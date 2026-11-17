// SPDX-License-Identifier: MIT

/**
 * Assemble the licensing, provenance and corresponding-source artifacts that
 * ship with the package.
 *
 * `LICENSE.md`, `THIRD_PARTY_NOTICES.md` and the license texts live at the
 * repository root; packaging copies them into the package.  `REBUILDING.md`
 * carries exact release values, so it is rendered from `REBUILDING.md.in`.
 * None of the package copies is committed.  The source kit contains the pinned
 * upstream archive, the applied patches and every project-owned input needed
 * to relink the WASM without the monorepo.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert } from './errors.ts';
import { assertFile, readJson, sha256File, walk, writeJson } from './files.ts';
import { log } from './exec.ts';
import {
  LICENSE_FILES,
  ROOT_LICENSING_FILES,
  UPSTREAM_BASE_FILES,
  UPSTREAM_LICENSE_FILES,
  kitBridgePath,
  packageLicensingManifest,
} from './package-manifest.ts';
import { emccVersion, kitCommandFiles } from './native-flags.ts';
import { patchesSha256, releaseEnv } from './release-env.ts';
import {
  CORRESPONDING_SOURCE,
  FINISH_MODULE_SCRIPT,
  LIBRARY_JS,
  LINK_INPUTS_JSON,
  PACKAGE_DIR,
  PACKAGE_LICENSES_DIR,
  PACKAGE_LICENSING_MANIFEST,
  PACKAGE_REBUILDING,
  REBUILDING_TEMPLATE,
  REBUILD_SCRIPT,
  REPO_ROOT,
  SOURCE_JSON,
  THIRD_PARTY_DIR,
  bridgeInputs,
  packageRelative,
  releaseArchivePath,
  releaseKitStaging,
  releaseSourceDir,
  releaseSourceDirName,
} from './paths.ts';
import { type SourceManifest, emscriptenRelease } from './provenance.ts';
import { loadUpstream, type Upstream } from './upstream.ts';

export interface LinkInput {
  readonly object: string;
  readonly source: string | null;
  readonly license: string;
}

export interface LinkInputs {
  readonly generatedAt: string;
  readonly method: string;
  readonly bridgeInputs: readonly { readonly source: string; readonly license: 'MIT' }[];
  readonly included: readonly LinkInput[];
  readonly excluded: readonly { readonly object: string; readonly reason: string }[];
  readonly linkedLicenses: readonly string[];
}

/**
 * Classify an upstream source file from its own header.  Hamlib's upstream
 * LICENSE states that the library and backend sources are LGPL; files without
 * an explicit header in src/, rigs/ or lib/ inherit that policy.  Third-party
 * files carry their own header and take precedence.
 */
function classifySource(file: string, sourceDir: string, object: string): string {
  const text = readFileSync(file, 'utf8');
  const spdx = /SPDX-License-Identifier:\s*([^\s*]+)/.exec(text);

  if (spdx) {
    return spdx[1] as string;
  }

  if (/GNU Lesser General Public License/.test(text)) {
    return 'LGPL-2.1-or-later';
  }

  if (/GNU General Public License/.test(text)) {
    if (/version 3|Version 3|either version 3|GPL-3/.test(text)) {
      return 'GPL-3.0-or-later';
    }

    return 'GPL-2.0-or-later';
  }

  if (/Permission is hereby granted, free of charge/.test(text)) {
    return 'MIT';
  }

  if (/Redistribution and use in source and binary forms/.test(text)) {
    return 'BSD-3-Clause';
  }

  if (/public domain/i.test(text)) {
    return 'Public-Domain';
  }

  const relative = path.relative(sourceDir, file);

  if (
    relative.startsWith('src/')
    || relative.startsWith('rigs/')
    || relative.startsWith('lib/')
  ) {
    return 'LGPL-2.1-or-later';
  }

  throw new Error(
    `cannot classify the license of linked object ${object} `
    + `(${relative}); the header is unknown and the file is outside the `
    + 'Hamlib LGPL source families. Audit it before shipping.',
  );
}

/** Map an archive object name to the upstream source that produced it. */
function sourceForObject(object: string, sourceDir: string): string | null {
  /* libtool renames the second and later objects whose basenames collide
   * (`lt1-dummy.o`, `lt2-frame.o`).  The license is a property of the source
   * family; the shortest matching path is enough for the audit. */
  const base = object.replace(/^lt\d+-/, '').replace(/\.o$/, '');
  const candidates = walk(sourceDir).filter((file) => {
    const relative = path.relative(sourceDir, file);

    return (
      relative.startsWith('src/')
      || relative.startsWith('rigs/')
      || relative.startsWith('lib/')
      || relative.startsWith('security/')
    ) && (
      path.basename(file) === `${base}.c`
      || path.basename(file) === `${base}.cpp`
      || path.basename(file) === `${base}.cc`
    );
  });

  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    candidates.sort((left, right) => {
      const leftRank = path.relative(sourceDir, left).startsWith('src/') ? 0 : 1;
      const rightRank = path.relative(sourceDir, right).startsWith('src/') ? 0 : 1;

      return leftRank - rightRank || left.length - right.length;
    });
  }

  return candidates[0] as string;
}

/** Read the wasm-ld map and list the archive members actually linked. */
export function readLinkInputs(mapFile: string): LinkInputs {
  assertFile(mapFile, 'link map');
  const map = readFileSync(mapFile, 'utf8');
  const names = new Set<string>();

  for (const match of map.matchAll(/libhamlib\.a\(([^)]+)\):\(/g)) {
    names.add(match[1] as string);
  }

  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);
  const included: LinkInput[] = [];
  const missing: string[] = [];

  for (const object of [...names].sort()) {
    const source = sourceForObject(object, sourceDir);

    if (!source) {
      missing.push(object);
      included.push({ object, source: null, license: 'UNKNOWN' });
    } else {
      included.push({
        object,
        source: path.relative(sourceDir, source),
        license: classifySource(source, sourceDir, object),
      });
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `the link map names objects with no upstream source: ${missing.join(', ')}. `
      + 'Audit the build before shipping.',
    );
  }

  const excluded = included
    .filter((entry) => entry.license.startsWith('GPL-'))
    .map((entry) => ({
      object: entry.object,
      reason: 'GPL-only source must not be linked; see the source audit',
    }));

  if (excluded.length > 0) {
    throw new Error(
      `GPL-only objects are linked into the WASM: ${excluded
        .map((entry) => entry.object)
        .join(', ')}. Replace or exclude them before packaging.`,
    );
  }

  const linkedLicenses = [
    ...new Set([...included.map((entry) => entry.license), 'MIT']),
  ].sort();

  return {
    generatedAt: new Date().toISOString(),
    method:
      'Parsed the wasm-ld link map for archive members pulled from '
      + 'libhamlib.a; libtool ltN- basename prefixes are stripped, each object '
      + 'is matched to its upstream source, and the source header or Hamlib '
      + 'LICENSE policy determines the license. For a basename collision the '
      + 'shortest matching source is recorded because the license is the same '
      + 'source family.',
    bridgeInputs: bridgeInputs().map((source) => ({ source, license: 'MIT' as const })),
    included,
    excluded: [
      {
        object: 'precise_time.o',
        reason:
          'GPL-3.0-or-later upstream helper; references are redirected to '
          + 'native/monotonic_time.c by -Wl,--wrap=monotonic_seconds',
      },
      {
        object: 'aes.o, sha256.o, AESStringCrypt.o, password.o, security.o, md5.o',
        reason:
          'GPL-2.0-or-later upstream security helpers; no linked Hamlib object '
          + 'references them',
      },
    ],
    linkedLicenses,
  };
}

/** Copy the root licensing files into the package. */
export function syncPackageLicenseFiles(): void {
  rmSync(PACKAGE_LICENSES_DIR, { recursive: true, force: true });

  for (const relative of ROOT_LICENSING_FILES) {
    const source = path.join(REPO_ROOT, relative);
    const destination = path.join(PACKAGE_DIR, relative);

    assertFile(source, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  log('licensing', 'copied the licensing files into the package');
}

/** Render `REBUILDING.md` for this release. */
export function writeRebuildingGuide(): void {
  const upstream = loadUpstream();
  const values: Record<string, string> = {
    HAMLIB_VERSION: upstream.version,
    HAMLIB_COMMIT: upstream.commit,
    HAMLIB_TAG_OBJECT: upstream.tagObject,
    HAMLIB_ARCHIVE_NAME: upstream.archive.name,
    HAMLIB_ARCHIVE_URL: upstream.archive.url,
    HAMLIB_ARCHIVE_SHA256: upstream.archive.sha256,
    HAMLIB_PATCHES: upstream.patches
      .map((patch) => `  - \`${patch.file}\`, SHA-256\n    \`${sha256File(patch.path)}\``)
      .join('\n'),
    HAMLIB_SOURCE_DIR: releaseSourceDirName(upstream),
    EMSCRIPTEN_VERSION: emscriptenRelease(emccVersion()),
    NODE_MAJOR: process.versions.node.split('.')[0] as string,
  };
  const rendered = readFileSync(REBUILDING_TEMPLATE, 'utf8').replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (token, key: string) => {
      const value = values[key];

      assert(value !== undefined, `REBUILDING.md.in has an unknown token ${token}`);
      return value;
    },
  );

  writeFileSync(PACKAGE_REBUILDING, rendered);
  log('licensing', 'rendered REBUILDING.md');
}

/**
 * The native step's share of `dist/third_party/hamlib`: the upstream notices,
 * the shipped patches and the audit of what the link pulled in.
 */
export function writeThirdPartyData(linkMapFile: string): void {
  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);

  for (const file of UPSTREAM_BASE_FILES) {
    assertFile(path.join(sourceDir, file), `upstream ${file}`);
  }

  mkdirSync(THIRD_PARTY_DIR, { recursive: true });

  /* The package step writes these from this build; until it runs, an older
   * copy would describe a different module. */
  for (const file of [SOURCE_JSON, CORRESPONDING_SOURCE, PACKAGE_LICENSING_MANIFEST]) {
    rmSync(file, { force: true });
  }

  for (const file of UPSTREAM_BASE_FILES) {
    cpSync(path.join(sourceDir, file), path.join(THIRD_PARTY_DIR, file));
  }

  for (const patch of upstream.patches) {
    cpSync(patch.path, path.join(THIRD_PARTY_DIR, patch.file));
  }

  writeJson(LINK_INPUTS_JSON, readLinkInputs(linkMapFile));
  log('licensing', 'wrote the upstream notices and the linked-input audit');
}

/** `SOURCE.json` for this build; the kit's hash is filled in once it exists. */
function sourceManifest(upstream: Upstream): SourceManifest {
  const linkInputs = readJson<LinkInputs>(LINK_INPUTS_JSON);
  const licenseHashes = Object.fromEntries(
    [
      ...LICENSE_FILES,
      ...UPSTREAM_LICENSE_FILES.map(
        (file) => packageRelative(path.join(THIRD_PARTY_DIR, file)),
      ),
    ].map((relative) => [relative, sha256File(path.join(PACKAGE_DIR, relative))]),
  );

  return {
    component: 'Hamlib',
    version: upstream.version,
    series: upstream.series,
    license: upstream.license,
    upstreamRepository: upstream.repository,
    upstreamCommit: upstream.commit,
    upstreamTagObject: upstream.tagObject,
    url: upstream.archive.url,
    sha256: upstream.archive.sha256,
    sourceArchiveFile: `source/${upstream.archive.name}`,
    patches: upstream.patches.map((patch) => ({
      file: patch.file,
      purpose: patch.purpose,
      sha256: sha256File(path.join(THIRD_PARTY_DIR, patch.file)),
    })),
    correspondingSource: packageRelative(CORRESPONDING_SOURCE),
    correspondingSourceSha256: null,
    rebuildInstructions: 'REBUILDING.md',
    emscriptenVersion: emccVersion(),
    nodeVersion: process.version,
    linkedLicenses: linkInputs.linkedLicenses,
    bundledSourceLicenses: [
      'LGPL-2.1-or-later',
      'GPL-2.0-or-later',
      'GPL-3.0-or-later',
      'MIT',
      'BSD-3-Clause',
      'file-level terms in the archived upstream tree',
    ],
    licenseFiles: LICENSE_FILES,
    licenseFileSha256: licenseHashes,
    linkInputs: packageRelative(LINK_INPUTS_JSON),
    linkInputsSha256: sha256File(LINK_INPUTS_JSON),
    note:
      'Built into WebAssembly with the browser serial transport in '
      + 'packages/hamlib-wasm/native. Rebuild with `mise run build-native`; '
      + 'the pinned release is described by packages/hamlib-wasm/hamlib.config.yaml. '
      + 'The published package carries a complete relink kit; see REBUILDING.md.',
  };
}

function kitReadme(upstream: Upstream): string {
  const patches = upstream.patches.map((patch) => `\`patches/${patch.file}\``).join(', ');

  return `# hamlib-wasm corresponding-source and relink kit

This archive contains the source and build inputs needed to rebuild
\`hamlib-wasm.wasm\` with a modified Hamlib library.

- Upstream: Hamlib ${upstream.version}, commit ${upstream.commit}
- Original archive: \`source/${upstream.archive.name}\`
- Archive SHA-256: \`${upstream.archive.sha256}\`
- Patches, applied in order: ${patches}
- Project bridge and generated bindings: \`native/\`
- Precompiled Emscripten JS library: \`library/web_serial.js\`
- License texts and notices: \`LICENSES/\`, \`LICENSE.md\`, \`THIRD_PARTY_NOTICES.md\`,
  and the upstream \`AUTHORS\`, \`LICENSE\`, \`COPYING\`, \`COPYING.LIB\`
- Rebuild instructions: \`REBUILDING.md\`
- Release values consumed by \`rebuild.sh\`: \`release.env\`, \`patches.sha256\`
- The configure, compile and link commands of the package build:
  \`configure.args\`, \`compile.args\`, \`link.args\`; the post-link step:
  \`finish-module.mts\`

The package-level \`dist/third_party/hamlib/SOURCE.json\` records the SHA-256 of
this tarball. The \`SOURCE.json\` copy inside the kit predates that hash and
therefore leaves \`correspondingSourceSha256\` null; it is not a placeholder.

\`rebuild.sh\` extracts and verifies the archive, applies the patches, replaces
\`src/serial.c\` with the project transport, compiles Hamlib, and links a
replacement \`hamlib-wasm.wasm\` plus loader.

The complete upstream source tree is included even though some files
(GPL utilities/examples and \`lib/precise_time.c\`) are not linked into the
WASM. Their original licenses are retained in the archive and disclosed in
\`THIRD_PARTY_NOTICES.md\`.
`;
}

/**
 * Build the corresponding-source/relink archive and write the provenance that
 * describes it.  Runs after the native build, whose JS library, notices and
 * link audit it packs.
 */
export function buildCorrespondingSourceKit(): void {
  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);
  const archive = releaseArchivePath(upstream);
  const staging = releaseKitStaging(upstream);

  assertFile(archive, 'source archive');
  assertFile(LIBRARY_JS, 'compiled serial transport library');
  assertFile(LINK_INPUTS_JSON, 'linked-input audit');
  assertFile(REBUILD_SCRIPT, 'relink script');
  assert(
    sha256File(archive) === upstream.archive.sha256,
    `source archive hash does not match the pinned manifest: ${archive}`,
  );

  const source = sourceManifest(upstream);

  rmSync(staging, { recursive: true, force: true });
  for (const dir of ['source', 'patches']) {
    mkdirSync(path.join(staging, dir), { recursive: true });
  }

  cpSync(archive, path.join(staging, 'source', upstream.archive.name));

  for (const patch of upstream.patches) {
    cpSync(patch.path, path.join(staging, 'patches', patch.file));
  }

  for (const relative of bridgeInputs()) {
    const destination = path.join(staging, kitBridgePath(relative));

    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(PACKAGE_DIR, relative), destination);
  }

  cpSync(REBUILD_SCRIPT, path.join(staging, 'rebuild.sh'));
  cpSync(FINISH_MODULE_SCRIPT, path.join(staging, path.basename(FINISH_MODULE_SCRIPT)));
  cpSync(PACKAGE_REBUILDING, path.join(staging, 'REBUILDING.md'));
  writeJson(path.join(staging, 'SOURCE.json'), source);

  for (const relative of ROOT_LICENSING_FILES) {
    mkdirSync(path.dirname(path.join(staging, relative)), { recursive: true });
    cpSync(path.join(PACKAGE_DIR, relative), path.join(staging, relative));
  }

  for (const file of UPSTREAM_BASE_FILES) {
    cpSync(path.join(sourceDir, file), path.join(staging, file));
  }

  writeFileSync(path.join(staging, 'release.env'), releaseEnv(upstream));
  writeFileSync(path.join(staging, 'patches.sha256'), patchesSha256(upstream));

  for (const [file, content] of Object.entries(kitCommandFiles())) {
    writeFileSync(path.join(staging, file), content);
  }

  writeFileSync(path.join(staging, 'KIT-README.md'), kitReadme(upstream));

  execFileSync('tar', ['-czf', CORRESPONDING_SOURCE, '-C', staging, '.'], {
    stdio: 'inherit',
  });

  const kitSha256 = sha256File(CORRESPONDING_SOURCE);

  writeJson(SOURCE_JSON, { ...source, correspondingSourceSha256: kitSha256 } satisfies SourceManifest);
  writeJson(PACKAGE_LICENSING_MANIFEST, packageLicensingManifest(upstream));

  log('licensing', `built corresponding-source kit (${kitSha256})`);
}

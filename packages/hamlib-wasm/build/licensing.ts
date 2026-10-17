// SPDX-License-Identifier: MIT

/**
 * Assemble the licensing, provenance and corresponding-source artifacts that
 * ship with the package.
 *
 * The canonical license texts and repository-level notices live at the
 * repository root.  Packaging copies them into the package instead of
 * maintaining a second handwritten set.  The source kit contains the pinned
 * upstream archive, the applied patch and every project-owned input needed to
 * relink the WASM without the monorepo.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert } from './errors.ts';
import { assertFile, readJson, sha256File, walk, writeJson } from './files.ts';
import { log } from './exec.ts';
import {
  configureArgsFile,
  configureEnv,
  linkArgsFile,
  packageLicensingManifest,
  releaseEnv,
} from './release-env.ts';
import {
  BRIDGE_INPUTS,
  CODEGEN_LICENSE,
  CORRESPONDING_SOURCE,
  LIBRARY_JS,
  LICENSE_FILES,
  LINK_INPUTS_JSON,
  NATIVE_DIR,
  PACKAGE_DIR,
  PACKAGE_LICENSE,
  PACKAGE_LICENSES_DIR,
  PACKAGE_LICENSING_MANIFEST,
  PACKAGE_NOTICES,
  PACKAGE_REBUILDING,
  REBUILD_SCRIPT,
  REPO_ROOT,
  ROOT_LICENSES_DIR,
  ROOT_NOTICES,
  SOURCE_JSON,
  THIRD_PARTY_DIR,
  releaseArchivePath,
  releaseKitStaging,
  releaseSourceDir,
} from './paths.ts';
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
function classifySource(file: string, sourceDir: string): string {
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

  return 'UNKNOWN';
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
        license: classifySource(source, sourceDir),
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
    ...new Set([
      ...included.map((entry) => entry.license),
      ...BRIDGE_INPUTS.map(() => 'MIT'),
    ]),
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
    bridgeInputs: BRIDGE_INPUTS.map((source) => ({ source, license: 'MIT' as const })),
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

function emscriptenVersion(): string | null {
  try {
    const output = execFileSync('emcc', ['--version'], { encoding: 'utf8' });
    return output.split('\n')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Copy the canonical root license texts into the package tarball. */
export function syncPackageLicenseFiles(): void {
  for (const relative of LICENSE_FILES) {
    assertFile(path.join(REPO_ROOT, relative), relative);
  }

  assertFile(ROOT_NOTICES, 'root third-party notices');
  assertFile(PACKAGE_LICENSE, 'package LICENSE.md');
  assertFile(PACKAGE_REBUILDING, 'package REBUILDING.md');

  rmSync(PACKAGE_LICENSES_DIR, { recursive: true, force: true });
  cpSync(ROOT_LICENSES_DIR, PACKAGE_LICENSES_DIR, { recursive: true });
  cpSync(ROOT_NOTICES, PACKAGE_NOTICES);
  cpSync(path.join(ROOT_LICENSES_DIR, 'MIT.txt'), CODEGEN_LICENSE);

  log('licensing', 'synced package license texts');
}

export function writeThirdPartyData(linkMapFile: string): void {
  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);
  const archive = releaseArchivePath(upstream);

  assertFile(archive, 'source archive');
  for (const file of ['LICENSE', 'COPYING', 'COPYING.LIB', 'AUTHORS']) {
    assertFile(path.join(sourceDir, file), `upstream ${file}`);
  }
  assert(
    sha256File(archive) === upstream.archive.sha256,
    `source archive hash does not match the pinned manifest: ${archive}`,
  );

  syncPackageLicenseFiles();
  mkdirSync(THIRD_PARTY_DIR, { recursive: true });
  writeJson(PACKAGE_LICENSING_MANIFEST, packageLicensingManifest(upstream));

  for (const file of ['LICENSE', 'COPYING', 'COPYING.LIB', 'AUTHORS']) {
    cpSync(path.join(sourceDir, file), path.join(THIRD_PARTY_DIR, file));
  }

  for (const patch of upstream.patches) {
    cpSync(patch.path, path.join(THIRD_PARTY_DIR, patch.file));
  }

  /* The kit is assembled by the package step from the current source inputs.
   * Drop an older archive here so SOURCE.json cannot advertise a stale kit if
   * someone stops after the native build. */
  rmSync(CORRESPONDING_SOURCE, { force: true });

  const linkInputs = readLinkInputs(linkMapFile);
  writeJson(LINK_INPUTS_JSON, linkInputs);

  const patchHashes = Object.fromEntries(
    upstream.patches.map((patch) => [
      patch.file,
      sha256File(path.join(THIRD_PARTY_DIR, patch.file)),
    ]),
  );

  const licenseHashes = Object.fromEntries(
    [
      ...LICENSE_FILES,
      'dist/third_party/hamlib/LICENSE',
      'dist/third_party/hamlib/COPYING',
      'dist/third_party/hamlib/COPYING.LIB',
    ].map((relative) => [relative, sha256File(path.join(PACKAGE_DIR, relative))]),
  );

  const source = {
    component: 'Hamlib',
    package: 'Hamlib',
    version: upstream.version,
    series: upstream.series,
    license: upstream.license,
    licenseExpression: 'SEE LICENSE IN LICENSE.md',
    upstreamRepository: upstream.repository,
    upstreamCommit: upstream.commit,
    upstreamTagObject: upstream.tagObject,
    upstreamTag: upstream.version,
    sourceArchive: upstream.archive.url,
    sourceArchiveFile: `source/${upstream.archive.name}`,
    sourceArchiveSha256: upstream.archive.sha256,
    url: upstream.archive.url,
    sha256: upstream.archive.sha256,
    patch: upstream.patches[0]?.file ?? null,
    patchSha256: patchHashes[upstream.patches[0]?.file ?? ''] ?? null,
    patches: upstream.patches.map((patch) => ({
      file: patch.file,
      purpose: patch.purpose,
      sha256: patchHashes[patch.file],
    })),
    correspondingSource: 'dist/third_party/hamlib/corresponding-source.tar.gz',
    correspondingSourceSha256: existsSync(CORRESPONDING_SOURCE)
      ? sha256File(CORRESPONDING_SOURCE)
      : null,
    rebuildInstructions: 'REBUILDING.md',
    emscriptenVersion: emscriptenVersion(),
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
    linkInputs: 'dist/third_party/hamlib/LINK_INPUTS.json',
    linkInputsSha256: sha256File(LINK_INPUTS_JSON),
    note:
      'Built into WebAssembly with the browser serial transport in '
      + 'packages/hamlib-wasm/native. Rebuild with `mise run build-native`; '
      + 'the pinned release is described by packages/hamlib-wasm/hamlib.config.yaml. '
      + 'The published package carries a complete relink kit; see REBUILDING.md.',
  };

  writeJson(SOURCE_JSON, source);
  log('licensing', 'wrote third-party notices and provenance');
}

function kitReadme(upstream: Upstream): string {
  const patch = upstream.patches[0]?.file ?? '';

  return `# hamlib-wasm corresponding-source and relink kit

This archive contains the source and build inputs needed to rebuild
\`hamlib-wasm.wasm\` with a modified Hamlib library.

- Upstream: Hamlib ${upstream.version}, commit ${upstream.commit}
- Original archive: \`source/${upstream.archive.name}\`
- Archive SHA-256: \`${upstream.archive.sha256}\`
- Patch: \`patches/${patch}\`
- Project bridge and generated bindings: \`native/\`
- Precompiled Emscripten JS library: \`library/web_serial.js\`
- License texts and notices: \`LICENSES/\`, \`LICENSE.md\`, \`THIRD_PARTY_NOTICES.md\`
- Rebuild instructions: \`REBUILDING.md\`
- Release values consumed by \`rebuild.sh\`: \`release.env\`, \`configure.env\`,
  \`configure.args\`, \`link.args\`

The package-level \`dist/third_party/hamlib/SOURCE.json\` records the SHA-256 of
this tarball. The \`SOURCE.json\` copy inside the kit predates that hash and
therefore leaves \`correspondingSourceSha256\` null; it is not a placeholder.

\`rebuild.sh\` extracts and verifies the archive, applies the patch, replaces
\`src/serial.c\` with the project transport, compiles Hamlib, and links a
replacement \`hamlib-wasm.wasm\` plus loader.

The complete upstream source tree is included even though some files
(GPL utilities/examples and \`lib/precise_time.c\`) are not linked into the
WASM. Their original licenses are retained in the archive and disclosed in
\`THIRD_PARTY_NOTICES.md\`.
`;
}

/**
 * Build the corresponding-source/relink archive.  This must be called after
 * the native build, because it copies the linked JS library and the generated
 * provenance files.
 */
export function buildCorrespondingSourceKit(): void {
  const upstream = loadUpstream();
  const sourceDir = releaseSourceDir(upstream);
  const archive = releaseArchivePath(upstream);
  const staging = releaseKitStaging(upstream);

  assertFile(archive, 'source archive');
  assertFile(LIBRARY_JS, 'compiled serial transport library');
  assertFile(SOURCE_JSON, 'third-party source manifest');
  assertFile(REBUILD_SCRIPT, 'relink script');
  assert(
    sha256File(archive) === upstream.archive.sha256,
    `source archive hash does not match the pinned manifest: ${archive}`,
  );

  rmSync(staging, { recursive: true, force: true });
  for (const dir of ['source', 'patches', 'library']) {
    mkdirSync(path.join(staging, dir), { recursive: true });
  }

  cpSync(archive, path.join(staging, 'source', upstream.archive.name));

  for (const patch of upstream.patches) {
    cpSync(patch.path, path.join(staging, 'patches', patch.file));
  }

  cpSync(NATIVE_DIR, path.join(staging, 'native'), { recursive: true });
  cpSync(LIBRARY_JS, path.join(staging, 'library', 'web_serial.js'));
  cpSync(REBUILD_SCRIPT, path.join(staging, 'rebuild.sh'));
  cpSync(PACKAGE_REBUILDING, path.join(staging, 'REBUILDING.md'));
  cpSync(PACKAGE_LICENSE, path.join(staging, 'LICENSE.md'));
  cpSync(PACKAGE_NOTICES, path.join(staging, 'THIRD_PARTY_NOTICES.md'));
  cpSync(PACKAGE_LICENSES_DIR, path.join(staging, 'LICENSES'), { recursive: true });
  cpSync(SOURCE_JSON, path.join(staging, 'SOURCE.json'));

  for (const file of ['LICENSE', 'COPYING', 'COPYING.LIB', 'AUTHORS']) {
    cpSync(path.join(sourceDir, file), path.join(staging, file));
  }

  writeFileSync(path.join(staging, 'release.env'), releaseEnv(upstream));
  writeFileSync(path.join(staging, 'configure.env'), configureEnv());
  writeFileSync(path.join(staging, 'configure.args'), configureArgsFile());
  writeFileSync(path.join(staging, 'link.args'), linkArgsFile());
  writeFileSync(path.join(staging, 'KIT-README.md'), kitReadme(upstream));
  writeJson(PACKAGE_LICENSING_MANIFEST, packageLicensingManifest(upstream));

  execFileSync('tar', ['-czf', CORRESPONDING_SOURCE, '-C', staging, '.'], {
    stdio: 'inherit',
  });

  const source = readJson<Record<string, unknown>>(SOURCE_JSON);
  source.correspondingSource = 'dist/third_party/hamlib/corresponding-source.tar.gz';
  source.correspondingSourceSha256 = sha256File(CORRESPONDING_SOURCE);
  writeJson(SOURCE_JSON, source);

  log('licensing', `built corresponding-source kit (${sha256File(CORRESPONDING_SOURCE)})`);
}

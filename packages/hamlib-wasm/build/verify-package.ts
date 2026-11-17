#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Verify the licensing, provenance and relink material in the actual npm
 * tarball.  This is not a working-tree check: it extracts the bytes a consumer
 * receives, verifies the source kit, and applies the patch to a fresh upstream
 * extraction.  With `--relink` it also rebuilds that same extraction and
 * exercises the rebuilt WASM through the packaged loader, so the release gate
 * packs and extracts only once.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  applyPatchFiles,
  cleanup,
  extractKit,
  extractTarball,
  packTarball,
} from './artifact.ts';
import { assert, runMain } from './errors.ts';
import { log, parseFlag } from './exec.ts';
import { assertFile, readJson, sha256File, walk } from './files.ts';
import {
  PACKAGE_JSON_FILES,
  ROOT_LICENSING_FILES,
  kitFiles,
  requiredPackageFiles,
  scannedPackageFiles,
} from './package-manifest.ts';
import {
  DIST_MODULE_JS,
  DIST_MODULE_TSD,
  LINK_INPUTS_JSON,
  PACKAGE_LICENSING_MANIFEST,
  REPO_ROOT,
  SOURCE_JSON,
  THIRD_PARTY_DIR,
  packageRelative,
  releaseSourceDirName,
} from './paths.ts';
import { type SourcePatch, readSourceManifest } from './provenance.ts';
import { type Upstream, loadUpstream } from './upstream.ts';
import { runRelink } from './verify-relink.ts';

const SCOPE = 'verify-package';
const PACKAGE_LICENSE_EXPRESSION = 'MIT AND LGPL-2.1-or-later';
const PLACEHOLDER_PATTERN =
  /\[(?:INSERT|REPLACE)|REPLACE_WITH|<year> <copyright holders>|YOUR COPYRIGHT HOLDER|YOUR NAME|\bTODO\b|\bTBD\b|example\.com/i;

function scanText(file: string, what: string): void {
  const text = readFileSync(file, 'utf8');

  if (PLACEHOLDER_PATTERN.test(text)) {
    throw new Error(`${what} contains a stale placeholder in ${file}`);
  }
}

/** Report where a packaged manifest still records an unclassified license. */
function findUnknownLicense(value: unknown, where: string): string | null {
  if (value === 'UNKNOWN') { return where; }

  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findUnknownLicense(child, `${where}[${index}]`);

      if (found) { return found; }
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const found = findUnknownLicense(child, `${where}.${key}`);

      if (found) { return found; }
    }
  }

  return null;
}

function assertRequiredEntry(packageRoot: string, relative: string, kind: string): void {
  const absolute = path.join(packageRoot, relative);

  if (kind === 'directory') {
    assert(
      existsSync(absolute) && statSync(absolute).isDirectory(),
      `required package directory ${relative} is missing`,
    );
    return;
  }

  assertFile(absolute, `required package file ${relative}`);
}

/** SOURCE.json lists every configured patch, in order, with its shipped hash. */
function verifyPatchRecords(
  upstream: Upstream,
  records: readonly SourcePatch[],
  patchDir: string,
  what: string,
): void {
  assert(Array.isArray(records), `${what} has no patches list`);
  assert(
    JSON.stringify(records.map((record) => record.file))
    === JSON.stringify(upstream.patches.map((patch) => patch.file)),
    `${what} patches do not match the config`,
  );

  for (const record of records) {
    assert(
      record.sha256 === sha256File(path.join(patchDir, record.file)),
      `${what} hash for ${record.file} does not match the patch in ${patchDir}`,
    );
  }
}

function verifyTarball(upstream: Upstream, tarball: string, work: string, relink: boolean): void {
  const packageRoot = extractTarball(tarball, path.join(work, 'unpacked'));

  for (const entry of requiredPackageFiles(upstream)) {
    assertRequiredEntry(packageRoot, entry.relative, entry.kind);
  }

  const manifest = readJson<{ license?: string; files?: string[] }>(
    path.join(packageRoot, 'package.json'),
  );
  assert(
    manifest.license === PACKAGE_LICENSE_EXPRESSION,
    `package.json license is ${String(manifest.license)}, expected ${PACKAGE_LICENSE_EXPRESSION}`,
  );
  const requiredEntries = PACKAGE_JSON_FILES.map((entry) => entry.relative);
  assert(
    Array.isArray(manifest.files)
    && requiredEntries.every((entry) => (manifest.files as string[]).includes(entry)),
    `package.json files does not include every packaged entry: ${requiredEntries.join(', ')}`,
  );

  for (const relative of ROOT_LICENSING_FILES) {
    const canonical = path.join(REPO_ROOT, relative);
    const packaged = path.join(packageRoot, relative);
    assertFile(canonical, `canonical ${relative}`);
    assert(
      sha256File(canonical) === sha256File(packaged),
      `${relative} in the package is not byte-identical to the repository root copy`,
    );
  }

  const licenseText = readFileSync(path.join(packageRoot, 'LICENSE.md'), 'utf8');
  assert(
    licenseText.includes(PACKAGE_LICENSE_EXPRESSION) && /Hamlib/.test(licenseText),
    'LICENSE.md does not describe the MIT and LGPL component licensing',
  );

  const notices = readFileSync(path.join(packageRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const required of [
    'Hamlib',
    'LGPL-2.1-or-later',
    'GPL-3.0-or-later',
    'precise_time.c',
    'Emscripten',
  ]) {
    assert(notices.includes(required), `THIRD_PARTY_NOTICES.md is missing ${required}`);
  }

  const rebuild = readFileSync(path.join(packageRoot, 'REBUILDING.md'), 'utf8');
  assert(
    rebuild.includes('corresponding-source.tar.gz')
    && rebuild.includes('--source-dir')
    && rebuild.includes('hamlib-wasm.wasm'),
    'REBUILDING.md does not document the packaged relink procedure',
  );
  assert(
    rebuild.includes(upstream.commit) && rebuild.includes(upstream.archive.sha256),
    'REBUILDING.md does not name the exact Hamlib commit and archive hash',
  );

  for (const relative of scannedPackageFiles(upstream)) {
    scanText(path.join(packageRoot, relative), relative);
  }

  const loader = readFileSync(
    path.join(packageRoot, packageRelative(DIST_MODULE_JS)),
    'utf8',
  );
  assert(loader.startsWith('// SPDX-License-Identifier:'), 'the loader has no SPDX banner');
  assert(
    /LGPL-2\.1-or-later/.test(loader.slice(0, 600)),
    'the loader banner does not mention the LGPL WASM',
  );

  const declaration = readFileSync(
    path.join(packageRoot, packageRelative(DIST_MODULE_TSD)),
    'utf8',
  );
  assert(
    declaration.startsWith('// SPDX-License-Identifier:'),
    'the generated declaration has no SPDX banner',
  );

  const thirdPartyDir = path.join(packageRoot, packageRelative(THIRD_PARTY_DIR));
  const source = readSourceManifest(path.join(packageRoot, packageRelative(SOURCE_JSON)));
  assert(source.component === 'Hamlib', 'SOURCE.json component is not Hamlib');
  assert(source.version === upstream.version, 'SOURCE.json version does not match config');
  assert(source.upstreamCommit === upstream.commit, 'SOURCE.json commit does not match config');
  assert(source.upstreamTagObject === upstream.tagObject, 'SOURCE.json tag object does not match config');
  assert(source.upstreamRepository === upstream.repository, 'SOURCE.json repository does not match config');
  assert(
    source.url === upstream.archive.url && source.sha256 === upstream.archive.sha256,
    'SOURCE.json archive URL or hash does not match config',
  );
  assert(
    source.sourceArchiveFile === `source/${upstream.archive.name}`,
    'SOURCE.json archive filename does not match config',
  );
  verifyPatchRecords(
    upstream,
    source.patches,
    thirdPartyDir,
    'SOURCE.json',
  );
  assert(
    typeof source.emscriptenVersion === 'string' && source.emscriptenVersion.length > 0,
    'SOURCE.json has no Emscripten version',
  );
  assert(
    source.rebuildInstructions === 'REBUILDING.md',
    'SOURCE.json rebuildInstructions does not point at REBUILDING.md',
  );

  const sourceFileHashes = source.licenseFileSha256;
  assert(sourceFileHashes && typeof sourceFileHashes === 'object', 'SOURCE.json has no license hashes');
  for (const [relative, hash] of Object.entries(sourceFileHashes)) {
    assertFile(path.join(packageRoot, relative), `hashed license file ${relative}`);
    assert(
      sha256File(path.join(packageRoot, relative)) === hash,
      `SOURCE.json hash does not match ${relative}`,
    );
  }

  const linkInputs = readJson<{
    included?: { object?: string; license?: string }[];
    linkedLicenses?: string[];
    bridgeInputs?: { source?: string; license?: string }[];
  }>(path.join(packageRoot, packageRelative(LINK_INPUTS_JSON)));
  const included = linkInputs.included ?? [];
  assert(included.length > 0, 'LINK_INPUTS.json has no included objects');

  for (const entry of included) {
    assert(entry.object && entry.license, 'LINK_INPUTS.json entry is incomplete');
    assert(
      entry.license !== 'UNKNOWN',
      `LINK_INPUTS.json records an unclassified license for ${entry.object}`,
    );
    assert(
      !entry.license.startsWith('GPL-'),
      `GPL-only object is linked into the WASM: ${entry.object} (${entry.license})`,
    );
    assert(
      entry.object !== 'precise_time.o',
      'precise_time.o (GPL-3.0-or-later) is linked into the WASM',
    );
  }

  assert(
    linkInputs.linkedLicenses?.includes('MIT')
    && linkInputs.linkedLicenses.includes('LGPL-2.1-or-later'),
    'LINK_INPUTS.json linkedLicenses is missing MIT or LGPL-2.1-or-later',
  );
  assert(
    Array.isArray(linkInputs.bridgeInputs)
    && linkInputs.bridgeInputs.length > 0
    && linkInputs.bridgeInputs.every((entry) => entry.license === 'MIT'),
    'LINK_INPUTS.json does not record the MIT bridge inputs',
  );

  const kitArtifact = extractKit(packageRoot, path.join(work, 'kit'));

  assert(
    source.correspondingSourceSha256 === sha256File(kitArtifact.kitArchive),
    'SOURCE.json correspondingSourceSha256 does not match the kit',
  );

  for (const relative of kitFiles(upstream)) {
    assertFile(path.join(kitArtifact.kit, relative), `kit file ${relative}`);
  }

  const kitArchiveFile = path.join(kitArtifact.kit, 'source', upstream.archive.name);
  const kitPatchDir = path.join(kitArtifact.kit, 'patches');
  assert(
    sha256File(kitArchiveFile) === source.sha256,
    'the kit embedded archive hash does not match SOURCE.json',
  );
  verifyPatchRecords(upstream, source.patches, kitPatchDir, 'SOURCE.json (kit patches)');

  const patchCheck = path.join(work, 'patch-check');
  mkdirSync(patchCheck, { recursive: true });
  execFileSync('tar', ['-xzf', kitArchiveFile, '-C', patchCheck], { stdio: 'inherit' });
  applyPatchFiles(
    upstream.patches.map((patch) => path.join(kitPatchDir, patch.file)),
    path.join(patchCheck, releaseSourceDirName(upstream)),
  );

  for (const file of walk(kitArtifact.kit)) {
    if (file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.txt')) {
      scanText(file, path.relative(kitArtifact.kit, file));
    }
  }

  const packageLicensing = readJson<{ copy?: unknown[] }>(
    path.join(packageRoot, packageRelative(PACKAGE_LICENSING_MANIFEST)),
  );
  assert(
    Array.isArray(packageLicensing.copy) && packageLicensing.copy.length > 0,
    'PACKAGE-LICENSING.json has no copy entries',
  );
  const unknown = findUnknownLicense(packageLicensing, 'PACKAGE-LICENSING.json');

  assert(!unknown, `${unknown ?? 'PACKAGE-LICENSING.json'} is UNKNOWN`);

  if (relink) {
    log(SCOPE, 'running the clean-room relink against the extracted tarball');
    runRelink({
      packageRoot,
      kit: kitArtifact.kit,
      tarball,
      work: path.join(work, 'relink'),
    });
  }

  log(
    SCOPE,
    `OK: ${path.basename(tarball)} (${readdirSync(packageRoot).length} top-level entries, `
    + `${included.length} linked Hamlib objects, source kit verified`
    + `${relink ? ', clean-room relink verified' : ''})`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const tarballArg = parseFlag(args, '--tarball');
  const workArg = parseFlag(args, '--work-dir');
  const upstream = loadUpstream();
  const work = workArg ?? mkdtempSync(path.join(os.tmpdir(), 'hamlib-wasm-package-'));

  mkdirSync(work, { recursive: true });

  try {
    const tarball = tarballArg ?? packTarball(path.join(work, 'artifact'));
    verifyTarball(upstream, tarball, work, args.includes('--relink'));
  } finally {
    cleanup(work, args.includes('--keep'));
  }
}

await runMain(SCOPE, main);

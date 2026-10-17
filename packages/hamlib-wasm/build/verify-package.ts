#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Verify the licensing, provenance and relink material in the actual npm
 * tarball.  This is not a working-tree check: it extracts the bytes a consumer
 * receives, verifies the source kit, and applies the patch to a fresh upstream
 * extraction.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
  applyPatchFile,
  cleanup,
  collectPatchLeftovers,
  extractKit,
  extractTarball,
  packTarball,
} from './artifact.ts';
import { renderLicensingDocs } from './docs.ts';
import { assert } from './errors.ts';
import { log, parseFlag } from './exec.ts';
import { assertFile, readJson, sha256File, walk } from './files.ts';
import { verifyRepository } from './guard.ts';
import {
  LICENSE_FILES,
  REPO_ROOT,
  releaseSourceDirName,
  requiredPackageFiles,
} from './paths.ts';
import { loadUpstream } from './upstream.ts';

const SCOPE = 'verify-package';
const PLACEHOLDER_PATTERN =
  /\[(?:INSERT|REPLACE)|REPLACE_WITH|YOUR COPYRIGHT HOLDER|YOUR NAME|\bTODO\b|\bTBD\b|example\.com/i;

function scanText(file: string, what: string): void {
  const text = readFileSync(file, 'utf8');

  if (PLACEHOLDER_PATTERN.test(text)) {
    throw new Error(`${what} contains a stale placeholder in ${file}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const tarballArg = parseFlag(args, '--tarball');
  const workArg = parseFlag(args, '--work-dir');
  const keep = args.includes('--keep');
  const upstream = loadUpstream();
  const patchFile = upstream.patches[0]?.file;

  assert(patchFile, 'the release config has no patch');
  verifyRepository();
  renderLicensingDocs({ check: true });

  const work = workArg ?? mkdtempSync(path.join(os.tmpdir(), 'hamlib-wasm-package-'));
  mkdirSync(work, { recursive: true });

  const tarball = tarballArg ?? packTarball(path.join(work, 'artifact'));
  const packageRoot = extractTarball(tarball, path.join(work, 'unpacked'));

  for (const relative of requiredPackageFiles(upstream)) {
    assertFile(path.join(packageRoot, relative), `required package file ${relative}`);
  }

  const manifest = readJson<{ license?: string; files?: string[] }>(
    path.join(packageRoot, 'package.json'),
  );
  assert(
    manifest.license === 'SEE LICENSE IN LICENSE.md',
    `package.json license is ${String(manifest.license)}, expected SEE LICENSE IN LICENSE.md`,
  );
  assert(
    Array.isArray(manifest.files)
    && ['dist', 'LICENSE.md', 'LICENSES', 'THIRD_PARTY_NOTICES.md', 'REBUILDING.md']
      .every((entry) => (manifest.files as string[]).includes(entry)),
    'package.json files does not include the licensing and relink artifacts',
  );

  for (const relative of LICENSE_FILES) {
    const canonical = path.join(REPO_ROOT, relative);
    const packaged = path.join(packageRoot, relative);
    assertFile(canonical, `canonical ${relative}`);
    assert(
      sha256File(canonical) === sha256File(packaged),
      `${relative} in the package is not byte-identical to the canonical file`,
    );
  }

  assert(
    sha256File(path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'))
    === sha256File(path.join(packageRoot, 'THIRD_PARTY_NOTICES.md')),
    'package THIRD_PARTY_NOTICES.md is not byte-identical to the repository copy',
  );

  const licenseText = readFileSync(path.join(packageRoot, 'LICENSE.md'), 'utf8');
  assert(
    /LGPL-2\.1-or-later/.test(licenseText)
    && /Hamlib/.test(licenseText)
    && /not MIT-only/i.test(licenseText),
    'LICENSE.md does not describe the mixed MIT/LGPL arrangement',
  );

  const notices = readFileSync(path.join(packageRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const required of [
    `Hamlib ${upstream.version}`,
    'LGPL-2.1-or-later',
    'GPL-3.0-or-later',
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

  for (const relative of [
    'LICENSE.md',
    'REBUILDING.md',
    'THIRD_PARTY_NOTICES.md',
    'README.md',
    'dist/third_party/hamlib/SOURCE.json',
    'dist/third_party/hamlib/LINK_INPUTS.json',
    'dist/third_party/hamlib/PACKAGE-LICENSING.json',
    ...LICENSE_FILES,
  ]) {
    scanText(path.join(packageRoot, relative), relative);
  }

  const loader = readFileSync(
    path.join(packageRoot, 'dist/native/hamlib-wasm.mjs'),
    'utf8',
  );
  assert(loader.startsWith('// SPDX-License-Identifier:'), 'the loader has no SPDX banner');
  assert(
    /LGPL-2\.1-or-later/.test(loader.slice(0, 600)),
    'the loader banner does not mention the LGPL WASM',
  );

  const declaration = readFileSync(
    path.join(packageRoot, 'dist/native/hamlib-wasm.d.mts'),
    'utf8',
  );
  assert(
    declaration.startsWith('// SPDX-License-Identifier:'),
    'the generated declaration has no SPDX banner',
  );

  const source = readJson<Record<string, unknown>>(
    path.join(packageRoot, 'dist/third_party/hamlib/SOURCE.json'),
  );
  assert(source.component === 'Hamlib', 'SOURCE.json component is not Hamlib');
  assert(source.version === upstream.version, 'SOURCE.json version does not match config');
  assert(source.upstreamCommit === upstream.commit, 'SOURCE.json commit does not match config');
  assert(source.upstreamTagObject === upstream.tagObject, 'SOURCE.json tag object does not match config');
  assert(source.upstreamRepository === upstream.repository, 'SOURCE.json repository does not match config');
  assert(
    source.sourceArchiveSha256 === upstream.archive.sha256,
    'SOURCE.json archive hash does not match config',
  );
  assert(
    source.sourceArchiveFile === `source/${upstream.archive.name}`,
    'SOURCE.json archive filename does not match config',
  );
  assert(source.patch === patchFile, 'SOURCE.json patch filename does not match config');
  assert(
    source.patchSha256
    === sha256File(path.join(packageRoot, 'dist/third_party/hamlib', patchFile)),
    'SOURCE.json patch hash does not match the packaged patch',
  );
  assert(
    source.emscriptenVersion !== null && String(source.emscriptenVersion).length > 0,
    'SOURCE.json has no Emscripten version',
  );
  assert(
    source.rebuildInstructions === 'REBUILDING.md',
    'SOURCE.json rebuildInstructions does not point at REBUILDING.md',
  );

  const sourceFileHashes = source.licenseFileSha256 as Record<string, string>;
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
  }>(path.join(packageRoot, 'dist/third_party/hamlib/LINK_INPUTS.json'));
  const included = linkInputs.included ?? [];
  assert(included.length > 0, 'LINK_INPUTS.json has no included objects');

  for (const entry of included) {
    assert(entry.object && entry.license, 'LINK_INPUTS.json entry is incomplete');
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
    linkInputs.linkedLicenses
    && linkInputs.linkedLicenses.includes('MIT')
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

  for (const relative of [
    'KIT-README.md',
    'REBUILDING.md',
    'rebuild.sh',
    'SOURCE.json',
    'release.env',
    'configure.env',
    'configure.args',
    'link.args',
    `source/${upstream.archive.name}`,
    `patches/${patchFile}`,
    'native/facade.cpp',
    'native/wrapped_io.cpp',
    'native/monotonic_time.c',
    'native/web_serial.c',
    'native/web_serial.h',
    'native/compat/pthread.h',
    'native/generated/embind.inc',
    'native/generated/operations.inc',
    'native/generated/results.inc',
    'native/generated/capabilities.inc',
    'library/web_serial.js',
    'LICENSES/LGPL-2.1-or-later.txt',
    'LICENSES/GPL-2.0-or-later.txt',
    'LICENSES/GPL-3.0-or-later.txt',
  ]) {
    assertFile(path.join(kitArtifact.kit, relative), `kit file ${relative}`);
  }

  const kitArchiveFile = path.join(kitArtifact.kit, 'source', upstream.archive.name);
  const kitPatch = path.join(kitArtifact.kit, 'patches', patchFile);
  assert(
    sha256File(kitArchiveFile) === source.sourceArchiveSha256,
    'the kit embedded archive hash does not match SOURCE.json',
  );
  assert(
    sha256File(kitPatch) === source.patchSha256,
    'the kit patch hash does not match SOURCE.json',
  );

  const patchCheck = path.join(work, 'patch-check');
  mkdirSync(patchCheck, { recursive: true });
  execFileSync('tar', ['-xzf', kitArchiveFile, '-C', patchCheck], { stdio: 'inherit' });

  const patchSource = path.join(patchCheck, releaseSourceDirName(upstream));
  applyPatchFile(kitPatch, patchSource);
  const leftovers = collectPatchLeftovers(patchSource);
  assert(leftovers.length === 0, `patch left rejects behind: ${leftovers.join(', ')}`);

  for (const file of walk(kitArtifact.kit)) {
    if (file.endsWith('.md') || file.endsWith('.json') || file.endsWith('.txt')) {
      scanText(file, path.relative(kitArtifact.kit, file));
    }
  }

  const packageLicensing = readJson<{ copy?: unknown[] }>(
    path.join(packageRoot, 'dist/third_party/hamlib/PACKAGE-LICENSING.json'),
  );
  assert(
    Array.isArray(packageLicensing.copy) && packageLicensing.copy.length > 0,
    'PACKAGE-LICENSING.json has no copy entries',
  );

  log(
    SCOPE,
    `OK: ${path.basename(tarball)} (${readdirSync(packageRoot).length} top-level entries, `
    + `${included.length} linked Hamlib objects, source kit verified)`,
  );

  cleanup(work, keep);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

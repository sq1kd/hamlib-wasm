// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert, fail } from './errors.ts';
import { assertFile, readJson, sha256File, walk } from './files.ts';
import {
  NATIVE_DIR,
  REPO_ROOT,
  releaseArchivePath,
  releaseSourceDirName,
} from './paths.ts';
import type { Upstream } from './upstream.ts';

/** Pack the workspace package and return the absolute tarball path. */
export function packTarball(destination: string): string {
  mkdirSync(destination, { recursive: true });
  const output = execFileSync(
    'npm',
    [
      'pack',
      '--workspace=packages/hamlib-wasm',
      '--pack-destination',
      destination,
      '--json',
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const parsed = JSON.parse(output) as { filename?: string }[];
  const filename = parsed[0]?.filename;

  assert(filename, 'npm pack did not report a tarball filename');
  return path.join(destination, filename);
}

/** Extract an npm tarball and return its `package/` root. */
export function extractTarball(tarball: string, destination: string): string {
  assertFile(tarball, 'npm tarball');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', destination], { stdio: 'inherit' });

  const packageRoot = path.join(destination, 'package');
  assert(existsSync(packageRoot), 'the tarball does not contain package/');
  return packageRoot;
}

export interface KitArtifact {
  readonly kit: string;
  readonly kitArchive: string;
  readonly source: Record<string, unknown>;
}

/** Extract `corresponding-source.tar.gz` from an unpacked package. */
export function extractKit(packageRoot: string, destination: string): KitArtifact {
  const source = readJson<Record<string, unknown>>(
    path.join(packageRoot, 'dist/third_party/hamlib/SOURCE.json'),
  );
  const corresponding = source.correspondingSource;

  assert(typeof corresponding === 'string', 'SOURCE.json has no correspondingSource path');
  const kitArchive = path.join(packageRoot, corresponding);

  assertFile(kitArchive, 'corresponding-source archive');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', kitArchive, '-C', destination], { stdio: 'inherit' });

  return { kit: destination, kitArchive, source };
}

/** Any .rej or .orig left behind means a hunk did not land where intended. */
export function collectPatchLeftovers(dir: string): string[] {
  return walk(dir).filter((file) => file.endsWith('.rej') || file.endsWith('.orig'));
}

export function applyPatchFile(patchFile: string, sourceDir: string): void {
  try {
    execFileSync(
      'patch',
      ['-p1', '--batch', '--forward', '--fuzz=0', '-i', patchFile],
      { cwd: sourceDir, stdio: 'inherit' },
    );
  } catch {
    fail('patch', `patch did not apply cleanly: ${patchFile}`);
  }
}

export function applyPatches(upstream: Upstream, sourceDir: string): void {
  for (const patch of upstream.patches) {
    applyPatchFile(patch.path, sourceDir);
  }

  const leftovers = collectPatchLeftovers(sourceDir);

  if (leftovers.length > 0) {
    fail('patch', `patch application left rejects behind: ${leftovers.join(', ')}`);
  }
}

export function installTransport(sourceDir: string): void {
  copyFileSync(
    path.join(NATIVE_DIR, 'web_serial.c'),
    path.join(sourceDir, 'src', 'serial.c'),
  );

  const serial = readFileSync(path.join(sourceDir, 'src', 'serial.c'), 'utf8');

  if (!serial.includes('Web Serial')) {
    fail('transport', 'src/serial.c was not replaced with the browser implementation');
  }
}

/** Verify, extract, patch and prepare the pinned tree in `workDir`. */
export function prepareSourceTree(
  upstream: Upstream,
  workDir: string,
  archive = releaseArchivePath(upstream),
): string {
  assertFile(archive, 'source archive');
  assert(
    sha256File(archive) === upstream.archive.sha256,
    `source archive hash does not match the pinned manifest: ${archive}`,
  );

  mkdirSync(workDir, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', workDir], { stdio: 'inherit' });

  const sourceDir = path.join(workDir, releaseSourceDirName(upstream));
  assert(existsSync(path.join(sourceDir, 'configure')), 'the archive layout is unexpected');

  applyPatches(upstream, sourceDir);
  installTransport(sourceDir);
  return sourceDir;
}

export interface PreparedKit extends KitArtifact {
  readonly sourceDir: string;
}

/** Extract the kit, verify its archive and patch, and prepare the source tree. */
export function prepareKit(
  upstream: Upstream,
  packageRoot: string,
  workDir: string,
): PreparedKit {
  const artifact = extractKit(packageRoot, path.join(workDir, 'kit'));
  const archive = path.join(artifact.kit, 'source', upstream.archive.name);
  const patch = upstream.patches[0];

  assert(patch, 'the release config has no patch');
  const kitPatch = path.join(artifact.kit, 'patches', patch.file);
  assertFile(archive, 'kit source archive');
  assertFile(kitPatch, 'kit patch');
  assert(
    sha256File(archive) === upstream.archive.sha256,
    'the kit archive hash does not match hamlib.config.yaml',
  );
  assert(
    artifact.source.sourceArchiveSha256 === upstream.archive.sha256,
    'the kit SOURCE.json archive hash does not match hamlib.config.yaml',
  );
  assert(
    sha256File(kitPatch) === artifact.source.patchSha256,
    'the kit patch hash does not match SOURCE.json',
  );

  const sourceDir = prepareSourceTree(upstream, path.join(workDir, 'source'), archive);
  return { ...artifact, sourceDir };
}

/** Remove a work directory unless the caller asked to keep it. */
export function cleanup(dir: string, keep: boolean): void {
  if (!keep) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    process.stderr.write(`artifacts kept at ${dir}\n`);
  }
}

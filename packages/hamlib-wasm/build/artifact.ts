// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert } from './errors.ts';
import { log } from './exec.ts';
import { assertFile, sha256File, walk } from './files.ts';
import {
  NATIVE_DIR,
  REPO_ROOT,
  SOURCE_JSON,
  packageRelative,
  releaseArchivePath,
  releaseSourceDirName,
} from './paths.ts';
import { type SourceManifest, readSourceManifest } from './provenance.ts';
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
  readonly source: SourceManifest;
}

/** Extract `corresponding-source.tar.gz` from an unpacked package. */
export function extractKit(packageRoot: string, destination: string): KitArtifact {
  const source = readSourceManifest(path.join(packageRoot, packageRelative(SOURCE_JSON)));

  assert(
    typeof source.correspondingSource === 'string',
    'SOURCE.json has no correspondingSource path',
  );
  const kitArchive = path.join(packageRoot, source.correspondingSource);

  assertFile(kitArchive, 'corresponding-source archive');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', kitArchive, '-C', destination], { stdio: 'inherit' });

  return { kit: destination, kitArchive, source };
}

/** Any .rej or .orig left behind means a hunk did not land where intended. */
function collectPatchLeftovers(dir: string): string[] {
  return walk(dir).filter((file) => file.endsWith('.rej') || file.endsWith('.orig'));
}

function applyPatchFile(patchFile: string, sourceDir: string): void {
  try {
    execFileSync(
      'patch',
      ['-p1', '--batch', '--forward', '--fuzz=0', '-i', patchFile],
      { cwd: sourceDir, stdio: 'inherit' },
    );
  } catch {
    throw new Error(`patch did not apply cleanly: ${patchFile}`);
  }
}

/** Apply patch files in order and require that every hunk landed. */
export function applyPatchFiles(patchFiles: readonly string[], sourceDir: string): void {
  for (const patchFile of patchFiles) {
    applyPatchFile(patchFile, sourceDir);
  }

  const leftovers = collectPatchLeftovers(sourceDir);

  assert(
    leftovers.length === 0,
    `patch application left rejects behind: ${leftovers.join(', ')}`,
  );
}

export function installTransport(sourceDir: string): void {
  copyFileSync(
    path.join(NATIVE_DIR, 'web_serial.c'),
    path.join(sourceDir, 'src', 'serial.c'),
  );

  const serial = readFileSync(path.join(sourceDir, 'src', 'serial.c'), 'utf8');

  assert(
    serial.includes('Web Serial'),
    'src/serial.c was not replaced with the browser implementation',
  );
}

/** Download the pinned archive unless the release cache holds a verified copy. */
export async function ensureArchive(scope: string, upstream: Upstream): Promise<string> {
  const archive = releaseArchivePath(upstream);

  if (existsSync(archive) && sha256File(archive) === upstream.archive.sha256) {
    log(scope, `archive verified: ${path.relative(REPO_ROOT, archive)}`);
    return archive;
  }

  mkdirSync(path.dirname(archive), { recursive: true });
  log(scope, `downloading ${upstream.archive.url}`);

  const response = await fetch(upstream.archive.url, { redirect: 'follow' });

  assert(response.ok, `download failed with HTTP ${response.status}`);
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

  const actual = sha256File(archive);

  if (actual !== upstream.archive.sha256) {
    rmSync(archive, { force: true });
    throw new Error(
      `archive SHA-256 mismatch: expected ${upstream.archive.sha256}, got ${actual}`,
    );
  }

  log(scope, 'archive downloaded and verified');
  return archive;
}

/** Verify, extract and patch the pinned tree in `workDir`. */
export function preparePatchedTree(
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

  applyPatchFiles(upstream.patches.map((patch) => patch.path), sourceDir);
  return sourceDir;
}

/** The patched tree with the browser transport installed. */
export function prepareSourceTree(
  upstream: Upstream,
  workDir: string,
  archive = releaseArchivePath(upstream),
): string {
  const sourceDir = preparePatchedTree(upstream, workDir, archive);

  installTransport(sourceDir);
  return sourceDir;
}

/** Remove a work directory unless the caller asked to keep it. */
export function cleanup(dir: string, keep: boolean): void {
  if (!keep) {
    rmSync(dir, { recursive: true, force: true });
  } else {
    process.stderr.write(`artifacts kept at ${dir}\n`);
  }
}

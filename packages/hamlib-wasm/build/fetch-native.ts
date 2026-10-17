#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Fetch, verify, patch and extract the pinned Hamlib release.
 *
 * Split from the native build so that the binding generator only needs the
 * extracted headers: `mise run generate` depends on this task, not on a full
 * Wasm build.  The download is verified against the SHA-256 in
 * `hamlib.config.yaml` and the source tree is only re-extracted when the
 * release inputs change.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { installTransport, prepareSourceTree } from './artifact.ts';
import { log, requireTool } from './exec.ts';
import { readJson, sha256File, writeJson } from './files.ts';
import {
  releaseArchivePath,
  releaseCacheDir,
  releaseSourceDir,
  releaseStampPath,
} from './paths.ts';
import { loadUpstream, manifestDigest } from './upstream.ts';

const SCOPE = 'fetch-native';
const UPSTREAM = loadUpstream();
const CACHE_DIR = releaseCacheDir(UPSTREAM);
const ARCHIVE_PATH = releaseArchivePath(UPSTREAM);
const SOURCE_DIR = releaseSourceDir(UPSTREAM);
const STAMP_PATH = releaseStampPath(UPSTREAM, 'fetch');

async function ensureArchive(): Promise<void> {
  if (existsSync(ARCHIVE_PATH) && sha256File(ARCHIVE_PATH) === UPSTREAM.archive.sha256) {
    log(SCOPE, `archive verified: ${path.relative(process.cwd(), ARCHIVE_PATH)}`);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  log(SCOPE, `downloading ${UPSTREAM.archive.url}`);

  const response = await fetch(UPSTREAM.archive.url, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}`);
  }

  writeFileSync(ARCHIVE_PATH, Buffer.from(await response.arrayBuffer()));
  const actual = sha256File(ARCHIVE_PATH);

  if (actual !== UPSTREAM.archive.sha256) {
    rmSync(ARCHIVE_PATH, { force: true });
    throw new Error(
      `archive SHA-256 mismatch: expected ${UPSTREAM.archive.sha256}, got ${actual}`,
    );
  }

  log(SCOPE, 'archive downloaded and verified');
}

/** The release inputs the extracted tree was produced from. */
function extractedDigest(): string {
  return createHash('sha256')
    .update(`${manifestDigest(UPSTREAM)}\0${UPSTREAM.archive.sha256}`)
    .digest('hex');
}

function stampMatches(): boolean {
  if (!existsSync(STAMP_PATH) || !existsSync(path.join(SOURCE_DIR, 'configure'))) {
    return false;
  }

  try {
    const parsed = readJson<{ digest?: unknown }>(STAMP_PATH);
    return parsed.digest === extractedDigest();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  requireTool(SCOPE, 'tar', 'Run this through `mise run fetch-native`.');
  requireTool(SCOPE, 'patch', 'Run this through `mise run fetch-native`.');

  if (stampMatches()) {
    log(SCOPE, 'extracted tree is up to date');
  } else {
    await ensureArchive();
    rmSync(path.join(CACHE_DIR, 'hamlib'), { recursive: true, force: true });
    prepareSourceTree(UPSTREAM, path.dirname(SOURCE_DIR), ARCHIVE_PATH);
    writeJson(STAMP_PATH, { digest: extractedDigest() });
  }

  /* Install on every run: a local edit to web_serial.c must reach the tree
   * even when the release stamp still matches. */
  installTransport(SOURCE_DIR);
  log(SCOPE, 'upstream tree ready');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

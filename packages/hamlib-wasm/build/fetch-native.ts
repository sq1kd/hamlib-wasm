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
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { ensureArchive, installTransport, prepareSourceTree } from './artifact.ts';
import { runMain } from './errors.ts';
import { log, requireTool } from './exec.ts';
import { readJson, writeJson } from './files.ts';
import { releaseSourceDir, releaseStampPath } from './paths.ts';
import { loadUpstream, manifestDigest } from './upstream.ts';

const SCOPE = 'fetch-native';
const UPSTREAM = loadUpstream();
const SOURCE_DIR = releaseSourceDir(UPSTREAM);
const STAMP_PATH = releaseStampPath(UPSTREAM, 'fetch');

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
  requireTool('tar', 'Run this through `mise run fetch-native`.');
  requireTool('patch', 'Run this through `mise run fetch-native`.');

  if (stampMatches()) {
    log(SCOPE, 'extracted tree is up to date');
  } else {
    const archive = await ensureArchive(SCOPE, UPSTREAM);

    rmSync(path.dirname(SOURCE_DIR), { recursive: true, force: true });
    prepareSourceTree(UPSTREAM, path.dirname(SOURCE_DIR), archive);
    writeJson(STAMP_PATH, { digest: extractedDigest() });
  }

  /* Install on every run: a local edit to web_serial.c must reach the tree
   * even when the release stamp still matches. */
  installTransport(SOURCE_DIR);
  log(SCOPE, 'upstream tree ready');
}

await runMain(SCOPE, main);

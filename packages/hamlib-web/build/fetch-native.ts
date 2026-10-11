#!/usr/bin/env node
/**
 * Fetch, verify, patch and extract the pinned Hamlib release.
 *
 * Split from the native build so that the binding generator only needs the
 * extracted headers: `mise run generate` depends on this task, not on a full
 * Wasm build.  The download is verified against the SHA-256 in
 * `hamlib.config.yaml` and the source tree is only re-extracted when the
 * release inputs change.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadUpstream, manifestDigest, upstreamSourceDir } from './upstream.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const NATIVE_DIR = path.join(PACKAGE_DIR, 'native');

const UPSTREAM = loadUpstream();
const HAMLIB_VERSION = UPSTREAM.version;

const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'hamlib', HAMLIB_VERSION);
const ARCHIVE_PATH = path.join(CACHE_DIR, UPSTREAM.archive.name);
const SOURCE_DIR = upstreamSourceDir(UPSTREAM);
const STAMP_PATH = path.join(CACHE_DIR, 'fetch-stamp.json');

function log(message: string): void {
  process.stdout.write(`[fetch-native] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[fetch-native] error: ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function requireTool(tool: string): void {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
  } catch {
    fail(`${tool} is not available; run this through \`mise run fetch-native\``);
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function ensureArchive(): Promise<void> {
  if (existsSync(ARCHIVE_PATH) && sha256File(ARCHIVE_PATH) === UPSTREAM.archive.sha256) {
    log(`archive verified: ${path.relative(REPO_ROOT, ARCHIVE_PATH)}`);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  log(`downloading ${UPSTREAM.archive.url}`);

  const response = await fetch(UPSTREAM.archive.url, { redirect: 'follow' });

  if (!response.ok) {
    fail(`download failed with HTTP ${response.status}`);
  }

  writeFileSync(ARCHIVE_PATH, Buffer.from(await response.arrayBuffer()));

  const actual = sha256File(ARCHIVE_PATH);

  if (actual !== UPSTREAM.archive.sha256) {
    rmSync(ARCHIVE_PATH, { force: true });
    fail(`archive SHA-256 mismatch: expected ${UPSTREAM.archive.sha256}, got ${actual}`);
  }

  log('archive downloaded and verified');
}

/** Any .rej or .orig left behind means a hunk did not land where intended. */
function collectPatchLeftovers(dir: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      found.push(...collectPatchLeftovers(full));
    } else if (entry.name.endsWith('.rej') || entry.name.endsWith('.orig')) {
      found.push(path.relative(SOURCE_DIR, full));
    }
  }

  return found;
}

function extractAndPatch(): void {
  log('extracting a fresh source tree');

  rmSync(path.join(CACHE_DIR, 'hamlib'), { recursive: true, force: true });
  mkdirSync(path.dirname(SOURCE_DIR), { recursive: true });

  run('tar', ['xzf', ARCHIVE_PATH, '-C', path.dirname(SOURCE_DIR)], REPO_ROOT);

  if (!existsSync(path.join(SOURCE_DIR, 'configure'))) {
    fail(`unexpected archive layout: ${SOURCE_DIR}/configure is missing`);
  }

  /* Strict: no fuzz, and a leftover reject file fails the build. */
  for (const patch of UPSTREAM.patches) {
    log(`applying ${patch.file}`);

    try {
      run('patch', ['-p1', '--batch', '--forward', '--fuzz=0', '-i', patch.path], SOURCE_DIR);
    } catch {
      fail(
        `${patch.file} did not apply cleanly to ${UPSTREAM.archive.name}; the release or `
        + 'the patch has to be updated together',
      );
    }
  }

  const leftovers = collectPatchLeftovers(SOURCE_DIR);

  if (leftovers.length > 0) {
    fail(`patch application left rejects behind: ${leftovers.join(', ')}`);
  }
}

/*
 * Install the project owned browser transport over upstream's `src/serial.c`.
 *
 * This runs on every invocation, not only when the tree is re-extracted: the
 * stamp above tracks the pinned release, so an edit to `native/web_serial.c`
 * or `native/web_serial.h` would otherwise leave the previous copy installed
 * and the build would fail on a stale definition that no longer matches the
 * new header.  Both files are small, so the copy is cheaper than the round of
 * confusing errors it prevents.
 */
function installTransport(): void {
  log('installing the browser serial transport as src/serial.c');
  copyFileSync(
    path.join(NATIVE_DIR, 'web_serial.c'),
    path.join(SOURCE_DIR, 'src', 'serial.c'),
  );

  const serial = readFileSync(path.join(SOURCE_DIR, 'src', 'serial.c'), 'utf8');

  if (!serial.includes('Web Serial')) {
    fail('src/serial.c was not replaced with the browser implementation');
  }
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

  const parsed = JSON.parse(readFileSync(STAMP_PATH, 'utf8')) as { digest?: unknown };

  return parsed.digest === extractedDigest();
}

async function main(): Promise<void> {
  requireTool('tar');
  requireTool('patch');

  if (stampMatches()) {
    log('extracted tree is up to date');
  } else {
    await ensureArchive();
    extractAndPatch();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(STAMP_PATH, `${JSON.stringify({ digest: extractedDigest() }, null, 2)}\n`);
  }

  installTransport();

  log('upstream tree ready');
}

await main();

#!/usr/bin/env node
/**
 * Compare a representative transaction with native Hamlib.
 *
 * The browser package's own baseline (`packages/hamlib-wasm/baseline/baseline.json`)
 * records the CAT commands a fixed TS-480 transaction produces in the browser.
 * This script builds the same pinned Hamlib release for the host machine, runs
 * the same configuration sequence and the same transaction against a pseudo
 * terminal, and compares the two command logs.
 *
 * That isolates the adapter: the upstream backends are identical, so a
 * difference means the Web Serial transport, the facade or the way the module
 * is opened changed radio-facing behaviour.
 *
 * The host build lives in `.cache/hamlib-host` and is unrelated to the Wasm
 * build.  This is an opt-in verification step (`mise run compare:native`): it
 * needs a host C compiler and network access, but no browser.
 */
import { createHash } from 'node:crypto';
import { execFileSync, type StdioOptions } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { loadUpstream, PACKAGE_DIR, REPO_ROOT } from './upstream.ts';

const UPSTREAM = loadUpstream();

const HOST_CACHE = path.join(REPO_ROOT, '.cache', 'hamlib-host');
const ARCHIVE_PATH = path.join(HOST_CACHE, UPSTREAM.archive.name);
const SOURCE_DIR = path.join(
  HOST_CACHE,
  `hamlib-${UPSTREAM.version}`,
);
const BUILD_DIR = path.join(SOURCE_DIR, 'build');
const LIBRARY = path.join(BUILD_DIR, 'src', '.libs', 'libhamlib.a');
const BINARY = path.join(HOST_CACHE, 'host-trace');

const BASELINE_PATH = path.join(PACKAGE_DIR, 'baseline', 'baseline.json');
const HARNESS = path.join(REPO_ROOT, 'tests', 'native', 'host-trace.c');

const CONFIGURE_ARGS: readonly string[] = [
  '--disable-shared',
  '--enable-static',
  '--without-libusb',
  '--without-readline',
  '--without-indi',
  '--without-cxx-binding',
  '--disable-html-matrix',
  '--disable-winradio',
  '--disable-parallel',
];

function log(message: string): void {
  process.stdout.write(`[compare-native] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[compare-native] error: ${message}\n`);
  process.exit(1);
}

interface RunOptions {
  readonly stdio?: StdioOptions;
  readonly cwd?: string;
  readonly encoding?: BufferEncoding;
}

function run(
  command: string,
  args: readonly string[],
  options: RunOptions & { readonly encoding: BufferEncoding },
): string;
function run(command: string, args: readonly string[], options?: RunOptions): void;
function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): string | undefined {
  const output = execFileSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    cwd: options.cwd,
    encoding: options.encoding,
  });

  return typeof output === 'string' ? output : undefined;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function ensureArchive(): Promise<void> {
  if (existsSync(ARCHIVE_PATH) && sha256File(ARCHIVE_PATH) === UPSTREAM.archive.sha256) {
    return;
  }

  mkdirSync(HOST_CACHE, { recursive: true });
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
}

async function ensureLibrary(): Promise<void> {
  if (existsSync(LIBRARY)) { return; }

  await ensureArchive();

  log('extracting a pristine tree for the host build');
  rmSync(SOURCE_DIR, { recursive: true, force: true });
  run('tar', ['xzf', ARCHIVE_PATH, '-C', HOST_CACHE]);

  if (!existsSync(path.join(SOURCE_DIR, 'configure'))) {
    fail(`unexpected archive layout: ${SOURCE_DIR}/configure is missing`);
  }

  mkdirSync(BUILD_DIR, { recursive: true });

  log('configuring and building the host library');
  run(path.join(SOURCE_DIR, 'configure'), CONFIGURE_ARGS, { cwd: BUILD_DIR });
  run('make', ['-j', '8', '-C', 'src'], { cwd: BUILD_DIR });
}

function buildHarness(): void {
  log('building the reference harness');

  run('cc', [
    '-O1',
    '-o',
    BINARY,
    HARNESS,
    `-I${path.join(BUILD_DIR, 'include')}`,
    `-I${path.join(SOURCE_DIR, 'include')}`,
    LIBRARY,
  ]);
}

function trace(): string[] {
  const output = run(BINARY, [SOURCE_DIR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * The browser build skips the Morse worker start (the single upstream patch
 * hunk), so its open never asks for the CW keyspeed; the host build does.
 * Everything else must match, so that probe is removed before comparing - and
 * its absence from the browser trace is asserted, which is what makes the
 * patch's effect visible instead of hidden.
 */
const MORSE_PROBE = 'KS';

function compare(browser: readonly string[], native: readonly string[]): string[] {
  const browserMorse = browser.filter((command) => command === MORSE_PROBE);
  const nativeMorse = native.filter((command) => command === MORSE_PROBE);

  if (browserMorse.length !== 0) {
    fail(
      `the browser trace contains ${browserMorse.length} ${MORSE_PROBE} probe(s): `
      + 'the Morse worker patch is not taking effect',
    );
  }

  if (nativeMorse.length !== 1) {
    fail(
      `expected the host trace to contain exactly one ${MORSE_PROBE} probe, found `
      + `${nativeMorse.length}; the comparison no longer describes the patch`,
    );
  }

  return native.filter((command) => command !== MORSE_PROBE);
}

function main(): void {
  log(`pinned release ${UPSTREAM.version}`);

  if (!existsSync(HARNESS)) {
    fail(`the reference harness is missing: ${path.relative(REPO_ROOT, HARNESS)}`);
  }

  if (!existsSync(BASELINE_PATH)) {
    fail(
      'the browser baseline is missing; run `mise run baseline:record` first',
    );
  }

  ensureLibrary().then(() => {
    buildHarness();

    const browser: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).ts480.wire;
    const native = compare(browser, trace());

    if (native.join('|') === browser.join('|')) {
      log(`identical: ${native.length} CAT commands match the browser baseline`);
      return;
    }

    const width = Math.max(native.length, browser.length);
    const lines = ['  #  browser            native'];

    for (let index = 0; index < width; index++) {
      const left = browser[index] ?? '<none>';
      const right = native[index] ?? '<none>';

      lines.push(
        `  ${String(index).padStart(2)}  ${left.padEnd(18)} ${right}`
        + (left === right ? '' : '   <-- differs'),
      );
    }

    fail(`the CAT traces differ:\n${lines.join('\n')}`);
  }).catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

main();

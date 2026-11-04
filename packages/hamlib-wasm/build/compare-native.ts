#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Compare a representative transaction with native Hamlib.
 *
 * The browser package's own baseline (`packages/hamlib-wasm/baseline/baseline.json`)
 * records the CAT commands a fixed TS-480 transaction produces in the browser.
 * This script builds the same pinned Hamlib release for the host machine, runs
 * the same configuration sequence and the same transaction against a pseudo
 * terminal, and compares the two command logs.
 *
 * The host build is the same patched source as the Wasm build: this script
 * applies every patch from `hamlib.config.yaml` through `artifact.ts`, exactly
 * as `fetch-native` does, so the upstream backends are identical.  A
 * difference therefore means the Web Serial transport, the facade or the way
 * the module is opened changed radio-facing behaviour.
 *
 * The C emulator in `tests/native/host-trace.c` is a second copy of
 * `tests/browser/fixtures/rigs.ts` and must change with it.
 *
 * The host build lives in `.cache/hamlib-host` and is unrelated to the Wasm
 * build.  This is an opt-in verification step (`mise run compare-native`): it
 * needs a host C compiler and network access, but no browser.
 */
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

import { applyPatches } from './artifact.ts';
import { sha256File } from './files.ts';
import { CONFIGURE_ARGS } from './native-flags.ts';
import { PACKAGE_DIR, REPO_ROOT } from './paths.ts';
import { loadUpstream, manifestDigest } from './upstream.ts';

const UPSTREAM = loadUpstream();
const INPUT_DIGEST = manifestDigest(UPSTREAM);

const HOST_CACHE = path.join(REPO_ROOT, '.cache', 'hamlib-host');
const ARCHIVE_PATH = path.join(HOST_CACHE, UPSTREAM.archive.name);
const HOST_SOURCE_DIR = path.join(HOST_CACHE, `hamlib-${UPSTREAM.version}`);
const HOST_BUILD_DIR = path.join(HOST_SOURCE_DIR, 'build');
const LIBRARY = path.join(HOST_BUILD_DIR, 'src', '.libs', 'libhamlib.a');
const STAMP = path.join(HOST_CACHE, 'build-stamp.json');
const BINARY = path.join(HOST_CACHE, 'host-trace');

const BASELINE_PATH = path.join(PACKAGE_DIR, 'baseline', 'baseline.json');
const HARNESS = path.join(REPO_ROOT, 'tests', 'native', 'host-trace.c');

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
  /* An unpatched cache would make the trace comparison meaningless, so the
   * cached library counts only when it was built from these release inputs. */
  if (
    existsSync(LIBRARY)
    && existsSync(STAMP)
    && readFileSync(STAMP, 'utf8').trim() === INPUT_DIGEST
  ) {
    return;
  }

  await ensureArchive();

  log('extracting a pristine tree for the host build');
  rmSync(HOST_SOURCE_DIR, { recursive: true, force: true });
  run('tar', ['xzf', ARCHIVE_PATH, '-C', HOST_CACHE]);

  if (!existsSync(path.join(HOST_SOURCE_DIR, 'configure'))) {
    fail(`unexpected archive layout: ${HOST_SOURCE_DIR}/configure is missing`);
  }

  log('applying the pinned Hamlib patches to the host tree');
  applyPatches(UPSTREAM, HOST_SOURCE_DIR);

  mkdirSync(HOST_BUILD_DIR, { recursive: true });

  log('configuring and building the host library');
  run(path.join(HOST_SOURCE_DIR, 'configure'), CONFIGURE_ARGS, { cwd: HOST_BUILD_DIR });
  run('make', ['-j', '8', '-C', 'src'], { cwd: HOST_BUILD_DIR });
  writeFileSync(STAMP, `${INPUT_DIGEST}\n`);
}

function buildHarness(): void {
  log('building the reference harness');

  run('cc', [
    '-O1',
    '-o',
    BINARY,
    HARNESS,
    `-I${path.join(HOST_BUILD_DIR, 'include')}`,
    `-I${path.join(HOST_SOURCE_DIR, 'include')}`,
    LIBRARY,
  ]);
}

function trace(): string[] {
  const output = run(BINARY, [HOST_SOURCE_DIR], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  return output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

function main(): void {
  log(`pinned release ${UPSTREAM.version}`);

  if (!existsSync(HARNESS)) {
    fail(`the reference harness is missing: ${path.relative(REPO_ROOT, HARNESS)}`);
  }

  if (!existsSync(BASELINE_PATH)) {
    fail(
      'the browser baseline is missing; run `mise run baseline-record` first',
    );
  }

  ensureLibrary().then(() => {
    buildHarness();

    const browser: string[] = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).ts480.wire;
    const native = trace();

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

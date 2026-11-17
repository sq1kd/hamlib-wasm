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
 * The host build lives next to the Wasm build in the release cache and shares
 * its verified archive.  This is an opt-in verification step
 * (`mise run compare-native`): it needs a host C compiler and, on a cold
 * cache, network access, but no browser.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { ensureArchive, preparePatchedTree } from './artifact.ts';
import { assert, runMain } from './errors.ts';
import { capture, jobs, log, run } from './exec.ts';
import { readJson, writeJson } from './files.ts';
import { CONFIGURE_ARGS } from './native-flags.ts';
import {
  BASELINE_JSON,
  HOST_TRACE_SOURCE,
  REPO_ROOT,
  releaseHostDir,
  releaseSourceDirName,
  releaseStampPath,
} from './paths.ts';
import { loadUpstream, manifestDigest, type Upstream } from './upstream.ts';

const SCOPE = 'compare-native';

interface HostBuild {
  readonly sourceDir: string;
  readonly buildDir: string;
  readonly library: string;
  readonly binary: string;
}

function hostBuild(upstream: Upstream): HostBuild {
  const hostDir = releaseHostDir(upstream);
  const buildDir = path.join(hostDir, 'build');

  return {
    sourceDir: path.join(hostDir, releaseSourceDirName(upstream)),
    buildDir,
    library: path.join(buildDir, 'src', '.libs', 'libhamlib.a'),
    binary: path.join(hostDir, 'host-trace'),
  };
}

function stampMatches(upstream: Upstream, build: HostBuild): boolean {
  const stamp = releaseStampPath(upstream, 'host');

  return existsSync(build.library)
    && existsSync(stamp)
    && readJson<{ digest?: unknown }>(stamp).digest === manifestDigest(upstream);
}

async function ensureLibrary(upstream: Upstream, build: HostBuild): Promise<void> {
  /* An unpatched cache would make the trace comparison meaningless, so the
   * cached library counts only when it was built from these release inputs. */
  if (stampMatches(upstream, build)) {
    log(SCOPE, 'host library is up to date, reusing it');
    return;
  }

  const archive = await ensureArchive(SCOPE, upstream);
  const hostDir = releaseHostDir(upstream);

  log(SCOPE, 'extracting and patching a tree for the host build');
  rmSync(hostDir, { recursive: true, force: true });
  preparePatchedTree(upstream, hostDir, archive);

  log(SCOPE, 'configuring and building the host library');
  mkdirSync(build.buildDir, { recursive: true });
  run(SCOPE, path.join(build.sourceDir, 'configure'), CONFIGURE_ARGS, { cwd: build.buildDir });
  run(SCOPE, 'make', ['-j', jobs(), '-C', 'src'], { cwd: build.buildDir });
  writeJson(releaseStampPath(upstream, 'host'), { digest: manifestDigest(upstream) });
}

function buildHarness(build: HostBuild): void {
  log(SCOPE, 'building the reference harness');
  run(SCOPE, 'cc', [
    '-O1',
    '-o',
    build.binary,
    HOST_TRACE_SOURCE,
    `-I${path.join(build.buildDir, 'include')}`,
    `-I${path.join(build.sourceDir, 'include')}`,
    build.library,
  ]);
}

function trace(build: HostBuild): string[] {
  return capture(SCOPE, build.binary, [build.sourceDir], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function describeDifference(browser: readonly string[], native: readonly string[]): string {
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

  return lines.join('\n');
}

async function main(): Promise<void> {
  const upstream = loadUpstream();
  const build = hostBuild(upstream);

  log(SCOPE, `pinned release ${upstream.version}`);
  assert(
    existsSync(HOST_TRACE_SOURCE),
    `the reference harness is missing: ${path.relative(REPO_ROOT, HOST_TRACE_SOURCE)}`,
  );
  assert(
    existsSync(BASELINE_JSON),
    'the browser baseline is missing; run `mise run baseline-record` first',
  );

  await ensureLibrary(upstream, build);
  buildHarness(build);

  const browser = readJson<{ ts480: { wire: string[] } }>(BASELINE_JSON).ts480.wire;
  const native = trace(build);

  assert(
    native.join('|') === browser.join('|'),
    `the CAT traces differ:\n${describeDifference(browser, native)}`,
  );
  log(SCOPE, `identical: ${native.length} CAT commands match the browser baseline`);
}

await runMain(SCOPE, main);

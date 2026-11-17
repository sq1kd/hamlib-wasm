#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Hand a verified package build to a later CI job: `--save` archives every
 * output `packageBuildOutputs()` names into one file, `--restore` unpacks it
 * into a fresh checkout, so the job publishes or documents exactly what the
 * gate verified without rebuilding it.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert, runMain } from './errors.ts';
import { log, run } from './exec.ts';
import { assertFile } from './files.ts';
import { packageBuildOutputs } from './package-manifest.ts';
import { BUILD_OUTPUTS_ARCHIVE, REPO_ROOT } from './paths.ts';

const SCOPE = 'build-outputs';

function assertOutputs(): readonly string[] {
  const outputs = packageBuildOutputs().map((output) => path.relative(REPO_ROOT, output));

  for (const output of outputs) {
    assert(existsSync(path.join(REPO_ROOT, output)), `build output is missing: ${output}`);
  }

  return outputs;
}

function main(): void {
  const archive = path.relative(REPO_ROOT, BUILD_OUTPUTS_ARCHIVE);

  if (process.argv.includes('--save')) {
    const outputs = assertOutputs();

    mkdirSync(path.dirname(BUILD_OUTPUTS_ARCHIVE), { recursive: true });
    run(SCOPE, 'tar', ['-czf', BUILD_OUTPUTS_ARCHIVE, '-C', REPO_ROOT, ...outputs]);
    log(SCOPE, `saved ${outputs.length} build outputs to ${archive}`);
  } else if (process.argv.includes('--restore')) {
    assertFile(BUILD_OUTPUTS_ARCHIVE, 'build outputs archive');
    run(SCOPE, 'tar', ['-xzf', BUILD_OUTPUTS_ARCHIVE, '-C', REPO_ROOT]);
    log(SCOPE, `restored ${assertOutputs().length} build outputs from ${archive}`);
  } else {
    throw new Error('usage: build-outputs.ts --save | --restore');
  }
}

await runMain(SCOPE, main);

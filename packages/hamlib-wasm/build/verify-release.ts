#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Release gate: pack once, then run package verification and relink
 * verification concurrently.  The package check is quick; the relink check
 * recompiles Hamlib, so overlapping them keeps the gate near relink time
 * rather than the sum of both.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { cleanup, packTarball } from './artifact.ts';
import { log, runConcurrent } from './exec.ts';

const SCOPE = 'verify-release';
const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const work = mkdtempSync(path.join(os.tmpdir(), 'hamlib-wasm-release-'));
  const artifactDir = path.join(work, 'artifact');

  mkdirSync(artifactDir, { recursive: true });
  const tarball = packTarball(artifactDir);

  log(SCOPE, `packed ${path.basename(tarball)}; running package and relink checks`);

  await runConcurrent([
    {
      scope: 'verify-package',
      command: process.execPath,
      args: [
        path.join(HERE, 'verify-package.ts'),
        '--tarball',
        tarball,
        '--work-dir',
        path.join(work, 'package-check'),
      ],
    },
    {
      scope: 'verify-relink',
      command: process.execPath,
      args: [
        path.join(HERE, 'verify-relink.ts'),
        '--tarball',
        tarball,
        '--work-dir',
        path.join(work, 'relink-check'),
      ],
      env: { JOBS: process.env.JOBS ?? '4' },
    },
  ]);

  log(SCOPE, 'release verification passed');
  cleanup(work, keep);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Install the packed package into the consumer fixture (tests/consumer), so
 * `tsc -b` checks it exactly as an external project sees it: through the
 * tarball's `exports`, declarations and files list, not the workspace link.
 *
 * The fixture's package.json depends on `file:packed/hamlib-wasm.tgz`, so the
 * tarball is renamed to that fixed name whatever version npm stamps on it.
 */
import { renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { packTarball } from './artifact.ts';
import { runMain } from './errors.ts';
import { log, run } from './exec.ts';
import { CONSUMER_DIR, CONSUMER_PACKED_DIR } from './paths.ts';

const SCOPE = 'typecheck-consumer';

function main(): void {
  rmSync(CONSUMER_PACKED_DIR, { recursive: true, force: true });
  rmSync(path.join(CONSUMER_DIR, 'node_modules'), { recursive: true, force: true });

  renameSync(packTarball(CONSUMER_PACKED_DIR), path.join(CONSUMER_PACKED_DIR, 'hamlib-wasm.tgz'));

  run(SCOPE, 'npm', [
    'install',
    '--prefix',
    CONSUMER_DIR,
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
  ]);
  log(SCOPE, 'installed the packed package into tests/consumer');
}

await runMain(SCOPE, main);

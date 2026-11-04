#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Compatibility entry point for the release gate.
 *
 * `verify-package --relink` now packs once, extracts once, verifies the
 * package and runs the clean-room relink against that same extraction.  It
 * fully covers the old concurrent gate, sequentially, without a second pack.
 * This shim remains because `mise.toml` and the root `package.json` scripts
 * still name `verify-release`; it forwards every argument unchanged.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
  process.execPath,
  [
    path.join(HERE, 'verify-package.ts'),
    '--relink',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);

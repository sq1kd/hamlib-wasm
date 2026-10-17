#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Run the binding generator for this package.
 *
 * `packages/hamlib-codegen` is a pure transform: headers plus config in,
 * generated artifacts out.  This wrapper supplies the three paths it needs, so
 * the cache layout and the package layout stay in one place.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  CODEGEN_DIR,
  CONFIG_PATH,
  PACKAGE_DIR,
  releaseIncludeDir,
} from './paths.ts';
import { loadUpstream } from './upstream.ts';

const GENERATOR = path.join(CODEGEN_DIR, 'cli.ts');

/** Run the generator with the package's config, outputs and pinned headers. */
export function runCodegen(args: readonly string[]): void {
  const headers = releaseIncludeDir(loadUpstream());

  execFileSync(
    process.execPath,
    [
      GENERATOR,
      '--config',
      CONFIG_PATH,
      '--package',
      PACKAGE_DIR,
      '--headers',
      headers,
      ...args,
    ],
    { stdio: 'inherit' },
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCodegen(process.argv.slice(2));
}

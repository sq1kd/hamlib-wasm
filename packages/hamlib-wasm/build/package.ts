// SPDX-License-Identifier: MIT

/**
 * Compile the public TypeScript package.
 *
 * Runs after `build-native`, which produces the generated Embind declaration
 * (`src/native/hamlib-wasm.d.mts`) and the Wasm/Emscripten assets in
 * `dist/native`.  The public `.d.ts` files are emitted by tsc here; they are
 * never handwritten.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { assert, runMain } from './errors.ts';
import { log, run } from './exec.ts';
import {
  buildCorrespondingSourceKit,
  syncPackageLicenseFiles,
  writeRebuildingGuide,
} from './licensing.ts';
import { generatedPackageOutputs } from './package-manifest.ts';
import { PACKAGE_DIR, TSD_SOURCE_PATH } from './paths.ts';

const SCOPE = 'build-package';

function main(): void {
  assert(
    existsSync(TSD_SOURCE_PATH),
    'the generated Embind declaration is missing; run `mise run build-native` first',
  );

  log(SCOPE, 'type checking and emitting declarations');
  run(SCOPE, 'tsc', ['-p', 'tsconfig.json'], { cwd: PACKAGE_DIR });

  for (const output of generatedPackageOutputs()) {
    assert(existsSync(output), `expected build output is missing: ${path.relative(PACKAGE_DIR, output)}`);
  }

  log(SCOPE, 'rendering license notices and relink kit');
  syncPackageLicenseFiles();
  writeRebuildingGuide();
  buildCorrespondingSourceKit();

  log(SCOPE, 'package build complete');
}

await runMain(SCOPE, main);

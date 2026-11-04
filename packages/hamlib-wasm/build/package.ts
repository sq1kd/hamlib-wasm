// SPDX-License-Identifier: MIT

/**
 * Compile the public TypeScript package.
 *
 * Runs after `build-native`, which produces the generated Embind declaration
 * (`src/native/hamlib-wasm.d.mts`) and the Wasm/Emscripten assets in
 * `dist/native`.  The public `.d.ts` files are emitted by tsc here; they are
 * never handwritten.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { renderLicensingDocs } from './docs.ts';
import { assert } from './errors.ts';
import { log, run } from './exec.ts';
import {
  buildCorrespondingSourceKit,
  syncPackageLicenseFiles,
} from './licensing.ts';
import { generatedPackageOutputs } from './package-manifest.ts';
import {
  DIST_MODULE_JS,
  DIST_MODULE_TSD,
  PACKAGE_DIR,
  TSD_SOURCE_PATH,
} from './paths.ts';

const SCOPE = 'build-package';
const GENERATED_DECLARATION = TSD_SOURCE_PATH;

/**
 * Generated Emscripten output must carry the notices a bare copyright line
 * would otherwise lose.  Prepending comments is behaviour-preserving; the
 * guard keeps repeated builds idempotent.
 */
function prependBanner(file: string, banner: string): void {
  const content = readFileSync(file, 'utf8');

  if (content.startsWith('// SPDX-License-Identifier:')) {
    return;
  }

  writeFileSync(file, `${banner}\n${content}`);
}

function main(): void {
  assert(
    existsSync(GENERATED_DECLARATION),
    'the generated Embind declaration is missing; run `mise run build-native` first',
  );

  log(SCOPE, 'type checking and emitting declarations');
  run(SCOPE, 'tsc', ['-p', 'tsconfig.json'], { cwd: PACKAGE_DIR });

  for (const output of generatedPackageOutputs()) {
    assert(existsSync(output), `expected build output is missing: ${path.relative(PACKAGE_DIR, output)}`);
  }

  log(SCOPE, 'rendering license notices and relink kit');

  prependBanner(
    DIST_MODULE_JS,
    [
      '// SPDX-License-Identifier: MIT',
      '// Emscripten-generated loader. The Emscripten runtime and sysroot',
      '// components are MIT/NCSA-licensed. The WASM binary this loader',
      '// instantiates contains LGPL-2.1-or-later Hamlib; see LICENSE.md and',
      '// THIRD_PARTY_NOTICES.md.',
    ].join('\n'),
  );

  prependBanner(
    GENERATED_DECLARATION,
    [
      '// SPDX-License-Identifier: MIT',
      '// Emscripten-generated TypeScript declarations for the project-owned',
      '// Embind facade. See THIRD_PARTY_NOTICES.md for toolchain notices.',
    ].join('\n'),
  );

  prependBanner(
    DIST_MODULE_TSD,
    [
      '// SPDX-License-Identifier: MIT',
      '// Emscripten-generated TypeScript declarations for the project-owned',
      '// Embind facade. See THIRD_PARTY_NOTICES.md for toolchain notices.',
    ].join('\n'),
  );

  renderLicensingDocs({ check: false });
  syncPackageLicenseFiles();
  buildCorrespondingSourceKit();

  log(SCOPE, 'package build complete');
}

try {
  main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

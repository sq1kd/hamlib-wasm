// SPDX-License-Identifier: MIT
//
// The React example is deployed as a static site and serves the Hamlib WASM.
// A deployed WASM is a distribution of the library binary, so the same notice
// and corresponding-source materials that ship in the npm package must be
// available from the site.  The copy list is generated with the package.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const exampleDir = path.resolve(here, '..');
const packageDir = path.resolve(exampleDir, '..', '..', 'packages', 'hamlib-wasm');
const dist = path.join(exampleDir, 'dist');
const licensingDir = path.join(dist, 'licensing');
const manifestPath = path.join(
  packageDir,
  'dist',
  'third_party',
  'hamlib',
  'PACKAGE-LICENSING.json',
);

if (!existsSync(path.join(dist, 'index.html'))) {
  process.stderr.write(
    '[copy-licensing] error: the Vite build has not produced dist/index.html\n',
  );
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  process.stderr.write(
    `[copy-licensing] error: missing generated manifest ${manifestPath}\n`,
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
rmSync(licensingDir, { recursive: true, force: true });
mkdirSync(licensingDir, { recursive: true });

for (const entry of manifest.copy) {
  const source = path.join(packageDir, entry.from);
  const destination = path.join(licensingDir, entry.to);

  mkdirSync(path.dirname(destination), { recursive: true });

  if (entry.recursive) {
    cpSync(source, destination, { recursive: true });
  } else {
    copyFileSync(source, destination);
  }
}

process.stdout.write('[copy-licensing] wrote dist/licensing\n');

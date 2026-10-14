/**
 * Compile the public TypeScript package.
 *
 * Runs after `build:native`, which produces the generated Embind declaration
 * (src/native/hamlib-wasm.d.mts) and the Wasm/Emscripten assets in dist/native.
 * The public .d.ts files are emitted by tsc here; they are never handwritten.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');

const GENERATED_DECLARATION = path.join(PACKAGE_DIR, 'src', 'native', 'hamlib-wasm.d.mts');

const REQUIRED_OUTPUTS: readonly string[] = [
  path.join(PACKAGE_DIR, 'dist', 'index.js'),
  path.join(PACKAGE_DIR, 'dist', 'index.d.ts'),
  path.join(PACKAGE_DIR, 'dist', 'hamlib.js'),
  path.join(PACKAGE_DIR, 'dist', 'hamlib.d.ts'),
  path.join(PACKAGE_DIR, 'dist', 'node.js'),
  path.join(PACKAGE_DIR, 'dist', 'node.d.ts'),
  path.join(PACKAGE_DIR, 'dist', 'native', 'hamlib-wasm.mjs'),
  path.join(PACKAGE_DIR, 'dist', 'native', 'hamlib-wasm.wasm'),
  path.join(PACKAGE_DIR, 'dist', 'native', 'hamlib-wasm.d.mts'),
];

function log(message: string): void {
  process.stdout.write(`[build-package] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[build-package] error: ${message}\n`);
  process.exit(1);
}

if (!existsSync(GENERATED_DECLARATION)) {
  fail('the generated Embind declaration is missing; run `mise run build:native` first');
}

log('type checking and emitting declarations');
execFileSync('tsc', ['-p', 'tsconfig.json'], { cwd: PACKAGE_DIR, stdio: 'inherit' });

for (const output of REQUIRED_OUTPUTS) {
  if (!existsSync(output)) {
    fail(`expected build output is missing: ${path.relative(PACKAGE_DIR, output)}`);
  }
}

log('package build complete');

#!/usr/bin/env node
/**
 * Typecheck every workspace project from the repository root.
 *
 * The consumer fixture is installed from the *packed* tarball, so it proves
 * that the published declarations and the package exports map agree.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKED_DIR = path.join(ROOT, 'tests', 'consumer', 'packed');
const CONSUMER_DIR = path.join(ROOT, 'tests', 'consumer');
const TARBALL = path.join(PACKED_DIR, 'hamlib-web.tgz');

const PROJECTS = [
  'packages/hamlib-web',
  'examples/basic',
  'tests/harness',
  'tests/browser',
  'tests/consumer',
];

function run(command, args, options = {}) {
  process.stdout.write(`[typecheck] ${command} ${args.join(' ')}\n`);
  execFileSync(command, args, { cwd: options.cwd ?? ROOT, stdio: 'inherit' });
}

rmSync(PACKED_DIR, { recursive: true, force: true });
rmSync(path.join(CONSUMER_DIR, 'node_modules'), { recursive: true, force: true });
mkdirSync(PACKED_DIR, { recursive: true });

run('npm', [
  'pack',
  '--workspace',
  'packages/hamlib-web',
  '--pack-destination',
  PACKED_DIR,
]);

const [tarball] = readdirSync(PACKED_DIR).filter((name) => name.endsWith('.tgz'));

if (!tarball) {
  process.stderr.write('[typecheck] error: npm pack produced no tarball\n');
  process.exit(1);
}

/* The fixture depends on a fixed name so package.json needs no version skew. */
renameSync(path.join(PACKED_DIR, tarball), TARBALL);

run('npm', [
  'install',
  '--prefix',
  CONSUMER_DIR,
  '--no-audit',
  '--no-fund',
  '--no-package-lock',
]);

for (const project of PROJECTS) {
  run(path.join(ROOT, 'node_modules', '.bin', 'tsc'), [
    '-p',
    path.join(project, 'tsconfig.json'),
    '--noEmit',
  ]);
}

process.stdout.write('[typecheck] all projects typecheck\n');

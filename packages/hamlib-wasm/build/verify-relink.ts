#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Clean-room relink acceptance test.
 *
 * Packs (or receives) the npm tarball, extracts only that tarball, rebuilds
 * from the included corresponding-source kit, changes a Hamlib version string,
 * and exercises the replacement through the packaged loader.
 *
 * `runRelink` is exported so `verify-package --relink` can run the same test
 * against the tarball it already extracted, without a second pack or a second
 * extraction.  The command-line entry point below stays reachable for
 * `mise run verify-relink`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  cleanup,
  extractKit,
  extractTarball,
  packTarball,
} from './artifact.ts';
import { assert } from './errors.ts';
import { capture, log, parseFlag, run } from './exec.ts';
import { sha256File } from './files.ts';
import { releaseSourceDirName } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const SCOPE = 'verify-relink';

function modifyHamlibVersion(sourceFile: string): void {
  const text = readFileSync(sourceFile, 'utf8');
  const marker = 'const char *hamlib_version2 = "Hamlib " PACKAGE_VERSION';

  assert(text.includes(marker), `could not find hamlib_version2 in ${sourceFile}`);
  const updated = text.replace(
    /const char \*hamlib_version2 = "Hamlib " PACKAGE_VERSION " " HAMLIBDATETIME " " ARCHBITS;/,
    'const char *hamlib_version2 = "Hamlib " PACKAGE_VERSION " " HAMLIBDATETIME " " ARCHBITS " wasm-relink-test";',
  );

  assert(updated !== text, 'the Hamlib version initializer was not replaced');
  writeFileSync(sourceFile, updated);
}

export interface RelinkOptions {
  /** The already extracted npm tarball root (`package/`). */
  readonly packageRoot: string;
  /** The already extracted corresponding-source kit. */
  readonly kit: string;
  /** The tarball name, used only for reporting. */
  readonly tarball: string;
  /** Directory to relink in; the caller owns it, including cleanup. */
  readonly work: string;
}

/**
 * Rebuild the kit with a modified Hamlib version and prove the packaged
 * loader used it.  The caller must have extracted both the tarball and the
 * kit already; this function never packs or extracts either.
 */
export function runRelink(options: RelinkOptions): void {
  const upstream = loadUpstream();
  const script = path.join(options.kit, 'rebuild.sh');

  mkdirSync(options.work, { recursive: true });
  assert(existsSync(script), 'the kit has no rebuild.sh');

  const relink = path.join(options.work, 'build');
  run(SCOPE, 'sh', [script, '--work-dir', relink, '--prepare'], {
    env: { JOBS: process.env.JOBS ?? '4' },
  });

  const sourceDir = path.join(relink, releaseSourceDirName(upstream));
  const rig = path.join(sourceDir, 'src/rig.c');
  modifyHamlibVersion(rig);

  run(SCOPE, 'sh', [script, '--work-dir', relink, '--source-dir', sourceDir], {
    env: { JOBS: process.env.JOBS ?? '4' },
  });

  const rebuilt = path.join(relink, 'out/hamlib-wasm.wasm');
  assert(existsSync(rebuilt), 'the relink build produced no wasm');

  const installedWasm = path.join(
    options.packageRoot,
    'dist/native/hamlib-wasm.wasm',
  );
  const originalHash = sha256File(installedWasm);
  const rebuiltHash = sha256File(rebuilt);
  assert(originalHash !== rebuiltHash, 'the rebuilt wasm is byte-identical to the package wasm');

  copyFileSync(rebuilt, installedWasm);

  const smoke = path.join(options.work, 'smoke.mjs');
  const loader = pathToFileURL(
    path.join(options.packageRoot, 'dist/native/hamlib-wasm.mjs'),
  ).href;
  writeFileSync(
    smoke,
    [
      `import create from ${JSON.stringify(loader)};`,
      'const module = await create();',
      'const version = module.version();',
      'console.log(version);',
      "if (!version.includes('wasm-relink-test')) {",
      "  throw new Error('the modified Hamlib implementation was not used');",
      '}',
    ].join('\n'),
  );

  const output = capture(SCOPE, process.execPath, [smoke], { env: process.env });
  log(SCOPE, output.trim());
  log(
    SCOPE,
    `OK: rebuilt ${path.basename(options.tarball)} with modified Hamlib `
    + `(${originalHash.slice(0, 12)} -> ${rebuiltHash.slice(0, 12)})`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const tarballArg = parseFlag(args, '--tarball');
  const workArg = parseFlag(args, '--work-dir');
  const keep = args.includes('--keep');
  const work = workArg ?? mkdtempSync(path.join(os.tmpdir(), 'hamlib-wasm-relink-'));

  mkdirSync(work, { recursive: true });

  const tarball = tarballArg ?? packTarball(path.join(work, 'artifact'));
  const packageRoot = extractTarball(tarball, path.join(work, 'unpacked'));
  const kitArtifact = extractKit(packageRoot, path.join(work, 'kit'));

  runRelink({
    packageRoot,
    kit: kitArtifact.kit,
    tarball,
    work: path.join(work, 'relink'),
  });

  cleanup(work, keep);
}

const entryPoint = process.argv[1];

if (
  entryPoint
  && pathToFileURL(path.resolve(entryPoint)).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
    process.exit(1);
  }
}

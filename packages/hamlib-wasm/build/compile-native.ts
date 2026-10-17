// SPDX-License-Identifier: MIT

/**
 * Compile the pinned Hamlib release for the browser.
 *
 * Expects the tree `fetch-native` extracted (which is also what the binding
 * generator reads), then:
 *   1. configures a static-only, single-threaded Emscripten build,
 *   2. builds Hamlib's static library and every built-in rig backend,
 *   3. runs the code generator, links the Embind facade plus the link-time
 *      POSIX wrappers, and emits the generated TypeScript declarations,
 *   4. assembles the Hamlib licence/provenance data into the package.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCodegen } from './codegen.ts';
import { assert } from './errors.ts';
import { capture, log, requireTool, run } from './exec.ts';
import { directoryFiles, fileDigest, readJson } from './files.ts';
import { writeThirdPartyData } from './licensing.ts';
import {
  CONFIGURE_ARGS,
  CONFIGURE_VALUES,
  LINK_ARGS,
  configureCppflags,
  linkArgs,
} from './native-flags.ts';
import {
  CODEGEN_DIR,
  DIST_MODULE_JS,
  DIST_MODULE_TSD,
  DIST_MODULE_WASM,
  DIST_NATIVE_DIR,
  GENERATED_INC,
  GENERATED_TS,
  LIBRARY_JS,
  MODULE_JS,
  MODULE_TSD,
  MODULE_WASM,
  NATIVE_DIR,
  PACKAGE_DIR,
  REPO_ROOT,
  TSD_SOURCE_PATH,
  releaseBuildDir,
  releaseCacheDir,
  releaseLinkMap,
  releaseSourceDir,
  releaseStampPath,
} from './paths.ts';
import { loadUpstream, manifestDigest } from './upstream.ts';

const SCOPE = 'build-native';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM = loadUpstream();
const HAMLIB_VERSION = UPSTREAM.version;

const CACHE_DIR = releaseCacheDir(UPSTREAM);
const SOURCE_DIR = releaseSourceDir(UPSTREAM);
const BUILD_DIR = releaseBuildDir(UPSTREAM);
const STAMP_PATH = releaseStampPath(UPSTREAM, 'build');
const LINK_MAP = releaseLinkMap(UPSTREAM);

/* Files whose content invalidates a previously built libhamlib.a or the linked
 * module.  The release digest covers the pinned release and every applied
 * patch; the config, the generator and every generated artifact change the
 * linked bindings. */
const TRACKED_FILES: readonly string[] = [
  path.join(NATIVE_DIR, 'compat', 'pthread.h'),
  path.join(NATIVE_DIR, 'web_serial.h'),
  path.join(NATIVE_DIR, 'web_serial.c'),
  path.join(NATIVE_DIR, 'web_serial.ts'),
  path.join(NATIVE_DIR, 'emscripten-globals.d.ts'),
  path.join(NATIVE_DIR, 'tsconfig.library.json'),
  path.join(NATIVE_DIR, 'wrapped_io.cpp'),
  path.join(NATIVE_DIR, 'monotonic_time.c'),
  path.join(NATIVE_DIR, 'facade.cpp'),
  path.join(PACKAGE_DIR, 'hamlib.config.yaml'),
  path.join(HERE, 'compile-native.ts'),
  path.join(HERE, 'upstream.ts'),
  path.join(HERE, 'codegen.ts'),
  path.join(HERE, 'native-flags.ts'),
  path.join(HERE, 'paths.ts'),
  ...directoryFiles(GENERATED_INC),
  ...directoryFiles(GENERATED_TS),
  ...directoryFiles(path.join(GENERATED_TS, 'methods')),
  ...directoryFiles(CODEGEN_DIR),
];

interface BuildStamp {
  readonly key: string;
  readonly emcc: string;
  readonly version: string;
}

function emccVersion(): string {
  return capture(SCOPE, 'emcc', ['--version']).split('\n')[0]?.trim() ?? '';
}

function buildKey(): string {
  const hash = createHash('sha256');
  hash.update(`v4\0${manifestDigest(UPSTREAM)}\0${emccVersion()}\0`);
  hash.update([...CONFIGURE_ARGS, ...LINK_ARGS].join('\0'));

  for (const file of TRACKED_FILES) {
    hash.update('\0');
    hash.update(fileDigest(file, PACKAGE_DIR));
  }

  return hash.digest('hex');
}

function readStamp(): BuildStamp | null {
  if (!existsSync(STAMP_PATH)) {
    return null;
  }

  try {
    return readJson<BuildStamp>(STAMP_PATH);
  } catch {
    return null;
  }
}

/**
 * The compile step works on the tree `fetch-native` extracted, so the headers
 * the generator reads and the sources compiled here are the same bytes.
 */
function assertExtracted(): void {
  assert(
    existsSync(path.join(SOURCE_DIR, 'configure'))
    && existsSync(path.join(SOURCE_DIR, 'COPYING.LIB')),
    `the upstream tree is missing at ${path.relative(REPO_ROOT, SOURCE_DIR)}; `
    + 'run `mise run fetch-native` first.',
  );
}

function configureAndBuild(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  log(SCOPE, 'configuring (static, single-threaded, emscripten)');

  run(
    SCOPE,
    'emconfigure',
    [
      path.join(SOURCE_DIR, 'configure'),
      '--host=wasm32-unknown-emscripten',
      ...CONFIGURE_ARGS,
      ...CONFIGURE_VALUES,
      `CPPFLAGS=${configureCppflags(NATIVE_DIR)}`,
    ],
    { cwd: BUILD_DIR },
  );

  log(SCOPE, 'building libhamlib.a and all built-in backends');
  run(SCOPE, 'make', ['-j', String(cpus()), '-C', 'src'], { cwd: BUILD_DIR });
}

function cpus(): number {
  try {
    return Number(capture(SCOPE, 'getconf', ['_NPROCESSORS_ONLN']).trim());
  } catch {
    return 4;
  }
}

function libraryPath(): string {
  return path.join(BUILD_DIR, 'src', '.libs', 'libhamlib.a');
}

function compileJsLibrary(): string {
  mkdirSync(path.dirname(LIBRARY_JS), { recursive: true });

  log(SCOPE, 'compiling the serial transport library');
  run(SCOPE, 'tsc', ['-p', path.join(NATIVE_DIR, 'tsconfig.library.json')], {
    cwd: NATIVE_DIR,
  });

  assert(existsSync(LIBRARY_JS), 'the serial transport library was not produced');
  return LIBRARY_JS;
}

function linkModule(): void {
  assert(existsSync(libraryPath()), `static library missing: ${libraryPath()}`);

  mkdirSync(DIST_NATIVE_DIR, { recursive: true });
  const jsLibrary = compileJsLibrary();

  log(SCOPE, 'linking the Embind facade and generating TypeScript declarations');
  run(
    SCOPE,
    'em++',
    [
      path.join(NATIVE_DIR, 'facade.cpp'),
      path.join(NATIVE_DIR, 'wrapped_io.cpp'),
      path.join(NATIVE_DIR, 'monotonic_time.c'),
      `-I${path.join(BUILD_DIR, 'include')}`,
      `-I${path.join(SOURCE_DIR, 'include')}`,
      `-I${NATIVE_DIR}`,
      libraryPath(),
      '--js-library',
      jsLibrary,
      ...linkArgs(LINK_MAP),
      '-o',
      DIST_MODULE_JS,
      '--emit-tsd',
      MODULE_TSD,
    ],
    { cwd: DIST_NATIVE_DIR },
  );

  for (const [file, label] of [
    [DIST_MODULE_JS, MODULE_JS],
    [DIST_MODULE_WASM, MODULE_WASM],
    [DIST_MODULE_TSD, MODULE_TSD],
  ] as const) {
    assert(existsSync(file), `expected build output ${label} was not produced`);
  }

  mkdirSync(path.dirname(TSD_SOURCE_PATH), { recursive: true });
  copyFileSync(DIST_MODULE_TSD, TSD_SOURCE_PATH);
}

function checkBindings(): void {
  log(SCOPE, 'checking the generated bindings against the upstream headers');
  runCodegen(['--check']);
}

function verifyBindings(): void {
  log(SCOPE, 'verifying the linked module against the config');
  runCodegen(['--emitted', DIST_MODULE_TSD]);
}

function main(): void {
  requireTool(SCOPE, 'emcc', 'Run this through `mise run build-native` so emsdk is on PATH.');
  requireTool(SCOPE, 'emconfigure', 'Run this through `mise run build-native` so emsdk is on PATH.');
  requireTool(SCOPE, 'em++', 'Run this through `mise run build-native` so emsdk is on PATH.');

  const key = buildKey();
  const stamp = readStamp();
  const reusable =
    stamp?.key === key
    && existsSync(libraryPath())
    && existsSync(path.join(SOURCE_DIR, 'COPYING.LIB'));

  if (reusable) {
    log(SCOPE, 'native library is up to date, reusing it');
  } else {
    assertExtracted();
    configureAndBuild();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      STAMP_PATH,
      `${JSON.stringify({ key, emcc: emccVersion(), version: HAMLIB_VERSION }, null, 2)}\n`,
    );
  }

  checkBindings();
  linkModule();
  verifyBindings();
  writeThirdPartyData(LINK_MAP);
  log(SCOPE, 'native build complete');
}

try {
  main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

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
 * Beyond the single hunk in native/patches, upstream sources are unmodified:
 * the transport is reached through native/wrapped_io.cpp and a replaced
 * src/serial.c rather than through edits to src/iofunc.c or src/sleep.c.
 *
 * This script needs the pinned emsdk (for emcc/emconfigure/em++) and the
 * pinned workspace TypeScript (tsc compiles the serial transport library).  It
 * must be run through `mise run build:native` so both are on PATH.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { loadUpstream, manifestDigest, upstreamSourceDir } from './upstream.ts';
import { runCodegen } from './codegen.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
const NATIVE_DIR = path.join(PACKAGE_DIR, 'native');

const UPSTREAM = loadUpstream();
const HAMLIB_VERSION = UPSTREAM.version;
const ARCHIVE_URL = UPSTREAM.archive.url;
const ARCHIVE_SHA256 = UPSTREAM.archive.sha256;

const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'hamlib', HAMLIB_VERSION);
const SOURCE_DIR = upstreamSourceDir(UPSTREAM);
const BUILD_DIR = path.join(CACHE_DIR, 'build');
const STAMP_PATH = path.join(CACHE_DIR, 'build-stamp.json');

const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
const DIST_NATIVE_DIR = path.join(DIST_DIR, 'native');
const MODULE_BASENAME = 'hamlib-web';
const MODULE_JS = `${MODULE_BASENAME}.mjs`;
const MODULE_WASM = `${MODULE_BASENAME}.wasm`;
const MODULE_TSD = `${MODULE_BASENAME}.d.mts`;

const TSD_SOURCE_PATH = path.join(PACKAGE_DIR, 'src', 'native', MODULE_TSD);
const THIRD_PARTY_DIR = path.join(DIST_DIR, 'third_party', 'hamlib');

const GENERATED_INC = path.join(NATIVE_DIR, 'generated');
const GENERATED_TS = path.join(PACKAGE_DIR, 'src', 'native', 'generated');
const CODEGEN_SRC = path.join(REPO_ROOT, 'packages', 'hamlib-codegen', 'src');

/** Every file in a directory, so a new generated file is tracked automatically. */
function directoryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

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
  path.join(NATIVE_DIR, 'facade.cpp'),
  path.join(PACKAGE_DIR, 'hamlib.config.yaml'),
  fileURLToPath(import.meta.url),
  path.join(HERE, 'upstream.ts'),
  path.join(HERE, 'codegen.ts'),
  ...directoryFiles(GENERATED_INC),
  ...directoryFiles(GENERATED_TS),
  ...directoryFiles(path.join(GENERATED_TS, 'methods')),
  ...directoryFiles(CODEGEN_SRC),
];

const CONFIGURE_ARGS = [
  '--disable-shared',
  '--enable-static',
  '--without-libusb',
  '--without-readline',
  '--without-indi',
  '--without-cxx-binding',
  '--disable-html-matrix',
  '--disable-winradio',
  '--disable-parallel',
];

const LINK_ARGS = [
  '-O3',
  '-lembind',
  '-sASYNCIFY',
  '-sMODULARIZE',
  '-sEXPORT_ES6',
  '-sENVIRONMENT=web',
  '-sALLOW_MEMORY_GROWTH',
  '-sNO_EXIT_RUNTIME',
  '-sSTACK_SIZE=1048576',
  '-sEXPORT_NAME=createHamlibWebModule',
  '-sEXPORTED_RUNTIME_METHODS=HamlibWs',
  /* native/wrapped_io.cpp redirects the POSIX calls Hamlib's iofunc.c and
   * sleep.c make on a serial port to the browser transport, so upstream's
   * own read loop, masking and timeout handling stay in charge. */
  '-Wl,--wrap=read',
  '-Wl,--wrap=write',
  '-Wl,--wrap=select',
  '-Wl,--wrap=nanosleep',
];

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
}

function log(message: string): void {
  process.stdout.write(`[build-native] ${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`[build-native] error: ${message}\n`);
  process.exit(1);
}

function run(command: string, args: readonly string[], options: RunOptions = {}): void {
  execFileSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
}

function requireTool(tool: string): void {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
  } catch {
    fail(
      `${tool} is not available. Run this task through \`mise run build:native\` `
      + 'so the pinned emsdk is on PATH.',
    );
  }
}

function fileDigest(file: string): string {
  return createHash('sha256')
    .update(path.relative(PACKAGE_DIR, file))
    .update('\0')
    .update(readFileSync(file))
    .digest('hex');
}

function emccVersion(): string {
  const output = execFileSync('emcc', ['--version'], { encoding: 'utf8' });
  return output.split('\n')[0]?.trim() ?? '';
}

function buildKey(): string {
  const hash = createHash('sha256');
  hash.update(`v3\0${manifestDigest(UPSTREAM)}\0${emccVersion()}\0`);
  hash.update([...CONFIGURE_ARGS, ...LINK_ARGS].join('\0'));

  for (const file of TRACKED_FILES) {
    hash.update('\0');
    hash.update(fileDigest(file));
  }

  return hash.digest('hex');
}

interface BuildStamp {
  readonly key: string;
  readonly emcc: string;
  readonly version: string;
}

function readStamp(): BuildStamp | null {
  if (!existsSync(STAMP_PATH)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(STAMP_PATH, 'utf8')) as BuildStamp;
  } catch {
    return null;
  }
}

/**
 * The compile step works on the tree `fetch-native` extracted, so the headers
 * the generator reads and the sources compiled here are the same bytes.
 */
function assertExtracted(): void {
  if (
    !existsSync(path.join(SOURCE_DIR, 'configure'))
    || !existsSync(path.join(SOURCE_DIR, 'COPYING.LIB'))
  ) {
    fail(
      `the upstream tree is missing at ${path.relative(REPO_ROOT, SOURCE_DIR)}; `
      + 'run `mise run fetch-native` first.',
    );
  }
}

function configureAndBuild(): void {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  log('configuring (static, single-threaded, emscripten)');

  /* Autoconf probes headers with CPPFLAGS, so the compat include directory
   * (which satisfies AX_PTHREAD without thread flags) must live there.
   *
   * `-include sys/types.h` is a build-level fix for upstream headers that use
   * POSIX types such as mode_t without including <sys/types.h> themselves. */
  const cppflags = [
    `-I${NATIVE_DIR}`,
    `-I${path.join(NATIVE_DIR, 'compat')}`,
    '-include sys/types.h',
  ].join(' ');

  run(
    'emconfigure',
    [
      path.join(SOURCE_DIR, 'configure'),
      '--host=wasm32-unknown-emscripten',
      ...CONFIGURE_ARGS,
      `CPPFLAGS=${cppflags}`,
      'CFLAGS=-O2',
      'CXXFLAGS=-O2',
      'PTHREAD_CFLAGS=',
      'PTHREAD_LIBS=',
    ],
    { cwd: BUILD_DIR },
  );

  log('building libhamlib.a and all built-in backends');

  run('make', ['-j', String(cpus()), '-C', 'src'], { cwd: BUILD_DIR });
}

function cpus(): number {
  try {
    return Number(execFileSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).trim());
  } catch {
    return 4;
  }
}

function libraryPath(): string {
  return path.join(BUILD_DIR, 'src', '.libs', 'libhamlib.a');
}

/**
 * Compile the project-owned serial transport to the JS library Emscripten
 * consumes.  The source is strict TypeScript; tsc is the pinned workspace
 * compiler, the same one the package build uses.
 */
function compileJsLibrary(): string {
  const outputDir = path.join(DIST_DIR, 'native', 'library');
  mkdirSync(outputDir, { recursive: true });

  log('compiling the serial transport library');

  run('tsc', ['-p', path.join(NATIVE_DIR, 'tsconfig.library.json')], { cwd: NATIVE_DIR });

  const library = path.join(outputDir, 'web_serial.js');

  if (!existsSync(library)) {
    fail('the serial transport library was not produced');
  }

  return library;
}

function linkModule(): void {
  if (!existsSync(libraryPath())) {
    fail(`static library missing: ${libraryPath()}`);
  }

  mkdirSync(DIST_NATIVE_DIR, { recursive: true });

  const jsLibrary = compileJsLibrary();

  log('linking the Embind facade and generating TypeScript declarations');
  run(
    'em++',
    [
      path.join(NATIVE_DIR, 'facade.cpp'),
      path.join(NATIVE_DIR, 'wrapped_io.cpp'),
      `-I${path.join(BUILD_DIR, 'include')}`,
      `-I${path.join(SOURCE_DIR, 'include')}`,
      `-I${NATIVE_DIR}`,
      libraryPath(),
      '--js-library',
      jsLibrary,
      ...LINK_ARGS,
      '-o',
      path.join(DIST_NATIVE_DIR, MODULE_JS),
      '--emit-tsd',
      MODULE_TSD,
    ],
    { cwd: DIST_NATIVE_DIR },
  );

  for (const asset of [MODULE_JS, MODULE_WASM, MODULE_TSD]) {
    if (!existsSync(path.join(DIST_NATIVE_DIR, asset))) {
      fail(`expected build output ${asset} was not produced`);
    }
  }

  mkdirSync(path.dirname(TSD_SOURCE_PATH), { recursive: true });
  copyFileSync(path.join(DIST_NATIVE_DIR, MODULE_TSD), TSD_SOURCE_PATH);
}

function checkBindings(): void {
  log('checking the generated bindings against the upstream headers');
  runCodegen(['--check']);
}

function verifyBindings(): void {
  log('verifying the linked module against the config');
  runCodegen(['--emitted', path.join(DIST_NATIVE_DIR, MODULE_TSD)]);
}

function writeThirdPartyData(): void {
  mkdirSync(THIRD_PARTY_DIR, { recursive: true });

  copyFileSync(
    path.join(SOURCE_DIR, 'COPYING.LIB'),
    path.join(THIRD_PARTY_DIR, 'COPYING.LIB'),
  );

  for (const patch of UPSTREAM.patches) {
    copyFileSync(patch.path, path.join(THIRD_PARTY_DIR, patch.file));
  }

  const source = {
    package: 'Hamlib',
    version: HAMLIB_VERSION,
    series: UPSTREAM.series,
    license: UPSTREAM.license,
    url: ARCHIVE_URL,
    sha256: ARCHIVE_SHA256,
    patches: UPSTREAM.patches.map((patch) => ({
      file: patch.file,
      purpose: patch.purpose,
    })),
    note:
      'Built into WebAssembly with the browser serial transport in '
      + 'packages/hamlib-web/native. Rebuild with `mise run build:native`; '
      + 'the pinned release is described by packages/hamlib-web/hamlib.config.yaml.',
  };

  writeFileSync(
    path.join(THIRD_PARTY_DIR, 'SOURCE.json'),
    `${JSON.stringify(source, null, 2)}\n`,
  );

  log('wrote third-party licence and provenance data');
}

function main(): void {
  requireTool('emcc');
  requireTool('emconfigure');
  requireTool('em++');

  const key = buildKey();
  const stamp = readStamp();
  const reusable =
    stamp?.key === key
    && existsSync(libraryPath())
    && existsSync(path.join(SOURCE_DIR, 'COPYING.LIB'));

  if (reusable) {
    log('native library is up to date, reusing it');
  } else {
    assertExtracted();
    configureAndBuild();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      STAMP_PATH,
      `${JSON.stringify({ key, emcc: emccVersion(), version: HAMLIB_VERSION }, null, 2)}\n`,
    );
  }

  /* The config, the committed generated files and the upstream headers must
   * agree before anything is linked. */
  checkBindings();

  linkModule();

  /* ... and the declaration Emscripten emitted must expose exactly that
   * surface. */
  verifyBindings();

  writeThirdPartyData();
  log('native build complete');
}

await main();

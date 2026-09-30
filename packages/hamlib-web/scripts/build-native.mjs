#!/usr/bin/env node
/**
 * Build Hamlib 4.7.2 for the browser.
 *
 * Steps, in order:
 *   1. download the pinned upstream release archive and verify its SHA-256,
 *   2. extract a fresh source tree and apply packages/hamlib-web/native/patches,
 *   3. replace upstream src/serial.c with the project-owned browser transport,
 *   4. configure a static-only, single-threaded Emscripten build,
 *   5. build Hamlib's static library and every built-in rig backend,
 *   6. link the Embind facade, emit the generated TypeScript declarations,
 *   7. assemble the Hamlib licence/provenance data into the package.
 *
 * This script is deliberately dependency-free: npm packages are not needed to
 * reproduce the native artifact.  It must be run through `mise run
 * build:native` so that the pinned emsdk is on PATH.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

const NATIVE_DIR = path.join(PACKAGE_DIR, 'native');
const PATCH_FILE = path.join(NATIVE_DIR, 'patches', 'hamlib-4.7.2-web.patch');

const HAMLIB_VERSION = '4.7.2';
const ARCHIVE_NAME = `hamlib-${HAMLIB_VERSION}.tar.gz`;
const ARCHIVE_URL =
  `https://github.com/Hamlib/Hamlib/releases/download/${HAMLIB_VERSION}/${ARCHIVE_NAME}`;
const ARCHIVE_SHA256 =
  'ae1fcf2dbc80ea0786ea8f047b09399c3f7737d1930442f61a031708ed33e88f';

const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'hamlib', HAMLIB_VERSION);
const ARCHIVE_PATH = path.join(CACHE_DIR, ARCHIVE_NAME);
const SOURCE_DIR = path.join(CACHE_DIR, 'hamlib', `hamlib-${HAMLIB_VERSION}`);
const BUILD_DIR = path.join(CACHE_DIR, 'build');
const STAMP_PATH = path.join(CACHE_DIR, 'build-stamp.json');

const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
const DIST_NATIVE_DIR = path.join(DIST_DIR, 'native');
const MODULE_BASENAME = 'hamlib-web';
const MODULE_JS = `${MODULE_BASENAME}.mjs`;
const MODULE_WASM = `${MODULE_BASENAME}.wasm`;
const MODULE_TSD = `${MODULE_BASENAME}.d.mts`;

/* The generated declaration is consumed by tsc from src/, and shipped from
 * dist/ next to the Emscripten module it describes. */
const TSD_SOURCE_PATH = path.join(PACKAGE_DIR, 'src', 'native', MODULE_TSD);
const THIRD_PARTY_DIR = path.join(DIST_DIR, 'third_party', 'hamlib');

/* Files whose content invalidates a previously built libhamlib.a. */
const TRACKED_FILES = [
  path.join(NATIVE_DIR, 'compat', 'pthread.h'),
  path.join(NATIVE_DIR, 'web_serial.h'),
  path.join(NATIVE_DIR, 'web_serial.c'),
  path.join(NATIVE_DIR, 'web_serial.js'),
  path.join(NATIVE_DIR, 'facade.cpp'),
  PATCH_FILE,
  fileURLToPath(import.meta.url),
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
];

function log(message) {
  process.stdout.write(`[build-native] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[build-native] error: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
}

function requireTool(tool) {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' });
  } catch {
    fail(
      `${tool} is not available. Run this task through \`mise run build:native\` ` +
      'so the pinned emsdk is on PATH.',
    );
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fileDigest(file) {
  return createHash('sha256')
    .update(path.relative(PACKAGE_DIR, file))
    .update('\0')
    .update(readFileSync(file))
    .digest('hex');
}

function emccVersion() {
  const output = execFileSync('emcc', ['--version'], { encoding: 'utf8' });
  return output.split('\n')[0].trim();
}

function buildKey() {
  const hash = createHash('sha256');
  hash.update(`v1\0${ARCHIVE_SHA256}\0${emccVersion()}\0`);
  hash.update([...CONFIGURE_ARGS, ...LINK_ARGS].join('\0'));

  for (const file of TRACKED_FILES) {
    hash.update('\0');
    hash.update(fileDigest(file));
  }

  return hash.digest('hex');
}

function readStamp() {
  if (!existsSync(STAMP_PATH)) { return null; }

  try {
    return JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function ensureArchive() {
  if (existsSync(ARCHIVE_PATH) && sha256File(ARCHIVE_PATH) === ARCHIVE_SHA256) {
    log(`archive verified: ${path.relative(REPO_ROOT, ARCHIVE_PATH)}`);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  log(`downloading ${ARCHIVE_URL}`);

  const response = await fetch(ARCHIVE_URL, { redirect: 'follow' });

  if (!response.ok) {
    fail(`download failed with HTTP ${response.status}`);
  }

  writeFileSync(ARCHIVE_PATH, Buffer.from(await response.arrayBuffer()));

  const actual = sha256File(ARCHIVE_PATH);

  if (actual !== ARCHIVE_SHA256) {
    rmSync(ARCHIVE_PATH, { force: true });
    fail(`archive SHA-256 mismatch: expected ${ARCHIVE_SHA256}, got ${actual}`);
  }

  log('archive downloaded and verified');
}

function extractAndPatch() {
  log('extracting a fresh source tree');

  rmSync(path.join(CACHE_DIR, 'hamlib'), { recursive: true, force: true });
  mkdirSync(path.dirname(SOURCE_DIR), { recursive: true });

  run('tar', ['xzf', ARCHIVE_PATH, '-C', path.dirname(SOURCE_DIR)]);

  if (!existsSync(path.join(SOURCE_DIR, 'configure'))) {
    fail(`unexpected archive layout: ${SOURCE_DIR}/configure is missing`);
  }

  log('applying the Hamlib web patch');
  run('patch', ['-p1', '--batch', '--forward', '-i', PATCH_FILE], {
    cwd: SOURCE_DIR,
  });

  log('installing the browser serial transport as src/serial.c');
  copyFileSync(
    path.join(NATIVE_DIR, 'web_serial.c'),
    path.join(SOURCE_DIR, 'src', 'serial.c'),
  );

  const serial = readFileSync(path.join(SOURCE_DIR, 'src', 'serial.c'), 'utf8');

  if (!serial.includes('Web Serial')) {
    fail('src/serial.c was not replaced with the browser implementation');
  }
}

function configureAndBuild() {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });

  log('configuring (static, single-threaded, emscripten)');

  /* Autoconf probes headers with CPPFLAGS, so the compat include directory
   * (which satisfies AX_PTHREAD without thread flags) must live there.
   *
   * `-include sys/types.h` is a build-level fix for upstream headers that use
   * POSIX types such as mode_t without including <sys/types.h> themselves
   * (rigs/harris/harris.h:49); glibc happens to leak mode_t, musl does not. */
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
      // AX_PTHREAD must not add -pthread: native/compat/pthread.h supplies
      // single-threaded definitions so its probe links without thread flags.
      'PTHREAD_CFLAGS=',
      'PTHREAD_LIBS=',
    ],
    { cwd: BUILD_DIR },
  );

  log('building libhamlib.a and all built-in backends');

  const jobs = String(Math.max(1, cpus()));

  run('make', ['-j', jobs, '-C', 'src'], { cwd: BUILD_DIR });
}

function cpus() {
  try {
    return Number(
      execFileSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).trim(),
    );
  } catch {
    return 4;
  }
}

function libraryPath() {
  return path.join(BUILD_DIR, 'src', '.libs', 'libhamlib.a');
}

function linkModule() {
  if (!existsSync(libraryPath())) {
    fail(`static library missing: ${libraryPath()}`);
  }

  mkdirSync(DIST_NATIVE_DIR, { recursive: true });

  log('linking the Embind facade and generating TypeScript declarations');
  run(
    'em++',
    [
      path.join(NATIVE_DIR, 'facade.cpp'),
      `-I${path.join(BUILD_DIR, 'include')}`,
      `-I${path.join(SOURCE_DIR, 'include')}`,
      `-I${NATIVE_DIR}`,
      libraryPath(),
      '--js-library',
      path.join(NATIVE_DIR, 'web_serial.js'),
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

function writeThirdPartyData() {
  mkdirSync(THIRD_PARTY_DIR, { recursive: true });

  copyFileSync(
    path.join(SOURCE_DIR, 'COPYING.LIB'),
    path.join(THIRD_PARTY_DIR, 'COPYING.LIB'),
  );
  copyFileSync(PATCH_FILE, path.join(THIRD_PARTY_DIR, path.basename(PATCH_FILE)));

  const source = {
    package: 'Hamlib',
    version: HAMLIB_VERSION,
    license: 'LGPL-2.1-or-later',
    url: ARCHIVE_URL,
    sha256: ARCHIVE_SHA256,
    patch: path.basename(PATCH_FILE),
    note:
      'Built into WebAssembly with the browser serial transport in ' +
      'packages/hamlib-web/native. Rebuild with `mise run build:native`.',
  };

  writeFileSync(
    path.join(THIRD_PARTY_DIR, 'SOURCE.json'),
    `${JSON.stringify(source, null, 2)}\n`,
  );

  log('wrote third-party licence and provenance data');
}

async function main() {
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
    await ensureArchive();
    extractAndPatch();
    configureAndBuild();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      STAMP_PATH,
      `${JSON.stringify({ key, emcc: emccVersion(), version: HAMLIB_VERSION }, null, 2)}\n`,
    );
  }

  linkModule();
  writeThirdPartyData();
  log('native build complete');
}

await main();

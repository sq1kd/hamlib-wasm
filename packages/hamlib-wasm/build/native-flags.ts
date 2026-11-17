// SPDX-License-Identifier: MIT

/**
 * The configure, compile and link commands of the Wasm module.  The native
 * build runs them with repository paths; the relink kit ships them with
 * `@KIT_DIR@`-style placeholders that `rebuild.sh` expands, so the package and
 * a relinked module are built by the same commands.
 */
import path from 'node:path';

import { assert } from './errors.ts';
import { capture } from './exec.ts';
import { MODULE_JS, MODULE_TSD } from './paths.ts';

/** The first line of `emcc --version`: the release and its revision. */
export function emccVersion(): string {
  const banner = capture('emcc', 'emcc', ['--version']).split('\n')[0]?.trim();

  assert(banner, 'emcc --version printed nothing');
  return banner;
}

export const CONFIGURE_ARGS: readonly string[] = [
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

const LINK_ARGS: readonly string[] = [
  '-O3',
  '-lembind',
  '-sASYNCIFY',
  '-sMODULARIZE',
  '-sEXPORT_ES6',
  '-sENVIRONMENT=web,node',
  '-sALLOW_MEMORY_GROWTH',
  '-sNO_EXIT_RUNTIME',
  '-sSTACK_SIZE=1048576',
  '-sEXPORT_NAME=createHamlibWasmModule',
  '-sEXPORTED_RUNTIME_METHODS=HamlibWs',
  '-Wl,--wrap=read',
  '-Wl,--wrap=write',
  '-Wl,--wrap=select',
  '-Wl,--wrap=nanosleep',
  '-Wl,--wrap=monotonic_seconds',
];

/** Where the commands find their inputs and put their outputs. */
export interface NativeLayout {
  /** The project bridge: facade, wrappers, compatibility headers. */
  readonly nativeDir: string;
  /** The patched Hamlib tree. */
  readonly sourceDir: string;
  /** The configure and make tree. */
  readonly buildDir: string;
  /** The compiled Emscripten JS library. */
  readonly jsLibrary: string;
  /** The linked loader, Wasm and declarations. */
  readonly outDir: string;
  readonly linkMap: string;
}

/** A program followed by its arguments. */
export type Command = readonly [string, ...string[]];

export function configureCommand(layout: NativeLayout): Command {
  return [
    'emconfigure',
    path.join(layout.sourceDir, 'configure'),
    '--host=wasm32-unknown-emscripten',
    ...CONFIGURE_ARGS,
    'CFLAGS=-O2',
    'CXXFLAGS=-O2',
    'PTHREAD_CFLAGS=',
    'PTHREAD_LIBS=',
    `CPPFLAGS=-I${layout.nativeDir} -I${path.join(layout.nativeDir, 'compat')} -include sys/types.h`,
  ];
}

export function libraryPath(layout: NativeLayout): string {
  return path.join(layout.buildDir, 'src', '.libs', 'libhamlib.a');
}

function monotonicObject(layout: NativeLayout): string {
  return path.join(layout.buildDir, 'monotonic_time.o');
}

/* Compiled on its own: handed to em++ with the facade, a .c file is compiled
 * as C++, which clang has deprecated. */
export function compileCommand(layout: NativeLayout): Command {
  return [
    'emcc',
    '-c',
    '-O3',
    path.join(layout.nativeDir, 'monotonic_time.c'),
    '-o',
    monotonicObject(layout),
  ];
}

export function linkCommand(layout: NativeLayout): Command {
  return [
    'em++',
    path.join(layout.nativeDir, 'facade.cpp'),
    path.join(layout.nativeDir, 'wrapped_io.cpp'),
    monotonicObject(layout),
    `-I${path.join(layout.buildDir, 'include')}`,
    `-I${path.join(layout.sourceDir, 'include')}`,
    `-I${layout.nativeDir}`,
    libraryPath(layout),
    '--js-library',
    layout.jsLibrary,
    ...LINK_ARGS,
    `-Wl,-Map=${layout.linkMap}`,
    '-o',
    path.join(layout.outDir, MODULE_JS),
    '--emit-tsd',
    path.join(layout.outDir, MODULE_TSD),
  ];
}

/** The kit's layout, in the placeholders `rebuild.sh` expands. */
const KIT_LAYOUT: NativeLayout = {
  nativeDir: '@KIT_DIR@/native',
  sourceDir: '@SOURCE_DIR@',
  buildDir: '@BUILD_DIR@',
  jsLibrary: '@KIT_DIR@/library/web_serial.js',
  outDir: '@OUT_DIR@',
  linkMap: '@OUT_DIR@/hamlib-wasm.map',
};

/** The kit's command files: one argument per line, the program first. */
export function kitCommandFiles(): Readonly<Record<string, string>> {
  const render = (command: Command): string => `${command.join('\n')}\n`;

  return {
    'configure.args': render(configureCommand(KIT_LAYOUT)),
    'compile.args': render(compileCommand(KIT_LAYOUT)),
    'link.args': render(linkCommand(KIT_LAYOUT)),
  };
}

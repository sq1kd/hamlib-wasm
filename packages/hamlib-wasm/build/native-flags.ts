// SPDX-License-Identifier: MIT

import path from 'node:path';

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

export const CONFIGURE_VALUES: readonly string[] = [
  'CFLAGS=-O2',
  'CXXFLAGS=-O2',
  'PTHREAD_CFLAGS=',
  'PTHREAD_LIBS=',
];

/** The link flags shared by the native build and the standalone kit. */
export const LINK_ARGS: readonly string[] = [
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

export function configureCppflags(nativeDir: string): string {
  return [
    `-I${nativeDir}`,
    `-I${path.join(nativeDir, 'compat')}`,
    '-include sys/types.h',
  ].join(' ');
}

export function linkArgs(linkMap: string): string[] {
  return [...LINK_ARGS, `-Wl,-Map=${linkMap}`];
}

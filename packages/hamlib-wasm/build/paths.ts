// SPDX-License-Identifier: MIT

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Upstream } from './upstream.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BUILD_SCRIPTS_DIR = HERE;
export const PACKAGE_DIR = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');
export const NATIVE_DIR = path.join(PACKAGE_DIR, 'native');
export const CONFIG_PATH = path.join(PACKAGE_DIR, 'hamlib.config.yaml');
export const PACKAGE_JSON = path.join(PACKAGE_DIR, 'package.json');
export const MISE_TOML = path.join(REPO_ROOT, 'mise.toml');
export const BASELINE_JSON = path.join(PACKAGE_DIR, 'baseline', 'baseline.json');
export const HOST_TRACE_SOURCE = path.join(REPO_ROOT, 'tests', 'native', 'host-trace.c');
export const CONSUMER_DIR = path.join(REPO_ROOT, 'tests', 'consumer');
export const CONSUMER_PACKED_DIR = path.join(CONSUMER_DIR, 'packed');

export const DIST_DIR = path.join(PACKAGE_DIR, 'dist');
export const DIST_NATIVE_DIR = path.join(DIST_DIR, 'native');
export const THIRD_PARTY_DIR = path.join(DIST_DIR, 'third_party', 'hamlib');
export const SOURCE_JSON = path.join(THIRD_PARTY_DIR, 'SOURCE.json');
export const LINK_INPUTS_JSON = path.join(THIRD_PARTY_DIR, 'LINK_INPUTS.json');
export const CORRESPONDING_SOURCE = path.join(
  THIRD_PARTY_DIR,
  'corresponding-source.tar.gz',
);
export const PACKAGE_LICENSING_MANIFEST = path.join(
  THIRD_PARTY_DIR,
  'PACKAGE-LICENSING.json',
);

export const MODULE_BASENAME = 'hamlib-wasm';
export const MODULE_JS = `${MODULE_BASENAME}.mjs`;
export const MODULE_WASM = `${MODULE_BASENAME}.wasm`;
export const MODULE_TSD = `${MODULE_BASENAME}.d.mts`;
export const DIST_MODULE_JS = path.join(DIST_NATIVE_DIR, MODULE_JS);
export const DIST_MODULE_WASM = path.join(DIST_NATIVE_DIR, MODULE_WASM);
export const DIST_MODULE_TSD = path.join(DIST_NATIVE_DIR, MODULE_TSD);
export const TSD_SOURCE_PATH = path.join(PACKAGE_DIR, 'src', 'native', MODULE_TSD);
export const LIBRARY_JS = path.join(DIST_NATIVE_DIR, 'library', 'web_serial.js');

export const GENERATED_INC = path.join(NATIVE_DIR, 'generated');
export const GENERATED_TS = path.join(PACKAGE_DIR, 'src', 'native', 'generated');
export const CODEGEN_DIR = path.join(REPO_ROOT, 'packages', 'hamlib-codegen', 'src');
export const CODEGEN_CLI = path.join(CODEGEN_DIR, 'cli.ts');

/** The package build's outputs, archived for the CI jobs that publish them. */
export const BUILD_OUTPUTS_ARCHIVE = path.join(REPO_ROOT, '.cache', 'build-outputs.tar.gz');

export const PACKAGE_LICENSES_DIR = path.join(PACKAGE_DIR, 'LICENSES');
export const PACKAGE_REBUILDING = path.join(PACKAGE_DIR, 'REBUILDING.md');
export const REBUILDING_TEMPLATE = path.join(BUILD_SCRIPTS_DIR, 'REBUILDING.md.in');
export const REBUILD_SCRIPT = path.join(BUILD_SCRIPTS_DIR, 'rebuild.sh');
export const FINISH_MODULE_SCRIPT = path.join(BUILD_SCRIPTS_DIR, 'finish-module.mts');

export const BRIDGE_INPUTS: readonly string[] = [
  'native/facade.cpp',
  'native/wrapped_io.cpp',
  'native/monotonic_time.c',
  'native/web_serial.c',
  'native/web_serial.h',
  'native/web_serial.ts',
  'native/compat/pthread.h',
  'native/generated/capabilities.inc',
  'native/generated/codecs.h',
  'native/generated/embind.inc',
  'native/generated/operations.inc',
  'native/generated/results.inc',
  'native/emscripten-globals.d.ts',
  'native/tsconfig.library.json',
  'dist/native/library/web_serial.js',
];

export function releaseCacheDir(upstream: Upstream): string {
  return path.join(REPO_ROOT, '.cache', 'hamlib', upstream.version);
}

export function releaseSourceDirName(upstream: Upstream): string {
  return `hamlib-${upstream.version}`;
}

export function releaseSourceDir(upstream: Upstream): string {
  return path.join(
    releaseCacheDir(upstream),
    'hamlib',
    releaseSourceDirName(upstream),
  );
}

export function releaseIncludeDir(upstream: Upstream): string {
  return path.join(releaseSourceDir(upstream), 'include');
}

export function releaseArchivePath(upstream: Upstream): string {
  return path.join(releaseCacheDir(upstream), upstream.archive.name);
}

export function releaseBuildDir(upstream: Upstream): string {
  return path.join(releaseCacheDir(upstream), 'build');
}

export function releaseStampPath(
  upstream: Upstream,
  kind: 'fetch' | 'build' | 'host',
): string {
  return path.join(releaseCacheDir(upstream), `${kind}-stamp.json`);
}

export function releaseLinkMap(upstream: Upstream): string {
  return path.join(releaseCacheDir(upstream), 'link.map');
}

export function releaseKitStaging(upstream: Upstream): string {
  return path.join(releaseCacheDir(upstream), 'corresponding-source');
}


/** The host (non-Wasm) build `compare-native` traces against. */
export function releaseHostDir(upstream: Upstream): string {
  return path.join(releaseCacheDir(upstream), 'host');
}

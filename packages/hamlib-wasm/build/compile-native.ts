// SPDX-License-Identifier: MIT

/**
 * Compile the pinned Hamlib release for the browser.
 *
 * Expects the tree `fetch-native` extracted (which is also what the binding
 * generator reads), then:
 *   1. configures a static-only, single-threaded Emscripten build,
 *   2. builds Hamlib's static library and every built-in rig backend,
 *   3. links the Embind facade plus the link-time POSIX wrappers, emits the
 *      TypeScript declarations and checks them against the config,
 *   4. assembles the Hamlib licence/provenance data into the package.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { runCodegen } from './codegen.ts';
import { assert, runMain } from './errors.ts';
import { capture, jobs, log, requireTool, run } from './exec.ts';
import { directoryFiles, fileDigest, readJson, writeJson } from './files.ts';
import { finishModule } from './finish-module.mts';
import { writeThirdPartyData } from './licensing.ts';
import {
  type Command,
  type NativeLayout,
  compileCommand,
  configureCommand,
  kitCommandFiles,
  libraryPath,
  linkCommand,
} from './native-flags.ts';
import {
  BRIDGE_INPUTS,
  BUILD_SCRIPTS_DIR,
  CODEGEN_DIR,
  CONFIG_PATH,
  DIST_MODULE_JS,
  DIST_MODULE_TSD,
  DIST_MODULE_WASM,
  DIST_NATIVE_DIR,
  GENERATED_TS,
  LIBRARY_JS,
  NATIVE_DIR,
  PACKAGE_DIR,
  REPO_ROOT,
  TSD_SOURCE_PATH,
  releaseBuildDir,
  releaseLinkMap,
  releaseSourceDir,
  releaseStampPath,
} from './paths.ts';
import { type Upstream, loadUpstream, manifestDigest } from './upstream.ts';

const SCOPE = 'build-native';

/* Files whose content invalidates a previously built libhamlib.a: the bridge
 * (minus the JS library this build compiles), the config, the scripts that
 * shape the build and the generator.  The release digest covers the pinned
 * release and every applied patch. */
function trackedFiles(): string[] {
  return [
    ...BRIDGE_INPUTS
      .filter((relative) => !relative.startsWith('dist/'))
      .map((relative) => path.join(PACKAGE_DIR, relative)),
    CONFIG_PATH,
    ...['compile-native.ts', 'native-flags.ts', 'upstream.ts', 'codegen.ts', 'paths.ts']
      .map((file) => path.join(BUILD_SCRIPTS_DIR, file)),
    ...directoryFiles(GENERATED_TS),
    ...directoryFiles(path.join(GENERATED_TS, 'methods')),
    ...directoryFiles(CODEGEN_DIR),
  ];
}

interface BuildStamp {
  readonly key: string;
  readonly emcc: string;
  readonly version: string;
}

function emccVersion(): string {
  return capture(SCOPE, 'emcc', ['--version']).split('\n')[0]?.trim() ?? '';
}

function buildKey(upstream: Upstream): string {
  const hash = createHash('sha256');
  hash.update(`v5\0${manifestDigest(upstream)}\0${emccVersion()}\0`);
  hash.update(Object.values(kitCommandFiles()).join('\0'));

  for (const file of trackedFiles()) {
    hash.update('\0');
    hash.update(fileDigest(file, PACKAGE_DIR));
  }

  return hash.digest('hex');
}

function readStamp(stampPath: string): BuildStamp | null {
  if (!existsSync(stampPath)) {
    return null;
  }

  try {
    return readJson<BuildStamp>(stampPath);
  } catch {
    return null;
  }
}

function runCommand(command: Command, cwd?: string): void {
  const [program, ...args] = command;
  run(SCOPE, program, args, { cwd });
}

function configureAndBuild(layout: NativeLayout): void {
  /* The compile step works on the tree `fetch-native` extracted, so the
   * headers the generator reads and the sources compiled here are the same
   * bytes. */
  assert(
    existsSync(path.join(layout.sourceDir, 'configure'))
    && existsSync(path.join(layout.sourceDir, 'COPYING.LIB')),
    `the upstream tree is missing at ${path.relative(REPO_ROOT, layout.sourceDir)}; `
    + 'run `mise run fetch-native` first.',
  );

  rmSync(layout.buildDir, { recursive: true, force: true });
  mkdirSync(layout.buildDir, { recursive: true });

  log(SCOPE, 'configuring (static, single-threaded, emscripten)');
  runCommand(configureCommand(layout), layout.buildDir);

  log(SCOPE, 'building libhamlib.a and all built-in backends');
  run(SCOPE, 'make', ['-j', jobs(), '-C', 'src'], { cwd: layout.buildDir });
}

function compileJsLibrary(): void {
  mkdirSync(path.dirname(LIBRARY_JS), { recursive: true });

  log(SCOPE, 'compiling the serial transport library');
  run(SCOPE, 'tsc', ['-p', path.join(NATIVE_DIR, 'tsconfig.library.json')], {
    cwd: NATIVE_DIR,
  });

  assert(existsSync(LIBRARY_JS), 'the serial transport library was not produced');
}

function linkModule(layout: NativeLayout): void {
  assert(existsSync(libraryPath(layout)), `static library missing: ${libraryPath(layout)}`);

  mkdirSync(layout.outDir, { recursive: true });
  compileJsLibrary();

  log(SCOPE, 'linking the Embind facade and generating TypeScript declarations');
  runCommand(compileCommand(layout));
  runCommand(linkCommand(layout));

  for (const file of [DIST_MODULE_JS, DIST_MODULE_WASM, DIST_MODULE_TSD]) {
    assert(existsSync(file), `expected build output ${path.basename(file)} was not produced`);
  }

  finishModule(DIST_MODULE_JS, DIST_MODULE_TSD);
  mkdirSync(path.dirname(TSD_SOURCE_PATH), { recursive: true });
  copyFileSync(DIST_MODULE_TSD, TSD_SOURCE_PATH);
}

function main(): void {
  for (const tool of ['emcc', 'emconfigure', 'em++']) {
    requireTool(tool, 'Run this through `mise run build-native` so emsdk is on PATH.');
  }

  const upstream = loadUpstream();
  const stampPath = releaseStampPath(upstream, 'build');
  const layout: NativeLayout = {
    nativeDir: NATIVE_DIR,
    sourceDir: releaseSourceDir(upstream),
    buildDir: releaseBuildDir(upstream),
    jsLibrary: LIBRARY_JS,
    outDir: DIST_NATIVE_DIR,
    linkMap: releaseLinkMap(upstream),
  };

  const key = buildKey(upstream);
  const reusable =
    readStamp(stampPath)?.key === key
    && existsSync(libraryPath(layout))
    && existsSync(path.join(layout.sourceDir, 'COPYING.LIB'));

  if (reusable) {
    log(SCOPE, 'native library is up to date, reusing it');
  } else {
    configureAndBuild(layout);
    writeJson(stampPath, { key, emcc: emccVersion(), version: upstream.version });
  }

  linkModule(layout);

  log(SCOPE, 'verifying the linked module against the config');
  runCodegen(['--emitted', DIST_MODULE_TSD]);

  writeThirdPartyData(layout.linkMap);
  log(SCOPE, 'native build complete');
}

await runMain(SCOPE, main);

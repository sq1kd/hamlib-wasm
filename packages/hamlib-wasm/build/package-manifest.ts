// SPDX-License-Identifier: MIT

/**
 * The single definition of what ships in the published package.
 *
 * npm's `files` field in `package.json` is the authority for the package
 * contents; this module reads it at build time and records each entry's kind
 * so callers can apply npm's directory semantics (a directory ships
 * recursively, a file ships once).  It adds the generated artifacts the build
 * must emit and the per-release files (patches, provenance, license texts)
 * that live inside those directories.
 *
 * Every build, packaging and verification script consumes this module.
 * Adding a shipped file is an edit to `package.json` `files` or to one of the
 * generated-artifact definitions here, never a second list in a consumer.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { readJson } from './files.ts';
import { kitCommandFiles } from './native-flags.ts';
import {
  BRIDGE_INPUTS,
  DIST_MODULE_JS,
  DIST_MODULE_TSD,
  DIST_DIR,
  DIST_MODULE_WASM,
  FINISH_MODULE_SCRIPT,
  LIBRARY_JS,
  PACKAGE_DIR,
  PACKAGE_JSON,
  PACKAGE_REBUILDING,
  TSD_SOURCE_PATH,
} from './paths.ts';
import type { Upstream } from './upstream.ts';

export interface PackageManifestEntry {
  /** Path relative to the package root, with forward slashes. */
  readonly relative: string;
  /** `directory` entries ship recursively under npm's `files` semantics. */
  readonly kind: 'file' | 'directory';
}

type ExportTarget = string | { readonly [condition: string]: ExportTarget };

interface PackageJson {
  readonly files?: readonly string[];
  readonly exports?: { readonly [subpath: string]: ExportTarget };
}

const PACKAGE_MANIFEST = readJson<PackageJson>(PACKAGE_JSON);

/** Path of a package file, relative to the package root, as npm sees it. */
function packageRelative(file: string): string {
  return path.relative(PACKAGE_DIR, file).split(path.sep).join('/');
}

/**
 * `package.json` `files` entries.  The entry is a directory when it exists and
 * is one; an entry that does not exist yet (a clean tree before the build) is
 * classified by its extension so `dist` is still a directory.
 */
function readPackageFiles(): readonly PackageManifestEntry[] {
  return (PACKAGE_MANIFEST.files ?? []).map((relative) => {
    const absolute = path.join(PACKAGE_DIR, relative);
    const kind: PackageManifestEntry['kind'] = existsSync(absolute)
      ? (statSync(absolute).isDirectory() ? 'directory' : 'file')
      : (path.extname(relative) ? 'file' : 'directory');

    return { relative, kind };
  });
}

/** The authority for npm package contents, read from `package.json`. */
export const PACKAGE_JSON_FILES: readonly PackageManifestEntry[] = readPackageFiles();

/** Every concrete file an `exports` target names; wildcard targets are skipped. */
function exportTargets(target: ExportTarget): readonly string[] {
  if (typeof target === 'string') {
    return target.includes('*') ? [] : [path.posix.normalize(target)];
  }

  return Object.values(target).flatMap(exportTargets);
}

/**
 * Files the package build must emit: every file `package.json` `exports`
 * names, plus the Emscripten outputs no export names.  `package.ts` asserts
 * these after tsc and the native build; `verify-package.ts` asserts they
 * reached the tarball.  Relative to the package root.
 */
export const GENERATED_OUTPUTS: readonly string[] = [
  ...new Set([
    ...Object.values(PACKAGE_MANIFEST.exports ?? {}).flatMap(exportTargets),
    packageRelative(DIST_MODULE_JS),
    packageRelative(DIST_MODULE_WASM),
    packageRelative(DIST_MODULE_TSD),
    packageRelative(LIBRARY_JS),
  ]),
];

/** Absolute paths of `GENERATED_OUTPUTS`, for the build's existence checks. */
export function generatedPackageOutputs(): readonly string[] {
  return GENERATED_OUTPUTS.map((relative) => path.join(PACKAGE_DIR, relative));
}

/**
 * License texts copied from the repository root into the package.  The
 * directory is listed in `files`; these are the individual files whose bytes
 * the package verification compares and hashes.
 */
export const LICENSE_FILES: readonly string[] = [
  'LICENSES/MIT.txt',
  'LICENSES/LGPL-2.1-or-later.txt',
  'LICENSES/GPL-2.0-or-later.txt',
  'LICENSES/GPL-3.0-or-later.txt',
  'LICENSES/Emscripten.txt',
  'LICENSES/LLVM.txt',
];

/**
 * Every licensing file the package build copies verbatim from the repository
 * root.  The same relative path names the root original, the package copy and
 * the copy inside the source kit.  `REBUILDING.md` is not here: it is rendered
 * per release from `build/REBUILDING.md.in`.
 */
export const ROOT_LICENSING_FILES: readonly string[] = [
  'LICENSE.md',
  'THIRD_PARTY_NOTICES.md',
  ...LICENSE_FILES,
];

/**
 * Every untracked file the native and package builds write into the package:
 * what packing, publishing or building the site needs without a rebuild.
 */
export function packageBuildOutputs(): readonly string[] {
  return [
    DIST_DIR,
    TSD_SOURCE_PATH,
    PACKAGE_REBUILDING,
    ...ROOT_LICENSING_FILES.map((relative) => path.join(PACKAGE_DIR, relative)),
  ];
}

/** Upstream license texts copied from the release tree into the package. */
export const UPSTREAM_LICENSE_FILES: readonly string[] = [
  'LICENSE',
  'COPYING',
  'COPYING.LIB',
];

/** Every upstream file copied from the release tree into the package. */
export const UPSTREAM_BASE_FILES: readonly string[] = [
  ...UPSTREAM_LICENSE_FILES,
  'AUTHORS',
];

/** Upstream and provenance files that ship under `dist/third_party/hamlib`. */
export function thirdPartyFiles(upstream: Upstream): readonly string[] {
  return [
    ...UPSTREAM_BASE_FILES.map((file) => `dist/third_party/hamlib/${file}`),
    ...upstream.patches.map((patch) => `dist/third_party/hamlib/${patch.file}`),
    'dist/third_party/hamlib/SOURCE.json',
    'dist/third_party/hamlib/LINK_INPUTS.json',
    'dist/third_party/hamlib/PACKAGE-LICENSING.json',
    'dist/third_party/hamlib/corresponding-source.tar.gz',
  ];
}

/**
 * Everything the tarball must contain: the npm `files` entries, the generated
 * outputs, every explicitly named license text and the third-party files.
 * Directories stay directory entries so verification can apply npm's
 * recursive `files` semantics instead of pretending a directory is a file.
 */
export function requiredPackageFiles(
  upstream: Upstream,
): readonly PackageManifestEntry[] {
  const entries = new Map<string, PackageManifestEntry>();

  /* npm always ships the manifest itself, whether or not `files` names it. */
  const manifestPath = packageRelative(PACKAGE_JSON);
  entries.set(manifestPath, { relative: manifestPath, kind: 'file' });

  for (const entry of PACKAGE_JSON_FILES) {
    entries.set(entry.relative, entry);
  }

  for (const relative of [
    ...GENERATED_OUTPUTS,
    ...LICENSE_FILES,
    ...thirdPartyFiles(upstream),
  ]) {
    if (!entries.has(relative)) {
      entries.set(relative, { relative, kind: 'file' });
    }
  }

  return [...entries.values()];
}

/**
 * Packaged text files that must not contain release placeholders: the shipped
 * Markdown documents, the provenance JSON and the license texts.
 */
export function scannedPackageFiles(upstream: Upstream): readonly string[] {
  return [
    ...PACKAGE_JSON_FILES
      .filter((entry) => entry.kind === 'file' && entry.relative.endsWith('.md'))
      .map((entry) => entry.relative),
    ...thirdPartyFiles(upstream).filter((relative) => relative.endsWith('.json')),
    ...LICENSE_FILES,
  ];
}

/**
 * Files the standalone relink kit must contain.  The kit keeps the archive,
 * the patches and the whole native bridge, so derive the bridge entries from
 * `BRIDGE_INPUTS` instead of restating them.
 */
export function kitFiles(upstream: Upstream): readonly string[] {
  return [
    'KIT-README.md',
    'REBUILDING.md',
    'rebuild.sh',
    'SOURCE.json',
    path.basename(FINISH_MODULE_SCRIPT),
    'release.env',
    'patches.sha256',
    ...Object.keys(kitCommandFiles()),
    `source/${upstream.archive.name}`,
    ...upstream.patches.map((patch) => `patches/${patch.file}`),
    ...BRIDGE_INPUTS.map((relative) => (
      relative.startsWith('dist/native/')
        ? relative.slice('dist/native/'.length)
        : relative
    )),
    ...ROOT_LICENSING_FILES,
    ...UPSTREAM_BASE_FILES,
  ];
}

export interface PackageLicensingEntry {
  readonly from: string;
  readonly to: string;
  readonly recursive?: boolean;
}

/**
 * The copy manifest shipped as `PACKAGE-LICENSING.json`: the licensing and
 * relink material at the package root, plus every third-party file that moves
 * from `dist/` to the package root's `third_party/` directory.
 *
 * The root files are a subset of the shipped `files` entries, not a second
 * definition of them: the selection is the licensing/relink documents and the
 * license-text directory.
 */
export function packageLicensingEntries(
  upstream: Upstream,
): readonly PackageLicensingEntry[] {
  const rootEntries: Record<string, true> = {
    'LICENSE.md': true,
    LICENSES: true,
    'THIRD_PARTY_NOTICES.md': true,
    'REBUILDING.md': true,
  };
  const entries: PackageLicensingEntry[] = [];

  for (const entry of PACKAGE_JSON_FILES) {
    if (!rootEntries[entry.relative]) { continue; }

    entries.push(entry.kind === 'directory'
      ? { from: entry.relative, to: entry.relative, recursive: true }
      : { from: entry.relative, to: entry.relative });
  }

  for (const relative of thirdPartyFiles(upstream)) {
    entries.push({ from: relative, to: relative.slice('dist/'.length) });
  }

  return entries;
}

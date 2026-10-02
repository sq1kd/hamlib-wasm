/**
 * The one place that knows which upstream Hamlib release is pinned.
 *
 * `hamlib.config.yaml` holds the version, the archive to download and verify,
 * and the patches that adapt it; the build scripts, the provenance data, the
 * cache paths and the tests all derive from it.  Refreshing upstream is a
 * manifest edit plus regenerated artifacts.
 *
 * Authored as TypeScript and run directly by Node's type stripping, so this
 * file must stay erasable (no enums, namespaces or parameter properties).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const PACKAGE_DIR: string = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const REPO_ROOT: string = path.resolve(PACKAGE_DIR, '..', '..');

export const NATIVE_DIR: string = path.join(PACKAGE_DIR, 'native');

export const CONFIG_PATH: string = path.join(PACKAGE_DIR, 'hamlib.config.yaml');

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface UpstreamArchive {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
}

export interface UpstreamPatch {
  readonly file: string;
  readonly purpose: string;
  /** Absolute path to the patch inside the package. */
  readonly path: string;
}

export interface Upstream {
  readonly version: string;
  readonly series: string;
  readonly archive: UpstreamArchive;
  readonly license: string;
  readonly patches: readonly UpstreamPatch[];
}

function fail(message: string): never {
  process.stderr.write(`[upstream] error: ${message}\n`);
  process.exit(1);
}

function assertString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} must be a non-empty string`);
  }

  return value;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be a mapping`);
  }

  return value as Record<string, unknown>;
}

/** Read and validate the `release:` section of the config. */
export function loadUpstream(): Upstream {
  if (!existsSync(CONFIG_PATH)) {
    fail(`the config is missing: ${path.relative(REPO_ROOT, CONFIG_PATH)}`);
  }

  let parsed: unknown;

  try {
    parsed = parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    fail(`the config is not valid YAML: ${String(error)}`);
  }

  const release = assertObject(assertObject(parsed, 'config').release, 'release');
  const version = assertString(release.version, 'release.version');

  if (!VERSION_PATTERN.test(version)) {
    fail(`release.version "${version}" is not a Hamlib release number`);
  }

  const series = assertString(release.series, 'release.series');

  if (!version.startsWith(`${series}.`)) {
    fail(`release.version "${version}" does not belong to series "${series}"`);
  }

  const archive = assertObject(release.archive, 'release.archive');
  const name = assertString(archive.name, 'release.archive.name');
  const url = assertString(archive.url, 'release.archive.url');
  const sha256 = assertString(archive.sha256, 'release.archive.sha256');

  if (!url.endsWith(`/${name}`)) {
    fail(`release.archive.url must end with "/${name}"`);
  }

  if (!SHA256_PATTERN.test(sha256)) {
    fail('release.archive.sha256 must be 64 lowercase hexadecimal characters');
  }

  if (!Array.isArray(release.patches)) {
    fail('release.patches must be a list');
  }

  const patches: UpstreamPatch[] = release.patches.map((entry) => {
    const patch = assertObject(entry, 'release.patches entry');
    const file = assertString(patch.file, 'patch file');
    const purpose = assertString(patch.purpose, 'patch purpose');
    const absolute = path.join(NATIVE_DIR, 'patches', file);

    if (!existsSync(absolute)) {
      fail(`the config names a patch that does not exist: ${file}`);
    }

    return { file, purpose, path: absolute };
  });

  const license = assertString(release.license, 'release.license');

  return { version, series, archive: { name, url, sha256 }, license, patches };
}

/** Digest of the release inputs, so a build stamp notices a release change. */
export function manifestDigest(manifest: Upstream): string {
  const hash = createHash('sha256');
  hash.update(manifest.version);
  hash.update('\0');
  hash.update(manifest.archive.url);
  hash.update('\0');
  hash.update(manifest.archive.sha256);

  for (const patch of manifest.patches) {
    hash.update('\0');
    hash.update(patch.file);
    hash.update('\0');
    hash.update(readFileSync(patch.path));
  }

  return hash.digest('hex');
}

/** Absolute path to the extracted upstream source tree for the pinned release. */
export function upstreamSourceDir(manifest: Upstream): string {
  return path.join(
    REPO_ROOT,
    '.cache',
    'hamlib',
    manifest.version,
    'hamlib',
    `hamlib-${manifest.version}`,
  );
}

/** Absolute path to the extracted upstream public headers. */
export function upstreamIncludeDir(manifest: Upstream): string {
  return path.join(upstreamSourceDir(manifest), 'include');
}

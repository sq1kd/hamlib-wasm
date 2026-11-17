// SPDX-License-Identifier: MIT

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
import { parse } from 'yaml';

import { errorMessage } from './errors.ts';
import { CONFIG_PATH, NATIVE_DIR, REPO_ROOT } from './paths.ts';

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

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
  readonly repository: string;
  readonly commit: string;
  readonly tagObject: string;
  readonly archive: UpstreamArchive;
  readonly license: string;
  readonly patches: readonly UpstreamPatch[];
}

function invalid(message: string): never {
  throw new Error(message);
}

function assertString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(`${what} must be a non-empty string`);
  }

  return value;
}

function assertObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${what} must be a mapping`);
  }

  return value as Record<string, unknown>;
}

/**
 * Parse and validate the `release:` section from config text.
 *
 * Throws on any invalid value instead of exiting, so callers that are about to
 * write a config (release-bump) can validate the exact bytes they will commit.
 */
export function parseUpstreamConfig(text: string): Upstream {
  let parsed: unknown = null;

  try {
    parsed = parse(text);
  } catch (error) {
    invalid(`the config is not valid YAML: ${String(error)}`);
  }

  const release = assertObject(assertObject(parsed, 'config').release, 'release');
  const version = assertString(release.version, 'release.version');

  if (!VERSION_PATTERN.test(version)) {
    invalid(`release.version "${version}" is not a Hamlib release number`);
  }

  const series = assertString(release.series, 'release.series');

  if (!version.startsWith(`${series}.`)) {
    invalid(`release.version "${version}" does not belong to series "${series}"`);
  }

  const repository = assertString(release.repository, 'release.repository');
  const commit = assertString(release.commit, 'release.commit');
  const tagObject = assertString(release.tagObject, 'release.tagObject');

  if (!COMMIT_PATTERN.test(commit)) {
    invalid('release.commit must be a 40-character lowercase commit SHA');
  }

  if (!COMMIT_PATTERN.test(tagObject)) {
    invalid('release.tagObject must be a 40-character lowercase object SHA');
  }

  const archive = assertObject(release.archive, 'release.archive');
  const name = assertString(archive.name, 'release.archive.name');
  const url = assertString(archive.url, 'release.archive.url');
  const sha256 = assertString(archive.sha256, 'release.archive.sha256');

  if (!url.endsWith(`/${name}`)) {
    invalid(`release.archive.url must end with "/${name}"`);
  }

  if (!SHA256_PATTERN.test(sha256)) {
    invalid('release.archive.sha256 must be 64 lowercase hexadecimal characters');
  }

  if (!Array.isArray(release.patches)) {
    invalid('release.patches must be a list');
  }

  const patches: UpstreamPatch[] = release.patches.map((entry) => {
    const patch = assertObject(entry, 'release.patches entry');
    const file = assertString(patch.file, 'patch file');
    const purpose = assertString(patch.purpose, 'patch purpose');
    const absolute = path.join(NATIVE_DIR, 'patches', file);

    if (!existsSync(absolute)) {
      invalid(`the config names a patch that does not exist: ${file}`);
    }

    return { file, purpose, path: absolute };
  });

  const license = assertString(release.license, 'release.license');

  return {
    version,
    series,
    repository,
    commit,
    tagObject,
    archive: { name, url, sha256 },
    license,
    patches,
  };
}

/** Read and validate the `release:` section of the config. */
export function loadUpstream(): Upstream {
  const config = path.relative(REPO_ROOT, CONFIG_PATH);

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`the config is missing: ${config}`);
  }

  try {
    return parseUpstreamConfig(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    throw new Error(`${config}: ${errorMessage(error)}`);
  }
}

/** Digest of the release inputs, so a build stamp notices a release change. */
export function manifestDigest(manifest: Upstream): string {
  const hash = createHash('sha256');
  hash.update(manifest.version);
  hash.update('\0');
  hash.update(manifest.commit);
  hash.update('\0');
  hash.update(manifest.tagObject);
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

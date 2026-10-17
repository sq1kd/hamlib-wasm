/**
 * The pinned upstream release, as the tests see it.
 *
 * `packages/hamlib-wasm/hamlib.config.yaml` is the single source of truth for
 * the upstream version, archive and patches, so no spec hardcodes a release
 * number: refreshing Hamlib is a config edit and the tests follow it.  The
 * built package ships the same data as provenance, and the helpers here check
 * that the two agree before any browser assertion runs.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export interface UpstreamPatch {
  file: string;
  purpose: string;
}

export interface UpstreamManifest {
  version: string;
  series: string;
  archive: { name: string; url: string; sha256: string };
  license: string;
  patches: UpstreamPatch[];
}

interface UpstreamProvenance {
  version: string;
  series: string;
  license: string;
  url: string;
  sha256: string;
  patches: { file: string; purpose: string }[];
}

const packageUrl = (relative: string): URL =>
  new URL(`../../packages/hamlib-wasm/${relative}`, import.meta.url);

export const UPSTREAM_MANIFEST: UpstreamManifest = (
  parse(readFileSync(fileURLToPath(packageUrl('hamlib.config.yaml')), 'utf8')) as {
    release: UpstreamManifest;
  }
).release;

export const UPSTREAM_VERSION = UPSTREAM_MANIFEST.version;

/** Provenance written by `mise run build-native` into the built package. */
export function readBuiltProvenance(): UpstreamProvenance {
  return JSON.parse(
    readFileSync(
      fileURLToPath(packageUrl('dist/third_party/hamlib/SOURCE.json')),
      'utf8',
    ),
  );
}

/** The patch text actually shipped inside the built package. */
export function readShippedPatch(file: string): string {
  return readFileSync(
    fileURLToPath(packageUrl(`dist/third_party/hamlib/${file}`)),
    'utf8',
  );
}

/** The patch text recorded in the repository. */
export function readRepositoryPatch(file: string): string {
  return readFileSync(
    fileURLToPath(packageUrl(`native/patches/${file}`)),
    'utf8',
  );
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

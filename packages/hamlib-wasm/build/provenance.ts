// SPDX-License-Identifier: MIT

/** `SOURCE.json`: the provenance of the bundled Hamlib build. */
import { readJson } from './files.ts';
import { SOURCE_JSON } from './paths.ts';

export interface SourcePatch {
  readonly file: string;
  readonly purpose: string;
  readonly sha256: string;
}

export interface SourceManifest {
  readonly component: 'Hamlib';
  readonly version: string;
  readonly series: string;
  readonly license: string;
  readonly upstreamRepository: string;
  readonly upstreamCommit: string;
  readonly upstreamTagObject: string;
  /** The upstream release archive and its SHA-256. */
  readonly url: string;
  readonly sha256: string;
  /** The archive's path inside the relink kit. */
  readonly sourceArchiveFile: string;
  readonly patches: readonly SourcePatch[];
  /** Package-relative, like every other path below unless noted. */
  readonly correspondingSource: string;
  /** Null in the kit's own copy, which cannot contain its own hash. */
  readonly correspondingSourceSha256: string | null;
  readonly rebuildInstructions: string;
  /** The first line of `emcc --version`. */
  readonly emscriptenVersion: string;
  readonly nodeVersion: string;
  readonly linkedLicenses: readonly string[];
  readonly bundledSourceLicenses: readonly string[];
  readonly licenseFiles: readonly string[];
  readonly licenseFileSha256: Readonly<Record<string, string>>;
  readonly linkInputs: string;
  readonly linkInputsSha256: string;
  readonly note: string;
}

export function readSourceManifest(file: string = SOURCE_JSON): SourceManifest {
  return readJson<SourceManifest>(file);
}

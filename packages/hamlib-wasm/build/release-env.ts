// SPDX-License-Identifier: MIT

import { sha256File } from './files.ts';
import { releaseSourceDirName } from './paths.ts';
import type { Upstream } from './upstream.ts';

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The release values `rebuild.sh` sources. */
export function releaseEnv(upstream: Upstream): string {
  return [
    `HAMLIB_VERSION=${shellQuote(upstream.version)}`,
    `HAMLIB_ARCHIVE_NAME=${shellQuote(upstream.archive.name)}`,
    `HAMLIB_ARCHIVE_SHA256=${shellQuote(upstream.archive.sha256)}`,
    `HAMLIB_SOURCE_DIR=${shellQuote(releaseSourceDirName(upstream))}`,
    '',
  ].join('\n');
}

/** Every patch in application order, in `sha256sum` format. */
export function patchesSha256(upstream: Upstream): string {
  return upstream.patches
    .map((patch) => `${sha256File(patch.path)}  ${patch.file}\n`)
    .join('');
}

// SPDX-License-Identifier: MIT

import {
  CONFIGURE_ARGS,
  CONFIGURE_VALUES,
  LINK_ARGS,
  configureCppflags,
} from './native-flags.ts';
import { sha256File } from './files.ts';
import {
  packageLicensingEntries,
  type PackageLicensingEntry,
} from './package-manifest.ts';
import type { Upstream } from './upstream.ts';

export function releaseEnv(upstream: Upstream): string {
  const patch = upstream.patches[0];

  if (!patch) {
    throw new Error('the release has no patch');
  }

  return [
    `HAMLIB_VERSION='${upstream.version}'`,
    `HAMLIB_ARCHIVE_NAME='${upstream.archive.name}'`,
    `HAMLIB_ARCHIVE_SHA256='${upstream.archive.sha256}'`,
    `HAMLIB_PATCH_FILE='${patch.file}'`,
    `HAMLIB_PATCH_SHA256='${sha256File(patch.path)}'`,
    `HAMLIB_SOURCE_DIR='hamlib-${upstream.version}'`,
    '',
  ].join('\n');
}

/** Shell values shared by the native build and the standalone kit. */
export function configureEnv(): string {
  const cppflags = configureCppflags('$KIT_DIR/native');

  return [
    `CPPFLAGS="${cppflags}"`,
    ...CONFIGURE_VALUES.map((value) => {
      const separator = value.indexOf('=');
      return `${value.slice(0, separator)}='${value.slice(separator + 1)}'`;
    }),
    '',
  ].join('\n');
}

export function configureArgsFile(): string {
  return `${CONFIGURE_ARGS.join('\n')}\n`;
}

export function linkArgsFile(): string {
  return `${LINK_ARGS.join('\n')}\n`;
}

export interface PackageLicensingManifest {
  readonly copy: readonly PackageLicensingEntry[];
}

export function packageLicensingManifest(upstream: Upstream): PackageLicensingManifest {
  return { copy: packageLicensingEntries(upstream) };
}

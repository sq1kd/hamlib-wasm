// SPDX-License-Identifier: MIT

import {
  CONFIGURE_ARGS,
  CONFIGURE_VALUES,
  LINK_ARGS,
  configureCppflags,
} from './native-flags.ts';
import { sha256File } from './files.ts';
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

export interface PackageLicensingEntry {
  readonly from: string;
  readonly to: string;
  readonly recursive?: boolean;
}

export interface PackageLicensingManifest {
  readonly copy: readonly PackageLicensingEntry[];
}

export function packageLicensingManifest(upstream: Upstream): PackageLicensingManifest {
  return {
    copy: [
      { from: 'LICENSE.md', to: 'LICENSE.md' },
      { from: 'LICENSES', to: 'LICENSES', recursive: true },
      { from: 'THIRD_PARTY_NOTICES.md', to: 'THIRD_PARTY_NOTICES.md' },
      { from: 'REBUILDING.md', to: 'REBUILDING.md' },
      { from: 'dist/third_party/hamlib/LICENSE', to: 'third_party/hamlib/LICENSE' },
      { from: 'dist/third_party/hamlib/COPYING', to: 'third_party/hamlib/COPYING' },
      { from: 'dist/third_party/hamlib/COPYING.LIB', to: 'third_party/hamlib/COPYING.LIB' },
      { from: 'dist/third_party/hamlib/AUTHORS', to: 'third_party/hamlib/AUTHORS' },
      ...upstream.patches.map((patch) => ({
        from: `dist/third_party/hamlib/${patch.file}`,
        to: `third_party/hamlib/${patch.file}`,
      })),
      { from: 'dist/third_party/hamlib/SOURCE.json', to: 'third_party/hamlib/SOURCE.json' },
      { from: 'dist/third_party/hamlib/LINK_INPUTS.json', to: 'third_party/hamlib/LINK_INPUTS.json' },
      {
        from: 'dist/third_party/hamlib/corresponding-source.tar.gz',
        to: 'third_party/hamlib/corresponding-source.tar.gz',
      },
    ],
  };
}

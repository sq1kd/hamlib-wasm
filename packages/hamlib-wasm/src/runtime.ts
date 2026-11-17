// SPDX-License-Identifier: MIT

/**
 * Which runtime the package is loaded in.  Read through `globalThis`, so the
 * same code loads in a page, where there is no `process`.
 */

interface RuntimeScope {
  navigator?: { userAgent?: string };
  process?: { versions?: { node?: string; electron?: string } };
}

/** Node's version, and Electron's when it is Electron; `undefined` outside Node. */
function nodeVersions(): { node: string; electron?: string } | undefined {
  const versions = (globalThis as RuntimeScope).process?.versions;

  if (typeof versions?.node !== 'string') {
    return undefined;
  }

  return typeof versions.electron === 'string'
    ? { node: versions.node, electron: versions.electron }
    : { node: versions.node };
}

export function runsInNode(): boolean {
  return nodeVersions() !== undefined;
}

/** The runtime, as one line, for a bug report. */
export function describeRuntime(): string {
  const versions = nodeVersions();

  if (versions) {
    return versions.electron
      ? `electron ${versions.electron} (node ${versions.node})`
      : `node ${versions.node}`;
  }

  return (globalThis as RuntimeScope).navigator?.userAgent ?? 'unknown';
}

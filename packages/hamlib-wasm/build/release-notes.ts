#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Emit the "Bundled components" Markdown that `@semantic-release/exec`
 * appends to the generated release notes.  Only that block goes to stdout,
 * because semantic-release treats stdout as the notes themselves.
 *
 * This must never fail a release: provenance is best-effort, so every problem
 * is reported on stderr and the block is built from whatever is available.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { errorMessage as message } from './errors.ts';
import { readJson } from './files.ts';
import { CONFIG_PATH, MISE_TOML, SOURCE_JSON } from './paths.ts';
import { parseUpstreamConfig } from './upstream.ts';

const SCOPE = 'release-notes';

interface Components {
  readonly hamlibVersion?: string | undefined;
  readonly hamlibCommit?: string | undefined;
  readonly emscriptenVersion?: string | undefined;
}

function warn(message: string): void {
  process.stderr.write(`[${SCOPE}] ${message}\n`);
}

/** Reduce the full `emcc --version` banner to the release number. */
function shortEmscriptenVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) { return undefined; }
  return /\b\d+\.\d+\.\d+\b/.exec(value)?.[0] ?? value;
}

/** The provenance the package build records next to the third-party tree. */
function readProvenance(): Components | undefined {
  try {
    const source = readJson<Record<string, unknown>>(SOURCE_JSON);

    return {
      hamlibVersion: typeof source.version === 'string' ? source.version : undefined,
      hamlibCommit: typeof source.upstreamCommit === 'string' ? source.upstreamCommit : undefined,
      emscriptenVersion: shortEmscriptenVersion(source.emscriptenVersion),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warn(`cannot read ${SOURCE_JSON}: ${message(error)}`);
    }
    return undefined;
  }
}

/**
 * The emsdk pin from mise.toml's `[tools]` table.  Only one string is needed,
 * so this reads the table directly instead of taking on a TOML parser.
 */
function readPinnedEmscripten(): string | undefined {
  try {
    const text = readFileSync(MISE_TOML, 'utf8');
    const start = /^\[tools\][^\n]*$/m.exec(text);

    if (!start) { return undefined; }

    const table = text.slice(start.index + start[0].length).split(/^\[/m)[0] ?? '';
    return /^\s*emsdk\s*=\s*["']([^"']+)["']/m.exec(table)?.[1];
  } catch (error) {
    warn(`cannot read ${MISE_TOML}: ${message(error)}`);
    return undefined;
  }
}

/** The pinned release from hamlib.config.yaml. */
function readConfig(): Components | undefined {
  try {
    const upstream = parseUpstreamConfig(readFileSync(CONFIG_PATH, 'utf8'));

    return {
      hamlibVersion: upstream.version,
      hamlibCommit: upstream.commit,
      emscriptenVersion: readPinnedEmscripten(),
    };
  } catch (error) {
    warn(`cannot read ${CONFIG_PATH}: ${message(error)}`);
    return undefined;
  }
}

function buildBlock(): string {
  const provenance = readProvenance();
  const complete = provenance?.hamlibVersion !== undefined
    && provenance.hamlibCommit !== undefined
    && provenance.emscriptenVersion !== undefined;
  const config = complete ? undefined : readConfig();

  if (!provenance) {
    warn('build provenance not found; using the pinned config instead');
  } else if (!complete) {
    warn('provenance is incomplete; filling the missing fields from the pinned config');
  }

  const version = provenance?.hamlibVersion ?? config?.hamlibVersion;
  const commit = provenance?.hamlibCommit ?? config?.hamlibCommit;
  const emscripten = provenance?.emscriptenVersion ?? config?.emscriptenVersion;
  const lines = ['## Bundled components', ''];

  if (version) { lines.push(`- Hamlib: \`${version}\``); }
  if (commit) { lines.push(`- Hamlib revision: \`${commit}\``); }
  if (emscripten) { lines.push(`- Emscripten: \`${emscripten}\``); }

  if (lines.length === 2) {
    warn('no bundled component metadata was available');
    lines.push('_Bundled component provenance was unavailable._');
  }

  return `${lines.join('\n')}\n`;
}

try {
  process.stdout.write(buildBlock());
} catch (error) {
  warn(`cannot build the bundled components block: ${message(error)}`);
  process.stdout.write(
    '## Bundled components\n\n_Bundled component provenance was unavailable._\n',
  );
}

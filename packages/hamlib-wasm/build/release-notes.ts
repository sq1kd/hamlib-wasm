#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Emit the "Bundled components" Markdown that `@semantic-release/exec`
 * appends to the generated release notes.  Only that block goes to stdout,
 * because semantic-release treats stdout as the notes themselves.
 *
 * The block describes the build being released, so it reads that build's
 * `SOURCE.json` and fails when it is missing rather than guess from the
 * checkout.
 */
import process from 'node:process';

import { runMain } from './errors.ts';
import { assertFile } from './files.ts';
import { SOURCE_JSON } from './paths.ts';
import { emscriptenRelease, readSourceManifest } from './provenance.ts';

const SCOPE = 'release-notes';

function main(): void {
  assertFile(SOURCE_JSON, 'build provenance (restore or build the released package first)');
  const source = readSourceManifest();

  process.stdout.write([
    '## Bundled components',
    '',
    `- Hamlib: \`${source.version}\``,
    `- Hamlib revision: \`${source.upstreamCommit}\``,
    `- Emscripten: \`${emscriptenRelease(source.emscriptenVersion)}\``,
    '',
  ].join('\n'));
}

await runMain(SCOPE, main);

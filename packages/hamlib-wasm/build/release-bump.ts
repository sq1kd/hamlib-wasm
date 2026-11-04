#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Update the pinned Hamlib release in one place.  The patch remains reviewed
 * source: this helper updates the config and, with --verify, runs the full
 * fetch/generate/build/verify sequence.
 *
 * The config is edited as a YAML document rather than by line regexes, so
 * comments and the surrounding binding-surface sections survive untouched, and
 * the result is validated with the same parser the build uses before it is
 * written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseDocument } from 'yaml';

import { assert } from './errors.ts';
import { log, parseFlag, run } from './exec.ts';
import { CONFIG_PATH } from './paths.ts';
import { loadUpstream, parseUpstreamConfig } from './upstream.ts';

const SCOPE = 'release-bump';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Every value for a repeated flag, in command-line order. */
function parseFlagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      values.push(args[index + 1] as string);
    }
  }

  return values;
}

function main(): void {
  const args = process.argv.slice(2);
  const version = parseFlag(args, '--version');
  const commit = parseFlag(args, '--commit');
  const tagObject = parseFlag(args, '--tag-object');
  const archiveUrl = parseFlag(args, '--archive-url');
  const archiveSha256 = parseFlag(args, '--archive-sha256')
    ?? parseFlag(args, '--sha256');
  const repository = parseFlag(args, '--repository');
  const patchFiles = parseFlagValues(args, '--patch-file');
  const verify = args.includes('--verify');
  const current = loadUpstream();

  assert(version, '--version is required');
  assert(/^\d+\.\d+(?:\.\d+)?$/.test(version), '--version is not a Hamlib release');
  assert(commit && COMMIT.test(commit), '--commit must be a 40-character lower-case SHA');
  assert(
    tagObject && COMMIT.test(tagObject),
    '--tag-object must be a 40-character lower-case SHA',
  );
  assert(archiveUrl, '--archive-url is required');
  assert(
    archiveSha256 && SHA256.test(archiveSha256),
    '--archive-sha256 (or --sha256) must be 64 lower-case hex',
  );
  assert(current.patches.length > 0, 'the release config has no patch');
  assert(
    patchFiles.length === 0 || patchFiles.length === current.patches.length,
    `--patch-file must be given once per configured patch (${current.patches.length})`,
  );

  const archiveName = path.basename(new URL(archiveUrl).pathname);
  const series = version.split('.').slice(0, 2).join('.');
  const document = parseDocument(readFileSync(CONFIG_PATH, 'utf8'));

  document.setIn(['release', 'version'], version);
  document.setIn(['release', 'series'], series);
  document.setIn(['release', 'commit'], commit);
  document.setIn(['release', 'tagObject'], tagObject);
  document.setIn(['release', 'archive', 'name'], archiveName);
  document.setIn(['release', 'archive', 'url'], archiveUrl);
  document.setIn(['release', 'archive', 'sha256'], archiveSha256);

  if (repository) {
    document.setIn(['release', 'repository'], repository);
  }

  patchFiles.forEach((file, index) => {
    document.setIn(['release', 'patches', index, 'file'], file);
  });

  /* Reflowing every long quoted scalar would bury the release change in diff
   * noise; emit the existing line structure. */
  const text = document.toString({ lineWidth: 0 });

  /* Validate the exact bytes that will be written; a bad version/series pair
   * or a patch that does not exist aborts before the config changes. */
  parseUpstreamConfig(text);

  writeFileSync(CONFIG_PATH, text);
  log(SCOPE, `updated ${path.relative(process.cwd(), CONFIG_PATH)} for Hamlib ${version}`);

  if (verify) {
    run(SCOPE, 'npm', ['run', 'fetch-native']);
    run(SCOPE, 'npm', ['run', 'generate']);
    run(SCOPE, 'npm', ['run', 'build-package']);
    run(SCOPE, 'npm', ['run', 'verify-package']);
  } else {
    log(SCOPE, 'next: mise run fetch-native && mise run generate && mise run build-package');
    log(SCOPE, 'then: mise run verify-package && mise run verify-relink');
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

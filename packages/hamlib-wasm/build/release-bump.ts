#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Update the pinned Hamlib release in one place.  The patches remain reviewed
 * source: this helper updates the config and, with --verify, regenerates the
 * bindings and runs the release verification (`mise run verify-release`).
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

import { assert, runMain } from './errors.ts';
import { log, parseFlag, run } from './exec.ts';
import { CONFIG_PATH } from './paths.ts';
import { loadUpstream, parseUpstreamConfig } from './upstream.ts';

const SCOPE = 'release-bump';

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

  /* The values themselves are validated by parseUpstreamConfig below. */
  assert(version, '--version is required');
  assert(commit, '--commit is required');
  assert(tagObject, '--tag-object is required');
  assert(archiveUrl, '--archive-url is required');
  assert(archiveSha256, '--archive-sha256 (or --sha256) is required');
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

  /* One mise graph: `generate` runs before the build that verify-release
   * depends on. */
  const tasks = ['generate', ':::', 'verify-release'];

  if (verify) {
    run(SCOPE, 'mise', ['run', ...tasks]);
  } else {
    log(SCOPE, `next: mise run ${tasks.join(' ')}`);
  }
}

await runMain(SCOPE, main);

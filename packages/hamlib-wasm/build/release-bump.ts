#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Update the pinned Hamlib release in one place.  The patch remains reviewed
 * source: this helper updates the config and, with --verify, runs the full
 * fetch/generate/build/verify sequence.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assert } from './errors.ts';
import { log, parseFlag, run } from './exec.ts';
import { CONFIG_PATH } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const SCOPE = 'release-bump';
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

interface Values {
  readonly version: string;
  readonly commit: string;
  readonly tagObject: string;
  readonly archiveUrl: string;
  readonly archiveSha256: string;
  readonly repository: string | null;
  readonly patchFile: string | null;
}

function updateLine(text: string, pattern: RegExp, value: string, what: string): string {
  assert(pattern.test(text), `could not find ${what} in hamlib.config.yaml`);
  return text.replace(pattern, `$1${value}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const version = parseFlag(args, '--version');
  const commit = parseFlag(args, '--commit');
  const tagObject = parseFlag(args, '--tag-object');
  const archiveUrl = parseFlag(args, '--archive-url');
  const archiveSha256 = parseFlag(args, '--archive-sha256');
  const repository = parseFlag(args, '--repository');
  const patchFile = parseFlag(args, '--patch-file');
  const verify = args.includes('--verify');
  const current = loadUpstream();

  const values: Values = {
    version: version ?? '',
    commit: commit ?? '',
    tagObject: tagObject ?? '',
    archiveUrl: archiveUrl ?? '',
    archiveSha256: archiveSha256 ?? '',
    repository,
    patchFile,
  };

  assert(values.version, '--version is required');
  assert(/^\d+\.\d+(?:\.\d+)?$/.test(values.version), '--version is not a Hamlib release');
  assert(COMMIT.test(values.commit), '--commit must be a 40-character lower-case SHA');
  assert(COMMIT.test(values.tagObject), '--tag-object must be a 40-character lower-case SHA');
  assert(values.archiveUrl, '--archive-url is required');
  assert(SHA256.test(values.archiveSha256), '--archive-sha256 must be 64 lower-case hex');
  assert(patchFile ?? current.patches[0], '--patch-file is required if no patch is configured');

  const archiveName = path.basename(new URL(values.archiveUrl).pathname);
  const series = values.version.split('.').slice(0, 2).join('.');
  let text = readFileSync(CONFIG_PATH, 'utf8');

  text = updateLine(text, /^(\s*version:\s*).*$/m, values.version, 'version');
  text = updateLine(text, /^(\s*series:\s*).*$/m, `"${series}"`, 'series');
  text = updateLine(text, /^(\s*commit:\s*).*$/m, values.commit, 'commit');
  text = updateLine(text, /^(\s*tagObject:\s*).*$/m, values.tagObject, 'tagObject');
  text = updateLine(text, /^(\s{4}name:\s*).*$/m, archiveName, 'archive name');
  text = updateLine(text, /^(\s*url:\s*).*$/m, values.archiveUrl, 'archive url');
  text = updateLine(text, /^(\s*sha256:\s*).*$/m, values.archiveSha256, 'archive sha256');

  if (values.repository) {
    text = updateLine(text, /^(\s*repository:\s*).*$/m, values.repository, 'repository');
  }

  if (values.patchFile) {
    text = updateLine(text, /^(\s*-\s*file:\s*).*$/m, values.patchFile, 'patch file');
  }

  writeFileSync(CONFIG_PATH, text);
  log(SCOPE, `updated ${path.relative(process.cwd(), CONFIG_PATH)} for Hamlib ${values.version}`);

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

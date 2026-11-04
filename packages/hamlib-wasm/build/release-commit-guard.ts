#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Guard the one change semantic-release cannot classify on its own: editing
 * the `release:` block of hamlib.config.yaml.  That block pins the bundled
 * Hamlib release, so the commit is user-visible and must carry a feat, fix or
 * perf type instead of disappearing as a chore.
 *
 * The comparison is against the merge base with main (or origin/main), so the
 * requirement is evaluated on HEAD's cumulative release pin rather than only
 * HEAD's own diff.  Everything is local Git + YAML: no network, no remote.
 *
 * Exits 1 when HEAD changes the block and its subject is not feat/fix/perf.
 * Skips with exit 0 when neither main nor origin/main is available, and on
 * any unexpected Git or YAML state: a local guard must not block unrelated
 * work.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

import { CONFIG_PATH, REPO_ROOT } from './paths.ts';

const SCOPE = 'release-commit-guard';
const CONFIG = path.relative(REPO_ROOT, CONFIG_PATH);
const SUBJECT_PATTERN = /^(feat|fix|perf)(\([^)]+\))?!?:/;

function warn(message: string): void {
  process.stderr.write(`[${SCOPE}] ${message}\n`);
}

function git(args: readonly string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function releaseBlockAt(ref: string): unknown {
  const content = git(['show', `${ref}:${CONFIG}`]);

  if (!content) { return undefined; }
  return (parse(content) as { release?: unknown } | null)?.release;
}

function mergeBase(): string | undefined {
  for (const base of ['main', 'origin/main']) {
    if (git(['rev-parse', '--verify', `${base}^{commit}`]) === undefined) { continue; }

    const found = git(['merge-base', 'HEAD', base]);
    if (found) { return found; }
  }
  return undefined;
}

/** Whether HEAD may carry its release pin under its current subject. */
function allowed(): boolean {
  const base = mergeBase();

  if (!base) {
    warn('neither main nor origin/main has a merge base with HEAD; skipping');
    return true;
  }

  const head = releaseBlockAt('HEAD');

  /* No file at HEAD leaves nothing to compare; do not block unrelated work. */
  if (head === undefined || isDeepStrictEqual(releaseBlockAt(base), head)) { return true; }

  const subject = git(['log', '-1', '--pretty=%s', 'HEAD']) ?? '';

  if (SUBJECT_PATTERN.test(subject)) { return true; }

  warn(
    `HEAD (${JSON.stringify(subject)}) changes the release: block of ${CONFIG}.\n`
      + 'Use a feat, fix, or perf commit type so semantic-release publishes the new\n'
      + 'bundled Hamlib release, for example:\n'
      + '  feat(hamlib): update the pinned Hamlib release\n'
      + '  fix(hamlib)!: update the pinned Hamlib release with a breaking API change',
  );
  return false;
}

try {
  process.exitCode = allowed() ? 0 : 1;
} catch (error) {
  warn(`internal error, skipping: ${error instanceof Error ? error.message : String(error)}`);
}

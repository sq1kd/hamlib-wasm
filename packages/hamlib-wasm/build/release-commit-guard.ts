#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Guard the one change semantic-release cannot classify on its own: editing
 * the `release:` block of hamlib.config.yaml.  That block pins the bundled
 * Hamlib release, so every commit that changes it is user-visible and must
 * release: a feat, fix or perf type, or a breaking-change marker, instead of
 * disappearing as a chore.
 *
 * Checks every commit in `--from <rev>` .. `--to <rev>` (default HEAD).  CI
 * passes a pull request's range; without `--from` the range starts at the
 * merge base with main (or origin/main), and the guard skips when neither
 * exists.
 */
import path from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

import { assert, runMain } from './errors.ts';
import { capture, log, parseFlag } from './exec.ts';
import { CONFIG_PATH, REPO_ROOT } from './paths.ts';

const SCOPE = 'release-guard';
const CONFIG = path.relative(REPO_ROOT, CONFIG_PATH);
const RELEASING_SUBJECT = /^(?:(?:feat|fix|perf)(?:\([^)]+\))?!?|\w+(?:\([^)]+\))?!):/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

function git(args: readonly string[]): string {
  return capture(SCOPE, 'git', args, { cwd: REPO_ROOT }).trim();
}

function gitOrUndefined(args: readonly string[]): string | undefined {
  try {
    return git(args);
  } catch {
    return undefined;
  }
}

/** The `release:` block at a revision; undefined when the file is absent. */
function releaseBlockAt(revision: string): unknown {
  const content = gitOrUndefined(['show', `${revision}:${CONFIG}`]);

  return content === undefined
    ? undefined
    : (parse(content) as { release?: unknown } | null)?.release;
}

function defaultBase(): string | undefined {
  for (const branch of ['main', 'origin/main']) {
    if (gitOrUndefined(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])) {
      return gitOrUndefined(['merge-base', 'HEAD', branch]);
    }
  }

  return undefined;
}

function releases(commit: string): boolean {
  const subject = git(['log', '-1', '--format=%s', commit]);
  const body = git(['log', '-1', '--format=%b', commit]);

  return RELEASING_SUBJECT.test(subject) || BREAKING_FOOTER.test(body);
}

function main(): void {
  const args = process.argv.slice(2);
  const from = parseFlag(args, '--from') ?? defaultBase();
  const to = parseFlag(args, '--to') ?? 'HEAD';

  if (from === undefined) {
    log(SCOPE, 'neither main nor origin/main has a merge base with HEAD; skipping');
    return;
  }

  const commits = git(['rev-list', '--reverse', '--no-merges', `${from}..${to}`])
    .split('\n')
    .filter((commit) => commit.length > 0);
  const offenders = commits.filter((commit) => (
    !isDeepStrictEqual(releaseBlockAt(`${commit}^`), releaseBlockAt(commit))
    && !releases(commit)
  ));

  assert(
    offenders.length === 0,
    `${offenders.map((commit) => git(['log', '-1', '--format=%h %s', commit])).join('\n')}\n`
    + `changes the release: block of ${CONFIG} without releasing.\n`
    + 'Use a feat, fix or perf commit type so semantic-release publishes the new\n'
    + 'bundled Hamlib release, for example:\n'
    + '  feat(hamlib): update the pinned Hamlib release\n'
    + '  fix(hamlib)!: update the pinned Hamlib release with a breaking API change',
  );
  log(SCOPE, `${commits.length} commit(s) checked`);
}

await runMain(SCOPE, main);

// SPDX-License-Identifier: MIT

// Local guard for the one change that semantic-release cannot classify well on
// its own: editing the `release:` block of hamlib.config.yaml.  That block
// pins the bundled Hamlib release, so the commit is user-visible and must carry
// a feat, fix, or perf type instead of disappearing as a chore.
//
// The comparison is against the merge base with main (or origin/main), so the
// requirement is evaluated on HEAD's cumulative release pin rather than only
// HEAD's own diff.  Everything is local Git + YAML: no network, no remote
// required.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = 'packages/hamlib-wasm/hamlib.config.yaml';
const SUBJECT_PATTERN = /^(feat|fix|perf)(\([^)]+\))?!?:/;
const REQUIRED_TYPES = 'feat, fix, or perf';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'Usage: node scripts/release-commit-guard.mjs\n\n' +
      'Exits 1 when HEAD changes the release: block of\n' +
      `${CONFIG_PATH} and its subject is not a feat, fix, or perf commit.\n` +
      'Skips with exit 0 when main and origin/main are both unavailable.\n',
  );
  process.exit(0);
}

function warn(message) {
  process.stderr.write(`release-commit-guard: ${message}\n`);
}

function git(args) {
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

function releaseBlockAt(ref) {
  const content = git(['show', `${ref}:${CONFIG_PATH}`]);
  if (content === undefined || content === '') return undefined;
  try {
    return parseYaml(content)?.release;
  } catch (error) {
    warn(`cannot parse ${CONFIG_PATH} at ${ref}: ${error.message}`);
    return undefined;
  }
}

try {
  let mergeBase;
  for (const base of ['main', 'origin/main']) {
    if (git(['rev-parse', '--verify', `${base}^{commit}`]) === undefined) continue;
    mergeBase = git(['merge-base', 'HEAD', base]);
    if (mergeBase) break;
  }

  if (!mergeBase) {
    warn('neither main nor origin/main has a merge base with HEAD; skipping');
    process.exit(0);
  }

  const baseRelease = releaseBlockAt(mergeBase);
  const headRelease = releaseBlockAt('HEAD');

  // A missing file at HEAD means the guard has nothing to compare and cannot
  // demand a type; treat it as unchanged rather than blocking unrelated work.
  if (headRelease === undefined) process.exit(0);

  if (isDeepStrictEqual(baseRelease, headRelease)) process.exit(0);

  const subject = git(['log', '-1', '--pretty=%s', 'HEAD']) ?? '';
  if (SUBJECT_PATTERN.test(subject)) process.exit(0);

  warn(
    `HEAD (${JSON.stringify(subject)}) changes the release: block of ${CONFIG_PATH}.\n` +
      `Use a ${REQUIRED_TYPES} commit type so semantic-release publishes the new\n` +
      'bundled Hamlib release, for example:\n' +
      '  feat(hamlib): update the pinned Hamlib release\n' +
      '  fix(hamlib)!: update the pinned Hamlib release with a breaking API change',
  );
  process.exit(1);
} catch (error) {
  // A local guard must not block unrelated work on unexpected Git/YAML state.
  warn(`internal error, skipping: ${error?.message ?? error}`);
  process.exit(0);
}

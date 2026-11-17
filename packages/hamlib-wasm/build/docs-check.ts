#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Check that the documentation names only things that exist.
 *
 * Two independent drifts made the release docs stale: a renamed mise task left
 * its old name in prose, and a moved directory left a Layout table pointing at
 * a missing path.  Both are mechanical to check:
 *
 *   1. every `mise run <task>` in the READMEs, RELEASING.md and the
 *      REBUILDING template is a task (or alias) this repository declares;
 *   2. every relative path in the root README's Layout table exists.
 *
 * The task list comes from `mise tasks ls --json`, so `[tasks.*]` tables and
 * file tasks are covered alike, and the user's global tasks are not.
 *
 * This deliberately does not edit the docs.  It lists the mismatches and
 * exits non-zero so the author fixes the text where it is wrong.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assert, runMain } from './errors.ts';
import { capture, log } from './exec.ts';
import { REPO_ROOT } from './paths.ts';

const SCOPE = 'docs-check';
const MISE_RUN = /\bmise run ([A-Za-z0-9][A-Za-z0-9_.:+-]*)/g;
const INLINE_CODE = /`([^`\n]+)`/g;

interface MiseTask {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly source: string;
}

/**
 * Every task name and alias declared inside this repository.  mise also
 * merges tasks from parent directories and the user's global config; those
 * are not something the docs may promise.
 */
function miseTasks(): ReadonlySet<string> {
  const tasks = JSON.parse(
    capture(SCOPE, 'mise', ['tasks', 'ls', '--json', '--hidden'], { cwd: REPO_ROOT }),
  ) as MiseTask[];

  return new Set(
    tasks
      .filter((task) => !path.relative(REPO_ROOT, task.source).startsWith('..'))
      .flatMap((task) => [task.name, ...task.aliases]),
  );
}

/**
 * Documentation that promises tasks: the READMEs, the release guide and the
 * REBUILDING template the package build renders into the npm tarball.
 */
const DOCUMENTATION: readonly string[] = [
  'README.md',
  'RELEASING.md',
  path.join('packages', 'hamlib-wasm', 'README.md'),
  path.join('packages', 'hamlib-wasm', 'build', 'REBUILDING.md.in'),
];

/** `mise run` names mentioned in one document, deduplicated. */
function mentionedTasks(text: string): readonly string[] {
  const names = new Set<string>();

  for (const match of text.matchAll(MISE_RUN)) {
    /* Sentence punctuation can follow the name directly. */
    names.add((match[1] as string).replace(/\.+$/, ''));
  }

  return [...names];
}

/** The path tokens in the first column of the root README's Layout table. */
function layoutPaths(text: string): readonly string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^##\s+Layout\s*$/.test(line));

  if (start < 0) { return []; }

  const paths = new Set<string>();

  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) { break; }
    if (!line.trim().startsWith('|')) { continue; }

    const firstCell = line.split('|')[1] ?? '';

    if (/^\s*-+\s*$/.test(firstCell)) { continue; }

    for (const match of firstCell.matchAll(INLINE_CODE)) {
      const token = (match[1] as string).replace(/\/+$/, '');

      /* The cells hold repository-relative paths only.  Skip links and
       * placeholders so a future annotation does not become a false path. */
      if (
        token.length > 0
        && !token.startsWith('http')
        && !token.includes('<')
        && !token.includes(' ')
      ) {
        paths.add(token);
      }
    }
  }

  return [...paths];
}

function main(): void {
  const tasks = miseTasks();
  const mismatches: string[] = [];

  for (const relative of DOCUMENTATION) {
    const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');

    for (const task of mentionedTasks(text)) {
      if (!tasks.has(task)) {
        mismatches.push(`${relative}: mise task "${task}" is not a declared mise task`);
      }
    }
  }

  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

  for (const relative of layoutPaths(readme)) {
    if (!existsSync(path.join(REPO_ROOT, relative))) {
      mismatches.push(`README.md: layout path "${relative}" does not exist`);
    }
  }

  assert(
    mismatches.length === 0,
    `${mismatches.length} documentation mismatch(es):\n${mismatches.join('\n')}`,
  );

  log(SCOPE, 'documented tasks and layout paths all exist');
}

await runMain(SCOPE, main);

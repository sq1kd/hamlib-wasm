#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Check that the documentation names only things that exist.
 *
 * Two independent drifts made the release docs stale: a renamed mise task left
 * its old name in prose, and a moved directory left a Layout table pointing at
 * a missing path.  Both are mechanical to check:
 *
 *   1. every `mise run <task>` in the READMEs and `docs/*.md` is a
 *      `[tasks.<name>]` heading in `mise.toml`;
 *   2. every relative path in the root README's Layout table exists.
 *
 * This deliberately does not edit the docs.  It lists the mismatches and
 * exits non-zero so the author fixes the text where it is wrong.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { log } from './exec.ts';
import { REPO_ROOT } from './paths.ts';

const SCOPE = 'docs-check';
const MISE_RUN = /\bmise run ([A-Za-z0-9][A-Za-z0-9_.:+-]*)/g;
const TASK_HEADING = /^\[tasks\.([^\]]+)\]\s*$/gm;
const INLINE_CODE = /`([^`\n]+)`/g;

/** Every task name declared as a `[tasks.<name>]` heading in mise.toml. */
function miseTasks(): ReadonlySet<string> {
  const text = readFileSync(path.join(REPO_ROOT, 'mise.toml'), 'utf8');

  return new Set(
    [...text.matchAll(TASK_HEADING)]
      .map((match) => (match[1] as string).replace(/^"|"$/g, '')),
  );
}

/** Documentation that promises tasks and paths. */
function documentation(): readonly string[] {
  const files = [
    'README.md',
    'RELEASING.md',
    path.join('packages', 'hamlib-wasm', 'README.md'),
  ];

  for (const name of readdirSync(path.join(REPO_ROOT, 'docs')).sort()) {
    if (name.endsWith('.md')) { files.push(path.join('docs', name)); }
  }

  return files;
}

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

  for (const relative of documentation()) {
    const text = readFileSync(path.join(REPO_ROOT, relative), 'utf8');

    for (const task of mentionedTasks(text)) {
      if (!tasks.has(task)) {
        mismatches.push(`${relative}: mise task "${task}" is not declared in mise.toml`);
      }
    }
  }

  const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');

  for (const relative of layoutPaths(readme)) {
    if (!existsSync(path.join(REPO_ROOT, relative))) {
      mismatches.push(`README.md: layout path "${relative}" does not exist`);
    }
  }

  if (mismatches.length > 0) {
    for (const mismatch of mismatches) { log(SCOPE, mismatch); }
    log(SCOPE, `${mismatches.length} documentation mismatch(es)`);
    process.exit(1);
  }

  log(SCOPE, 'documented tasks and layout paths all exist');
}

try {
  main();
} catch (error) {
  process.stderr.write(`[${SCOPE}] error: ${String(error)}\n`);
  process.exit(1);
}

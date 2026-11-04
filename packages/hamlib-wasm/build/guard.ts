// SPDX-License-Identifier: MIT

/**
 * Guard the repository against the two regressions that made release bumps
 * expensive: duplicated path literals and hardcoded release identity.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assert } from './errors.ts';
import { readJson, sha256File } from './files.ts';
import { REPO_ROOT } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const TASK_REFERENCE = /\bmise run ([A-Za-z0-9][A-Za-z0-9_.:+-]*)/g;

/**
 * Task names the repository actually declares: `[tasks.<name>]` headings from
 * `mise.toml` plus the root `package.json` scripts.  Parsing the heading text
 * keeps this dependency-free; mise's own config parser would be a build
 * dependency for one regex.
 */
function declaredTaskNames(): ReadonlySet<string> {
  const toml = readFileSync(path.join(REPO_ROOT, 'mise.toml'), 'utf8');
  const tasks = [...toml.matchAll(/^\[tasks\.([^\]]+)\]\s*$/gm)]
    .map((match) => (match[1] as string).replace(/^"|"$/g, ''));
  const scripts = Object.keys(
    readJson<{ scripts?: Record<string, string> }>(
      path.join(REPO_ROOT, 'package.json'),
    ).scripts ?? {},
  );

  return new Set([...tasks, ...scripts]);
}

/** `mise run` references in `content` that name no declared task. */
function staleTaskReferences(content: string, declared: ReadonlySet<string>): string[] {
  const stale = new Set<string>();

  for (const match of content.matchAll(TASK_REFERENCE)) {
    /* A sentence may end right after the task name; the dot is punctuation,
     * not part of the name. */
    const name = (match[1] as string).replace(/\.+$/, '');

    if (!declared.has(name)) { stale.add(name); }
  }

  return [...stale];
}

const HISTORICAL_DOCS = new Set([
  'docs/plan.md',
  'docs/implementation.md',
  'docs/hamlib-wasm-licensing-implementation.md',
  'docs/HAMLIB_WASM_RELEASE_DOCS_PLAN.md',
]);

const GENERATED_DOCS = new Set([
  'THIRD_PARTY_NOTICES.md',
  'packages/hamlib-wasm/THIRD_PARTY_NOTICES.md',
  'packages/hamlib-wasm/REBUILDING.md',
  'docs/licensing-audit.md',
  'docs/licensing-rebuild.md',
]);

const PATH_DECLARATION =
  /^\s*(?:export\s+)?const\s+(?:PACKAGE_DIR|REPO_ROOT|NATIVE_DIR|CACHE_DIR|BUILD_DIR|SOURCE_DIR|DIST_DIR|DIST_NATIVE_DIR|THIRD_PARTY_DIR)\s*=\s*(?:path\.(?:join|resolve)|'|")/m;

const BUILD_SCOPE = 'packages/hamlib-wasm/build/';
const REACT_SCRIPT_SCOPE = 'examples/react/scripts/';

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((file) => file.length > 0);
}

function releasePatterns(): readonly string[] {
  const upstream = loadUpstream();

  assert(upstream.patches.length > 0, 'the release config has no patch');

  return [
    upstream.version,
    upstream.commit,
    upstream.tagObject,
    upstream.archive.sha256,
    ...upstream.patches.map((patch) => sha256File(patch.path)),
  ];
}

export function verifyRepository(): void {
  const files = trackedFiles();
  const release = releasePatterns();
  const declaredTasks = declaredTaskNames();
  const upstream = loadUpstream();
  const patchPaths = new Set(
    upstream.patches.map((patch) => path.relative(REPO_ROOT, patch.path)),
  );
  const failures: string[] = [];

  for (const file of files) {
    if (HISTORICAL_DOCS.has(file)) {
      continue;
    }

    if (file === 'packages/hamlib-wasm/build/guard.ts') {
      continue;
    }

    const content = readFileSync(path.join(REPO_ROOT, file), 'utf8');

    for (const task of staleTaskReferences(content, declaredTasks)) {
      failures.push(`${file}: unknown task name ${task}`);
    }

    if (
      (file.startsWith(BUILD_SCOPE) || file.startsWith(REACT_SCRIPT_SCOPE))
      && !file.endsWith('paths.ts')
      && PATH_DECLARATION.test(content)
    ) {
      failures.push(`${file}: duplicate path declaration`);
    }

    if (
      !GENERATED_DOCS.has(file)
      && file !== 'packages/hamlib-wasm/hamlib.config.yaml'
      && file !== 'packages/hamlib-wasm/coverage.json'
      && !patchPaths.has(file)
      && !file.startsWith('docs/templates/')
    ) {
      for (const literal of release) {
        if (content.includes(literal)) {
          failures.push(`${file}: hardcoded release literal ${literal.slice(0, 12)}…`);
        }
      }
    }
  }

  assert(
    failures.length === 0,
    `repository guard failed:\n${failures.join('\n')}`,
  );
}

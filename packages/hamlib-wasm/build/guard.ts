// SPDX-License-Identifier: MIT

/**
 * Guard the repository against the two regressions that made release bumps
 * expensive: duplicated path literals and hardcoded release identity.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { assert } from './errors.ts';
import { sha256File } from './files.ts';
import { REPO_ROOT } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const OLD_TASKS = [
  'build:native',
  'build:package',
  'build:example',
  'build:react-example',
  'build:harness',
  'typecheck:projects',
  'typecheck:consumer',
  'test:hooks',
  'test:node',
  'test:browser',
  'test:hardware',
  'pack:check',
  'check:licensing',
  'relink:check',
  'dev:react',
  'audit:backends',
  'compare:native',
  'baseline:record',
  'example:node',
];

const HISTORICAL_DOCS = new Set([
  'docs/plan.md',
  'docs/implementation.md',
  'docs/hamlib-wasm-licensing-implementation.md',
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
  const patch = upstream.patches[0];

  assert(patch, 'the release config has no patch');

  return [
    upstream.version,
    upstream.commit,
    upstream.tagObject,
    upstream.archive.sha256,
    sha256File(patch.path),
  ];
}

export function verifyRepository(): void {
  const files = trackedFiles();
  const release = releasePatterns();
  const failures: string[] = [];

  for (const file of files) {
    if (HISTORICAL_DOCS.has(file)) {
      continue;
    }

    if (file === 'packages/hamlib-wasm/build/guard.ts') {
      continue;
    }

    const content = readFileSync(path.join(REPO_ROOT, file), 'utf8');

    for (const task of OLD_TASKS) {
      if (content.includes(task)) {
        failures.push(`${file}: old task name ${task}`);
      }
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
      && file !== 'packages/hamlib-wasm/native/patches/hamlib-4.7.2-web.patch'
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

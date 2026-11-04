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

const PATH_DECLARATION =
  /^\s*(?:export\s+)?const\s+(?:PACKAGE_DIR|REPO_ROOT|NATIVE_DIR|CACHE_DIR|BUILD_DIR|SOURCE_DIR|DIST_DIR|DIST_NATIVE_DIR|THIRD_PARTY_DIR)\s*=\s*(?:path\.(?:join|resolve)|'|")/m;

const BUILD_SCOPE = 'packages/hamlib-wasm/build/';

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
  const upstream = loadUpstream();
  const patchPaths = new Set(
    upstream.patches.map((patch) => path.relative(REPO_ROOT, patch.path)),
  );
  const failures: string[] = [];

  for (const file of files) {
    const content = readFileSync(path.join(REPO_ROOT, file), 'utf8');

    if (
      file.startsWith(BUILD_SCOPE)
      && !file.endsWith('paths.ts')
      && PATH_DECLARATION.test(content)
    ) {
      failures.push(`${file}: duplicate path declaration`);
    }

    if (
      file !== 'packages/hamlib-wasm/hamlib.config.yaml'
      && file !== 'packages/hamlib-wasm/coverage.json'
      && !patchPaths.has(file)
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

#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Guard the repository against the two regressions that made release bumps
 * expensive: file locations declared outside `paths.ts` and hardcoded release
 * identity.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { assert, runMain } from './errors.ts';
import { capture, log } from './exec.ts';
import { sha256File } from './files.ts';
import { BUILD_SCRIPTS_DIR, CONFIG_PATH, PACKAGE_DIR, REPO_ROOT } from './paths.ts';
import { loadUpstream } from './upstream.ts';

const SCOPE = 'guard';

/** A module-level constant that locates a file or directory. */
const PATH_DECLARATION =
  /^(?:export\s+)?const\s+\w+\s*(?::[^=]+)?=\s*(?:path\.(?:join|resolve|dirname)|fileURLToPath)\(/m;

function repositoryFiles(): string[] {
  return capture(SCOPE, 'git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
  })
    .split('\n')
    .filter((file) => file.length > 0 && existsSync(path.join(REPO_ROOT, file)));
}

function main(): void {
  const upstream = loadUpstream();
  const relative = (file: string): string => path.relative(REPO_ROOT, file);
  const buildScope = `${relative(BUILD_SCRIPTS_DIR)}/`;
  const pathsModule = relative(path.join(BUILD_SCRIPTS_DIR, 'paths.ts'));
  const releaseLiterals = [
    upstream.version,
    upstream.commit,
    upstream.tagObject,
    upstream.archive.sha256,
    ...upstream.patches.map((patch) => sha256File(patch.path)),
  ];
  /* The files that pin the release, and the recorded coverage report. */
  const releaseOwners = new Set([
    relative(CONFIG_PATH),
    relative(path.join(PACKAGE_DIR, 'coverage.json')),
    ...upstream.patches.map((patch) => relative(patch.path)),
  ]);
  const failures: string[] = [];

  for (const file of repositoryFiles()) {
    const content = readFileSync(path.join(REPO_ROOT, file), 'utf8');

    if (
      file.startsWith(buildScope)
      && /\.m?ts$/.test(file)
      && file !== pathsModule
      && PATH_DECLARATION.test(content)
    ) {
      failures.push(`${file}: declares a path outside ${pathsModule}`);
    }

    if (!releaseOwners.has(file)) {
      for (const literal of releaseLiterals) {
        if (content.includes(literal)) {
          failures.push(`${file}: hardcoded release literal ${literal.slice(0, 12)}…`);
        }
      }
    }
  }

  assert(failures.length === 0, `repository guard failed:\n${failures.join('\n')}`);
  log(SCOPE, 'no stray path declarations or release literals');
}

await runMain(SCOPE, main);

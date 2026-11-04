#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Release entry point (`mise run release`).  Runs semantic-release with
 * release.config.cjs through its API, which distinguishes "nothing to
 * release" (a false result) from "published" (a result object); the CLI's
 * exit code alone cannot express that.
 *
 * Under GitHub Actions it writes two step outputs:
 *   released=true|false
 *   version=X.Y.Z            (empty when no release was published)
 *
 * Requires GITHUB_TOKEN and, for npm publishing, an id-token-enabled
 * environment whose npm Trusted Publisher matches this repository and the
 * release workflow.  Outside CI, semantic-release only does a dry run.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { log } from './exec.ts';
import { PACKAGE_JSON, REPO_ROOT } from './paths.ts';

const SCOPE = 'release';

interface Manifest {
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
}

/**
 * Make sure the package about to be published names the repository it was
 * built from.
 *
 * npm links a release and its provenance to `repository`, and the repository
 * has no remote until it is first pushed, so the field cannot be checked in as
 * a guess.  In CI the value is derived from `GITHUB_REPOSITORY`; locally the
 * release refuses to run unless the field is already set (or a dry run opts
 * out with RELEASE_ALLOW_MISSING_REPOSITORY=1).
 */
function ensureRepository(): void {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as Manifest;
  const relative = path.relative(REPO_ROOT, PACKAGE_JSON);

  if (manifest.repository !== undefined) { return; }

  const slug = process.env.GITHUB_REPOSITORY;

  if (slug) {
    manifest.repository = { type: 'git', url: `git+https://github.com/${slug}.git` };
    manifest.homepage ??= `https://github.com/${slug}#readme`;
    manifest.bugs ??= { url: `https://github.com/${slug}/issues` };
    writeFileSync(PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
    log(SCOPE, `stamped repository ${slug} into ${relative}`);
    return;
  }

  if (process.env.RELEASE_ALLOW_MISSING_REPOSITORY === '1') {
    log(SCOPE, `warning: ${relative} has no repository; publishing without it`);
    return;
  }

  throw new Error(
    `${relative} has no "repository" and GITHUB_REPOSITORY is unset; set the `
      + 'repository URL, or set RELEASE_ALLOW_MISSING_REPOSITORY=1 for a dry run',
  );
}

async function main(): Promise<void> {
  ensureRepository();

  const { default: semanticRelease } = await import('semantic-release');
  const result = await semanticRelease({}, { cwd: REPO_ROOT });
  const version = result ? result.nextRelease.version : '';

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `released=${result ? 'true' : 'false'}\nversion=${version}\n`,
    );
  }

  log(SCOPE, result ? `published ${version}` : 'no release was necessary');
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `[${SCOPE}] error: semantic-release failed: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
}

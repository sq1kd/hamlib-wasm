// SPDX-License-Identifier: MIT

// GitHub Actions entry point for the release job.  The semantic-release API
// distinguishes "nothing to release" (a false result) from "published"
// (a result object), which the CLI's exit code alone cannot express.
//
// The workflow reads the two outputs this writes:
//   released=true|false
//   version=X.Y.Z            (empty when no release was published)

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'Usage: node scripts/run-release.mjs\n\n' +
      'Runs semantic-release with release.config.cjs.  Requires GITHUB_TOKEN\n' +
      'and, for npm publishing, an id-token-enabled environment whose npm\n' +
      'Trusted Publisher matches this repository and the release workflow.\n' +
      'The published package needs a repository URL: it is stamped from\n' +
      'GITHUB_REPOSITORY here, or must already be set in package.json.\n',
  );
  process.exit(0);
}

const PACKAGE_JSON = 'packages/hamlib-wasm/package.json';

/**
 * Make sure the package about to be published names the repository it was
 * built from.
 *
 * npm links a release and its provenance to `repository`, and the repository
 * has no remote until it is first pushed, so the field cannot be checked in as
 * a guess.  In CI the value is derived from `GITHUB_REPOSITORY`; locally the
 * release refuses to run unless the field is already set (or a dry run opts
 * out explicitly).
 */
function ensureRepository() {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));

  if (manifest.repository !== undefined) {
    return;
  }

  const slug = process.env.GITHUB_REPOSITORY;

  if (slug) {
    const url = `git+https://github.com/${slug}.git`;

    manifest.repository = { type: 'git', url };
    manifest.homepage ??= `https://github.com/${slug}#readme`;
    manifest.bugs ??= { url: `https://github.com/${slug}/issues` };
    writeFileSync(PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stderr.write(`run-release: stamped repository ${slug} into ${PACKAGE_JSON}\n`);
    return;
  }

  if (process.env.RELEASE_ALLOW_MISSING_REPOSITORY === '1') {
    process.stderr.write(
      'run-release: warning: package.json has no repository; publishing without it\n',
    );
    return;
  }

  throw new Error(
    `${PACKAGE_JSON} has no "repository" and GITHUB_REPOSITORY is unset; `
    + 'set the repository URL, or set RELEASE_ALLOW_MISSING_REPOSITORY=1 for a dry run',
  );
}

try {
  ensureRepository();

  // Imported after --help so the usage text can be read before the release
  // dependencies are installed.
  const { default: semanticRelease } = await import('semantic-release');
  const result = await semanticRelease();
  const version = result?.nextRelease?.version ?? '';

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `released=${result ? 'true' : 'false'}\nversion=${version}\n`,
    );
  }

  process.stderr.write(
    result
      ? `run-release: published ${version}\n`
      : 'run-release: no release was necessary\n',
  );
} catch (error) {
  process.stderr.write(
    `run-release: semantic-release failed: ${error?.stack ?? error}\n`,
  );
  process.exitCode = 1;
}

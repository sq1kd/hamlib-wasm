<!-- SPDX-License-Identifier: MIT -->

# Releasing `hamlib-wasm`

The npm package is published only by `.github/workflows/release.yml` through
semantic-release. Nothing is version-stamped into the repository: the checked-in
`packages/hamlib-wasm/package.json` version (`0.1.0`) is a local placeholder, and
`@semantic-release/npm` supplies the selected version to the packed tarball. Do
not run `npm version`, do not edit that version by hand, and do not commit a
version bump.

The bundled Hamlib release is a separate input. Its version is reported in the
release notes and comes from the build provenance at
`packages/hamlib-wasm/dist/third_party/hamlib/SOURCE.json`, not from the npm
package version.

## Prerequisites (one time)

- **npm name availability.** Confirm before the first release:

  ```sh
  npm view hamlib-wasm version
  ```

  A `404` / `E404` means the name is unclaimed. If it is already owned, resolve
  ownership or choose the intended package name before wiring up automation.

- **Repository URL.** `packages/hamlib-wasm/package.json` carries
  `publishConfig: { access: "public", provenance: true }` but deliberately no
  guessed `repository`: the repository has no remote until it is first pushed.
  The release job stamps `repository`/`homepage`/`bugs` from
  `GITHUB_REPOSITORY` before invoking semantic-release, so provenance links to
  the real repository. Outside CI, `packages/hamlib-wasm/build/release-publish.ts` refuses to run
  without a `repository` field (a dry run may set
  `RELEASE_ALLOW_MISSING_REPOSITORY=1`).

- **Node 24 and npm >= 11.5.1.** Trusted Publishing requires npm CLI `11.5.1`
  or newer on Node `22.14.0` or newer; the repository pins Node `24.21.0` in
  `mise.toml`. Run `npm -v` and confirm it reports `11.5.1` or newer.
  `mise run bootstrap` installs the pinned toolchain and the locked
  dependencies.

- **Bootstrap publish.** An unowned npm name cannot have a Trusted Publisher, so
  the first version is published manually once:

  ```sh
  mise run build-package
  mise run verify-package

  cd packages/hamlib-wasm
  npm login                       # account with 2FA enabled
  npm publish --access public     # publishes the checked-in 0.1.0
  ```

  Then tag that exact commit and push the tag:

  ```sh
  git tag v0.1.0 <commit-that-was-published>
  git push origin v0.1.0
  ```

  The tag is important: without a previous release tag, semantic-release starts
  its history at `1.0.0` rather than continuing from `0.1.0`. The next
  automatic release is computed from `v0.1.0`.

- **npm Trusted Publisher.** On npmjs.com, open the `hamlib-wasm` package
  settings and add a Trusted Publisher with:

  | Field | Value |
  | --- | --- |
  | Publisher | GitHub Actions |
  | Organization or user | the GitHub account or organization that owns this repository |
  | Repository | this repository's name |
  | Workflow filename | `release.yml` |
  | Environment | leave blank |
  | Allowed actions | enable direct `npm publish` (see below) |

  Newer npm registries create trusted publishers with staged publishing
  allowed by default. semantic-release publishes directly with `npm publish`,
  so the publisher must also be allowed to run direct publishes; a stage-only
  configuration will fail the release job. Complete the first publish within
  two days of creating the publisher, or the unvalidated configuration
  expires and must be recreated.

  The workflow already requests `id-token: write`. There is no `NPM_TOKEN`
  secret, no `actions/setup-node`, and no `registry-url`; the generated `.npmrc`
  from `setup-node` conflicts with npm's OIDC authentication. The workflow
  filename must match the configured Trusted Publisher exactly.

## How versions are chosen

semantic-release analyzes conventional commit subjects since the last release
tag on the branch and applies these rules:

| Commit | Release |
| --- | --- |
| `feat: ...` / `feat(scope): ...` | minor |
| `fix: ...` / `fix(scope): ...` | patch |
| `perf: ...` / `perf(scope): ...` | patch |
| `revert: ...` | patch |
| any type with `!` (`feat(api)!: ...`) | major |
| any type with a `BREAKING CHANGE:` footer | major |
| `docs`, `ci`, `build`, `chore`, `refactor`, `style`, `test` | no release |

A change to the `release:` block of
`packages/hamlib-wasm/hamlib.config.yaml` pins a different Hamlib release and
is always user-visible, so its commit **must** be `feat` or `fix` (use `!` or a
`BREAKING CHANGE:` footer when the consumer-facing API or behavior breaks).
`chore(hamlib): bump the pinned release` will not publish and is rejected by
the local guard. Use, for example:

```text
feat(hamlib): update the pinned Hamlib release to 4.8.0
fix(hamlib): include the upstream regression fix for the QMX
feat(api)!: replace the initialization options object
```

Commit scopes are limited by `.commitlintrc.json` to `hamlib`, `api`, `build`,
`deps`, `docs`, `ci`, `tests`, and `release` (for example,
`chore(deps): update the release tooling`).

No release is produced when the commits contain nothing releasable: the release
job still succeeds, and `packages/hamlib-wasm/build/release-publish.ts` writes `released=false`.

## Branches and the `next` prerelease flow

- `main` publishes stable versions to the `latest` dist-tag.
- `next` publishes prereleases (`X.Y.Z-next.N`) to the `next` dist-tag.

To stage a feature:

```sh
git switch next
git merge main
# commit with feat/fix/perf...
git push origin next
npm install hamlib-wasm@next          # consumer check, once published
```

The push to `next` runs the release workflow and publishes a prerelease. To
promote it, merge `next` into `main`:

```sh
git switch main
git merge --no-ff next
git push origin main
```

`main` then publishes the corresponding stable version to `latest`. The
prerelease version stays on npm forever and remains installable through
`@next`; it is not retagged or deleted. `concurrency: release` with
`cancel-in-progress: false` keeps the two branches from publishing at once.

## What CI runs

- `.github/workflows/ci.yml` runs on pull requests, pushes to `main`, manual
  dispatch and a weekly schedule. Every run executes `mise run check-release`
  through the shared `.github/actions/setup` action (mise, `npm ci`, the Hamlib
  input cache and the Playwright browser cache); pull requests also lint their
  commit messages, and everything except pull requests runs the clean-room
  relink (`mise run verify-release`).
- `.github/workflows/release.yml` runs on pushes to `main` and `next` (and via
  `workflow_dispatch`). Its `verify` job restores the same caches and runs
  `mise run check-release` (which is `mise run check` +
  `mise run verify-package` + `mise run audit-backends`), then uploads the
  verified `packages/hamlib-wasm/dist`. Its `release` job checks out full
  history, runs `mise run release`, and never rebuilds the package.

Do not add separate build or test commands to the workflows: keep the release
gate in the `mise` tasks so local and CI behavior stay identical.

## Local commit checks

Install the hook once per clone:

```sh
git config core.hooksPath .githooks
```

`.githooks/commit-msg` runs the pinned commitlint CLI and rejects malformed
messages. The release-block guard is a separate local check and works offline:

```sh
mise run release-guard
```

It compares the `release:` block in `packages/hamlib-wasm/hamlib.config.yaml`
between `HEAD` and the merge base with `main` (falling back to `origin/main`).
If the block changed, `HEAD` must be a `feat`, `fix`, or `perf` commit;
otherwise it exits 1 with the required type. If neither branch exists locally,
the guard exits 0.

## Local dry run

Run semantic-release against a throwaway remote, never against the production
repository:

```sh
git clone --no-hardlinks . /tmp/hamlib-wasm-dry-run
cd /tmp/hamlib-wasm-dry-run

# A scratch GitHub repository you own, used only for tags/history lookups.
git remote set-url origin git@github.com:<you>/hamlib-wasm-dry-run.git
git push origin HEAD:main --tags

npm ci
mise run build-package          # or copy a matching packages/hamlib-wasm/dist

GITHUB_TOKEN=<token with repo access to the scratch repository> \
  npx semantic-release --dry-run --no-ci
```

`--dry-run` does not publish to npm, push tags, or create a GitHub Release. It
prints the next version and the generated notes, including the
`## Bundled components` section from `packages/hamlib-wasm/build/release-notes.ts`.
`--no-ci` prevents semantic-release from requiring a CI environment. A dry run
does not exercise OIDC or Trusted Publishing; only the real workflow does that.

If `dist/` is absent, the notes script falls back to
`packages/hamlib-wasm/hamlib.config.yaml` and `mise.toml` and still exits 0, but
the tarball prepared by the npm plugin will not contain the built package.
Always use a real build for a meaningful dry run.

## Recovery: npm published but the GitHub Release failed

**Never republish an immutable version.** If
`npm view hamlib-wasm@X.Y.Z version` succeeds, that version is final. Do not
rerun the whole release workflow, do not `npm publish` it again, and do not
delete or move the tag to "fix" it. Repair only the missing artifact.

1. Establish the state:

   ```sh
   npm view hamlib-wasm@<version> version gitHead dist.tarball
   git fetch --tags
   git tag --list "v<version>"
   gh release view "v<version>"
   ```

2. If the tag exists but the GitHub Release does not, create only the release
   from the existing tag, then append the bundled-components block:

   ```sh
   gh release create "v<version>" --verify-tag --generate-notes
   gh release view "v<version>" --json body -q .body > /tmp/release-notes.md
   node packages/hamlib-wasm/build/release-notes.ts >> /tmp/release-notes.md
   gh release edit "v<version>" --notes-file /tmp/release-notes.md
   ```

3. If npm published but the tag is missing, recreate the tag at the commit npm
   recorded, then create the release:

   ```sh
   git tag "v<version>" "$(npm view hamlib-wasm@<version> gitHead)"
   git push origin "v<version>"
   gh release create "v<version>" --verify-tag --generate-notes
   ```

4. If a tag exists but npm has no such version, do not delete or move the tag
   to force a same-version retry. semantic-release creates the Git tag before it
   runs the publish plugins, so a tag can exist without a published package.
   Check the run logs and whether the tag is on the remote
   (`git ls-remote --tags origin "v<version>"`). If the tag was only local to
   the failed runner, a rerun is safe. If it is already on the remote,
   semantic-release treats that version as released; make the fix in a new
   commit and let it produce the next version instead.

5. A later release is a new version. Never reuse a version number for a retry.

## Release checklist

- [ ] Commit messages are conventional; the pinned Hamlib release change uses
      `feat` or `fix` (and `!` if consumer-breaking).
- [ ] `mise run check-release` passes locally or in CI.
- [ ] The push is on `main` or `next` (or a deliberate `workflow_dispatch`).
- [ ] `release.yml` is green and `npm view hamlib-wasm version` shows the new
      version on the expected dist-tag.
- [ ] The GitHub Release exists for the matching `vX.Y.Z` tag.
- [ ] No `package.json` version change was committed.

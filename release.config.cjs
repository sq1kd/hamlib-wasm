// SPDX-License-Identifier: MIT

// semantic-release owns the npm package version.  The checked-in
// packages/hamlib-wasm/package.json version is only a local placeholder:
// @semantic-release/npm stamps the selected version into its pack copy, and
// no commit-back plugin is installed, so the repository does not drift.
//
// The bundled Hamlib version is deliberately independent of the wrapper
// version and is reported by the notes script from build provenance.
module.exports = {
  branches: ['main', { name: 'next', prerelease: true }],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: semantic-release expands this lodash template.
  tagFormat: 'v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      {
        // Runs only when a version is about to be published: the package audit
        // and clean-room relink of a tarball packed from the directory
        // @semantic-release/npm publishes, before it stamps the version.
        // --skip-deps: the job restored the build CI verified.
        verifyReleaseCmd: 'mise run --skip-deps verify-release',
        // Adds the "Bundled components" section from the restored build's
        // SOURCE.json; it fails rather than describe a different build.
        generateNotesCmd: 'node packages/hamlib-wasm/build/release-notes.ts',
      },
    ],
    [
      '@semantic-release/npm',
      {
        pkgRoot: 'packages/hamlib-wasm',
        npmPublish: true,
      },
    ],
    '@semantic-release/github',
  ],
};

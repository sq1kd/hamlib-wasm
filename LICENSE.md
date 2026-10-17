# Licensing

This repository is a mixed-license project. Its original code and its
upstream-derived components are subject to different licenses.

## Original project code — MIT

Unless a file or directory explicitly says otherwise, original code authored
for this project is licensed under the MIT License. This includes the
`packages/hamlib-codegen` generator, original TypeScript runtime and adapters,
original C/C++ interoperability and Web Serial code, build tooling, tests,
examples, and documentation.

Generated API bindings are covered by MIT only to the extent that they contain
our original material and do not reproduce independently copyrightable
third-party code or documentation. Such third-party material retains its
applicable license. The generator's output is audited in
`docs/licensing-audit.md`.

See `LICENSES/MIT.txt` for the complete license and copyright notice.

## Hamlib — LGPL-2.1-or-later

The Hamlib library and our changes to LGPL-covered Hamlib library files are
licensed under GNU LGPL version 2.1 or, at the recipient's option, a later
version (`LGPL-2.1-or-later`). We do not relicense Hamlib under MIT.

The `hamlib-wasm` package distributes a WebAssembly binary containing Hamlib
linked with our native interoperability code. The binary is a combined work;
its distribution is subject to the applicable LGPL conditions, including
notices and the ability to relink/rebuild with a modified Hamlib.

See `LICENSES/LGPL-2.1-or-later.txt`, `THIRD_PARTY_NOTICES.md`, and
`docs/licensing-rebuild.md`.

## Other upstream material

Some utilities and examples in Hamlib's original source distribution are
licensed under `GPL-2.0-or-later`. One upstream helper, `lib/precise_time.c`, is
`GPL-3.0-or-later`; the build excludes it from the linked WASM and supplies an
original MIT replacement. The distributed corresponding-source archive still
contains these upstream files, so their original GPL terms and notices apply to
those files. Their presence in the source archive does not relicense our
independently authored code and does not mean they are linked into the WASM.

See `THIRD_PARTY_NOTICES.md` for the actual set of included components and
license texts for the distributed release.

## Package metadata and precedence

The `license` field of each `package.json` describes the licenses represented
in that package; it does not grant a new license over third-party files.
Copyright and license notices in the individual files and bundled upstream
materials continue to apply.

Do not remove third-party notices. See the package-specific
`packages/hamlib-wasm/LICENSE.md` for distribution details.

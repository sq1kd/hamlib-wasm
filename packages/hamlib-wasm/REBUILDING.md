# Rebuilding `hamlib-wasm` with a modified Hamlib

This release includes the source and build inputs necessary to create a
replacement `hamlib-wasm.wasm` with a modified Hamlib library, consistent with
LGPL 2.1 section 6. The WASM contains statically linked Hamlib.

## Exact release inputs

- Package version: `hamlib-wasm` 0.1.0
- Hamlib version: 4.7.2, commit
  `40f63488fe0bd751b147f48d62fd217bf53713a0` (tag object
  `f4fe0e5feab233cf45606f63d7f2fdcb7d5579dc`)
- Original archive:
  https://github.com/Hamlib/Hamlib/releases/download/4.7.2/hamlib-4.7.2.tar.gz
- SHA-256 of original archive:
  `ae1fcf2dbc80ea0786ea8f047b09399c3f7737d1930442f61a031708ed33e88f`
- Patch: `hamlib-4.7.2-web.patch`
- SHA-256 of applied patch:
  `160e7cd4203b63048c4aee0623600d792cb4e4845b2218122165570c36b9cc5f`
- Toolchain: Emscripten SDK 6.0.10, Node.js 24, GNU tar, GNU patch (or the
  BSD equivalents), and `make`
- Source/relink kit in this npm package:
  `dist/third_party/hamlib/corresponding-source.tar.gz`

The kit contains the complete upstream Hamlib 4.7.2 source archive, the patch,
the project-owned native bridge and generated bindings, the precompiled
Emscripten JS library, and license/notice files. It does not need the
`hamlib-wasm` monorepo and does not download anything. The kit's `release.env`
carries the pinned version and hash values that `rebuild.sh` verifies.

## Build and relink procedure

The commands below were exercised from the packed npm tarball in a clean
temporary directory with only the documented toolchain. Run them with the
pinned Emscripten SDK active on `PATH`; in the repository, `mise exec --` does
that.

```sh
# 1. Start in a fresh directory and extract the kit from the installed package.
mkdir hamlib-relink
cd hamlib-relink
tar xzf /path/to/node_modules/hamlib-wasm/dist/third_party/hamlib/corresponding-source.tar.gz

# 2. Verify the recorded source and patch hashes, extract Hamlib, apply the
#    patch, and install the project serial transport.
./rebuild.sh --prepare

# 3. Make a harmless change to a Hamlib library source file.  For example,
#    change the version string in build/hamlib-4.7.2/src/rig.c:
#      const char hamlib_version[21] = "Hamlib " PACKAGE_VERSION;
#    or the corresponding hamlib_version2 initializer.
$EDITOR build/hamlib-4.7.2/src/rig.c

# 4. Compile and link the modified Hamlib into a replacement binary.
./rebuild.sh --source-dir build/hamlib-4.7.2

# 5. Replace the package's binary (keep a backup if you want to compare).
cp build/out/hamlib-wasm.wasm \
   /path/to/node_modules/hamlib-wasm/dist/native/hamlib-wasm.wasm

# 6. Exercise the replacement through the published loader.
node --input-type=module -e '
  import create from "/path/to/node_modules/hamlib-wasm/dist/native/hamlib-wasm.mjs";
  const module = await create();
  console.log(module.version());
  if (!module.version().includes("4.7.2")) process.exit(1);
'
```

The build writes:

```text
build/out/hamlib-wasm.wasm
build/out/hamlib-wasm.mjs
build/out/hamlib-wasm.d.mts
build/out/hamlib-wasm.map
```

`--prepare` writes `build/hamlib-4.7.2/`. `--source-dir` reuses that tree, so
edits survive the second invocation. A run without `--prepare` or
`--source-dir` extracts and patches a fresh tree and links immediately. The
output need not reproduce the original binary byte for byte; it must contain
the modified Hamlib implementation and load through the published loader.

## Distribution

When redistributing the resulting WASM in a website, application, or another
npm bundle, retain the Hamlib notices and the applicable LGPL license and
provide compliant corresponding-source/relink access with that distribution.
The kit in this package is the corresponding-source material for the unmodified
package. If you modify Hamlib, distribute your modified source as well, as
LGPL 2.1 section 2 requires.

#!/bin/sh
#
# Rebuild hamlib-wasm.wasm with the Hamlib source in this kit.
#
# This script is the tested relink procedure for the published package.  It is
# self-contained: it uses only the upstream archive, the patch, the project
# bridge and the precompiled Emscripten JS library in this kit.  It does not
# read the monorepo.
#
# SPDX-License-Identifier: MIT
set -eu

KIT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK_DIR="$PWD/build"
OUT_DIR=
SOURCE_DIR=
PREPARE_ONLY=0
JOBS=${JOBS:-4}
RELEASE_ENV="$KIT_DIR/release.env"

if [ ! -f "$RELEASE_ENV" ]; then
    echo "missing release.env in the kit; this is not a complete relink kit" >&2
    exit 1
fi

# Generated from packages/hamlib-wasm/hamlib.config.yaml when the kit is
# packaged.  Keeping the release values here means a Hamlib bump updates the
# script and the documentation from one source.
. "$RELEASE_ENV"

CONFIGURE_ENV="$KIT_DIR/configure.env"
CONFIGURE_ARGS_FILE="$KIT_DIR/configure.args"
LINK_ARGS_FILE="$KIT_DIR/link.args"

for file in "$CONFIGURE_ENV" "$CONFIGURE_ARGS_FILE" "$LINK_ARGS_FILE"; do
    if [ ! -f "$file" ]; then
        echo "missing build input in the kit: $file" >&2
        exit 1
    fi
done

. "$CONFIGURE_ENV"

usage() {
    cat <<'EOF'
Usage: ./rebuild.sh [options]

  --work-dir DIR    working directory (default: ./build)
  --out-dir DIR     output directory (default: WORK_DIR/out)
  --source-dir DIR  build an already prepared Hamlib tree instead of
                    extracting and patching the archive
  --prepare         extract, verify and patch, then stop
  --jobs N          parallel make jobs (default: 4)
  -h, --help        show this help

Prerequisites: tar, patch, sha256sum or shasum, and the pinned Emscripten SDK
(emconfigure, emake/emcc, em++).  Run the script with the SDK environment
active, for example `mise exec -- ./rebuild.sh` in the hamlib-wasm repository.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --work-dir)
            WORK_DIR=$2
            shift 2
            ;;
        --out-dir)
            OUT_DIR=$2
            shift 2
            ;;
        --source-dir)
            SOURCE_DIR=$2
            shift 2
            ;;
        --prepare)
            PREPARE_ONLY=1
            shift
            ;;
        --jobs)
            JOBS=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "unknown option: $1" >&2
            usage >&2
            exit 2
            ;;
    esac
done

if [ -z "$OUT_DIR" ]; then
    OUT_DIR="$WORK_DIR/out"
fi

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

require() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "missing required tool: $1" >&2
        exit 1
    }
}

require tar
require patch
require emconfigure
require emcc
require em++
require make
require awk

ARCHIVE="$KIT_DIR/source/$HAMLIB_ARCHIVE_NAME"
PATCH="$KIT_DIR/patches/$HAMLIB_PATCH_FILE"

[ -f "$ARCHIVE" ] || {
    echo "missing source archive: $ARCHIVE" >&2
    exit 1
}
[ -f "$PATCH" ] || {
    echo "missing patch: $PATCH" >&2
    exit 1
}

actual_archive=$(sha256 "$ARCHIVE")
if [ "$actual_archive" != "$HAMLIB_ARCHIVE_SHA256" ]; then
    echo "archive SHA-256 mismatch" >&2
    echo "expected: $HAMLIB_ARCHIVE_SHA256" >&2
    echo "actual:   $actual_archive" >&2
    exit 1
fi

actual_patch=$(sha256 "$PATCH")
if [ "$actual_patch" != "$HAMLIB_PATCH_SHA256" ]; then
    echo "patch SHA-256 mismatch" >&2
    echo "expected: $HAMLIB_PATCH_SHA256" >&2
    echo "actual:   $actual_patch" >&2
    exit 1
fi

if [ -z "$SOURCE_DIR" ]; then
    mkdir -p "$WORK_DIR"
    echo "extracting Hamlib $HAMLIB_VERSION"
    tar xzf "$ARCHIVE" -C "$WORK_DIR"
    SOURCE_DIR="$WORK_DIR/$HAMLIB_SOURCE_DIR"

    echo "applying $HAMLIB_VERSION web patch"
    patch -p1 --batch --forward --fuzz=0 -d "$SOURCE_DIR" -i "$PATCH"

    if find "$SOURCE_DIR" -name '*.rej' -o -name '*.orig' | grep -q .; then
        echo "patch left reject or backup files behind" >&2
        exit 1
    fi

    echo "installing the project serial transport"
    cp "$KIT_DIR/native/web_serial.c" "$SOURCE_DIR/src/serial.c"

    if ! grep -q 'Web Serial' "$SOURCE_DIR/src/serial.c"; then
        echo "the project serial transport was not installed" >&2
        exit 1
    fi
fi

if [ "$PREPARE_ONLY" -eq 1 ]; then
    echo "prepared Hamlib tree: $SOURCE_DIR"
    exit 0
fi

BUILD_DIR="$WORK_DIR/build"
mkdir -p "$BUILD_DIR" "$OUT_DIR"

echo "configuring Hamlib for wasm32-emscripten"
(
    cd "$BUILD_DIR"
    set -- "$SOURCE_DIR/configure" --host=wasm32-unknown-emscripten
    while IFS= read -r arg; do
        [ -n "$arg" ] && set -- "$@" "$arg"
    done < "$CONFIGURE_ARGS_FILE"
    set -- "$@" \
        "CPPFLAGS=$CPPFLAGS" \
        "CFLAGS=$CFLAGS" \
        "CXXFLAGS=$CXXFLAGS" \
        "PTHREAD_CFLAGS=$PTHREAD_CFLAGS" \
        "PTHREAD_LIBS=$PTHREAD_LIBS"
    emconfigure "$@"
)

echo "building libhamlib.a and built-in backends"
make -j "$JOBS" -C "$BUILD_DIR/src"

echo "linking hamlib-wasm"
# Compiled on its own: handed to em++ with the facade, a .c file is compiled
# as C++, which clang has deprecated.
emcc -c -O3 "$KIT_DIR/native/monotonic_time.c" -o "$BUILD_DIR/monotonic_time.o"
set -- \
    "$KIT_DIR/native/facade.cpp" \
    "$KIT_DIR/native/wrapped_io.cpp" \
    "$BUILD_DIR/monotonic_time.o" \
    "-I$BUILD_DIR/include" \
    "-I$SOURCE_DIR/include" \
    "-I$KIT_DIR/native" \
    "$BUILD_DIR/src/.libs/libhamlib.a" \
    --js-library "$KIT_DIR/library/web_serial.js"
while IFS= read -r arg; do
    [ -n "$arg" ] && set -- "$@" "$arg"
done < "$LINK_ARGS_FILE"
set -- "$@" \
    "-Wl,-Map=$OUT_DIR/hamlib-wasm.map" \
    -o "$OUT_DIR/hamlib-wasm.mjs" \
    --emit-tsd "$OUT_DIR/hamlib-wasm.d.mts"
em++ "$@"

{
    printf '%s\n' \
        '// SPDX-License-Identifier: MIT' \
        '// Emscripten-generated loader. The Emscripten runtime and sysroot' \
        '// components are MIT/NCSA-licensed. The WASM binary this loader' \
        '// instantiates contains LGPL-2.1-or-later Hamlib; see LICENSE.md and' \
        '// THIRD_PARTY_NOTICES.md.'
    cat "$OUT_DIR/hamlib-wasm.mjs"
} > "$OUT_DIR/hamlib-wasm.mjs.tmp"
mv "$OUT_DIR/hamlib-wasm.mjs.tmp" "$OUT_DIR/hamlib-wasm.mjs"

{
    printf '%s\n' \
        '// SPDX-License-Identifier: MIT' \
        '// Emscripten-generated TypeScript declarations for the project-owned' \
        '// Embind facade. See THIRD_PARTY_NOTICES.md for toolchain notices.'
    cat "$OUT_DIR/hamlib-wasm.d.mts"
} > "$OUT_DIR/hamlib-wasm.d.mts.tmp"
mv "$OUT_DIR/hamlib-wasm.d.mts.tmp" "$OUT_DIR/hamlib-wasm.d.mts"

echo "built:"
echo "  $OUT_DIR/hamlib-wasm.wasm"
echo "  $OUT_DIR/hamlib-wasm.mjs"
echo "  $OUT_DIR/hamlib-wasm.d.mts"
echo
echo "To use the replacement with an installed package, copy the rebuilt"
echo "hamlib-wasm.wasm over the package's dist/native/hamlib-wasm.wasm."

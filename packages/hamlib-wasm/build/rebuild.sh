#!/bin/sh
#
# Rebuild hamlib-wasm.wasm with the Hamlib source in this kit.
#
# This script is the tested relink procedure for the published package.  It is
# self-contained: it uses only the upstream archive, the patches, the project
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

# The release values, the patch list and the package build's own configure,
# compile and link commands, generated from the repository when the kit is
# packaged.
for file in release.env patches.sha256 configure.args compile.args link.args finish-module.mts; do
    if [ ! -f "$KIT_DIR/$file" ]; then
        echo "missing $file in the kit; this is not a complete relink kit" >&2
        exit 1
    fi
done

. "$KIT_DIR/release.env"

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

Prerequisites: tar, patch, sha256sum or shasum, make, Node.js and the pinned
Emscripten SDK (emconfigure, emcc, em++).  Run the script with the SDK
environment active, for example `mise exec -- ./rebuild.sh` in the hamlib-wasm
repository.
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

absolute() {
    CDPATH= cd -- "$1" && pwd
}

# Print $1 with every $2 replaced by $3.
replace() {
    rest=$1
    out=
    while :; do
        case $rest in
            *"$2"*)
                out=$out${rest%%"$2"*}$3
                rest=${rest#*"$2"}
                ;;
            *)
                printf '%s' "$out$rest"
                return
                ;;
        esac
    done
}

# Run a kit command file: one argument per line, the program first, with the
# kit and work paths as @KIT_DIR@, @SOURCE_DIR@, @BUILD_DIR@ and @OUT_DIR@.
run_command_file() {
    file=$1
    set --
    while IFS= read -r arg || [ -n "$arg" ]; do
        [ -n "$arg" ] || continue
        arg=$(replace "$arg" @KIT_DIR@ "$KIT_DIR")
        arg=$(replace "$arg" @SOURCE_DIR@ "$SOURCE_DIR")
        arg=$(replace "$arg" @BUILD_DIR@ "$BUILD_DIR")
        arg=$(replace "$arg" @OUT_DIR@ "$OUT_DIR")
        set -- "$@" "$arg"
    done < "$file"
    "$@"
}

for tool in tar patch emconfigure emcc em++ make awk node; do
    require "$tool"
done

ARCHIVE="$KIT_DIR/source/$HAMLIB_ARCHIVE_NAME"

[ -f "$ARCHIVE" ] || {
    echo "missing source archive: $ARCHIVE" >&2
    exit 1
}

actual=$(sha256 "$ARCHIVE")
if [ "$actual" != "$HAMLIB_ARCHIVE_SHA256" ]; then
    echo "archive SHA-256 mismatch" >&2
    echo "expected: $HAMLIB_ARCHIVE_SHA256" >&2
    echo "actual:   $actual" >&2
    exit 1
fi

while read -r expected patch_file; do
    [ -f "$KIT_DIR/patches/$patch_file" ] || {
        echo "missing patch: $KIT_DIR/patches/$patch_file" >&2
        exit 1
    }

    actual=$(sha256 "$KIT_DIR/patches/$patch_file")
    if [ "$actual" != "$expected" ]; then
        echo "patch SHA-256 mismatch: $patch_file" >&2
        echo "expected: $expected" >&2
        echo "actual:   $actual" >&2
        exit 1
    fi
done < "$KIT_DIR/patches.sha256"

mkdir -p "$WORK_DIR"
WORK_DIR=$(absolute "$WORK_DIR")

if [ -z "$SOURCE_DIR" ]; then
    echo "extracting Hamlib $HAMLIB_VERSION"
    tar xzf "$ARCHIVE" -C "$WORK_DIR"
    SOURCE_DIR="$WORK_DIR/$HAMLIB_SOURCE_DIR"

    while read -r expected patch_file; do
        echo "applying $patch_file"
        patch -p1 --batch --forward --fuzz=0 -d "$SOURCE_DIR" -i "$KIT_DIR/patches/$patch_file"
    done < "$KIT_DIR/patches.sha256"

    if find "$SOURCE_DIR" -name '*.rej' -o -name '*.orig' | grep -q .; then
        echo "patches left reject or backup files behind" >&2
        exit 1
    fi

    echo "installing the project serial transport"
    cp "$KIT_DIR/native/web_serial.c" "$SOURCE_DIR/src/serial.c"

    if ! grep -q 'Web Serial' "$SOURCE_DIR/src/serial.c"; then
        echo "the project serial transport was not installed" >&2
        exit 1
    fi
fi

SOURCE_DIR=$(absolute "$SOURCE_DIR")

if [ "$PREPARE_ONLY" -eq 1 ]; then
    echo "prepared Hamlib tree: $SOURCE_DIR"
    exit 0
fi

OUT_DIR=${OUT_DIR:-$WORK_DIR/out}
mkdir -p "$WORK_DIR/build" "$OUT_DIR"
BUILD_DIR=$(absolute "$WORK_DIR/build")
OUT_DIR=$(absolute "$OUT_DIR")

echo "configuring Hamlib for wasm32-emscripten"
(cd "$BUILD_DIR" && run_command_file "$KIT_DIR/configure.args")

echo "building libhamlib.a and built-in backends"
make -j "$JOBS" -C "$BUILD_DIR/src"

echo "linking hamlib-wasm"
run_command_file "$KIT_DIR/compile.args"
run_command_file "$KIT_DIR/link.args"
node "$KIT_DIR/finish-module.mts" "$OUT_DIR/hamlib-wasm.mjs" "$OUT_DIR/hamlib-wasm.d.mts"

echo "built:"
echo "  $OUT_DIR/hamlib-wasm.wasm"
echo "  $OUT_DIR/hamlib-wasm.mjs"
echo "  $OUT_DIR/hamlib-wasm.d.mts"
echo
echo "To use the replacement with an installed package, copy the rebuilt"
echo "hamlib-wasm.wasm over the package's dist/native/hamlib-wasm.wasm."

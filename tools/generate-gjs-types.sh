#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
set -e

srcdir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
toolsdir="$srcdir/tools"
outdir="$srcdir/@girs"
toolbox_name=gnome-shell-devel

usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTION]

Generate type definitions for GObject Introspection libraries.

Options:
  --toolbox  Run inside the "$toolbox_name" toolbox
  -h, --help Display this help
EOF
}

while [ $# -gt 0 ]; do
    case $1 in
        --toolbox)
            if ! command -v toolbox >/dev/null 2>&1; then
                echo "toolbox is required to run in a container" >&2
                exit 1
            fi

            toolbox run --container "$toolbox_name" \
                "$toolsdir/generate-gjs-types.sh" \
                __ensure-nodejs-toolbox__
            exec toolbox run --container "$toolbox_name" \
                "$toolsdir/generate-gjs-types.sh"
            ;;
        __ensure-nodejs-toolbox__)
            if [ ! -f /run/.toolboxenv ]; then
                echo "This command may only run inside Toolbox" >&2
                exit 1
            fi

            if ! command -v npx >/dev/null 2>&1; then
                echo "Installing Node.js and npm"

                # DNF supports installing packages passing a file contained within the package you want
                # This makes it future proof as new nodejs versions get released and deprecated
                sudo dnf install -y --setopt=install_weak_deps=False \
                    /usr/bin/node /usr/bin/npm /usr/bin/npx
            fi
            exit 0
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

cd "$toolsdir"

if ! command -v npx >/dev/null 2>&1; then
    echo "npx is required to generate GJS types" >&2
    echo "Run this script with --toolbox to install it automatically" >&2
    exit 1
fi

gir_args=()
for gir_dir in \
    /usr/local/share/gir-1.0 \
    /usr/share/gir-1.0 \
    /usr/share/*/gir-1.0 \
    /usr/lib/mutter-* \
    /usr/lib64/mutter-* \
    "$srcdir"/_build-*/src \
    "$srcdir"/_build-*/src/st; do
    if [ -d "$gir_dir" ]; then
        gir_args+=(-g "$gir_dir")
    fi
done

exec npx @ts-for-gir/cli generate '*' \
    --ignoreVersionConflicts \
    --outdir "$outdir" \
    "${gir_args[@]}"

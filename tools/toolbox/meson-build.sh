#!/usr/bin/env bash

set -e

DEFAULT_TOOLBOX=gnome-shell-devel
CONFIG_FILE=${XDG_CONFIG_HOME:-$HOME/.config}/gnome-shell-toolbox-tools.conf

usage() {
  cat <<-EOF
	Usage: $(basename "$0") [OPTION…]

	Build and install a meson project in a toolbox

	Options:
	  -t, --toolbox=TOOLBOX   Use TOOLBOX instead of the default "$DEFAULT_TOOLBOX"
	  --mutter-src=PATH       Build Mutter from a local source directory
	  --mutter-git=REPOSITORY Build Mutter from a Git repository
	  --mutter-git-rev=REV    Git branch, tag or commit to build

	  -Dkey=val               Option to pass to meson setup
	  --dist                  Run meson dist
	  --reconfigure           Reconfigure the project
	  --wipe                  Wipe build directory and reconfigure
	  --sysext                Install to separate target suitable for systemd-sysext

	  -h, --help              Display this help

	EOF
}

die() {
  echo "$@" >&2
  exit 1
}

build_mutter() {
  local source=$1
  local -a args

  args=(-t "$TOOLBOX" -Ddevkit=enabled)
  [[ $RECONFIGURE ]] && args+=(--reconfigure)
  [[ $WIPE ]] && args+=(--wipe)
  [[ $BUILD_SYSEXT ]] && args+=(--sysext)

  (cd "$source" && "$SCRIPT_PATH" "${args[@]}")
}

checkout_mutter() {
  local checkout_root
  local revision

  checkout_root=${XDG_CACHE_HOME:-$HOME/.cache}/gnome-shell-toolbox
  mkdir -p "$checkout_root"
  MUTTER_CHECKOUT=$(mktemp --directory \
    --tmpdir="$checkout_root" mutter.XXXXXX)
  trap 'rm -rf "$MUTTER_CHECKOUT"' EXIT

  git clone --filter=blob:none --no-checkout \
    "$MUTTER_GIT" "$MUTTER_CHECKOUT"

  if [[ $MUTTER_GIT_REV ]]; then
    if revision=$(git -C "$MUTTER_CHECKOUT" rev-parse --verify \
      "${MUTTER_GIT_REV}^{commit}" 2>/dev/null); then
      :
    elif revision=$(git -C "$MUTTER_CHECKOUT" rev-parse --verify \
      "origin/${MUTTER_GIT_REV}^{commit}" 2>/dev/null); then
      :
    else
      git -C "$MUTTER_CHECKOUT" fetch --filter=blob:none \
        origin "$MUTTER_GIT_REV"
      revision=$(git -C "$MUTTER_CHECKOUT" rev-parse \
        --verify 'FETCH_HEAD^{commit}')
    fi
  else
    revision=$(git -C "$MUTTER_CHECKOUT" rev-parse --verify 'HEAD^{commit}')
  fi

  git -C "$MUTTER_CHECKOUT" checkout --detach "$revision"
}

find_toplevel() {
  while true; do
    grep -qs '\<project\>' meson.build && break
    [[ $(pwd) -ef / ]] && die "Error: No meson toplevel found"
    cd ..
  done
}

setup_command() {
  if [[ ${#MESON_OPTIONS[*]} > 0 && -d $BUILD_DIR ]]; then
    RECONFIGURE=--reconfigure
  fi

  echo -n "meson setup --prefix=/usr $RECONFIGURE $WIPE ${MESON_OPTIONS[*]} $BUILD_DIR"
}

compile_command() {
  echo -n "meson compile -C $BUILD_DIR"
}

install_command() {
  local destdir=${BUILD_SYSEXT:+/var/lib/extensions/$TOOLBOX}

  local install_deps=.gitlab-ci/install-common-dependencies.sh
  if [[ $BUILD_SYSEXT && -x $install_deps ]]; then
    echo -n "$install_deps --destdir $destdir && "
  fi

  if [[ $destdir || ! $RUN_DIST ]]; then
    echo -n "sudo meson install -C $BUILD_DIR ${destdir:+--destdir=$destdir}"
  else
    echo -n :
  fi
}

dist_command() {
  if [[ $RUN_DIST ]]; then
    echo -n "meson dist -C $BUILD_DIR --include-subprojects"
  else
    echo -n :
  fi
}

# load defaults
if [[ -e "$CONFIG_FILE" ]]; then
  . $CONFIG_FILE
fi
TOOLBOX=$DEFAULT_TOOLBOX

TEMP=$(getopt \
  --name "$(basename "$0")" \
  --options 't:D:h' \
  --longoptions 'toolbox:' \
  --longoptions 'mutter-src:' \
  --longoptions 'mutter-git:' \
  --longoptions 'mutter-git-rev:' \
  --longoptions 'dist' \
  --longoptions 'reconfigure' \
  --longoptions 'wipe' \
  --longoptions 'sysext' \
  --longoptions 'help' \
  -- "$@") || die "Run $(basename "$0") --help to see available options"

eval set -- "$TEMP"
unset TEMP

MESON_OPTIONS=()

while true; do
  case $1 in
    -t|--toolbox)
      TOOLBOX=$2
      shift 2
    ;;

    --mutter-src)
      MUTTER_SRC=$2
      shift 2
    ;;

    --mutter-git)
      MUTTER_GIT=$2
      shift 2
    ;;

    --mutter-git-rev)
      MUTTER_GIT_REV=$2
      shift 2
    ;;

    --dist)
      RUN_DIST=1
      shift
    ;;

    --reconfigure)
       RECONFIGURE=--reconfigure
       shift
    ;;

    --wipe)
      WIPE=--wipe
      shift
    ;;

    --sysext)
      BUILD_SYSEXT=1
      shift
    ;;

    -D)
      MESON_OPTIONS+=(-D$2)
      shift 2
    ;;

    -h|--help)
      usage
      exit 0
    ;;

    --)
      shift
      break
    ;;
  esac
done

if [[ $MUTTER_SRC && $MUTTER_GIT ]]; then
  die "--mutter-src and --mutter-git cannot be used together"
fi

if [[ $MUTTER_GIT_REV && ! $MUTTER_GIT ]]; then
  die "--mutter-git-rev requires --mutter-git"
fi

SCRIPT_PATH=$(realpath "$0")

if [[ $MUTTER_GIT ]]; then
  checkout_mutter
  MUTTER_SRC=$MUTTER_CHECKOUT
elif [[ $MUTTER_SRC ]]; then
  [[ -d $MUTTER_SRC ]] || die "Mutter source directory does not exist: $MUTTER_SRC"
  MUTTER_SRC=$(realpath "$MUTTER_SRC")
fi

if [[ $MUTTER_SRC ]]; then
  [[ -f $MUTTER_SRC/meson.build ]] ||
    die "Mutter source directory does not contain meson.build: $MUTTER_SRC"
  build_mutter "$MUTTER_SRC"
fi

BUILD_DIR=_build-$TOOLBOX

find_toplevel

toolbox run --container $TOOLBOX sh -c "
  $(setup_command) &&
  $(compile_command) &&
  $(install_command) &&
  $(dist_command)"

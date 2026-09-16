#!/usr/bin/env sh
set -eu

repository="${INTEGRATIONS_REPOSITORY:-https://github.com/mokronos/integrations.git}"
install_directory="${INTEGRATIONS_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/integrations}"
binary_directory="${INTEGRATIONS_BIN_DIR:-}"
default_ref="main"
ref="${INTEGRATIONS_REF:-$default_ref}"

usage() {
  printf '%s\n' "Install integrations from GitHub.

Usage:
  install.sh [--ref <branch-or-tag>] [--dir <directory>] [--bin-dir <directory>]

Defaults:
  ref:       $default_ref
  checkout:  $install_directory
  binaries:  first existing directory of ~/.bun/bin or ~/.local/bin
"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || { printf '%s\n' "error: --ref requires a value" >&2; exit 1; }
      ref="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || { printf '%s\n' "error: --dir requires a value" >&2; exit 1; }
      install_directory="$2"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { printf '%s\n' "error: --bin-dir requires a value" >&2; exit 1; }
      binary_directory="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '%s\n' "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

command -v git >/dev/null 2>&1 || { printf '%s\n' "error: git is required" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { printf '%s\n' "error: Bun 1.2 or newer is required: https://bun.sh" >&2; exit 1; }
git check-ref-format --branch "$ref" >/dev/null 2>&1 || {
  printf '%s\n' "error: invalid Git branch or tag: $ref" >&2
  exit 1
}

if [ -e "$install_directory" ]; then
  [ -d "$install_directory/.git" ] || {
    printf '%s\n' "error: $install_directory exists but is not a Git checkout" >&2
    exit 1
  }
  origin="$(git -C "$install_directory" remote get-url origin)"
  [ "$origin" = "$repository" ] || {
    printf '%s\n' "error: $install_directory belongs to $origin, not $repository" >&2
    exit 1
  }
  [ -z "$(git -C "$install_directory" status --porcelain)" ] || {
    printf '%s\n' "error: $install_directory has local changes; preserve or discard them before updating" >&2
    exit 1
  }
  git -C "$install_directory" fetch --depth 1 origin "$ref"
  git -C "$install_directory" checkout --detach FETCH_HEAD
else
  mkdir -p "$(dirname "$install_directory")"
  git clone --depth 1 --branch "$ref" "$repository" "$install_directory"
fi

cd "$install_directory"
bun install --frozen-lockfile
bun run build:control-plane

if [ -n "$binary_directory" ]; then
  bun run install:local --dir "$binary_directory"
else
  bun run install:local
fi

printf '%s\n' "
integrations installed from $ref.

Start it at login (Linux or macOS):
  ii install

Or start it for this session:
  ii serve -d

Then open the control plane:
  ii dashboard"

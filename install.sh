#!/usr/bin/env sh
set -eu

repository="${INTEGRATIONS_REPOSITORY:-mokronos/integrations}"
binary_directory="${INTEGRATIONS_BIN_DIR:-$HOME/.local/bin}"
default_version="latest"
version="${INTEGRATIONS_VERSION:-$default_version}"
force=false

usage() {
  printf '%s\n' "Install a standalone integrations release from GitHub.

Usage:
  install.sh [--version <vX.Y.Z>] [--bin-dir <directory>] [--force]

Defaults:
  version:    $default_version
  binaries:   $binary_directory

The installer downloads a platform release, verifies its SHA-256 checksum,
and installs the integrations executable as both i and ii. Git, Bun, npm, and
a source checkout are not required.
"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { printf '%s\n' "error: --version requires a value" >&2; exit 1; }
      version="$2"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { printf '%s\n' "error: --bin-dir requires a value" >&2; exit 1; }
      binary_directory="$2"
      shift 2
      ;;
    --force)
      force=true
      shift
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

command -v curl >/dev/null 2>&1 || { printf '%s\n' "error: curl is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' "error: tar is required" >&2; exit 1; }
command -v install >/dev/null 2>&1 || { printf '%s\n' "error: install is required" >&2; exit 1; }

case "$(uname -s)" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) printf '%s\n' "error: only Linux and macOS are supported" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) architecture="x64" ;;
  arm64|aarch64) architecture="arm64" ;;
  *) printf '%s\n' "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="integrations-$platform-$architecture.tar.gz"
if [ "$version" = "latest" ]; then
  release_url="https://github.com/$repository/releases/latest/download"
else
  printf '%s\n' "$version" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || {
    printf '%s\n' "error: version must look like v0.2.0 or v0.2.4-nightly.20260921.4" >&2
    exit 1
  }
  release_url="https://github.com/$repository/releases/download/$version"
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

curl -fsSL --proto '=https' --tlsv1.2 "$release_url/$asset" -o "$temporary_directory/$asset"
curl -fsSL --proto '=https' --tlsv1.2 "$release_url/SHA256SUMS" -o "$temporary_directory/SHA256SUMS"

expected="$(awk -v asset="$asset" '$2 == asset { print $1; exit }' "$temporary_directory/SHA256SUMS")"
printf '%s\n' "$expected" | grep -Eq '^[0-9a-fA-F]{64}$' || {
  printf '%s\n' "error: release checksum for $asset is missing or invalid" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$temporary_directory/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$temporary_directory/$asset" | awk '{ print $1 }')"
else
  printf '%s\n' "error: sha256sum or shasum is required" >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { printf '%s\n' "error: checksum verification failed for $asset" >&2; exit 1; }

tar -xzf "$temporary_directory/$asset" -C "$temporary_directory"
[ -f "$temporary_directory/integrations" ] || { printf '%s\n' "error: release archive does not contain integrations" >&2; exit 1; }

mkdir -p "$binary_directory"
managed=false
if [ -f "$binary_directory/integrations" ] &&
  [ -L "$binary_directory/i" ] && [ "$(readlink "$binary_directory/i")" = "integrations" ] &&
  [ -L "$binary_directory/ii" ] && [ "$(readlink "$binary_directory/ii")" = "integrations" ]; then
  managed=true
fi
for target in "$binary_directory/integrations" "$binary_directory/i" "$binary_directory/ii"; do
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    printf '%s\n' "error: refusing to replace directory $target" >&2
    exit 1
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    [ "$managed" = true ] || [ "$force" = true ] || {
      printf '%s\n' "error: $target already exists; use --force to replace it" >&2
      exit 1
    }
  fi
done

install -m 755 "$temporary_directory/integrations" "$binary_directory/integrations.new"
mv "$binary_directory/integrations.new" "$binary_directory/integrations"
ln -sf integrations "$binary_directory/i"
ln -sf integrations "$binary_directory/ii"

case ":${PATH:-}:" in
  *:"$binary_directory":*) ;;
  *) printf '%s\n' "warning: $binary_directory is not on PATH" >&2 ;;
esac
for command_name in i ii; do
  installed="$binary_directory/$command_name"
  resolved="$(command -v "$command_name" 2>/dev/null || true)"
  if [ -n "$resolved" ] && [ "$resolved" != "$installed" ]; then
    printf '%s\n' "warning: PATH resolves $command_name to $resolved instead of $installed" >&2
  fi
done

printf '%s\n' "integrations $version installed in $binary_directory.

Start the local gateway at login:
  ii install

Or start it for this session:
  ii serve -d

Then open the control plane:
  ii dashboard"

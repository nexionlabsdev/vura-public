#!/usr/bin/env bash
# Packages a VS Code extension (packages/<name>) as a .vsix.
#
# core-extension and vura-dataverse-adapter are standalone (non-workspace) npm
# projects — their @vura-data-os/* dependencies resolve as normal npm
# packages, not workspace symlinks, so vsce can package them directly with
# no staging/tarball workaround needed.
#
# This script assumes packages/<name>/node_modules is already populated:
#   - Before the packages are published (or to test local changes to a
#     library package), run scripts/install-local-deps.sh <name> first.
#   - Once @vura-data-os/* is actually published, a plain `npm install`
#     inside packages/<name> is enough (that's what the release workflow does).
#
# Usage: scripts/package-extension.sh <package-name> [--target <vsce-target>] [-o <output.vsix>]
#   e.g. scripts/package-extension.sh core-extension --target darwin-arm64 -o dist/vura-core-darwin-arm64.vsix
#        scripts/package-extension.sh vura-dataverse-adapter -o dist/vura-dataverse-adapter.vsix

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -eq 0 || "$1" == --* ]]; then
  echo "Usage: $0 <package-name> [--target <vsce-target>] [-o <output.vsix>]" >&2
  exit 1
fi
PKG_NAME="$1"; shift
EXT_DIR="$ROOT_DIR/packages/$PKG_NAME"
if [[ ! -d "$EXT_DIR" ]]; then
  echo "No such package: packages/$PKG_NAME" >&2
  exit 1
fi
if [[ ! -d "$EXT_DIR/node_modules" ]]; then
  echo "packages/$PKG_NAME/node_modules is missing — run 'npm install' there" \
       "(or scripts/install-local-deps.sh $PKG_NAME before publishing) first." >&2
  exit 1
fi

VSCE_ARGS=()
OUT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) VSCE_ARGS+=(--target "$2"); shift 2 ;;
    -o) OUT_PATH="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "==> Compiling $PKG_NAME"
(cd "$EXT_DIR" && npm run compile)

echo "==> Packaging"
PACKAGE_ARGS=(package --no-git-tag-version --skip-license --allow-missing-repository "${VSCE_ARGS[@]+"${VSCE_ARGS[@]}"}")
if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  PACKAGE_ARGS+=(-o "$(cd "$(dirname "$OUT_PATH")" && pwd)/$(basename "$OUT_PATH")")
fi
(cd "$EXT_DIR" && npx --yes @vscode/vsce "${PACKAGE_ARGS[@]}")

if [[ -z "$OUT_PATH" ]]; then
  mkdir -p "$ROOT_DIR/dist"
  mv "$EXT_DIR"/*.vsix "$ROOT_DIR/dist/"
  echo "==> Output: $ROOT_DIR/dist/$(ls -t "$ROOT_DIR/dist" | head -1)"
fi

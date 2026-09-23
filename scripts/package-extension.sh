#!/usr/bin/env bash
# Packages a VS Code extension (packages/<name>) as a .vsix.
#
# core-extension is a standalone (non-workspace) npm project — its @vura-data-os/*
# dependencies resolve as normal npm packages, not workspace symlinks, so vsce
# can package them directly with no staging/tarball workaround needed.
#
# vura-dataverse and vura-sharepoint ARE npm workspace members. `vsce package`
# (without --no-dependencies) shells out to `npm list --production --parseable
# --depth=99999` to figure out which node_modules files to bundle — and npm,
# on seeing this dir is a workspace member, roots that listing at the *repo*
# root instead of packages/<name>, regardless of --workspaces=false or a
# local .npmrc (verified: npm keeps resolving "workspace root" from the
# nearest ancestor package.json's "workspaces" field either way). That extra
# "dependency" entry then gets glob'd from the repo root with only
# `<repo-root>/node_modules/**` excluded, which sweeps up
# packages/<name>/node_modules a second time and vsce's own duplicate-path
# check rejects the resulting VSIX. So for these packages this script stages
# a full copy of the (already-built) extension outside the monorepo tree —
# where no ancestor package.json declares it as a workspace member — and
# runs `vsce package` there instead.
#
# This script assumes packages/<name>/node_modules is already populated:
#   - Before the packages are published (or to test local changes to a
#     library package), run scripts/install-local-deps.sh <name> first.
#   - Once @vura-data-os/* is actually published, a plain `npm install`
#     inside packages/<name> is enough (that's what the release workflow does).
#
# Usage: scripts/package-extension.sh <package-name> [--target <vsce-target>] [-o <output.vsix>]
#   e.g. scripts/package-extension.sh core-extension --target darwin-arm64 -o dist/vura-studio-lite-darwin-arm64.vsix

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -eq 0 || "$1" == --* ]]; then
  echo "Usage: $0 <package-name> [--target <vsce-target>] [-o <output.vsix>]" >&2
  exit 1
fi
PKG_NAME="$1"; shift
EXT_DIR="$ROOT_DIR/packages/$PKG_NAME"
if [[ ! -d "$EXT_DIR" ]]; then
  if [[ -d "$ROOT_DIR/packages/core/$PKG_NAME" ]]; then
    PKG_NAME="core/$PKG_NAME"
    EXT_DIR="$ROOT_DIR/packages/$PKG_NAME"
  elif [[ -d "$ROOT_DIR/packages/connectors/$PKG_NAME" ]]; then
    PKG_NAME="connectors/$PKG_NAME"
    EXT_DIR="$ROOT_DIR/packages/$PKG_NAME"
  else
    echo "No such package: packages/$PKG_NAME" >&2
    exit 1
  fi
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
    --pre-release) VSCE_ARGS+=(--pre-release); shift ;;
    -o) OUT_PATH="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

echo "==> Ensuring native vendor binaries are synced"
node "$ROOT_DIR/scripts/copy-duckdb-vendor.js"

echo "==> Compiling $PKG_NAME"
(cd "$EXT_DIR" && npm run compile)

# See banner comment: workspace members need `vsce package` run outside the
# monorepo tree so npm's ancestor-workspace detection can't kick in.
IS_WORKSPACE_MEMBER=""
if grep -q "\"packages/$PKG_NAME\"" "$ROOT_DIR/package.json"; then
  IS_WORKSPACE_MEMBER=1
fi

if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
  PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vura-ext-stage.XXXXXX")"
  echo "==> Staging packages/$PKG_NAME outside the monorepo for packaging"
  cp -R "$EXT_DIR/." "$PACKAGE_DIR/"
else
  PACKAGE_DIR="$EXT_DIR"
fi

echo "==> Packaging"
PACKAGE_ARGS=(package --no-git-tag-version --skip-license --allow-missing-repository "${VSCE_ARGS[@]+"${VSCE_ARGS[@]}"}")
if [[ -n "$OUT_PATH" ]]; then
  mkdir -p "$(dirname "$OUT_PATH")"
  RESOLVED_OUT="$(node -e 'const path = require("path"); console.log(path.resolve(process.argv[1]))' "$OUT_PATH")"
  PACKAGE_ARGS+=(-o "$RESOLVED_OUT")
fi

BACKUP="$(mktemp "${TMPDIR:-/tmp}/vura-ext-backup.XXXXXX")"
cp "$PACKAGE_DIR/package.json" "$BACKUP"
cleanup_ext() {
  if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
    # $PACKAGE_DIR is a disposable copy outside the repo — discard it entirely.
    rm -rf "$PACKAGE_DIR"
  else
    # $PACKAGE_DIR is the real, committed packages/$PKG_NAME — restore its
    # package.json (the rename/strip below mutates it in place).
    cp "$BACKUP" "$PACKAGE_DIR/package.json"
  fi
  rm -f "$BACKUP"
}
trap cleanup_ext EXIT

node -e '
  const fs = require("fs");
  const pkgPath = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let modified = false;
  if (pkg.name && pkg.name.includes("/")) {
    pkg.name = pkg.name.split("/").pop();
    modified = true;
  }
  if (pkg.files) {
    delete pkg.files;
    modified = true;
  }
  if (pkg.version && pkg.version.includes("-")) {
    pkg.version = pkg.version.split("-")[0];
    modified = true;
  }
  if (modified) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
' "$PACKAGE_DIR/package.json"

MINOR="$(node -e 'const pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(parseInt((pkg.version || "").split(".")[1] || "0", 10));' "$PACKAGE_DIR/package.json")"
if [[ $((MINOR % 2)) -ne 0 ]]; then
  has_prerelease=false
  for arg in "${PACKAGE_ARGS[@]}"; do
    if [[ "$arg" == "--pre-release" ]]; then has_prerelease=true; break; fi
  done
  if [[ "$has_prerelease" == false ]]; then
    echo "==> Odd minor version ($MINOR) detected: marking as --pre-release"
    PACKAGE_ARGS+=(--pre-release)
  fi
fi

(cd "$PACKAGE_DIR" && npx --yes @vscode/vsce "${PACKAGE_ARGS[@]}")

if [[ -z "$OUT_PATH" ]]; then
  mkdir -p "$ROOT_DIR/dist"
  mv "$PACKAGE_DIR"/*.vsix "$ROOT_DIR/dist/"
  echo "==> Output: $ROOT_DIR/dist/$(ls -t "$ROOT_DIR/dist" | head -1)"
fi

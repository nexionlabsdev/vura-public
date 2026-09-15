#!/usr/bin/env bash
# Installs a package's own dependencies for local building/testing/packaging,
# so packages/<name>/node_modules ends up with a real, self-contained copy of
# everything it requires at runtime — not just whatever the npm workspace
# hoisted to the repo root.
#
# core-extension is deliberately NOT an npm workspace member (see root
# package.json) — it depends on @vura-data-os/* like any real npm consumer
# would, resolved from the registry once those packages are published.
# Before that first publish (or while testing local changes to a library
# package), `npm install` inside it would 404 trying to fetch an
# @vura-data-os/* version that doesn't exist on the registry yet.
#
# vura-dataverse and vura-sharepoint ARE npm workspace members, which is fine
# for compiling (Node's module resolution walks up to the hoisted root
# node_modules) but not for packaging: `vsce package` only looks inside the
# extension's own directory, and the installed .vsix is extracted standalone
# outside the monorepo, so anything only present in the *root* node_modules
# (which is where a plain `npm install` run from inside a workspace member
# lands its deps — see below) is missing at runtime. So for those packages
# this script stages the install in a directory copy outside the monorepo
# tree, where npm can't detect the ancestor `workspaces` field and hoist
# there instead, then copies the resulting node_modules back.
#
# This script: temporarily strips the @vura-data-os/* entries so the normal
# install can succeed for everything else, restores the real package.json
# immediately after, then overlays fresh tarballs of the local library
# packages via `npm install --no-save` — which populates node_modules
# without ever touching the committed package.json/package-lock.json.
#
# Usage: scripts/install-local-deps.sh <group>/<package-name>
#   e.g. scripts/install-local-deps.sh core/core-extension

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="${1:?Usage: $0 <group>/<package-name>}"
PKG_DIR="$ROOT_DIR/packages/$PKG_NAME"
PKG_JSON="$PKG_DIR/package.json"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "No such package: packages/$PKG_NAME" >&2
  exit 1
fi

# Is $PKG_NAME listed in the root package.json's "workspaces" globs? If so, a
# plain `npm install` run from inside $PKG_DIR hoists everything to the repo
# root's node_modules instead of $PKG_DIR/node_modules, so the install below
# needs to happen in an isolated copy instead (see banner comment above).
IS_WORKSPACE_MEMBER=""
if node -e "
  const ws = require('$ROOT_DIR/package.json').workspaces || [];
  process.exit(ws.includes('packages/$PKG_NAME') ? 0 : 1);
"; then
  IS_WORKSPACE_MEMBER=1
fi

if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
  INSTALL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vura-addon-stage.XXXXXX")"
  cp "$PKG_JSON" "$INSTALL_DIR/package.json"
else
  INSTALL_DIR="$PKG_DIR"
fi

TARBALL_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vura-local-deps.XXXXXX")"
BACKUP="$(mktemp "${TMPDIR:-/tmp}/vura-pkg-backup.XXXXXX")"
cp "$PKG_JSON" "$BACKUP"

cleanup() {
  # Always ensure the real package.json (with @vura-data-os/* ranges intact)
  # ends up back in place — including if something fails after we stripped
  # it but before the inline restore below runs. Harmless no-op if it's
  # already restored.
  cp "$BACKUP" "$PKG_JSON"
  rm -rf "$TARBALL_DIR"
  rm -f "$BACKUP"
  if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
    rm -rf "$INSTALL_DIR"
  fi
}
trap cleanup EXIT

LIB_PACKAGES=(core-sdk vura-io vura-odata-sync-core vura-dataverse-sync-core vura-runner)

# Bare lib name -> its group-qualified path under packages/. Bash 3.2 (macOS's
# default /bin/bash) has no associative arrays, so this is a case statement
# rather than a `declare -A` map.
lib_path() {
  case "$1" in
    core-sdk) echo "core/core-sdk" ;;
    vura-io) echo "core/vura-io" ;;
    vura-odata-sync-core) echo "core/vura-odata-sync-core" ;;
    vura-runner) echo "core/vura-runner" ;;
    vura-dataverse-sync-core) echo "connectors/vura-dataverse-sync-core" ;;
    *) echo "$1" ;;
  esac
}

echo "==> Building library packages"
(cd "$ROOT_DIR" && npm install --no-audit --no-fund)
for lib in "${LIB_PACKAGES[@]}"; do
  echo "  -- $lib"
  (cd "$ROOT_DIR/packages/$(lib_path "$lib")" && npm run compile)
done

echo "==> Installing $PKG_NAME's own dependencies (excluding local @vura-data-os/* siblings for now)"
node "$ROOT_DIR/scripts/lib/strip-vura-deps.js" "$([[ -n "$IS_WORKSPACE_MEMBER" ]] && echo "$INSTALL_DIR/package.json" || echo "$PKG_JSON")"
(cd "$INSTALL_DIR" && npm install --no-audit --no-fund)

# Restore the real package.json (with the @vura-data-os/* ranges intact) —
# the tarball overlay below uses --no-save, so it never needs the stripped copy.
cp "$BACKUP" "$PKG_JSON"
if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
  cp "$BACKUP" "$INSTALL_DIR/package.json"
fi

echo "==> Overlaying local @vura-data-os/* siblings actually used by $PKG_NAME"
# One single `npm install --no-save` call with every applicable tarball, not
# one call per package: npm reconciles the *whole* dependency tree against
# package.json on every install, tarball or not — installing them one at a
# time means each intermediate call still sees an unsatisfied @vura-data-os/*
# range for whichever sibling hasn't been overlaid yet, and 404s trying to
# fetch it from the registry.
TARBALL_PATHS=()
for lib in "${LIB_PACKAGES[@]}"; do
  if [[ "$lib" == "vura-io" ]]; then
    full_name="@vura/io"
  else
    full_name="@vura-data-os/$lib"
  fi
  echo "  -- $full_name"
  tgz_name="$(cd "$ROOT_DIR/packages/$(lib_path "$lib")" && npm pack --silent --pack-destination "$TARBALL_DIR")"
  TARBALL_PATHS+=("$TARBALL_DIR/$tgz_name")
done

if [[ ${#TARBALL_PATHS[@]} -gt 0 ]]; then
  if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
    # $INSTALL_DIR is a disposable staging copy (never copied back to
    # $PKG_DIR, only its node_modules and package-lock.json are), so unlike
    # the core-extension case there's no committed package.json to protect
    # here — let npm actually record the tarballs with --save. Without that,
    # `npm install --no-save` leaves package-lock.json stale relative to the
    # node_modules it just wrote, which makes vsce's own `npm list
    # --production --parseable` (run later, against packages/$PKG_NAME) misread
    # the tree and double-count every file when packaging.
    (cd "$INSTALL_DIR" && npm install --no-audit --no-fund "${TARBALL_PATHS[@]}")
  else
    (cd "$INSTALL_DIR" && npm install --no-save --no-audit --no-fund "${TARBALL_PATHS[@]}")
  fi
fi

if [[ -n "$IS_WORKSPACE_MEMBER" ]]; then
  echo "==> Copying staged node_modules back into packages/$PKG_NAME"
  rm -rf "$PKG_DIR/node_modules"
  mkdir -p "$PKG_DIR/node_modules"
  cp -R "$INSTALL_DIR/node_modules/." "$PKG_DIR/node_modules/"
  # vsce's dependency-bundling step (plain `vsce package`, no --no-dependencies)
  # needs a package-lock.json alongside node_modules to correctly resolve which
  # files belong to which package — without one it double-counts every file.
  # This lockfile is packaging-only scaffolding for a workspace member (the
  # root package-lock.json is what's actually committed), so it's gitignored.
  cp "$INSTALL_DIR/package-lock.json" "$PKG_DIR/package-lock.json"
fi

node "$ROOT_DIR/scripts/copy-duckdb-vendor.js"

echo "==> Done: packages/$PKG_NAME/node_modules is ready to build"

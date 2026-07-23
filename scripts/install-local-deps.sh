#!/usr/bin/env bash
# Installs a non-workspace package's (core-extension, vura-dataverse-adapter) own
# dependencies for local building/testing.
#
# core-extension and vura-dataverse-adapter are deliberately NOT npm workspace
# members (see root package.json) — they depend on @vura-data-os/* like any
# real npm consumer would, resolved from the registry once those packages are
# published. Before that first publish (or while testing local changes to a
# library package), `npm install` inside either of them would 404 trying to
# fetch an @vura-data-os/* version that doesn't exist on the registry yet.
#
# This script: temporarily strips the @vura-data-os/* entries so the normal
# install can succeed for everything else, restores the real package.json
# immediately after, then overlays fresh tarballs of the local library
# packages via `npm install --no-save` — which populates node_modules
# without ever touching the committed package.json/package-lock.json.
#
# Usage: scripts/install-local-deps.sh <package-name>
#   e.g. scripts/install-local-deps.sh core-extension

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="${1:?Usage: $0 <package-name>}"
PKG_DIR="$ROOT_DIR/packages/$PKG_NAME"
PKG_JSON="$PKG_DIR/package.json"

if [[ ! -f "$PKG_JSON" ]]; then
  echo "No such package: packages/$PKG_NAME" >&2
  exit 1
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
}
trap cleanup EXIT

LIB_PACKAGES=(core-sdk vura-dataverse-sync-core vura-runner vura-dataverse-runner-plugin)

echo "==> Building library packages"
(cd "$ROOT_DIR" && npm install --no-audit --no-fund)
for lib in "${LIB_PACKAGES[@]}"; do
  echo "  -- $lib"
  (cd "$ROOT_DIR/packages/$lib" && npm run compile)
done

echo "==> Installing $PKG_NAME's own dependencies (excluding local @vura-data-os/* siblings for now)"
node "$ROOT_DIR/scripts/lib/strip-vura-deps.js" "$PKG_JSON"
(cd "$PKG_DIR" && npm install --no-audit --no-fund)

# Restore the real package.json (with the @vura-data-os/* ranges intact) —
# the tarball overlay below uses --no-save, so it never needs the stripped copy.
cp "$BACKUP" "$PKG_JSON"

echo "==> Overlaying local @vura-data-os/* siblings actually used by $PKG_NAME"
# One single `npm install --no-save` call with every applicable tarball, not
# one call per package: npm reconciles the *whole* dependency tree against
# package.json on every install, tarball or not — installing them one at a
# time means each intermediate call still sees an unsatisfied @vura-data-os/*
# range for whichever sibling hasn't been overlaid yet, and 404s trying to
# fetch it from the registry.
TARBALL_PATHS=()
for lib in "${LIB_PACKAGES[@]}"; do
  full_name="@vura-data-os/$lib"
  has_dep="$(node "$ROOT_DIR/scripts/lib/has-dep.js" "$PKG_JSON" "$full_name")"
  [[ "$has_dep" == "yes" ]] || continue

  echo "  -- $full_name"
  tgz_name="$(cd "$ROOT_DIR/packages/$lib" && npm pack --silent --pack-destination "$TARBALL_DIR")"
  TARBALL_PATHS+=("$TARBALL_DIR/$tgz_name")
done

if [[ ${#TARBALL_PATHS[@]} -gt 0 ]]; then
  (cd "$PKG_DIR" && npm install --no-save --no-audit --no-fund "${TARBALL_PATHS[@]}")
fi

echo "==> Done: packages/$PKG_NAME/node_modules is ready to build"

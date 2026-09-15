#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CATALOG_FILE="${ROOT_DIR}/docker/plugins-catalog.json"

MODE=""
OUT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --mode=*) MODE="${arg#--mode=}" ;;
    --out-dir=*) OUT_DIR="${arg#--out-dir=}" ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "$MODE" ] || [ -z "$OUT_DIR" ]; then
  echo "Usage: $0 --mode=npm|vsix --out-dir=<directory>" >&2
  exit 1
fi

if [ ! -f "$CATALOG_FILE" ]; then
  echo "Error: Catalog file missing at $CATALOG_FILE" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# Connectors live under packages/connectors/<key> (see docker/plugins-catalog.json's
# "connectors" section — core libraries and Docker images are catalogued
# alongside it but aren't "plugins" this script stages/packages).
CONNECTORS=$(node -e '
  const fs = require("fs");
  const catalog = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(JSON.stringify(catalog.connectors || {}));
' "$CATALOG_FILE")

plugin_keys=$(node -e '
  const connectors = JSON.parse(process.argv[1]);
  console.log(Object.keys(connectors).join(" "));
' "$CONNECTORS")

for key in $plugin_keys; do
  pkg_dir="$ROOT_DIR/packages/connectors/$key"
  if [ ! -d "$pkg_dir" ]; then
    echo "Error: Package directory $pkg_dir missing for catalog key $key" >&2
    exit 1
  fi

  if [ "$MODE" = "npm" ]; then
    echo "==> Staging NPM plugin: $key -> $OUT_DIR/$key"
    mkdir -p "$OUT_DIR/$key"
    cp -r "$pkg_dir"/* "$OUT_DIR/$key/"
  elif [ "$MODE" = "vsix" ]; then
    vsix_name=$(node -e '
      const connectors = JSON.parse(process.argv[1]);
      console.log(connectors[process.argv[2]].vsixName);
    ' "$CONNECTORS" "$key")
    echo "==> Packaging VSIX plugin: $key -> $OUT_DIR/$vsix_name"
    bash "$ROOT_DIR/scripts/install-local-deps.sh" "connectors/$key"
    bash "$ROOT_DIR/scripts/package-extension.sh" "connectors/$key" -o "$OUT_DIR/$vsix_name"
  else
    echo "Unknown mode: $MODE" >&2
    exit 1
  fi
done

echo "Plugin build completed successfully for mode: $MODE"

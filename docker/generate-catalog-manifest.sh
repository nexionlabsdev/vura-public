#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CATALOG_FILE="${ROOT_DIR}/docker/plugins-catalog.json"

if [ ! -f "${CATALOG_FILE}" ]; then
  echo "Error: catalog file not found at ${CATALOG_FILE}" >&2
  exit 1
fi

missing=0

# Read keys from JSON
plugin_keys=$(node -e '
  const fs = require("fs");
  const catalog = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  console.log(Object.keys(catalog).join(" "));
' "${CATALOG_FILE}")

for plugin in ${plugin_keys}; do
  if [ ! -d "${ROOT_DIR}/packages/${plugin}" ]; then
    echo "Error: catalog entry '${plugin}' does not exist in ${ROOT_DIR}/packages/" >&2
    missing=1
  else
    echo "Catalog entry '${plugin}' verified in packages/${plugin}."
  fi
done

if [ ${missing} -ne 0 ]; then
  echo "Catalog verification failed: missing workspace packages." >&2
  exit 1
fi

echo "Catalog manifest check passed successfully."

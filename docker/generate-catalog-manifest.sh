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

# Reverse check: scan packages/*/src/index.ts for provider implementations
# (packages exporting activateVsCodeProvider or implementing IVuraProvider)
# and ensure they are listed in plugins-catalog.json.
reverse_missing=0
for index_file in "${ROOT_DIR}"/packages/*/src/index.ts; do
  [ -f "${index_file}" ] || continue
  pkg_name=$(basename "$(dirname "$(dirname "${index_file}")")")

  [ "${pkg_name}" = "core-sdk" ] && continue
  if grep -qE "activateVsCodeProvider\(|implements.*IVuraProvider" "${index_file}"; then
    if ! echo " ${plugin_keys} " | grep -q " ${pkg_name} "; then
      echo "Error: Workspace package '${pkg_name}' implements IVuraProvider/activateVsCodeProvider in src/index.ts but is missing from ${CATALOG_FILE}" >&2
      reverse_missing=1
    else
      echo "Reverse check verified: '${pkg_name}' provider is present in catalog."
    fi
  fi
done

if [ ${reverse_missing} -ne 0 ]; then
  echo "Catalog verification failed: workspace providers missing from catalog." >&2
  exit 1
fi

echo "Catalog manifest check passed successfully."

#!/usr/bin/env bash
set -euo pipefail

CATALOG_PATH="/opt/vura/plugins-catalog.json"
APP_DIR="/opt/vura/app"

RESOLVED_PLUGINS=""
NEW_ARGS=()

for arg in "$@"; do
    case "$arg" in
        --plugins=*)
            RESOLVED_PLUGINS="${arg#--plugins=}"
            ;;
        *)
            NEW_ARGS+=("$arg")
            ;;
    esac
done

if [ -z "$RESOLVED_PLUGINS" ]; then
    RESOLVED_PLUGINS="${VURA_PLUGINS:-}"
fi

if [ -n "$RESOLVED_PLUGINS" ] && [ -f "$CATALOG_PATH" ]; then
    # Validate plugins against catalog and link valid ones into app node_modules
    LOADED_PLUGINS_JSON=$(node -e '
        const fs = require("fs");
        const path = require("path");
        const catalogPath = process.argv[1];
        const rawPlugins = process.argv[2] || "";
        const appDir = process.argv[3];

        const pluginList = rawPlugins.split(",").map(s => s.trim()).filter(Boolean);
        const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        const activePackages = [];

        for (const pluginName of pluginList) {
            if (!catalog[pluginName]) {
                console.error(`Warning: unknown plugin "${pluginName}" requested. Skipping.`);
                continue;
            }

            const info = catalog[pluginName];
            const npmPackage = info.npmPackage;
            const srcCatalogPath = path.join("/opt/vura/plugins-catalog", pluginName);
            const targetPkgPath = path.join(appDir, "node_modules", npmPackage);

            if (fs.existsSync(srcCatalogPath)) {
                fs.mkdirSync(path.dirname(targetPkgPath), { recursive: true });
                try {
                    if (fs.existsSync(targetPkgPath)) {
                        fs.rmSync(targetPkgPath, { recursive: true, force: true });
                    }
                    fs.symlinkSync(srcCatalogPath, targetPkgPath, "dir");
                } catch (e) {
                    // Fallback to copy if symlink fails
                    fs.cpSync(srcCatalogPath, targetPkgPath, { recursive: true });
                }
                activePackages.push(npmPackage);
            } else {
                console.error(`Warning: plugin catalog directory for "${pluginName}" not found at ${srcCatalogPath}. Skipping.`);
            }
        }
        console.log(JSON.stringify(activePackages));
    ' "$CATALOG_PATH" "$RESOLVED_PLUGINS" "$APP_DIR")

    if [ "$LOADED_PLUGINS_JSON" != "[]" ] && [ -n "$LOADED_PLUGINS_JSON" ]; then
        vura-runner config set vura.plugins "$LOADED_PLUGINS_JSON" || true
    fi
fi

# Ensure VURA_HOME exists
mkdir -p "${VURA_HOME:-/data/.vura}"

exec vura-runner serve --port "${VURA_PORT:-3000}" --notebooks-dir "${VURA_NOTEBOOKS_DIR:-/notebooks}" "${NEW_ARGS[@]}"

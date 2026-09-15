#!/usr/bin/env bash
set -euo pipefail

CATALOG_PATH="/opt/vura/plugins-catalog.json"
PLUGINS_DIR="/opt/vura/plugins-catalog"

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
    INSTALLED_EXTS=$(code-server --list-extensions 2>/dev/null || true)

    node -e '
        const fs = require("fs");
        const path = require("path");
        const { execSync } = require("child_process");

        const catalogPath = process.argv[1];
        const rawPlugins = process.argv[2] || "";
        const pluginsDir = process.argv[3];
        const installedExts = process.argv[4] || "";

        const pluginList = rawPlugins.split(",").map(s => s.trim()).filter(Boolean);
        const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
        const connectors = catalog.connectors || {};

        for (const pluginName of pluginList) {
            if (!connectors[pluginName]) {
                console.error(`Warning: unknown plugin "${pluginName}" requested. Skipping.`);
                continue;
            }

            const info = connectors[pluginName];
            const vsixName = info.vsixName;
            const vsixPath = path.join(pluginsDir, vsixName);

            // Check if extension is already installed
            const extSearch = pluginName.toLowerCase();
            const isInstalled = installedExts.toLowerCase().split("\n").some(line => line.includes(extSearch));

            if (isInstalled) {
                console.log(`Plugin extension ${vsixName} is already installed.`);
                continue;
            }

            if (fs.existsSync(vsixPath)) {
                console.log(`Installing plugin extension ${vsixName}...`);
                try {
                    execSync(`code-server --install-extension "${vsixPath}"`, { stdio: "inherit" });
                } catch (err) {
                    console.error(`Warning: failed to install extension "${vsixName}": ${err.message}`);
                }
            } else {
                console.error(`Warning: .vsix file for "${pluginName}" not found at ${vsixPath}. Skipping.`);
            }
        }
    ' "$CATALOG_PATH" "$RESOLVED_PLUGINS" "$PLUGINS_DIR" "$INSTALLED_EXTS"
fi

AUTH="${AUTH:-password}"
mkdir -p "${VURA_WORKSPACE_DIR:-/home/coder/project}"

exec code-server --bind-addr 0.0.0.0:8080 --auth "${AUTH}" "${VURA_WORKSPACE_DIR:-/home/coder/project}" "${NEW_ARGS[@]}"

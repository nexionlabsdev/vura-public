#!/usr/bin/env bash
set -euo pipefail

CATALOG_PATH="/opt/vura/plugins-catalog.json"
PLUGINS_DIR="/opt/vura/plugins-catalog"
CORE_VSIX="/opt/vura/vura-studio-lite.vsix"

# /home/coder/.local/share/code-server is a persistent named volume, so an
# extension installed there on a previous run stays put even after this image
# is rebuilt with a newer vura-studio-lite — without --force, code-server sees it's
# "already installed" and silently skips it, leaving the container running a
# stale bundled extension indefinitely. Reinstalling from the image's own
# vsix on every start makes the image the single source of truth for it.
if [ -f "$CORE_VSIX" ]; then
    code-server --install-extension "$CORE_VSIX" --force
fi

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

    python3 -c '
import sys, json, os, subprocess

catalog_path = sys.argv[1]
raw_plugins = sys.argv[2] if len(sys.argv) > 2 else ""
plugins_dir = sys.argv[3]
installed_exts = sys.argv[4] if len(sys.argv) > 4 else ""

plugin_list = [s.strip() for s in raw_plugins.split(",") if s.strip()]
with open(catalog_path, "r", encoding="utf-8") as f:
    catalog = json.load(f)
connectors = catalog.get("connectors", {})
installed_lines = installed_exts.lower().splitlines()

for plugin_name in plugin_list:
    if plugin_name not in connectors:
        sys.stderr.write(f"Warning: unknown plugin \"{plugin_name}\" requested. Skipping.\n")
        continue

    info = connectors[plugin_name]
    vsix_name = info.get("vsixName", "")
    vsix_path = os.path.join(plugins_dir, vsix_name)

    ext_search = plugin_name.lower()
    is_installed = any(ext_search in line for line in installed_lines)

    if is_installed:
        print(f"Plugin extension {vsix_name} is already installed.")
        continue

    if os.path.exists(vsix_path):
        print(f"Installing plugin extension {vsix_name}...")
        try:
            subprocess.run(["code-server", "--install-extension", vsix_path], check=True)
        except Exception as err:
            sys.stderr.write(f"Warning: failed to install extension \"{vsix_name}\": {err}\n")
    else:
        sys.stderr.write(f"Warning: .vsix file for \"{plugin_name}\" not found at {vsix_path}. Skipping.\n")
' "$CATALOG_PATH" "$RESOLVED_PLUGINS" "$PLUGINS_DIR" "$INSTALLED_EXTS"
fi

AUTH="${AUTH:-password}"
mkdir -p "${VURA_WORKSPACE_DIR:-/home/coder/project}"

exec code-server --bind-addr 0.0.0.0:8080 --auth "${AUTH}" "${VURA_WORKSPACE_DIR:-/home/coder/project}" "${NEW_ARGS[@]}"

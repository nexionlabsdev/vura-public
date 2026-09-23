# vura-web-studio

Browser-based [code-server](https://github.com/coder/code-server) preloaded with **VURA Studio** (`vura-studio-lite`), the VS Code extension that renders `.flownb` notebooks — SQL, Python, JavaScript, and HTML cells backed by an embedded DuckDB engine. Open a browser, get a full VURA notebook environment, no local install.

VURA is the open-source core of a platform that replaces a fragmented stack of integration middleware, reporting tools, and compliance software with a single engineer-native workflow. This image is the browser-based editor; `vura-runner` is the headless CLI/HTTP kernel for running notebooks without an editor.

## Quick start

```bash
docker run -d \
  -p 8080:8080 \
  -e PASSWORD=changeme \
  -v $(pwd)/project:/home/coder/project \
  -v vura-data:/data/.vura \
  nexionlabsdev/vura-web-studio:latest
```

Then open `http://localhost:8080` and log in with the password you set.

## Configuration

| Variable / flag | Default | Description |
|---|---|---|
| `PASSWORD` | *(required)* | code-server login password. |
| `VURA_WORKSPACE_DIR` | `/home/coder/project` | Workspace folder opened in the editor. Mount a volume here to persist your notebooks. |
| `VURA_HOME` | `/data/.vura` | Persistent state directory (connection profiles, history). Mount a volume here to survive container restarts. |
| `VURA_PLUGINS` (env) or `--plugins=` (CLI arg) | none | Comma-separated list of connector Add-on extensions to install on startup, e.g. `vura-dataverse,vura-sharepoint`. |

## Available connector Add-ons

Load any of these via `VURA_PLUGINS` / `--plugins=`:

- `vura-dataverse` — Dynamics 365 / Microsoft Dataverse OData connector
- `vura-sharepoint` — SharePoint Lists OData sync + document library import/export
- `vura-onedrive` — OneDrive (Microsoft Graph) import/export
- `vura-googledrive` — Google Drive import/export
- `vura-s3` — Amazon S3 import/export
- `vura-local` — Local / mapped folder import/export

Example:

```bash
docker run -d -p 8080:8080 -e PASSWORD=changeme -e VURA_PLUGINS=vura-dataverse nexionlabsdev/vura-web-studio:latest
```

Each connector is installed as a separate VS Code extension on container start and shows up in the Connections sidebar.

## Source & license

Source: [github.com/nexionlabsdev/vura-public](https://github.com/nexionlabsdev/vura-public) (`docker/vura-web-studio/Dockerfile`).
Licensed under AGPL-3.0. For a commercial license without AGPL's obligations, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

# vura-runner

Headless CLI/HTTP server for executing [VURA](https://github.com/nexionlabsdev/vura-public) `.flownb` notebooks — SQL, Python, JavaScript, and HTML cells backed by an embedded DuckDB engine — outside of VS Code. Ingest from any source, transform with code, and deliver to files, databases, APIs, or stakeholder reports, all from one notebook, headlessly.

VURA is the open-source core of a platform that replaces a fragmented stack of integration middleware, reporting tools, and compliance software with a single engineer-native workflow. This image is the standalone kernel; `vura-web-studio` is the browser-based VS Code equivalent with the notebook editor UI.

## Quick start

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/notebooks:/notebooks \
  -v vura-data:/data/.vura \
  nexionlabsdev/vura-runner:latest
```

Then execute a notebook already in `/notebooks` via the HTTP API, or check it's up:

```bash
curl http://localhost:3000/api/flows
```

## Configuration

| Variable / flag | Default | Description |
|---|---|---|
| `VURA_PORT` | `3000` | HTTP server port. |
| `VURA_NOTEBOOKS_DIR` | `/notebooks` | Directory scanned for `.flownb` notebooks. |
| `VURA_HOME` | `/data/.vura` | Persistent state directory (connection profiles, history). Mount a volume here to survive container restarts. |
| `VURA_PLUGINS` (env) or `--plugins=` (CLI arg) | none | Comma-separated list of connector Add-ons to load on startup, e.g. `vura-dataverse,vura-sharepoint`. |

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
docker run -d -p 3000:3000 -e VURA_PLUGINS=vura-dataverse,vura-s3 nexionlabsdev/vura-runner:latest
```

## Source & license

Source: [github.com/nexionlabsdev/vura-public](https://github.com/nexionlabsdev/vura-public) (`docker/vura-runner/Dockerfile`).
Licensed under AGPL-3.0. For a commercial license without AGPL's obligations, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

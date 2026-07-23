# VURA Studio

The core VS Code extension for [VURA](https://github.com/nexionlabsdev/vura-public) — an engineer-native notebook platform uniting SQL, Python, JavaScript, and HTML in one `.flownb` notebook, backed by an embedded DuckDB/Parquet bridge.

This is the **kernel** in VURA's micro-kernel architecture: it renders `.flownb` notebooks, runs SQL/Python/JavaScript/HTML cells, and exposes a `ProviderRegistry` (from `@vura-data-os/core-sdk`) that separate Add-on extensions — like `vura-dataverse-adapter` — register into to add their own magic commands.

## Features

- **Polyglot notebook cells** — SQL (multi-auth TDS/MSSQL), Python and JavaScript (via gRPC sidecars sharing data through DuckDB/Parquet, zero-copy), HTML (Vega-Lite charts, PDF export), and `vura-terminal` for `!magic commands`.
- **Connection management** — SQL connection profiles across four auth modes (Service Principal, Device Code, SQL Login, Windows Auth), stored in VS Code's `globalState`/`SecretStorage`.
- **Auto-Schema Flattener** — ingest nested JSON/CSV/Excel/Parquet files directly into relational DuckDB tables via `!ingest-file`.
- **Query history and schema explorer** — dedicated sidebar views for SQL connections.
- **Cell output export** — export or copy cell outputs, export HTML/graph cells to PDF.

## Requirements

- VS Code 1.80+
- Node.js 18+
- Python 3.10+ (for Python cells)

## Install

This repo doesn't publish to the VS Code Marketplace — package and install locally:

```bash
npm install
cd packages/core-extension
npm run compile
npx vsce package
code --install-extension vura-core-0.0.1.vsix
```

## Getting started

Open VS Code, create a `.flownb` file, and add a cell per language to exercise the polyglot bridge — see the main repo's [Development Playbook](https://github.com/nexionlabsdev/vura-public/blob/main/docs/DEVELOPMENT_PLAYBOOK.md) for the full golden-path walkthrough, and [Architecture & IPC](https://github.com/nexionlabsdev/vura-public/blob/main/docs/architecture.md) for how the DuckDB/Parquet bridge works under the hood.

To extend it with your own Add-on (a custom connector, a new magic command), see the [SDK Guide](https://github.com/nexionlabsdev/vura-public/blob/main/docs/sdk_guide.md) — the same Add-on contract also runs, unmodified, in the standalone `vura-runner` CLI.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

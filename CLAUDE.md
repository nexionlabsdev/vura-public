# VURA Developer & Agent Playbook

This document is the unified guide to working on the VURA open-source core codebase.

## Repository Overview

VURA is organized as a TypeScript & Python monorepo using npm workspaces:

- **`packages/core/core-sdk`** — Shared Add-on contract interfaces (`IVuraProvider`, `ProviderRegistry`, `IVuraEnvironment`, `FlownbCell`, `ICellLogger`).
- **`packages/core/vura-runner`** — The CLI notebook runner and engine host.
- **`packages/core/core-extension`** — The VS Code Extension Host interface.
- **`packages/connectors/vura-dataverse`** — Unified Dataverse integration package supporting both CLI and VS Code Extension Host execution paths (CLI and VS Code extension integrations for Dataverse were unified into a single `packages/connectors/vura-dataverse` package per Phase 9d — the previously separate `vura-dataverse-adapter` and `vura-dataverse-runner-plugin` packages no longer exist).
- **`packages/connectors/vura-dataverse-sync-core`** — Host-agnostic Dataverse OData v4 `$batch` sync engine.
- **`packages/core/vura-io`** / **`packages/core/vura-io-py`** — Data abstraction library for Node and Python sidecars. Partitioned tables use a tiny fixed-size `manifest.json` summary summary (`version`, `tableName`, `rowCount`, `compacted`, `nextPartIndex`, `schema`) alongside an append-only `manifest-parts.jsonl` log.

## Development Workflow

### Building Packages
```bash
npm run compile --workspaces
```

### Running Tests
```bash
npm test --workspace=<package-name>
```

### Building VS Code Extension
```bash
make build
```

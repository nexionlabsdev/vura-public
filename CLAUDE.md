# VURA — Codebase Guide for AI Assistants

## What This Project Is

**VURA** is an engineer-native notebook platform: ingest from any source, transform with code, and deliver to files, databases, APIs, or stakeholder reports — all from one notebook. This repository is the **open-source core**:
- A VS Code extension that renders `.flownb` notebooks with SQL, Python, JavaScript, and HTML cells
- An embedded DuckDB engine as the shared-memory data layer
- A Dynamics 365 / OData integration, split into a shared sync engine (`vura-dataverse-sync-core`) and two thin host wrappers — a VS Code add-on (`vura-dataverse-adapter`) and a `vura-runner` CLI plugin (`vura-dataverse-runner-plugin`) — as a reference implementation of the add-on SDK
- A standalone CLI (`vura-runner`) for executing `.flownb` notebooks outside VS Code

The system is a **micro-kernel + plugin model**: `core-extension` (VS Code) and `vura-runner` (CLI) are both kernels sharing one contract. `ProviderRegistry` and the `IVuraProvider` interface live in `core-sdk` (not either kernel), so the same Add-on class can register with whichever host loads it. In VS Code, Add-ons are separate extensions that call `api.registerProvider(...)` on activation. In the CLI, plugin packages are loaded by name — either declared by the notebook itself (`requiredPlugins` in the `.flownb` document) or globally via `vura-runner config set vura.plugins '[...]'` — and dispatched the same way through `ProviderRegistry.getProviderForCommand()` before falling back to a raw shell command.

The remote execution stack (control plane UI, Kafka/gRPC orchestrator, managed connectors) is **VURA Enterprise**, a separate commercial product in a private repository — not part of this codebase. See [`ROADMAP.md`](ROADMAP.md).

---

## Repository Layout

```
vura/
├── packages/
│   ├── core-extension/       # VS Code extension — notebook UI, DuckDB, cell routing
│   ├── core-sdk/             # Shared TypeScript SDK: IVuraProvider, ProviderRegistry, FlownbCell,
│   │                         # ICellLogger, IVuraEnvironment, BaseAdapter — used by both kernels and all add-ons
│   ├── vura-dataverse-sync-core/       # Host-agnostic Dataverse $batch sync engine (no vscode dependency)
│   ├── vura-dataverse-adapter/         # VS Code add-on wrapping vura-dataverse-sync-core
│   ├── vura-dataverse-runner-plugin/   # vura-runner CLI plugin wrapping vura-dataverse-sync-core
│   └── vura-runner/          # Standalone CLI/engine for executing .flownb notebooks
├── docs/                     # Architecture and developer documentation
├── samples/                  # Example .flownb notebooks
├── Makefile                  # Build automation for the VS Code extension
└── package.json              # npm workspace root (workspaces: packages/*)
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| VS Code extension | TypeScript, VS Code Extension API |
| Notebook format | `.flownb` (YAML-serialized, no outputs stored) |
| Embedded analytics | DuckDB (in-process) |
| Dataverse integration | OData v4 `$batch` multipart API |
| Standalone runner | Node.js CLI, Express (HTTP trigger server) |
| Sidecars | Python 3.10, Node.js 18 |

---

## Development Setup

```bash
npm install          # Install all workspace dependencies (monorepo root)
make build            # TypeScript compile: npm install + npx tsc -p ./
make install          # Package .vsix and install into local VS Code
```

Package platform-specific `.vsix` bundles:

```bash
make build-mac       # darwin-x64 and darwin-arm64
make build-linux     # linux-x64 and linux-arm64
make build-windows   # win32-x64 and win32-arm64
```

---

## Architecture Overview

### Cell Execution Flow

```
.flownb notebook
  └─ NotebookController (packages/core-extension/src/notebookController.ts)
       ├─ SQL cells        → sqlService.ts (TDS/MSSQL, multi-auth)
       ├─ Python cells     → Python gRPC sidecar
       ├─ JavaScript cells → Node gRPC sidecar
       ├─ HTML cells       → templateHandler.ts (Vega-Lite, PDF export)
       └─ !magic commands  → ProviderRegistry.getProviderForCommand() → IVuraProvider.handleCommand()
```

### Plugin Discovery

`ProviderRegistry` (a singleton in `core-sdk`) is shared by both hosts — an Add-on class implementing `IVuraProvider` can register with either one:

**VS Code:** Add-ons are separate extensions. The core extension exposes `registerProvider` via its exports API; Add-ons call it on activation.

```typescript
// In an add-on's activate():
const coreExt = vscode.extensions.getExtension('nexion-labs.vura-core');
const api = coreExt.exports;
api.registerProvider('vura-dataverse-adapter', myProvider);
```

**vura-runner (CLI):** there's no extension host, so plugin packages are loaded explicitly by name — either declared by the notebook itself (`requiredPlugins: ["@vura-data-os/vura-dataverse-runner-plugin"]` in the `.flownb` document) or globally via `vura-runner config set vura.plugins '["@vura-data-os/vura-dataverse-runner-plugin"]'`. `pluginLoader.ts` `require()`s each package's default export and registers it the same way, before the notebook's cells run.

### Data Bridge (Zero-Copy IPC)

Parquet files let Python, Node, and SQL cells share data without JSON serialization. The `AutoSchemaFlattener` (`packages/core-sdk/src/flattener.ts`) shreds nested JSON into relational Parquet tables with `Vura_ID` / `Vura_Parent_ID` linkage columns.

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/core-extension/src/extension.ts` | VS Code activation, command registration |
| `packages/core-extension/src/notebookController.ts` | Cell execution dispatcher |
| `packages/core-extension/src/connectionManager.ts` | SQL connection profile management |
| `packages/core-extension/src/VsCodeEnvironment.ts` | `IVuraEnvironment` implementation for VS Code — delegates DuckDB access and cross-cell variable mapping to `vura-runner`'s `DuckDbManager`/`ContextManager` rather than a local copy |
| `packages/core-extension/src/sqlService.ts` | MSSQL/TDS query execution, multi-auth |
| `packages/core-sdk/src/interfaces.ts` | `IVuraProvider`, `IConnectionAdapter`, `FlownbCell`, `ICellLogger`, `IVuraEnvironment` contracts |
| `packages/core-sdk/src/providerRegistry.ts` | Add-on lifecycle registry (singleton), shared by both hosts |
| `packages/core-sdk/src/baseAdapter.ts` | `BaseAdapter` — secret-storage helpers over `IVuraEnvironment` |
| `packages/core-sdk/src/flattener.ts` | Auto-schema JSON → Parquet flattener |
| `packages/vura-dataverse-sync-core/src/syncDataverseHandler.ts` | Host-agnostic Dataverse OData `$batch` sync engine |
| `packages/vura-dataverse-adapter/src/provider_dataverse.ts` | VS Code `IVuraProvider` wrapper around `vura-dataverse-sync-core` |
| `packages/vura-dataverse-runner-plugin/src/index.ts` | CLI `IVuraProvider` wrapper around `vura-dataverse-sync-core` |
| `packages/vura-runner/src/runner.ts` | Standalone notebook execution engine |
| `packages/vura-runner/src/cli.ts` | CLI entry point |
| `packages/vura-runner/src/pluginLoader.ts` | Loads/registers CLI plugin packages into `ProviderRegistry` |
| `packages/vura-runner/src/handlers/terminalHandler.ts` | `vura-terminal` cell dispatch: `ProviderRegistry` lookup, then shell fallback |
| `docs/README.md` | Documentation hub |

---

## Naming Conventions

### TypeScript

- **Classes:** `PascalCase` — `NotebookController`, `DuckDbManager`
- **Interfaces:** `I` prefix — `IVuraProvider`, `IConnectionAdapter`
- **Functions:** `camelCase` — `executeSql`, `handleSyncDataverse`
- **Constants:** `UPPER_SNAKE_CASE` — `PROFILES_KEY`
- **Private members:** `_` prefix — `_statusBarItem`, `_execute`
- **Files:** match the exported class name — `connectionManager.ts`, `writebackHandler.ts`

### Magic Commands

Cells with `!` prefix (e.g., `!sync_dataverse --source my_table --target accounts`, `!npm install`) are checked against `ProviderRegistry.getProviderForCommand()` (matching against each registered provider's `getCommands()`); a match is dispatched to that provider's `handleCommand()`. Anything unrecognized falls back to a raw shell command — so an Add-on's magic commands must be registered (VS Code: the extension installed and activated; CLI: the plugin loaded via `requiredPlugins` or `vura.plugins`) before they'll resolve to real logic instead of a shell "command not found".

---

## Commit Style

Follow **Conventional Commits**:

```
feat: add OpenLineage integration for SQL cells
fix: handle empty result sets in DuckDB manager
docs: update SDK guide with new adapter example
chore: bump @vscode/vsce to 2.32
refactor: extract batch-chunking logic from syncDataverseHandler
```

---

## Core Interfaces (Add-on Contract)

```typescript
// packages/core-sdk/src/interfaces.ts
interface IVuraProvider {
  activate(env: IVuraEnvironment): Promise<void>;
  getCommands(): string[];      // e.g. ['!sync_dataverse']
  getSettings(): any;
  handleCommand(
    commandRoot: string,
    cell: FlownbCell,
    logger: ICellLogger,
    env: IVuraEnvironment,
    commandLine: string
  ): Promise<void>;
}

interface IConnectionAdapter {
  connect(): Promise<void>;
  validate(): Promise<boolean>;
  sync(args: any): Promise<any>;   // unrelated to magic-command dispatch — a separate hook
}
```

`FlownbCell`, `ICellLogger`, and `IVuraEnvironment` are the same host-agnostic types both kernels use internally — an Add-on written against them runs unmodified in VS Code or the CLI. `BaseAdapter` captures `env` in `activate()` (not the constructor, since a provider is constructed before any environment exists) — subclasses overriding `activate` must call `super.activate(env)`.

---

## Authentication Modes (SQL/Dataverse)

The `ConnectionManager` supports four auth modes stored in VS Code's `globalState` (profiles) and `SecretStorage` (tokens):

- `ServicePrincipal` — Azure AD OAuth 2.0 client credentials
- `DeviceCode` — Interactive user login
- `SqlLogin` — Username/password
- `WindowsAuth` — Domain\user NTLM

---

## Error Handling Patterns

**TypeScript:** try/catch → log to output channel → `vscode.window.showErrorMessage()` → re-throw.

**DuckDB extensions:** loaded with silent catch — failures are non-fatal.

---

## Known Gaps

- **No CI/CD pipeline** — no GitHub Actions; PRs are not automatically tested
- **No pre-commit hooks** — no Husky or pre-commit config; quality checks are manual
- **No CONTRIBUTING.md** — contribution process is undocumented

# Dynamics 365 Integration

This document details how VURA writes data *back* into Dynamics 365 (Dataverse).

While SQL is used for querying (via TDS endpoint), Dataverse is strictly read-only through TDS. To solve this, the integration uses the Dataverse Web API (OData V4) to perform inserts, updates, and deletes seamlessly.

`packages/vura-dataverse` is a single unified package — one `IVuraProvider` implementation, published to both npm (for the `vura-runner` CLI) and the VS Code Marketplace (as a `.vsix`), from the same compiled `out/`:

- **`DataverseProvider`** (`src/index.ts`) implements `IVuraProvider`/`IConnectionAdapter`/`IUIActionProvider` and delegates `!dataverse.sync` (alias: `!sync_dataverse`) to `src/syncDataverseHandler.ts` — the actual `$batch` sync engine: argument parsing, Dataverse metadata lookup, batch chunking/sending, response parsing, HTML result rendering. Depends only on `@vura-data-os/core-sdk`'s host-agnostic types (`FlownbCell`, `ICellLogger`, `IVuraEnvironment`) and `@vura-data-os/vura-odata-sync-core` — no `vscode` import at all.
- **VS Code**: `export const activate = activateVsCodeProvider(DataverseProvider, 'dataverse-provider')` (from `@vura-data-os/core-sdk`) is the package's `main` entry point — install the `vura-dataverse` `.vsix` alongside `core-extension` and it registers itself on activation.
- **CLI**: the same package's default export (`DataverseProvider`) is what `vura-runner`'s plugin loader `require()`s. See [SDK Guide](sdk_guide.md#vura-runner-cli) for how a notebook declares it via `requiredPlugins: ["@vura-data-os/vura-dataverse"]`, or how to set it globally via `vura.plugins`.

---

## The $batch Synchronization Engine

The primary engine for pushing data to Dataverse is triggered by the `!dataverse.sync` command (alias: `!sync_dataverse`) in a `vura-terminal` cell, or via the `-- !odata-push` magic comment in a SQL cell.

It automatically handles OData V4 formatting, authentication, and chunked `$batch` processing to abide by API limits, while dynamically validating local tables against live Dataverse metadata to prevent schema errors.

`!dataverse.sync` only reaches this engine if a provider for it is registered — in VS Code, the `vura-dataverse` extension must be installed and active; in the CLI, `@vura-data-os/vura-dataverse` must be loaded (via `requiredPlugins` or `vura.plugins`). Otherwise the command falls through to a raw shell command and fails with "command not found".

### The Sync Process Flow

This sequence diagram explains how data moves from the DuckDB local storage, through validation, and into the Dataverse OData endpoint via multipart Batch requests.

```mermaid
sequenceDiagram
    participant Notebook
    participant SyncHandler as vura-dataverse
    participant DataverseMetadataAPI as Dataverse API (Metadata)
    participant DataverseBatchAPI as Dataverse API ($batch)

    Notebook->>SyncHandler: !dataverse.sync --source my_table --target accounts

    SyncHandler->>DataverseMetadataAPI: GET /api/data/v9.2/EntityDefinitions(LogicalName='account')
    DataverseMetadataAPI-->>SyncHandler: PrimaryId, Attributes, AlternateKeys

    SyncHandler->>SyncHandler: Validate local columns against Dataverse Attributes

    loop Chunking (e.g., 500 records)
        SyncHandler->>SyncHandler: Build Multipart $batch Payload
        SyncHandler->>DataverseBatchAPI: POST /api/data/v9.2/$batch
        DataverseBatchAPI-->>SyncHandler: Multipart Response (204 No Content / 400 Error)
        SyncHandler->>SyncHandler: parseBatchResponse()
    end

    SyncHandler-->>Notebook: Render Output HTML (Success/Failure Table)
```

> **Pro-Tip for Handling Errors:**
> Due to the high volume of records involved in `$batch` operations, partial failures can occur. We strictly **do not** use OS/editor-level notification popups for these data errors. Instead, `vura-dataverse` renders an HTML table detailing exactly which UUIDs failed and why, directly in the Notebook Cell Output (via `ICellLogger.replaceOutput`) — identically in VS Code and the CLI.

---

## Local Development

Making thousands of experimental write calls against a live CRM tenant is risky and slow. To develop against the adapter without a live Dynamics 365 tenant, point it at any local or sandbox endpoint that implements the OData v4 `$batch` protocol:

1. **Configure the Connection:**
   - **VS Code:** use the command palette (`Ctrl+Shift+P` -> `VURA Notebook: Set Connection`) to point the active cell's `cell.metadata.connectionId` at your OData v4 endpoint (e.g. `http://localhost:8080/api/data/v9.2/`).
   - **CLI:** `vura-runner credentials add <id> <server> <database> ServicePrincipal --client-id ... --tenant-id ...`, then reference `<id>` as `dataverseConnectionId` in the cell's metadata.
2. The sync engine will seamlessly route queries and `$batch` operations to that endpoint, in either host.

A ready-made local mock server that simulates the full Dynamics 365 OData `$batch` API — so you can develop against realistic CRM data without any external dependency — ships as part of VURA Enterprise.

# @vura-data-os/core-sdk

Core SDK for building Add-ons on top of the [VURA](https://github.com/nexionlabsdev/vura-public) notebook platform. VURA has **two kernels** — the VS Code extension and the standalone `vura-runner` CLI — and this package defines the one Add-on contract both share, so an Add-on written against it runs unmodified in either host.

## Install

```bash
npm install @vura-data-os/core-sdk
```

## What's in it

- **`IVuraProvider`** — the contract every Add-on implements: which magic commands (`!sync_dataverse`, etc.) it handles, and what settings it contributes.
- **`ProviderRegistry`** — the singleton registry both kernels register Add-ons into and dispatch magic commands through.
- **`IConnectionAdapter`** — the contract for connecting to and validating an external system (a CRM, a database, an API) — unrelated to magic-command dispatch.
- **`BaseAdapter`** — an abstract base class with secret-storage helpers (`storeSecret`/`getSecret`/`deleteSecret`) over `IVuraEnvironment`.
- **`FlownbCell`**, **`ICellLogger`**, **`IVuraEnvironment`** — host-agnostic types describing a notebook cell, its output sink, and everything an Add-on needs from its host (config, SQL connection profiles, secrets, local DuckDB access). VS Code's real cell/logger/environment objects and `vura-runner`'s CLI equivalents both satisfy these.
- **`AutoSchemaFlattener`** (`flattener.ts`) — recursively shreds nested JSON into relational Parquet tables linked by `Vura_ID` / `Vura_Parent_ID`, and reconstructs the original structure from those tables.
- **`ParquetUtilities`** — low-level helpers for reading and writing Parquet files, used by the flattener and available directly to Add-ons.

## Example

This Add-on has no `vscode` import at all — it runs unmodified in both kernels:

```typescript
import { IVuraProvider, IConnectionAdapter, BaseAdapter, FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';

export class MyCustomAdapter extends BaseAdapter implements IVuraProvider, IConnectionAdapter {
    async activate(env: IVuraEnvironment) {
        await super.activate(env); // captures env for BaseAdapter's secret helpers
    }

    getCommands() {
        return ['!my_custom_command'];
    }

    getSettings() {
        return { 'vura.myCustomAdapter.timeout': 5000 };
    }

    async connect() { /* authentication logic */ }
    async validate() { return true; }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string) {
        // e.g. env.runLocalQuery(...) to read the shared DuckDB instance
        await logger.logText('Command executed successfully!');
    }
}
```

**Registering in VS Code** — the provider is constructed with no arguments; `activate(env)` supplies the environment:

```typescript
const core = vscode.extensions.getExtension('nexion-labs.vura-core');
if (core) {
    if (!core.isActive) {
        await core.activate();
    }
    core.exports.registerProvider('my-custom-adapter-id', new MyCustomAdapter());
}
```

**Registering in `vura-runner` (CLI)** — publish your Add-on as its own package with a **default export**, then either declare it in a notebook's `requiredPlugins`, or globally: `vura-runner config set vura.plugins '["my-custom-adapter-plugin"]'`.

See the [SDK Guide](https://github.com/nexionlabsdev/vura-public/blob/main/docs/sdk_guide.md) and [Dataverse Integration](https://github.com/nexionlabsdev/vura-public/blob/main/docs/dataverse_integration.md) (a reference implementation split into `vura-dataverse-sync-core` + `vura-dataverse-adapter` + `vura-dataverse-runner-plugin`) in the main repo for the full walkthrough.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

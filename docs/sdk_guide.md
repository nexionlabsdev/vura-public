# SDK Guide: Building Add-ons (@vura-data-os/core-sdk)

Welcome to the SDK Guide! VURA has **two kernels** — the VS Code `core-extension` and the standalone `vura-runner` CLI — and one Add-on contract shared by both, defined entirely in `@vura-data-os/core-sdk`. An Add-on written against `core-sdk`'s interfaces runs unmodified in either host: only the thin registration wrapper differs (a VS Code extension vs. a CLI plugin package), while the actual logic (`handleCommand`, etc.) is identical. See [Dataverse Integration](dataverse_integration.md) for a worked example of this split (`vura-dataverse-sync-core` + `vura-dataverse-adapter` + `vura-dataverse-runner-plugin`).

## The Add-on Discovery and Activation Flow

How does a kernel know about your external Add-on? Each host discovers Add-ons differently, but both register into the same `ProviderRegistry` singleton (also in `core-sdk`).

```mermaid
flowchart TD
    A1[VS Code Starts / Add-on Extension Activated] --> B[Add-on constructs Class implementing IVuraProvider]
    A2[vura-runner reads requiredPlugins / vura.plugins config] --> B
    B --> C[Host calls ProviderRegistry.registerProvider]
    C --> D[registerProvider calls provider.activate(env)]
    D --> E[Add-on is ready to handle magic commands]
    E --> F{"'!' cell matches getCommands()?"}
    F -- Yes --> G[ProviderRegistry.getProviderForCommand routes to handleCommand]
    F -- No --> H[Falls back to a raw shell command]
```

## Getting Started

1. Install the SDK: `npm install @vura-data-os/core-sdk`
2. Implement `IVuraProvider` (and optionally `IConnectionAdapter`) against the host-agnostic types below.
3. Add a thin registration wrapper per host you want to support — a VS Code extension, a CLI plugin package, or both.

## Interface Definitions

The SDK exposes two primary interfaces and a helper class that your adapter must implement.

### Host-agnostic types

These three types describe everything a provider needs from its host, without depending on `vscode` or `vura-runner` directly — both kernels' real cell/logger/environment objects satisfy them.

*   **`FlownbCell`**: `{ kind, language, value, metadata? }` — a notebook cell, independent of the host's own cell representation.
*   **`ICellLogger`**: `logText`, `logError`, `logHtml`, `logJson`, `replaceOutput`, `logMultiple`, `clearOutput` — the output sink your command writes to.
*   **`IVuraEnvironment`**: `storagePath`, `notebookDir`, `getConfig`, `getProfile`/`getProfileSecret` (SQL connection profiles), `getSecret`/`setSecret`/`deleteSecret` (generic Add-on secrets), `runLocalQuery` (query the shared DuckDB instance), `getPythonVenvPath`, and more.

### `IVuraProvider`

This interface defines how your Add-on interacts with the Polyglot Notebook's `vura-terminal` cell.

*   **`getCommands(): string[]`**: Returns an array of magic commands your Add-on supports (e.g., `['!sync_dataverse', '!ping_custom']`).
*   **`handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void>`**: The host routes execution here when a user runs one of your registered commands. `ProviderRegistry.getProviderForCommand()` is checked *before* the shell fallback — an unrecognized `!` command still gets executed as a literal shell command, so make sure `getCommands()` actually lists everything you handle.
*   **`getSettings(): any`**: Returns any custom configuration settings your Add-on contributes (namespaced with `vura.`).
*   **`activate(env: IVuraEnvironment): Promise<void>`**: Called once when the provider registers with its host. If you extend `BaseAdapter`, call `super.activate(env)` first — it's what captures `env` for `BaseAdapter`'s secret helpers.

### `IConnectionAdapter`

This interface defines how your Add-on handles authentication and validation for external systems. It's unrelated to magic-command dispatch — a separate hook for connection lifecycle, not required just to handle `!` commands.

*   **`connect(): Promise<void>`**: Logic to establish a connection (e.g., fetching OAuth tokens). Remember to read `cell.metadata.connectionId` to handle multi-connection scenarios.
*   **`validate(): Promise<boolean>`**: Logic to ensure the connection is active and valid before execution.

### `BaseAdapter`

The SDK provides a `BaseAdapter` class. It is highly recommended to extend this class as it provides built-in helper utilities (`storeSecret`/`getSecret`/`deleteSecret`) over `env.setSecret`/`getSecret`/`deleteSecret`. It captures `env` in `activate()`, not the constructor — a provider is constructed by its host *before* any environment exists (VS Code activates the extension; the CLI loads the plugin package), so subclasses that override `activate` must call `super.activate(env)`.

## Example Implementation

This example has no `vscode` import at all — it runs unmodified in both kernels.

```typescript
import { IVuraProvider, IConnectionAdapter, BaseAdapter, FlownbCell, ICellLogger, IVuraEnvironment } from '@vura-data-os/core-sdk';

export class MyCustomAdapter extends BaseAdapter implements IVuraProvider, IConnectionAdapter {
    async activate(env: IVuraEnvironment) {
        await super.activate(env);
        // Any other initialization logic
    }

    getCommands() {
        return ['!my_custom_command'];
    }

    getSettings() {
        return {
            'vura.myCustomAdapter.timeout': 5000
        };
    }

    async connect() {
        // Authentication logic
    }

    async validate() {
        return true;
    }

    async handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string) {
        if (commandRoot === '!my_custom_command') {
            // Execution logic for your command — e.g. env.runLocalQuery(...) to read the
            // shared DuckDB instance, or env.getProfile(cell.metadata?.connectionId) for
            // a configured connection.
            await logger.logText("Command Executed Successfully!");
        }
    }
}
```

## Registration

The provider class above is identical either way — only the registration wrapper differs.

### VS Code

In your extension's `activate` method, obtain the core's exports and register your provider:

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // Note: Use the actual publisher and name of the core extension
    const core = vscode.extensions.getExtension('nexion-labs.vura-core');
    if (core) {
        // Ensure the core is activated before accessing exports
        if (!core.isActive) {
            core.activate().then(() => register(core));
        } else {
            register(core);
        }
    }
}

function register(core: vscode.Extension<any>) {
    const provider = new MyCustomAdapter();
    core.exports.registerProvider('my-custom-adapter-id', provider);
}
```

Note the provider is constructed with **no arguments** — `activate(env)` is what supplies the environment, not the constructor.

### vura-runner (CLI)

Publish your Add-on as its own npm package with a **default export** of the `IVuraProvider` class:

```typescript
// my-custom-adapter-plugin/src/index.ts
export default class MyCustomAdapter extends BaseAdapter implements IVuraProvider, IConnectionAdapter {
    // ...same class as above
}
```

Consumers then either declare it in their notebook:

```yaml
version: 1
cells: [...]
requiredPlugins:
  - "my-custom-adapter-plugin"
```

or install it and set it globally:

```bash
npm install -g my-custom-adapter-plugin
vura-runner config set vura.plugins '["my-custom-adapter-plugin"]'
```

`vura-runner` `require()`s the package's default export and registers it into the same `ProviderRegistry` before running the notebook's cells — a notebook's own `requiredPlugins` and the global `vura.plugins` config are merged, so either (or both) is enough.

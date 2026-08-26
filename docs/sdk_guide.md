# SDK Guide: Building Add-ons (@vura-data-os/core-sdk)

Welcome to the SDK Guide! VURA has **two kernels** — the VS Code `core-extension` and the standalone `vura-runner` CLI — and one Add-on contract shared by both, defined entirely in `@vura-data-os/core-sdk`. An Add-on written against `core-sdk`'s interfaces runs unmodified in either host: single-package architecture allows publishing to both npm and VS Code Marketplace. See [Dataverse Integration](dataverse_integration.md) for a worked example.

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
2. Implement `IVuraProvider` (and optionally `IConnectionAdapter` and `IUIActionProvider`) against the host-agnostic types below.
3. Use the `activateVsCodeProvider` helper export from `@vura-data-os/core-sdk` in a single unified package for both CLI and VS Code.

## Naming Convention for Magic Commands

All first-party connector Add-ons must follow the `!{connector}.{action}` namespacing convention for their magic commands:
- **Dataverse**: `!dataverse.sync`
- **SharePoint**: `!sharepoint.sync`

*Note on dispatch behavior:* `ProviderRegistry.getProviderForCommand()` remains flat-first-match (no runtime namespacing enforcement) — this convention is enforced by team discipline, consistent with connectors being first-party.

## Interface Definitions

The SDK exposes interfaces and a helper class that your adapter must implement.

### Host-agnostic types

These describe everything a provider needs from its host, without depending on `vscode` or `vura-runner` directly — both kernels' real cell/logger/environment objects satisfy them.

*   **`FlownbCell`**: `{ kind, language, value, metadata? }` — a notebook cell, independent of the host's own cell representation.
*   **`ICellLogger`**: `logText`, `logError`, `logHtml`, `logJson`, `replaceOutput`, `logMultiple`, `clearOutput` — the output sink your command writes to.
*   **`IVuraEnvironment`**: `storagePath`, `notebookDir`, `getConfig`, `getProfile`/`getProfileSecret` (SQL connection profiles), `getSecret`/`setSecret`/`deleteSecret` (generic Add-on secrets), `runLocalQuery` (query the shared DuckDB instance), `getPythonVenvPath`, and more.

### `IVuraProvider`

This interface defines how your Add-on interacts with the Polyglot Notebook's `vura-terminal` cell.

*   **`getCommands(): string[]`**: Returns an array of magic commands your Add-on supports following the `!{connector}.{action}` convention (e.g., `['!dataverse.sync']`).
*   **`handleCommand(commandRoot: string, cell: FlownbCell, logger: ICellLogger, env: IVuraEnvironment, commandLine: string): Promise<void>`**: The host routes execution here when a user runs one of your registered commands. `ProviderRegistry.getProviderForCommand()` is checked *before* the shell fallback.
*   **`getSettings(): any`**: Returns any custom configuration settings your Add-on contributes (namespaced with `vura.`).
*   **`activate(env: IVuraEnvironment): Promise<void>`**: Called once when the provider registers with its host.

### `IUIActionProvider` (Optional SDK Hook for Host-specific UI)

```typescript
export interface UIAction {
    id: string;
    label: string;              // e.g. "$(cloud) Dataverse Sync"
    kind: 'quickpick' | 'input' | 'button';
    options?: () => Promise<string[]>;
    onSelect: (value: string, cell: FlownbCell) => Promise<void>;
}

export interface IUIActionProvider {
    getUIActions(cell: FlownbCell): UIAction[];
}
```

## Single Package Pattern

Connectors use `activateVsCodeProvider` from `@vura-data-os/core-sdk` to publish one package to both npm and VS Code Marketplace:

```typescript
import { IVuraProvider, BaseAdapter, activateVsCodeProvider } from '@vura-data-os/core-sdk';

export class MyConnectorProvider extends BaseAdapter implements IVuraProvider {
    getCommands() {
        return ['!myconnector.sync'];
    }
    // ...
}

export default MyConnectorProvider;
export const activate = activateVsCodeProvider(MyConnectorProvider, 'myconnector-provider');
```

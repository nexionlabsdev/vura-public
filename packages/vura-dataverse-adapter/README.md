# Dataverse Adapter

VS Code Add-on that connects [VURA](https://github.com/nexionlabsdev/vura-public) notebooks to Dynamics 365 (Dataverse). It plugs into the `VURA Studio` core extension via `@vura-data-os/core-sdk`'s `IVuraProvider` contract and adds the `!sync_dataverse` magic command to `vura-terminal` cells.

The actual `$batch` sync logic lives in `@vura-data-os/vura-dataverse-sync-core`, shared with the `@vura-data-os/vura-dataverse-runner-plugin` CLI plugin — this package is a thin VS Code-specific wrapper around it (activation, registration with the core extension's `ProviderRegistry`).

## Requirements

- VURA Studio (`nexion-labs.vura-core`) installed and active — this Add-on activates on `onExtension:nexion-labs.vura-core`.
- A Dynamics 365 connection profile with `ServicePrincipal` auth (Azure AD client credentials) — the only auth mode `vura-dataverse-sync-core` currently supports for `$batch` sync.

## Install

Package and install as a `.vsix` alongside the core extension (this repo doesn't publish to the VS Code Marketplace):

```bash
cd packages/vura-dataverse-adapter
npm run compile
npx vsce package
code --install-extension vura-dataverse-adapter-1.0.0.vsix
```

## Usage

In a `vura-terminal` cell:

```
!sync_dataverse --source <local_table> --target <dataverse_entity_logical_name> [--mode upsert|insert] [--batch_size 1000] [--key <column>]
```

The cell needs a `dataverseConnectionId` in its metadata pointing at a connection profile (set via the `VURA Notebook: Set Dataverse Connection` command). `--source` reads from the shared DuckDB instance (e.g. a table a Python cell wrote via `vura_bridge.save_table`); `--target` is the Dataverse entity's logical name.

See the main repo's [Dataverse Integration](https://github.com/nexionlabsdev/vura-public/blob/main/docs/dataverse_integration.md) doc for the full sync flow, and the [SDK Guide](https://github.com/nexionlabsdev/vura-public/blob/main/docs/sdk_guide.md) for how this Add-on's provider registration works.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

# @vura-data-os/vura-dataverse

Dynamics 365 (Dataverse) OData v4 `$batch` sync connector for [VURA](https://github.com/nexionlabsdev/vura-public), packaged once and published to both npm and the VS Code Marketplace from the same compiled output.

- **VS Code:** install the extension and it registers itself with the `VURA Studio` core extension via `@vura-data-os/core-sdk`'s `IVuraProvider` contract, adding the `!dataverse.sync` (alias `!sync_dataverse`) magic command to `vura-terminal` cells.
- **`vura-runner` CLI:** `npm install -g @vura-data-os/vura-dataverse`, then declare it in a notebook's `requiredPlugins: ["@vura-data-os/vura-dataverse"]` or globally via `vura-runner config set vura.plugins '["@vura-data-os/vura-dataverse"]'`.

## What's in it

`handleSyncDataverse(cell, logger, env, commandLine)` — parses `!dataverse.sync --source <table> --target <entity> [--mode upsert|insert] [--batch_size N] [--key <col>]`, resolves the Dataverse entity's primary/alternate keys, reads the local table via `env.runLocalQuery`, chunks and sends `$batch` requests, and renders a success/failure HTML table via `logger.replaceOutput`.

See the main repo's [Dataverse Integration](https://github.com/nexionlabsdev/vura-public/blob/main/docs/dataverse_integration.md) doc for the full sync flow.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

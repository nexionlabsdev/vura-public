# @vura-data-os/vura-dataverse-sync-core

Host-agnostic Dynamics 365 (Dataverse) OData v4 `$batch` sync engine for [VURA](https://github.com/nexionlabsdev/vura-public). No `vscode` dependency — the same logic backs both the VS Code Add-on (`@vura-data-os/vura-dataverse-adapter`) and the `vura-runner` CLI plugin (`@vura-data-os/vura-dataverse-runner-plugin`).

## What's in it

`handleSyncDataverse(cell, logger, env, commandLine)` — parses `!sync_dataverse --source <table> --target <entity> [--mode upsert|insert] [--batch_size N] [--key <col>]`, resolves the Dataverse entity's primary/alternate keys, reads the local table via `env.runLocalQuery`, chunks and sends `$batch` requests, and renders a success/failure HTML table via `logger.replaceOutput`.

`parseArgs(commandLine)` is also exported directly if you need to validate a command line without running the sync.

This package isn't meant to be used standalone — install it via `@vura-data-os/vura-dataverse-adapter` (VS Code) or `@vura-data-os/vura-dataverse-runner-plugin` (CLI) instead. See the main repo's [Dataverse Integration](https://github.com/nexionlabsdev/vura-public/blob/main/docs/dataverse_integration.md) doc.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

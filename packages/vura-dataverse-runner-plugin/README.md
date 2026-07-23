# @vura-data-os/vura-dataverse-runner-plugin

Adds `!sync_dataverse` support to the [`vura-runner`](https://github.com/nexionlabsdev/vura-public) CLI — the same Dynamics 365 `$batch` sync engine (`@vura-data-os/vura-dataverse-sync-core`) used by the VS Code `vura-dataverse-adapter` Add-on, wrapped as a `vura-runner` plugin.

## Install

```bash
npm install -g @vura-data-os/vura-dataverse-runner-plugin
```

## Enable it

Either declare it in the notebook that needs it:

```yaml
version: 1
cells: [...]
requiredPlugins:
  - "@vura-data-os/vura-dataverse-runner-plugin"
```

or set it globally, for any notebook that doesn't declare its own plugins:

```bash
vura-runner config set vura.plugins '["@vura-data-os/vura-dataverse-runner-plugin"]'
```

`vura-runner` loads and registers it before running a notebook's cells, so `!sync_dataverse` resolves to the real sync engine instead of falling through to a raw shell command.

## Usage

```
!sync_dataverse --source <local_table> --target <dataverse_entity_logical_name> [--mode upsert|insert] [--batch_size 1000] [--key <column>]
```

The cell needs a `dataverseConnectionId` in its metadata pointing at a connection profile added via `vura-runner credentials add`. See the main repo's [Dataverse Integration](https://github.com/nexionlabsdev/vura-public/blob/main/docs/dataverse_integration.md) doc.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

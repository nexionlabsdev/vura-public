# @vura-data-os/vura-runner

Standalone CLI and execution engine for [VURA](https://github.com/nexionlabsdev/vura-public) `.flownb` notebooks — run them outside VS Code, from a CI job, a cron trigger, or an HTTP call.

## Install

```bash
npm install -g @vura-data-os/vura-runner
```

## CLI usage

```bash
# Execute a notebook
vura-runner execute my-notebook.flownb

# Only run cell 3, showing more rows per table, and save the JSON output
vura-runner execute my-notebook.flownb --cell 3 --rows 20 --output result.json

# Export the notebook's visual (HTML) cells to a standalone file, image, or PDF
vura-runner execute my-notebook.flownb --export-html report.html
vura-runner execute my-notebook.flownb --export-png report.png
vura-runner execute my-notebook.flownb --export-pdf report.pdf

# Print the execution plan (which cells would run/skip based on runWhen) without running anything
vura-runner execute my-notebook.flownb --dry-run

# List the cells in a notebook
vura-runner list my-notebook.flownb

# Serve a directory of notebooks over HTTP so they can be triggered remotely
vura-runner serve --port 3000 --notebooks-dir ./notebooks

# Manage stored SQL connection profiles
vura-runner credentials add my-profile my-server.database.windows.net my-db SqlLogin --username sa --secret '{"password":"..."}'
vura-runner credentials list
vura-runner credentials remove my-profile

# Manage global VURA config (~/.vura/config.json) — values are parsed as JSON
# where possible, so booleans/numbers/arrays round-trip correctly
vura-runner config set vura.python.venvPath /path/to/venv
vura-runner config get vura.python.venvPath
vura-runner config list
vura-runner config unset vura.python.venvPath
vura-runner config --help    # lists all known keys (vura.plugins, vura.depthLimit, etc.)
```

Run `vura-runner --help` or `vura-runner <command> --help` for the full option list.

## Add-on plugins

Magic commands like `!sync_dataverse` are handled by Add-ons — the same ones that plug into the VS Code extension — not built into the runner itself. An unrecognized `!` command falls back to a raw shell command. Load a plugin package either per-notebook or globally:

```yaml
# in the .flownb document itself
version: 1
cells: [...]
requiredPlugins:
  - "@vura-data-os/vura-dataverse-runner-plugin"
```

```bash
# or globally, for notebooks that don't declare it themselves
vura-runner config set vura.plugins '["@vura-data-os/vura-dataverse-runner-plugin"]'
```

See the [SDK Guide](https://github.com/nexionlabsdev/vura-public/blob/main/docs/sdk_guide.md) for building your own plugin.

## Programmatic usage

The engine can also be used as a library:

```typescript
import { VuraRunner, CliEnvironment } from '@vura-data-os/vura-runner';

const env = new CliEnvironment(process.cwd());
const runner = new VuraRunner(env);
const result = await runner.executeNotebook(cells, logger, process.env);
```

See the main repo's [Development Playbook](https://github.com/nexionlabsdev/vura-public/blob/main/docs/DEVELOPMENT_PLAYBOOK.md) for the full golden-path walkthrough, and [Architecture & IPC](https://github.com/nexionlabsdev/vura-public/blob/main/docs/architecture.md) for how the DuckDB/Parquet bridge works under the hood.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

# vura-io

Python counterpart of [`@vura-data-os/vura-io`](https://github.com/nexionlabsdev/vura-public/tree/main/packages/vura-io) for [VURA](https://github.com/nexionlabsdev/vura-public) — state management, metrics, and DuckDB-backed relational JSON shredding for the Python sidecar that `vura-runner` and the core VS Code extension use to run `python` notebook cells.

## What's in it

- `shred_json` / `unshred_json` — recursively shreds nested JSON into relational tables (with `Vura_ID`/`Vura_Parent_ID` linkage columns) and back, matching the TypeScript shredder's contract byte-for-byte.
- `DataManager` (`data`) — reads/writes the shared Arrow/Parquet-backed tables a notebook's cells pass between each other, including automatic partitioning above a row-count threshold.
- `StateManager` (`state`) / `MetricsManager` (`metrics`) — session state and execution metrics shared across cells in a run.
- `load_schemas()` / `SIDECAR_REQUEST_SCHEMA` / `SIDECAR_RESPONSE_SCHEMA` / `TABLE_MANIFEST_SCHEMA` — the JSON Schema contract shared with `@vura-data-os/vura-io`, validating the sidecar request/response protocol and table manifests.

This package isn't meant to be installed standalone — `vura-runner`'s Python sidecar depends on it to execute `python` cells. See the main repo's [architecture docs](https://github.com/nexionlabsdev/vura-public/blob/main/docs/architecture.md) for how the polyglot notebook bridge works.

## License

AGPL-3.0-or-later. See [LICENSE](https://github.com/nexionlabsdev/vura-public/blob/main/LICENSE). For a commercial license, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

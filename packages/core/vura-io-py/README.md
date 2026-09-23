# vura-io

Python data abstraction library for [VURA](https://github.com/nexionlabsdev/vura-public) notebook sidecars — a Parquet/Arrow-backed key-value/table store, DuckDB-powered relational JSON shredding, run metrics, and lightweight session state, shared with the Node counterpart (`@vura-data-os/vura-io`).

It's the storage layer `.flownb` Python cells talk to under the hood: `vura.io.data` for tables, `vura.io.state` for session variables, `vura.io.metrics` for run tracking — all backed by DuckDB, Arrow, and Parquet on disk, with automatic partitioning once a table grows past a row threshold.

## Install

```bash
pip install vura-io
```

## Quick start

```python
from vura.io import data, state, metrics

# Store a DataFrame, dict, or Arrow Table as a named table
data.put("customers", df)

# Stream it back — as records, a DataFrame, or a genuine Arrow Table
for batch in data.stream("customers", format="arrow"):
    ...

# Upsert against an existing key
data.upsert("customers", new_rows, on="customer_id")

# Session state, shared across cells in a notebook run
state.set("last_sync_at", "2026-09-22T00:00:00Z")
state.get("last_sync_at")

# Run metrics, surfaced in the notebook's cell output
metrics.track("rows_ingested", len(df))
metrics.log("Sync completed", level="INFO")
```

### Relational JSON shredding

Nested JSON (e.g. an API response with arrays of objects) gets flattened into related tables and reassembled on read:

```python
from vura.io import shred_json, unshred_json

tables, manifest, table_names = shred_json("orders", nested_json_obj)
restored = unshred_json(manifest, tables)
```

## Storage layout

Tables live under `VURA_STORAGE_PATH` (defaults to the current working directory). A table under the row threshold (`VURA_PARTITION_THRESHOLD_ROWS`, default `50000`) is a single `.parquet`/`.arrow` file; once it crosses that threshold, `vura-io` transparently converts it to a partitioned directory — a fixed-size `manifest.json` summary (`version`, `tableName`, `rowCount`, `compacted`, `nextPartIndex`, `schema`) alongside an append-only `manifest-parts.jsonl` log. `data.pack()`/`data.unpack()` and `data.stream()` handle both layouts transparently.

## API surface

| Module | Key methods |
|---|---|
| `vura.io.data` (`DataManager`) | `put`, `get`, `pack`, `unpack`, `append`, `update`, `upsert`, `stream`, `count`, `flush`, `flush_all`, `tables` |
| `vura.io.state` (`StateManager`) | `set`, `get`, `context` |
| `vura.io.metrics` (`MetricsManager`) | `track`, `log`, `preview` |
| `vura.io.shredder` | `shred_json`, `unshred_json` |
| `vura.io.schemas` | `load_schemas`, `get_schema_dir_path`, `validate_object` |

## Requirements

Python 3.8+, `pandas`, `pyarrow`, `duckdb`, `jsonschema` (installed automatically).

## Source & license

Source: [`packages/core/vura-io-py`](https://github.com/nexionlabsdev/vura-public/tree/main/packages/core/vura-io-py) in [nexionlabsdev/vura-public](https://github.com/nexionlabsdev/vura-public).
Licensed under AGPL-3.0. For a commercial license without AGPL's obligations, contact [info@nexionlabs.dev](mailto:info@nexionlabs.dev).

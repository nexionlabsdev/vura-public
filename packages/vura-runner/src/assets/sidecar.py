import contextlib
import io
import json
import os
import sys
import traceback
import types
import uuid

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    import duckdb
except ImportError:
    duckdb = None


def shred_json(dataset_name, obj):
    tables = {}
    manifest = {
        "dataset_name": dataset_name,
        "root_table": dataset_name,
        "is_root_array": isinstance(obj, list),
        "tables": {}
    }

    def next_id():
        return str(uuid.uuid4())

    def process_node(node, table_name, parent_table, field_name, parent_id, index_in_parent):
        if table_name not in manifest["tables"]:
            manifest["tables"][table_name] = {
                "table_name": table_name,
                "parent_table": parent_table,
                "field_name": field_name,
                "node_type": "array" if isinstance(node, list) else "object",
                "field_order": [],
                "field_types": {},
                "children": {}
            }
        meta = manifest["tables"][table_name]
        if table_name not in tables:
            tables[table_name] = []

        if isinstance(node, list):
            if len(node) == 0:
                if not meta.get("node_type"):
                    meta["node_type"] = "array"
                return
            is_primitive_array = any(item is None or not isinstance(item, (dict, list)) for item in node)
            if is_primitive_array:
                meta["node_type"] = "primitive_array"
                for i, item in enumerate(node):
                    row_id = next_id()
                    tables[table_name].append({
                        "_vura_id": row_id,
                        "_vura_parent_id": parent_id,
                        "_vura_index": i,
                        "_vura_value": item
                    })
                return

            if meta.get("node_type") != "primitive_array":
                meta["node_type"] = "array"
            for i, item in enumerate(node):
                process_object_item(item, table_name, parent_id, i)
        elif isinstance(node, dict):
            meta["node_type"] = "object"
            process_object_item(node, table_name, parent_id, index_in_parent)

    def process_object_item(item, table_name, parent_id, index):
        meta = manifest["tables"][table_name]
        row_id = next_id()
        row = {
            "_vura_id": row_id,
            "_vura_parent_id": parent_id,
            "_vura_index": index
        }

        if isinstance(item, dict):
            for key, value in item.items():
                if key not in meta["field_order"]:
                    meta["field_order"].append(key)

                if value is None:
                    meta["field_types"][key] = "null"
                    row[key] = None
                elif isinstance(value, (dict, list)):
                    child_table_name = f"{table_name}_{key}"
                    meta["field_types"][key] = "array" if isinstance(value, list) else "object"
                    meta["children"][key] = child_table_name
                    process_node(value, child_table_name, table_name, key, row_id, 0)
                else:
                    meta["field_types"][key] = type(value).__name__
                    row[key] = value

        tables[table_name].append(row)

    process_node(obj, dataset_name, None, None, None, 0)
    table_names = list(manifest["tables"].keys())

    return tables, manifest, table_names


def unshred_json(manifest, tables):
    from collections import defaultdict
    row_indexes = {}
    for t_name, rows in tables.items():
        by_parent = defaultdict(list)
        for r in (rows or []):
            p_id = r.get("_vura_parent_id")
            if not p_id or p_id == "null":
                p_id = None
            by_parent[p_id].append(r)
        row_indexes[t_name] = by_parent

    def reconstruct_node(table_name, parent_id):
        meta = manifest["tables"].get(table_name)
        if not meta:
            return None

        table_rows = row_indexes.get(table_name, {}).get(parent_id, [])
        table_rows.sort(key=lambda r: r.get("_vura_index", 0) if r.get("_vura_index") is not None else 0)

        if meta["node_type"] == "primitive_array":
            return [r.get("_vura_value") for r in table_rows]

        if meta["node_type"] == "array":
            return [reconstruct_item(r, meta) for r in table_rows]

        if len(table_rows) == 0:
            return None

        return reconstruct_item(table_rows[0], meta)

    def reconstruct_item(row, meta):
        item = {}
        for key in meta["field_order"]:
            if key in meta["children"]:
                child_table_name = meta["children"][key]
                child_meta = manifest["tables"].get(child_table_name)
                child_val = reconstruct_node(child_table_name, row.get("_vura_id"))
                if child_val is None and child_meta and child_meta.get("node_type") == "array":
                    item[key] = []
                else:
                    item[key] = child_val
            elif key in row:
                item[key] = row[key]
            else:
                item[key] = None
        return item

    return reconstruct_node(manifest["root_table"], None)


class DataManager:
    def __init__(self, storage_path):
        self.storage_path = storage_path
        self._manifests = {}

    def _get_pd(self):
        global pd
        if pd is None:
            try:
                import pandas as pd
            except ImportError:
                raise ImportError(
                    "pandas and pyarrow are required for vura.io operations. "
                    "Install them using: !pip install pandas pyarrow"
                )
        return pd

    @property
    def current_storage_path(self):
        return os.environ.get("VURA_STORAGE_PATH", self.storage_path)

    @property
    def threshold_bytes(self):
        env_val = os.environ.get("VURA_ARROW_THRESHOLD_BYTES")
        if env_val:
            try:
                val = int(env_val)
                if val >= 0:
                    return val
            except ValueError:
                pass
        return 5 * 1024 * 1024  # Default 5 MB

    def _get_table_path(self, table_name, ext):
        return os.path.join(self.current_storage_path, f"{table_name}.{ext}")

    def _find_existing_table_path(self, table_name):
        base_name = table_name.replace('.parquet', '').replace('.arrow', '')
        arrow_path = self._get_table_path(base_name, 'arrow')
        parquet_path = self._get_table_path(base_name, 'parquet')

        if os.path.exists(arrow_path):
            return arrow_path, 'arrow'
        if os.path.exists(parquet_path):
            return parquet_path, 'parquet'

        if os.path.exists(self.current_storage_path):
            lower_base = base_name.lower()
            for f in os.listdir(self.current_storage_path):
                f_lower = f.lower()
                if f_lower == f"{lower_base}.arrow":
                    return os.path.join(self.current_storage_path, f), 'arrow'
                if f_lower == f"{lower_base}.parquet":
                    return os.path.join(self.current_storage_path, f), 'parquet'
        return None, None

    def _emit_mapping(self, variable_name, file_path):
        print(json.dumps({"type": "vura_io_mapping", "variable": variable_name, "path": file_path}), file=sys.stderr)

    def _write_table_data(self, table_name, records):
        curr_pd = self._get_pd()
        import pyarrow as pa
        import pyarrow.parquet as pq

        if isinstance(records, pa.Table):
            table = records
        elif isinstance(records, curr_pd.DataFrame):
            table = pa.Table.from_pandas(records)
        elif not records:
            df = curr_pd.DataFrame(columns=["_vura_id", "_vura_parent_id", "_vura_index", "_vura_value"])
            table = pa.Table.from_pandas(df)
        elif isinstance(records, list):
            try:
                table = pa.Table.from_pylist(records)
            except Exception:
                df = curr_pd.DataFrame(records)
                table = pa.Table.from_pandas(df)
        else:
            df = curr_pd.DataFrame([records])
            table = pa.Table.from_pandas(df)

        parquet_path = self._get_table_path(table_name, 'parquet')
        pq.write_table(table, parquet_path)
        return parquet_path

    def _read_table_data(self, table_name):
        file_path, fmt = self._find_existing_table_path(table_name)
        if not file_path:
            return []
        curr_pd = self._get_pd()
        if fmt == 'arrow':
            import pyarrow.feather as feather
            df = feather.read_feather(file_path)
        else:
            df = curr_pd.read_parquet(file_path, engine="pyarrow")
        return df.to_dict(orient="records")

    def pack(self, name, obj):
        tables, manifest, table_names = shred_json(name, obj)
        self._manifests[name] = manifest

        for table_name, records in tables.items():
            file_path = self._write_table_data(table_name, records)
            self._emit_mapping(table_name, file_path)
            if table_name.startswith(f"{name}_"):
                short_key = table_name[len(name) + 1:]
                if short_key:
                    self._emit_mapping(short_key, file_path)

        meta_table_name = f"__vura_meta_{name}"
        meta_records = [{"manifest": json.dumps(manifest)}]
        self._write_table_data(meta_table_name, meta_records)

        root_path, _ = self._find_existing_table_path(name)
        if not root_path:
            root_path = self._get_table_path(name, 'parquet')
        self._emit_mapping(name, root_path)
        return table_names

    def unpack(self, name):
        manifest = self._manifests.get(name)
        if not manifest:
            meta_table_name = f"__vura_meta_{name}"
            meta_records = self._read_table_data(meta_table_name)
            if not meta_records or not meta_records[0].get("manifest"):
                raise FileNotFoundError(f"Dataset metadata for '{name}' not found.")
            manifest = json.loads(meta_records[0]["manifest"])
            self._manifests[name] = manifest

        tables = {}
        for table_name in manifest["tables"].keys():
            tables[table_name] = self._read_table_data(table_name)

        return unshred_json(manifest, tables)

    def put(self, name, obj):
        curr_pd = self._get_pd()
        import pyarrow as pa

        if isinstance(obj, (curr_pd.DataFrame, pa.Table)):
            file_path = self._write_table_data(name, obj)
            self._emit_mapping(name, file_path)
            return [name]

        is_nested = False
        if isinstance(obj, list):
            is_nested = any(
                isinstance(item, dict) and any(isinstance(v, (dict, list)) for v in item.values())
                for item in obj
            )
        elif isinstance(obj, dict):
            is_nested = any(isinstance(v, (dict, list)) for v in obj.values())

        if is_nested:
            return self.pack(name, obj)

        records = obj if isinstance(obj, list) else [obj]
        file_path = self._write_table_data(name, records)
        self._emit_mapping(name, file_path)
        return [name]

    def get(self, name):
        meta_table_name = f"__vura_meta_{name}"
        meta_path, _ = self._find_existing_table_path(meta_table_name)
        if meta_path or name in self._manifests:
            return self.unpack(name)

        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            raise FileNotFoundError(f"Table '{name}' not found.")
        curr_pd = self._get_pd()
        if fmt == 'arrow':
            import pyarrow.feather as feather
            return feather.read_feather(file_path)
        return curr_pd.read_parquet(file_path, engine="pyarrow")

    def count(self, name):
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            return 0
        import pyarrow.parquet as pq
        return pq.ParquetFile(file_path).metadata.num_rows

    def stream(self, name, batch_size=50000, format='dict'):
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            return
        import pyarrow.parquet as pq
        pf = pq.ParquetFile(file_path)
        for batch in pf.iter_batches(batch_size=batch_size):
            if format == 'arrow':
                yield batch
            elif format == 'dataframe':
                curr_pd = self._get_pd()
                yield curr_pd.DataFrame(batch.to_pydict())
            else:
                yield batch.to_pylist()

    def append(self, name, obj):
        file_path, _ = self._find_existing_table_path(name)
        if not file_path:
            return self.put(name, obj)
        import pyarrow as pa
        import pyarrow.parquet as pq
        curr_pd = self._get_pd()

        if isinstance(obj, pa.Table):
            new_table = obj
        elif isinstance(obj, curr_pd.DataFrame):
            new_table = pa.Table.from_pandas(obj)
        elif isinstance(obj, list):
            new_table = pa.Table.from_pylist(obj)
        else:
            new_table = pa.Table.from_pandas(curr_pd.DataFrame([obj]))

        existing_table = pq.read_table(file_path)
        combined_table = pa.concat_tables([existing_table, new_table])
        parquet_path = self._get_table_path(name, 'parquet')
        pq.write_table(combined_table, parquet_path)
        self._emit_mapping(name, parquet_path)
        return [name]

    def update(self, name, obj, on):
        file_path, _ = self._find_existing_table_path(name)
        if not file_path:
            raise FileNotFoundError(f"Table '{name}' does not exist to update.")

        keys = [on] if isinstance(on, str) else list(on)
        if not keys:
            raise ValueError("Update requires at least one key in 'on'.")

        import duckdb
        conn = duckdb.connect()
        curr_pd = self._get_pd()
        import pyarrow as pa

        if isinstance(obj, (curr_pd.DataFrame, pa.Table)):
            stage_df = obj.to_pandas() if isinstance(obj, pa.Table) else obj
        elif isinstance(obj, list):
            stage_df = curr_pd.DataFrame(obj)
        else:
            stage_df = curr_pd.DataFrame([obj])

        safe_file_path = file_path.replace("\\", "/")
        conn.register("stage_df", stage_df)
        conn.execute(f"CREATE TEMP TABLE target_tbl AS SELECT * FROM read_parquet('{safe_file_path}')")

        stage_cols = list(stage_df.columns)
        non_key_cols = [c for c in stage_cols if c not in keys]

        if non_key_cols:
            set_clause = ", ".join([f'"{c}" = s."{c}"' for c in non_key_cols])
            join_cond = " AND ".join([f't."{k}" = s."{k}"' for k in keys])
            conn.execute(f"""
                UPDATE target_tbl AS t
                SET {set_clause}
                FROM stage_df AS s
                WHERE {join_cond}
            """)

        parquet_path = self._get_table_path(name, 'parquet')
        safe_target = parquet_path.replace("\\", "/")
        conn.execute(f"COPY target_tbl TO '{safe_target}' (FORMAT PARQUET)")
        conn.close()

        self._emit_mapping(name, parquet_path)
        return [name]

    def upsert(self, name, obj, on):
        file_path, _ = self._find_existing_table_path(name)
        if not file_path:
            return self.put(name, obj)

        keys = [on] if isinstance(on, str) else list(on)
        if not keys:
            raise ValueError("Upsert requires at least one key in 'on'.")

        import duckdb
        conn = duckdb.connect()
        curr_pd = self._get_pd()
        import pyarrow as pa

        if isinstance(obj, (curr_pd.DataFrame, pa.Table)):
            stage_df = obj.to_pandas() if isinstance(obj, pa.Table) else obj
        elif isinstance(obj, list):
            stage_df = curr_pd.DataFrame(obj)
        else:
            stage_df = curr_pd.DataFrame([obj])

        safe_file_path = file_path.replace("\\", "/")
        conn.register("stage_df", stage_df)
        conn.execute(f"CREATE TEMP TABLE target_tbl AS SELECT * FROM read_parquet('{safe_file_path}')")

        stage_cols = list(stage_df.columns)
        non_key_cols = [c for c in stage_cols if c not in keys]

        join_cond = " AND ".join([f't."{k}" = s."{k}"' for k in keys])
        update_set_clause = ", ".join([f'"{c}" = s."{c}"' for c in non_key_cols])
        insert_cols_clause = ", ".join([f'"{c}"' for c in stage_cols])
        insert_vals_clause = ", ".join([f's."{c}"' for c in stage_cols])

        update_part = f"WHEN MATCHED THEN UPDATE SET {update_set_clause}" if non_key_cols else ""

        conn.execute(f"""
            MERGE INTO target_tbl AS t
            USING stage_df AS s
            ON {join_cond}
            {update_part}
            WHEN NOT MATCHED THEN INSERT ({insert_cols_clause}) VALUES ({insert_vals_clause})
        """)

        parquet_path = self._get_table_path(name, 'parquet')
        safe_target = parquet_path.replace("\\", "/")
        conn.execute(f"COPY target_tbl TO '{safe_target}' (FORMAT PARQUET)")
        conn.close()

        self._emit_mapping(name, parquet_path)
        return [name]

    def tables(self, name=None):
        if name:
            meta_table_name = f"__vura_meta_{name}"
            meta_records = self._read_table_data(meta_table_name)
            if meta_records and meta_records[0].get("manifest"):
                manifest = json.loads(meta_records[0]["manifest"])
                return list(manifest["tables"].keys())
            return [name]

        path_to_check = self.current_storage_path
        if not os.path.exists(path_to_check):
            return []
        return [
            os.path.splitext(f)[0]
            for f in os.listdir(path_to_check)
            if (f.endswith(".parquet") or f.endswith(".arrow")) and not f.startswith("__vura_meta_")
        ]


class StateManager:
    def __init__(self):
        self._store = {}

    def set(self, key, value):
        self._store[key] = value

    def get(self, key, default=None):
        return self._store.get(key, default)

    @property
    def context(self):
        return {
            "storage_path": os.environ.get("VURA_STORAGE_PATH", ""),
            "notebook_id": os.environ.get("VURA_NOTEBOOK_ID", "default"),
            "depth_limit": int(os.environ.get("VURA_DEPTH_LIMIT", "5")),
            "env": dict(os.environ)
        }


class MetricsManager:
    def track(self, name, value, step=None):
        import time
        payload = {"type": "vura_metric", "name": name, "value": value, "step": step, "timestamp": time.time()}
        print(json.dumps(payload), file=sys.stderr)

    def log(self, message, level="INFO"):
        print(f"[{level.upper()}] {message}")

    def preview(self, name, sample):
        import time
        payload = {"type": "vura_preview", "name": name, "sample": sample, "timestamp": time.time()}
        print(json.dumps(payload), file=sys.stderr)


def serve_forever(data, state, metrics, vura_module, vura_io_module):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue

        req_id = request.get('id')
        code = request.get('code', '')
        for key, value in (request.get('env') or {}).items():
            os.environ[key] = '' if value is None else str(value)

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        status = 'ok'
        error_message = None

        exec_globals = {
            'vura': vura_module,
            'vura_io': vura_io_module,
            'data': data,
            'state': state,
            'metrics': metrics
        }
        curr_pd = data._get_pd() if pd is not None else None
        if curr_pd is not None:
            exec_globals['pd'] = curr_pd

        try:
            with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                exec(code, exec_globals)
        except Exception:
            status = 'error'
            error_message = traceback.format_exc()

        response = {
            'id': req_id,
            'status': status,
            'stdout': stdout_buf.getvalue(),
            'stderr': stderr_buf.getvalue(),
        }
        if error_message:
            response['error'] = error_message

        sys.stdout.write(json.dumps(response) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    storage_path = os.environ.get('VURA_STORAGE_PATH')
    if not storage_path:
        print("VURA_STORAGE_PATH not set", file=sys.stderr)
        sys.exit(1)

    data = DataManager(storage_path)
    state = StateManager()
    metrics = MetricsManager()

    import importlib.machinery
    vura_module = types.ModuleType('vura')
    vura_module.__path__ = []
    vura_module.__spec__ = importlib.machinery.ModuleSpec('vura', None, is_package=True)

    vura_io_module = types.ModuleType('vura.io')
    vura_io_module.__path__ = []
    vura_io_module.__spec__ = importlib.machinery.ModuleSpec('vura.io', None, is_package=True)
    vura_io_module.data = data
    vura_io_module.state = state
    vura_io_module.metrics = metrics
    vura_io_module.shred_json = shred_json
    vura_io_module.unshred_json = unshred_json
    vura_io_module.put = data.put
    vura_io_module.get = data.get
    vura_io_module.pack = data.pack
    vura_io_module.unpack = data.unpack
    vura_io_module.tables = data.tables
    vura_io_module.save_table = data.put
    vura_io_module.get_table = data.get
    vura_io_module.save_nested = data.pack
    vura_io_module.load_reconstructed = data.unpack

    vura_module.io = vura_io_module
    vura_module.data = data
    vura_module.state = state
    vura_module.metrics = metrics
    vura_module.put = data.put
    vura_module.get = data.get
    vura_module.pack = data.pack
    vura_module.unpack = data.unpack
    vura_module.tables = data.tables
    vura_module.save_table = data.put
    vura_module.get_table = data.get
    vura_module.save_nested = data.pack
    vura_module.load_reconstructed = data.unpack

    sys.modules['vura'] = vura_module
    sys.modules['vura.io'] = vura_io_module
    sys.modules['vura_io'] = vura_io_module
    sys.modules['vura-io'] = vura_io_module
    sys.modules['vura_bridge'] = vura_io_module

    serve_forever(data, state, metrics, vura_module, vura_io_module)

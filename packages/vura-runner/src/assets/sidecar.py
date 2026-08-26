import contextlib
import io
import json
import os
import sys
import shutil
import tempfile
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
        self._duckdb_conn = None
        self._buffer_map = {}

    def _get_duckdb_conn(self):
        if self._duckdb_conn is None:
            import duckdb
            self._duckdb_conn = duckdb.connect()
        return self._duckdb_conn

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

    def set_storage_path(self, path):
        self.storage_path = path

    @property
    def current_storage_path(self):
        return os.environ.get("VURA_STORAGE_PATH", self.storage_path)

    @property
    def partition_threshold_rows(self):
        env_val = os.environ.get("VURA_PARTITION_THRESHOLD_ROWS")
        if env_val:
            try:
                val = int(env_val)
                if val >= 0:
                    return val
            except ValueError:
                pass
        return 50000

    def _get_table_path(self, table_name, ext):
        return os.path.join(self.current_storage_path, f"{table_name}.{ext}")

    def _find_existing_table_path(self, table_name):
        base_name = table_name.replace('.parquet', '').replace('.arrow', '')
        manifest_path = os.path.join(self.current_storage_path, base_name, 'manifest.json')
        if os.path.exists(manifest_path):
            return manifest_path, 'partitioned'

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
                full_item = os.path.join(self.current_storage_path, f)
                if f_lower == lower_base and os.path.isdir(full_item) and os.path.exists(os.path.join(full_item, 'manifest.json')):
                    return os.path.join(full_item, 'manifest.json'), 'partitioned'
                if f_lower == f"{lower_base}.arrow":
                    return full_item, 'arrow'
                if f_lower == f"{lower_base}.parquet":
                    return full_item, 'parquet'
        return None, None

    def _emit_mapping(self, variable_name, file_path, partitioned=False):
        payload = {"type": "vura_io_mapping", "variable": variable_name, "path": file_path}
        if partitioned:
            payload["partitioned"] = True
        print(json.dumps(payload), file=sys.stderr)

    def _save_manifest_atomically(self, table_name, manifest):
        dir_path = os.path.join(self.current_storage_path, table_name)
        os.makedirs(dir_path, exist_ok=True)
        manifest_path = os.path.join(dir_path, 'manifest.json')
        fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix='manifest.json.tmp.')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, indent=2)
        os.replace(tmp_path, manifest_path)
        return manifest_path

    def _extract_schema_map(self, pyarrow_table):
        schema_map = {}
        for field in pyarrow_table.schema:
            t_str = str(field.type)
            if 'int' in t_str:
                schema_map[field.name] = 'BIGINT'
            elif 'double' in t_str or 'float' in t_str:
                schema_map[field.name] = 'DOUBLE'
            elif 'bool' in t_str:
                schema_map[field.name] = 'BOOLEAN'
            elif 'timestamp' in t_str or 'date' in t_str:
                schema_map[field.name] = 'TIMESTAMP'
            else:
                schema_map[field.name] = 'VARCHAR'
        if not schema_map:
            schema_map['_vura_value'] = 'VARCHAR'
        return schema_map

    def _to_pyarrow_table(self, records):
        curr_pd = self._get_pd()
        import pyarrow as pa
        if isinstance(records, pa.Table):
            return records
        elif isinstance(records, curr_pd.DataFrame):
            return pa.Table.from_pandas(records)
        elif not records:
            df = curr_pd.DataFrame(columns=["_vura_id", "_vura_parent_id", "_vura_index", "_vura_value"])
            return pa.Table.from_pandas(df)
        elif isinstance(records, list):
            try:
                return pa.Table.from_pylist(records)
            except Exception:
                df = curr_pd.DataFrame(records)
                return pa.Table.from_pandas(df)
        else:
            df = curr_pd.DataFrame([records])
            return pa.Table.from_pandas(df)

    def _write_parquet_part(self, table_name, part_name, table):
        import pyarrow.parquet as pq
        dir_path = os.path.join(self.current_storage_path, table_name)
        os.makedirs(dir_path, exist_ok=True)
        part_path = os.path.join(dir_path, part_name)
        pq.write_table(table, part_path)
        return part_path

    def _write_table_data(self, table_name, records):
        table = self._to_pyarrow_table(records)

        if len(table) < self.partition_threshold_rows:
            arrow_path = self._get_table_path(table_name, 'arrow')
            os.makedirs(os.path.dirname(arrow_path), exist_ok=True)
            import pyarrow.feather as feather
            feather.write_feather(table, arrow_path, compression="uncompressed")

            parquet_path = self._get_table_path(table_name, 'parquet')
            if os.path.exists(parquet_path):
                try:
                    os.remove(parquet_path)
                except OSError:
                    pass
            part_dir = os.path.join(self.current_storage_path, table_name)
            if os.path.exists(part_dir) and os.path.isdir(part_dir):
                try:
                    shutil.rmtree(part_dir)
                except OSError:
                    pass

            return arrow_path

        part0 = 'part-0000.parquet'
        self._write_parquet_part(table_name, part0, table)
        schema_map = self._extract_schema_map(table)
        manifest = {
            "version": 1,
            "tableName": table_name,
            "rowCount": len(table),
            "compacted": False,
            "parts": [{"file": part0, "rowCount": len(table)}],
            "schema": schema_map
        }
        manifest_path = self._save_manifest_atomically(table_name, manifest)

        legacy_arrow = self._get_table_path(table_name, 'arrow')
        if os.path.exists(legacy_arrow):
            try:
                os.remove(legacy_arrow)
            except OSError:
                pass
        legacy_parquet = self._get_table_path(table_name, 'parquet')
        if os.path.exists(legacy_parquet):
            try:
                os.remove(legacy_parquet)
            except OSError:
                pass

        return manifest_path

    def _read_table_data(self, table_name):
        file_path, fmt = self._find_existing_table_path(table_name)
        if not file_path:
            return []
        curr_pd = self._get_pd()

        if fmt == 'partitioned':
            dir_path = os.path.dirname(file_path)
            part_files = [os.path.join(dir_path, f) for f in os.listdir(dir_path) if f.endswith('.parquet')]
            import pyarrow.dataset as ds
            dataset = ds.dataset(part_files, format="parquet")
            df = dataset.to_table().to_pandas()
            return df.to_dict(orient="records")

        if fmt == 'arrow':
            import pyarrow.feather as feather
            df = feather.read_feather(file_path)
            return df.to_dict(orient="records")

        df = curr_pd.read_parquet(file_path, engine="pyarrow")
        return df.to_dict(orient="records")

    def pack(self, name, obj):
        self._buffer_map.pop(name, None)
        tables, manifest, table_names = shred_json(name, obj)
        self._manifests[name] = manifest

        for table_name, records in tables.items():
            self._buffer_map.pop(table_name, None)
            file_path = self._write_table_data(table_name, records)
            is_part = file_path.endswith('manifest.json')
            self._emit_mapping(table_name, file_path, is_part)
            if table_name.startswith(f"{name}_"):
                short_key = table_name[len(name) + 1:]
                if short_key:
                    self._emit_mapping(short_key, file_path, is_part)

        meta_table_name = f"__vura_meta_{name}"
        meta_records = [{"manifest": json.dumps(manifest)}]
        self._write_table_data(meta_table_name, meta_records)

        root_path, root_fmt = self._find_existing_table_path(name)
        if not root_path:
            root_path = self._get_table_path(name, 'parquet')
        self._emit_mapping(name, root_path, root_fmt == 'partitioned')
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
        self._buffer_map.pop(name, None)
        curr_pd = self._get_pd()
        import pyarrow as pa

        if isinstance(obj, (curr_pd.DataFrame, pa.Table)):
            file_path = self._write_table_data(name, obj)
            self._emit_mapping(name, file_path, file_path.endswith('manifest.json'))
            return [name]

        is_nested = False
        if isinstance(obj, list):
            is_nested = any(isinstance(item, (dict, list)) for item in obj)
        elif isinstance(obj, dict):
            is_nested = any(isinstance(v, (dict, list)) for v in obj.values())

        if is_nested:
            return self.pack(name, obj)

        records = obj if isinstance(obj, list) else [obj]
        file_path = self._write_table_data(name, records)
        self._emit_mapping(name, file_path, file_path.endswith('manifest.json'))
        return [name]

    def get(self, name):
        self.flush(name)
        meta_table_name = f"__vura_meta_{name}"
        meta_path, _ = self._find_existing_table_path(meta_table_name)
        if meta_path or name in self._manifests:
            return self.unpack(name)

        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            raise FileNotFoundError(f"Table '{name}' not found.")

        if fmt == 'partitioned':
            dir_path = os.path.dirname(file_path)
            part_files = [os.path.join(dir_path, f) for f in os.listdir(dir_path) if f.endswith('.parquet')]
            import pyarrow.dataset as ds
            dataset = ds.dataset(part_files, format="parquet")
            return dataset.to_table().to_pandas()

        curr_pd = self._get_pd()
        if fmt == 'arrow':
            import pyarrow.feather as feather
            return feather.read_feather(file_path)
        return curr_pd.read_parquet(file_path, engine="pyarrow")

    def count(self, name):
        self.flush(name)
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            return 0
        if fmt == 'partitioned':
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    manifest = json.load(f)
                    return manifest.get("rowCount", 0)
            except Exception:
                return 0
        if fmt == 'arrow':
            import pyarrow.feather as feather
            return len(feather.read_feather(file_path))
        import pyarrow.parquet as pq
        return pq.ParquetFile(file_path).metadata.num_rows

    def stream(self, name, batch_size=50000, format='dict'):
        self.flush(name)
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            return

        if fmt == 'partitioned':
            dir_path = os.path.dirname(file_path)
            part_files = [os.path.join(dir_path, f) for f in os.listdir(dir_path) if f.endswith('.parquet')]
            import pyarrow.dataset as ds
            dataset = ds.dataset(part_files, format="parquet")
            for batch in dataset.to_batches(batch_size=batch_size):
                if format == 'arrow':
                    yield batch
                elif format == 'dataframe':
                    curr_pd = self._get_pd()
                    yield curr_pd.DataFrame(batch.to_pydict())
                else:
                    yield batch.to_pylist()
            return

        if fmt == 'arrow':
            import pyarrow.feather as feather
            df = feather.read_feather(file_path)
            import pyarrow as pa
            table = pa.Table.from_pandas(df)
            for batch in table.to_batches(max_chunksize=batch_size):
                if format == 'arrow':
                    yield batch
                elif format == 'dataframe':
                    curr_pd = self._get_pd()
                    yield curr_pd.DataFrame(batch.to_pydict())
                else:
                    yield batch.to_pylist()
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
        import pyarrow as pa
        table = self._to_pyarrow_table(obj)
        if len(table) == 0:
            return [name]

        buf = self._buffer_map.get(name)
        if buf is None:
            buf = table
        else:
            buf = pa.concat_tables([buf, table], promote_options="permissive")
        self._buffer_map[name] = buf

        if len(buf) >= self.partition_threshold_rows:
            self.flush(name)
        return [name]

    def flush(self, name):
        buffered = self._buffer_map.pop(name, None)
        if buffered is None or len(buffered) == 0:
            return [name]

        file_path, fmt = self._find_existing_table_path(name)

        if not file_path:
            if len(buffered) < self.partition_threshold_rows:
                written_path = self._write_table_data(name, buffered)
                self._emit_mapping(name, written_path)
                return [name]
            else:
                part0 = 'part-0000.parquet'
                self._write_parquet_part(name, part0, buffered)
                schema_map = self._extract_schema_map(buffered)
                manifest = {
                    "version": 1,
                    "tableName": name,
                    "rowCount": len(buffered),
                    "compacted": False,
                    "parts": [{"file": part0, "rowCount": len(buffered)}],
                    "schema": schema_map
                }
                manifest_path = self._save_manifest_atomically(name, manifest)
                self._emit_mapping(name, manifest_path, True)
                return [name]

        if fmt == 'partitioned':
            with open(file_path, 'r', encoding='utf-8') as f:
                manifest = json.load(f)
            next_part_index = len(manifest.get("parts", []))
            part_name = f"part-{next_part_index:04d}.parquet"
            self._write_parquet_part(name, part_name, buffered)

            manifest["parts"].append({"file": part_name, "rowCount": len(buffered)})
            manifest["rowCount"] += len(buffered)
            schema_map = self._extract_schema_map(buffered)
            manifest.setdefault("schema", {}).update(schema_map)

            manifest_path = self._save_manifest_atomically(name, manifest)
            self._emit_mapping(name, manifest_path, True)
            return [name]

        # Single file case (.arrow or .parquet)
        import pyarrow as pa
        curr_pd = self._get_pd()
        if fmt == 'arrow':
            import pyarrow.feather as feather
            existing_df = feather.read_feather(file_path)
            existing_table = pa.Table.from_pandas(existing_df)
        else:
            import pyarrow.parquet as pq
            existing_table = pq.read_table(file_path)

        combined_table = pa.concat_tables([existing_table, buffered], promote_options="permissive")
        total_rows = len(combined_table)

        if total_rows < self.partition_threshold_rows:
            written_path = self._write_table_data(name, combined_table)
            self._emit_mapping(name, written_path)
            return [name]

        # Migrate single file to partitioned table
        part0 = 'part-0000.parquet'
        part1 = 'part-0001.parquet'
        self._write_parquet_part(name, part0, existing_table)
        self._write_parquet_part(name, part1, buffered)

        schema_map = self._extract_schema_map(combined_table)
        manifest = {
            "version": 1,
            "tableName": name,
            "rowCount": total_rows,
            "compacted": False,
            "parts": [
                {"file": part0, "rowCount": len(existing_table)},
                {"file": part1, "rowCount": len(buffered)}
            ],
            "schema": schema_map
        }
        manifest_path = self._save_manifest_atomically(name, manifest)

        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                pass

        self._emit_mapping(name, manifest_path, True)
        return [name]

    def flush_all(self):
        for name in list(self._buffer_map.keys()):
            self.flush(name)

    def update(self, name, obj, on):
        self.flush(name)
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            raise FileNotFoundError(f"Table '{name}' does not exist to update.")

        keys = [on] if isinstance(on, str) else list(on)
        if not keys:
            raise ValueError("Update requires at least one key in 'on'.")

        existing_records = self._read_table_data(name)
        curr_pd = self._get_pd()
        target_df = curr_pd.DataFrame(existing_records)

        if isinstance(obj, curr_pd.DataFrame):
            stage_df = obj
        elif hasattr(obj, 'to_pandas'):
            stage_df = obj.to_pandas()
        elif isinstance(obj, list):
            stage_df = curr_pd.DataFrame(obj)
        else:
            stage_df = curr_pd.DataFrame([obj])

        target_df.set_index(keys, inplace=False, drop=False)
        stage_df.set_index(keys, inplace=False, drop=False)

        updated_df = target_df.copy()
        for idx, row in stage_df.iterrows():
            cond = True
            for k in keys:
                cond = cond & (updated_df[k] == row[k])
            updated_df.loc[cond, stage_df.columns] = row

        updated_records = updated_df.to_dict(orient="records")
        file_path = self._write_table_data(name, updated_records)
        self._emit_mapping(name, file_path, file_path.endswith('manifest.json'))
        return [name]

    def upsert(self, name, obj, on):
        self.flush(name)
        file_path, fmt = self._find_existing_table_path(name)
        if not file_path:
            return self.put(name, obj)

        keys = [on] if isinstance(on, str) else list(on)
        if not keys:
            raise ValueError("Upsert requires at least one key in 'on'.")

        existing_records = self._read_table_data(name)
        curr_pd = self._get_pd()
        target_df = curr_pd.DataFrame(existing_records)

        if isinstance(obj, curr_pd.DataFrame):
            stage_df = obj
        elif hasattr(obj, 'to_pandas'):
            stage_df = obj.to_pandas()
        elif isinstance(obj, list):
            stage_df = curr_pd.DataFrame(obj)
        else:
            stage_df = curr_pd.DataFrame([obj])

        for idx, row in stage_df.iterrows():
            cond = True
            for k in keys:
                cond = cond & (target_df[k] == row[k])
            if cond.any():
                target_df.loc[cond, stage_df.columns] = row
            else:
                target_df = curr_pd.concat([target_df, curr_pd.DataFrame([row])], ignore_index=True)

        updated_records = target_df.to_dict(orient="records")
        file_path = self._write_table_data(name, updated_records)
        self._emit_mapping(name, file_path, file_path.endswith('manifest.json'))
        return [name]

    def tables(self, name=None):
        self.flush_all()
        if name:
            meta_table_name = f"__vura_meta_{name}"
            meta_records = self._read_table_data(meta_table_name)
            if meta_records and meta_records[0].get("manifest"):
                manifest = json.loads(meta_records[0]["manifest"])
                return list(manifest["tables"].keys())
            return [name]

        if not os.path.exists(self.current_storage_path):
            return []
        res = []
        for f in os.listdir(self.current_storage_path):
            if f.startswith("__vura_meta_"):
                continue
            full = os.path.join(self.current_storage_path, f)
            if os.path.isdir(full) and os.path.exists(os.path.join(full, 'manifest.json')):
                res.append(f)
            elif f.endswith(".parquet") or f.endswith(".arrow"):
                res.append(os.path.splitext(f)[0])
        return res


class StateManager:
    def __init__(self):
        self._store = {}
        self._current_ctx = {}

    def set(self, key, value):
        self._store[key] = value

    def get(self, key, default=None):
        return self._store.get(key, default)

    def set_request_ctx(self, ctx):
        self._current_ctx = ctx or {}

    @property
    def context(self):
        depth_limit = self._current_ctx.get("depthLimit")
        if depth_limit is None:
            depth_limit = int(os.environ.get("VURA_DEPTH_LIMIT", "5"))
        return {
            "storage_path": os.environ.get("VURA_STORAGE_PATH", ""),
            "notebook_id": os.environ.get("VURA_NOTEBOOK_ID", "default"),
            "depth_limit": depth_limit,
            "token": self._current_ctx.get("token", ""),
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
    is_executing = False

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception:
            continue

        req_id = request.get('id')

        if is_executing:
            response = {
                'id': req_id,
                'status': 'error',
                'stdout': '',
                'stderr': '',
                'error': 'Sidecar process is busy with another request'
            }
            sys.stdout.write(json.dumps(response) + '\n')
            sys.stdout.flush()
            continue

        is_executing = True
        try:
            code = request.get('code', '')
            ctx = request.get('ctx') or {}
            state.set_request_ctx(ctx)
            if ctx.get('storagePath'):
                data.storage_path = ctx['storagePath']
                os.environ['VURA_STORAGE_PATH'] = ctx['storagePath']

            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            status = 'ok'
            error_message = None

            exec_globals = {
                'vura': vura_module,
                'vura_io': vura_io_module,
                'data': data,
                'state': state,
                'metrics': metrics,
                'ctx': ctx
            }
            curr_pd = data._get_pd() if pd is not None else None
            if curr_pd is not None:
                exec_globals['pd'] = curr_pd

            try:
                with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                    exec(code, exec_globals)
                data.flush_all()
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
        finally:
            is_executing = False


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
    vura_io_module.flush = data.flush
    vura_io_module.flush_all = data.flush_all
    vura_io_module.append = data.append

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
    vura_module.flush = data.flush
    vura_module.flush_all = data.flush_all
    vura_module.append = data.append

    sys.modules['vura'] = vura_module
    sys.modules['vura.io'] = vura_io_module
    sys.modules['vura_io'] = vura_io_module
    sys.modules['vura-io'] = vura_io_module
    sys.modules['vura_bridge'] = vura_io_module

    serve_forever(data, state, metrics, vura_module, vura_io_module)

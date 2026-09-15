import os
import json
import sys
import shutil
import tempfile
from .shredder import shred_json, unshred_json

try:
    import pandas as pd
except ImportError:
    pd = None

try:
    import duckdb
except ImportError:
    duckdb = None

class DataManager:
    def __init__(self, storage_path=None):
        self.storage_path = storage_path or os.environ.get("VURA_STORAGE_PATH", os.getcwd())
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
                raise ImportError("pandas and pyarrow are required for vura.io operations. Install with: pip install pandas pyarrow")
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

    def _check_test_pause_hook(self, hook_name="VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE"):
        if os.environ.get(hook_name):
            sentinel = "PAUSED_BEFORE_PARTS_LOG_APPEND" if hook_name == "VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND" else "PAUSED_BEFORE_MANIFEST_WRITE"
            import time
            out_stream = sys.__stderr__ if sys.__stderr__ is not None else sys.stderr
            out_stream.write(f"[VURA_TEST_HOOK] {sentinel}\n")
            out_stream.flush()
            while True:
                time.sleep(0.1)

    def _get_manifest_parts(self, dir_path):
        parts_path = os.path.join(dir_path, 'manifest-parts.jsonl')
        if not os.path.exists(parts_path):
            return []
        with open(parts_path, 'r', encoding='utf-8') as f:
            lines = [line.strip() for line in f if line.strip()]
        return [json.loads(line) for line in lines]

    def _append_manifest_part(self, table_name, part_entry):
        self._check_test_pause_hook("VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND")
        dir_path = os.path.join(self.current_storage_path, table_name)
        os.makedirs(dir_path, exist_ok=True)
        parts_path = os.path.join(dir_path, 'manifest-parts.jsonl')
        with open(parts_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(part_entry) + '\n')

    def _save_manifest_parts_atomically(self, table_name, parts):
        self._check_test_pause_hook("VURA_TEST_PAUSE_BEFORE_PARTS_LOG_APPEND")
        dir_path = os.path.join(self.current_storage_path, table_name)
        os.makedirs(dir_path, exist_ok=True)
        parts_path = os.path.join(dir_path, 'manifest-parts.jsonl')
        fd, tmp_path = tempfile.mkstemp(dir=dir_path, prefix='manifest-parts.jsonl.tmp.')
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            for p in parts:
                f.write(json.dumps(p) + '\n')
        os.replace(tmp_path, parts_path)
        return parts_path

    def _save_manifest_atomically(self, table_name, manifest):
        self._check_test_pause_hook("VURA_TEST_PAUSE_BEFORE_MANIFEST_WRITE")
        self._check_test_pause_hook()
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
        self._save_manifest_parts_atomically(table_name, [{"file": part0, "rowCount": len(table)}])
        schema_map = self._extract_schema_map(table)
        manifest = {
            "version": 1,
            "tableName": table_name,
            "rowCount": len(table),
            "compacted": False,
            "nextPartIndex": 1,
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
            parts = self._get_manifest_parts(dir_path)
            if not parts:
                return []
            part_files = [os.path.join(dir_path, p['file']) for p in parts]
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
            parts = self._get_manifest_parts(dir_path)
            if not parts:
                return
            part_files = [os.path.join(dir_path, p['file']) for p in parts]
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
            parts = self._get_manifest_parts(dir_path)
            if not parts:
                return
            part_files = [os.path.join(dir_path, p['file']) for p in parts]
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
                table_buf = self._to_pyarrow_table(buffered)
                self._write_parquet_part(name, part0, table_buf)
                self._save_manifest_parts_atomically(name, [{"file": part0, "rowCount": len(table_buf)}])
                schema_map = self._extract_schema_map(table_buf)
                manifest = {
                    "version": 1,
                    "tableName": name,
                    "rowCount": len(table_buf),
                    "compacted": False,
                    "nextPartIndex": 1,
                    "schema": schema_map
                }
                manifest_path = self._save_manifest_atomically(name, manifest)
                self._emit_mapping(name, manifest_path, True)
                return [name]

        if fmt == 'partitioned':
            with open(file_path, 'r', encoding='utf-8') as f:
                manifest = json.load(f)
            next_part_index = manifest.get("nextPartIndex", 0)
            part_name = f"part-{next_part_index:04d}.parquet"
            table_buf = self._to_pyarrow_table(buffered)
            self._write_parquet_part(name, part_name, table_buf)
            self._append_manifest_part(name, {"file": part_name, "rowCount": len(table_buf)})

            manifest["rowCount"] += len(table_buf)
            manifest["nextPartIndex"] = next_part_index + 1
            schema_map = self._extract_schema_map(table_buf)
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

        table_buf = self._to_pyarrow_table(buffered)
        combined_table = pa.concat_tables([existing_table, table_buf], promote_options="permissive")
        total_rows = len(combined_table)

        if total_rows < self.partition_threshold_rows:
            written_path = self._write_table_data(name, combined_table)
            self._emit_mapping(name, written_path)
            return [name]

        # Migrate single file to partitioned table
        part0 = 'part-0000.parquet'
        part1 = 'part-0001.parquet'
        self._write_parquet_part(name, part0, existing_table)
        self._write_parquet_part(name, part1, table_buf)
        self._save_manifest_parts_atomically(name, [
            {"file": part0, "rowCount": len(existing_table)},
            {"file": part1, "rowCount": len(table_buf)}
        ])

        schema_map = self._extract_schema_map(combined_table)
        manifest = {
            "version": 1,
            "tableName": name,
            "rowCount": total_rows,
            "compacted": False,
            "nextPartIndex": 2,
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

data = DataManager()

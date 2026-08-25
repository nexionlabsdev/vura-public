import os
import json
import sys
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
            is_nested = any(isinstance(item, (dict, list)) for item in obj)
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
        conn = self._get_duckdb_conn()
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
        conn.execute(f"CREATE OR REPLACE TEMP TABLE target_tbl AS SELECT * FROM read_parquet('{safe_file_path}')")

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
        conn = self._get_duckdb_conn()
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
        conn.execute(f"CREATE OR REPLACE TEMP TABLE target_tbl AS SELECT * FROM read_parquet('{safe_file_path}')")

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

        if not os.path.exists(self.current_storage_path):
            return []
        return [
            os.path.splitext(f)[0]
            for f in os.listdir(self.current_storage_path)
            if (f.endswith(".parquet") or f.endswith(".arrow")) and not f.startswith("__vura_meta_")
        ]

data = DataManager()


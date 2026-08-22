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

    def _get_parquet_path(self, table_name):
        return os.path.join(self.storage_path, f"{table_name}.parquet")

    def _emit_mapping(self, variable_name, file_path):
        print(json.dumps({"type": "vura_io_mapping", "variable": variable_name, "path": file_path}), file=sys.stderr)

    def _write_table_parquet(self, table_name, records):
        curr_pd = self._get_pd()
        file_path = self._get_parquet_path(table_name)
        if not records:
            df = curr_pd.DataFrame(columns=["_vura_id", "_vura_parent_id", "_vura_index", "_vura_value"])
        else:
            df = curr_pd.DataFrame(records)
        df.to_parquet(file_path, engine="pyarrow")

    def _read_table_parquet(self, table_name):
        curr_pd = self._get_pd()
        file_path = self._get_parquet_path(table_name)
        if not os.path.exists(file_path):
            return []
        df = curr_pd.read_parquet(file_path, engine="pyarrow")
        return df.to_dict(orient="records")

    def pack(self, name, obj):
        tables, manifest, table_names = shred_json(name, obj)
        self._manifests[name] = manifest

        for table_name, records in tables.items():
            self._write_table_parquet(table_name, records)

        meta_table_name = f"__vura_meta_{name}"
        meta_records = [{"manifest": json.dumps(manifest)}]
        self._write_table_parquet(meta_table_name, meta_records)

        root_path = self._get_parquet_path(name)
        self._emit_mapping(name, root_path)
        return table_names

    def unpack(self, name):
        manifest = self._manifests.get(name)
        if not manifest:
            meta_table_name = f"__vura_meta_{name}"
            meta_records = self._read_table_parquet(meta_table_name)
            if not meta_records or not meta_records[0].get("manifest"):
                raise FileNotFoundError(f"Dataset metadata for '{name}' not found.")
            manifest = json.loads(meta_records[0]["manifest"])
            self._manifests[name] = manifest

        tables = {}
        for table_name in manifest["tables"].keys():
            tables[table_name] = self._read_table_parquet(table_name)

        return unshred_json(manifest, tables)

    def put(self, name, obj):
        curr_pd = self._get_pd()
        if isinstance(obj, curr_pd.DataFrame):
            file_path = self._get_parquet_path(name)
            obj.to_parquet(file_path, engine="pyarrow")
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
        self._write_table_parquet(name, records)
        file_path = self._get_parquet_path(name)
        self._emit_mapping(name, file_path)
        return [name]

    def get(self, name):
        meta_table_name = f"__vura_meta_{name}"
        meta_path = self._get_parquet_path(meta_table_name)
        if os.path.exists(meta_path) or name in self._manifests:
            return self.unpack(name)

        curr_pd = self._get_pd()
        file_path = self._get_parquet_path(name)
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"Table '{name}' not found.")
        return curr_pd.read_parquet(file_path, engine="pyarrow")

    def tables(self, name=None):
        if name:
            meta_table_name = f"__vura_meta_{name}"
            meta_records = self._read_table_parquet(meta_table_name)
            if meta_records and meta_records[0].get("manifest"):
                manifest = json.loads(meta_records[0]["manifest"])
                return list(manifest["tables"].keys())
            return [name]

        if not os.path.exists(self.storage_path):
            return []
        return [
            os.path.splitext(f)[0]
            for f in os.listdir(self.storage_path)
            if f.endswith(".parquet") and not f.startswith("__vura_meta_")
        ]

data = DataManager()

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
        if isinstance(records, curr_pd.DataFrame):
            df = records
        elif not records:
            df = curr_pd.DataFrame(columns=["_vura_id", "_vura_parent_id", "_vura_index", "_vura_value"])
        else:
            df = curr_pd.DataFrame(records)

        parquet_path = self._get_table_path(table_name, 'parquet')
        df.to_parquet(parquet_path, engine="pyarrow")
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
            self._write_table_data(table_name, records)
            parquet_path = self._get_table_path(table_name, 'parquet')
            self._emit_mapping(table_name, parquet_path)
            if table_name.startswith(f"{name}_"):
                short_key = table_name[len(name) + 1:]
                if short_key:
                    self._emit_mapping(short_key, parquet_path)

        meta_table_name = f"__vura_meta_{name}"
        meta_records = [{"manifest": json.dumps(manifest)}]
        self._write_table_data(meta_table_name, meta_records)

        root_parquet_path = self._get_table_path(name, 'parquet')
        self._emit_mapping(name, root_parquet_path)
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
        if isinstance(obj, curr_pd.DataFrame):
            self._write_table_data(name, obj)
            parquet_path = self._get_table_path(name, 'parquet')
            self._emit_mapping(name, parquet_path)
            return [name]

        is_nested = False
        if isinstance(obj, list):
            is_nested = any(isinstance(item, (dict, list)) for item in obj)
        elif isinstance(obj, dict):
            is_nested = any(isinstance(v, (dict, list)) for v in obj.values())

        if is_nested:
            return self.pack(name, obj)

        records = obj if isinstance(obj, list) else [obj]
        self._write_table_data(name, records)
        parquet_path = self._get_table_path(name, 'parquet')
        self._emit_mapping(name, parquet_path)
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

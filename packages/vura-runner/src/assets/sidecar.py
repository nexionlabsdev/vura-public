import contextlib
import io
import json
import os
import sys
import traceback
import pandas as pd

class VuraBridgeLibrary:
    def __init__(self, storage_path):
        self.storage_path = storage_path

    def save(self, variable_name, df):
        if hasattr(self, 'save_automated') and isinstance(df, (dict, list)):
            depth_limit = int(os.environ.get('VURA_DEPTH_LIMIT', '5'))
            return self.save_automated(variable_name, df, depth_limit)

        if not isinstance(df, pd.DataFrame):
            raise ValueError("Only pandas DataFrames are supported.")
        file_path = os.path.join(self.storage_path, f"{variable_name}.parquet")
        df.to_parquet(file_path, engine='pyarrow')
        # Print a specific marker so the Extension Host can parse it
        print(json.dumps({"type": "vura_bridge_mapping", "variable": variable_name, "path": file_path}), file=sys.stderr)

    def load(self, variable_name):
        """Load a saved parquet table as a pandas DataFrame. Alias: get_table()."""
        file_path = os.path.join(self.storage_path, f"{variable_name}.parquet")
        if not os.path.exists(file_path):
            raise FileNotFoundError(
                f"Table '{variable_name}' not found. "
                f"Available tables: {self.list_tables()}"
            )
        return pd.read_parquet(file_path, engine='pyarrow')

    # Friendly alias — many users naturally write vura_bridge.save_table(...)
    def save_table(self, variable_name, df):
        """Alias for save(). Saves a DataFrame (or dict/list) as a parquet table."""
        return self.save(variable_name, df)

    # Friendly alias — many users naturally write vura_bridge.get_table(...)
    def get_table(self, variable_name):
        """Alias for load(). Returns a pandas DataFrame for the named table."""
        return self.load(variable_name)

    def save_nested(self, variable_name, data):
        """Alias for save() with dict/list — auto-shreds nested objects into relational parquet tables."""
        return self.save(variable_name, data)

    def saveNested(self, variable_name, data):
        """camelCase alias for save_nested()."""
        return self.save_nested(variable_name, data)

    def loadReconstructed(self, variable_name):
        """camelCase alias for load_reconstructed()."""
        return self.load_reconstructed(variable_name)

    def list_tables(self):
        """Return a list of table names currently saved in the shared storage."""
        return [
            os.path.splitext(f)[0]
            for f in os.listdir(self.storage_path)
            if f.endswith('.parquet')
        ]

    def query(self, sql):
        """Run a DuckDB SQL query across all parquet files in storage.
        Tables are referenced by their file name without extension.
        Example: vura_bridge.query("SELECT * FROM my_table WHERE col > 10")
        """
        try:
            import duckdb
        except ImportError:
            raise ImportError("duckdb is required for vura_bridge.query(). Install it with: pip install duckdb")

        con = duckdb.connect()
        # Register every parquet file as a view
        for f in os.listdir(self.storage_path):
            if f.endswith('.parquet'):
                table_name = os.path.splitext(f)[0]
                parquet_path = os.path.join(self.storage_path, f)
                con.execute(f"CREATE VIEW \"{table_name}\" AS SELECT * FROM read_parquet('{parquet_path}')")

        result = con.execute(sql).fetchdf()
        con.close()
        return result

    def save_automated(self, variable_name, data, depth_limit=5):
        import uuid

        tables = {}

        def traverse(items, current_name, parent_id, depth):
            if depth > depth_limit:
                return

            if current_name not in tables:
                tables[current_name] = []

            for item in items:
                if not isinstance(item, dict):
                    continue

                row_id = str(uuid.uuid4())
                flattened_row = {"Vura_ID": row_id}
                if parent_id:
                    flattened_row["Vura_Parent_ID"] = parent_id

                metadata = {"children": {}}

                for key, value in item.items():
                    if isinstance(value, (dict, list)):
                        child_table_name = f"{current_name}_{key}"
                        metadata["children"][key] = {
                            "type": "array" if isinstance(value, list) else "object",
                            "table": child_table_name
                        }

                        if isinstance(value, list):
                            traverse(value, child_table_name, row_id, depth + 1)
                        else:
                            traverse([value], child_table_name, row_id, depth + 1)
                    else:
                        flattened_row[key] = value

                flattened_row["_vura_metadata"] = json.dumps(metadata)
                tables[current_name].append(flattened_row)

        data_list = data if isinstance(data, list) else [data]
        traverse(data_list, variable_name, None, 1)

        for table_name, records in tables.items():
            if not records:
                continue
            df = pd.DataFrame(records)
            file_path = os.path.join(self.storage_path, f"{table_name}.parquet")
            df.to_parquet(file_path, engine='pyarrow')
            if table_name == variable_name:
                print(json.dumps({"type": "vura_bridge_mapping", "variable": variable_name, "path": file_path}), file=sys.stderr)

    def load_reconstructed(self, variable_name):
        root_file_path = os.path.join(self.storage_path, f"{variable_name}.parquet")
        if not os.path.exists(root_file_path):
            raise FileNotFoundError(f"Parquet file for variable {variable_name} not found.")

        def load_table(table_name):
            path = os.path.join(self.storage_path, f"{table_name}.parquet")
            if not os.path.exists(path):
                return []
            df = pd.read_parquet(path, engine='pyarrow')
            # Handle pandas float NaN vs None if needed, but to_dict handles most
            return df.to_dict('records')

        def resolve_children(records):
            resolved = []
            for record in records:
                rec = dict(record)
                vura_id = rec.pop("Vura_ID", None)
                rec.pop("Vura_Parent_ID", None)

                meta_str = rec.pop("_vura_metadata", None)
                metadata = None
                if meta_str and isinstance(meta_str, str):
                    try:
                        metadata = json.loads(meta_str)
                    except:
                        pass

                if metadata and "children" in metadata:
                    for key, child_info in metadata["children"].items():
                        child_table_name = child_info["table"]
                        child_records = load_table(child_table_name)
                        # filter
                        my_children = [c for c in child_records if c.get("Vura_Parent_ID") == vura_id]
                        resolved_children = resolve_children(my_children)

                        if child_info["type"] == "object":
                            rec[key] = resolved_children[0] if resolved_children else None
                        else:
                            rec[key] = resolved_children
                resolved.append(rec)
            return resolved

        root_records = load_table(variable_name)
        return resolve_children(root_records)

def serve_forever(vura_bridge):
    """
    Persistent worker loop: reads one NDJSON request per stdin line, executes
    the code in a brand-new globals dict every time (so no variable state
    ever survives between cell runs — only the process and its already-loaded
    imports, e.g. pandas, stay warm), and writes one NDJSON response per line.

    Request:  {"id": str, "code": str, "env": {"VURA_DATAVERSE_TOKEN": str, "VURA_DEPTH_LIMIT": str}}
    Response: {"id": str, "status": "ok"|"error", "stdout": str, "stderr": str, "error"?: str}
    """
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

        # Fresh globals dict per execution — this is the isolation boundary.
        # Nothing a cell assigns at top level (or via `global`) can be seen by
        # the next request, even though the interpreter process is reused.
        exec_globals = {'vura_bridge': vura_bridge, 'pd': pd}
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

    vura_bridge = VuraBridgeLibrary(storage_path)
    # Make vura_bridge importable both as a global AND via `import vura_bridge`
    sys.modules['vura_bridge'] = vura_bridge  # type: ignore[assignment]

    serve_forever(vura_bridge)

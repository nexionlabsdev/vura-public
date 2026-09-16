import uuid
import json

def shred_json(dataset_name, obj):
    tables = {}
    manifest = {
        "dataset_name": dataset_name,
        "root_table": dataset_name,
        "is_root_array": isinstance(obj, list),
        "tables": {}
    }

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
                    row_id = str(uuid.uuid4())
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
        row_id = str(uuid.uuid4())
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
    def reconstruct_node(table_name, parent_id):
        meta = manifest["tables"].get(table_name)
        if not meta:
            return None

        raw_rows = tables.get(table_name, [])
        table_rows = [
            r for r in raw_rows
            if (not r.get("_vura_parent_id") or r.get("_vura_parent_id") == "null" if parent_id is None else r.get("_vura_parent_id") == parent_id)
        ]

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

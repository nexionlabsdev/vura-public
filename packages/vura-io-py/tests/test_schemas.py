import unittest
from vura.io.schemas import (
    get_schema_dir_path,
    load_schemas,
    validate_object,
    SIDECAR_REQUEST_SCHEMA,
    SIDECAR_RESPONSE_SCHEMA,
    TABLE_MANIFEST_SCHEMA,
    HAS_JSONSCHEMA,
)
if HAS_JSONSCHEMA:
    import jsonschema


class TestSchemas(unittest.TestCase):
    def test_get_schema_dir_path(self):
        path = get_schema_dir_path()
        self.assertTrue(path.exists())
        self.assertTrue((path / "sidecar-request.schema.json").exists())

    def test_load_schemas(self):
        req, res, manifest = load_schemas()
        self.assertEqual(req.get("$id"), "vura://sidecar/request.schema.json")
        self.assertEqual(res.get("$id"), "vura://sidecar/response.schema.json")
        self.assertEqual(manifest.get("$id"), "vura://table/manifest.schema.json")

    def test_module_level_schemas_loaded(self):
        self.assertEqual(SIDECAR_REQUEST_SCHEMA["$id"], "vura://sidecar/request.schema.json")
        self.assertEqual(SIDECAR_RESPONSE_SCHEMA["$id"], "vura://sidecar/response.schema.json")
        self.assertEqual(TABLE_MANIFEST_SCHEMA["$id"], "vura://table/manifest.schema.json")

    def test_schema_validation(self):
        valid_req = {"id": "req-1", "code": "print('hello')"}
        validate_object(valid_req, SIDECAR_REQUEST_SCHEMA)

        if HAS_JSONSCHEMA:
            invalid_req = {"id": "req-1"}
            with self.assertRaises(jsonschema.ValidationError):
                validate_object(invalid_req, SIDECAR_REQUEST_SCHEMA)

        valid_res = {"id": "req-1", "status": "ok", "stdout": "hello", "stderr": ""}
        validate_object(valid_res, SIDECAR_RESPONSE_SCHEMA)

        valid_manifest = {
            "version": 1,
            "tableName": "users",
            "rowCount": 100,
            "parts": [{"file": "users_1.parquet", "rowCount": 100}],
            "schema": {"id": "INTEGER", "name": "VARCHAR"},
        }
        validate_object(valid_manifest, TABLE_MANIFEST_SCHEMA)

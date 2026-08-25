import pytest
import jsonschema
from vura.io.schemas import (
    get_schema_dir_path,
    load_schemas,
    validate_object,
    SIDECAR_REQUEST_SCHEMA,
    SIDECAR_RESPONSE_SCHEMA,
    TABLE_MANIFEST_SCHEMA,
)


def test_get_schema_dir_path():
    path = get_schema_dir_path()
    assert path.exists()
    assert (path / "sidecar-request.schema.json").exists()


def test_load_schemas():
    req, res, manifest = load_schemas()
    assert req.get("$id") == "vura://sidecar/request.schema.json"
    assert res.get("$id") == "vura://sidecar/response.schema.json"
    assert manifest.get("$id") == "vura://table/manifest.schema.json"


def test_module_level_schemas_loaded():
    assert SIDECAR_REQUEST_SCHEMA["$id"] == "vura://sidecar/request.schema.json"
    assert SIDECAR_RESPONSE_SCHEMA["$id"] == "vura://sidecar/response.schema.json"
    assert TABLE_MANIFEST_SCHEMA["$id"] == "vura://table/manifest.schema.json"


def test_schema_validation():
    valid_req = {"id": "req-1", "code": "print('hello')"}
    validate_object(valid_req, SIDECAR_REQUEST_SCHEMA)

    invalid_req = {"id": "req-1"}
    with pytest.raises(jsonschema.ValidationError):
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

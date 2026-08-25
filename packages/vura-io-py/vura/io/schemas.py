import json
from pathlib import Path
from typing import Any, Dict, Tuple
import jsonschema


def get_schema_dir_path() -> Path:
    # Check relative locations from current file and repository root
    current_file = Path(__file__).resolve()
    candidates = [
        current_file.parents[4] / "schemas",
        current_file.parents[3] / "schemas",
        Path.cwd() / "schemas",
    ]

    for candidate in candidates:
        if candidate.exists() and (candidate / "sidecar-request.schema.json").exists():
            return candidate

    raise FileNotFoundError(f"Schemas directory not found. Checked: {candidates}")


def load_schemas() -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    schema_dir = get_schema_dir_path()

    with open(schema_dir / "sidecar-request.schema.json", "r", encoding="utf-8") as f:
        sidecar_request = json.load(f)

    with open(schema_dir / "sidecar-response.schema.json", "r", encoding="utf-8") as f:
        sidecar_response = json.load(f)

    with open(schema_dir / "table-manifest.schema.json", "r", encoding="utf-8") as f:
        table_manifest = json.load(f)

    # Validate schema structures themselves against jsonschema
    jsonschema.Draft7Validator.check_schema(sidecar_request)
    jsonschema.Draft7Validator.check_schema(sidecar_response)
    jsonschema.Draft7Validator.check_schema(table_manifest)

    return sidecar_request, sidecar_response, table_manifest


def validate_object(instance: Dict[str, Any], schema: Dict[str, Any]) -> None:
    jsonschema.validate(instance=instance, schema=schema)


# Load and parse at module-init time
SIDECAR_REQUEST_SCHEMA, SIDECAR_RESPONSE_SCHEMA, TABLE_MANIFEST_SCHEMA = load_schemas()

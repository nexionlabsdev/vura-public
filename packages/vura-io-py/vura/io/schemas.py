import json
from pathlib import Path
from typing import Any, Dict, Tuple
try:
    import jsonschema
    HAS_JSONSCHEMA = True
except ImportError:
    jsonschema = None
    HAS_JSONSCHEMA = False


def get_schema_dir_path() -> Path:
    current_file = Path(__file__).resolve()
    candidates = [
        # Package-local copy — ships inside the package itself (see
        # scripts/copy-schemas.js, run before packaging/testing), so this
        # resolves correctly whether vura-io is pip-installed as a real
        # dependency (site-packages/vura/io/schemas) or run in place in the
        # monorepo (packages/vura-io-py/vura/io/schemas).
        current_file.parent / "schemas",
        # Monorepo-root fallback, for running straight from a checkout
        # before the copy step above has ever run.
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
    if HAS_JSONSCHEMA:
        jsonschema.Draft7Validator.check_schema(sidecar_request)
        jsonschema.Draft7Validator.check_schema(sidecar_response)
        jsonschema.Draft7Validator.check_schema(table_manifest)

    return sidecar_request, sidecar_response, table_manifest


def validate_object(instance: Dict[str, Any], schema: Dict[str, Any]) -> None:
    if HAS_JSONSCHEMA:
        jsonschema.validate(instance=instance, schema=schema)


# Load and parse at module-init time
SIDECAR_REQUEST_SCHEMA, SIDECAR_RESPONSE_SCHEMA, TABLE_MANIFEST_SCHEMA = load_schemas()

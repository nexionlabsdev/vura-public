import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ValidateFunction } from 'ajv';

export interface LoadedSchemas {
  sidecarRequest: object;
  sidecarResponse: object;
  tableManifest: object;
  tableManifestParts: object;
  validators: {
    sidecarRequest: ValidateFunction;
    sidecarResponse: ValidateFunction;
    tableManifest: ValidateFunction;
    tableManifestParts: ValidateFunction;
  };
}

export function getSchemaDirPath(): string {
  // Walk up from this module's location looking for a sibling `schemas/`
  // directory. This finds the repo-root `schemas/` in the monorepo dev
  // layout (packages/vura-io/dist -> ... -> <root>/schemas) as well as the
  // copy postbuild.js places at packages/core-extension/schemas when vura-io
  // is consumed as a nested node_modules dependency inside a packaged
  // extension (node_modules/@vura-data-os/vura-io/dist -> ... -> core-extension/schemas),
  // where the nesting depth isn't fixed.
  const checked: string[] = [];
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, 'schemas');
    checked.push(candidate);
    if (fs.existsSync(path.join(candidate, 'sidecar-request.schema.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  const cwdCandidate = path.resolve(process.cwd(), 'schemas');
  checked.push(cwdCandidate);
  if (fs.existsSync(path.join(cwdCandidate, 'sidecar-request.schema.json'))) {
    return cwdCandidate;
  }

  throw new Error(`Schemas directory not found. Checked: ${checked.join(', ')}`);
}

export function loadSchemas(): LoadedSchemas {
  const schemaDir = getSchemaDirPath();

  const sidecarRequestRaw = fs.readFileSync(path.join(schemaDir, 'sidecar-request.schema.json'), 'utf-8');
  const sidecarResponseRaw = fs.readFileSync(path.join(schemaDir, 'sidecar-response.schema.json'), 'utf-8');
  const tableManifestRaw = fs.readFileSync(path.join(schemaDir, 'table-manifest.schema.json'), 'utf-8');
  const tableManifestPartsRaw = fs.readFileSync(path.join(schemaDir, 'table-manifest-parts.schema.json'), 'utf-8');

  const sidecarRequest = JSON.parse(sidecarRequestRaw);
  const sidecarResponse = JSON.parse(sidecarResponseRaw);
  const tableManifest = JSON.parse(tableManifestRaw);
  const tableManifestParts = JSON.parse(tableManifestPartsRaw);

  const ajv = new Ajv({ strict: false });

  const validators = {
    sidecarRequest: ajv.compile(sidecarRequest),
    sidecarResponse: ajv.compile(sidecarResponse),
    tableManifest: ajv.compile(tableManifest),
    tableManifestParts: ajv.compile(tableManifestParts),
  };

  return {
    sidecarRequest,
    sidecarResponse,
    tableManifest,
    tableManifestParts,
    validators,
  };
}

export const defaultSchemas = loadSchemas();

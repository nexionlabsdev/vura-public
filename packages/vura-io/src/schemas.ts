import * as fs from 'fs';
import * as path from 'path';
import Ajv, { ValidateFunction } from 'ajv';

export interface LoadedSchemas {
  sidecarRequest: object;
  sidecarResponse: object;
  tableManifest: object;
  validators: {
    sidecarRequest: ValidateFunction;
    sidecarResponse: ValidateFunction;
    tableManifest: ValidateFunction;
  };
}

export function getSchemaDirPath(): string {
  const candidates = [
    // Package-local copy — ships inside the package itself (see
    // scripts/copy-schemas.js, run before `tsc` by this package's compile/
    // build/test scripts), so this resolves correctly whether vura-io is
    // installed as a real npm dependency (node_modules/@vura-data-os/vura-io/schemas) or
    // built in place in the monorepo (packages/vura-io/schemas).
    path.resolve(__dirname, '../schemas'),
    // Monorepo-root fallback, for running straight against src/ (e.g.
    // ts-jest) before the copy step above has ever run.
    path.resolve(__dirname, '../../../schemas'),
    path.resolve(__dirname, '../../schemas'),
    path.resolve(process.cwd(), 'schemas')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'sidecar-request.schema.json'))) {
      return candidate;
    }
  }

  throw new Error(`Schemas directory not found. Checked: ${candidates.join(', ')}`);
}

export function loadSchemas(): LoadedSchemas {
  const schemaDir = getSchemaDirPath();

  const sidecarRequestRaw = fs.readFileSync(path.join(schemaDir, 'sidecar-request.schema.json'), 'utf-8');
  const sidecarResponseRaw = fs.readFileSync(path.join(schemaDir, 'sidecar-response.schema.json'), 'utf-8');
  const tableManifestRaw = fs.readFileSync(path.join(schemaDir, 'table-manifest.schema.json'), 'utf-8');

  const sidecarRequest = JSON.parse(sidecarRequestRaw);
  const sidecarResponse = JSON.parse(sidecarResponseRaw);
  const tableManifest = JSON.parse(tableManifestRaw);

  const ajv = new Ajv({ strict: false });

  const validators = {
    sidecarRequest: ajv.compile(sidecarRequest),
    sidecarResponse: ajv.compile(sidecarResponse),
    tableManifest: ajv.compile(tableManifest),
  };

  return {
    sidecarRequest,
    sidecarResponse,
    tableManifest,
    validators,
  };
}

export const defaultSchemas = loadSchemas();

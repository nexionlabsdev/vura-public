import { loadSchemas, getSchemaDirPath } from '../src/schemas';

describe('Schema Foundation (vura-io)', () => {
  it('should locate the schemas directory', () => {
    const dir = getSchemaDirPath();
    expect(dir).toBeTruthy();
  });

  it('should load and parse all schemas at module-init / load time', () => {
    const loaded = loadSchemas();
    expect(loaded.sidecarRequest).toBeDefined();
    expect(loaded.sidecarResponse).toBeDefined();
    expect(loaded.tableManifest).toBeDefined();
    expect(loaded.tableManifestParts).toBeDefined();

    expect((loaded.sidecarRequest as any).$id).toBe('vura://sidecar/request.schema.json');
    expect((loaded.sidecarResponse as any).$id).toBe('vura://sidecar/response.schema.json');
    expect((loaded.tableManifest as any).$id).toBe('vura://table/manifest.schema.json');
    expect((loaded.tableManifestParts as any).$id).toBe('vura://table/manifest-parts.schema.json');
  });

  it('should validate sample objects against compiled validators', () => {
    const { validators } = loadSchemas();

    const validReq = { id: 'req-1', code: 'print("hello")' };
    expect(validators.sidecarRequest(validReq)).toBe(true);

    const invalidReq = { id: 'req-1' };
    expect(validators.sidecarRequest(invalidReq)).toBe(false);

    const validRes = { id: 'req-1', status: 'ok', stdout: 'hello', stderr: '' };
    expect(validators.sidecarResponse(validRes)).toBe(true);

    const validManifest = {
      version: 1,
      tableName: 'users',
      rowCount: 100,
      compacted: false,
      nextPartIndex: 1,
      schema: { id: 'INTEGER', name: 'VARCHAR' }
    };
    expect(validators.tableManifest(validManifest)).toBe(true);

    const validPartsLine = {
      file: 'part-0000.parquet',
      rowCount: 100
    };
    expect(validators.tableManifestParts(validPartsLine)).toBe(true);
  });
});

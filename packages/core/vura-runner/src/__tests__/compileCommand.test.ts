import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { compileTarget, runDiagnosticsCheck, computeChecksum, readSnapshot } from '../commands/compileCommand';
import { parseFlownbDocument } from '../utils/flownbLoader';
import { CliEnvironment } from '../cliEnvironment';

describe('vura-runner compile & runtime reload', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-compile-test-'));
    });

    afterEach(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('reads file non-locking snapshot via readSnapshot', async () => {
        const filePath = path.join(tmpDir, 'test.flownb');
        const yamlContent = `version: 1\ncells:\n  - kind: 1\n    language: markdown\n    value: "# Test Notebook"`;
        await fs.writeFile(filePath, yamlContent, 'utf8');

        const snapshot = await readSnapshot(filePath);
        expect(snapshot).toBe(yamlContent);
        expect(computeChecksum(snapshot)).toBe(computeChecksum(yamlContent));
    });

    it('runs diagnostics check for missing connection profiles and environment variables', async () => {
        const env = new CliEnvironment(tmpDir);
        const yamlContent = `
version: 1
cells:
  - kind: 2
    language: sql
    value: "SELECT * FROM users WHERE token = '\${UNSET_DB_TOKEN}';"
    metadata:
      connectionId: missing-db-profile-999
  - kind: 2
    language: python
    value: |
      import os
      db_pass = os.environ['MISSING_PY_PASS']
`;
        const doc = parseFlownbDocument(yamlContent);
        const warnings = await runDiagnosticsCheck(doc, env);

        expect(warnings.length).toBeGreaterThanOrEqual(2);
        expect(warnings.some(w => w.includes('missing-db-profile-999'))).toBe(true);
        expect(warnings.some(w => w.includes('UNSET_DB_TOKEN') || w.includes('MISSING_PY_PASS'))).toBe(true);
    });

    it('compiles target directory and creates .vura/manifest.json', async () => {
        const flownbPath = path.join(tmpDir, 'sample.flownb');
        const yamlContent = `
version: 1
cells:
  - kind: 1
    language: markdown
    value: "## Intro"
  - kind: 2
    language: javascript
    value: "console.log('Hello');"
`;
        await fs.writeFile(flownbPath, yamlContent, 'utf8');

        const manifest = await compileTarget(tmpDir, undefined, { quiet: true });

        expect(manifest.version).toBe(1);
        expect(manifest.notebooks['sample.flownb']).toBeDefined();
        expect(manifest.notebooks['sample.flownb'].hasNode).toBe(true);
        expect(manifest.notebooks['sample.flownb'].hasPython).toBe(false);
        expect(manifest.notebooks['sample.flownb'].checksum).toBe(computeChecksum(yamlContent));

        const manifestFile = path.join(tmpDir, '.vura', 'manifest.json');
        const fileContent = await fs.readFile(manifestFile, 'utf8');
        const savedManifest = JSON.parse(fileContent);
        expect(savedManifest.notebooks['sample.flownb'].checksum).toBe(manifest.notebooks['sample.flownb'].checksum);
    });
});

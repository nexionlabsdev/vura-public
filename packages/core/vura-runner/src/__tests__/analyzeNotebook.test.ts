import * as fs from 'fs';
import * as path from 'path';
import * as engine from '../index';
import { analyzeNotebook } from '../analysis/analyzeNotebook';

const samplesDir = path.resolve(__dirname, '../../../../../samples');

const yaml = (cells: string) => `version: 1\ncells:\n${cells}`;
const cell = (language: string, value: string, meta = '{}') =>
    `  - kind: 2\n    language: ${language}\n    value: ${JSON.stringify(value)}\n    metadata: ${meta}\n`;

describe('analyzeNotebook (ECR-3)', () => {
    it('is exported from the package root together with the compile API and capabilities', () => {
        expect(typeof engine.analyzeNotebook).toBe('function');
        expect(typeof engine.compileTarget).toBe('function');
        expect(typeof engine.runDiagnosticsCheck).toBe('function');
        expect(engine.ENGINE_CAPABILITIES.analysis).toBe(true);
        // ECR-1 / ECR-2 are implemented (see cancelAndPause.test.ts); capabilities NOT implemented must stay off.
        expect(engine.ENGINE_CAPABILITIES.cancel).toBe(true);
        expect(engine.ENGINE_CAPABILITIES.pauseGate).toBe(true);
        expect(engine.ENGINE_CAPABILITIES.connectorCatalog).toBe(true); // ECR-4, see connectorCatalog.test.ts
    });

    it('analyzes every shipped sample without errors', () => {
        const files = fs.readdirSync(samplesDir).filter((f) => f.endsWith('.flownb'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            const a = analyzeNotebook(fs.readFileSync(path.join(samplesDir, f), 'utf8'));
            expect(a.cellCount).toBeGreaterThan(0);
            const errors = a.diagnostics.filter((d) => d.severity === 'error');
            expect({ file: f, errors }).toEqual({ file: f, errors: [] });
        }
    });

    it('extracts languages, pip packages and runtime flags from the use-case sample', () => {
        const a = analyzeNotebook(fs.readFileSync(path.join(samplesDir, 'use_case_sample.flownb'), 'utf8'));
        expect(a.languages).toEqual(expect.arrayContaining(['sql', 'python', 'javascript', 'vura-terminal']));
        expect(a.hasPython).toBe(true);
        expect(a.hasNode).toBe(true);
        expect(a.pipPackages).toEqual(expect.arrayContaining(['pandas', 'pyarrow']));
    });

    it('reports connection aliases (excluding local), add-on commands and plugins', () => {
        const text = yaml(
            cell('sql', 'SELECT 1', '{ connectionId: d365-crm }') +
            cell('sql', 'SELECT 2', '{ connectionId: local }') +
            cell('sql', 'SELECT 3', '{ connectionId: lake }') +
            cell('vura-terminal', '!sync_dataverse account --to t\n!ingest-file x\n!pip install requests -q') +
            '',
        ) + 'requiredPlugins:\n  - vura-dataverse\n';
        const a = analyzeNotebook(text);
        expect(a.connectionIds).toEqual(['d365-crm', 'lake']);
        expect(a.connectionUsage.map((u) => u.cellIndex)).toEqual([0, 2]);
        expect(a.addonCommands).toEqual(['!sync_dataverse']); // built-ins are not add-on commands
        expect(a.pipPackages).toEqual(['requests']);
        expect(a.requiredPlugins).toEqual(['vura-dataverse']);
    });

    it('reports env-var references without checking them against any environment', () => {
        process.env.VURA_ANALYZE_SET = '1';
        delete process.env.VURA_ANALYZE_UNSET;
        const a = analyzeNotebook(yaml(
            cell('javascript', 'const k = process.env.VURA_ANALYZE_UNSET; const s = process.env["VURA_ANALYZE_SET"];') +
            cell('python', "import os\nx = os.environ['PY_VAR']") +
            cell('sql', "SELECT '${TPL_VAR}'"),
        ));
        expect(a.envVarReferences.map((r) => `${r.kind}:${r.name}`).sort()).toEqual(
            ['node:VURA_ANALYZE_SET', 'node:VURA_ANALYZE_UNSET', 'python:PY_VAR', 'template:TPL_VAR'].sort(),
        );
        // A reference is reported whether or not the variable is set: no environment lookup.
        expect(a.diagnostics.find((d) => /not set/i.test(d.message))).toBeUndefined();
    });

    it('never reads process.env, the filesystem or connection stores', () => {
        const realEnv = process.env;
        const touched: string[] = [];
        process.env = new Proxy(realEnv, { get(t, k) { touched.push(String(k)); return (t as any)[k]; } }) as NodeJS.ProcessEnv;
        // Pre-parsed cells: the analysis code itself must not read the environment. (The `yaml`
        // parser dependency reads its own LOG_* debug variables, which is not analysis logic.)
        const cells = [
            { kind: 2, language: 'javascript', value: 'process.env.X', metadata: {} },
            { kind: 2, language: 'sql', value: 'SELECT 1', metadata: { connectionId: 'c' } },
        ];
        try {
            analyzeNotebook(cells);
        } finally {
            process.env = realEnv;
        }
        expect(touched).toEqual([]);
    });

    it('extracts the http-input schema and http output cell', () => {
        const a = analyzeNotebook(yaml(
            cell('http-input', '{"type":"object","properties":{"id":{"type":"string"}}}') +
            cell('json', '{}', '{ vura_is_http_output: true }'),
        ));
        expect(a.httpInput).toEqual({ cellIndex: 0, schema: { type: 'object', properties: { id: { type: 'string' } } } });
        expect(a.httpOutputCellIndex).toBe(1);
    });

    it('reports problems as diagnostics instead of throwing', () => {
        const a = analyzeNotebook(yaml(
            cell('cobol', 'DISPLAY 1') + cell('sql', '   ') + cell('http-input', 'not json'),
        ));
        const codes = a.diagnostics.map((d) => d.code).sort();
        expect(codes).toEqual(['empty-cell', 'invalid-http-input', 'unsupported-language']);
        expect(a.diagnostics.find((d) => d.code === 'unsupported-language')?.severity).toBe('error');
    });

    it('rejects text that is not a .flownb document', () => {
        expect(() => analyzeNotebook('just: a string')).toThrow(/Invalid \.flownb format/);
    });

    it('accepts a parsed document or a bare cell array', () => {
        const cells = [{ kind: 2, language: 'sql', value: 'SELECT 1', metadata: { connectionId: 'a' } }];
        expect(analyzeNotebook(cells).connectionIds).toEqual(['a']);
        expect(analyzeNotebook({ version: 1, cells, requiredPlugins: ['p'] }).requiredPlugins).toEqual(['p']);
    });
});

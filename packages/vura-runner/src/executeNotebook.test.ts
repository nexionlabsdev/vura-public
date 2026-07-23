// Mock modules with native or ESM-only transitive dependencies so runner.ts can load in Jest
jest.mock('./services/duckDbManager', () => ({
    DuckDbManager: { getInstance: jest.fn(), createIsolated: jest.fn() }
}));
jest.mock('./handlers/writebackHandler', () => ({
    handleODataWriteback: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('./services/sqlService', () => ({ SqlService: jest.fn() }));

import { VuraRunner } from './runner';
import { IVuraEnvironment, ICellLogger, FlownbCell } from './interfaces';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEnv(): IVuraEnvironment {
    return {
        storagePath: '/tmp/vura-test',
        notebookDir: '/tmp',
        notebookId: 'mock-notebook-id',
        extensionPath: '/ext',
        getConfig: jest.fn((_key: string, defaultValue: any) => defaultValue),
        getProfile: jest.fn().mockResolvedValue(undefined),
        getProfileSecret: jest.fn().mockResolvedValue(undefined),
        getSecret: jest.fn().mockResolvedValue(undefined),
        setSecret: jest.fn().mockResolvedValue(undefined),
        deleteSecret: jest.fn().mockResolvedValue(undefined),
        runLocalQuery: jest.fn().mockResolvedValue([]),
        getPythonVenvPath: jest.fn().mockResolvedValue(undefined),
        setPythonVenvPath: jest.fn().mockResolvedValue(undefined),
        setMapping: jest.fn().mockResolvedValue(undefined),
    };
}

function makeLogger(): ICellLogger {
    return {
        logText: jest.fn().mockResolvedValue(undefined),
        logError: jest.fn().mockResolvedValue(undefined),
        logHtml: jest.fn().mockResolvedValue(undefined),
        logJson: jest.fn().mockResolvedValue(undefined),
        replaceOutput: jest.fn().mockResolvedValue(undefined),
        logMultiple: jest.fn().mockResolvedValue(undefined),
        clearOutput: jest.fn().mockResolvedValue(undefined),
    };
}

function codeCell(overrides: Partial<FlownbCell> = {}): FlownbCell {
    return { kind: 2, language: 'sql', value: 'SELECT 1', ...overrides };
}

function markupCell(): FlownbCell {
    return { kind: 1, language: 'markdown', value: '# Title' };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('VuraRunner.executeNotebook', () => {
    let runner: VuraRunner;
    let logger: ICellLogger;

    beforeEach(() => {
        runner = new VuraRunner(makeEnv());
        logger = makeLogger();
        // Mock executeCell so no real DuckDB/Python/Node is needed
        jest.spyOn(runner, 'executeCell').mockResolvedValue(undefined);
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns success when all code cells execute cleanly', async () => {
        const cells = [codeCell(), codeCell()];
        const result = await runner.executeNotebook(cells, logger);
        expect(result.status).toBe('success');
        expect(result.error).toBeNull();
    });

    it('skips markup cells and does not call executeCell for them', async () => {
        const cells = [markupCell(), codeCell()];
        await runner.executeNotebook(cells, logger);
        expect(runner.executeCell).toHaveBeenCalledTimes(1);
    });

    it('records a failed cell as error and aborts its group', async () => {
        (runner.executeCell as jest.Mock)
            .mockRejectedValueOnce(new Error('table not found'))  // cell 0
            .mockResolvedValue(undefined);                         // cell 1+

        const cells = [
            codeCell({ metadata: { label: 'step_one', group: 'etl' } }),
            codeCell({ metadata: { label: 'step_two', group: 'etl' } }),  // same group — should be skipped
            codeCell({ metadata: { label: 'independent' } }),              // no group — should still run
        ];

        const result = await runner.executeNotebook(cells, logger);

        expect(result.status).toBe('error');
        expect(result.context.cells['step_one']?.status).toBe('error');
        expect(result.context.cells['step_two']?.status).toBe('skipped');
        expect(result.context.cells['independent']?.status).toBe('success');
    });

    it('skips a cell whose runWhen evaluates to false and aborts its group', async () => {
        const cells = [
            codeCell({ metadata: { label: 'quality', group: 'setup' } }),
            // transform only if quality returned rows — with empty context it evaluates false
            codeCell({ metadata: { label: 'transform', group: 'main', runWhen: "quality.rowCount > 0" } }),
            codeCell({ metadata: { label: 'write', group: 'main' } }),  // same group, no runWhen → aborted
        ];

        // quality cell succeeds but its rowCount stays null (no SQL result in mock)
        const result = await runner.executeNotebook(cells, logger);

        // transform.runWhen: "quality.rowCount > 0" — quality.rowCount is null, so null > 0 is false
        expect(result.context.cells['transform']?.status).toBe('skipped');
        expect(result.context.cells['write']?.status).toBe('skipped');
    });

    it('rollback cell fires when its group error condition is met', async () => {
        (runner.executeCell as jest.Mock)
            .mockRejectedValueOnce(new Error('transform failed'))  // transform cell
            .mockResolvedValue(undefined);                         // rollback cell

        const cells = [
            codeCell({ metadata: { label: 'transform', group: 'main-etl' } }),
            // rollback runs when main_etl group is error — must be in a DIFFERENT group
            codeCell({
                metadata: {
                    label: 'rollback',
                    group: 'rollback',
                    runWhen: "group.main_etl.status == 'error'"
                }
            }),
        ];

        const result = await runner.executeNotebook(cells, logger);

        expect(result.context.cells['transform']?.status).toBe('error');
        expect(result.context.groups['main_etl']?.status).toBe('error');
        expect(result.context.cells['rollback']?.status).toBe('success');
    });

    it('stops iteration after the http output cell executes', async () => {
        const cells = [
            codeCell({ metadata: { label: 'data' } }),
            codeCell({ metadata: { label: 'response', vura_is_http_output: true } }),
            codeCell({ metadata: { label: 'unreachable' } }),  // must NOT execute
        ];

        const result = await runner.executeNotebook(cells, logger);

        expect(runner.executeCell).toHaveBeenCalledTimes(2);
        expect(result.httpOutputCell).not.toBeNull();
        expect(result.context.cells['unreachable']).toBeUndefined();
    });

    it('fires onCellStart and onCellEnd hooks for each executed cell', async () => {
        const cells = [codeCell({ metadata: { label: 'a' } }), codeCell({ metadata: { label: 'b' } })];
        const starts: number[] = [];
        const ends: string[] = [];

        await runner.executeNotebook(cells, logger, {}, {
            onCellStart: (i) => { starts.push(i); },
            onCellEnd: (i, r) => { ends.push(r.status); }
        });

        expect(starts).toEqual([0, 1]);
        expect(ends).toEqual(['success', 'success']);
    });

    it('calls onCellEnd with skipped status for runWhen-skipped cells', async () => {
        const cells = [
            codeCell({ metadata: { label: 'gate', runWhen: "1 == 0" } }),  // always false
        ];
        const ends: string[] = [];

        await runner.executeNotebook(cells, logger, {}, {
            onCellEnd: (_, r) => ends.push(r.status)
        });

        expect(ends).toEqual(['skipped']);
        expect(runner.executeCell).not.toHaveBeenCalled();
    });

    it('treats a bad runWhen expression as fail-open (cell runs) and logs a warning', async () => {
        const cells = [
            codeCell({ metadata: { label: 'cell', runWhen: "this === bad syntax" } }),
        ];

        const result = await runner.executeNotebook(cells, logger);

        // Fail-open: cell runs despite bad expression
        expect(result.context.cells['cell']?.status).toBe('success');
        // Warning surfaced in cell output
        expect(logger.logText).toHaveBeenCalledWith(
            expect.stringContaining('[ConditionEvaluator] Failed to evaluate expression')
        );
    });
});

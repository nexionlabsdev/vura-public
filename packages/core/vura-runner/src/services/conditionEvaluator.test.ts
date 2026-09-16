import { ConditionEvaluator } from './conditionEvaluator';
import { ExecutionContext } from '../interfaces';

describe('ConditionEvaluator', () => {
    let evaluator: ConditionEvaluator;
    let mockContext: ExecutionContext;

    beforeEach(() => {
        evaluator = new ConditionEvaluator();
        mockContext = {
            cells: {
                cell_1: { status: 'success', rowCount: 10, durationMs: 100, output: null, error: null },
                fetch_accounts: { status: 'success', rowCount: 10, durationMs: 100, output: null, error: null },
                cell_2: { status: 'error', rowCount: null, durationMs: 50, output: null, error: 'Failed to fetch' },
                cell_3: { status: 'success', rowCount: null, durationMs: 20, output: { totalCount: 42 }, error: null }
            },
            groups: {
                main_etl: { status: 'error' },
                cleanup: { status: 'pending' }
            },
            env: {
                RUN_MODE: 'dry-run',
                ROLLBACK_ENABLED: 'true'
            }
        };
    });

    it('should return true if runWhen is undefined or empty', () => {
        expect(evaluator.evaluate(undefined, mockContext)).toBe(true);
        expect(evaluator.evaluate('', mockContext)).toBe(true);
        expect(evaluator.evaluate('   ', mockContext)).toBe(true);
    });

    it('should match on cell status', () => {
        expect(evaluator.evaluate("cell_1.status == 'success'", mockContext)).toBe(true);
        expect(evaluator.evaluate("cell_2.status == 'error'", mockContext)).toBe(true);
        expect(evaluator.evaluate("fetch_accounts.status == 'success'", mockContext)).toBe(true);
        expect(evaluator.evaluate("cell_1.status == 'error'", mockContext)).toBe(false);
    });

    it('should match on rowCount', () => {
        expect(evaluator.evaluate("cell_1.rowCount > 5", mockContext)).toBe(true);
        expect(evaluator.evaluate("cell_1.rowCount == 10", mockContext)).toBe(true);
        expect(evaluator.evaluate("fetch_accounts.rowCount <= 10", mockContext)).toBe(true);
    });

    it('should match on group status', () => {
        expect(evaluator.evaluate("group.main_etl.status == 'error'", mockContext)).toBe(true);
        expect(evaluator.evaluate("group.cleanup.status == 'pending'", mockContext)).toBe(true);
        expect(evaluator.evaluate("group.main_etl.status == 'success'", mockContext)).toBe(false);
    });

    it('should match deeply nested output properties', () => {
        expect(evaluator.evaluate("cell_3.output.totalCount > 0", mockContext)).toBe(true);
        expect(evaluator.evaluate("cell_3.output.totalCount == 42", mockContext)).toBe(true);
    });

    it('should match on complex expressions involving env', () => {
        expect(evaluator.evaluate("group.main_etl.status == 'error' and env.ROLLBACK_ENABLED == 'true'", mockContext)).toBe(true);
        expect(evaluator.evaluate("cell_1.status == 'success' or env.RUN_MODE == 'prod'", mockContext)).toBe(true);
    });

    it('should default to true and log a warning on bad expression', () => {
        const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        // This expression is syntactically invalid
        const result = evaluator.evaluate("cell_1.status === 'success'", mockContext);

        expect(result).toBe(true);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ConditionEvaluator] Failed to evaluate expression'));

        consoleSpy.mockRestore();
    });

    it('should call onWarning callback with the warning message on bad expression', () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const warnings: string[] = [];

        const result = evaluator.evaluate("cell_1.status === 'success'", mockContext, (msg) => warnings.push(msg));

        expect(result).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('[ConditionEvaluator] Failed to evaluate expression');
        expect(warnings[0]).toContain("cell_1.status === 'success'");

        jest.restoreAllMocks();
    });

    it('should NOT call onWarning for valid expressions', () => {
        const warnings: string[] = [];
        evaluator.evaluate("cell_1.status == 'success'", mockContext, (msg) => warnings.push(msg));
        expect(warnings).toHaveLength(0);
    });
});

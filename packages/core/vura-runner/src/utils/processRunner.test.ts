import { runProcess } from './processRunner';

describe('runProcess', () => {
    it('executes node -v successfully and returns stdout', async () => {
        const result = await runProcess('node', ['-v'], process.cwd());
        expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/);
        expect(result.stderr).toBe('');
    });

    it('executes with streamOutputs without throwing', async () => {
        const mockLogger = {
            logText: jest.fn().mockResolvedValue(undefined),
            logError: jest.fn().mockResolvedValue(undefined),
            logHtml: jest.fn().mockResolvedValue(undefined),
            logJson: jest.fn().mockResolvedValue(undefined),
            replaceOutput: jest.fn().mockResolvedValue(undefined),
            logMultiple: jest.fn().mockResolvedValue(undefined),
            clearOutput: jest.fn().mockResolvedValue(undefined),
        };

        const result = await runProcess('node', ['-e', 'console.log("hello world")'], process.cwd(), mockLogger, process.env, true);
        expect(result.stdout).toContain('hello world');
        expect(mockLogger.logText).toHaveBeenCalledWith(expect.stringContaining('hello world'));
    });

    it('rejects on invalid exit code with error message', async () => {
        await expect(
            runProcess('node', ['-e', 'process.exit(42)'], process.cwd())
        ).rejects.toMatchObject({
            code: 42,
        });
    });

    it('rejects on non-existent command with failure message', async () => {
        await expect(
            runProcess('non_existent_executable_12345', [], process.cwd())
        ).rejects.toMatchObject({
            code: -1,
        });
    });
});

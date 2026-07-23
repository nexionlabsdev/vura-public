import { spawn } from 'child_process';
import { ICellLogger } from '../interfaces';

export async function runProcess(
    cmd: string,
    args: string[],
    cwd: string,
    logger?: ICellLogger,
    env?: any,
    streamOutputs = false
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env });
        let stdout = '';
        let stderr = '';

        child.stdout.on('data', async data => {
            stdout += data.toString();
            if (streamOutputs && logger) {
                await logger.logText(data.toString());
            }
        });

        child.stderr.on('data', async data => {
            stderr += data.toString();
            if (streamOutputs && logger) {
                await logger.logText(data.toString());
            }
        });

        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject({ stdout, stderr, code, message: stderr || `Process exited with code ${code}` });
            }
        });
    });
}

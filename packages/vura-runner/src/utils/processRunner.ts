import { spawn, SpawnOptions } from 'child_process';
import { ICellLogger } from '../interfaces';

export async function runProcess(
    cmd: string,
    args: string[],
    cwd: string,
    logger?: ICellLogger,
    env?: NodeJS.ProcessEnv,
    streamOutputs = false
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const isWindows = process.platform === 'win32';

        // Merge process.env so critical system variables (SystemRoot, PATH, COMSPEC) are preserved
        const combinedEnv = env ? { ...process.env, ...env } : process.env;

        const options: SpawnOptions = {
            cwd,
            env: combinedEnv,
            shell: isWindows ? true : false,
            windowsHide: true,
        };

        const child = spawn(cmd, args, options);
        let stdout = '';
        let stderr = '';

        child.on('error', (err) => {
            reject({
                stdout,
                stderr,
                code: -1,
                message: `Failed to spawn process "${cmd}": ${err.message}`,
            });
        });

        child.stdout?.on('data', async (data) => {
            const str = data.toString();
            stdout += str;
            if (streamOutputs && logger) {
                await logger.logText(str);
            }
        });

        child.stderr?.on('data', async (data) => {
            const str = data.toString();
            stderr += str;
            if (streamOutputs && logger) {
                await logger.logText(str);
            }
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                reject({
                    stdout,
                    stderr,
                    code,
                    message: stderr || `Process exited with code ${code}`,
                });
            }
        });
    });
}
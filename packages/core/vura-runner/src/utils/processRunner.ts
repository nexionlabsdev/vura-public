import { spawn, SpawnOptions } from 'child_process';
import { ICellLogger } from '../interfaces';

/**
 * Normalizes environment variables, especially on Windows where variable names
 * are case-insensitive and critical variables like SystemRoot, ComSpec, and PATH
 * must be correctly preserved and deduplicated.
 */
function buildCombinedEnv(customEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = { ...process.env };
    if (!customEnv) {
        return base;
    }

    if (process.platform !== 'win32') {
        return { ...base, ...customEnv };
    }

    // On Windows, normalize keys so we don't end up with duplicate keys like "Path" and "PATH"
    const combined: Record<string, string | undefined> = {};
    const keyMap = new Map<string, string>(); // lowercase -> canonical key

    for (const [key, value] of Object.entries(base)) {
        const lower = key.toLowerCase();
        keyMap.set(lower, key);
        combined[key] = value;
    }

    for (const [key, value] of Object.entries(customEnv)) {
        const lower = key.toLowerCase();
        const existingKey = keyMap.get(lower);
        if (existingKey && existingKey !== key) {
            delete combined[existingKey];
        }
        keyMap.set(lower, key);
        combined[key] = value;
    }

    // Ensure vital Windows environment variables are present
    if (!combined['SystemRoot'] && !combined['SYSTEMROOT']) {
        combined['SystemRoot'] = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
    }
    if (!combined['ComSpec'] && !combined['COMSPEC']) {
        combined['ComSpec'] = process.env.ComSpec || process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
    }

    return combined;
}

/**
 * Determines whether a command on Windows requires shell execution.
 * Only batch files (.bat, .cmd) require shell: true on Windows.
 * Executables (.exe, node, python, git, etc.) should be executed directly with shell: false
 * to avoid cmd.exe quoting/escaping issues, DEP0190 deprecations, and startup overhead.
 */
function shouldExecuteWithShell(cmd: string): boolean {
    if (process.platform !== 'win32') {
        return false;
    }
    const lower = cmd.toLowerCase().trim();
    if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
        return true;
    }
    if (/^(npm|npx|yarn|pnpm|corepack)$/i.test(lower)) {
        return true;
    }
    return false;
}

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
        const combinedEnv = buildCombinedEnv(env);

        let finalCmd = cmd;
        if (isWindows && cmd === 'node' && process.execPath) {
            finalCmd = process.execPath;
        }

        const useShell = shouldExecuteWithShell(finalCmd);

        const options: SpawnOptions = {
            cwd,
            env: combinedEnv,
            shell: useShell,
            windowsHide: true,
        };

        const fsSync = require('fs');
        try {
            if (cwd && !fsSync.existsSync(cwd)) {
                fsSync.mkdirSync(cwd, { recursive: true });
            }
        } catch {}

        const child = spawn(finalCmd, args, options);
        let stdout = '';
        let stderr = '';

        child.on('error', (err) => {
            reject({
                stdout,
                stderr,
                code: -1,
                message: `Failed to spawn process "${finalCmd}": ${err.message}`,
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
                    code: code ?? -1,
                    message: stderr.trim() || stdout.trim() || `Process exited with code ${code}`,
                });
            }
        });
    });
}
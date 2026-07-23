import * as path from 'path';
import * as fs from 'fs/promises';
import { IVuraEnvironment, ICellLogger } from '../interfaces';
import { runProcess } from './processRunner';

/**
 * Resolves the configured Python venv path (anchoring relative paths to
 * storagePath) and creates it if it doesn't exist yet. Returns the absolute
 * path to the venv's python binary.
 */
export async function ensurePythonVenv(env: IVuraEnvironment, logger: ICellLogger): Promise<string> {
    let venvFolder = await env.getPythonVenvPath();
    if (!venvFolder) {
        throw new Error('Python VENV folder is not configured.');
    }
    if (!path.isAbsolute(venvFolder)) {
        venvFolder = path.resolve(env.storagePath, venvFolder);
    }

    const isWin = process.platform === 'win32';
    const pythonBin = isWin
        ? path.join(venvFolder, 'Scripts', 'python.exe')
        : path.join(venvFolder, 'bin', 'python');

    try {
        await fs.access(pythonBin);
    } catch {
        await logger.logText(`Initializing Python VENV at ${venvFolder}...`);
        await runProcess(
            isWin ? 'python' : 'python3',
            ['-m', 'venv', venvFolder],
            env.storagePath, logger, process.env, true
        );
    }

    return pythonBin;
}

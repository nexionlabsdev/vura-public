import * as path from 'path';
import * as fs from 'fs/promises';
import { IVuraEnvironment, ICellLogger } from '../interfaces';
import { runProcess } from './processRunner';

async function findSystemPython(): Promise<string> {
    const candidates = process.platform === 'win32'
        ? ['python', 'py', 'python3']
        : ['python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];

    for (const cmd of candidates) {
        try {
            await new Promise((resolve, reject) => {
                const proc = require('child_process').spawn(cmd, ['--version'], { windowsHide: true });
                proc.on('error', reject);
                proc.on('exit', (code: number) => code === 0 ? resolve(true) : reject(new Error(`Exit code ${code}`)));
            });
            return cmd;
        } catch {}
    }
    throw new Error('Python executable not found on system PATH. Please ensure Python 3 is installed.');
}

async function checkVenvValid(pythonBin: string): Promise<boolean> {
    try {
        await new Promise((resolve, reject) => {
            const proc = require('child_process').spawn(pythonBin, ['--version'], { windowsHide: true });
            proc.on('error', reject);
            proc.on('exit', (code: number) => code === 0 ? resolve(true) : reject());
        });
        return true;
    } catch {
        return false;
    }
}

async function checkPackagesInstalled(pythonBin: string, packages: string[]): Promise<boolean> {
    try {
        const checkCode = packages.map(p => `import ${p}`).join('; ');
        await new Promise((resolve, reject) => {
            const proc = require('child_process').spawn(pythonBin, ['-c', checkCode], { windowsHide: true });
            proc.on('error', reject);
            proc.on('exit', (code: number) => code === 0 ? resolve(true) : reject());
        });
        return true;
    } catch {
        return false;
    }
}

const verifiedVenvs = new Set<string>();

/**
 * Resolves the configured Python venv path (anchoring relative paths to
 * storagePath) and creates it if it doesn't exist yet. Ensures baseline
 * dependencies (pandas, pyarrow) are installed. Returns the absolute path
 * to the venv's python binary.
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

    if (verifiedVenvs.has(pythonBin)) {
        return pythonBin;
    }

    let isValid = false;
    try {
        await fs.access(pythonBin);
        isValid = await checkVenvValid(pythonBin);
    } catch {}

    if (!isValid) {
        await logger.logText(`Initializing Python VENV at ${venvFolder}...`);
        await fs.mkdir(env.storagePath, { recursive: true }).catch(() => {});
        await fs.mkdir(path.dirname(venvFolder), { recursive: true }).catch(() => {});
        await fs.rm(venvFolder, { recursive: true, force: true }).catch(() => {});
        const sysPython = await findSystemPython();
        await runProcess(
            sysPython,
            ['-m', 'venv', venvFolder],
            env.storagePath, logger, process.env, true
        );
    }

    const hasBaseline = await checkPackagesInstalled(pythonBin, ['pandas', 'pyarrow']);
    if (!hasBaseline) {
        await logger.logText(`Installing baseline Python packages (pandas, pyarrow)...`);
        await runProcess(
            pythonBin,
            ['-m', 'pip', 'install', 'pandas', 'pyarrow'],
            env.storagePath, logger, process.env, true
        );
    }

    verifiedVenvs.add(pythonBin);
    return pythonBin;
}

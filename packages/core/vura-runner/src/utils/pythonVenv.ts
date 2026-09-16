import * as path from 'path';
import * as fs from 'fs/promises';
import { IVuraEnvironment, ICellLogger } from '../interfaces';
import { runProcess } from './processRunner';

export async function findSystemPython(): Promise<string> {
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

/** Absolute path to the venv's python binary, given its root folder — does not check it exists. */
export function getVenvPythonBin(venvFolder: string): string {
    return process.platform === 'win32'
        ? path.join(venvFolder, 'Scripts', 'python.exe')
        : path.join(venvFolder, 'bin', 'python');
}

export interface VenvCandidate {
    /** Absolute path to the venv/conda-env root folder. */
    folder: string;
    /** Absolute path to that env's python binary, if this looks like a real venv (vs. a bare lockfile). */
    pythonBin?: string;
    /** What tipped us off: .venv/venv folder, a conda-meta dir, or a poetry/pipenv lockfile. */
    marker: '.venv' | 'venv' | 'conda-meta' | 'poetry.lock' | 'Pipfile.lock';
}

/**
 * Scans a workspace root for common virtual-environment conventions so a host UI
 * (e.g. the VS Code extension's Environment Hub) can pre-fill a Python path
 * without the user hunting for it. Best-effort and read-only — never creates anything.
 */
export async function discoverWorkspaceVenvs(workspaceRoot: string): Promise<VenvCandidate[]> {
    const candidates: VenvCandidate[] = [];

    for (const folderName of ['.venv', 'venv'] as const) {
        const folder = path.join(workspaceRoot, folderName);
        const pythonBin = getVenvPythonBin(folder);
        try {
            await fs.access(pythonBin);
            candidates.push({ folder, pythonBin, marker: folderName });
        } catch {}
    }

    try {
        await fs.access(path.join(workspaceRoot, 'conda-meta'));
        candidates.push({ folder: workspaceRoot, marker: 'conda-meta' });
    } catch {}

    for (const lockFile of ['poetry.lock', 'Pipfile.lock'] as const) {
        try {
            await fs.access(path.join(workspaceRoot, lockFile));
            candidates.push({ folder: workspaceRoot, marker: lockFile });
        } catch {}
    }

    return candidates;
}

/**
 * True only if `pythonBin` sits in a real virtual/conda environment — i.e. its
 * env root contains `pyvenv.cfg` (venv/virtualenv) or `conda-meta` (conda) —
 * never merely because its path happens to contain the word "venv" or end in
 * "bin/python". Used to guard destructive/installing actions (pip install)
 * from ever running against a bare system interpreter resolved off PATH.
 */
export async function looksLikeVenvPython(pythonBin: string): Promise<boolean> {
    const binDir = path.dirname(pythonBin); // .../Scripts or .../bin
    const envRoot = path.dirname(binDir);   // the env folder itself
    if (!/^(Scripts|bin)$/i.test(path.basename(binDir))) return false;
    for (const marker of ['pyvenv.cfg', 'conda-meta']) {
        try {
            await fs.access(path.join(envRoot, marker));
            return true;
        } catch {}
    }
    return false;
}

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

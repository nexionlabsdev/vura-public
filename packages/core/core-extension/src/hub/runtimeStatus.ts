import * as vscode from 'vscode';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import {
    findSystemPython,
    discoverWorkspaceVenvs,
    getVenvPythonBin,
    looksLikeVenvPython,
    VenvCandidate,
    sidecarPool,
    DuckDbManager
} from '@vura-data-os/vura-runner';
import { VsCodeEnvironment } from '../VsCodeEnvironment';

/**
 * The real installable package that backs Python notebook cells today
 * (`from vura.io import data`). Kept as a single named constant — the
 * original brief called this "vura-bridge", which isn't a package that
 * exists in this repo; this is the actual equivalent.
 *
 * Published on PyPI as "vura-io" (see packages/core/vura-io-py/pyproject.toml
 * — "vura-io-py" is only the source directory name, not the package name).
 */
export const BRIDGE_PACKAGE_NAME = 'vura-io';

export interface RuntimeStatus {
    workspaceRoot?: string;
    venvCandidates: VenvCandidate[];
    configuredVenvPath?: string;
    pythonBin?: string;
    isRealVenv: boolean;
    pythonVersion?: string;
    bridgeInstalled: boolean;
    bridgePackageName: string;
    /** Node.js cells run via the same Node binary embedded in the extension host (process.execPath in
     *  nodeHandler.ts) — always available, nothing to install/select, so this is just informational. */
    nodeVersion: string;
    duckDbSessions: Array<{ notebookId: string; dbPath: string }>;
    sidecarSessions: Array<{ key: string; notebookId: string; kind: string; workerCount: number; pids: number[]; anyBusy: boolean; idleMs: number }>;
}

function execFileText(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout, stderr) => {
            if (err) return reject(err);
            resolve((stdout || stderr || '').trim());
        });
    });
}

async function getPythonVersion(pythonBin: string): Promise<string | undefined> {
    try {
        return await execFileText(pythonBin, ['--version']);
    } catch {
        return undefined;
    }
}

async function isBridgeInstalled(pythonBin: string): Promise<boolean> {
    return isPythonPackageInstalled(pythonBin, BRIDGE_PACKAGE_NAME);
}

export async function isPythonPackageInstalled(pythonBin: string, packageName: string): Promise<boolean> {
    try {
        await execFileText(pythonBin, ['-m', 'pip', 'show', packageName]);
        return true;
    } catch {
        return false;
    }
}

export async function getRuntimeStatus(context: vscode.ExtensionContext): Promise<RuntimeStatus> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const venvCandidates = workspaceRoot ? await discoverWorkspaceVenvs(workspaceRoot) : [];

    const env = new VsCodeEnvironment(context);
    const configuredVenvPath = await env.getPythonVenvPath();

    let pythonBin: string | undefined;
    let isRealVenv = false;
    if (configuredVenvPath) {
        const candidate = path.isAbsolute(configuredVenvPath)
            ? getVenvPythonBin(configuredVenvPath)
            : getVenvPythonBin(path.resolve(env.storagePath, configuredVenvPath));
        pythonBin = candidate;
        isRealVenv = await looksLikeVenvPython(candidate).catch(() => false);
    } else if (venvCandidates.length > 0 && venvCandidates[0].pythonBin) {
        pythonBin = venvCandidates[0].pythonBin;
        isRealVenv = true;
    }

    let pythonVersion: string | undefined;
    let bridgeInstalled = false;
    if (pythonBin) {
        pythonVersion = await getPythonVersion(pythonBin);
        if (pythonVersion) {
            bridgeInstalled = await isBridgeInstalled(pythonBin);
        } else {
            // configured python doesn't actually exist / isn't runnable
            pythonBin = undefined;
            isRealVenv = false;
        }
    }

    return {
        workspaceRoot,
        venvCandidates,
        configuredVenvPath,
        pythonBin,
        isRealVenv,
        pythonVersion,
        bridgeInstalled,
        bridgePackageName: BRIDGE_PACKAGE_NAME,
        nodeVersion: process.version,
        duckDbSessions: DuckDbManager.listActiveSessions(),
        sidecarSessions: sidecarPool.listActiveSessions()
    };
}

/**
 * Streams `pip install <pkg>` output to `channel` and resolves/rejects on exit.
 * Refuses to run unless `pythonBin` is verified (server-side, not just by trusting
 * whatever the webview last rendered) to sit inside a real venv/conda environment —
 * this is the guard that keeps a stale or raced UI state from ever installing into
 * a bare system/global interpreter.
 */
export async function installPythonPackage(pythonBin: string, packageName: string, channel: vscode.OutputChannel): Promise<void> {
    const isSafe = await looksLikeVenvPython(pythonBin).catch(() => false);
    if (!isSafe) {
        throw new Error(
            `Refusing to install "${packageName}" into ${pythonBin} — it doesn't look like a virtual/conda environment interpreter. Create or select a venv first.`
        );
    }
    return streamPip(pythonBin, ['install', packageName], channel);
}

export async function uninstallPythonPackage(pythonBin: string, packageName: string, channel: vscode.OutputChannel): Promise<void> {
    const isSafe = await looksLikeVenvPython(pythonBin).catch(() => false);
    if (!isSafe) {
        throw new Error(`Refusing to uninstall "${packageName}" from ${pythonBin} — it doesn't look like a virtual/conda environment interpreter.`);
    }
    return streamPip(pythonBin, ['uninstall', '-y', packageName], channel);
}

function streamPip(pythonBin: string, pipArgs: string[], channel: vscode.OutputChannel): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(pythonBin, ['-m', 'pip', ...pipArgs], { windowsHide: true });
        channel.appendLine(`$ ${pythonBin} -m pip ${pipArgs.join(' ')}`);
        proc.stdout?.on('data', (chunk) => channel.append(chunk.toString()));
        proc.stderr?.on('data', (chunk) => channel.append(chunk.toString()));
        proc.on('error', reject);
        proc.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`pip ${pipArgs[0]} exited with code ${code}`));
        });
    });
}

/** Creates a fresh venv at `folder` using the first system Python found on PATH. */
export async function createVenv(folder: string, channel: vscode.OutputChannel): Promise<string> {
    const sysPython = await findSystemPython();
    await new Promise<void>((resolve, reject) => {
        const proc = spawn(sysPython, ['-m', 'venv', folder], { windowsHide: true });
        channel.appendLine(`$ ${sysPython} -m venv ${folder}`);
        proc.stdout?.on('data', (chunk) => channel.append(chunk.toString()));
        proc.stderr?.on('data', (chunk) => channel.append(chunk.toString()));
        proc.on('error', reject);
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`venv creation exited with code ${code}`)));
    });
    return getVenvPythonBin(folder);
}

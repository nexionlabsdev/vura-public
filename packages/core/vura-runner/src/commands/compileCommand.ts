import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { CliEnvironment } from '../cliEnvironment';
import { parseFlownbDocument, FlownbDocument } from '../utils/flownbLoader';
import { ensurePythonVenv } from '../utils/pythonVenv';
import { runProcess } from '../utils/processRunner';
import { ICellLogger } from '../interfaces';
import { prepareStorageWorkspace } from '../runner';
import { colors, logSuccess, logWarning, logError, logInfo } from '../utils/colors';

export interface NotebookManifestEntry {
    checksum: string;
    hasPython: boolean;
    hasNode: boolean;
    requiredPlugins: string[];
    ast: FlownbDocument;
    diagnostics: string[];
}

export interface VuraManifest {
    version: number;
    generatedAt: string;
    notebooksDir: string;
    notebooks: Record<string, NotebookManifestEntry>;
    runtimePaths: {
        pythonBin?: string;
        nodeBin: string;
        storagePath: string;
    };
}

class SilentLogger implements ICellLogger {
    public logs: string[] = [];
    async logText(text: string): Promise<void> { this.logs.push(text); }
    async logError(error: string | Error): Promise<void> { this.logs.push(`ERROR: ${error}`); }
    async logHtml(html: string): Promise<void> { }
    async logJson(json: any): Promise<void> { }
    async logMultiple(items: { mime: string; data: any }[]): Promise<void> { }
    async clearOutput(): Promise<void> { }
    async replaceOutput(html: string): Promise<void> { }
}

export interface CompileOptions {
    quiet?: boolean;
}

/**
 * Non-locking atomic snapshot read of a file content.
 */
export async function readSnapshot(filePath: string): Promise<string> {
    return await fs.readFile(filePath, 'utf8');
}

/**
 * Compute SHA-256 checksum of string content.
 */
export function computeChecksum(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Scans directory recursively for .flownb files.
 */
export async function findFlownbFiles(dirOrFile: string): Promise<string[]> {
    const resolvedPath = path.resolve(process.cwd(), dirOrFile);
    try {
        const stat = await fs.stat(resolvedPath);
        if (stat.isFile()) {
            if (resolvedPath.endsWith('.flownb')) {
                return [resolvedPath];
            }
            return [];
        }

        const found: string[] = [];
        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(resolvedPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'out') continue;
                const subFiles = await findFlownbFiles(full);
                found.push(...subFiles);
            } else if (entry.isFile() && entry.name.endsWith('.flownb')) {
                found.push(full);
            }
        }
        return found;
    } catch {
        return [];
    }
}

/**
 * Diagnostics check for secrets and environment variables referenced in cells.
 */
export async function runDiagnosticsCheck(
    doc: FlownbDocument,
    env: CliEnvironment
): Promise<string[]> {
    const warnings: string[] = [];

    for (const cell of doc.cells) {
        if (cell.metadata?.connectionId && cell.metadata.connectionId !== 'local') {
            const connId = cell.metadata.connectionId;
            const profile = await env.getProfile(connId);
            const secret = await env.getProfileSecret(connId);
            if (!profile && !secret) {
                warnings.push(`Connection profile or secret '${connId}' referenced in cell metadata is missing.`);
            }
        }

        if (cell.value) {
            // Check for ${ENV_VAR}
            const envVarMatches = cell.value.matchAll(/\$\{([A-Z0-9_]+)\}/gi);
            for (const match of envVarMatches) {
                const varName = match[1];
                if (!process.env[varName]) {
                    warnings.push(`Environment variable '${varName}' referenced in cell value is not set.`);
                }
            }

            // Check for process.env.ENV_VAR or process.env['ENV_VAR']
            const nodeEnvMatches = cell.value.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/gi);
            for (const match of nodeEnvMatches) {
                const varName = match[1] || match[2];
                if (varName && !process.env[varName]) {
                    warnings.push(`Node environment variable '${varName}' referenced in cell is not set.`);
                }
            }

            // Check for os.environ['ENV_VAR'] or os.getenv('ENV_VAR')
            const pyEnvMatches = cell.value.matchAll(/os\.(?:environ\[['"]([A-Z0-9_]+)['"]\]|getenv\(['"]([A-Z0-9_]+)['"]\))/gi);
            for (const match of pyEnvMatches) {
                const varName = match[1] || match[2];
                if (varName && !process.env[varName]) {
                    warnings.push(`Python environment variable '${varName}' referenced in cell is not set.`);
                }
            }
        }
    }

    return Array.from(new Set(warnings));
}

/**
 * Main compilation logic.
 */
export async function compileTarget(
    targetPath: string,
    envPath?: string,
    options: CompileOptions = {}
): Promise<VuraManifest> {
    const resolvedTarget = path.resolve(process.cwd(), targetPath);
    let isSingleFile = false;
    let baseDir = resolvedTarget;

    try {
        const stat = await fs.stat(resolvedTarget);
        if (stat.isFile()) {
            isSingleFile = true;
            baseDir = path.dirname(resolvedTarget);
        }
    } catch (err: any) {
        throw new Error(`Target path '${targetPath}' does not exist: ${err.message}`);
    }

    const env = new CliEnvironment(baseDir, envPath);
    const flownbFiles = await findFlownbFiles(resolvedTarget);

    if (flownbFiles.length === 0) {
        throw new Error(`No .flownb files found in '${targetPath}'`);
    }

    if (!options.quiet) {
        console.log(`${colors.bold}${colors.brightCyan}🔨 Compiling ${flownbFiles.length} notebook(s) in ${baseDir}...${colors.reset}`);
    }

    let hasAnyPythonCell = false;
    let hasAnyNodeCell = false;

    const manifestEntries: Record<string, NotebookManifestEntry> = {};

    for (const filePath of flownbFiles) {
        const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
        const content = await readSnapshot(filePath);
        const checksum = computeChecksum(content);
        const doc = parseFlownbDocument(content);

        const hasPython = doc.cells.some(c => c.kind === 2 && c.language === 'python');
        const hasNode = doc.cells.some(c => c.kind === 2 && (c.language === 'node' || c.language === 'js' || c.language === 'javascript'));

        if (hasPython) hasAnyPythonCell = true;
        if (hasNode) hasAnyNodeCell = true;

        const diagnostics = await runDiagnosticsCheck(doc, env);
        if (!options.quiet && diagnostics.length > 0) {
            console.warn(`\n${colors.bold}${colors.brightYellow}⚠️  Diagnostics warnings for ${relPath}:${colors.reset}`);
            diagnostics.forEach(w => console.warn(`   ${colors.yellow}- ${w}${colors.reset}`));
        }

        manifestEntries[relPath] = {
            checksum,
            hasPython,
            hasNode,
            requiredPlugins: doc.requiredPlugins || [],
            ast: doc,
            diagnostics
        };
    }

    // Warm up / Provision dependencies
    let pythonBin: string | undefined = undefined;
    const silentLogger = new SilentLogger();

    try {
        await prepareStorageWorkspace(env, silentLogger);
    } catch (err: any) {
        logWarning(`Warning during storage workspace provisioning: ${err.message}`);
    }

    if (hasAnyPythonCell) {
        if (!options.quiet) {
            console.log(`${colors.brightCyan}🐍 Provisioning Python environment & dependencies...${colors.reset}`);
        }
        try {
            pythonBin = await ensurePythonVenv(env, silentLogger);

            // Install baseline python packages if missing (pandas, pyarrow)
            const requiredPythonPkgs = ['pandas', 'pyarrow'];
            await runProcess(
                pythonBin,
                ['-m', 'pip', 'install', ...requiredPythonPkgs],
                env.storagePath,
                silentLogger,
                process.env,
                true
            );

            // Parse !pip lines from cells across notebooks
            const cellPipPkgs: string[] = [];
            for (const entry of Object.values(manifestEntries)) {
                for (const cell of entry.ast.cells) {
                    if (cell.kind === 2) {
                        const lines = cell.value.split('\n');
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('!pip') || trimmed.startsWith('!pip3')) {
                                const args = trimmed.split(/\s+/).slice(1).filter(a => a !== 'install' && a !== 'i' && !a.startsWith('-'));
                                cellPipPkgs.push(...args);
                            }
                        }
                    }
                }
            }

            if (cellPipPkgs.length > 0) {
                const uniquePip = Array.from(new Set(cellPipPkgs));
                if (!options.quiet) {
                    console.log(` ${colors.cyan}Installing cell-declared Python packages: ${uniquePip.join(', ')}...${colors.reset}`);
                }
                await runProcess(
                    pythonBin,
                    ['-m', 'pip', 'install', ...uniquePip],
                    env.storagePath,
                    silentLogger,
                    process.env,
                    true
                );
            }
        } catch (err: any) {
            logWarning(`Warning during Python environment provisioning: ${err.message}`);
        }
    } else {
        if (!options.quiet) {
            console.log(`${colors.dim}ℹ️  No Python cells detected. Skipping Python venv provisioning.${colors.reset}`);
        }
    }

    if (hasAnyNodeCell) {
        if (!options.quiet) {
            console.log(`${colors.brightCyan}📦 Provisioning Node.js dependencies & plugins...${colors.reset}`);
        }
        // Load plugins if any declared
        const allPlugins = new Set<string>();
        const rawConfigPlugins = env.getConfig<string[] | string>('vura.plugins', []);
        if (Array.isArray(rawConfigPlugins)) rawConfigPlugins.forEach(p => allPlugins.add(p));

        for (const entry of Object.values(manifestEntries)) {
            entry.requiredPlugins.forEach(p => allPlugins.add(p));
        }

        if (allPlugins.size > 0) {
            try {
                const { loadPlugins } = require('../pluginLoader');
                await loadPlugins(Array.from(allPlugins), env, silentLogger);
            } catch (err: any) {
                logWarning(`Warning loading Node.js plugins: ${err.message}`);
            }
        }
    }

    const manifest: VuraManifest = {
        version: 1,
        generatedAt: new Date().toISOString(),
        notebooksDir: baseDir,
        notebooks: manifestEntries,
        runtimePaths: {
            pythonBin,
            nodeBin: process.execPath || 'node',
            storagePath: env.storagePath
        }
    };

    // Save manifest to .vura/manifest.json in baseDir
    const vuraDir = path.join(baseDir, '.vura');
    await fs.mkdir(vuraDir, { recursive: true });
    const manifestPath = path.join(vuraDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    if (!options.quiet) {
        logSuccess(`Execution manifest generated successfully at ${colors.underline}${manifestPath}${colors.reset}`);
    }

    return manifest;
}

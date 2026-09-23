import { FlownbCell } from '../interfaces';
import { FlownbDocument, parseFlownbDocument } from '../utils/flownbLoader';

/**
 * Static, side-effect-free analysis of a notebook.
 *
 * Unlike `runDiagnosticsCheck` (which consults the machine's environment variables and
 * connection profiles), this function only READS THE NOTEBOOK: it never touches
 * `process.env`, the filesystem, the network, or any connection store. It reports what a
 * notebook *references*; deciding whether those references are satisfied is the host's job
 * (a CLI checks local profiles, an enterprise control plane checks environment bindings).
 */

/** Languages the engine can execute (mirrors the dispatch in `VuraRunner.executeCell`). */
export const SUPPORTED_CELL_LANGUAGES = [
    'python', 'javascript', 'sql', 'html', 'shellscript', 'vura-terminal', 'vega-lite', 'json', 'http-input',
] as const;

export interface AnalysisDiagnostic {
    severity: 'error' | 'warning';
    code: string;
    message: string;
    cellIndex?: number;
}

export interface ConnectionUsage {
    /** The connection alias referenced by `metadata.connectionId`. */
    alias: string;
    cellIndex: number;
    language: string;
}

export interface EnvVarReference {
    name: string;
    kind: 'template' | 'node' | 'python';
    cellIndex: number;
}

export interface NotebookAnalysis {
    formatVersion: number;
    cellCount: number;
    codeCellCount: number;
    /** Distinct languages of code cells, sorted. */
    languages: string[];
    hasPython: boolean;
    hasNode: boolean;
    /** Distinct connection aliases (excluding the built-in 'local'), sorted. */
    connectionIds: string[];
    connectionUsage: ConnectionUsage[];
    /** Plugins the notebook itself declares (`requiredPlugins`). */
    requiredPlugins: string[];
    /** Distinct `!command` roots used in terminal cells that are not built-in engine commands
     *  (these are dispatched to Add-on providers, e.g. `!sync_dataverse`), sorted. */
    addonCommands: string[];
    /** Packages installed by `!pip` / `!pip3` lines, sorted. */
    pipPackages: string[];
    /** References to environment variables (reported, NOT checked against any environment). */
    envVarReferences: EnvVarReference[];
    /** The `http-input` cell's schema, if the notebook declares one. */
    httpInput: { cellIndex: number; schema: unknown } | null;
    /** Index of the cell marked as the HTTP output, if any. */
    httpOutputCellIndex: number | null;
    diagnostics: AnalysisDiagnostic[];
}

/** Commands handled by the engine itself; everything else is an Add-on command. */
const BUILTIN_COMMANDS = new Set(['!clean_session', '!clean-session', '!ingest-file', '!export-file', '!pip', '!pip3']);

function isCode(cell: FlownbCell): boolean {
    return cell.kind === 2;
}

function asDocument(input: string | FlownbDocument | FlownbCell[]): FlownbDocument {
    if (typeof input === 'string') return parseFlownbDocument(input);
    if (Array.isArray(input)) return { version: 0, cells: input };
    return input;
}

/**
 * Analyzes a notebook given as `.flownb` text, a parsed document, or a cell array.
 * Throws only when the text is not a valid `.flownb` document; every other problem is
 * reported as a diagnostic.
 */
export function analyzeNotebook(input: string | FlownbDocument | FlownbCell[]): NotebookAnalysis {
    const doc = asDocument(input);
    const cells = doc.cells;

    const languages = new Set<string>();
    const connectionUsage: ConnectionUsage[] = [];
    const addonCommands = new Set<string>();
    const pip = new Set<string>();
    const envRefs: EnvVarReference[] = [];
    const diagnostics: AnalysisDiagnostic[] = [];
    let httpInput: NotebookAnalysis['httpInput'] = null;
    let httpOutputCellIndex: number | null = null;
    let codeCellCount = 0;

    cells.forEach((cell, i) => {
        if (!isCode(cell)) return;
        codeCellCount++;
        languages.add(cell.language);

        if (!(SUPPORTED_CELL_LANGUAGES as readonly string[]).includes(cell.language)) {
            diagnostics.push({ severity: 'error', code: 'unsupported-language', cellIndex: i, message: `Unsupported cell language "${cell.language}".` });
        }
        if (!cell.value || !cell.value.trim()) {
            diagnostics.push({ severity: 'warning', code: 'empty-cell', cellIndex: i, message: 'Code cell is empty.' });
        }

        const conn = cell.metadata?.connectionId;
        if (typeof conn === 'string' && conn && conn !== 'local') {
            connectionUsage.push({ alias: conn, cellIndex: i, language: cell.language });
        }

        const value = cell.value ?? '';

        if (cell.language === 'vura-terminal' || cell.language === 'shellscript') {
            for (const raw of value.split('\n')) {
                const line = raw.trim();
                if (!line.startsWith('!')) continue;
                const root = line.split(/\s+/)[0];
                if (root === '!pip' || root === '!pip3') {
                    line.split(/\s+/).slice(1)
                        .filter((a) => a !== 'install' && a !== 'i' && !a.startsWith('-'))
                        .forEach((p) => pip.add(p));
                } else if (!BUILTIN_COMMANDS.has(root)) {
                    addonCommands.add(root);
                }
            }
        }

        if (cell.language === 'http-input') {
            if (httpInput) {
                diagnostics.push({ severity: 'warning', code: 'multiple-http-input', cellIndex: i, message: 'More than one http-input cell; only the first is used for the schema.' });
            } else {
                try {
                    httpInput = { cellIndex: i, schema: JSON.parse(value) };
                } catch {
                    httpInput = { cellIndex: i, schema: null };
                    diagnostics.push({ severity: 'error', code: 'invalid-http-input', cellIndex: i, message: 'http-input cell is not valid JSON.' });
                }
            }
        }
        if (cell.language === 'json' && (cell.metadata?.vura_is_http_output || cell.metadata?.vura_json_output)) {
            httpOutputCellIndex = i;
        }

        for (const m of value.matchAll(/\$\{([A-Z0-9_]+)\}/gi)) {
            envRefs.push({ name: m[1], kind: 'template', cellIndex: i });
        }
        for (const m of value.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/gi)) {
            envRefs.push({ name: m[1] || m[2], kind: 'node', cellIndex: i });
        }
        for (const m of value.matchAll(/os\.(?:environ\[['"]([A-Z0-9_]+)['"]\]|getenv\(['"]([A-Z0-9_]+)['"]\))/gi)) {
            envRefs.push({ name: m[1] || m[2], kind: 'python', cellIndex: i });
        }
    });

    if (codeCellCount === 0) {
        diagnostics.push({ severity: 'warning', code: 'no-code-cells', message: 'Notebook has no code cells.' });
    }

    const sortedUnique = (s: Iterable<string>) => Array.from(new Set(s)).sort();
    return {
        formatVersion: doc.version,
        cellCount: cells.length,
        codeCellCount,
        languages: sortedUnique(languages),
        hasPython: languages.has('python'),
        hasNode: languages.has('javascript') || languages.has('node') || languages.has('js'),
        connectionIds: sortedUnique(connectionUsage.map((u) => u.alias)),
        connectionUsage,
        requiredPlugins: sortedUnique(doc.requiredPlugins ?? []),
        addonCommands: sortedUnique(addonCommands),
        pipPackages: sortedUnique(pip),
        envVarReferences: envRefs,
        httpInput,
        httpOutputCellIndex,
        diagnostics,
    };
}

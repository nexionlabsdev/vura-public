import { ICellLogger } from '../interfaces';
import { DuckDbManager } from '../services/duckDbManager';

// ─── Types ──────────────────────────────────────────────────────────────────────

type DirectiveResult = any[] | Record<string, any> | any;

// ─── Main Entry Point ───────────────────────────────────────────────────────────

/**
 * Execute a JSON Compose cell.
 *
 * The cell content is a JSON template with directives:
 *   - { "$table": "table_name" }                      → fetch all rows from DuckDB table
 *   - { "$query": "SELECT ..." }                      → execute SQL query
 *   - { "$table": "...", "$as": "single" | "object" } → force single-object output
 *   - { "$query": "...", "$as": "array" }              → force array output
 *
 * Default behaviour:
 *   - 1 row  → object (each column becomes a property)
 *   - N rows → array of objects
 *
 * Keys starting with _ (e.g. "_comment") are stripped before processing.
 */
export async function handleJsonCompose(
    cellSource: string,
    logger: ICellLogger,
    duckDb: DuckDbManager
): Promise<string> {
    const source = cellSource.trim();

    // 1. Parse JSON template
    let template: any;
    try {
        template = JSON.parse(source);
    } catch (err: any) {
        throw new Error(`Invalid JSON in cell: ${err.message}`);
    }

    // 2. DuckDB instance is provided by caller

    // 3. Resolve directives recursively
    const composed = await resolveDirectives(template, duckDb);

    // Coerce BigInt values so JSON.stringify doesn't throw
    const safeComposed = coerceBigInt(composed);

    // 4. Return serialized output for the runner to store in cell metadata
    const serialized = JSON.stringify(safeComposed);

    // 5. Render output
    const htmlOutput = buildJsonTreeHtml(safeComposed);
    await logger.logMultiple([
        { mime: 'application/vnd.vura.visual', data: htmlOutput },
        { mime: 'application/json', data: safeComposed }
    ]);

    return serialized;
}

// ─── Directive Resolver ─────────────────────────────────────────────────────────

async function resolveDirectives(node: any, duckDb: DuckDbManager): Promise<any> {
    // Null / primitives → pass through
    if (node === null || node === undefined || typeof node !== 'object') {
        return node;
    }

    // Array → resolve each element
    if (Array.isArray(node)) {
        const results = [];
        for (const item of node) {
            results.push(await resolveDirectives(item, duckDb));
        }
        return results;
    }

    // Object → check for directives
    if (isDirectiveNode(node)) {
        return await executeDirective(node, duckDb);
    }

    // Regular object → recurse into each property (keys starting with _ are stripped)
    const resolved: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('_')) continue;
        resolved[key] = await resolveDirectives(value, duckDb);
    }
    return resolved;
}

function isDirectiveNode(obj: any): boolean {
    return obj && typeof obj === 'object' && !Array.isArray(obj) &&
        (obj.hasOwnProperty('$table') || obj.hasOwnProperty('$query'));
}

async function executeDirective(
    node: { $table?: string; $query?: string; $as?: 'object' | 'single' | 'array' },
    duckDb: DuckDbManager
): Promise<DirectiveResult> {
    let rows: any[];

    if (node.$table) {
        try {
            rows = await duckDb.runQuery(`SELECT * FROM "${node.$table}"`);
        } catch (err: any) {
            throw new Error(`$table "${node.$table}" not found in DuckDB: ${err.message}`);
        }
    } else if (node.$query) {
        try {
            rows = await duckDb.runQuery(node.$query);
        } catch (err: any) {
            throw new Error(`$query failed: ${err.message}\nQuery: ${node.$query}`);
        }
    } else {
        return node;
    }

    if (!rows || rows.length === 0) {
        return node.$as === 'object' ? {} : [];
    }

    // Determine output shape
    const forceType = node.$as;

    if (forceType === 'array') {
        return rows;
    }

    if (forceType === 'object' || forceType === 'single') {
        return rows[0];
    }

    // Default: 1 row → object, N rows → array
    if (rows.length === 1) {
        return rows[0];
    }

    return rows;
}

// ─── BigInt Coercion ────────────────────────────────────────────────────────────

function coerceBigInt(value: any): any {
    if (typeof value === 'bigint') {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value) : value.toString();
    }
    if (Array.isArray(value)) return value.map(coerceBigInt);
    if (value !== null && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) out[k] = coerceBigInt(v);
        return out;
    }
    return value;
}

// ─── JSON Tree HTML Renderer ────────────────────────────────────────────────────

function buildJsonTreeHtml(data: any): string {
    const jsonHtml = renderJsonNode(data, 0, true);

    return `<!DOCTYPE html>
<html>
<head>
<style>
    :root {
        --json-key: #9cdcfe;
        --json-string: #ce9178;
        --json-number: #b5cea8;
        --json-boolean: #569cd6;
        --json-null: #808080;
        --json-bracket: #d4d4d4;
        --json-toggle: #c586c0;
        --json-bg: transparent;
        --json-border: rgba(255,255,255,0.06);
    }
    .json-tree {
        font-family: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
        font-size: 13px;
        line-height: 1.6;
        color: var(--vscode-foreground, #d4d4d4);
        padding: 12px 16px;
        overflow: auto;
        max-height: 500px;
    }
    .json-key { color: var(--json-key); }
    .json-string { color: var(--json-string); }
    .json-number { color: var(--json-number); }
    .json-boolean { color: var(--json-boolean); }
    .json-null { color: var(--json-null); font-style: italic; }
    .json-bracket { color: var(--json-bracket); }
    .json-toggle {
        cursor: pointer;
        color: var(--json-toggle);
        user-select: none;
        display: inline-block;
        width: 16px;
        text-align: center;
        font-size: 11px;
        margin-right: 2px;
    }
    .json-toggle:hover { opacity: 0.7; }
    .json-collapsible { margin-left: 20px; }
    .json-collapsed { display: none; }
    .json-summary {
        color: var(--json-null);
        font-size: 12px;
        display: none;
    }
    .json-collapsed + .json-summary { display: inline; }
    .json-count {
        color: var(--json-null);
        font-size: 11px;
        margin-left: 4px;
    }
</style>
</head>
<body>
<div class="json-tree">${jsonHtml}</div>
<script>
document.querySelectorAll('.json-toggle').forEach(el => {
    el.addEventListener('click', function() {
        const target = this.nextElementSibling;
        if (!target) return;
        const collapsed = target.classList.toggle('json-collapsed');
        this.textContent = collapsed ? '▶' : '▼';
    });
});
</script>
</body>
</html>`;
}

function renderJsonNode(value: any, depth: number, expanded: boolean): string {
    if (value === null || value === undefined) {
        return '<span class="json-null">null</span>';
    }

    if (typeof value === 'string') {
        const escaped = escapeHtml(value);
        if (escaped.length > 200) {
            return `<span class="json-string">"${escaped.substring(0, 200)}…"</span>`;
        }
        return `<span class="json-string">"${escaped}"</span>`;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return `<span class="json-number">${value}</span>`;
    }

    if (typeof value === 'boolean') {
        return `<span class="json-boolean">${value}</span>`;
    }

    if (Array.isArray(value)) {
        if (value.length === 0) {
            return '<span class="json-bracket">[]</span>';
        }

        const isExpanded = depth < 2 && expanded;
        const toggle = isExpanded ? '▼' : '▶';
        const collapsedClass = isExpanded ? '' : 'json-collapsed';

        let html = `<span class="json-toggle">${toggle}</span>`;
        html += `<span class="json-bracket">[</span>`;
        html += `<div class="json-collapsible ${collapsedClass}">`;
        for (let i = 0; i < value.length; i++) {
            html += renderJsonNode(value[i], depth + 1, expanded);
            if (i < value.length - 1) html += ',';
            html += '<br>';
        }
        html += '</div>';
        html += `<span class="json-summary">…</span>`;
        html += `<span class="json-bracket">]</span>`;
        html += `<span class="json-count">(${value.length})</span>`;
        return html;
    }

    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            return '<span class="json-bracket">{}</span>';
        }

        const isExpanded = depth < 2 && expanded;
        const toggle = isExpanded ? '▼' : '▶';
        const collapsedClass = isExpanded ? '' : 'json-collapsed';

        let html = `<span class="json-toggle">${toggle}</span>`;
        html += `<span class="json-bracket">{</span>`;
        html += `<div class="json-collapsible ${collapsedClass}">`;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            html += `<span class="json-key">"${escapeHtml(k)}"</span>: `;
            html += renderJsonNode(value[k], depth + 1, expanded);
            if (i < keys.length - 1) html += ',';
            html += '<br>';
        }
        html += '</div>';
        html += `<span class="json-summary">…</span>`;
        html += `<span class="json-bracket">}</span>`;
        html += `<span class="json-count">(${keys.length} keys)</span>`;
        return html;
    }

    return `<span>${escapeHtml(String(value))}</span>`;
}

function escapeHtml(unsafe: string): string {
    if (unsafe === undefined || unsafe === null) return '';
    return unsafe.toString()
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

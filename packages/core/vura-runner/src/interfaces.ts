// Shared, host-agnostic types (cell shape, logger, environment, SQL profile)
// now live in @vura-data-os/core-sdk so Add-ons (like vura-dataverse) can use
// them without depending on this package. Re-exported here so existing
// imports from '@vura-data-os/vura-runner' keep working.
export {
    AuthMode,
    SqlProfile,
    RawOutputItem,
    RawOutput,
    FlownbCell,
    ICellLogger,
    IVuraEnvironment,
    ConnectorKind,
    ConnectionProfile,
    ConnectionField,
    StorageEntry,
    IStorageProvider
} from '@vura-data-os/core-sdk';

import { RawOutput as _RawOutput, FlownbCell as _FlownbCell } from '@vura-data-os/core-sdk';

// ─── Execution-engine-only types (not needed by Add-ons) ────────────────────

export type CellStatus = 'success' | 'error' | 'skipped';
export type GroupStatus = 'success' | 'error' | 'partial' | 'pending';

export interface CellExecutionResult {
    status: CellStatus;
    rowCount: number | null;   // null for non-data cells (python, html, etc.)
    durationMs: number;
    output: any;               // the parsed JSON output if cell is a json-compose cell, else null
    error: string | null;
}

export interface ExecutionContext {
    cells: Record<string, CellExecutionResult>;  // keyed by label OR "cell_N" (1-based)
    groups: Record<string, { status: GroupStatus }>;
    env: Record<string, string>;
}

export interface NotebookExecutionResult {
    status: 'success' | 'error' | 'canceled';   // 'canceled' only when an AbortSignal was passed and fired
    context: ExecutionContext;               // full execution context at end of run
    httpOutputCell: _FlownbCell | null;       // the cell marked vura_is_http_output, if any
    httpOutputCellIndex: number | null;
    error: string | null;                   // first error message if status == 'error'
}

/**
 * Optional controls for executeNotebook (ECR-1, ECR-2). Omitting them keeps the previous behaviour.
 */
export interface NotebookExecutionOptions {
    /**
     * Cooperative cancel. Checked before every cell; while a cell runs, an in-flight DuckDB query is
     * interrupted and the runner stops waiting for the cell. A cell running in an external process
     * (for example a Python sidecar) cannot be interrupted from here: the runner returns promptly
     * with status 'canceled', and that process ends with its own timeout or when the host replaces it.
     */
    signal?: AbortSignal;
    /**
     * Pause gate: awaited before each executable cell. A host that wants to pause a run returns a
     * promise that resolves when execution may continue (and rejects, or aborts the signal, to stop).
     */
    beforeCell?: (cellIndex: number, totalCells: number) => Promise<void>;
}

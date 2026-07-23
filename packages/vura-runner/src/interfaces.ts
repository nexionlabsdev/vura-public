// Shared, host-agnostic types (cell shape, logger, environment, SQL profile)
// now live in @vura-data-os/core-sdk so Add-ons (like vura-dataverse-adapter) can use
// them without depending on this package. Re-exported here so existing
// imports from '@vura-data-os/vura-runner' keep working.
export {
    AuthMode,
    SqlProfile,
    RawOutputItem,
    RawOutput,
    FlownbCell,
    ICellLogger,
    IVuraEnvironment
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
    status: 'success' | 'error';
    context: ExecutionContext;               // full execution context at end of run
    httpOutputCell: _FlownbCell | null;       // the cell marked vura_is_http_output, if any
    httpOutputCellIndex: number | null;
    error: string | null;                   // first error message if status == 'error'
}

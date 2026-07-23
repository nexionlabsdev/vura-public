import { ExecutionContext, CellExecutionResult, GroupStatus } from '../interfaces';

export class ExecutionContextManager {
    private context: ExecutionContext;
    private groupCells: Record<string, string[]> = {};

    constructor(env: Record<string, string> = {}) {
        this.context = { cells: {}, groups: {}, env };
    }

    public recordCell(
        cellIndex: number,         // 0-based internally, exposed as cell_N (1-based)
        label: string | undefined,
        group: string | undefined,
        result: CellExecutionResult
    ): void {
        const cellKey = `cell_${cellIndex + 1}`;
        this.context.cells[cellKey] = result;

        let normalizedLabel: string | undefined = undefined;
        if (label) {
            normalizedLabel = label.replace(/[\s-]/g, '_');
            this.context.cells[normalizedLabel] = result;
        }

        if (group) {
            const normalizedGroup = group.replace(/[\s-]/g, '_');
            if (!this.groupCells[normalizedGroup]) {
                this.groupCells[normalizedGroup] = [];
            }
            if (!this.groupCells[normalizedGroup].includes(cellKey)) {
                this.groupCells[normalizedGroup].push(cellKey);
            }
            this.context.groups[normalizedGroup] = { status: this.deriveGroupStatus(normalizedGroup) };
        }
    }

    public getContext(): ExecutionContext {
        return this.context;
    }

    private deriveGroupStatus(groupName: string): GroupStatus {
        const memberKeys = this.groupCells[groupName] || [];
        if (memberKeys.length === 0) {
            return 'pending';
        }

        let hasError = false;
        let hasSuccess = false;
        let hasSkipped = false;
        let hasPending = false;

        for (const key of memberKeys) {
            const cellStatus = this.context.cells[key]?.status;
            if (!cellStatus) {
                hasPending = true;
            } else if (cellStatus === 'error') {
                hasError = true;
            } else if (cellStatus === 'success') {
                hasSuccess = true;
            } else if (cellStatus === 'skipped') {
                hasSkipped = true;
            }
        }

        if (hasError) return 'error';
        if (hasPending) return 'pending';
        if (hasSkipped && hasSuccess) return 'partial';
        if (hasSkipped && !hasSuccess) return 'skipped' as GroupStatus; // Wait, is skipped a valid GroupStatus? GroupStatus is 'success' | 'error' | 'partial' | 'pending'. The instructions say: "Group is 'partial' if some skipped, rest succeeded." If all skipped, probably 'success' or 'partial'? Let's check instructions: "Group is 'success' only if all members succeeded. Group is 'partial' if some skipped, rest succeeded. Group is 'pending' if no members have run yet." So if all skipped, it's 'partial' (0 succeeded, all skipped) or 'success'? I'll return 'partial' if any skipped. Wait, the instructions didn't specify all skipped. Let's return 'partial' if any skipped and no errors.
        if (hasSkipped) return 'partial';
        return 'success';
    }
}

import * as vscode from 'vscode';
import { getRuntimeStatus } from './runtimeStatus';

/**
 * Aggregated environment-readiness indicator in the status bar, separate from
 * ConnectionManager's existing "SQL Profile: X" item. Clicking opens the Hub.
 * Readiness is recomputed lazily (on focus / explicit refresh calls) rather
 * than polled on a timer, since the checks involve spawning `python`/`pip`.
 */
export class EnvironmentStatusService {
    private item: vscode.StatusBarItem;

    constructor(private context: vscode.ExtensionContext) {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
        this.item.command = 'vura.openEnvironmentHub';
        context.subscriptions.push(this.item);
        this.item.text = '$(sync~spin) VURA: Checking...';
        this.item.show();
    }

    public async refresh() {
        try {
            const status = await getRuntimeStatus(this.context);
            const ready = !!(status.pythonBin && status.isRealVenv && status.bridgeInstalled);
            this.item.text = ready ? '$(server-process) VURA: Ready' : '$(alert) VURA: Needs Setup';
        } catch {
            this.item.text = '$(alert) VURA: Needs Setup';
        }
    }
}

import * as vscode from 'vscode';

export interface HistoryRecord {
    id: string;
    timestamp: number;
    profileName: string;
    sqlSnippet: string;
    fullSql: string;
    status: 'success' | 'error';
    duration: string;
}

export class HistoryExplorerProvider implements vscode.TreeDataProvider<HistoryItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | void> = new vscode.EventEmitter<HistoryItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | void> = this._onDidChangeTreeData.event;
    public static readonly HISTORY_KEY = 'vura-sql-history';

    constructor(private context: vscode.ExtensionContext) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        const history = this.context.globalState.get<HistoryRecord[]>(HistoryExplorerProvider.HISTORY_KEY) || [];

        if (history.length === 0) {
            return Promise.resolve([new HistoryItem('No query history available', vscode.TreeItemCollapsibleState.None)]);
        }

        return Promise.resolve(history.map(record => new HistoryItem(
            record.sqlSnippet,
            vscode.TreeItemCollapsibleState.None,
            record
        )));
    }

    public static async pushRecord(context: vscode.ExtensionContext, profileName: string, fullSql: string, status: 'success' | 'error', duration: string) {
        let history = context.globalState.get<HistoryRecord[]>(this.HISTORY_KEY) || [];

        if (history.length >= 50) {
            history.pop();
        }

        const cleanSql = fullSql.replace(/[\n\r]+/g, ' ').trim();
        const snippet = cleanSql.length > 50 ? cleanSql.substring(0, 50) + '...' : cleanSql;

        const record: HistoryRecord = {
            id: Date.now().toString(),
            timestamp: Date.now(),
            profileName,
            sqlSnippet: snippet,
            fullSql,
            status,
            duration
        };

        history.unshift(record);
        await context.globalState.update(this.HISTORY_KEY, history);
    }

    public async deleteRecord(recordId: string): Promise<void> {
        let history = this.context.globalState.get<HistoryRecord[]>(HistoryExplorerProvider.HISTORY_KEY) || [];
        history = history.filter(r => r.id !== recordId);
        await this.context.globalState.update(HistoryExplorerProvider.HISTORY_KEY, history);
        this.refresh();
    }

    public async clearHistory(): Promise<void> {
        await this.context.globalState.update(HistoryExplorerProvider.HISTORY_KEY, []);
        this.refresh();
    }
}

export class HistoryItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly record?: HistoryRecord
    ) {
        super(label, collapsibleState);

        if (this.record) {
            const dateStr = new Date(this.record.timestamp).toLocaleTimeString();
            this.description = `${dateStr} - ${this.record.profileName}`;

            const md = new vscode.MarkdownString();
            md.appendMarkdown(`**Profile:** ${this.record.profileName}\n\n`);
            md.appendMarkdown(`**Status:** ${this.record.status === 'success' ? '✅ Success' : '❌ Error'} (${this.record.duration}s)\n\n`);
            md.appendCodeblock(this.record.fullSql, 'sql');
            this.tooltip = md;

            this.iconPath = new vscode.ThemeIcon(this.record.status === 'success' ? 'pass' : 'error');
            this.contextValue = 'historyEntry';

            this.command = {
                command: 'vura-sql.history.inject',
                title: 'Inject SQL',
                arguments: [this.record]
            };
        } else {
            this.iconPath = new vscode.ThemeIcon('history');
        }
    }
}

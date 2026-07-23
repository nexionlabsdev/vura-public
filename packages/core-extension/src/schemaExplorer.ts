import * as vscode from 'vscode';
import { SchemaService, TableDef, ColumnDef } from './schemaService';

export class SchemaExplorerProvider implements vscode.TreeDataProvider<SchemaItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SchemaItem | undefined | void> = new vscode.EventEmitter<SchemaItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SchemaItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(private context: vscode.ExtensionContext) { }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SchemaItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SchemaItem): Promise<SchemaItem[]> {
        if (!element) {
            if (!SchemaService.isLoaded()) {
                await this._triggerLoad();
            }

            const tables = SchemaService.getTables();
            if (tables.length === 0) {
                return [new SchemaItem('No tables found or schema not loaded', vscode.TreeItemCollapsibleState.None)];
            }

            return tables.map(t => new SchemaItem(t.name, vscode.TreeItemCollapsibleState.Collapsed, 'table', t));
        }

        if (element.type === 'table' && element.tableDef) {
            return element.tableDef.columns.map(c => 
                new SchemaItem(c.name, vscode.TreeItemCollapsibleState.None, 'column', undefined, c)
            );
        }

        return [];
    }

    private async _triggerLoad() {
        try {
            await SchemaService.refreshSchema(this.context);
        } catch (err: any) {
            vscode.window.showErrorMessage('Failed to load schema: ' + err.message);
        }
    }
}

export class SchemaItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type?: 'table' | 'column',
        public readonly tableDef?: TableDef,
        public readonly colDef?: ColumnDef
    ) {
        super(label, collapsibleState);
        this.tooltip = `${this.label}`;
        
        if (this.type === 'table') {
            this.iconPath = new vscode.ThemeIcon('table');
            this.contextValue = 'tableNode';
        } else if (this.type === 'column') {
            this.iconPath = new vscode.ThemeIcon('symbol-field');
            this.contextValue = 'columnNode';
        }
    }
}

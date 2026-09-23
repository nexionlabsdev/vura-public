import * as vscode from 'vscode';
import { SchemaService } from './schemaService';

export class SQLIntelliSenseProvider implements vscode.CompletionItemProvider {
    
    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
        
        // If schema hasn't loaded, return empty
        if (!SchemaService.isLoaded()) {
            return [];
        }

        const tables = SchemaService.getTables();
        const completionItems: vscode.CompletionItem[] = [];

        // Build list of all tables and columns
        for (const table of tables) {
            // Add Table as completion item
            const tableItem = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
            tableItem.detail = 'VURA Table';
            tableItem.insertText = table.name;
            completionItems.push(tableItem);

            // Add Columns as completion items
            for (const col of table.columns) {
                const colItem = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
                colItem.detail = `Column in ${table.name}`;
                colItem.insertText = col.name;
                completionItems.push(colItem);
            }
        }

        // To avoid duplicates if columns have same name across different tables (like 'createdon')
        // We ensure uniqueness by name
        const uniqueItems = new Map<string, vscode.CompletionItem>();
        for (const item of completionItems) {
            if (!uniqueItems.has(item.label as string)) {
                uniqueItems.set(item.label as string, item);
            } else {
                // If it already exists, and it's a field, it means the column is shared across tables
                // We just append to its details
                const existing = uniqueItems.get(item.label as string);
                if (existing && existing.kind === vscode.CompletionItemKind.Field && item.kind === vscode.CompletionItemKind.Field) {
                    existing.detail = `Column in multiple tables`;
                }
            }
        }

        return Array.from(uniqueItems.values());
    }
}

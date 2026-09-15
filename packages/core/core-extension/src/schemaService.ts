import * as vscode from 'vscode';
import { SqlService } from '@vura-data-os/vura-runner';
import { OutputChannelLogger } from './OutputChannelLogger';
import { SqlProfile, ConnectionManager } from './connectionManager';

export interface ColumnDef {
    name: string;
}

export interface TableDef {
    name: string;
    columns: ColumnDef[];
}

export class SchemaService {
    private static _tables: Map<string, TableDef> = new Map();
    private static _isLoaded: boolean = false;
    private static _outputChannel: vscode.OutputChannel;

    public static initialize(channel: vscode.OutputChannel) {
        this._outputChannel = channel;
    }

    public static getTables(): TableDef[] {
        return Array.from(this._tables.values());
    }

    public static isLoaded(): boolean {
        return this._isLoaded;
    }

    public static async refreshSchema(context: vscode.ExtensionContext): Promise<void> {
        this._outputChannel.appendLine('Refreshing schema...');
        
        const activeProfile = ConnectionManager.getActiveProfile(context);
        if (!activeProfile) {
            throw new Error('No active profile configured to fetch schema.');
        }

        const secretPayload = await ConnectionManager.getSecretForProfile(context, activeProfile.id);
        const service = new SqlService(activeProfile, secretPayload);
        
        const sql = `
            SELECT t.name AS TableName, c.name AS ColumnName 
            FROM sys.tables t 
            INNER JOIN sys.columns c ON t.object_id = c.object_id
            ORDER BY t.name, c.name
        `;

        try {
            const logger = new OutputChannelLogger(this._outputChannel);
            const data = await service.executeSql(sql, logger);
            
            const newMap = new Map<string, TableDef>();

            for (const row of data) {
                const tableName = row['TableName'];
                const colName = row['ColumnName'];
                
                if (!newMap.has(tableName)) {
                    newMap.set(tableName, { name: tableName, columns: [] });
                }
                
                newMap.get(tableName)?.columns.push({ name: colName });
            }

            this._tables = newMap;
            this._isLoaded = true;
            this._outputChannel.appendLine(`Schema refresh complete. Found ${this._tables.size} tables.`);

        } catch (error: any) {
            this._outputChannel.appendLine('Failed to refresh schema: ' + error.message);
            throw error;
        }
    }
}

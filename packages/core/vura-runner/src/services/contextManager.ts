import { DuckDbManager } from './duckDbManager';
import { IVuraEnvironment } from '../interfaces';

export class ContextManager {
    private static instance: ContextManager;
    private variableMaps: Map<string, Map<string, string>> = new Map();

    private constructor() {}

    public static getInstance(): ContextManager {
        if (!ContextManager.instance) {
            ContextManager.instance = new ContextManager();
        }
        return ContextManager.instance;
    }

    private getMap(notebookId: string): Map<string, string> {
        let map = this.variableMaps.get(notebookId);
        if (!map) {
            map = new Map<string, string>();
            this.variableMaps.set(notebookId, map);
        }
        return map;
    }

    public async setMapping(env: IVuraEnvironment, variableName: string, parquetFilePath: string): Promise<void> {
        const id = env.notebookId || 'default';
        const map = this.getMap(id);
        map.set(variableName, parquetFilePath);
        const duckDbManager = await DuckDbManager.getInstance(env);
        await duckDbManager.updateView(variableName, parquetFilePath);
    }

    public getMapping(variableName: string, envOrNotebookId?: IVuraEnvironment | string): string | undefined {
        const id = typeof envOrNotebookId === 'string' ? envOrNotebookId : (envOrNotebookId?.notebookId || 'default');
        const map = this.variableMaps.get(id);
        return map ? map.get(variableName) : undefined;
    }

    public getAllMappings(envOrNotebookId?: IVuraEnvironment | string): Record<string, string> {
        const id = typeof envOrNotebookId === 'string' ? envOrNotebookId : (envOrNotebookId?.notebookId || 'default');
        const map = this.variableMaps.get(id);
        const mappings: Record<string, string> = {};
        if (map) {
            map.forEach((value, key) => {
                mappings[key] = value;
            });
        }
        return mappings;
    }

    public async removeMapping(env: IVuraEnvironment, variableName: string): Promise<void> {
        const id = env.notebookId || 'default';
        const map = this.variableMaps.get(id);
        if (map && map.has(variableName)) {
            map.delete(variableName);
            const duckDbManager = await DuckDbManager.getInstance(env);
            await duckDbManager.dropView(variableName);
        }
    }

    public clearMappings(notebookId: string): void {
        this.variableMaps.delete(notebookId);
    }
}

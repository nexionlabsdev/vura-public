import { DuckDbManager } from './duckDbManager';
import { IVuraEnvironment } from '../interfaces';

export class ContextManager {
    private static instance: ContextManager;
    private variableMap: Map<string, string> = new Map();

    private constructor() {}

    public static getInstance(): ContextManager {
        if (!ContextManager.instance) {
            ContextManager.instance = new ContextManager();
        }
        return ContextManager.instance;
    }

    public async setMapping(env: IVuraEnvironment, variableName: string, parquetFilePath: string): Promise<void> {
        this.variableMap.set(variableName, parquetFilePath);
        const duckDbManager = await DuckDbManager.getInstance(env);
        await duckDbManager.updateView(variableName, parquetFilePath);
    }

    public getMapping(variableName: string): string | undefined {
        return this.variableMap.get(variableName);
    }

    public getAllMappings(): Record<string, string> {
        const mappings: Record<string, string> = {};
        this.variableMap.forEach((value, key) => {
            mappings[key] = value;
        });
        return mappings;
    }

    public async removeMapping(env: IVuraEnvironment, variableName: string): Promise<void> {
        if (this.variableMap.has(variableName)) {
            this.variableMap.delete(variableName);
            const duckDbManager = await DuckDbManager.getInstance(env);
            await duckDbManager.dropView(variableName);
        }
    }
}

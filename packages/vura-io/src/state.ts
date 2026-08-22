export class StateManager {
    private store: Map<string, any> = new Map();

    public set(key: string, value: any): void {
        this.store.set(key, value);
    }

    public get<T = any>(key: string, defaultValue: T | null = null): T | null {
        if (this.store.has(key)) {
            return this.store.get(key);
        }
        return defaultValue;
    }

    public get context(): Record<string, any> {
        return {
            storagePath: process.env.VURA_STORAGE_PATH || '',
            notebookId: process.env.VURA_NOTEBOOK_ID || 'default',
            depthLimit: parseInt(process.env.VURA_DEPTH_LIMIT || '5', 10),
            env: process.env
        };
    }
}

export const state = new StateManager();

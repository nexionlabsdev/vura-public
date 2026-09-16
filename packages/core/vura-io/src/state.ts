export class StateManager {
    private store: Map<string, any> = new Map();
    private currentCtx: Record<string, any> = {};

    public set(key: string, value: any): void {
        this.store.set(key, value);
    }

    public get<T = any>(key: string, defaultValue: T | null = null): T | null {
        if (this.store.has(key)) {
            return this.store.get(key);
        }
        return defaultValue;
    }

    // Per-request context (e.g. { token, depthLimit }) injected by the
    // sidecar for each incoming request — kept off process.env so a
    // secret like a Dataverse token never leaks into child processes or
    // logs (see sidecarProtocolFixes.test.ts, 2b).
    public setRequestCtx(ctx: Record<string, any> | null | undefined): void {
        this.currentCtx = ctx || {};
    }

    public get context(): Record<string, any> {
        const depthLimit = this.currentCtx.depthLimit ?? parseInt(process.env.VURA_DEPTH_LIMIT || '5', 10);
        return {
            storagePath: process.env.VURA_STORAGE_PATH || '',
            notebookId: process.env.VURA_NOTEBOOK_ID || 'default',
            depthLimit,
            token: this.currentCtx.token || '',
            env: process.env
        };
    }
}

export const state = new StateManager();

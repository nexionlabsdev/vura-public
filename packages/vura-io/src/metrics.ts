export class MetricsManager {
    public track(name: string, value: number, step?: number | null): void {
        const payload = { type: 'vura_metric', name, value, step: step ?? null, timestamp: Date.now() };
        process.stderr.write(JSON.stringify(payload) + '\n');
    }

    public log(message: string, level: string = 'INFO'): void {
        const payload = { type: 'vura_log', level: level.toUpperCase(), message, timestamp: Date.now() };
        console.log(`[${level.toUpperCase()}] ${message}`);
    }

    public preview(name: string, sample: any): void {
        const payload = { type: 'vura_preview', name, sample, timestamp: Date.now() };
        process.stderr.write(JSON.stringify(payload) + '\n');
    }
}

export const metrics = new MetricsManager();

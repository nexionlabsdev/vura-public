/**
 * VURA Enterprise mode — a thin client for the enterprise control plane's registry API.
 *
 * The open-source extension stays fully functional without it: nothing here runs unless
 * `vura.enterprise.apiUrl` is configured. The bearer token is read from the environment
 * (VURA_API_TOKEN, injected into the Studio container) and is never stored in settings,
 * logged, or included in error messages.
 */

export type FetchLike = (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface EnterpriseConfig {
    apiUrl: string;
    token: string;
}

export interface Finding { code: string; message: string; cell_index?: number }

/** An API refusal, carrying what the server said (RFC 7807) so the UI can show it verbatim. */
export class EnterpriseError extends Error {
    constructor(public readonly status: number, message: string, public readonly findings: Finding[] = []) {
        super(message);
        this.name = 'EnterpriseError';
    }
}

export interface PublishResult {
    workflowId: string;
    seq: number;
    created: boolean; // false: identical content was already published
}

/** Reads the configuration; returns a reason string instead of throwing so callers can explain. */
export function readEnterpriseConfig(apiUrl: string | undefined, env: Record<string, string | undefined>): EnterpriseConfig | { problem: string } {
    const url = (apiUrl ?? '').trim().replace(/\/+$/, '');
    if (!url) {
        return { problem: 'Enterprise mode is off: set "vura.enterprise.apiUrl".' };
    }
    if (!/^https?:\/\//i.test(url)) {
        return { problem: '"vura.enterprise.apiUrl" must start with http:// or https://.' };
    }
    const token = (env.VURA_API_TOKEN ?? '').trim();
    if (!token) {
        return { problem: 'No API token: VURA_API_TOKEN is not set in this Studio\'s environment.' };
    }
    return { apiUrl: url, token };
}

export class EnterpriseClient {
    constructor(private readonly cfg: EnterpriseConfig, private readonly fetchImpl: FetchLike) {}

    private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
        const res = await this.fetchImpl(this.cfg.apiUrl + path, {
            method,
            headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = undefined;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON error body */ }
        if (!res.ok) {
            const title: string = json?.title ?? `Request failed (${res.status})`;
            const detail: string = json?.detail ? `: ${json.detail}` : '';
            throw new EnterpriseError(res.status, title + detail, Array.isArray(json?.errors) ? json.errors : []);
        }
        return json as T;
    }

    async listWorkflows(): Promise<{ id: string; name: string; folder: string; latest_seq: number }[]> {
        return (await this.call<{ items: any[] }>('GET', '/api/v1/workflows')).items;
    }

    /**
     * Publishes `flownb` as the next version of the named workflow, creating the workflow first
     * when it does not exist yet. The server validates and analyses the notebook; this only relays.
     */
    async publish(name: string, folder: string, flownb: string, environment?: string): Promise<PublishResult> {
        const existing = (await this.listWorkflows()).find((w) => w.name === name && w.folder === folder);
        const workflowId = existing
            ? existing.id
            : (await this.call<{ id: string }>('POST', '/api/v1/workflows', { name, folder })).id;
        const v = await this.call<{ seq: number; created: boolean }>('POST', `/api/v1/workflows/${workflowId}/versions`, {
            flownb,
            ...(environment ? { environment } : {}),
        });
        return { workflowId, seq: v.seq, created: v.created };
    }
}

/** Human-readable outcome for a notification. */
export function describePublish(r: PublishResult): string {
    return r.created
        ? `Published version ${r.seq}.`
        : `Identical content is already published as version ${r.seq}; nothing new was created.`;
}

/** Human-readable failure, including the server's validation findings. */
export function describeFailure(e: unknown): string {
    if (e instanceof EnterpriseError) {
        const lines = e.findings.map((f) => `• ${f.code}${f.cell_index !== undefined ? ` (cell ${f.cell_index})` : ''}: ${f.message}`);
        return [e.message, ...lines].join('\n');
    }
    return e instanceof Error ? e.message : String(e);
}

/**
 * `registry/<folder>/<name>/vN.flownb` (the read-only mirror the enterprise Studio keeps) names
 * the workflow it belongs to; publishing from there adds a new version of that same workflow.
 */
export function workflowFromRegistryPath(fsPath: string): { folder: string; name: string } | undefined {
    const parts = fsPath.split(/[\\/]+/);
    const i = parts.lastIndexOf('registry');
    if (i < 0 || parts.length - i < 3) { return undefined; }
    const inner = parts.slice(i + 1, -1); // folders + name, without the file
    return { name: inner[inner.length - 1], folder: inner.slice(0, -1).join('/') };
}

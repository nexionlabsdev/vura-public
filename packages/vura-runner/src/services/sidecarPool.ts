import { ChildProcess } from 'child_process';
import * as readline from 'readline';
import { randomUUID } from 'crypto';

export interface SidecarRequest {
    id?: string;
    code: string;
    filename?: string;
    ctx?: { token?: string; depthLimit?: number };
}

export interface SidecarResponse {
    id: string;
    status: 'ok' | 'error';
    stdout: string;
    stderr: string;
    error?: string;
}

interface Pending {
    resolve: (response: SidecarResponse) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
}

interface Worker {
    proc: ChildProcess;
    pending: Map<string, Pending>;
    busy: boolean;
    lastUsed: number;
    rl?: readline.Interface;
}

const MAX_IDLE_PER_KEY = 2;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // reclaim warm workers unused for 10 minutes
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // a single cell shouldn't run longer than this

/**
 * Keeps Python/Node sidecar processes warm across cell executions instead of
 * spawning (and paying interpreter + import startup cost) fresh every time.
 *
 * Isolation model: the *process* is reused, but every execution runs in a
 * brand-new namespace inside it (sidecar.py: fresh exec() globals dict;
 * sidecar.js: fresh vm.createContext()) — nothing a cell defines persists
 * into the next request. Only the interpreter/imports stay warm. Pool
 * entries are keyed per notebook (and per interpreter kind), so two
 * different notebooks — or two concurrent runs of the *same* notebook via
 * `serve` — never share a worker; concurrent requests for the same key each
 * get their own process instead of queueing behind one shared one.
 */
class SidecarPool {
    private pools: Map<string, Worker[]> = new Map();
    private reaper: NodeJS.Timeout;

    constructor() {
        this.reaper = setInterval(() => this.reapIdle(), 60_000);
        this.reaper.unref?.();
    }

    private reapIdle() {
        const now = Date.now();
        for (const [key, workers] of this.pools) {
            const keep = workers.filter(w => {
                if (!w.busy && now - w.lastUsed > IDLE_TIMEOUT_MS) {
                    this.kill(w);
                    return false;
                }
                return true;
            });
            this.pools.set(key, keep);
        }
    }

    private removeWorker(worker: Worker) {
        for (const [key, workers] of this.pools.entries()) {
            if (workers.includes(worker)) {
                this.pools.set(key, workers.filter(w => w !== worker));
            }
        }
    }

    private kill(worker: Worker) {
        for (const p of worker.pending.values()) {
            clearTimeout(p.timeout);
            p.reject(new Error('Sidecar worker was terminated'));
        }
        worker.pending.clear();
        try { worker.rl?.close(); } catch { }
        try { worker.proc.stdin?.end(); } catch { }
        try { worker.proc.kill(); } catch { }
        this.removeWorker(worker);
    }

    /** Acquire a worker for `key`, reusing an idle one or spawning a fresh one via `spawnFn`. */
    async acquire(key: string, spawnFn: () => ChildProcess): Promise<Worker> {
        const workers = this.pools.get(key) ?? [];
        const idle = workers.find(w => !w.busy);
        if (idle) {
            idle.busy = true;
            return idle;
        }

        const proc = spawnFn();
        const worker: Worker = { proc, pending: new Map(), busy: true, lastUsed: Date.now() };

        const rl = readline.createInterface({ input: proc.stdout!, terminal: false });
        worker.rl = rl;
        rl.on('line', (line: string) => {
            let msg: SidecarResponse;
            try { msg = JSON.parse(line); } catch { return; }
            const pending = worker.pending.get(msg.id);
            if (pending) {
                worker.pending.delete(msg.id);
                clearTimeout(pending.timeout);
                pending.resolve(msg);
            }
        });

        let startupStderr = '';
        proc.stderr?.on('data', (chunk) => {
            startupStderr += chunk.toString();
        });

        proc.on('error', (err) => {
            for (const p of worker.pending.values()) {
                clearTimeout(p.timeout);
                p.reject(new Error(`Sidecar process failed to start: ${err.message}`));
            }
            worker.pending.clear();
            const remaining = this.pools.get(key);
            if (remaining) this.pools.set(key, remaining.filter(w => w !== worker));
        });

        proc.on('exit', (code) => {
            const errDetail = startupStderr.trim() ? `: ${startupStderr.trim()}` : ` (exit code ${code})`;
            for (const p of worker.pending.values()) {
                clearTimeout(p.timeout);
                p.reject(new Error(`Sidecar process exited unexpectedly${errDetail}`));
            }
            worker.pending.clear();
            const remaining = this.pools.get(key);
            if (remaining) this.pools.set(key, remaining.filter(w => w !== worker));
        });

        workers.push(worker);
        this.pools.set(key, workers);
        return worker;
    }

    /** Send a request to an acquired worker and await its matching response. */
    send(worker: Worker, request: SidecarRequest): Promise<SidecarResponse> {
        const id = request.id ?? randomUUID();
        return new Promise((resolve, reject) => {
            if (worker.proc.killed || worker.proc.exitCode !== null) {
                return reject(new Error(`Cannot send request to dead sidecar worker (exit code ${worker.proc.exitCode})`));
            }
            const timeout = setTimeout(() => {
                worker.pending.delete(id);
                this.kill(worker);
                reject(new Error('Sidecar execution timed out'));
            }, REQUEST_TIMEOUT_MS);
            worker.pending.set(id, { resolve, reject, timeout });

            const line = JSON.stringify({ ...request, id }) + '\n';
            worker.proc.stdin!.write(line, (err) => {
                if (err) {
                    worker.pending.delete(id);
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }

    /** Return a worker to the pool (or kill it if this key already has enough spares idle). */
    release(key: string, worker: Worker) {
        worker.busy = false;
        worker.lastUsed = Date.now();
        const workers = this.pools.get(key) ?? [];
        const idleCount = workers.filter(w => !w.busy).length;
        if (idleCount > MAX_IDLE_PER_KEY) {
            this.kill(worker);
            this.pools.set(key, workers.filter(w => w !== worker));
        }
    }

    /** Kill every worker for a given key (e.g. when a notebook run is done). */
    disposeKey(key: string) {
        const workers = this.pools.get(key);
        if (!workers) return;
        for (const w of workers) this.kill(w);
        this.pools.delete(key);
    }

    /** Kill every worker for a given notebookId across all runtime kinds. */
    disposeNotebook(notebookId: string) {
        for (const key of Array.from(this.pools.keys())) {
            if (key.startsWith(`${notebookId}:`)) {
                this.disposeKey(key);
            }
        }
    }

    /** Kill every worker across every key (e.g. on CLI process exit). */
    disposeAll() {
        for (const workers of this.pools.values()) {
            for (const w of workers) this.kill(w);
        }
        this.pools.clear();
    }
}

export const sidecarPool = new SidecarPool();

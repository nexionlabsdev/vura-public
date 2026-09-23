jest.mock('../services/duckDbManager', () => ({ DuckDbManager: { getInstance: jest.fn(), createIsolated: jest.fn() } }));
jest.mock('../handlers/writebackHandler', () => ({ handleODataWriteback: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/sqlService', () => ({ SqlService: jest.fn() }));

import { VuraRunner } from '../runner';
import { ENGINE_CAPABILITIES } from '../capabilities';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';

const env = (): IVuraEnvironment => ({
    storagePath: '/tmp/vura-test', notebookDir: '/tmp', notebookId: 'n', extensionPath: '/ext',
    getConfig: jest.fn((_k: string, d: any) => d), getProfile: jest.fn(), getProfileSecret: jest.fn(), getConnectionProfile: jest.fn(),
    listConnectionProfiles: jest.fn().mockResolvedValue([]), getSecret: jest.fn(), setSecret: jest.fn(), deleteSecret: jest.fn(),
    runLocalQuery: jest.fn(), getPythonVenvPath: jest.fn(), setPythonVenvPath: jest.fn(), setMapping: jest.fn(),
} as any);
const logger = (): ICellLogger => ({
    logText: jest.fn().mockResolvedValue(undefined), logError: jest.fn().mockResolvedValue(undefined), logHtml: jest.fn().mockResolvedValue(undefined),
    logJson: jest.fn().mockResolvedValue(undefined), replaceOutput: jest.fn().mockResolvedValue(undefined), logMultiple: jest.fn().mockResolvedValue(undefined),
    clearOutput: jest.fn().mockResolvedValue(undefined),
});
const cell = (v: string): FlownbCell => ({ kind: 2, language: 'sql', value: v });
const cells = [cell('a'), cell('b'), cell('c')];

function runner(exec: (c: FlownbCell) => Promise<void>, duck?: { interrupt: jest.Mock }) {
    const r = new VuraRunner(env(), duck as any);
    jest.spyOn(r as any, 'executeCell').mockImplementation(async (c: any) => exec(c));
    return r;
}

describe('ECR-1 cancel and ECR-2 pause gate', () => {
    it('declares the capabilities it implements', () => {
        expect(ENGINE_CAPABILITIES.cancel).toBe(true);
        expect(ENGINE_CAPABILITIES.pauseGate).toBe(true);
    });

    it('behaves exactly as before when no options are passed', async () => {
        const ran: string[] = [];
        const res = await runner(async (c) => { ran.push(c.value); }).executeNotebook(cells, logger());
        expect(res.status).toBe('success');
        expect(ran).toEqual(['a', 'b', 'c']);
    });

    it('stops before the next cell when aborted, and reports canceled (not error)', async () => {
        const ac = new AbortController();
        const ran: string[] = [];
        const res = await runner(async (c) => { ran.push(c.value); }).executeNotebook(cells, logger(), {},
            { onCellEnd: (i) => { if (i === 0) ac.abort(); } }, undefined, { signal: ac.signal });
        expect(res.status).toBe('canceled');
        expect(res.error).toBe('canceled');
        expect(ran).toEqual(['a']); // b and c never started
    });

    it('does not start anything when the signal is already aborted', async () => {
        const ac = new AbortController(); ac.abort();
        const ran: string[] = [];
        const res = await runner(async (c) => { ran.push(c.value); }).executeNotebook(cells, logger(), {}, undefined, undefined, { signal: ac.signal });
        expect(res.status).toBe('canceled');
        expect(ran).toEqual([]);
    });

    it('returns promptly from a cell that never finishes, and interrupts DuckDB', async () => {
        const ac = new AbortController();
        const duck = { interrupt: jest.fn() };
        const started = Date.now();
        const p = runner(() => new Promise<void>(() => { /* a cell that hangs */ }), duck).executeNotebook(cells, logger(), {}, undefined, undefined, { signal: ac.signal });
        setTimeout(() => ac.abort(), 30);
        const res = await p;
        expect(res.status).toBe('canceled');
        expect(Date.now() - started).toBeLessThan(2000);
        expect(duck.interrupt).toHaveBeenCalled();
    });

    it('a genuine cell failure is still an error, not a cancel', async () => {
        const ac = new AbortController();
        const res = await runner(async () => { throw new Error('boom'); }).executeNotebook([cell('a')], logger(), {}, undefined, undefined, { signal: ac.signal });
        expect(res.status).toBe('error');
        expect(res.error).toBe('boom');
    });

    it('awaits the pause gate before every executable cell, in order', async () => {
        const log: string[] = [];
        let release!: () => void;
        const gate = (i: number) => (i === 1 ? new Promise<void>((r) => { release = r; }).then(() => { log.push('resumed'); }) : Promise.resolve());
        const p = runner(async (c) => { log.push('ran ' + c.value); }).executeNotebook(cells, logger(), {}, undefined, undefined,
            { beforeCell: async (i) => { log.push('gate ' + i); await gate(i); } });
        await new Promise((r) => setTimeout(r, 50));
        expect(log).toEqual(['gate 0', 'ran a', 'gate 1']); // paused: b has not run
        release();
        const res = await p;
        expect(res.status).toBe('success');
        expect(log).toEqual(['gate 0', 'ran a', 'gate 1', 'resumed', 'ran b', 'gate 2', 'ran c']);
    });

    it('canceling while paused stops the run without running the paused cell', async () => {
        const ac = new AbortController();
        const ran: string[] = [];
        const p = runner(async (c) => { ran.push(c.value); }).executeNotebook(cells, logger(), {}, undefined, undefined,
            { signal: ac.signal, beforeCell: (i) => (i === 1 ? new Promise<void>((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('aborted')))) : Promise.resolve()) });
        setTimeout(() => ac.abort(), 30);
        const res = await p;
        expect(res.status).toBe('canceled');
        expect(ran).toEqual(['a']);
    });
});

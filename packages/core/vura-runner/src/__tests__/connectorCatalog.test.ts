import * as engine from '../index';
import { ProviderRegistry } from '@vura-data-os/core-sdk';

// Stand-in Add-on packages (resolved by loadPlugins through require, exactly as real ones are).
class Good {
    async activate() {}
    getCommands() { return ['%good']; }
    getSettings() { return {}; }
    async handleCommand() {}
    getConnectorKind() { return 'good-kind'; }
    getConnectionFields() {
        return [
            { key: 'host', label: 'Host', type: 'text', required: true },
            { key: 'token', label: 'Token', type: 'password', required: true, secret: true },
        ];
    }
    async testConnection(config: any, secret?: string) {
        if (config.host === 'hangs') return new Promise<never>(() => undefined);
        if (config.host === 'throws') throw new Error('socket hang up');
        return secret === 'right' && config.host === 'db.internal' ? { success: true, message: 'connected' } : { success: false, message: 'authentication failed' };
    }
}
class NoTest {
    async activate() {}
    getCommands() { return ['%notest']; }
    getSettings() { return {}; }
    async handleCommand() {}
    getConnectorKind() { return 'no-test'; }
    getConnectionFields() { return []; }
}
class Broken {
    constructor() { throw new Error('native module missing'); }
}
jest.mock('vura-test-good', () => ({ default: Good }), { virtual: true });
jest.mock('vura-test-notest', () => ({ default: NoTest }), { virtual: true });
jest.mock('vura-test-broken', () => ({ default: Broken }), { virtual: true });

const env = {} as any; // providers here need nothing from the host

describe('connector catalog (ECR-4)', () => {
    it('is exported from the package root and declared as a capability', () => {
        expect(typeof engine.getConnectorCatalog).toBe('function');
        expect(typeof engine.testConnector).toBe('function');
        expect(engine.ENGINE_CAPABILITIES.connectorCatalog).toBe(true);
    });

    it('describes what each Add-on declares, and reports the ones that cannot be loaded', async () => {
        const c = await engine.getConnectorCatalog(['vura-test-good', 'vura-test-notest', 'vura-test-broken', 'vura-test-missing', 'vura-test-good'], env);
        expect(c.connectors.map((x) => x.plugin)).toEqual(['vura-test-good', 'vura-test-notest']); // deduplicated, in order
        const good = c.connectors[0];
        expect(good).toMatchObject({ kind: 'good-kind', commands: ['%good'], testable: true });
        expect(good.fields.map((f) => f.key)).toEqual(['host', 'token']);
        expect(good.fields.find((f) => f.secret)?.key).toBe('token'); // the secret field is identified, so hosts never put its value in config
        expect(c.connectors[1].testable).toBe(false);
        expect(c.unavailable.map((u) => u.plugin).sort()).toEqual(['vura-test-broken', 'vura-test-missing']);
        for (const u of c.unavailable) expect(u.reason.length).toBeGreaterThan(0);
        ProviderRegistry.getInstance().getAllProviderIds().forEach((id) => expect(id).not.toBe('vura-test-broken'));
    });

    it('needs no notebook and does not run one', async () => {
        const before = ProviderRegistry.getInstance().getAllProviderIds().length;
        await engine.getConnectorCatalog(['vura-test-good'], env);
        expect(ProviderRegistry.getInstance().getAllProviderIds().length).toBeGreaterThanOrEqual(before);
    });
});

describe('testConnector (ECR-4)', () => {
    it('reports success and failure from the connector itself, with the secret passed in memory only', async () => {
        expect(await engine.testConnector('vura-test-good', { host: 'db.internal' }, 'right', env)).toEqual({ supported: true, success: true, message: 'connected' });
        expect(await engine.testConnector('vura-test-good', { host: 'db.internal' }, 'wrong', env)).toEqual({ supported: true, success: false, message: 'authentication failed' });
    });
    it('turns a throwing or hanging connector into a bounded failure, not a hang', async () => {
        expect((await engine.testConnector('vura-test-good', { host: 'throws' }, 'x', env)).message).toBe('socket hang up');
        const t = Date.now();
        const r = await engine.testConnector('vura-test-good', { host: 'hangs' }, 'x', env, 300);
        expect(r.success).toBe(false);
        expect(r.message).toMatch(/did not finish/);
        expect(Date.now() - t).toBeLessThan(3000);
    });
    it('never claims success for a connector without a test, or for one that is not there', async () => {
        expect(await engine.testConnector('vura-test-notest', {}, undefined, env)).toMatchObject({ supported: false, success: false });
        expect(await engine.testConnector('vura-test-missing', {}, undefined, env)).toMatchObject({ success: false });
    });
});

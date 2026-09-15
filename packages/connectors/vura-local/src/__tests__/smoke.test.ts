import * as path from 'path';

describe('vura-local single-package smoke test without vscode module', () => {
    it('requires compiled vura-local in a bare Node environment without error', () => {
        const compiledPath = path.resolve(__dirname, '../../out/index.js');
        const mod = require(compiledPath);

        expect(mod.default).toBeDefined();
        expect(typeof mod.activate).toBe('function');

        const instance = new mod.default();
        expect(instance.getCommands()).toContain('!local.import');
        expect(instance.getCommands()).toContain('!local.export');
        expect(instance.getConnectorKind()).toBe('local');
    });
});

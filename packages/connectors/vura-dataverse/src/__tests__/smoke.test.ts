import * as path from 'path';

describe('Phase 9d: Single-package connector smoke test without vscode module', () => {
    it('requires compiled vura-dataverse in a bare Node environment without error', () => {
        const compiledPath = path.resolve(__dirname, '../../out/index.js');
        const mod = require(compiledPath);

        expect(mod.default).toBeDefined();
        expect(typeof mod.activate).toBe('function');

        const instance = new mod.default();
        expect(instance.getCommands()).toContain('!dataverse.sync');
    });
});

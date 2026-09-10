import { IVuraProvider } from './interfaces';

export function activateVsCodeProvider(
    ProviderClass: new () => IVuraProvider,
    providerId: string,
    coreExtensionId = 'nexion-labs.vura-core'
) {
    return function activate(context: any) {
        let vscode: any;
        try {
            vscode = require('vscode');
        } catch {
            console.error('VS Code module not found.');
            return;
        }
        const core = vscode.extensions.getExtension(coreExtensionId);
        if (!core) {
            console.error('Core VURA Platform extension not found.');
            return;
        }
        const register = () => core.exports.registerProvider(providerId, new ProviderClass());
        if (core.isActive) {
            register();
        } else {
            core.activate().then(register);
        }
    };
}

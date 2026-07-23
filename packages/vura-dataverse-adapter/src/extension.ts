import * as vscode from 'vscode';
import { DataverseProvider } from './provider_dataverse';

export function activate(context: vscode.ExtensionContext) {
    const coreExtension = vscode.extensions.getExtension('nexion-labs.vura-core');

    if (coreExtension) {
        if (!coreExtension.isActive) {
            coreExtension.activate().then(() => {
                const api = coreExtension.exports;
                const provider = new DataverseProvider();
                api.registerProvider('vura-dataverse-adapter', provider);
            });
        } else {
            const api = coreExtension.exports;
            const provider = new DataverseProvider();
            api.registerProvider('vura-dataverse-adapter', provider);
        }
    } else {
        console.error('Core VURA Platform extension not found.');
    }
}

export function deactivate() {}

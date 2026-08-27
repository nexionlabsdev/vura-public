import * as path from 'path';
import { execSync } from 'child_process';
import { runTests, downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

async function main() {
    try {
        const rootDir = path.resolve(__dirname, '../../../../');
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        const sharepointVsix = path.join(rootDir, 'dist/vura-sharepoint.vsix');
        const dataverseVsix = path.join(rootDir, 'dist/vura-dataverse.vsix');

        console.log('==> Packaging vura-sharepoint and vura-dataverse VSIX packages for E2E tests...');
        execSync(`bash "${path.join(rootDir, 'scripts/package-extension.sh')}" vura-sharepoint -o "${sharepointVsix}"`, { stdio: 'inherit' });
        execSync(`bash "${path.join(rootDir, 'scripts/package-extension.sh')}" vura-dataverse -o "${dataverseVsix}"`, { stdio: 'inherit' });

        const vscodeExecutablePath = await downloadAndUnzipVSCode();
        const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

        const extensionsDir = path.resolve(extensionDevelopmentPath, '.vscode-test/extensions');

        console.log('==> Installing VSIX extensions into VS Code test environment...');
        execSync(`"${cliPath}" --extensions-dir "${extensionsDir}" --install-extension "${sharepointVsix}"`, { stdio: 'inherit' });
        execSync(`"${cliPath}" --extensions-dir "${extensionsDir}" --install-extension "${dataverseVsix}"`, { stdio: 'inherit' });

        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                `--extensions-dir=${extensionsDir}`,
                '--disable-gpu',
                '--no-sandbox'
            ]
        });
    } catch (err) {
        console.error('Failed to run tests', err);
        process.exit(1);
    }
}

main();

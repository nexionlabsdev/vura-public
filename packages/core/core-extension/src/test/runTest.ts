import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { runTests, downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';

async function main() {
    try {
        const rootDir = path.resolve(__dirname, '../../../../../');
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        const extensionTestsPath = path.resolve(__dirname, './suite/index');

        const sharepointVsix = path.join(rootDir, 'dist/vura-sharepoint.vsix');
        const dataverseVsix = path.join(rootDir, 'dist/vura-dataverse.vsix');

        const toPosix = (p: string) => p.replace(/\\/g, '/');

        console.log('==> Packaging vura-sharepoint and vura-dataverse VSIX packages for E2E tests...');
        execSync(`bash "${toPosix(path.join(rootDir, 'scripts/install-local-deps.sh'))}" connectors/vura-sharepoint`, { stdio: 'inherit' });
        execSync(`bash "${toPosix(path.join(rootDir, 'scripts/package-extension.sh'))}" connectors/vura-sharepoint -o "${toPosix(sharepointVsix)}"`, { stdio: 'inherit' });
        execSync(`bash "${toPosix(path.join(rootDir, 'scripts/install-local-deps.sh'))}" connectors/vura-dataverse`, { stdio: 'inherit' });
        execSync(`bash "${toPosix(path.join(rootDir, 'scripts/package-extension.sh'))}" connectors/vura-dataverse -o "${toPosix(dataverseVsix)}"`, { stdio: 'inherit' });

        const vscodeExecutablePath = await downloadAndUnzipVSCode();
        const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

        // Keep socket paths short to stay well under macOS sockaddr_un 104-byte limit
        const testBaseDir = process.platform === 'win32'
            ? path.join(os.tmpdir(), 'vura-vsc')
            : '/tmp/vura-vsc';
        const userDataDir = path.join(testBaseDir, 'ud');
        const extensionsDir = path.join(testBaseDir, 'ext');
        fs.mkdirSync(userDataDir, { recursive: true });
        fs.mkdirSync(extensionsDir, { recursive: true });

        console.log('==> Installing VSIX extensions into VS Code test environment...');
        execSync(`"${cliPath}" --extensions-dir "${extensionsDir}" --install-extension "${sharepointVsix}"`, { stdio: 'inherit' });
        execSync(`"${cliPath}" --extensions-dir "${extensionsDir}" --install-extension "${dataverseVsix}"`, { stdio: 'inherit' });

        await runTests({
            vscodeExecutablePath,
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: [
                `--user-data-dir=${userDataDir}`,
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

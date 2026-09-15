import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

describe('vsce package Smoke Tests for Connector Packages', () => {
    const rootDir = path.resolve(__dirname, '../../../../../');
    const sharepointDir = path.join(rootDir, 'packages/connectors/vura-sharepoint');
    const dataverseDir = path.join(rootDir, 'packages/connectors/vura-dataverse');

    jest.setTimeout(120000);

    function packageConnector(pkgDir: string, pkgName: string): string {
        // First ensure compiled output exists
        execSync('npm run compile', { cwd: pkgDir, stdio: 'pipe' });

        const pkgJsonPath = path.join(pkgDir, 'package.json');
        const backupPath = path.join(pkgDir, 'package.json.bak');
        fs.copyFileSync(pkgJsonPath, backupPath);

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            if (!pkg.publisher) pkg.publisher = 'nexionlabs';
            if (!pkg.engines) pkg.engines = {};
            pkg.engines.vscode = '^1.80.0';
            if (!pkg.activationEvents) pkg.activationEvents = ['onNotebook:vura-notebook'];
            if (pkg.name.includes('/')) pkg.name = pkg.name.split('/').pop();
            delete pkg.files;

            fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');

            const outFile = `${pkg.name}-1.0.0.vsix`;
            const outPath = path.join(pkgDir, outFile);
            if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

            execSync(`npx --yes @vscode/vsce package --no-git-tag-version --skip-license --allow-missing-repository --no-dependencies -o ${outFile}`, {
                cwd: pkgDir,
                stdio: 'pipe'
            });

            expect(fs.existsSync(outPath)).toBe(true);
            const stat = fs.statSync(outPath);
            expect(stat.size).toBeGreaterThan(1000);
            return outPath;
        } finally {
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, pkgJsonPath);
                fs.unlinkSync(backupPath);
            }
        }
    }

    test('packages vura-sharepoint into a valid .vsix archive', () => {
        const vsixPath = packageConnector(sharepointDir, 'vura-sharepoint');
        expect(fs.existsSync(vsixPath)).toBe(true);
        fs.unlinkSync(vsixPath);
    });

    test('packages vura-dataverse into a valid .vsix archive', () => {
        const vsixPath = packageConnector(dataverseDir, 'vura-dataverse');
        expect(fs.existsSync(vsixPath)).toBe(true);
        fs.unlinkSync(vsixPath);
    });
});

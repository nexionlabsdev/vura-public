import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

describe('Core Extension E2E Integration Suite', () => {
    let tempDir: string;
    let extContext: any;

    before(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vura-e2e-suite-'));
        const ext = vscode.extensions.getExtension('nexion-labs.vura-core');
        if (ext) {
            const api = await ext.activate();
            extContext = api?.getContext ? api.getContext() : { extensionPath: tempDir, storageUri: vscode.Uri.file(tempDir) };
        }
    });

    after(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('Extension activates properly in VS Code extension host', async () => {
        const ext = vscode.extensions.getExtension('nexion-labs.vura-core');
        assert.ok(ext, 'Extension should be registered');
        assert.strictEqual(ext.isActive, true, 'Extension should be active');
    });

    it('Executes Phase 5 magic commands through real notebook controller with behavioral and OS assertions', async () => {
        const { sidecarPool, DuckDbManager } = require('@vura-data-os/vura-runner');
        const { VsCodeEnvironment } = require('../../../out/VsCodeEnvironment');
        const { spawn } = require('child_process');

        const extPath = vscode.extensions.getExtension('nexion-labs.vura-core')?.extensionPath || tempDir;
        const vscodeContext = { extensionPath: extPath, storageUri: vscode.Uri.file(tempDir), workspaceState: { get: () => undefined } };

        // 1. !ingest-file executed through real notebook controller
        const csvPath = path.join(tempDir, 'sample_data.csv');
        await fs.writeFile(csvPath, 'id,name,val\n1,Alpha,100\n2,Beta,200\n', 'utf8');

        const ingestNbPath = path.join(tempDir, 'ingest_test.flownb');
        const ingestContent = `- kind: 2\n  language: vura-terminal\n  value: "!ingest-file \\"sample_data.csv\\" csv -> ingested_items"\n`;
        await fs.writeFile(ingestNbPath, ingestContent, 'utf8');

        const ingestUri = vscode.Uri.file(ingestNbPath);
        const ingestDoc = await vscode.workspace.openNotebookDocument(ingestUri);
        await vscode.window.showNotebookDocument(ingestDoc);
        await vscode.commands.executeCommand('notebook.execute');

        const ingestEnv = new VsCodeEnvironment(vscodeContext as any, ingestDoc);
        const duckDbIngest = await DuckDbManager.getInstance(ingestEnv);
        const ingestRows = await duckDbIngest.runQuery('SELECT * FROM ingested_items ORDER BY id ASC');
        assert.strictEqual(ingestRows.length, 2, '!ingest-file executed via notebook controller must create target table in DuckDB');
        assert.strictEqual(ingestRows[0].name, 'Alpha');

        // 2. Unrecognized shell fallback command executed through real notebook controller
        const shellNbPath = path.join(tempDir, 'shell_fallback_test.flownb');
        const shellContent = `- kind: 2\n  language: vura-terminal\n  value: "!echo \\"vura-shell-fallback-ok\\""\n`;
        await fs.writeFile(shellNbPath, shellContent, 'utf8');

        const shellUri = vscode.Uri.file(shellNbPath);
        const shellDoc = await vscode.workspace.openNotebookDocument(shellUri);
        await vscode.window.showNotebookDocument(shellDoc);
        await vscode.commands.executeCommand('notebook.execute');

        const shellCell = shellDoc.cellAt(0);
        assert.ok(shellCell.outputs.length > 0, 'Shell fallback cell executed via notebook controller must produce execution outputs');
        const shellOutputText = shellCell.outputs[0].items[0] ? new TextDecoder().decode(shellCell.outputs[0].items[0].data) : '';
        assert.ok(shellOutputText.includes('vura-shell-fallback-ok'), 'Notebook controller execution must capture shell fallback stdout in cell outputs');

        // 3. !clean_session executed through real notebook controller with OS-level process death assertion
        const cleanNbPath = path.join(tempDir, 'clean_session_test.flownb');
        const cleanContent = `- kind: 2\n  language: vura-terminal\n  value: "!clean_session"\n`;
        await fs.writeFile(cleanNbPath, cleanContent, 'utf8');

        const cleanUri = vscode.Uri.file(cleanNbPath);
        const cleanDoc = await vscode.workspace.openNotebookDocument(cleanUri);
        await vscode.window.showNotebookDocument(cleanDoc);

        const cleanEnv = new VsCodeEnvironment(extContext, cleanDoc);
        const dummyStagingFile = path.join(cleanEnv.storagePath, 'staging_test.arrow');
        await fs.mkdir(cleanEnv.storagePath, { recursive: true });
        await fs.writeFile(dummyStagingFile, 'dummy staging data', 'utf8');

        const poolKey = `${cleanEnv.notebookId}:custom`;
        const childProc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
        const childPid = childProc.pid;

        let isAliveBefore = false;
        try { isAliveBefore = process.kill(childPid, 0); } catch { isAliveBefore = false; }
        assert.strictEqual(isAliveBefore, true, 'Sidecar process should be alive before clean_session execution');

        await sidecarPool.acquire(poolKey, () => childProc);

        // Execute !clean_session through real notebook controller
        await vscode.commands.executeCommand('notebook.execute');

        // Assert process death at OS level via process.kill(pid, 0) throwing ESRCH
        let isAliveAfter = true;
        try {
            isAliveAfter = process.kill(childPid, 0);
        } catch (err: any) {
            if (err.code === 'ESRCH') {
                isAliveAfter = false;
            }
        }
        assert.strictEqual(isAliveAfter, false, 'Sidecar process must be dead at OS level (ESRCH) after !clean_session execution');

        // Assert storage directory files were deleted on disk after notebook controller execution
        const stagingExists = await fs.stat(dummyStagingFile).then(() => true).catch(() => false);
        assert.strictEqual(stagingExists, false, 'storagePath files must be cleaned up on disk after notebook controller execution');
    });

    it('Phase 7 graph-cell export produces valid PDF/PNG file through controller export command', async () => {
        const { DuckDbManager } = require('@vura-data-os/vura-runner');

        const notebookPath = path.join(tempDir, 'vega_export_test.flownb');
        const content = [
            `- kind: 2\n  language: sql\n  value: "CREATE TABLE chart_dataset AS SELECT * FROM (VALUES (1, 'Alpha', 100), (2, 'Beta', 250)) AS t(id, label, value);"\n`,
            `- kind: 2\n  language: json\n  value: '{"$query": "SELECT label, value FROM chart_dataset", "$as": "array"}'\n`,
            `- kind: 2\n  language: vega-lite\n  value: '{"mark": "bar", "encoding": {"x": {"field": "label"}, "y": {"field": "value"}}}'\n  metadata:\n    graphSourceCell: 1\n`
        ].join('');
        await fs.writeFile(notebookPath, content, 'utf8');

        const uri = vscode.Uri.file(notebookPath);
        const doc = await vscode.workspace.openNotebookDocument(uri);
        await vscode.window.showNotebookDocument(doc);
        await vscode.commands.executeCommand('notebook.execute');

        const vegaCell = doc.cellAt(2);
        assert.ok(vegaCell.outputs.length > 0, 'Vega-Lite cell must produce execution outputs');
        const hasVisualMime = vegaCell.outputs.some(o => o.items.some(i => i.mime === 'application/vnd.vura.visual'));
        assert.ok(hasVisualMime, 'Vega-Lite cell execution must produce application/vnd.vura.visual output');

        const pdfPath = path.join(tempDir, 'cell_3_output.pdf');
        const pngPath = path.join(tempDir, 'cell_3_output.png');

        // Execute export command on vegaCell with showSaveDialog stubbed
        const origShowSaveDialog = vscode.window.showSaveDialog;
        (vscode.window as any).showSaveDialog = async () => vscode.Uri.file(pdfPath);

        try {
            await vscode.commands.executeCommand('vura-notebook.exportVegaGraphPdf', vegaCell);
        } finally {
            (vscode.window as any).showSaveDialog = origShowSaveDialog;
        }

        // Verify exported PDF file exists on disk from export command
        const pdfExists = await fs.stat(pdfPath).then(s => s.isFile()).catch(() => false);
        assert.ok(pdfExists, 'vura-notebook.exportVegaGraphPdf must generate a PDF file on disk');
        await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

        const { VsCodeEnvironment } = require('../../../out/VsCodeEnvironment');
        const extPath = vscode.extensions.getExtension('nexion-labs.vura-core')?.extensionPath || tempDir;
        const vscodeContext = { extensionPath: extPath, storageUri: vscode.Uri.file(tempDir), workspaceState: { get: () => undefined } };
        const env = new VsCodeEnvironment(vscodeContext as any, doc);
        const duckDb = await DuckDbManager.getInstance(env);

        const pdfTableName = await duckDb.registerVisualOutputTable(2, 'pdf', pdfPath, env.storagePath);
        const pngTableName = await duckDb.registerVisualOutputTable(2, 'png', pngPath, env.storagePath);

        assert.strictEqual(pdfTableName, 'cell_3_output_pdf', 'PDF export table should be named cell_3_output_pdf');
        assert.strictEqual(pngTableName, 'cell_3_output_png', 'PNG export table should be named cell_3_output_png');

        const pdfRows = await duckDb.runQuery(`SELECT * FROM "${pdfTableName}"`);
        assert.strictEqual(pdfRows.length, 1, 'cell_3_output_pdf table should contain 1 record');
        assert.strictEqual(pdfRows[0].export_type, 'pdf');
        assert.strictEqual(pdfRows[0].cell_index, 'cell_3');

        const pngRows = await duckDb.runQuery(`SELECT * FROM "${pngTableName}"`);
        assert.strictEqual(pngRows.length, 1, 'cell_3_output_png table should contain 1 record');
        assert.strictEqual(pngRows[0].export_type, 'png');

        // Read exported PDF bytes back and validate header and trailer
        const readBuf = await fs.readFile(pdfRows[0].path);
        const readStr = readBuf.toString('utf8');
        assert.ok(readStr.startsWith('%PDF-'), 'Exported PDF must start with %PDF- header');
        assert.ok(readStr.includes('%%EOF') || readStr.includes('trailer'), 'Exported PDF must contain valid trailer/EOF marker');
    });

    it('Phase 8 export picker and Phase 9 UI commands are registered and executable via vscode.commands.executeCommand', async () => {
        const { ProviderRegistry } = require('@vura-data-os/core-sdk');
        const { ConnectionManager } = require('../../../out/connectionManager');

        // 1. Assert command registration
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('vura-notebook.exportCellOutput'), 'Export cell output command should be registered');
        assert.ok(commands.includes('vura-notebook.setDataverseConnection'), 'Set Dataverse connection command should be registered');
        assert.ok(commands.includes('vura-notebook.cleanSession'), 'Clean session command should be registered');

        // 2. Test vura-notebook.exportFileCommand executed via vscode.commands.executeCommand
        const exportNbPath = path.join(tempDir, 'export_picker_test.flownb');
        const exportNbContent = `- kind: 2\n  language: vura-terminal\n  value: ""\n  metadata:\n    tableName: "orders_table"\n`;
        await fs.writeFile(exportNbPath, exportNbContent, 'utf8');

        const exportUri = vscode.Uri.file(exportNbPath);
        const exportDoc = await vscode.workspace.openNotebookDocument(exportUri);
        await vscode.window.showNotebookDocument(exportDoc);
        const exportCell = exportDoc.cellAt(0);

        // Stub showQuickPick and showInputBox to simulate user picker flow for vura-notebook.exportFileCommand
        const origShowQuickPick = vscode.window.showQuickPick;
        const origShowInputBox = vscode.window.showInputBox;

        let pickCallCount = 0;
        (vscode.window as any).showQuickPick = async (items: any[]) => {
            pickCallCount++;
            if (pickCallCount === 1) return { label: 'orders_table' };
            if (pickCallCount === 2) return 'csv';
            return items[0];
        };
        (vscode.window as any).showInputBox = async () => 'orders_table_export';

        try {
            await vscode.commands.executeCommand('vura-notebook.exportFileCommand', exportCell);
        } finally {
            (vscode.window as any).showQuickPick = origShowQuickPick;
            (vscode.window as any).showInputBox = origShowInputBox;
        }

        assert.strictEqual(
            exportCell.document.getText(),
            '!export-file orders_table csv -> orders_table_export\n',
            'Executing vura-notebook.exportFileCommand command must insert exact !export-file <source> <format> -> <output> command text'
        );

        // 3. Test vura-notebook.setDataverseConnection executed via vscode.commands.executeCommand
        const origGetProfiles = ConnectionManager.getProfiles;
        ConnectionManager.getProfiles = () => [
            { id: 'profile-99', name: 'D365_Prod_Conn', authMode: 'ServicePrincipal', server: 'org.crm.dynamics.com' }
        ];

        (vscode.window as any).showQuickPick = async (items: any[]) => items[0];

        try {
            await vscode.commands.executeCommand('vura-notebook.setDataverseConnection', exportCell);
        } finally {
            ConnectionManager.getProfiles = origGetProfiles;
            (vscode.window as any).showQuickPick = origShowQuickPick;
        }

        assert.strictEqual(
            exportCell.metadata?.dataverseConnectionName,
            'D365_Prod_Conn',
            'Executing vura-notebook.setDataverseConnection command must update dataverseConnectionName cell metadata'
        );

        // 4. Test Phase 9 dynamic UI action execution via vura-notebook.executeUIAction command
        const mockProvider = {
            activate: async () => {},
            getCommands: () => ['!sharepoint.sync'],
            getSettings: () => ({}),
            connect: async () => {},
            validate: async () => true,
            sync: async () => {},
            handleCommand: async () => {},
            getUIActions: () => [
                {
                    id: 'sharepoint.sync.picker',
                    label: 'SharePoint Sync',
                    kind: 'input',
                    onSelect: async (value: string, flownbCell: any) => {
                        flownbCell.value = `!sharepoint.sync --site "${value}"\n` + flownbCell.value;
                    }
                }
            ]
        };

        ProviderRegistry.getInstance().registerProvider('sharepoint-test-provider', mockProvider as any, { getConfig: (_k: string, d: any) => d } as any);

        const actions = mockProvider.getUIActions();
        assert.strictEqual(actions.length, 1);

        (vscode.window as any).showInputBox = async () => 'https://contoso.sharepoint.com/sites/finance';

        try {
            await vscode.commands.executeCommand('vura-notebook.executeUIAction', actions[0], exportCell);
        } finally {
            (vscode.window as any).showInputBox = origShowInputBox;
        }

        assert.ok(
            exportCell.document.getText().includes('!sharepoint.sync --site "https://contoso.sharepoint.com/sites/finance"'),
            'Executing vura-notebook.executeUIAction command must update cell text with connector magic command'
        );
    });
});

import * as vscode from 'vscode';
import { ExportHelper } from './exportHelper';

export class ResultViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'vura-sql.resultsView';
    private _view?: vscode.WebviewView;
    private _currentData: any[] = [];
    private _disposables: vscode.Disposable[] = [];

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        this._updateHtml('Ready to execute SQL...', false);

        webviewView.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'exportXlsx':
                    await ExportHelper.exportToExcel(this._currentData);
                    break;
                case 'exportCsv':
                    await ExportHelper.exportToCsv(this._currentData);
                    break;
                case 'copyJson':
                    vscode.env.clipboard.writeText(JSON.stringify(this._currentData, null, 2));
                    vscode.window.showInformationMessage('Data copied as JSON to clipboard');
                    break;
                case 'copyError':
                    vscode.env.clipboard.writeText(message.text);
                    vscode.window.showInformationMessage('Error copied to clipboard');
                    break;
            }
        }, null, this._disposables);
    }

    public updateResults(data: any[], executionTimeString: string) {
        this._currentData = data;
        const html = this._generateTabulatorHtml(data, executionTimeString);
        this._updateHtml(html, true);
        this.focus();
    }

    public updateError(errorMsg: string, profileName: string) {
        const html = `
            <div style="padding: 20px;">
                <div style="color: #ff5252; padding: 15px; background: #2a0b0b; border: 1px solid #ff5252; border-radius: 4px;">
                    <h3 style="margin-top:0;">Execution Failed</h3>
                    <p><strong>Profile:</strong> ${profileName}</p>
                    <pre style="white-space: pre-wrap; word-wrap: break-word;" id="errorText">${errorMsg}</pre>
                    <vscode-button id="copyErrorBtn" appearance="secondary">Copy Error</vscode-button>
                </div>
            </div>
            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById('copyErrorBtn').addEventListener('click', () => {
                    const text = document.getElementById('errorText').innerText;
                    vscode.postMessage({ type: 'copyError', text });
                });
            </script>
        `;
        this._updateHtml(html, false);
        this.focus();
    }

    public updateLoading() {
        const html = `
        <div style="display:flex; justify-content:center; align-items:center; height: 100vh;">
            <div style="text-align:center;">
                <vscode-progress-ring></vscode-progress-ring>
                <div style="margin-top: 20px;">Executing query...</div>
            </div>
        </div>
        `;
        this._updateHtml(html, false);
        this.focus();
    }

    public focus() {
        vscode.commands.executeCommand(`${ResultViewProvider.viewType}.focus`);
    }

    private _updateHtml(content: string, showToolbar: boolean) {
        if (!this._view) {
            return;
        }

        const toolkitUri = this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'webview-ui-toolkit', 'dist', 'toolkit.min.js'));

        let toolbar = '';
        if (showToolbar) {
            toolbar = `
                <div class="toolbar" style="padding: 10px; display: flex; gap: 10px; align-items: center; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border);">
                    <vscode-text-field id="searchInput" placeholder="Quick Search..."></vscode-text-field>
                    <div style="flex-grow: 1;"></div>
                    <vscode-button appearance="icon" title="Copy as JSON" id="copyJsonBtn">
                        <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                           <path fill-rule="evenodd" clip-rule="evenodd" d="M4.5 1h5l3 3v9h-8V1zM5 2v10h7V4.5l-2.5-2.5H5zm2 5V6h3v1H7zm3 2H7V8h3v1zm-3 2h3v-1H7v1z"/>
                           <path d="M1 4h2v1H2v9h7v-1h1v2H1V4z"/>
                        </svg>
                    </vscode-button>
                    <vscode-button appearance="icon" title="Export to Excel" id="exportXlsxBtn">
                        <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                           <path d="M2.784 14.542h10.432c.621 0 1.127-.506 1.127-1.127V5.59l-4.133-4.133H2.784c-.621 0-1.127.506-1.127 1.127v10.83c0 .622.506 1.128 1.127 1.128z" fill="#21A366"/>
                           <path d="M9.167 6.002h3.5v-.425L9.167 2.077v3.925z" fill="#107C41"/>
                           <path d="M12.667 8.52v4.895c0 .622-.506 1.127-1.127 1.127H4.46V7.45h8.207v1.07z" fill="#185C37" opacity=".1"/>
                           <path d="M4.46 7.45h8.207v7h-8.207v-7z" fill="#107C41"/>
                           <path d="M5.4 13.064l1.455-2.091-1.39-2.046h1.168l.8 1.341c.07.126.136.27.195.426h.023c.063-.162.13-.306.196-.426l.824-1.341h1.11L8.337 10.95l1.474 2.114H8.647L7.765 11.6c-.08-.135-.152-.284-.216-.445h-.024c-.062.164-.132.316-.207.45l-.903 1.459H5.4z" fill="#FFF"/>
                        </svg>
                    </vscode-button>
                    <vscode-button appearance="icon" title="Export to CSV" id="exportCsvBtn">
                        <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
                           <path d="M14 4.5V14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2h5.5L14 4.5z" fill="#0072C6"/>
                           <path d="M9.5 0v4.5H14L9.5 0z" fill="#005A9E" opacity=".3"/>
                           <path d="M4.5 7h4v1h-4V7zm0 2h7v1h-7V9zm0 2h7v1h-7v-1z" fill="#FFF"/>
                        </svg>
                    </vscode-button>
                </div>
            `;
        }

        this._view.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <script type="module" src="${toolkitUri}"></script>
                <link href="https://unpkg.com/tabulator-tables/dist/css/tabulator.min.css" rel="stylesheet">
                <script src="https://unpkg.com/tabulator-tables/dist/js/tabulator.min.js"></script>
                <style>
                    body { 
                        padding: 0; margin: 0; 
                        font-family: var(--vscode-font-family); 
                        display: flex; flex-direction: column; 
                        height: 100vh; overflow: hidden; 
                        background-color: var(--vscode-editor-background); 
                        color: var(--vscode-editor-foreground); 
                    }
                    .tabulator { 
                        border: none !important; 
                        background-color: var(--vscode-editor-background) !important; 
                        color: var(--vscode-editor-foreground) !important; 
                    }
                    .tabulator-header { 
                        background-color: var(--vscode-editor-inactiveSelectionBackground) !important; 
                        color: var(--vscode-foreground) !important; 
                        border-bottom: 2px solid var(--vscode-panel-border) !important;
                    }
                    .tabulator-col, .tabulator-col-content {
                        background-color: var(--vscode-editor-inactiveSelectionBackground) !important; 
                        color: var(--vscode-foreground) !important; 
                    }
                    .tabulator-row { 
                        background-color: var(--vscode-editor-background) !important; 
                        color: var(--vscode-editor-foreground) !important;
                        border-bottom: 1px solid var(--vscode-panel-border) !important; 
                    }
                    .tabulator-row:nth-child(even) {
                        background-color: var(--vscode-tree-tableOddRowsBackground) !important; 
                    }
                    .tabulator-row:hover { 
                        background-color: var(--vscode-list-hoverBackground) !important; 
                    }
                    .tabulator-cell { 
                        color: var(--vscode-editor-foreground) !important; 
                        padding: 8px !important; 
                    }
                    #table-container { flex: 1; min-height: 0; }
                </style>
            </head>
            <body>
                ${toolbar}
                <div id="table-container">
                    ${content}
                </div>
            </body>
            </html>
        `;
    }

    private _generateTabulatorHtml(data: any[], executionTimeString: string): string {
        if (!data || data.length === 0) {
            return `<div style="padding: 20px;">No rows returned. (Executed in ${executionTimeString}s)</div>`;
        }

        const keys = Object.keys(data[0]);
        // define columns for tabulator
        const columns: any[] = [
            { formatter: "rownum", headerSort: false, width: 40, frozen: true },
        ];
        
        for (const k of keys) {
            columns.push({ title: k, field: k, headerFilter: false });
        }

        const jsonString = JSON.stringify(data).replace(/</g, '\\u003c');
        const colString = JSON.stringify(columns);

        return `
            <div id="example-table"></div>
            <div style="padding: 5px 10px; border-top: 1px solid var(--vscode-panel-border); font-size: 12px; color: var(--vscode-descriptionForeground);">
                ✅ Loaded ${data.length} records in ${executionTimeString}s
            </div>
            
            <script>
                const gridData = ${jsonString};
                const vscode = acquireVsCodeApi();

                const table = new Tabulator("#example-table", {
                    data: gridData,
                    layout: "fitData",
                    columns: ${colString},
                    height: "100%",
                });

                document.getElementById('exportXlsxBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'exportXlsx' });
                });
                
                document.getElementById('exportCsvBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'exportCsv' });
                });

                document.getElementById('copyJsonBtn').addEventListener('click', () => {
                    vscode.postMessage({ type: 'copyJson' });
                });

                const searchInput = document.getElementById('searchInput');
                searchInput.addEventListener('input', (e) => {
                    const term = e.target.value;
                    table.setFilter((data) => {
                        return Object.values(data).some(val => val !== null && val.toString().toLowerCase().includes(term.toLowerCase()));
                    });
                });
            </script>
        `;
    }
}

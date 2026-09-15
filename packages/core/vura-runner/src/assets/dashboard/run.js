document.addEventListener('DOMContentLoaded', () => {
    // Theme setup
    const currentTheme = localStorage.getItem('vura-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);

    const urlParams = new URLSearchParams(window.location.search);
    const runId = urlParams.get('id');

    document.getElementById('back-btn').addEventListener('click', () => {
        window.location.href = '/';
    });

    if (!runId) {
        document.getElementById('run-title').textContent = 'Error: No Run ID provided';
        return;
    }

    loadRunDetails(runId);

    async function loadRunDetails(id) {
        try {
            const res = await fetch(`/api/history/${id}`);
            if (!res.ok) throw new Error('Run not found');
            const data = await res.json();
            
            renderSummary(data.run);
            renderCells(data.cells);
        } catch (e) {
            console.error('Failed to load run details', e);
            document.getElementById('run-title').textContent = 'Error loading run details';
        }
    }

    function renderSummary(run) {
        document.getElementById('run-title').textContent = `Run Details: ${run.id}`;
        document.getElementById('summary-id').textContent = run.id;
        document.getElementById('summary-flow').textContent = run.flow;
        document.getElementById('summary-time').textContent = new Date(run.timestamp).toLocaleString();
        document.getElementById('summary-duration').textContent = run.duration !== null ? `${run.duration}ms` : 'Running...';
        
        const statusBadge = document.getElementById('run-status');
        statusBadge.textContent = run.status;
        statusBadge.className = `badge badge-${run.status}`;
    }

    function renderCells(cells) {
        const container = document.getElementById('cells-container');
        container.innerHTML = '';

        if (!cells || cells.length === 0) {
            container.innerHTML = '<div class="card glass-panel"><div class="card-body">No cells executed yet.</div></div>';
            return;
        }

        cells.forEach((cell, idx) => {
            const card = document.createElement('div');
            card.className = `cell-card glass-panel ${cell.status === 'error' ? 'has-error' : ''}`;
            
            const logsText = tryParseJSON(cell.logs, '[]');
            const outputsJson = tryParseJSON(cell.outputs, '[]');

            card.innerHTML = `
                <div class="cell-header">
                    <div class="cell-title">
                        <span class="cell-index">Cell ${cell.cell_index + 1}</span>
                        <span class="badge badge-${cell.status}">${cell.status}</span>
                    </div>
                    <div class="cell-duration">${cell.duration}ms</div>
                </div>
                <div class="cell-body">
                    ${cell.error ? `<div class="cell-error"><strong>Error:</strong> ${escapeHtml(cell.error)}</div>` : ''}
                    
                    ${logsText.length > 0 ? `
                    <details class="cell-details" open>
                        <summary>Execution Logs</summary>
                        <pre class="cell-logs">${escapeHtml(logsText.join('\n'))}</pre>
                    </details>` : ''}
                    
                    ${outputsJson.length > 0 ? `
                    <details class="cell-details" open>
                        <summary>Cell Outputs</summary>
                        <div class="cell-outputs">
                            ${outputsJson.map(o => formatOutput(o)).join('')}
                        </div>
                    </details>` : ''}
                </div>
            `;
            container.appendChild(card);
        });
    }

    function tryParseJSON(str, def) {
        try {
            return JSON.parse(str);
        } catch {
            return JSON.parse(def);
        }
    }

    function formatOutput(output) {
        if (output.type === 'html') {
            return `<div class="output-html">${output.data}</div>`;
        } else if (output.type === 'json') {
            return `<pre class="output-json"><code class="json">${JSON.stringify(output.data, null, 2)}</code></pre>`;
        }
        return '';
    }

    function escapeHtml(unsafe) {
        return (unsafe || '').toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // --- Theme Toggling ---
    const themeBtn = document.getElementById('theme-btn');
    const iconSun = document.querySelector('.icon-sun');
    const iconMoon = document.querySelector('.icon-moon');
    
    // Check saved theme
    let currentTheme = localStorage.getItem('vura-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', currentTheme);
    updateThemeIcon();

    themeBtn.addEventListener('click', () => {
        currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', currentTheme);
        localStorage.setItem('vura-theme', currentTheme);
        updateThemeIcon();
    });

    function updateThemeIcon() {
        if (currentTheme === 'dark') {
            iconSun.style.display = 'block';
            iconMoon.style.display = 'none';
        } else {
            iconSun.style.display = 'none';
            iconMoon.style.display = 'block';
        }
    }

    // --- Tab Switching ---
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            btn.classList.add('active');
            const targetId = btn.dataset.target;
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'history-view' && activeFlow) {
                loadHistory(activeFlow);
            }
        });
    });

    // --- Data Fetching & State ---
    let activeFlow = null;
    let eventSource = null;
    const triggerBtn = document.getElementById('trigger-btn');

    if (triggerBtn) {
        triggerBtn.addEventListener('click', async () => {
            if (!activeFlow) return;
            triggerBtn.disabled = true;
            const originalText = triggerBtn.textContent;
            triggerBtn.textContent = 'Running...';
            
            try {
                // Switch to live view tab automatically
                const liveTabBtn = document.querySelector('.tab-btn[data-target="live-view"]');
                if (liveTabBtn) liveTabBtn.click();

                const triggerUrl = `/flow/trigger/${activeFlow.replace(/^\//, '')}`;
                const res = await fetch(triggerUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({})
                });
                const responseText = await res.text();
                appendLog('Trigger Result', `HTTP ${res.status}: ${responseText.substring(0, 300)}`);
            } catch (err) {
                appendLog('Trigger Error', err.message);
            } finally {
                triggerBtn.disabled = false;
                triggerBtn.textContent = originalText;
            }
        });
    }

    async function loadFlows() {
        try {
            const res = await fetch('/api/flows');
            const flows = await res.json();
            const list = document.getElementById('flows-list');
            list.innerHTML = '';
            
            if (!Array.isArray(flows) || flows.length === 0) {
                list.innerHTML = '<li class="no-flows">No flows found.</li>';
                return;
            }

            flows.forEach(flow => {
                const li = document.createElement('li');
                li.textContent = flow.name;
                li.addEventListener('click', () => selectFlow(flow, li));
                list.appendChild(li);
            });

            // Select first flow by default
            if (flows.length > 0) {
                selectFlow(flows[0], list.firstChild);
            }
        } catch (e) {
            console.error('Failed to load flows', e);
        }
    }

    async function loadHistory(flowName) {
        try {
            const url = flowName ? `/api/history?flow=${encodeURIComponent(flowName)}` : '/api/history';
            const res = await fetch(url);
            const history = await res.json();
            const tbody = document.getElementById('history-body');
            tbody.innerHTML = '';

            if (!Array.isArray(history) || history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4">No history found.</td></tr>';
                return;
            }

            history.forEach(run => {
                const tr = document.createElement('tr');
                const statusClass = run.status === 'success' ? 'status-success' : 
                                    (run.status === 'error' ? 'status-error' : 'status-running');
                
                tr.style.cursor = 'pointer';
                tr.addEventListener('click', () => {
                    window.location.href = `/run.html?id=${encodeURIComponent(run.id)}`;
                });

                tr.innerHTML = `
                    <td>${escapeHtml(run.id)}</td>
                    <td class="${statusClass}">${escapeHtml(run.status)}</td>
                    <td>${run.timestamp ? new Date(run.timestamp).toLocaleString() : '-'}</td>
                    <td>${run.duration !== null && run.duration !== undefined ? run.duration + 'ms' : '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        } catch (e) {
            console.error('Failed to load history', e);
        }
    }

    function selectFlow(flow, listItem) {
        document.querySelectorAll('.flows-list li').forEach(li => li.classList.remove('active'));
        if (listItem) listItem.classList.add('active');
        
        activeFlow = flow.name;
        document.getElementById('flow-title').textContent = flow.name;

        if (triggerBtn) triggerBtn.disabled = false;
        
        const inputSchemaElem = document.getElementById('input-schema');
        const outputSchemaElem = document.getElementById('output-schema');
        
        if (inputSchemaElem) {
            inputSchemaElem.innerHTML = `<code class="json">${escapeHtml(JSON.stringify(flow.inputSchema || {}, null, 2))}</code>`;
        }
        if (outputSchemaElem) {
            outputSchemaElem.innerHTML = `<code class="json">${escapeHtml(JSON.stringify(flow.outputSchema || {}, null, 2))}</code>`;
        }
        
        // Reset live view
        document.getElementById('live-status').textContent = 'Waiting for execution...';
        const progressBar = document.getElementById('progress-bar');
        progressBar.style.width = '0%';
        progressBar.style.background = 'var(--accent-color)';
        document.getElementById('logs-container').innerHTML = '';

        loadHistory(activeFlow);
    }

    function isFlowMatch(f1, f2) {
        if (!f1 || !f2) return false;
        const b1 = f1.split('/').pop();
        const b2 = f2.split('/').pop();
        return f1 === f2 || f1.endsWith('/' + f2) || f2.endsWith('/' + f1) || b1 === b2;
    }

    function setupSSE() {
        if (eventSource) {
            eventSource.close();
        }

        eventSource = new EventSource('/api/events');

        eventSource.addEventListener('run_started', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                document.getElementById('live-status').textContent = `Execution Started [ID: ${data.id}]`;
                const progressBar = document.getElementById('progress-bar');
                progressBar.style.width = '5%';
                progressBar.style.background = 'var(--accent-color)';
                document.getElementById('logs-container').innerHTML = '';
                appendLog('System', 'Execution initialized...');
                loadHistory(activeFlow);
            }
        });

        eventSource.addEventListener('cell_started', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                document.getElementById('live-status').textContent = `Running Cell ${data.cellIndex + 1} / ${data.totalCells}`;
                const percentage = Math.max(5, (data.cellIndex / data.totalCells) * 100);
                document.getElementById('progress-bar').style.width = `${percentage}%`;
            }
        });

        eventSource.addEventListener('cell_completed', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                appendLog(`Cell ${data.cellIndex + 1}`, `Completed in ${data.durationMs}ms [status: ${data.status}]`);
            }
        });

        eventSource.addEventListener('log_added', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                appendLog(`Cell ${data.cellIndex + 1}`, data.message);
            }
        });

        eventSource.addEventListener('run_completed', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                document.getElementById('live-status').textContent = `Execution Completed in ${data.duration}ms`;
                document.getElementById('progress-bar').style.width = '100%';
                appendLog('System', `Finished successfully in ${data.duration}ms`);
                loadHistory(activeFlow);
            }
        });

        eventSource.addEventListener('run_failed', (e) => {
            const data = JSON.parse(e.data);
            if (isFlowMatch(data.flow, activeFlow)) {
                document.getElementById('live-status').textContent = `Execution Failed: ${data.error}`;
                document.getElementById('progress-bar').style.background = 'var(--error-color)';
                appendLog('Error', data.error);
                loadHistory(activeFlow);
            }
        });
    }

    function appendLog(source, message) {
        const container = document.getElementById('logs-container');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'log-entry';
        
        const time = new Date().toLocaleTimeString();
        div.innerHTML = `<span class="log-time">[${time}]</span> <strong>${escapeHtml(source)}:</strong> ${escapeHtml(message)}`;
        
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    function escapeHtml(unsafe) {
        return (unsafe || '').toString()
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Initialize
    loadFlows();
    setupSSE();
});

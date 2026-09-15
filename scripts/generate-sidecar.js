const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const rootDir = path.resolve(__dirname, '..');
const ioSrcDir = path.join(rootDir, 'packages', 'vura-io', 'src');
const runnerAssetsDir = path.join(rootDir, 'packages', 'vura-runner', 'src', 'assets');

function transpileFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf-utf-8' in Buffer ? 'utf-8' : 'utf8');
    return ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
}

const shredderJs = transpileFile(path.join(ioSrcDir, 'shredder.ts'));
const dataJs = transpileFile(path.join(ioSrcDir, 'data.ts'));
const metricsJs = transpileFile(path.join(ioSrcDir, 'metrics.ts'));
const stateJs = transpileFile(path.join(ioSrcDir, 'state.ts'));

let combined = shredderJs + '\n' + dataJs + '\n' + metricsJs + '\n' + stateJs;

combined = combined.split('\n').filter(line => {
    if (line.includes('use strict')) return false;
    if (line.includes('defineProperty')) return false;
    if (line.trim().startsWith('exports.')) return false;
    if (line.includes('require("fs")') || line.includes("require('fs')")) return false;
    if (line.includes('require("path")') || line.includes("require('path')")) return false;
    if (line.includes('require("apache-arrow")') || line.includes("require('apache-arrow')")) return false;
    if (line.includes('require("@duckdb/node-api")') || line.includes("require('@duckdb/node-api')")) return false;
    if (line.includes('require("./shredder")') || line.includes("require('./shredder')")) return false;
    return true;
}).join('\n');

combined = combined.replace(/node_api_1\./g, '');
combined = combined.replace(/shredder_1\./g, '');

const header = `const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');
const { DuckDBInstance } = require('@duckdb/node-api');
const arrow = require('apache-arrow');
`;

const runnerCode = `
function transformImports(code) {
    if (typeof code !== 'string') return code;
    return code
        .replace(/^(\\s*)import\\s+(\\*\\s+as\\s+\\w+)\\s+from\\s+(['"][^'"]+['"])\\s*;?/gm, '$1const $2 = require($3);')
        .replace(/^(\\s*)import\\s+([\\w$]+)\\s*,\\s*(\\{[\\s\\S]*?\\})\\s+from\\s+(['"][^'"]+['"])\\s*;?/gm, (match, indent, defaultImport, namedImports, mod) => {
            const destructured = namedImports.slice(1, -1).split(',').map((s) => {
                const parts = s.trim().split(/\\s+as\\s+/);
                return parts.length === 2 ? \`\${parts[0]}: \${parts[1]}\` : parts[0];
            }).filter(Boolean).join(', ');
            return \`\${indent}const _default_\${defaultImport} = require(\${mod}); const \${defaultImport} = _default_\${defaultImport}.default || _default_\${defaultImport}; const { \${destructured} } = require(\${mod});\`;
        })
        .replace(/^(\\s*)import\\s+(\\{[\\s\\S]*?\\})\\s+from\\s+(['"][^'"]+['"])\\s*;?/gm, (match, indent, clause, mod) => {
            const destructured = clause.slice(1, -1).split(',').map((s) => {
                const parts = s.trim().split(/\\s+as\\s+/);
                return parts.length === 2 ? \`\${parts[0]}: \${parts[1]}\` : parts[0];
            }).filter(Boolean).join(', ');
            return \`\${indent}const { \${destructured} } = require(\${mod});\`;
        })
        .replace(/^(\\s*)import\\s+([\\w$]+)\\s+from\\s+(['"][^'"]+['"])\\s*;?/gm, (match, indent, defaultImport, mod) => {
            return \`\${indent}const _default_\${defaultImport} = require(\${mod}); const \${defaultImport} = _default_\${defaultImport}.default || _default_\${defaultImport};\`;
        })
        .replace(/^(\\s*)import\\s+(['"][^'"]+['"])\\s*;?/gm, '$1require($2);');
}

function serveForever(data, state, metrics) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    let isExecuting = false;
    const realStdoutWrite = process.stdout.write.bind(process.stdout);

    // Cell code often follows the documented fire-and-forget pattern
    // (\`async function run() { ... } run();\` with no top-level await —
    // see docs/DEVELOPMENT_PLAYBOOK.md), so the outer \`(async () => {...})()\`
    // wrapper below can resolve before run()'s own work — e.g. a
    // data.put(...) — has finished. Wrapping data's async methods lets each
    // request track any such in-flight calls and drain them before
    // responding, so their writes (and vura_io_mapping emissions) land
    // before the sidecar replies.
    let pendingOps = [];
    for (const name of ['put', 'get', 'append', 'count', 'flush', 'flushAll', 'stream', 'pack', 'unpack', 'tables']) {
        if (typeof data[name] !== 'function') continue;
        const orig = data[name].bind(data);
        data[name] = (...args) => {
            const result = orig(...args);
            pendingOps.push(Promise.resolve(result).catch(() => {}));
            return result;
        };
    }

    return new Promise((resolve) => {
        rl.on('line', async (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            let request;
            try { request = JSON.parse(trimmed); } catch { return; }

            const { id, code, filename, ctx: reqCtx } = request;

            if (isExecuting) {
                const errResp = {
                    id,
                    status: 'error',
                    stdout: '',
                    stderr: '',
                    error: 'Sidecar process is busy with another request'
                };
                realStdoutWrite(JSON.stringify(errResp) + '\\n');
                return;
            }

            isExecuting = true;
            pendingOps = [];
            try {
                const ctx = reqCtx || {};
                if (typeof state.setRequestCtx === 'function') {
                    state.setRequestCtx(ctx);
                }
                if (ctx.storagePath) {
                    data.storagePath = ctx.storagePath;
                    process.env.VURA_STORAGE_PATH = ctx.storagePath;
                }

                let stdoutBuf = '';
                let stderrBuf = '';
                const origStdoutWrite = process.stdout.write.bind(process.stdout);
                const origStderrWrite = process.stderr.write.bind(process.stderr);

                process.stdout.write = (chunk) => { stdoutBuf += chunk.toString(); return true; };
                process.stderr.write = (chunk) => {
                    const str = chunk.toString();
                    if (str.includes('[VURA_TEST_HOOK]')) {
                        origStderrWrite(chunk);
                    }
                    stderrBuf += str;
                    return true;
                };

                let status = 'ok';
                let errorMessage;
                const cellFilename = filename || path.join(process.cwd(), 'cell.js');

                try {
                    let processedCode = transformImports(code);
                    const wrapped = \`(async () => {\\n\${processedCode}\\n})()\`;
                    const script = new vm.Script(wrapped, { filename: cellFilename });
                    const vuraObj = {
                        io: { data, state, metrics },
                        data, state, metrics,
                        put: data.put.bind(data),
                        get: data.get.bind(data),
                        save_table: data.put.bind(data),
                        saveTable: data.put.bind(data),
                        get_table: data.get.bind(data),
                        getTable: data.get.bind(data),
                        append: data.append.bind(data),
                        count: data.count.bind(data),
                        flush: data.flush.bind(data),
                        stream: data.stream.bind(data)
                    };
                    const sandbox = {
                        require, module, exports,
                        __dirname: path.dirname(cellFilename),
                        __filename: cellFilename,
                        console, process, Buffer,
                        setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
                        URL, URLSearchParams, TextEncoder, TextDecoder,
                        data, state, metrics,
                        ctx,
                        vura: vuraObj
                    };
                    const context = vm.createContext(sandbox);
                    const executionPromise = script.runInContext(context);
                    await executionPromise;
                    // Drain in-flight ops from any un-awaited async work the
                    // cell fired off (see the pendingOps wrapping above) —
                    // draining can itself queue more (e.g. a .then() chain),
                    // so keep going until a pass adds nothing new.
                    let pendingOpsCount = -1;
                    while (pendingOps.length !== pendingOpsCount) {
                        pendingOpsCount = pendingOps.length;
                        await Promise.all(pendingOps);
                    }
                    await data.flushAll();
                } catch (e) {
                    status = 'error';
                    errorMessage = (e && e.stack) ? e.stack : String(e);
                } finally {
                    process.stdout.write = origStdoutWrite;
                    process.stderr.write = origStderrWrite;
                }

                const response = { id, status, stdout: stdoutBuf, stderr: stderrBuf };
                if (errorMessage) response.error = errorMessage;
                realStdoutWrite(JSON.stringify(response) + '\\n');
            } finally {
                isExecuting = false;
            }
        });

        rl.on('close', resolve);
    });
}

async function main() {
    const storagePath = process.env.VURA_STORAGE_PATH;
    if (!storagePath) {
        console.error("VURA_STORAGE_PATH not set");
        process.exit(1);
    }

    const data = new DataManager(storagePath);
    const state = new StateManager();
    const metrics = new MetricsManager();

    const ioModule = {
        data,
        state,
        metrics,
        put: data.put.bind(data),
        get: data.get.bind(data),
        pack: data.pack.bind(data),
        unpack: data.unpack.bind(data),
        tables: data.tables.bind(data),
        saveTable: data.put.bind(data),
        save_table: data.put.bind(data),
        getTable: data.get.bind(data),
        get_table: data.get.bind(data),
        count: data.count.bind(data),
        saveNested: data.pack.bind(data),
        save_nested: data.pack.bind(data),
        loadReconstructed: data.unpack.bind(data),
        load_reconstructed: data.unpack.bind(data),
        flush: data.flush.bind(data),
        flushAll: data.flushAll.bind(data),
        append: data.append.bind(data),
        stream: data.stream.bind(data),
    };
    ioModule.io = ioModule;
    ioModule.default = ioModule;
    global.data = data;
    global.state = state;
    global.metrics = metrics;
    global.vura = { io: ioModule, data, state, metrics, ...ioModule };

    const Module = require('module');
    const _origResolve = Module._resolveFilename.bind(Module);
    Module._resolveFilename = function(request, parent, isMain, options) {
        if (
            request === '@vura/io' ||
            request === 'vura-io' ||
            request === 'vura_io' ||
            request === 'vura_bridge' ||
            request === 'vura' ||
            request === 'vura/io'
        ) {
            return request;
        }
        return _origResolve(request, parent, isMain, options);
    };

    const registerCache = (modName) => {
        require.cache[modName] = {
            id: modName,
            filename: modName,
            loaded: true,
            exports: ioModule,
            parent: null,
            children: [],
            paths: []
        };
    };

    registerCache('@vura/io');
    registerCache('vura-io');
    registerCache('vura_io');
    registerCache('vura_bridge');
    registerCache('vura');
    registerCache('vura/io');

    await serveForever(data, state, metrics);
}

main();
`;

const updatedSidecar = header + combined + '\n' + runnerCode;
fs.writeFileSync(path.join(runnerAssetsDir, 'sidecar.js'), updatedSidecar);
console.log('Generated clean packages/vura-runner/src/assets/sidecar.js');

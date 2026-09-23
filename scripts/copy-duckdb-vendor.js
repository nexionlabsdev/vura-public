const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Target platform and architecture (defaults to current process platform/arch, overridable via env vars)
const targetPlatform = process.env.TARGET_PLATFORM || process.platform;
const targetArch = process.env.TARGET_ARCH || process.arch;
const platformArch = `${targetPlatform}-${targetArch}`;

// Candidates for platform/architecture-specific vendor duckdb.node binary
const vendorCandidates = [
    path.join(rootDir, 'vendor-packages', 'duckdb', platformArch, 'duckdb.node'),
    path.join(rootDir, 'vendor-packages', platformArch, 'duckdb.node'),
    path.join(rootDir, 'packages', 'core', 'core-extension', 'vendor', 'duckdb-bindings', platformArch, 'duckdb.node'),
    path.join(rootDir, 'vendor', 'packages', 'duckdb', platformArch, 'duckdb.node'),
    path.join(rootDir, 'vendor', 'packages', platformArch, 'duckdb.node'),
];

let vendorBinaryPath = null;
for (const cand of vendorCandidates) {
    if (fs.existsSync(cand)) {
        vendorBinaryPath = cand;
        break;
    }
}

if (!vendorBinaryPath) {
    console.log(`[vendor-sync] No custom vendor duckdb.node found for target ${platformArch}. Using default node_modules binary.`);
    return;
}

console.log(`[vendor-sync] Found custom vendor duckdb.node for target ${platformArch}: ${path.relative(rootDir, vendorBinaryPath)}`);

// Find all duckdb and @duckdb/node-bindings packages in root and any package
// under packages/ (packages/<group>/<name>/, at any nesting depth — not
// assumed to be exactly one level, so this survives future reorganizations).
const targetDuckDbDirs = [
    path.join(rootDir, 'node_modules', '@duckdb', 'node-bindings'),
    path.join(rootDir, 'node_modules', 'duckdb'),
];

function findPackageDirs(dir, depth) {
    if (depth <= 0 || !fs.existsSync(dir)) return [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, 'package.json'))) {
            result.push(full);
        }
        result.push(...findPackageDirs(full, depth - 1));
    }
    return result;
}

const packagesDir = path.join(rootDir, 'packages');
for (const pkgDir of findPackageDirs(packagesDir, 3)) {
    const candidateNapi = path.join(pkgDir, 'node_modules', '@duckdb', 'node-bindings');
    if (!targetDuckDbDirs.includes(candidateNapi)) {
        targetDuckDbDirs.push(candidateNapi);
    }
    const candidateLegacy = path.join(pkgDir, 'node_modules', 'duckdb');
    if (!targetDuckDbDirs.includes(candidateLegacy)) {
        targetDuckDbDirs.push(candidateLegacy);
    }
}

let copiedCount = 0;
for (const duckDbDir of targetDuckDbDirs) {
    if (!fs.existsSync(duckDbDir)) {
        continue;
    }

    const bindingDir = path.join(duckDbDir, 'lib', 'binding');
    const targetFile = path.join(bindingDir, 'duckdb.node');

    try {
        fs.mkdirSync(bindingDir, { recursive: true });

        // Copy vendor binary
        fs.copyFileSync(vendorBinaryPath, targetFile);
        console.log(`[vendor-sync] Copied duckdb.node -> ${path.relative(rootDir, targetFile)}`);
        copiedCount++;
    } catch (err) {
        console.warn(`[vendor-sync] Failed to copy to ${targetFile}: ${err.message}`);
    }
}

console.log(`[vendor-sync] Finished syncing duckdb.node to ${copiedCount} location(s).`);

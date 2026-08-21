const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Vendor duckdb.node is only built for Windows ARM64 (win32-arm64).
// For all other architectures/platforms, use the default duckdb.node binary installed via npm in node_modules.
const isWinArm64 = process.platform === 'win32' && process.arch === 'arm64';
if (!isWinArm64) {
    console.log(`[vendor-sync] Current platform (${process.platform}-${process.arch}) is not win32-arm64. Skipping vendor duckdb.node copy to use default node_modules binary.`);
    return;
}

// Candidates for vendor duckdb.node binary
const vendorCandidates = [
    path.join(rootDir, 'vendor-packages', 'duckdb', 'win32-arm64', 'duckdb.node'),
    path.join(rootDir, 'vendor-packages', 'duckdb', 'duckdb.node'),
    path.join(rootDir, 'vendor-packages', 'win32-arm64', 'duckdb.node'),
    path.join(rootDir, 'vendor-packages', 'duckdb.node'),
    path.join(rootDir, 'vendor', 'packages', 'duckdb', 'win32-arm64', 'duckdb.node'),
    path.join(rootDir, 'vendor', 'packages', 'duckdb.node'),
];

let vendorBinaryPath = null;
for (const cand of vendorCandidates) {
    if (fs.existsSync(cand)) {
        vendorBinaryPath = cand;
        break;
    }
}

if (!vendorBinaryPath) {
    console.log('[vendor-sync] No vendor duckdb.node found in vendor-packages/. Skipping.');
    return;
}

// Find all duckdb packages in root and packages/*
const targetDuckDbDirs = [
    path.join(rootDir, 'node_modules', 'duckdb'),
    path.join(rootDir, 'packages', 'core-extension', 'node_modules', 'duckdb'),
    path.join(rootDir, 'packages', 'vura-runner', 'node_modules', 'duckdb'),
    path.join(rootDir, 'packages', 'core-sdk', 'node_modules', 'duckdb'),
    path.join(rootDir, 'packages', 'vura-dataverse-sync-core', 'node_modules', 'duckdb'),
];

// Also dynamically check any node_modules/duckdb in any package folder
const packagesDir = path.join(rootDir, 'packages');
if (fs.existsSync(packagesDir)) {
    const pkgs = fs.readdirSync(packagesDir);
    for (const pkg of pkgs) {
        const candidate = path.join(packagesDir, pkg, 'node_modules', 'duckdb');
        if (!targetDuckDbDirs.includes(candidate)) {
            targetDuckDbDirs.push(candidate);
        }
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

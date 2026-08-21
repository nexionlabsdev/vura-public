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
    path.join(rootDir, 'packages', 'core-extension', 'vendor', 'duckdb-bindings', platformArch, 'duckdb.node'),
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

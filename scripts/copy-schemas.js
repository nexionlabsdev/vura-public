const fs = require('fs');
const path = require('path');

// The cross-language JSON schema contract (schemas/*.json) lives at the repo
// root so vura-io (TS) and vura-io-py (Python) share one source of truth in
// monorepo dev. Neither package's own directory is the repo root once it's
// installed as a real dependency (npm/pip install, or bundled into a
// .vsix), so each language's runtime lookup can't find the root copy there —
// this copies the contract into each package's own tree so it ships as part
// of the package itself. Run before `tsc` (vura-io) so the copy exists
// whenever dist/schemas.js does, and before packaging/testing vura-io-py.
const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.join(rootDir, 'schemas');

if (!fs.existsSync(sourceDir)) {
    console.error(`[schema-sync] Source schemas directory not found: ${sourceDir}`);
    process.exit(1);
}

const files = fs.readdirSync(sourceDir).filter((f) => f.endsWith('.json'));

const targetDirs = [
    path.join(rootDir, 'packages', 'vura-io', 'schemas'),
    path.join(rootDir, 'packages', 'vura-io-py', 'vura', 'io', 'schemas'),
];

for (const targetDir of targetDirs) {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const file of files) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
    }
    console.log(`[schema-sync] Copied ${files.length} schema file(s) to ${path.relative(rootDir, targetDir)}`);
}

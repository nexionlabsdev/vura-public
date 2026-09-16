// Copies build-time assets into out/ after tsc compiles. A plain Node script
// instead of `mkdir -p && cp -r` — those flags don't exist on Windows'
// cmd.exe (the default shell npm scripts run under there), which is what CI
// actually caught.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
fs.cpSync(path.join(pkgRoot, 'src', 'assets'), path.join(pkgRoot, 'out', 'assets'), { recursive: true });

// Sync vendor binaries (e.g. duckdb.node on windows ARM64)
try {
    require(path.join(pkgRoot, '..', '..', 'scripts', 'copy-duckdb-vendor.js'));
} catch (e) { }


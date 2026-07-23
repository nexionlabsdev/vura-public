// Copies build-time assets into out/ after tsc compiles. A plain Node script
// instead of `mkdir -p && cp ...` — those flags don't exist on Windows'
// cmd.exe (the default shell npm scripts run under there), which is what CI
// actually caught.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');
fs.mkdirSync(path.join(pkgRoot, 'out', 'proto'), { recursive: true });
fs.copyFileSync(
    path.join(pkgRoot, 'src', 'proto', 'execution.proto'),
    path.join(pkgRoot, 'out', 'proto', 'execution.proto')
);

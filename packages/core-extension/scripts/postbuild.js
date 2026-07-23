// Copies build-time assets into out/ after tsc compiles. A plain Node script
// instead of `mkdir -p && cp ...` — those flags don't exist on Windows'
// cmd.exe (the default shell npm scripts run under there), which is what CI
// actually caught.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.join(__dirname, '..');

function copyFilesWithExt(srcDir, destDir, ext) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
        if (entry.endsWith(ext)) {
            fs.copyFileSync(path.join(srcDir, entry), path.join(destDir, entry));
        }
    }
}

copyFilesWithExt(path.join(pkgRoot, 'src', 'proto'), path.join(pkgRoot, 'out', 'proto'), '.proto');
copyFilesWithExt(path.join(pkgRoot, 'src', 'assets'), path.join(pkgRoot, 'out', 'assets'), '.js');

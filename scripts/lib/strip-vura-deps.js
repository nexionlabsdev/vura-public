#!/usr/bin/env node
// Removes @vura-data-os/* entries from a package.json's dependencies, in place.
// Usage: node strip-vura-deps.js <path-to-package.json>
//
// A standalone script (not an inline `node -e` string) so the package.json
// path is its own CLI argument: Git Bash's automatic path conversion (POSIX
// -> Windows) only reliably rewrites whole path arguments, not path-like
// substrings embedded inside a larger `-e` script string.
const fs = require('fs');

const pkgPath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.dependencies) {
  for (const dep of Object.keys(pkg.dependencies)) {
    if (dep.startsWith('@vura-data-os/')) delete pkg.dependencies[dep];
  }
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

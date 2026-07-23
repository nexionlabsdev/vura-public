#!/usr/bin/env node
// Prints "yes" or "no" — whether <package.json>'s dependencies include <dep-name>.
// Usage: node has-dep.js <path-to-package.json> <dep-name>
//
// A standalone script (not an inline `node -e` string) so the package.json
// path is its own CLI argument: Git Bash's automatic path conversion (POSIX
// -> Windows) only reliably rewrites whole path arguments, not path-like
// substrings embedded inside a larger `-e` script string.
const fs = require('fs');

const pkgPath = process.argv[2];
const depName = process.argv[3];
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
process.stdout.write(pkg.dependencies && pkg.dependencies[depName] ? 'yes' : 'no');

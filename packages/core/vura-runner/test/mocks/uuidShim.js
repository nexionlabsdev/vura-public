// uuid@13 ships ESM-only in the "node" export condition (no .cjs build), which
// Jest's CommonJS module loader can't execute directly. The only export any
// package in this repo actually uses is v4, so under test we swap the whole
// package for this shim instead of fighting Jest into transforming
// node_modules/uuid's ESM syntax.
const crypto = require('crypto');

module.exports = {
    v4: () => crypto.randomUUID(),
};

const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
  },
  // uuid@13 ships ESM-only in dist-node (no .cjs build) — Jest's CommonJS loader
  // can't require() it directly. Only v4 is ever used anywhere in this repo, so
  // swap the whole package for a tiny shim under test rather than adding a
  // transform for arbitrary node_modules JS.
  moduleNameMapper: {
    '^uuid$': '<rootDir>/test/mocks/uuidShim.js',
  },
};
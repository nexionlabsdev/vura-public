const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  transform: {
    ...tsJestTransformCfg,
  },
  moduleNameMapper: {
    '^uuid$': '<rootDir>/../vura-runner/test/mocks/uuidShim.js',
  },
  // `npm run compile` emits compiled *.test.js alongside src/**/*.test.ts under out/ —
  // without this, jest picks up both copies as separate suites, and the compiled one
  // goes stale (silently re-running whatever the tests looked like as of the last build).
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/out/'],
};

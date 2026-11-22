/**
 * The evaluation harness's own specs. They reuse the API suite's config (the
 * ts-jest preset, the heap environment and the shared-source mapper) with the
 * roots set to eval/ only, so `npm test` in apps/api never runs them and this
 * config runs nothing else. `npm run test:eval -w @learnsdlc/api` starts it.
 */
const base = require('../jest.config.js');
module.exports = {
  ...base,
  rootDir: __dirname + '/..',
  roots: ['<rootDir>/eval'],
};

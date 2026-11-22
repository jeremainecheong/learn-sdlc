// Starts Jest through Node's module resolution rather than by a path into the
// repository's hoisted node_modules, so `npm test` still finds Jest when npm
// installs it under apps/api/node_modules instead. Jest reads its arguments
// from process.argv, which this file leaves as it is.
require('jest/bin/jest');

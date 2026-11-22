import * as path from 'path';
import { defineConfig } from 'vitest/config';

/**
 * The web app's unit runner: the tests under `test/`, run in Node with no
 * server and no browser.
 *
 * Two things the app relies on that Node does not resolve on its own:
 *
 * - `@/…`, the app's own path alias, which Next reads from tsconfig.json;
 * - `@learnsdlc/shared`, whose package entry is the built `dist`. The API's
 *   jest maps it to `src` for the same reason: a unit run should never be one
 *   stale build away from a false red, and there is no second copy of the
 *   types to drift from.
 *
 * The alias list is an array rather than an object because a `'@'` key would
 * also swallow `@learnsdlc/shared`; each entry is anchored instead.
 *
 * The default environment is node. A file that renders components asks for a
 * DOM with `@vitest-environment jsdom` on its first line, so the files that
 * need none keep a node-speed start. `test/setup.ts` runs before every file.
 */
export default defineConfig({
  oxc: {
    // The suites render .tsx components. The automatic runtime compiles their
    // JSX without a React import in every file.
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: [
      {
        find: /^@learnsdlc\/shared$/,
        replacement: path.resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
      { find: /^@\//, replacement: `${path.resolve(__dirname)}/` },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['test/setup.ts'],
    // A unit suite that needs longer than this has stopped being one.
    testTimeout: 10_000,
    clearMocks: true,
    restoreMocks: true,
  },
});

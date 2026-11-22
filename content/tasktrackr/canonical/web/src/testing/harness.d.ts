/**
 * What the test harness puts in scope, so your editor knows about it too.
 *
 * `test`, `it`, `describe` and `assert` are globals in both places a
 * front-end suite runs: inside the LearnSDLC sandbox, and under
 * `npm run test:web` on your own machine. That is why no suite in this
 * repository imports a test framework — there isn't one to import.
 *
 * `assert` is Node's own assert module, so `assert.strictEqual`,
 * `assert.deepStrictEqual`, `assert.match` and `assert.ok` all work.
 */

declare global {
  /** Register a case. The function may be async; the harness awaits it. */
  function test(name: string, fn: () => void | Promise<void>): void;
  /** The same function as `test`, for suites that read better as "it". */
  function it(name: string, fn: () => void | Promise<void>): void;
  /** Grouping only: the body runs immediately and registers its cases. */
  function describe(name: string, fn: () => void): void;
  const assert: typeof import('node:assert');
}

export {};

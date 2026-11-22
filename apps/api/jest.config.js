/**
 * The heap. The whole suite runs in band (one process, the files one after
 * another) on V8's default heap. Left alone, every file that boots the app
 * leaves 25-60 MB behind, and the run aborts with "JavaScript heap out of
 * memory" and no report. Heap snapshots name two retainers, neither of them
 * Jest's registry nor anything a test left open:
 * prom-client's GC `PerformanceObserver`, started once per file by
 * `src/observability/metrics.ts` on the shared `perf_hooks` and never stopped,
 * and V8's compilation cache holding each file's compiled ESM modules (Nest 12
 * is ESM) with the dynamic-import callbacks that close over that file.
 * `test/environment.js` disconnects the first at each file's teardown and turns
 * the second off; with both, the heap after a full GC stays flat from file to
 * file. It is the `testEnvironment` below, so it holds however the suite is
 * started. (A third, a spec re-requiring the whole module graph for every
 * test, is avoided inside preview.service.spec itself.)
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  // Jest's `node` environment plus the two heap fixes described above.
  testEnvironment: '<rootDir>/test/environment.js',
  // The shared package has no runner of its own, and `packages/shared/src`
  // holds specs: `projects.spec.ts` is the contract the pack compiler, the
  // importer, the entities and the class export all read. Without this entry
  // the file would be compiled by the typechecker and run by nobody, which is
  // the same as not having written it. The API suite is where it runs because the
  // API is what the contract is a contract with, and because
  // `moduleNameMapper` below already points `@learnsdlc/shared` at the same
  // sources, so a spec here and a spec there read one copy of the module.
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/../../packages/shared/src'],
  testMatch: ['**/*.spec.ts', '**/*.e2e-spec.ts'],
  // Every module this suite imports without an extension is TypeScript, and
  // `ts` leads so that it stays that way. Jest's default order begins `js`,
  // which means a compiled twin sitting next to its own source silently wins
  // the import: `tsconfig.build.json` compiles with `rootDir: src`, so a source
  // under `src/` that imports a `test/` module makes `npm run build -w
  // @learnsdlc/api` write that module's output to `dist/../test/<name>.js`, and
  // the verdict-golden net would then be held against a build artefact,
  // reading a later edit to the recorder as no edit at all.
  // `src/build-boundary.spec.ts` keeps `src/` from importing `test/`, and this
  // order is the second fence. `js` stays in the list (Jest requires it, and
  // `setup-env.js` is real); it simply does not outrank the source.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'node'],
  moduleNameMapper: {
    '^@learnsdlc/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  setupFiles: ['<rootDir>/test/setup-env.js'],
  testTimeout: 60000,
};

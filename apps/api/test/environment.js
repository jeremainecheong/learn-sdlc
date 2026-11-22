/**
 * The API suite's test environment: Jest's own `node` environment, and one
 * thing it cannot know to do: stop the performance observers a test file's
 * modules started, when that file ends.
 *
 * **Why.** Run in band without this, the suite runs out of V8's default heap
 * part-way through: every file that loads `src/observability/metrics.ts` keeps
 * 25-60 MB alive after it finishes. A heap snapshot names the retainer. That
 * module calls prom-client's `collectDefaultMetrics()` once per module instance,
 * which in production is once per process, and Jest evaluates the module
 * afresh for every test file. prom-client's GC metric starts a
 * `PerformanceObserver` and never disconnects it. `perf_hooks` is a core
 * module, shared by every file in the process, so its observer list keeps the
 * callback, the callback keeps its file's vm context, and the context keeps
 * that file's whole module graph (Nest, typeorm, the app) for the rest of the
 * run. The same observer also went on firing for every garbage collection of
 * every later file.
 *
 * So the environment notes each observer that starts observing while its file
 * runs and disconnects it at teardown, after the file's own `afterAll`. No
 * product code changes: the server still collects its default metrics, once,
 * for the life of its process, and a spec that scrapes `/metrics` still reads
 * them. The wrapper is installed on the shared prototype once per process and
 * lives in this realm, not in any file's sandbox, so it keeps no file alive of
 * its own.
 */
const { TestEnvironment } = require('jest-environment-node');
const { PerformanceObserver } = require('node:perf_hooks');
const v8 = require('node:v8');

/**
 * The second retainer the same snapshots name, and the reason this is a flag.
 * Nest 12 is ESM, so every file loads it as vm `SourceTextModule`s, and each
 * module Jest compiles carries a dynamic-import callback that closes over that
 * file's runtime. V8's compilation cache keeps the compiled scripts (and with
 * them the callbacks, the modules and the file's graph) after the file ends,
 * and an ordinary collection never clears it: measured over twelve end-to-end
 * files, the heap after a full GC still grew ~32 MB a file with the observers
 * disconnected, and stayed flat with the cache off. The cache only saves
 * recompiling a source this process already compiled; every file recompiles
 * into a fresh context anyway, and the same twelve files ran faster without it.
 * Set here, before any test file compiles, so it holds however the suite is
 * started: the package script, CI, or the bare command in the README.
 */
v8.setFlagsFromString('--no-compilation-cache');

const INSTALLED = Symbol.for('learnsdlc.test.observers-tracked');

/** The environment whose file is running now; in band that is exactly one. */
let running = null;

if (!PerformanceObserver.prototype[INSTALLED]) {
  const observe = PerformanceObserver.prototype.observe;
  Object.defineProperty(PerformanceObserver.prototype, 'observe', {
    configurable: true,
    writable: true,
    value: function observeAndNote(...args) {
      if (running) running.observers.add(this);
      return observe.apply(this, args);
    },
  });
  Object.defineProperty(PerformanceObserver.prototype, INSTALLED, { value: true });
}

class ApiTestEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.observers = new Set();
    running = this;
  }

  async teardown() {
    for (const observer of this.observers) {
      try {
        observer.disconnect();
      } catch {
        // Already disconnected by the code that started it.
      }
    }
    this.observers.clear();
    if (running === this) running = null;
    await super.teardown();
  }
}

module.exports = ApiTestEnvironment;

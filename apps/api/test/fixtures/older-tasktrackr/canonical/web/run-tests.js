/**
 * The front-end suite, on your laptop.
 *
 * It does the three things the LearnSDLC sandbox does to the same files, in
 * the same order, so a suite that passes here passes there:
 *
 *   1. esbuild every .ts and .tsx in web/src to CommonJS, one file per file
 *      and not bundled, so a stack frame still names the file you wrote;
 *   2. put a jsdom document, React's act flag and a fetch that refuses to
 *      reach the network in place before the first test file loads;
 *   3. load every *.test.js, run the cases one at a time, and report.
 *
 * `test`, `it`, `describe` and `assert` are globals here exactly as they are
 * in the sandbox, which is why the suites import no test framework at all.
 *
 *     node web/run-tests.js            every suite
 *     node web/run-tests.js overdue    only the files whose path contains it
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const WEB = __dirname;
const SRC = path.join(WEB, 'src');
const OUT = path.join(WEB, '.test');
const CASE_TIMEOUT_MS = 5000;

function walk(dir, keep) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(child, keep));
    else if (keep(child)) found.push(child);
  }
  return found;
}

function transform() {
  const esbuild = require('esbuild');
  const sources = walk(SRC, (file) => /\.tsx?$/.test(file));
  fs.rmSync(OUT, { recursive: true, force: true });
  esbuild.buildSync({
    entryPoints: sources,
    outdir: OUT,
    outbase: SRC,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
}

function openDom() {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  for (const key of [
    'window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'CustomEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'MutationObserver', 'localStorage', 'sessionStorage',
  ]) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.fetch = () =>
    Promise.reject(new Error('this test made a network call; stub it or test the API layer directly'));
}

const pending = [];
globalThis.assert = assert;
globalThis.test = (name, fn) => pending.push([name, fn]);
globalThis.it = globalThis.test;
globalThis.describe = (name, fn) => fn();

// A component that throws while React is committing an async update raises
// outside the awaited promise chain, and would take the whole process — and the
// run's result with it — before a single case was reported. Anything that
// escapes is attributed to the case that was running.
let derail = null;
process.on('uncaughtException', (failure) => {
  if (derail) derail(failure);
  else {
    console.log(`\nERRORED  after the last case\n  ${(failure && failure.message) || failure}`);
    process.exit(1);
  }
});
process.on('unhandledRejection', (failure) => {
  if (derail) derail(failure instanceof Error ? failure : new Error(String(failure)));
});

async function runOne(name, fn) {
  const started = Date.now();
  const escaped = new Promise((_, reject) => {
    derail = reject;
  });
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      escaped,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`case did not finish in ${CASE_TIMEOUT_MS} ms`)), CASE_TIMEOUT_MS).unref(),
      ),
    ]);
    derail = null;
    return { name, status: 'passed', ms: Date.now() - started };
  } catch (failure) {
    derail = null;
    const isAssertion = failure && (failure.code === 'ERR_ASSERTION' || failure instanceof assert.AssertionError);
    return {
      name,
      status: isAssertion ? 'failed' : 'errored',
      ms: Date.now() - started,
      message: String((failure && failure.message) || failure),
      stack: failure && failure.stack,
    };
  }
}

async function main() {
  const filter = process.argv[2] || '';
  transform();
  openDom();

  const files = walk(OUT, (file) => file.endsWith('.test.js'))
    .filter((file) => file.includes(filter))
    .sort();
  const results = [];
  for (const file of files) {
    pending.length = 0;
    try {
      require(file);
    } catch (failure) {
      results.push({ name: path.relative(OUT, file), status: 'errored', ms: 0, message: String(failure && failure.message), stack: failure && failure.stack });
      continue;
    }
    for (const [name, fn] of pending) results.push(await runOne(name, fn));
  }

  for (const result of results) {
    if (result.status === 'passed') continue;
    console.log(`\n${result.status.toUpperCase()}  ${result.name}\n  ${result.message}`);
    if (result.stack) console.log(String(result.stack).split('\n').slice(1, 4).join('\n'));
  }
  const passed = results.filter((r) => r.status === 'passed').length;
  console.log(`\n${passed} of ${results.length} front-end cases passed`);
  process.exit(passed === results.length && results.length > 0 ? 0 : 1);
}

main();

// Lambda-runner stress: drive SandboxService in RUNNER_MODE=lambda against a
// mock Lambda Invoke endpoint that delegates to the real lambda_handler.py,
// under heavy concurrency and adversarial payloads. (LocalStack runs the same
// path end-to-end in CI; this proves the adapter + handler under load without
// a Docker daemon.)
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const runnerDir = path.join(ROOT, 'apps', 'api', 'runner');
const PY_SHIM = 'import json,sys\nfrom lambda_handler import handler\nprint(json.dumps(handler(json.loads(sys.stdin.read()), None)))';

let pass = 0, fail = 0;
// Invocations the handler ended by raising. Real Lambda counts these as
// function errors; here they are what check 4 watches.
let unhandled = 0;
const rec = (n, ok, d = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${d}`); };

// Mock Lambda Invoke endpoint: each request runs the real handler in its own
// child process ASYNCHRONOUSLY, so concurrent invokes execute in parallel the
// way real Lambda (and LocalStack in CI) run them in separate containers.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const child = spawn('python3', ['-c', PY_SHIM], { cwd: runnerDir });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', (code) => {
      if (code !== 0) { unhandled += 1; res.writeHead(200, { 'X-Amz-Function-Error': 'Unhandled' }); res.end(JSON.stringify({ errorMessage: err.slice(0, 300) })); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(out.trim());
    });
    child.stdin.write(body); child.stdin.end();
  });
});

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.RUNNER_MODE = 'lambda';
  process.env.AWS_ENDPOINT_URL = `http://127.0.0.1:${port}`;
  process.env.RUNNER_LAMBDA_FUNCTION = 'learnsdlc-code-runner';
  process.env.AWS_ACCESS_KEY_ID = 'test';
  process.env.AWS_SECRET_ACCESS_KEY = 'test';
  process.env.RUN_TIMEOUT_SECONDS = '4'; // loops die fast under 4-core contention

  const { SandboxService } = await import(path.join(ROOT, 'apps', 'api', 'dist', 'execution', 'sandbox.service.js'));
  const svc = new SandboxService();

  const goodJob = (n) => ({ files: { 'tasktrackr/__init__.py': '', 'm.py': `def d(x):\n    return x*${n}\n`, 'tests/test_x.py': `import unittest\nfrom m import d\nclass T(unittest.TestCase):\n    def test_d(self):\n        self.assertEqual(d(2), ${2*n})\n` }, mode: 'tests', testPaths: ['tests/test_x.py'] });
  const badJob = { files: { 'tests/test_x.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1,2)\n' }, mode: 'tests', testPaths: ['tests/test_x.py'] };
  const loopJob = { files: { 'tests/test_x.py': 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        while True: pass\n' }, mode: 'tests', testPaths: ['tests/test_x.py'] };
  const netJob = { files: { 'tests/test_x.py': "import unittest, socket\nclass T(unittest.TestCase):\n    def test_x(self):\n        socket.create_connection(('8.8.8.8',53),timeout=2)\n" }, mode: 'tests', testPaths: ['tests/test_x.py'] };

  // 1. single correct invoke
  {
    const r = await svc.execute(goodJob(3));
    rec('lambda: single correct job', r.ok && r.tests?.passed === 1, `exit=${r.exitKind}`);
  }
  // 2. 30 concurrent correct invokes, each with a distinct expected value -> no cross-talk
  {
    const t0 = Date.now();
    const jobs = Array.from({ length: 30 }, (_, i) => svc.execute(goodJob(i + 1)));
    const results = await Promise.all(jobs);
    const allOk = results.every(r => r.ok && r.tests?.passed === 1);
    rec('lambda: 30 concurrent correct jobs, no cross-talk', allOk, `${results.filter(r=>r.ok).length}/30 in ${Date.now()-t0}ms`);
  }
  // 3. mixed batch: correct + failing + timeout + network, all classified correctly under load
  {
    const spec = [];
    for (let i = 0; i < 24; i++) spec.push(i % 4 === 0 ? loopJob : i % 4 === 1 ? badJob : i % 4 === 2 ? netJob : goodJob(7));
    const results = await Promise.all(spec.map(j => svc.execute({ ...j })));
    const cls = spec.map((j, i) => {
      const r = results[i];
      if (j === loopJob) return r.exitKind === 'timeout';
      if (j === badJob) return !r.ok && r.tests?.failed === 1;
      if (j === netJob) return r.tests && r.tests.cases[0].status !== 'passed';
      return r.ok && r.tests?.passed === 1;
    });
    rec('lambda: 24 mixed adversarial jobs classified correctly', cls.every(Boolean), `${cls.filter(Boolean).length}/24`);
  }
  // 4. handler error path: a job the runner cannot read comes back as a result
  //    rather than a throw, and as `unavailable` rather than `error`: nothing
  //    graded this learner's code, and sandbox.service.ts keeps those two apart
  //    so an outage is never charged to the learner as a failed attempt. The
  //    handler answers it the way serve.py answers a bad job (a payload, not a
  //    traceback), so the invocation itself must not fail either.
  {
    const before = unhandled;
    const r = await svc.execute({ files: {}, mode: 'nonsense-mode', testPaths: [] });
    const ok = r.ok === false && r.exitKind === 'unavailable' && !r.tests && unhandled === before;
    rec('lambda: malformed job -> unavailable, and no unhandled invocation', ok,
        `exit=${r.exitKind} unhandled=${unhandled - before}`);
  }
  // 6. sustained throughput: 60 sequential-ish invokes in 3 waves of 20
  {
    const t0 = Date.now();
    let okCount = 0;
    for (let wave = 0; wave < 3; wave++) {
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.execute(goodJob(wave * 20 + i + 1))));
      okCount += results.filter(r => r.ok && r.tests?.passed === 1).length;
    }
    rec('lambda: 60 invokes across 3 waves', okCount === 60, `${okCount}/60 in ${Date.now()-t0}ms`);
  }

  server.close();
  console.log(`\nLAMBDA STRESS: ${pass}/${pass+fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('HARNESS ERROR:', e.message); server.close(); process.exit(2); });

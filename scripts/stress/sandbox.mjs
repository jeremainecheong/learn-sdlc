// Adversarial stress battery against the Python sandbox runner directly.
//
// Probes 1-13 are resource containment; 14-19 are the in-process escape
// blocks (environment scrub, non-dumpable harness, _socket bypass, exec of
// curl/sh, ctypes, child_process); 20 drives serve.py over its UNIX socket
// as a non-root uid, the shape the runner container and CI actually run.
// Everything else here exercises the LOCAL runner
// (sandbox_runner.py as a plain process), so what it proves is the Python /
// Node-level hardening: a second line of defence that code in the same
// interpreter can in principle unwind. The real boundary is the runner
// container in docker-compose.yml / infra/runner.Dockerfile: no network, no
// secrets in its environment, uid 65534, its own pid namespace, read-only
// rootfs, no curl, and no /app/content. This script cannot prove any of
// those; `docker compose config` and the Dockerfile are the evidence.
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const RUNNER = path.join(ROOT, 'apps', 'api', 'runner', 'sandbox_runner.py');
// Root reads every /proc/<pid>/environ regardless of dumpability, which
// would make the environ probe pass or fail on who runs the script rather
// than on the runner. As root, run the runner as the same uid the container
// uses; as an ordinary user, stay that user (non-root is what matters).
const RUNNER_UID = process.getuid && process.getuid() === 0 ? 65534 : undefined;
// Stands in for the API's JWT_SECRET/DATABASE_URL: in RUNNER_MODE=local the
// runner inherits the API environment, and learner code must not get at it.
const CANARY = 'canary-' + crypto.randomBytes(12).toString('hex');
let pass = 0, fail = 0;
const results = [];

function runJob(job, harnessTimeoutMs = 40000) {
  return new Promise((resolve) => {
    const child = spawn('python3', [RUNNER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LSDLC_STRESS_CANARY: CANARY, NODE_BIN: process.execPath },
      ...(RUNNER_UID !== undefined ? { uid: RUNNER_UID, gid: RUNNER_UID } : {}),
    });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve({ harnessTimedOut: true, out, err }); }, harnessTimeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

const SERVE = path.join(ROOT, 'apps', 'api', 'runner', 'serve.py');

async function waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

// One HTTP exchange over a UNIX socket, the way sandbox.service.ts talks to
// the runner in RUNNER_MODE=socket. Resolves {status, body}; never rejects.
function unixRequest(socketPath, method, reqPath, payload) {
  return new Promise((resolve) => {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request(
      {
        socketPath, method, path: reqPath, timeout: 20000,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = { raw }; }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ status: 0, body: { error: String(err && err.message) } }));
    if (data) req.write(data);
    req.end();
  });
}

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`ok   ${name} ${detail}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
  results.push({ name, ok: !!cond, detail });
}

const testFile = (body) => ({ 'tests/test_x.py': `import unittest\n${body}\n` });

async function main() {
  // 1. infinite loop -> timeout, harness itself must return cleanly
  {
    const r = await runJob({ files: testFile('class T(unittest.TestCase):\n    def test_loop(self):\n        while True: pass'), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('infinite loop killed by wall-clock', !r.harnessTimedOut && res && res.exitKind === 'timeout' && !res.ok, res ? res.exitKind : 'no-output');
  }
  // 2. CPU spin (busy math) -> CPU rlimit / timeout
  {
    const r = await runJob({ files: testFile('class T(unittest.TestCase):\n    def test_spin(self):\n        x=0\n        while True:\n            x = (x*x + 1) % 999983'), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('cpu spin bounded', !r.harnessTimedOut && res && res.exitKind === 'timeout', res ? `${res.durationMs}ms` : 'no-output');
  }
  // 3. memory bomb -> address-space rlimit, reported not OK, no OOM of harness
  {
    const r = await runJob({ files: testFile("class T(unittest.TestCase):\n    def test_mem(self):\n        b = bytearray(2_000_000_000)\n        self.assertTrue(len(b) > 0)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 8, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('memory bomb contained', !r.harnessTimedOut && res && !res.ok, res ? `exit=${res.exitKind} tests=${res.tests ? res.tests.passed+'/'+res.tests.total : 'none'}` : 'no-output');
  }
  // 4. fork bomb attempt -> os.fork blocked/limited, harness survives
  {
    // Bounded (children os._exit so it can't grow exponentially): the learner
    // spawns 30 sleeper subprocesses then loops. On timeout the runner must
    // reap the ENTIRE process group (SIGSTOP+SIGKILL loop), leaving no orphans.
    const countPy = () => {
      try { return parseInt(execSync(`ps -u ${RUNNER_UID ?? process.getuid()} --no-headers | grep -c "[p]ython" || true`).toString().trim() || '0', 10); }
      catch { return -1; }
    };
    const before = countPy();
    const r = await runJob({ files: testFile("import os, time\nclass T(unittest.TestCase):\n    def test_spawn(self):\n        for _ in range(30):\n            if os.fork() == 0:\n                time.sleep(60)\n                os._exit(0)\n        while True: pass"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    await new Promise((res2) => setTimeout(res2, 2500));
    const after = countPy();
    check('spawned process group fully reaped on timeout', !r.harnessTimedOut && res && res.exitKind === 'timeout' && (before < 0 || after <= before + 2), `exit=${res ? res.exitKind : 'none'} py before=${before} after=${after}`);
  }
  // 5. network attempt -> blocked at socket layer
  {
    const r = await runJob({ files: testFile("import socket\nclass T(unittest.TestCase):\n    def test_net(self):\n        socket.create_connection(('8.8.8.8', 53), timeout=2)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 6, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    const msg = res && res.tests && res.tests.cases[0] ? res.tests.cases[0].message || '' : '';
    check('network blocked', res && res.tests && res.tests.cases[0] && res.tests.cases[0].status !== 'passed' && /disabled|RuntimeError/.test(msg), msg.slice(0, 50));
  }
  // 6. huge stdout -> clipped, not unbounded
  {
    const r = await runJob({ files: testFile("class T(unittest.TestCase):\n    def test_out(self):\n        print('A' * 50_000_000)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 8, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('huge stdout clipped', res && res.stdout.length < 100000, res ? `stdout=${res.stdout.length} bytes` : 'no-output');
  }
  // 7. path traversal in files -> rejected, harness returns error not crash
  {
    const r = await runJob({ files: { '../../../../etc/evil.py': 'x=1' }, mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 });
    check('path traversal rejected', r.code !== 0 || (r.err && /illegal path/.test(r.err)), r.err ? r.err.split('\n').find(l=>/illegal|Error/.test(l)) || '' : `code=${r.code}`);
  }
  // 8. absolute path in files -> rejected
  {
    const r = await runJob({ files: { '/tmp/evil.py': 'x=1' }, mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 });
    check('absolute path rejected', r.code !== 0 || (r.err && /illegal path/.test(r.err)), '');
  }
  // 9. deep recursion -> RecursionError handled, reported as fail not crash
  {
    const r = await runJob({ files: testFile("import sys\nsys.setrecursionlimit(100000)\ndef rec(n):\n    return rec(n+1)\nclass T(unittest.TestCase):\n    def test_rec(self):\n        rec(0)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 6, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('deep recursion handled', res && res.tests && res.tests.cases[0].status !== 'passed', res && res.tests ? res.tests.cases[0].status : 'no-tests');
  }
  // 10. syntax error -> clean error, no crash
  {
    const r = await runJob({ files: { 'tests/test_x.py': 'import unittest\nclass T(unittest.TestCase)\n  def broken(' }, mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('syntax error handled cleanly', res && !res.ok, res ? `exit=${res.exitKind}` : 'no-output');
  }
  // 11. smoke mode with crashing CLI -> reported not ok
  {
    const r = await runJob({ files: { 'cli.py': "import sys\nsys.exit(3)" }, mode: 'smoke', smokeCommands: [['python3','cli.py']], timeoutSeconds: 4, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('smoke non-zero exit caught', res && !res.ok, res ? `exit=${res.exitKind}` : 'no-output');
  }
  // 12. write-file attempt beyond fsize (learner tries to fill disk)
  {
    const r = await runJob({ files: testFile("class T(unittest.TestCase):\n    def test_disk(self):\n        with open('big.bin','wb') as f:\n            f.write(b'x' * 100_000_000)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 8, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('file-size bomb contained', res && res.tests && res.tests.cases[0].status !== 'passed', res && res.tests ? res.tests.cases[0].status : 'no-tests');
  }

  // 13. CONCURRENCY: 24 simultaneous mixed jobs, all must return correctly
  {
    // The good and bad jobs get 30 s, not 10: eight looping jobs saturate a
    // two-core CI runner for their 3 s each, and a correct job starved of CPU
    // must not read as an isolation failure. The loop jobs keep their 3 s so
    // the wall-clock kill is still proven under load.
    const good = { files: { 'tasktrackr/__init__.py': '', 'tasktrackr/m.py': 'def d(n):\n    return n*2\n', 'tests/test_x.py': 'import unittest\nfrom tasktrackr.m import d\nclass T(unittest.TestCase):\n    def test_d(self):\n        self.assertEqual(d(3),6)\n' }, mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 30, memoryMb: 256 };
    const bad = { files: testFile('class T(unittest.TestCase):\n    def test_x(self):\n        self.assertEqual(1,2)'), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 30, memoryMb: 256 };
    const loop = { files: testFile('class T(unittest.TestCase):\n    def test_x(self):\n        while True: pass'), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 3, memoryMb: 128 };
    const jobs = [];
    for (let i = 0; i < 24; i++) jobs.push(i % 3 === 0 ? loop : i % 3 === 1 ? bad : good);
    const t0 = Date.now();
    const outs = await Promise.all(jobs.map((j) => runJob(j, 60000)));
    const parsed = outs.map((r) => (r.out ? JSON.parse(r.out) : null));
    const goodOk = parsed.filter((_, i) => jobs[i] === good).every((r) => r && r.ok);
    const badFail = parsed.filter((_, i) => jobs[i] === bad).every((r) => r && !r.ok && r.tests && r.tests.failed === 1);
    const loopTimeout = parsed.filter((_, i) => jobs[i] === loop).every((r) => r && r.exitKind === 'timeout');
    const goodKinds = parsed.filter((_, i) => jobs[i] === good).map((r) => (r ? `${r.exitKind}${r.ok ? '' : '!'}` : 'null')).join(',');
    check('24 concurrent jobs isolated & correct', goodOk && badFail && loopTimeout && parsed.every((r) => r !== null), `good=${goodOk} (${goodKinds}) bad=${badFail} loop=${loopTimeout} in ${Date.now()-t0}ms`);
  }

  // ---- escape probes (in-process hardening; the container is the boundary) ----
  const caseMsg = (res, name) => {
    const c = res && res.tests && res.tests.cases.find((x) => x.name.endsWith(name));
    return c ? `${c.status}: ${c.message || ''}` : 'no-case';
  };
  const blocked = (res, name) => {
    const c = res && res.tests && res.tests.cases.find((x) => x.name.endsWith(name));
    return !!c && c.status !== 'passed' && /disabled|not available/.test(c.message || '');
  };
  // 14. the job's own environment carries nothing from the runner's
  {
    const r = await runJob({ files: testFile("import os\nclass T(unittest.TestCase):\n    def test_env(self):\n        leaked = [k for k, v in os.environ.items() if 'canary-' in v]\n        self.assertEqual(leaked, [], f'runner env leaked into job: {leaked}')"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 5, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('job environment scrubbed of runner secrets', res && res.ok && res.tests.passed === 1, caseMsg(res, 'test_env'));
  }
  // 15. no other process's environ is readable from inside a job. The runner
  //     holds the canary (as the API's child would hold JWT_SECRET) and marks
  //     itself non-dumpable, so /proc/<runner>/environ is denied to its own uid.
  //     Every child is fenced to its own
  //     workspace and /proc is not even listable from inside a job (that is
  //     the fence holding, not the probe failing), so a refused listing counts
  //     as nothing readable, while any environ that does open and carries the
  //     canary still fails it.
  {
    const r = await runJob({ files: testFile("import os\nclass T(unittest.TestCase):\n    def test_environ(self):\n        found, readable = [], 0\n        try:\n            pids = os.listdir('/proc')\n        except PermissionError:\n            pids = []\n        for pid in pids:\n            if not pid.isdigit(): continue\n            try:\n                with open(f'/proc/{pid}/environ', 'rb') as fh: data = fh.read()\n            except OSError: continue\n            readable += 1\n            if b'canary-' in data: found.append(pid)\n        self.assertEqual(found, [], f'canary readable from pids {found} ({readable} environ files readable)')"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 8, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check(`no sibling /proc/<pid>/environ exposes the runner's secrets (runner uid ${RUNNER_UID ?? process.getuid()})`, res && res.ok && res.tests.passed === 1, caseMsg(res, 'test_environ'));
  }
  // 16. _socket bypasses of the socket monkeypatch
  {
    const r = await runJob({ files: testFile("import socket\nclass T(unittest.TestCase):\n    def test_raw(self):\n        import _socket\n        _socket.socket()\n    def test_alias(self):\n        socket.SocketType(socket.AF_INET, socket.SOCK_STREAM)\n    def test_reimport(self):\n        import sys\n        sys.modules.pop('_socket', None); sys.modules.pop('socket', None)\n        import _socket\n        _socket.socket()"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 5, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('_socket.socket / SocketType / re-import blocked', blocked(res, 'test_raw') && blocked(res, 'test_alias') && blocked(res, 'test_reimport'), caseMsg(res, 'test_raw'));
  }
  // 17. spawning curl or a shell to reach the network
  {
    const r = await runJob({ files: testFile("import os, subprocess\nclass T(unittest.TestCase):\n    def test_curl(self):\n        subprocess.run(['curl', '-sS', 'http://127.0.0.1:1'], timeout=3)\n    def test_shell(self):\n        os.system('curl -sS http://127.0.0.1:1')\n    def test_exec(self):\n        os.execvp('sh', ['sh', '-c', 'exec 3<>/dev/tcp/127.0.0.1/1'])\n    def test_spawn(self):\n        os.posix_spawnp('curl', ['curl', 'http://127.0.0.1:1'], {})"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 5, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('subprocess/os.system/exec/posix_spawn of curl blocked', ['test_curl', 'test_shell', 'test_exec', 'test_spawn'].every((n) => blocked(res, n)), caseMsg(res, 'test_curl'));
  }
  // 18. ctypes (libc socket()/execve() without touching the patched modules)
  {
    const r = await runJob({ files: testFile("class T(unittest.TestCase):\n    def test_ctypes(self):\n        import ctypes\n        ctypes.CDLL(None).socket(2, 1, 0)"), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 5, memoryMb: 128 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('ctypes import blocked', blocked(res, 'test_ctypes'), caseMsg(res, 'test_ctypes'));
  }
  // 19. JavaScript: child_process and process.binding are the exec/network side doors
  {
    const r = await runJob({ files: { 'tests/x.test.js': "test('exec', () => { require('child_process').execSync('curl -sS http://127.0.0.1:1'); });\ntest('binding', () => { process.binding('tcp_wrap'); });\ntest('net', () => { require('net').connect(1, '127.0.0.1'); });\n" }, language: 'javascript', mode: 'tests', testPaths: ['tests/x.test.js'], timeoutSeconds: 8, memoryMb: 256 });
    const res = r.out ? JSON.parse(r.out) : null;
    check('JS child_process / process.binding / net blocked', res && res.tests && res.tests.total === 3 && ['exec', 'binding', 'net'].every((n) => blocked(res, n)), res && res.tests ? res.tests.cases.map((c) => `${c.name}=${c.status}`).join(' ') : `no-tests ${r.err.slice(0, 200)}`);
  }

  // 20. the socket transport, as the uid the container uses. This is the
  //     negative control the rest of the battery cannot provide: every probe
  //     above runs sandbox_runner.py directly, and serve.py once carried a
  //     process-wide umask that stripped x from each job's temp workspace:
  //     invisible to root (CAP_DAC_OVERRIDE ignores directory modes), fatal
  //     for uid 65534 in CI. So the served uid must not be 0, and the check
  //     asserts that alongside the job succeeding; a root runner is a FAIL.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdlc-stress-'));
    if (RUNNER_UID !== undefined) fs.chmodSync(dir, 0o777);
    const sock = path.join(dir, 'runner.sock');
    const server = spawn('python3', [SERVE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUNNER_SOCKET: sock, NODE_BIN: process.execPath },
      ...(RUNNER_UID !== undefined ? { uid: RUNNER_UID, gid: RUNNER_UID } : {}),
    });
    let serr = '';
    server.stderr.on('data', (d) => (serr += d));
    const ready = await waitFor(() => fs.existsSync(sock), 10000);
    const mode = ready ? fs.statSync(sock).mode & 0o777 : 0;
    const health = ready ? await unixRequest(sock, 'GET', '/health') : { status: 0, body: {} };
    const job = ready
      ? await unixRequest(sock, 'POST', '/execute', { files: testFile('class T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)'), mode: 'tests', testPaths: ['tests/test_x.py'], timeoutSeconds: 5, memoryMb: 128 })
      : { status: 0, body: {} };
    server.kill('SIGTERM');
    await new Promise((r) => server.once('close', r));
    fs.rmSync(dir, { recursive: true, force: true });
    const uid = health.body && typeof health.body.uid === 'number' ? health.body.uid : undefined;
    const ok = ready && uid !== undefined && uid !== 0 && job.status === 200 && job.body && job.body.ok === true && job.body.tests && job.body.tests.passed === 1;
    check(
      `serve.py over its socket completes a job as a non-root uid (served uid ${uid ?? 'none'})`,
      ok,
      ready ? `execute=${job.status} ${JSON.stringify(job.body).slice(0, 160)}` : `no socket within 10s: ${serr.slice(0, 200)}`,
    );
    check('runner socket is 0666 so the API uid can connect across the volume', ready && mode === 0o666, `mode=${mode.toString(8)}`);
  }

  console.log(`\nSANDBOX STRESS: ${pass}/${pass+fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}
main();

// Proves the production claim that matters most: a grading job survives its
// worker being killed mid-flight.
//
// It advances a learner to the code phase, submits deliberately slow work,
// SIGKILLs the API while that job is running, restarts it, and waits for the
// job to COMPLETE on its own. With the durable (Redis/BullMQ) queue the job is
// re-delivered and finishes with no user action. With the in-process queue
// there is nothing to resume, so the job must instead be reconciled to a clear
// 'failed' state, never left hanging forever.
//
// With the durable queue the re-delivered job first waits out the row's
// processing lease the killed worker took (IN_FLIGHT_MAX_AGE_MS, 10 minutes,
// in apps/api/src/feedback/feedback.service.ts), so the verdict lands about
// ten minutes after the kill and this check waits that long.
//
// Usage (an API must already be running on :4000 with the same env):
//   node scripts/durability-check.mjs
//
// Against an API this script did not start (the Compose stack, where the API
// is a container), three variables say how, and nothing else changes:
//   DURABILITY_KILL_CMD   a shell command that SIGKILLs the API
//                         (docker compose ... kill -s SIGKILL api)
//   DURABILITY_START_CMD  a shell command that starts it again
//                         (docker compose ... start api)
//   DURABILITY_QUEUE      durable | in-process, when REDIS_URL is not in this
//                         process's environment to say which
// scripts/prove-local.sh sets all three.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { IMPLEMENTATION_ARTEFACT } from './golden-artefacts.mjs';
import { codeWork, designWork, requirementsWork } from './passing-work.mjs';
import { poll as pollUntil, request, sleep } from './lib/api-client.mjs';
import { NATIVE_API_URL } from './lib/endpoints.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_URL || NATIVE_API_URL;
const DURABLE = process.env.DURABILITY_QUEUE
  ? process.env.DURABILITY_QUEUE === 'durable'
  : Boolean(process.env.REDIS_URL);
const KILL_CMD = process.env.DURABILITY_KILL_CMD || '';
const START_CMD = process.env.DURABILITY_START_CMD || '';

let TOKEN = '';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${detail}`);
};

async function call(method, p, body) {
  const { status, data } = await request(API, method, p, { token: TOKEN, body });
  if (status >= 400) throw new Error(`${method} ${p} -> ${status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}
/** Every half second, 180 tries (90 s) unless told otherwise. */
const poll = (fn, done, tries = 180) => pollUntil(fn, done, { tries });
const waitForHealth = async (tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${API}/health/live`);
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
};

/**
 * The same slow-but-correct work every time: the finished repository with a
 * six-second sleep at import, which makes each sandbox run slow enough to be
 * killed mid-flight. Spliced into the golden implementation rather than
 * written out here, so it stays the artefact the graders actually pass.
 */
function slowButCorrectImplementation() {
  const repository = IMPLEMENTATION_ARTEFACT['api/repository/tasks.py'];
  const marker = '\nfrom api.db import';
  if (!repository.includes(marker)) {
    throw new Error('api/repository/tasks.py no longer imports api.db, so this splice has nowhere to go');
  }
  const slept = repository.replace(marker, '\nimport time\n\ntime.sleep(6)\n\nfrom api.db import');
  return { ...IMPLEMENTATION_ARTEFACT, 'api/repository/tasks.py': slept };
}

const sh = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out.trim()));
  });

/** A shell command's exit status, its output passed through. */
const shStatus = (cmd) =>
  new Promise((resolve) => {
    const p = spawn('bash', ['-c', cmd], { stdio: 'inherit' });
    p.on('error', () => resolve(127));
    p.on('close', (code) => resolve(code ?? 1));
  });

// Reads the listening socket's inode out of /proc/net/tcp{,6} and finds the
// process holding that fd. Pure Node, so it works on any Linux box even when
// psmisc/iproute2/lsof are all absent, which is the case on some CI images.
function listenerPidFromProc(port) {
  const wanted = port.toString(16).toUpperCase().padStart(4, '0');
  const inodes = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = fs.readFileSync(table, 'utf-8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10) continue;
      if (f[3] !== '0A') continue; // TCP_LISTEN
      if (!f[1].endsWith(`:${wanted}`)) continue;
      inodes.add(f[9]);
    }
  }
  if (!inodes.size) return 0;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try {
      fds = fs.readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue; // another user's process, or it exited mid-scan
    }
    for (const fd of fds) {
      let link;
      try {
        link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) return Number(entry);
    }
  }
  return 0;
}

// Four independent ways to answer "who is listening on :4000". The check is
// about queue durability, not about which process tools the runner ships.
async function findListenerPid(port) {
  const attempts = [
    `fuser ${port}/tcp 2>/dev/null | tr -d ' '`,
    `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -1`,
    `ss -lptnH 'sport = :${port}' 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`,
  ];
  for (const cmd of attempts) {
    const pid = Number((await sh(cmd)).split(/\s+/)[0] || 0);
    if (pid > 0) return pid;
  }
  return listenerPidFromProc(port);
}

function startApi() {
  const child = spawn('node', ['apps/api/dist/main.js'], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(path.join(ROOT, 'durability-restart.log'), { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return child;
}

async function main() {
  console.log(`durability check: queue is ${DURABLE ? 'DURABLE (redis)' : 'in-process'}`);

  const reg = await call('POST', '/auth/register', {
    email: `durability-${Date.now()}@learnsdlc.test`,
    password: 'Password1!',
    displayName: 'Durability Check',
  });
  TOKEN = reg.token;

  let enrollment = await call('POST', '/enrollments', { projectSlug: 'tasktrackr' });
  for (const [order, files] of [
    [1, requirementsWork()],
    [2, designWork()],
  ]) {
    const phase = enrollment.phases.find((p) => p.order === order);
    await call('PUT', `/phases/${phase.id}/workspace`, { files });
    const sub = await call('POST', `/phases/${phase.id}/submit`);
    const done = await poll(() => call('GET', `/submissions/${sub.id}`), (v) => v.status === 'completed' || v.status === 'failed');
    if (!done.passed) throw new Error(`setup: phase ${order} did not pass (score ${done.score})`);
    await call('POST', `/phases/${phase.id}/reflect`, {
      reflection: 'The automated feedback changed how I approached the following phase of the project.',
    });
    enrollment = await call('POST', `/phases/${phase.id}/advance`);
  }

  const phase3 = enrollment.phases.find((p) => p.order === 3);
  await call('PUT', `/phases/${phase3.id}/workspace`, { files: codeWork(slowButCorrectImplementation()) });
  // Run once before submitting, as a learner does and as scripts/journey.mjs
  // does: the implementation verdict counts the runs that came before it, and
  // work submitted without one scores 94 and does not pass.
  const run = await call('POST', `/phases/${phase3.id}/run`);
  const ran = await poll(() => call('GET', `/runs/${run.id}`), (v) => v.status === 'completed' || v.status === 'failed', 240);
  if (ran.status !== 'completed') throw new Error(`setup: the run before the submission did not complete (${ran.status})`);

  const submission = await call('POST', `/phases/${phase3.id}/submit`);
  const midFlight = await poll(
    () => call('GET', `/submissions/${submission.id}`),
    (v) => v.status === 'running',
    40,
  );
  check('job reaches "running" before the kill', midFlight.status === 'running', `status=${midFlight.status}`);

  // SIGKILL the API: no shutdown hooks, no draining: the worst case.
  if (KILL_CMD) {
    const killed = await shStatus(KILL_CMD);
    if (killed !== 0) throw new Error(`DURABILITY_KILL_CMD exited ${killed}`);
    console.log('  SIGKILLed the API (DURABILITY_KILL_CMD) mid-grading');
  } else {
    const apiPort = Number(new URL(API).port || 80);
    const pid = await findListenerPid(apiPort);
    if (!pid) throw new Error(`could not find the API process listening on :${apiPort}`);
    process.kill(pid, 'SIGKILL');
    console.log(`  SIGKILLed API (pid ${pid}) mid-grading`);
  }
  await sleep(2000);

  if (START_CMD) {
    const started = await shStatus(START_CMD);
    if (started !== 0) throw new Error(`DURABILITY_START_CMD exited ${started}`);
  } else {
    startApi();
  }
  const up = await waitForHealth();
  check('API restarts after the kill', up);

  // Durable: BullMQ's 30 s lock and 10 s stall check, then the 10-minute row
  // lease (JobDeferredUntil), then one grading run of the slow work. In
  // process: the boot reconciles the row at once, so 90 s stays the bound.
  const LEASE_MS = 10 * 60 * 1000;
  const settleMs = DURABLE ? LEASE_MS + 30_000 + 10_000 + 3 * 60 * 1000 : 90_000;
  const settled = await poll(
    () => call('GET', `/submissions/${submission.id}`),
    (v) => v.status === 'completed' || v.status === 'failed',
    Math.ceil(settleMs / 500),
  );

  if (DURABLE) {
    check(
      'durable queue RESUMES the interrupted job and completes it',
      settled.status === 'completed' && settled.passed === true,
      `status=${settled.status} passed=${settled.passed} score=${settled.score} failed=${JSON.stringify(
        settled.report?.checks?.filter((c) => c.status === 'failed').map((c) => c.id) ?? settled.error ?? null,
      )}`,
    );
  } else {
    check(
      'in-process queue reconciles the interrupted job to a clear failure',
      settled.status === 'failed' && /restart/i.test(settled.error || ''),
      `status=${settled.status} error=${(settled.error || '').slice(0, 60)}`,
    );
  }
  check('the learner is never left hanging', settled.status !== 'running' && settled.status !== 'queued', `status=${settled.status}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} durability checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('DURABILITY CHECK ERROR:', err.message);
  process.exit(2);
});

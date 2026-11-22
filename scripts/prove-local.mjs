#!/usr/bin/env node
// The checks scripts/prove-local.sh runs against a stack that is already up.
// Run it through that script; it starts the stack, picks the mode and names
// the receipt. Each check is timed and recorded; nothing here prints or
// records a secret, a host or an address other than the seeded demo ones.
//
//   node scripts/prove-local.mjs --mode full|ai --receipt <file> --logs <dir>
//        [--api http://localhost:4080/api/v1] [--web http://localhost:3080]
//        [--stub-marker] [--skip-durability] [--label <text>]
//
// full: everything a learner and a teacher use, on the Compose stack:
//       health, sign-in, the AI round trips, the six-phase journey with Run,
//       Submit and Preview through the runner container (scripts/journey.mjs),
//       a teacher's upload and deep validation of the Shelf pack, a teacher
//       authoring a Requirements story task that a learner then passes
//       (scripts/author-requirements.mjs), a teacher authoring a Design task
//       (both contracts and the sequence diagram on, two stories, a floor, a
//       starting point) that a learner then passes (scripts/author-design.mjs),
//       a teacher authoring a Deployment runbook floor and starting runbook
//       (scripts/author-deployment.mjs) and a Maintenance ticket and change
//       floor (scripts/author-maintenance.mjs) that a learner then passes,
//       a fresh teacher's three-phase project (shelf-three) that a fresh
//       learner finishes (scripts/author-subset.mjs), a fresh teacher's
//       Shelf with a quiz and edited Criteria exported and uploaded again to
//       the same tasks (scripts/export-roundtrip.mjs), and the durable queue
//       surviving an API kill (scripts/durability-check.mjs).
// ai:   the AI round trips alone, against whatever the API is configured with
//       (--ai-check): a mentor reply, a rubric review that the
//       API's parser accepts, and an Agentic propose -> explain -> apply on
//       the Requirements story record.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORED_RUNBOOK_FLOOR, authorDeployment } from './author-deployment.mjs';
import { AUTHORED_DESIGN_FLOOR, AUTHORED_DESIGN_START, AUTHORED_DESIGN_STORIES, AUTHORED_DESIGN_WEIGHTS, authorDesign } from './author-design.mjs';
import { AUTHORED_CHANGE_FLOOR, AUTHORED_TICKET, authorMaintenance } from './author-maintenance.mjs';
import { AUTHORED_PROVIDED_IDS, AUTHORED_WEIGHTS, authorRequirements } from './author-requirements.mjs';
import { proveSubset } from './author-subset.mjs';
import { proveRoundTrip } from './export-roundtrip.mjs';
import { zipPackDirectory } from './pack-archive.mjs';
import { readEnvFile } from './stack-seed.mjs';
import { mustOk, request, sleep } from './lib/api-client.mjs';
import { stackInstructor } from './lib/demo-accounts.mjs';
import { STACK_API_URL, STACK_WEB_URL } from './lib/endpoints.mjs';

// Every row the design, runbook and change floors grade, in order (packages/shared:
// design-floor.ts, runbook-record.ts, change-record.ts).
const { DESIGN_FLOOR_IDS, RUNBOOK_FLOOR_IDS, changeFloorIds } = createRequire(import.meta.url)('@learnsdlc/shared');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { mode: 'full', api: STACK_API_URL, web: STACK_WEB_URL, stubMarker: false, skipDurability: false, label: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mode') out.mode = next();
    else if (a === '--receipt') out.receipt = next();
    else if (a === '--logs') out.logs = next();
    else if (a === '--api') out.api = next().replace(/\/$/, '');
    else if (a === '--web') out.web = next().replace(/\/$/, '');
    else if (a === '--stub-marker') out.stubMarker = true;
    else if (a === '--skip-durability') out.skipDurability = true;
    else if (a === '--label') out.label = next();
    else throw new Error(`unknown option ${a}`);
  }
  if (!['full', 'ai'].includes(out.mode)) throw new Error('--mode is full or ai');
  if (!out.receipt || !out.logs) throw new Error('--receipt and --logs are required');
  return out;
}

let OPT;
try {
  OPT = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}. Run it through scripts/prove-local.sh (--help).`);
  process.exit(2);
}
const API = OPT.api;
// scripts/passing-work.mjs reads this when it is first imported: marked work
// for the stub, the work as written for a real model.
process.env.E2E_AI_STUB = OPT.stubMarker ? 'true' : '';
fs.mkdirSync(OPT.logs, { recursive: true });

/* ------------------------------------------------------------------ helpers */

const steps = [];
/** Wall-clock milliseconds of every call that waited on the model, for the p95. */
const aiLatencies = [];
/** One call; `ai: true` adds its wall-clock time to the latencies the receipt reports. */
async function call(method, route, { token, body, ai = false } = {}) {
  const started = Date.now();
  const res = await request(API, method, route, { token, body });
  if (ai) aiLatencies.push(Date.now() - started);
  return res;
}

/** One call that must succeed; a refusal throws with the API's own sentence. */
const must = (method, route, options) => mustOk(API, method, route, options);

async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`\n--> ${name}\n`);
  try {
    const detail = (await fn()) ?? '';
    const ms = Date.now() - started;
    steps.push({ name, ok: true, ms, detail });
    console.log(`    \x1b[32mok\x1b[0m   ${name} (${(ms / 1000).toFixed(1)} s)${detail ? `: ${detail}` : ''}`);
    return true;
  } catch (error) {
    const ms = Date.now() - started;
    const detail = String(error?.message ?? error).slice(0, 600);
    steps.push({ name, ok: false, ms, detail });
    console.log(`    \x1b[31mFAIL\x1b[0m ${name} (${(ms / 1000).toFixed(1)} s): ${detail}`);
    return false;
  }
}

/** A child process, its output to a log file and to this terminal. Resolves its exit code. */
function runLogged(command, args, { env = {}, log }) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(log);
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const take = (chunk) => {
      out.write(chunk);
      process.stdout.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => resolve({ code: 127, tail }));
    child.on('close', (code) => out.end(() => resolve({ code: code ?? 1, tail })));
  });
}

const stack = (...args) => ['bash', [path.join(ROOT, 'scripts/stack.sh'), 'compose', ...args]];

function quiet(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve({ code: 127, out }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

/** The stack's generated settings (the administrator among them), or nothing before its first start. */
function readEnvVerify() {
  const file = path.join(ROOT, '.env.verify');
  return fs.existsSync(file) ? readEnvFile(file) : {};
}

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/* ----------------------------------------------------------- the AI round trips */

const PASSWORD = 'Password1!';
const MARK = (text) => (OPT.stubMarker ? `${text} E2E-PASS` : text);
const STORY = 'requirements/story.json';
/**
 * The Agentic request both walks send: a bounded change to the story record.
 * Verbatim the prompt the test mentor (e2e/ai-stub.cjs) answers with one
 * boundary criterion and one out-of-scope line; a real model reads it as the
 * same small change.
 */
const STORY_PROMPT = 'Add a boundary criterion to my story saying a task due today is not overdue.';

async function newLearner(tag) {
  const reg = await registerLearner(tag);
  const enrollment = await must('POST', '/enrollments', { token: reg.token, body: { projectSlug: 'tasktrackr' } });
  return { token: reg.token, phase: enrollment.phases.find((p) => p.order === 1) };
}

async function pollSubmission(token, id, seconds = 300) {
  for (let i = 0; i < seconds * 2; i++) {
    const { data } = await call('GET', `/submissions/${id}`, { token });
    if (data.status === 'completed' || data.status === 'failed') return data;
    await sleep(500);
  }
  throw new Error(`the submission did not finish within ${seconds} s`);
}

/** The lines a proposal removed and added, against the saved file. */
function lineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const removed = a.filter((line) => !b.includes(line));
  const added = b.filter((line) => !a.includes(line));
  return { removed, added };
}

const readJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * What a learner would say about a proposal, built from the proposal itself:
 * for the story record, the criteria and out-of-scope lines it adds or drops;
 * for any other file, the lines. Two sentences are fixed rather than read
 * from the change: the story's boundary (the one the proof's prompt asks
 * for) and how the learner would check the change. Everything else is
 * computed, so a real model judges a true account of it.
 */
function explanationOf(saved, files) {
  const sentences = [];
  for (const [file, after] of Object.entries(files)) {
    const before = readJson(saved[file] ?? '');
    const next = readJson(after);
    if (file === STORY && next && Array.isArray(next.criteria) && Array.isArray(next.scopeExclusions)) {
      const said = (c) => `${c.given} / ${c.when} / ${c.then}`;
      const had = new Set((before?.criteria ?? []).map(said));
      const keeps = new Set(next.criteria.map(said));
      const added = next.criteria.filter((c) => !had.has(said(c)));
      const dropped = (before?.criteria ?? []).filter((c) => !keeps.has(said(c)));
      const scopeAdded = next.scopeExclusions.filter((line) => !(before?.scopeExclusions ?? []).includes(line));
      for (const c of added) {
        sentences.push(`The proposal adds ${c.id} to ${file}, tagged ${c.tag}: given ${c.given}, when ${c.when}, then ${c.then}.`);
      }
      if (scopeAdded.length) sentences.push(`It adds ${scopeAdded.map((line) => `"${line}"`).join(' and ')} to the out-of-scope lines.`);
      sentences.push(dropped.length ? `It drops ${dropped.length} criterion or criteria.` : 'It drops no criterion, and the story sentence, title and notes stay as they were.');
      sentences.push('A task due today is therefore not overdue, which is the boundary I asked to be written down.');
    } else {
      const { removed, added } = lineDiff(saved[file] ?? '', after);
      const shown = added.filter((l) => l.trim()).slice(0, 2).map((l) => `"${l.trim()}"`).join(' and ');
      sentences.push(`The proposal changes ${file}: it adds ${added.filter((l) => l.trim()).length} line(s)${shown ? `, ${shown}` : ''}, and removes ${removed.filter((l) => l.trim()).length}.`);
      sentences.push('Every other line stays as it was.');
    }
  }
  sentences.push('Nothing has been run, submitted or applied yet; to check it I would compare the old and new record and confirm that only those entries differ.');
  return sentences.join(' ');
}

/* The learner's calls, shared by the AI round trips and the authored-project step. */

async function registerLearner(tag) {
  return must('POST', '/auth/register', {
    body: { email: `prove-${tag}-${Date.now()}@learnsdlc.test`, password: PASSWORD, displayName: 'Local Proof' },
  });
}

async function proposeChange(token, phaseId, prompt) {
  const { data, ok, status } = await call('POST', `/phases/${phaseId}/agent/propose`, { token, body: { prompt }, ai: true });
  if (!ok) throw new Error(`propose answered HTTP ${status}: ${String(data?.message ?? '').slice(0, 200)}`);
  if (!data.assessment?.adequate) throw new Error(`the intent check asked a question instead: ${(data.assessment?.questions ?? []).join(' ').slice(0, 200)}`);
  if (!Object.keys(data.files ?? {}).length) throw new Error('the proposal holds no files');
  return data;
}

async function explainProposal(token, phaseId, proposal, explanation) {
  const { data, ok, status } = await call('POST', `/phases/${phaseId}/agent/proposals/${proposal.id}/explain`, {
    token, body: { proposalHash: proposal.proposalHash, explanation }, ai: true,
  });
  if (!ok) throw new Error(`explain answered HTTP ${status}: ${String(data?.message ?? '').slice(0, 200)}`);
  return data;
}

async function applyProposal(token, phaseId, proposal) {
  const data = await must('POST', `/phases/${phaseId}/agent/proposals/${proposal.id}/apply`, { token, body: { proposalHash: proposal.proposalHash } });
  for (const [file, bytes] of Object.entries(proposal.files)) {
    if (data.workspace?.[file] !== bytes) throw new Error(`${file} in the workspace is not the applied proposal`);
  }
  return data;
}

async function savedFiles(token, phaseId) {
  const detail = await must('GET', `/phases/${phaseId}`, { token });
  return Object.fromEntries((detail.files ?? []).map((f) => [f.path, f.content ?? '']));
}

async function submitAndPoll(token, phaseId) {
  const submission = await must('POST', `/phases/${phaseId}/submit`, { token });
  return pollSubmission(token, submission.id);
}

async function aiRoundTrips() {
  const results = {};
  const learner = await newLearner('ai');
  const { token, phase } = learner;

  results.mentor = await step('AI: the mentor answers a question (guided draft and review)', async () => {
    // A question nobody has asked this API before, so no cached reply answers it.
    const question = `What makes an acceptance criterion testable? I am checking draft ${Date.now() % 100000}.`;
    const { data, ok, status } = await call('POST', '/assistant/chat', { token, body: { phaseStateId: phase.id, message: question }, ai: true });
    if (!ok) throw new Error(`the mentor answered HTTP ${status}: ${String(data?.message ?? '').slice(0, 200)}`);
    const reply = data.reply ?? {};
    if (!reply.content || reply.content.length < 20) throw new Error('the reply was empty');
    if (reply.provider === 'guardrail') throw new Error('a guardrail answered instead of the model');
    return `provider ${reply.provider ?? 'unknown'}, ${reply.content.length} characters`;
  });

  results.review = await step('AI: a rubric review comes back and the API parser accepts it', async () => {
    const { requirementsWork } = await import('./passing-work.mjs');
    await must('PUT', `/phases/${phase.id}/workspace`, { token, body: { files: requirementsWork() } });
    const started = Date.now();
    const submission = await must('POST', `/phases/${phase.id}/submit`, { token });
    const done = await pollSubmission(token, submission.id);
    aiLatencies.push(Date.now() - started);
    const review = done.report?.aiReview;
    if (done.status !== 'completed') throw new Error(`the submission ${done.status}: ${String(done.error ?? '').slice(0, 200)}`);
    if (!review) throw new Error('the report carries no AI review');
    if (review.provider === 'unavailable' || review.assessmentError) {
      throw new Error(`the review could not be completed: ${String(review.assessmentError ?? 'provider unavailable').slice(0, 200)}`);
    }
    if (OPT.stubMarker && done.passed !== true) throw new Error(`the stub should pass marked work; passed=${done.passed} score=${done.score}`);
    return `verdict ${review.verdict}, passed ${done.passed}, score ${done.score}, provider ${review.provider}`;
  });

  // A second learner for the Agentic walk: the first one's phase 1 now holds
  // submitted work, and a proposal is made against the saved workspace.
  const agent = await newLearner('agent');
  const base = `/phases/${agent.phase.id}/agent`;
  let proposal = null;
  results.propose = await step('AI: Agentic propose (intent check, then the proposed files)', async () => {
    proposal = await proposeChange(agent.token, agent.phase.id, STORY_PROMPT);
    const paths = Object.keys(proposal.files);
    if (!paths.includes(STORY)) throw new Error(`the proposal does not change ${STORY}: ${paths.join(', ')}`);
    return `${paths.length} file(s): ${paths.join(', ')}`;
  });

  results.explain = await step('AI: the explanation gate assesses the learner\'s explanation', async () => {
    if (!proposal) throw new Error('no proposal to explain');
    const explanation = explanationOf(await savedFiles(agent.token, agent.phase.id), proposal.files);
    if (OPT.stubMarker) {
      // The stub's own rule, proved first: an unmarked answer leaves Apply shut.
      const refused = await explainProposal(agent.token, agent.phase.id, proposal, explanation);
      if (refused.approvedAt) throw new Error('the stub approved an unmarked explanation');
      const shut = await call('POST', `${base}/proposals/${proposal.id}/apply`, { token: agent.token, body: { proposalHash: proposal.proposalHash } });
      if (shut.ok) throw new Error('Apply went through before the explanation was accepted');
    }
    const data = await explainProposal(agent.token, agent.phase.id, proposal, MARK(explanation));
    proposal = data;
    if (!data.approvedAt) {
      throw new Error(`the model did not accept a correct explanation: ${String(data.explanationAssessment?.feedback ?? '').slice(0, 200)}`);
    }
    return 'accepted on every dimension';
  });

  results.apply = await step('Agentic apply writes the reviewed bytes to the workspace', async () => {
    if (!proposal?.approvedAt) throw new Error('nothing approved to apply');
    await applyProposal(agent.token, agent.phase.id, proposal);
    return `${Object.keys(proposal.files).length} file(s) saved`;
  });
  return Object.values(results).every(Boolean);
}

/* ------------------------------------------------------------- the full proof */

// One function per step of the full proof, in the order full() runs them.
// Each step's name is its key in the receipt, so the names never change.

async function proveHealth() {
  await step('Health: the API is ready and the web app answers', async () => {
    const ready = await fetch(`${API}/health/ready`);
    if (!ready.ok) throw new Error(`/health/ready answered ${ready.status}`);
    const health = await (await fetch(`${API}/health`)).json().catch(() => ({}));
    const login = await fetch(`${OPT.web}/login`);
    if (!login.ok) throw new Error(`${OPT.web}/login answered ${login.status}`);
    if (!health.aiProvider || health.aiProvider === 'unavailable') throw new Error('the API reports no AI provider');
    return `AI provider ${health.aiProvider}`;
  });
}

/** Signs in both staff accounts; a token stays empty when its sign-in failed, and the steps that need it fail in turn. */
async function proveSignIn(env) {
  const tokens = { instructor: '', admin: '' };
  await step('Sign-in: the generated administrator and the demo instructor', async () => {
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error('.env.verify has no administrator');
    tokens.admin = (await must('POST', '/auth/login', { body: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } })).token;
    const { email, password } = stackInstructor(env);
    const instructor = await must('POST', '/auth/login', { body: { email, password } });
    if (instructor.user?.role && instructor.user.role !== 'INSTRUCTOR') throw new Error(`the demo instructor has role ${instructor.user.role}`);
    tokens.instructor = instructor.token;
    return 'both sign in';
  });
  return tokens;
}

/** Only against the test mentor (--stub-marker): its own counts show every Agentic call reached it. */
async function proveStubCounts() {
  if (OPT.stubMarker) {
    await step('AI: every Agentic call reached the stub container', async () => {
      const [cmd, args] = stack('exec', '-T', 'ai-stub', 'node', '-e',
        "fetch('http://127.0.0.1:4199/__stub/counts').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.counts)))");
      const { code, out } = await quiet(cmd, args);
      if (code !== 0) throw new Error('could not read the stub counts');
      const counts = JSON.parse(out.trim().split('\n').pop());
      for (const kind of ['agentic.classify', 'agentic.generate', 'agentic.explanation', 'grading.review', 'guided.draft']) {
        if (!(counts[kind] >= 1)) throw new Error(`the stub saw no ${kind} call`);
      }
      return Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
    });
  }
}

async function proveJourney(env) {
  await step('Journey: six phases, Run and Submit through the runner, live preview (scripts/journey.mjs)', async () => {
    const { code, tail } = await runLogged(process.execPath, ['scripts/journey.mjs'], {
      log: path.join(OPT.logs, 'journey.log'),
      env: {
        API_URL: API,
        JOURNEY_REQUIRE_PREVIEW: 'true',
        E2E_AI_STUB: OPT.stubMarker ? 'true' : '',
        ADMIN_EMAIL: env.ADMIN_EMAIL ?? '',
        ADMIN_PASSWORD: env.ADMIN_PASSWORD ?? '',
      },
    });
    const tally = /(\d+)\/(\d+) checks passed/.exec(tail);
    if (code !== 0) throw new Error(`the journey exited ${code}${tally ? ` (${tally[0]})` : ''}; see journey.log`);
    return tally ? tally[0] : 'passed';
  });
}

async function proveRunnerEvidence() {
  await step('Runner: learner code executed inside the runner container', async () => {
    const [cmd, args] = stack('logs', '--no-color', 'runner');
    const { code, out } = await quiet(cmd, args);
    if (code !== 0) throw new Error('could not read the runner log');
    const executed = (out.match(/POST \/execute/g) ?? []).length;
    const previews = (out.match(/POST \/app\/start/g) ?? []).length;
    if (executed < 1) throw new Error('the runner log shows no POST /execute');
    if (previews < 1) throw new Error('the runner log shows no POST /app/start');
    return `${executed} job(s) executed, ${previews} preview(s) started`;
  });
}

async function proveShelfUpload(instructorToken) {
  await step('Teacher: upload the Shelf pack and run deep validation', async () => {
    const archive = zipPackDirectory(path.join(ROOT, 'apps/api/test/fixtures/upload-packs/shelf'));
    const made = await must('POST', '/instructor/projects/upload', {
      token: instructorToken, body: { title: `Shelf (local proof ${Date.now()})`, archiveBase64: archive.toString('base64') },
    });
    if (!made.projectId || !made.versionId) throw new Error('the upload answered without a project');
    const at = `/instructor/projects/${made.projectId}/versions/${made.versionId}/deep-validation`;
    const view = await must('GET', at, { token: instructorToken });
    await must('POST', at, { token: instructorToken, body: { acknowledgedMicroVMs: view.costWarning?.microVMs ?? 0 } });
    let deep = view;
    for (let i = 0; i < 300; i++) {
      await sleep(2000);
      deep = await must('GET', at, { token: instructorToken });
      if (deep.status === 'passed' || deep.status === 'failed') break;
    }
    const failed = (deep.checks ?? []).filter((c) => c.status === 'failed').map((c) => c.id);
    if (deep.status !== 'passed') throw new Error(`deep validation ${deep.status}${failed.length ? `: ${failed.join(', ')}` : ''}`);
    const fast = made.validation ? `fast checks ${made.validation.passed} passed, ${made.validation.failed} failed; ` : '';
    return `${fast}deep validation passed (${(deep.checks ?? []).filter((c) => c.status === 'passed').length} checks, ${view.costWarning?.microVMs ?? 0} runner jobs)`;
  });
}

async function proveAuthoredRequirements(instructorToken) {
  await step('Teacher authors Requirements and a learner passes it', async () => {
    // The teacher's half (scripts/author-requirements.mjs): a TaskTrackr copy
    // whose Requirements task carries the teacher's story block and rubric,
    // published and given to a new class.
    const made = await authorRequirements({ api: API, token: instructorToken, title: `Proof ${Date.now()}` });
    // The learner's half, on that class's project: the story record, an
    // Agentic boundary criterion explained and applied, then the review.
    const learner = await registerLearner('authored');
    await must('POST', '/enrollments/join', { token: learner.token, body: { code: made.joinCode } });
    const board = await must('POST', '/enrollments', { token: learner.token, body: {} });
    if (board.projectIsDefault !== false) throw new Error('the learner was enrolled on the platform project, not the class copy');
    const phase = board.phases.find((p) => p.order === 1);
    // What only the teacher's authoring set reached the learner's phase: its
    // provided stories (not TaskTrackr's own) and its rubric weights.
    const detail = await must('GET', `/phases/${phase.id}`, { token: learner.token });
    const provided = (detail.story?.providedStories ?? []).map((one) => one.id);
    if (provided.join(',') !== AUTHORED_PROVIDED_IDS.join(',')) {
      throw new Error(`the learner's phase provides ${provided.join(', ') || 'no stories'}, not the authored ${AUTHORED_PROVIDED_IDS.join(', ')}`);
    }
    const weights = (detail.rubric?.criteria ?? []).map((one) => one.weight);
    if (weights.join(',') !== AUTHORED_WEIGHTS.join(',')) {
      throw new Error(`the learner's rubric weighs ${weights.join(', ') || 'nothing'}, not the authored ${AUTHORED_WEIGHTS.join(', ')}`);
    }
    const { requirementsWork } = await import('./passing-work.mjs');
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: requirementsWork() } });
    const before = await savedFiles(learner.token, phase.id);
    const proposal = await proposeChange(learner.token, phase.id, STORY_PROMPT);
    const explained = await explainProposal(learner.token, phase.id, proposal, MARK(explanationOf(before, proposal.files)));
    if (!explained.approvedAt) throw new Error(`the explanation was not accepted: ${String(explained.explanationAssessment?.feedback ?? '').slice(0, 200)}`);
    await applyProposal(learner.token, phase.id, explained);
    const record = JSON.parse((await savedFiles(learner.token, phase.id))[STORY] ?? '{}');
    const added = (record.criteria?.length ?? 0) - (JSON.parse(before[STORY] ?? '{}').criteria?.length ?? 0);
    const sub = await submitAndPoll(learner.token, phase.id);
    if (sub.status !== 'completed') throw new Error(`the submission ${sub.status}: ${String(sub.error ?? '').slice(0, 200)}`);
    if (!sub.passed) throw new Error(`learner did not pass: ${JSON.stringify(sub.report?.checks ?? sub.report ?? {}).slice(0, 400)}`);
    return `the authored copy published and assigned, the learner's phase providing ${provided.join(', ')} and weighing ${weights.join(', ')}; the learner applied ${Object.keys(explained.files).length} file(s) (${added} criterion added, ${record.criteria?.length ?? 0} in all) and passed with score ${sub.score}`;
  });
}

async function proveAuthoredDesign(instructorToken) {
  await step('Teacher authors Design and a learner passes it', async () => {
    // The teacher's half (scripts/author-design.mjs): a TaskTrackr copy whose
    // Design task carries the teacher's switches (both contracts and the
    // sequence diagram on), stories, floor, rubric and starting point,
    // published and given to a new class.
    const made = await authorDesign({ api: API, token: instructorToken, title: `Proof design ${Date.now()}` });
    const learner = await registerLearner('authored-design');
    await must('POST', '/enrollments/join', { token: learner.token, body: { code: made.joinCode } });
    const board = await must('POST', '/enrollments', { token: learner.token, body: {} });
    if (board.projectIsDefault !== false) throw new Error('the learner was enrolled on the platform project, not the class copy');
    // Requirements first, as any learner reaches Design: the story record,
    // the review, the reflection and the advance.
    const { requirementsWork, designWork } = await import('./passing-work.mjs');
    const req = board.phases.find((p) => p.order === 1);
    await must('PUT', `/phases/${req.id}/workspace`, { token: learner.token, body: { files: requirementsWork() } });
    const passedReq = await submitAndPoll(learner.token, req.id);
    if (!passedReq.passed) throw new Error('the learner did not pass Requirements on the way to Design');
    await must('POST', `/phases/${req.id}/reflect`, { token: learner.token, body: { reflection: 'Requirements done: the floor and the review agreed on what my story still lacked.' } });
    const advanced = await must('POST', `/phases/${req.id}/advance`, { token: learner.token });
    const phase = (advanced.phases ?? board.phases).find((p) => p.order === 2);
    // What only the teacher's authoring set reached the learner's Design: its
    // stories, its switches, its rubric weights and its starting point.
    const detail = await must('GET', `/phases/${phase.id}`, { token: learner.token });
    const stories = (detail.design?.stories ?? []).map((one) => one.id);
    if (stories.join(',') !== AUTHORED_DESIGN_STORIES.join(',')) {
      throw new Error(`the learner's Design lists ${stories.join(', ') || 'no stories'}, not the authored ${AUTHORED_DESIGN_STORIES.join(', ')}`);
    }
    if (detail.design?.contracts?.api !== true || detail.design?.contracts?.screens !== true) throw new Error("the learner's Design does not carry both contracts the teacher switched on");
    if (detail.design?.sequence !== true) throw new Error("the learner's Design does not carry the sequence diagram the teacher switched on");
    // TaskTrackr has both contracts and the sequence diagram on too; its floor's
    // counts differ from the authored one's, so the floor is what proves the authoring arrived.
    const floor = detail.design?.floor ?? {};
    const off = Object.keys(AUTHORED_DESIGN_FLOOR).filter((key) => floor[key] !== AUTHORED_DESIGN_FLOOR[key]);
    if (off.length) throw new Error(`the learner's Design floor is not the authored one: ${off.join(', ')} differ`);
    const weights = (detail.rubric?.criteria ?? []).map((one) => one.weight);
    if (weights.join(',') !== AUTHORED_DESIGN_WEIGHTS.join(',')) {
      throw new Error(`the learner's Design weighs ${weights.join(', ') || 'nothing'}, not the authored ${AUTHORED_DESIGN_WEIGHTS.join(', ')}`);
    }
    const start = readJson((detail.files ?? []).find((f) => f.path === 'design/design.json')?.content ?? '') ?? {};
    const startNames = (start.entities ?? []).map((one) => one.name).join(',');
    if (startNames !== AUTHORED_DESIGN_START.entities.map((one) => one.name).join(',') || (start.operations ?? []).length !== AUTHORED_DESIGN_START.operations.length) {
      throw new Error("the learner's Design does not open on the starting point the teacher authored");
    }
    // The learner's half: the forms' writes (the record and both contracts),
    // one Agentic change explained and applied, then the floor and the review.
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: designWork() } });
    const before = await savedFiles(learner.token, phase.id);
    const proposal = await proposeChange(learner.token, phase.id, 'Add an operation for the overdue report and fill the overdue screen.');
    if (!(proposal.changes?.length > 0)) throw new Error('the design proposal carried no field changes');
    const explained = await explainProposal(learner.token, phase.id, proposal, MARK(explanationOf(before, proposal.files)));
    if (!explained.approvedAt) throw new Error(`the explanation was not accepted: ${String(explained.explanationAssessment?.feedback ?? '').slice(0, 200)}`);
    await applyProposal(learner.token, phase.id, explained);
    const sub = await submitAndPoll(learner.token, phase.id);
    if (sub.status !== 'completed') throw new Error(`the submission ${sub.status}: ${String(sub.error ?? '').slice(0, 200)}`);
    const rows = (sub.report?.checks ?? []).filter((c) => String(c.id).startsWith('design.'));
    const failed = rows.filter((c) => c.status !== 'passed').map((c) => c.id);
    if (!sub.passed) throw new Error(`learner did not pass Design${failed.length ? `: ${failed.join(', ')} failed` : ''}`);
    // Both contracts and the sequence diagram are on, so every floor row is graded, the sequence rule among them.
    const graded = rows.map((c) => c.id);
    if (graded.join(',') !== DESIGN_FLOOR_IDS.join(',')) {
      const missing = DESIGN_FLOOR_IDS.filter((id) => !graded.includes(id));
      throw new Error(`the graded report's floor rows are not the full floor${missing.length ? `: ${missing.join(', ')} missing` : ''}`);
    }
    if (failed.length) throw new Error(`the Design passed with floor rows failing: ${failed.join(', ')}`);
    return `the authored copy published and assigned, the learner's Design listing ${stories.join(', ')}, both contracts and the sequence diagram on, weighing ${weights.join(', ')} under the authored floor and opening on the authored starting point; the learner applied ${proposal.changes.length} field change(s) over ${Object.keys(explained.files).length} document(s) and passed with score ${sub.score}, ${rows.length} of ${DESIGN_FLOOR_IDS.length} floor rows graded and passed, the sequence rule among them`;
  });
}

/**
 * An authored Deployment or Maintenance is reached the way any learner
 * reaches it, through the phases before it with the passing work (the stack
 * has a runner, so the code phases run and grade, and Deployment's drill is
 * closed through the API). Returns the learner's phase list after the last
 * advance.
 */
async function passToPhase(learner, phases, upTo) {
  const { requirementsWork, designWork, codeWork, deploymentWork, closeDrill } = await import('./passing-work.mjs');
  const FX = await import('./golden-artefacts.mjs');
  const work = { 1: requirementsWork(), 2: designWork(), 3: codeWork(FX.IMPLEMENTATION_ARTEFACT), 4: codeWork(FX.TESTING_ARTEFACT), 5: deploymentWork(FX.DEPLOYMENT_ARTEFACT) };
  let list = phases;
  for (let order = 1; order < upTo; order++) {
    const phase = list.find((p) => p.order === order);
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: work[order] } });
    if (order >= 3) await runAndWait(learner.token, phase.id);
    if (order === 5) await closeDrill((method, route, body) => must(method, route, { token: learner.token, body }), phase.id);
    const sub = await submitAndPoll(learner.token, phase.id);
    if (!sub.passed) throw new Error(`the learner did not pass phase ${order} on the way to phase ${upTo}: ${String(sub.error ?? '').slice(0, 200)}`);
    await must('POST', `/phases/${phase.id}/reflect`, { token: learner.token, body: { reflection: `Phase ${order} done on the way to the authored phase.` } });
    list = (await must('POST', `/phases/${phase.id}/advance`, { token: learner.token })).phases ?? list;
  }
  return list;
}

/** One run of a phase through the runner, waited on for at most four minutes; a failed run throws with its error. */
async function runAndWait(token, phaseId) {
  const job = await must('POST', `/phases/${phaseId}/run`, { token });
  for (let i = 0; i < 240; i++) {
    const run = await must('GET', `/runs/${job.id}`, { token });
    if (run.status === 'completed') return run;
    if (run.status === 'failed') throw new Error(`the run failed: ${String(run.result?.stderr ?? run.error ?? '').slice(0, 200)}`);
    await sleep(1_000);
  }
  throw new Error('the run did not finish in four minutes');
}

async function proveAuthoredDeployment(instructorToken) {
  await step('Teacher authors Deployment and a learner passes it', async () => {
    // The teacher's half (scripts/author-deployment.mjs): a TaskTrackr copy
    // whose Deployment task carries the teacher's runbook floor and starting
    // runbook, published and given to a new class.
    const made = await authorDeployment({ api: API, token: instructorToken, title: `Proof deployment ${Date.now()}` });
    const learner = await registerLearner('authored-deployment');
    await must('POST', '/enrollments/join', { token: learner.token, body: { code: made.joinCode } });
    const board = await must('POST', '/enrollments', { token: learner.token, body: {} });
    if (board.projectIsDefault !== false) throw new Error('the learner was enrolled on the platform project, not the class copy');
    const phases = await passToPhase(learner, board.phases, 5);
    const phase = phases.find((p) => p.order === 5);
    // What only the teacher's authoring set reached the learner's Deployment: its floor and its starting runbook.
    const detail = await must('GET', `/phases/${phase.id}`, { token: learner.token });
    const floor = detail.runbook?.floor ?? {};
    const off = Object.keys(AUTHORED_RUNBOOK_FLOOR).filter((key) => floor[key] !== AUTHORED_RUNBOOK_FLOOR[key]);
    if (off.length) throw new Error(`the learner's runbook floor is not the authored one: ${off.join(', ')} differ`);
    const start = readJson((detail.files ?? []).find((f) => f.path === 'deployment/runbook.json')?.content ?? '') ?? {};
    if ((start.environment ?? []).map((e) => e.name).join(',') !== 'TASKTRACKR_DB,API_URL') throw new Error("the learner's Deployment does not open on the starting runbook the teacher authored");
    // The learner's half: the config files and the runbook the forms write, one
    // Agentic change explained and applied, a run, the drill closed into the
    // record, then the floor and the review.
    const { deploymentWork, closeDrill } = await import('./passing-work.mjs');
    const FX = await import('./golden-artefacts.mjs');
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: deploymentWork(FX.DEPLOYMENT_ARTEFACT) } });
    const before = await savedFiles(learner.token, phase.id);
    const proposal = await proposeChange(learner.token, phase.id, 'Add a data entry that says where the database file lives.');
    if (!(proposal.changes?.length > 0)) throw new Error('the runbook proposal carried no field changes');
    const explained = await explainProposal(learner.token, phase.id, proposal, MARK(explanationOf(before, proposal.files)));
    if (!explained.approvedAt) throw new Error(`the explanation was not accepted: ${String(explained.explanationAssessment?.feedback ?? '').slice(0, 200)}`);
    await applyProposal(learner.token, phase.id, explained);
    await runAndWait(learner.token, phase.id);
    await closeDrill((method, route, body) => must(method, route, { token: learner.token, body }), phase.id);
    const record = readJson((await savedFiles(learner.token, phase.id))['deployment/runbook.json'] ?? '') ?? {};
    if (!record.incident?.rootCause || (record.incident.timeline ?? []).length !== 3) throw new Error("closing the drill did not write the runbook's incident and its three timeline lines");
    const sub = await submitAndPoll(learner.token, phase.id);
    if (sub.status !== 'completed') throw new Error(`the submission ${sub.status}: ${String(sub.error ?? '').slice(0, 200)}`);
    const rows = (sub.report?.checks ?? []).filter((c) => String(c.id).startsWith('runbook.'));
    const failed = rows.filter((c) => c.status !== 'passed').map((c) => c.id);
    if (!sub.passed) throw new Error(`learner did not pass Deployment${failed.length ? `: ${failed.join(', ')} failed` : ''}`);
    // Every runbook floor row is graded, the incident rule among them (the floor requires it), and every one passed.
    if (rows.map((c) => c.id).join(',') !== RUNBOOK_FLOOR_IDS.join(',') || failed.length) {
      throw new Error(`the graded report's runbook rows are not the ${RUNBOOK_FLOOR_IDS.length} of the floor, all passed: ${rows.map((c) => `${c.id} ${c.status}`).join(', ')}`);
    }
    return `the authored copy published and assigned, the learner's Deployment under the authored floor and opening on the authored starting runbook; the learner applied ${proposal.changes.length} field change(s), closed the drill into the record and passed with score ${sub.score}, all ${RUNBOOK_FLOOR_IDS.length} runbook rows graded and passed`;
  });
}

async function proveAuthoredMaintenance(instructorToken) {
  await step('Teacher authors Maintenance and a learner passes it', async () => {
    // The teacher's half (scripts/author-maintenance.mjs): a TaskTrackr copy
    // whose Maintenance task carries the teacher's CR-2 ticket (AC-6 reworded)
    // and change floor, published and given to a new class.
    const made = await authorMaintenance({ api: API, token: instructorToken, title: `Proof maintenance ${Date.now()}` });
    const learner = await registerLearner('authored-maintenance');
    await must('POST', '/enrollments/join', { token: learner.token, body: { code: made.joinCode } });
    const board = await must('POST', '/enrollments', { token: learner.token, body: {} });
    if (board.projectIsDefault !== false) throw new Error('the learner was enrolled on the platform project, not the class copy');
    const phases = await passToPhase(learner, board.phases, 6);
    const phase = phases.find((p) => p.order === 6);
    // What only the teacher's authoring set reached the learner's Maintenance: the reworded AC-6 and the floor.
    const detail = await must('GET', `/phases/${phase.id}`, { token: learner.token });
    if (detail.change?.ticket?.acceptance?.[5]?.line !== AUTHORED_TICKET.acceptance[5].line) throw new Error("the learner's ticket is not the one the teacher authored");
    const floor = detail.change?.floor ?? {};
    const off = Object.keys(AUTHORED_CHANGE_FLOOR).filter((key) => floor[key] !== AUTHORED_CHANGE_FLOOR[key]);
    if (off.length) throw new Error(`the learner's change floor is not the authored one: ${off.join(', ')} differ`);
    // The learner's half: the code, the contracts and the change request the
    // forms write, one Agentic change explained and applied, then the floor and
    // the review.
    const { maintenanceWork } = await import('./passing-work.mjs');
    const { 'maintenance/change-request.json': record, ...code } = maintenanceWork();
    // The release starts without its change lines, so the assistant has a section to fill.
    const parsed = JSON.parse(record);
    const partial = { ...parsed, release: { ...parsed.release, changes: [] } };
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: { ...code, 'maintenance/change-request.json': `${JSON.stringify(partial, null, 2)}\n` } } });
    const before = await savedFiles(learner.token, phase.id);
    const proposal = await proposeChange(learner.token, phase.id, 'Add the release line that covers the two comment endpoints.');
    if (!(proposal.changes?.length > 0)) throw new Error('the change proposal carried no field changes');
    const explained = await explainProposal(learner.token, phase.id, proposal, MARK(explanationOf(before, proposal.files)));
    if (!explained.approvedAt) throw new Error(`the explanation was not accepted: ${String(explained.explanationAssessment?.feedback ?? '').slice(0, 200)}`);
    await applyProposal(learner.token, phase.id, explained);
    // Then the learner's own change lines, which cover every acceptance item, in place of the assistant's one.
    await must('PUT', `/phases/${phase.id}/workspace`, { token: learner.token, body: { files: { 'maintenance/change-request.json': record } } });
    await runAndWait(learner.token, phase.id);
    const sub = await submitAndPoll(learner.token, phase.id);
    if (sub.status !== 'completed') throw new Error(`the submission ${sub.status}: ${String(sub.error ?? '').slice(0, 200)}`);
    const rows = (sub.report?.checks ?? []).filter((c) => String(c.id).startsWith('change.'));
    const failed = rows.filter((c) => c.status !== 'passed').map((c) => c.id);
    if (!sub.passed) throw new Error(`learner did not pass Maintenance${failed.length ? `: ${failed.join(', ')} failed` : ''}`);
    // The contract is on, so every change floor row is graded, the contract rule among them, and every one passed.
    const CHANGE_ROWS = changeFloorIds(true);
    if (rows.map((c) => c.id).join(',') !== CHANGE_ROWS.join(',') || failed.length) {
      throw new Error(`the graded report's change rows are not the ${CHANGE_ROWS.length} of the floor, all passed: ${rows.map((c) => `${c.id} ${c.status}`).join(', ')}`);
    }
    return `the authored copy published and assigned, the learner's ticket carrying the reworded AC-6 under the authored floor; the learner applied ${proposal.changes.length} field change(s), then saved the worked change request in its place, and passed with score ${sub.score}, all ${CHANGE_ROWS.length} change rows graded and passed`;
  });
}

async function proveSubsetStep(adminToken) {
  await step('Teacher uploads a three-phase project and a learner finishes it', async () => {
    // scripts/author-subset.mjs: a fresh teacher uploads shelf-three (Shelf's
    // Requirements, Design and Implementation in the folder layout), validates,
    // publishes and assigns it, the assignable list naming the three phases; a
    // fresh learner reads each as phase n of 3, passes all three (the stack has
    // a runner, so Implementation runs and grades), and the completion record
    // reads three phases passed and the project completed.
    if (!adminToken) throw new Error('no administrator signed in to make the teacher');
    return proveSubset({ api: API, adminToken, title: `Shelf in three phases (local proof ${Date.now()})` });
  });
}

async function proveRoundTripStep(adminToken) {
  await step('Teacher exports a project and uploads it again, and the versions match', async () => {
    // scripts/export-roundtrip.mjs: a fresh teacher uploads Shelf (owned whole),
    // adds a concept quiz, rewords and reweighs Implementation's Criteria,
    // publishes and exports it; the archive is in the folder layout and
    // uploads again with no warning; once both are published, their task
    // lists read through the editor's routes are the same.
    if (!adminToken) throw new Error('no administrator signed in to make the teacher');
    return proveRoundTrip({ api: API, adminToken, title: `Shelf round trip (local proof ${Date.now()})` });
  });
}

async function proveDurability() {
  if (OPT.skipDurability) {
    steps.push({ name: 'Durable queue survives an API kill', ok: true, skipped: true, ms: 0, detail: 'skipped (--skip-durability)' });
  } else {
    await step('Durable queue: a grading job survives the API being killed (about 10 minutes)', async () => {
      const kill = `bash ${JSON.stringify(path.join(ROOT, 'scripts/stack.sh'))} compose kill -s SIGKILL api`;
      const start = `bash ${JSON.stringify(path.join(ROOT, 'scripts/stack.sh'))} compose up -d --no-deps --wait api`;
      const { code, tail } = await runLogged(process.execPath, ['scripts/durability-check.mjs'], {
        log: path.join(OPT.logs, 'durability.log'),
        env: {
          API_URL: API,
          E2E_AI_STUB: OPT.stubMarker ? 'true' : '',
          DURABILITY_QUEUE: 'durable',
          DURABILITY_KILL_CMD: kill,
          DURABILITY_START_CMD: start,
        },
      });
      const tally = /(\d+)\/(\d+) durability checks passed/.exec(tail);
      if (code !== 0) throw new Error(`the durability check exited ${code}${tally ? ` (${tally[0]})` : ''}; see durability.log`);
      return tally ? tally[0] : 'passed';
    });
  }
}

async function full() {
  const env = readEnvVerify();
  await proveHealth();
  const tokens = await proveSignIn(env);
  await aiRoundTrips();
  await proveStubCounts();
  await proveJourney(env);
  await proveRunnerEvidence();
  await proveShelfUpload(tokens.instructor);
  await proveAuthoredRequirements(tokens.instructor);
  await proveAuthoredDesign(tokens.instructor);
  await proveAuthoredDeployment(tokens.instructor);
  await proveAuthoredMaintenance(tokens.instructor);
  await proveSubsetStep(tokens.admin);
  await proveRoundTripStep(tokens.admin);
  await proveDurability();
}

/* ------------------------------------------------------------------- the end */

async function main() {
  const startedAt = new Date().toISOString();
  if (OPT.mode === 'full') await full();
  else await aiRoundTrips();
  const ok = steps.every((s) => s.ok);
  const p95 = percentile(aiLatencies, 95);
  const receipt = {
    kind: 'learnsdlc-local-proof',
    mode: OPT.mode,
    label: OPT.label || null,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    aiLatency: { calls: aiLatencies.length, p50Ms: percentile(aiLatencies, 50), p95Ms: p95, maxMs: aiLatencies.length ? Math.max(...aiLatencies) : null },
    steps,
  };
  fs.writeFileSync(OPT.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log('\n==> Summary');
  for (const s of steps) {
    const mark = s.skipped ? 'skip' : s.ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${mark}  ${s.name}  ${(s.ms / 1000).toFixed(1)} s`);
  }
  if (aiLatencies.length) {
    console.log(`  AI latency over ${aiLatencies.length} model-backed calls: p95 ${(p95 / 1000).toFixed(1)} s, max ${(receipt.aiLatency.maxMs / 1000).toFixed(1)} s`);
  }
  console.log(`  ${ok ? '\x1b[32mEvery check passed.\x1b[0m' : '\x1b[31mAt least one check failed.\x1b[0m'} Receipt: ${path.relative(ROOT, OPT.receipt)}`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

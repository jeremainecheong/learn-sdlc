#!/usr/bin/env node
// A teacher's three-phase project, taught from end to end through the API: a
// fresh teacher account uploads `shelf-three` (Shelf's Requirements, Design
// and Implementation in the folder layout, apps/api/test/fixtures/upload-packs/
// shelf-three), runs deep validation, publishes, opens a class and gives the
// class that version; a fresh learner joins, passes Requirements and Design,
// runs and passes Implementation, advances, and the completion record reads
// three phases passed and the project completed.
//
//   ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/author-subset.mjs [--api http://localhost:4080/api/v1] [--title "Shelf, three phases"]
//
// The administrator makes the teacher (a registered account promoted to
// INSTRUCTOR), so the project is the teacher's own, owned whole. Prints one
// line saying what was proved. scripts/prove-local.mjs imports `proveSubset`
// for the proof's "Teacher uploads a three-phase project and a learner
// finishes it" step, with the administrator token it already holds.
//
// The archive is built when the step runs, from the fixture folder, with the
// writer the proof's Shelf upload uses (scripts/pack-archive.mjs). The
// learner's work is Shelf's own: its story SH-5 and its design (the shapes
// e2e/upload-helpers.ts writes for the browser journey, which meet Shelf's
// floors), and Implementation's reference solution read from the fixture's
// `solution/` folder, with `add()`'s year check moved into a helper as the
// shipped starter has it (the inline check is over the grader's complexity
// limit, which the strict gate refuses). Each is marked for the test mentor as
// scripts/passing-work.mjs marks work when E2E_AI_STUB=true.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { call, runWhenMain } from './author-common.mjs';
import { sleep as realSleep } from './lib/api-client.mjs';
import { zipPackDirectory } from './pack-archive.mjs';
import { withYearHelper } from '../e2e/shelf-year-helper.mjs';

export { withYearHelper };

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The tracked fixture folder that holds Shelf's first three phases, in the folder layout. */
export const SHELF_THREE_DIR = path.join(ROOT, 'apps/api/test/fixtures/upload-packs/shelf-three');

/** The phases the three-phase project holds, in place order. */
export const SUBSET_PHASES = Object.freeze(['requirements', 'design', 'implementation']);

/** Why the proof cannot build the archive from `dir` (its fixture is missing), or null when it can. */
export function missingSubsetFixture(dir = SHELF_THREE_DIR) {
  return fs.existsSync(path.join(dir, 'project.json'))
    ? null
    : `${path.relative(ROOT, dir)} is not in this checkout`;
}

/** The three-phase project as the archive a teacher uploads (pack root at the archive root). */
export function subsetArchive(dir = SHELF_THREE_DIR) {
  const missing = missingSubsetFixture(dir);
  if (missing) throw new Error(missing);
  return zipPackDirectory(dir);
}

/** A pack's phase folders under `phases/`, in name order, each with the key its name gives (`03-implementation` is `implementation`). */
export function phaseFoldersOf(dir) {
  const at = path.join(dir, 'phases');
  return fs
    .readdirSync(at, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((folder) => ({ folder, key: folder.replace(/^\d+-/, '') }));
}

/**
 * A code phase's reference solution as learner work: every file under the
 * phase folder's `solution/`, keyed by its workspace path. The folder is the
 * same in both archive layouts (the older one names it in `checks.solutionDir`).
 */
export function solutionWork(dir, key = 'implementation') {
  const phase = phaseFoldersOf(dir).find((one) => one.key === key);
  if (!phase) throw new Error(`${path.relative(ROOT, dir)} has no ${key} phase`);
  const base = path.join(dir, 'phases', phase.folder, 'solution');
  if (!fs.existsSync(base)) throw new Error(`${path.relative(ROOT, dir)}'s ${key} phase holds no solution folder`);
  const out = {};
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(base, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(child);
      else if (entry.name !== '.DS_Store') out[child] = fs.readFileSync(path.join(base, child), 'utf8');
    }
  };
  visit('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The learner's Implementation work: the fixture's reference solution, with `api/shelf.py`'s year check in its helper (`withYearHelper`). */
export function implementationWork(dir) {
  const work = solutionWork(dir);
  if (work['api/shelf.py'] !== undefined) work['api/shelf.py'] = withYearHelper(work['api/shelf.py']);
  return work;
}

/** The test mentor's pass mark when the API under test talks to it (E2E_AI_STUB=true), else null: the work goes in as written. */
function stubMarker() {
  return process.env.E2E_AI_STUB === 'true' ? require('../e2e/ai-stub.cjs').MARKER : null;
}

/**
 * Requirements: SH-5, the story Shelf's learner writes (its
 * `checks.learnerStory.id`), as the record `requirements/story.json` alone: a
 * full sentence, a happy path and a boundary, and one out-of-scope line.
 * `marker` goes in the notes, where nothing grades by shape.
 */
export function shelfStoryWork(marker = stubMarker()) {
  const { STORY_JSON, serialiseStory } = require('@learnsdlc/shared');
  const story = {
    id: 'SH-5',
    title: 'See which books by an author are free to borrow',
    persona: 'member',
    capability: "to see which of an author's books are free to borrow right now",
    benefit: 'I can plan my visit without a wasted trip',
    criteria: [
      { id: 'AC-1', tag: 'happy', given: 'an author with two books on the shelf', when: 'I filter the shelf by that author', then: 'I see both books marked free to borrow' },
      { id: 'AC-2', tag: 'boundary', given: 'a book that is already on loan', when: 'I filter the shelf by its author', then: 'that book shows as on loan and cannot be borrowed' },
    ],
    scopeExclusions: ['holding a book for a member while it is lent out'],
    notes: `Heard from the head librarian at the lending desk.${marker ? ` ${marker}` : ''}`,
  };
  return { [STORY_JSON]: serialiseStory(story) };
}

/**
 * Design: the record and the API contract, which meet Shelf's floor (one
 * entity, three operations each with its inputs, a return and its story, one
 * decision with a rationale and a trade-off, four endpoints and an error
 * catalogue). `marker` goes in the record's notes.
 */
export function shelfDesignWork(marker = stubMarker()) {
  const { API_CONTRACT_JSON, DESIGN_JSON, EMPTY_DESIGN, serialiseDesign } = require('@learnsdlc/shared');
  const record = serialiseDesign({
    ...EMPTY_DESIGN,
    entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: ['knows who has it on loan'], satisfies: ['SH-1'] }],
    operations: [
      { id: 'O1', name: 'listBooks', inputs: ['author'], returns: 'every book, in shelf order', errors: [], satisfies: ['SH-1'] },
      { id: 'O2', name: 'lendBook', inputs: ['id', 'borrower'], returns: 'the book with its borrower', errors: ['book_not_found', 'cannot_lend'], satisfies: ['SH-2'] },
      { id: 'O3', name: 'returnBook', inputs: ['id'], returns: 'the book, back on the shelf', errors: ['book_not_found', 'not_on_loan'], satisfies: ['SH-3'] },
    ],
    decisions: [{
      id: 'D1', title: 'Keep the shelf in memory', choice: 'an in-memory shelf', alternative: 'a database',
      rationale: 'The shelf is small and the tests need a fresh one each time.', tradeOff: 'The books are gone when the process stops.',
      status: 'accepted', satisfies: ['SH-1'],
    }],
    notes: `The shelf is one entity and three operations, one per story.${marker ? ` ${marker}` : ''}`,
  });
  const contract = `${JSON.stringify({
    operations: [
      { id: 'listBooks', method: 'GET', path: '/api/books', summary: 'Every book, in shelf order, optionally filtered by author.', satisfies: 'SH-1', errors: [] },
      { id: 'addBook', method: 'POST', path: '/api/books', summary: 'Adds a book and answers it with its new id.', errors: [] },
      { id: 'lendBook', method: 'POST', path: '/api/books/{id}/lend', summary: 'Lends a book to the named borrower.', satisfies: 'SH-2', errors: ['book_not_found', 'cannot_lend'] },
      { id: 'returnBook', method: 'POST', path: '/api/books/{id}/return', summary: 'Puts a lent book back on the shelf.', satisfies: 'SH-3', errors: ['book_not_found', 'not_on_loan'] },
    ],
    errors: {
      book_not_found: { status: 404, meaning: 'No book has the id.' },
      cannot_lend: { status: 409, meaning: 'The book is already on loan, or the borrower is blank.' },
      not_on_loan: { status: 409, meaning: 'A book that is on the shelf was returned.' },
    },
  }, null, 2)}\n`;
  return { [DESIGN_JSON]: record, [API_CONTRACT_JSON]: contract };
}

const PASSWORD = 'Password1!';

/** A unique address for a fresh account, on the domain the proof's own accounts use. */
const freshEmail = (tag) => `prove-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@learnsdlc.test`;

/** A fresh learner account: `{ token }`. */
export async function freshLearner({ api, tag }) {
  const made = await call(api, '', 'POST', '/auth/register', { email: freshEmail(tag), password: PASSWORD, displayName: 'Local Proof Learner' });
  if (!made.token) throw new Error('the learner registration answered without a token');
  return { token: made.token };
}

/**
 * A fresh teacher account: registered, promoted to INSTRUCTOR by the
 * administrator, then signed in again (a role change revokes the account's
 * earlier sessions). Returns `{ token }`.
 */
export async function freshTeacher({ api, adminToken, tag }) {
  const email = freshEmail(tag);
  const made = await call(api, '', 'POST', '/auth/register', { email, password: PASSWORD, displayName: 'Local Proof Teacher' });
  const userId = made.user?.id;
  if (!userId) throw new Error('the teacher registration answered without a user');
  await call(api, adminToken, 'PATCH', `/admin/users/${userId}`, { role: 'INSTRUCTOR' });
  const signedIn = await call(api, '', 'POST', '/auth/login', { email, password: PASSWORD });
  if (signedIn.user?.role && signedIn.user.role !== 'INSTRUCTOR') throw new Error(`the promoted teacher signs in with role ${signedIn.user.role}`);
  if (!signedIn.token) throw new Error('the promoted teacher could not sign in');
  return { token: signedIn.token };
}

/** The editor's route of one version. */
export const versionRoute = (projectId, versionId) => `/instructor/projects/${projectId}/versions/${versionId}`;

/**
 * Deep validation of one draft, started and waited on (a check a minute at
 * most, ten minutes in all): the publish of an uploaded project asks for a
 * current pass. Returns the passed view; a failed run throws with its failed
 * check ids.
 */
export async function deepValidate({ api, token, at, sleep = realSleep, polls = 300, pollMs = 2000 }) {
  const route = `${at}/deep-validation`;
  const view = await call(api, token, 'GET', route);
  await call(api, token, 'POST', route, { acknowledgedMicroVMs: view.costWarning?.microVMs ?? 0 });
  for (let i = 0; i < polls; i++) {
    await sleep(pollMs);
    const deep = await call(api, token, 'GET', route);
    if (deep.status === 'passed') return deep;
    if (deep.status === 'failed') {
      const failed = (deep.checks ?? []).filter((c) => c.status === 'failed').map((c) => c.id);
      throw new Error(`deep validation failed${failed.length ? `: ${failed.join(', ')}` : ''}`);
    }
  }
  throw new Error('deep validation did not finish in ten minutes');
}

/**
 * Upload an archive as the teacher's own draft, then deep validation and the
 * first publish. Returns the project, its published version and the upload's
 * answer (its warnings among it).
 */
export async function uploadAndPublish({ api, token, title, archive, notes, sleep }) {
  const made = await call(api, token, 'POST', '/instructor/projects/upload', { title, archiveBase64: archive.toString('base64') });
  if (!made.projectId || !made.versionId) throw new Error('the upload answered without a project');
  const at = versionRoute(made.projectId, made.versionId);
  await deepValidate({ api, token, at, sleep });
  const published = await call(api, token, 'POST', `${at}/publish`, { version: '1.0.0', notes });
  const versionId = published.versionId ?? made.versionId;
  return { projectId: made.projectId, versionId, upload: made };
}

/** One submission, waited on for at most five minutes. */
async function submitAndWait({ api, token, phaseId, sleep }) {
  const started = await call(api, token, 'POST', `/phases/${phaseId}/submit`);
  for (let i = 0; i < 600; i++) {
    const done = await call(api, token, 'GET', `/submissions/${started.id}`);
    if (done.status === 'completed' || done.status === 'failed') return done;
    await sleep(500);
  }
  throw new Error('the submission did not finish in five minutes');
}

/** One run through the runner, waited on for at most four minutes; a failed run throws with its error. */
async function runAndWait({ api, token, phaseId, sleep }) {
  const job = await call(api, token, 'POST', `/phases/${phaseId}/run`);
  for (let i = 0; i < 240; i++) {
    const run = await call(api, token, 'GET', `/runs/${job.id}`);
    if (run.status === 'completed') return run;
    if (run.status === 'failed') throw new Error(`the run failed: ${String(run.result?.stderr ?? run.error ?? '').slice(0, 200)}`);
    await sleep(1000);
  }
  throw new Error('the run did not finish in four minutes');
}

const keysOf = (phases) => (phases ?? []).map((one) => one.key).join(', ');

/**
 * The teacher's half: upload `shelf-three`, check the draft holds the three
 * phases, deep validation, publish, a class, and the assignable list naming
 * the version's three phases before the class is given it.
 * @returns {Promise<{ projectId: string, versionId: string, joinCode: string, phaseList: string }>}
 */
export async function authorSubset({ api, token, title, dir = SHELF_THREE_DIR, sleep }) {
  const archive = subsetArchive(dir);
  const made = await call(api, token, 'POST', '/instructor/projects/upload', { title, archiveBase64: archive.toString('base64') });
  if (!made.projectId || !made.versionId) throw new Error('the upload answered without a project');
  const at = versionRoute(made.projectId, made.versionId);
  const draft = await call(api, token, 'GET', at);
  if (keysOf(draft.phases) !== SUBSET_PHASES.join(', ')) throw new Error(`the uploaded draft holds ${keysOf(draft.phases) || 'no phase'}, not ${SUBSET_PHASES.join(', ')}`);
  await deepValidate({ api, token, at, sleep });
  const published = await call(api, token, 'POST', `${at}/publish`, { version: '1.0.0', notes: 'Shelf in three phases: Requirements, Design and Implementation.' });
  const versionId = published.versionId ?? made.versionId;

  const cohort = await call(api, token, 'POST', '/instructor/cohorts', { name: `${title} class`.slice(0, 80) });
  const offered = await call(api, token, 'GET', `/instructor/cohorts/${cohort.id}/project/assignable`);
  const row = (Array.isArray(offered) ? offered : []).find((one) => one.versionId === versionId);
  if (!row) throw new Error("the class's assignable list does not offer the published version");
  if ((row.phases ?? []).join(',') !== SUBSET_PHASES.join(',')) throw new Error(`the assignable list names ${(row.phases ?? []).join(', ') || 'no phases'} for the version`);
  await call(api, token, 'PUT', `/instructor/cohorts/${cohort.id}/project`, { projectVersionId: versionId, reason: 'This class works the shelf in three phases.' });
  const { phaseListSentence } = require('@learnsdlc/shared');
  return { projectId: made.projectId, versionId, joinCode: cohort.joinCode, phaseList: phaseListSentence(row.phases) };
}

/**
 * The learner's half: join the class, then for each phase in place order
 * check its place label, save the work (Implementation runs first), submit,
 * reflect and advance; the last advance completes the project. Returns the
 * completion record (`GET /enrollments/mine`) and the scores.
 */
export async function learnerFinishes({ api, token, joinCode, work, sleep = realSleep }) {
  await call(api, token, 'POST', '/enrollments/join', { code: joinCode });
  const board = await call(api, token, 'POST', '/enrollments', {});
  if (board.projectIsDefault !== false) throw new Error('the learner was enrolled on the platform project, not the class version');
  if (keysOf(board.phases) !== SUBSET_PHASES.join(', ')) throw new Error(`the learner's board holds ${keysOf(board.phases)}, not ${SUBSET_PHASES.join(', ')}`);
  let phases = board.phases;
  let last = null;
  const scores = [];
  for (const [index, key] of SUBSET_PHASES.entries()) {
    const phase = phases.find((one) => one.key === key);
    const detail = await call(api, token, 'GET', `/phases/${phase.id}`);
    if (detail.place !== index + 1 || detail.count !== SUBSET_PHASES.length) {
      throw new Error(`${key} reads phase ${detail.place} of ${detail.count}, not ${index + 1} of ${SUBSET_PHASES.length}`);
    }
    await call(api, token, 'PUT', `/phases/${phase.id}/workspace`, { files: work[key] });
    if (key === 'implementation') await runAndWait({ api, token, phaseId: phase.id, sleep });
    const sub = await submitAndWait({ api, token, phaseId: phase.id, sleep });
    if (sub.status !== 'completed' || !sub.passed) throw new Error(`the learner did not pass ${key}: ${sub.status}, score ${sub.score}${sub.error ? `, ${String(sub.error).slice(0, 200)}` : ''}`);
    scores.push(sub.score);
    await call(api, token, 'POST', `/phases/${phase.id}/reflect`, { reflection: `Phase ${index + 1} of the shelf done: the review and the floor agreed on what was left.` });
    last = await call(api, token, 'POST', `/phases/${phase.id}/advance`);
    phases = last.phases ?? phases;
  }
  if (last?.completed !== true) throw new Error('the last advance did not complete the project');
  const record = await call(api, token, 'GET', '/enrollments/mine');
  const passed = (record.phases ?? []).filter((one) => one.status === 'passed').length;
  if (record.completed !== true || (record.phases ?? []).length !== SUBSET_PHASES.length || passed !== SUBSET_PHASES.length) {
    throw new Error(`the completion record reads ${passed} of ${(record.phases ?? []).length} phases passed, completed ${record.completed}`);
  }
  return { record, scores };
}

/**
 * The whole step: a fresh teacher authors and assigns the three-phase
 * version, a fresh learner finishes it. `adminToken` makes the teacher.
 * Returns the line the proof prints.
 */
export async function proveSubset({ api, adminToken, title, dir = SHELF_THREE_DIR, sleep }) {
  const teacher = await freshTeacher({ api, adminToken, tag: 'subset-teacher' });
  const made = await authorSubset({ api, token: teacher.token, title, dir, sleep });
  const learner = await freshLearner({ api, tag: 'subset-learner' });
  const { codeWork } = await import('./passing-work.mjs');
  const work = { requirements: shelfStoryWork(), design: shelfDesignWork(), implementation: codeWork(implementationWork(dir)) };
  const { record, scores } = await learnerFinishes({ api, token: learner.token, joinCode: made.joinCode, work, sleep });
  return `a fresh teacher uploaded, validated, published and assigned ${made.phaseList}; a fresh learner read each as phase n of 3, passed all three (scores ${scores.join(', ')}) and the completion record reads ${record.phases.length} of ${record.phases.length} phases passed, completed`;
}

/**
 * Sign in as the administrator named by ADMIN_EMAIL and ADMIN_PASSWORD, the
 * account that makes the fresh teacher: `{ adminToken }`.
 */
async function signInAsAdministrator(api) {
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD name the administrator who makes the teacher');
  const admin = await call(api, '', 'POST', '/auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });
  return { adminToken: admin.token };
}

/**
 * When `moduleUrl` is the script node was asked to run: read `--api` and
 * `--title`, sign in as the administrator, run `prove` and print its line.
 */
export function runAsAdminWhenMain(moduleUrl, prove, titlePrefix) {
  runWhenMain(moduleUrl, prove, titlePrefix, { signIn: signInAsAdministrator, report: (line) => line });
}

runAsAdminWhenMain(import.meta.url, proveSubset, 'Shelf in three phases');

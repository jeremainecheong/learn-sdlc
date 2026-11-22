import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  SHELF_THREE_DIR,
  SUBSET_PHASES,
  authorSubset,
  implementationWork,
  learnerFinishes,
  missingSubsetFixture,
  phaseFoldersOf,
  shelfDesignWork,
  shelfStoryWork,
  solutionWork,
  subsetArchive,
  withYearHelper,
} from './author-subset.mjs';
import { SHELF_DIR, readZip } from './export-roundtrip.mjs';

const require = createRequire(import.meta.url);
const { evaluateDesignFloor, evaluateStoryFloor, parseStoryJson, validateStoryRecord, STORY_JSON } = require('@learnsdlc/shared');

/** A phase's phase.json in a fixture pack, found by its key. */
function phaseJson(dir, key) {
  const folder = phaseFoldersOf(dir).find((one) => one.key === key);
  return JSON.parse(fs.readFileSync(path.join(dir, 'phases', folder.folder, 'phase.json'), 'utf8'));
}

/** Shelf's story and design work meet the floors of the pack at `dir`. */
function assertWorkMeetsFloors(dir) {
  const story = phaseJson(dir, 'requirements').checks;
  const text = shelfStoryWork('MARK')[STORY_JSON];
  assert.equal(validateStoryRecord(text, story.learnerStory.id).error, null);
  for (const row of evaluateStoryFloor(parseStoryJson(text), story.floor)) assert.ok(row.passed, `${row.id}: ${row.detail}`);
  const design = phaseJson(dir, 'design').checks;
  const results = evaluateDesignFloor(shelfDesignWork('MARK'), { contracts: design.contracts, sequence: design.sequence, stories: design.stories, floor: design.floor });
  for (const row of results) assert.ok(row.passed, `${row.id}: ${row.detail}`);
}

test('the shelf-three archive holds the three phase folders by place, a project.json with no phase list, and no canonical/', () => {
  const entries = readZip(subsetArchive());
  const names = [...entries.keys()];
  const folders = [...new Set(names.filter((name) => name.startsWith('phases/')).map((name) => name.split('/')[1]))].sort();
  assert.deepEqual(folders, ['01-requirements', '02-design', '03-implementation']);
  assert.ok(!('phases' in JSON.parse(entries.get('project.json').toString('utf8'))));
  assert.deepEqual(names.filter((name) => name.startsWith('canonical/')), []);
  assert.deepEqual(phaseFoldersOf(SHELF_THREE_DIR).map((one) => one.key), [...SUBSET_PHASES]);
});

test("the shelf-three learner's work meets its Requirements and Design floors, and its Implementation work is its solution folder with add()'s year check in its helper", () => {
  assertWorkMeetsFloors(SHELF_THREE_DIR);
  const solution = solutionWork(SHELF_THREE_DIR);
  const work = implementationWork(SHELF_THREE_DIR);
  assert.deepEqual(Object.keys(work), Object.keys(solution));
  const base = path.join(SHELF_THREE_DIR, 'phases/03-implementation/solution');
  for (const [at, text] of Object.entries(solution)) assert.equal(text, fs.readFileSync(path.join(base, at), 'utf8'));
  for (const [at, text] of Object.entries(work)) assert.equal(text, at === 'api/shelf.py' ? withYearHelper(solution[at]) : solution[at], at);
  // the reference solution as it stands is over the grader's limit, and the learner's copy is not
  assert.equal(maxComplexity(solution['api/shelf.py']), 9);
  assert.ok(maxComplexity(work['api/shelf.py']) <= 8);
});

// The browser journey (e2e/phase-subset.spec.ts, step 8) hands in the same Implementation work as this proof, so the
// strict gate passes it on an isolating host too. Playwright is not run
// here, so the journey's source is read: it lists the solution's files and moves api/shelf.py's year check with the
// helper this module re-exports.
test("the browser journey's Implementation work is implementationWork's, with add()'s year check in its helper", () => {
  const journey = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../e2e/phase-subset.spec.ts'), 'utf8');
  assert.ok(/^import \{ withYearHelper \} from '\.\/shelf-year-helper\.mjs';$/m.test(journey), 'the journey imports the shared withYearHelper');
  assert.ok(journey.includes("files['api/shelf.py'] = withYearHelper(files['api/shelf.py']);"), "the journey moves api/shelf.py's year check");
  const listed = /for \(const one of (\[[^\]]*\])\) files\[one\] = fs\.readFileSync/.exec(journey);
  assert.ok(listed, "the journey lists the solution's files");
  assert.deepEqual(JSON.parse(listed[1].replace(/'/g, '"')), Object.keys(implementationWork(SHELF_THREE_DIR)));
});

/** The grader's analyser over one Python file, as the API's starter-pack-properties spec runs it: the file's highest function complexity. */
function maxComplexity(text) {
  const analyser = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../apps/api/runner/analyzer.py');
  const out = spawnSync(process.env.PYTHON_BIN || 'python3', ['-I', '-B', analyser], {
    input: JSON.stringify({ files: { 'api/shelf.py': text }, targets: ['api/shelf.py'], language: 'python' }),
    encoding: 'utf-8',
  });
  if (out.status !== 0) throw new Error(`the analyser exited ${out.status}: ${out.stderr}`);
  return JSON.parse(out.stdout).metrics.maxComplexity;
}

test("withYearHelper moves Shelf's inline year check into _year_is_valid, the starter's shape, and leaves other texts as they are", () => {
  const inline = fs.readFileSync(path.join(SHELF_DIR, 'phases/03-implementation/solution/api/shelf.py'), 'utf8');
  const moved = withYearHelper(inline);
  assert.match(moved, /\n\ndef _year_is_valid\(year\):\n[\s\S]*?    return 1000 <= year <= 2999\n\n\nclass Shelf:\n/);
  assert.ok(moved.includes('        if not _year_is_valid(year):\n            raise ValueError("year must be a four-digit number")\n'));
  assert.ok(!moved.includes('if year is not None and (isinstance(year, bool)'));
  assert.equal(withYearHelper(moved), moved);
  assert.equal(withYearHelper('print(1)\n'), 'print(1)\n');
  assert.throws(() => withYearHelper(inline.replace('\n\n\nclass Shelf:\n', '\nclass Shelf:\n')), /no class Shelf after two blank lines/);
});

test('without shelf-three the archive is refused in a sentence that names the missing folder', () => {
  const absent = path.join(path.dirname(SHELF_THREE_DIR), 'no-such-pack');
  assert.match(missingSubsetFixture(absent), /^apps\/api\/test\/fixtures\/upload-packs\/no-such-pack is not in this checkout$/);
  assert.throws(() => subsetArchive(absent), { message: missingSubsetFixture(absent) });
});

test("Shelf's story and design work meet the Shelf fixture's floors, and the stub's mark goes in the notes only when asked", () => {
  assertWorkMeetsFloors(SHELF_DIR);
  assert.match(parseStoryJson(shelfStoryWork('MARK')[STORY_JSON]).notes, / MARK$/);
  assert.doesNotMatch(parseStoryJson(shelfStoryWork(null)[STORY_JSON]).notes, /MARK/);
  assert.ok(Object.values(shelfDesignWork('MARK')).some((text) => text.includes('MARK')));
  assert.ok(!Object.values(shelfDesignWork(null)).some((text) => text.includes('MARK')));
});

test("the solution reader takes a code phase's solution folder by workspace path, in either layout", () => {
  assert.deepEqual(phaseFoldersOf(SHELF_DIR).map((one) => one.key), ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance']);
  const work = solutionWork(SHELF_DIR);
  assert.deepEqual(Object.keys(work), ['api/shelf.py', 'web/src/lib/shelf.ts']);
  assert.equal(work['api/shelf.py'], fs.readFileSync(path.join(SHELF_DIR, 'phases/03-implementation/solution/api/shelf.py'), 'utf8'));
  assert.throws(() => solutionWork(SHELF_DIR, 'requirements'), /requirements phase holds no solution folder/);
});

/* ---------------- the two halves over a stubbed API, in order ---------------- */

/** A fetch that answers each `METHOD route` (ids replaced by :id) from `answers`, in turn when the answer is a list, and records the calls. */
function stubFetch(answers) {
  const calls = [];
  const turns = new Map();
  globalThis.fetch = async (url, init) => {
    const route = String(url).replace('http://api.test', '').replace(/\/(p1|v1|c1|ph[0-9]|s[0-9]|r1|u1)(?=\/|$)/g, '/:id');
    const key = `${init.method} ${route}`;
    calls.push(init.body ? [key, JSON.parse(init.body)] : [key]);
    let answer = answers[key] ?? {};
    if (Array.isArray(answer) && answer.turns) {
      const n = turns.get(key) ?? 0;
      turns.set(key, n + 1);
      answer = answer[Math.min(n, answer.length - 1)];
    }
    return { ok: true, status: 200, json: async () => answer };
  };
  return calls;
}
const inTurn = (...answers) => Object.assign(answers, { turns: true });
const phasesOf = (keys) => keys.map((key, i) => ({ id: `ph${i + 1}`, key, order: i + 1, status: 'passed' }));
const noSleep = async () => {};

test('authorSubset uploads, checks the three phases, validates, publishes, opens a class, reads the assignable list and assigns, in that order', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch({
    'POST /instructor/projects/upload': { projectId: 'p1', versionId: 'v1' },
    'GET /instructor/projects/:id/versions/:id': { phases: phasesOf(SUBSET_PHASES) },
    'GET /instructor/projects/:id/versions/:id/deep-validation': inTurn({ status: 'idle', costWarning: { microVMs: 2 } }, { status: 'running' }, { status: 'passed' }),
    'POST /instructor/projects/:id/versions/:id/publish': { versionId: 'v1' },
    'POST /instructor/cohorts': { id: 'c1', joinCode: 'JOIN1' },
    'GET /instructor/cohorts/:id/project/assignable': [{ versionId: 'v1', phases: [...SUBSET_PHASES] }],
  });
  const made = await authorSubset({ api: 'http://api.test', token: 't', title: 'T', dir: SHELF_DIR, sleep: noSleep });
  assert.deepEqual(made, { projectId: 'p1', versionId: 'v1', joinCode: 'JOIN1', phaseList: 'Requirements, Design and Implementation' });
  assert.deepEqual(calls.map(([key]) => key), [
    'POST /instructor/projects/upload',
    'GET /instructor/projects/:id/versions/:id',
    'GET /instructor/projects/:id/versions/:id/deep-validation',
    'POST /instructor/projects/:id/versions/:id/deep-validation',
    'GET /instructor/projects/:id/versions/:id/deep-validation',
    'GET /instructor/projects/:id/versions/:id/deep-validation',
    'POST /instructor/projects/:id/versions/:id/publish',
    'POST /instructor/cohorts',
    'GET /instructor/cohorts/:id/project/assignable',
    'PUT /instructor/cohorts/:id/project',
  ]);
  assert.deepEqual(calls[3][1], { acknowledgedMicroVMs: 2 });
  assert.deepEqual(calls[9][1].projectVersionId, 'v1');
});

for (const [name, change, refusal] of [
  ['a draft that holds other phases', { 'GET /instructor/projects/:id/versions/:id': { phases: phasesOf(['requirements', 'design']) } }, 'the uploaded draft holds requirements, design, not requirements, design, implementation'],
  ['a failed deep validation', { 'GET /instructor/projects/:id/versions/:id/deep-validation': inTurn({ status: 'idle' }, { status: 'failed', checks: [{ id: 'implementation.solution', status: 'failed' }] }) }, 'deep validation failed: implementation.solution'],
  ['an assignable list that names other phases', { 'GET /instructor/cohorts/:id/project/assignable': [{ versionId: 'v1', phases: ['requirements'] }] }, 'the assignable list names requirements for the version'],
]) {
  test(`authorSubset refuses ${name}`, async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    stubFetch({
      'POST /instructor/projects/upload': { projectId: 'p1', versionId: 'v1' },
      'GET /instructor/projects/:id/versions/:id': { phases: phasesOf(SUBSET_PHASES) },
      'GET /instructor/projects/:id/versions/:id/deep-validation': inTurn({ status: 'idle' }, { status: 'passed' }),
      'POST /instructor/projects/:id/versions/:id/publish': { versionId: 'v1' },
      'POST /instructor/cohorts': { id: 'c1', joinCode: 'JOIN1' },
      'GET /instructor/cohorts/:id/project/assignable': [{ versionId: 'v1', phases: [...SUBSET_PHASES] }],
      ...change,
    });
    await assert.rejects(authorSubset({ api: 'http://api.test', token: 't', title: 'T', dir: SHELF_DIR, sleep: noSleep }), { message: refusal });
  });
}

/** The learner's routes answering a learner who passes every phase. */
function learnerAnswers(overrides = {}) {
  const board = phasesOf(SUBSET_PHASES).map((one) => ({ ...one, status: 'in_progress' }));
  return {
    'POST /enrollments': { projectIsDefault: false, phases: board },
    'GET /phases/:id': inTurn(...SUBSET_PHASES.map((_, i) => ({ place: i + 1, count: 3 }))),
    'POST /phases/:id/run': { id: 'r1' },
    'GET /runs/:id': { status: 'completed' },
    'POST /phases/:id/submit': inTurn({ id: 's1' }, { id: 's2' }, { id: 's3' }),
    'GET /submissions/:id': { status: 'completed', passed: true, score: 90 },
    'POST /phases/:id/advance': inTurn({ phases: board }, { phases: board }, { completed: true, phases: phasesOf(SUBSET_PHASES) }),
    'GET /enrollments/mine': { completed: true, phases: phasesOf(SUBSET_PHASES) },
    ...overrides,
  };
}
const WORK = { requirements: { a: '1' }, design: { b: '2' }, implementation: { c: '3' } };

test('learnerFinishes joins, then saves, submits, reflects and advances each phase in place order, running Implementation first, and reads the completion record', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(learnerAnswers());
  const { record, scores } = await learnerFinishes({ api: 'http://api.test', token: 't', joinCode: 'JOIN1', work: WORK, sleep: noSleep });
  assert.equal(record.completed, true);
  assert.deepEqual(scores, [90, 90, 90]);
  const phase = (n, implementation = false) => [
    'GET /phases/:id',
    'PUT /phases/:id/workspace',
    ...(implementation ? ['POST /phases/:id/run', 'GET /runs/:id'] : []),
    'POST /phases/:id/submit',
    'GET /submissions/:id',
    'POST /phases/:id/reflect',
    'POST /phases/:id/advance',
  ];
  assert.deepEqual(calls.map(([key]) => key), ['POST /enrollments/join', 'POST /enrollments', ...phase(1), ...phase(2), ...phase(3, true), 'GET /enrollments/mine']);
  assert.deepEqual(calls.filter(([key]) => key === 'PUT /phases/:id/workspace').map(([, body]) => body.files), [WORK.requirements, WORK.design, WORK.implementation]);
});

for (const [name, change, refusal] of [
  ['a board on the platform project', { 'POST /enrollments': { projectIsDefault: true, phases: [] } }, 'the learner was enrolled on the platform project, not the class version'],
  ['a phase read at the wrong place', { 'GET /phases/:id': { place: 1, count: 6 } }, 'requirements reads phase 1 of 6, not 1 of 3'],
  ['a phase the learner did not pass', { 'GET /submissions/:id': { status: 'completed', passed: false, score: 40 } }, 'the learner did not pass requirements: completed, score 40'],
  ['a last advance that does not complete', { 'POST /phases/:id/advance': { phases: phasesOf(SUBSET_PHASES) } }, 'the last advance did not complete the project'],
  ['a completion record short of three passed phases', { 'GET /enrollments/mine': { completed: true, phases: phasesOf(['requirements', 'design']) } }, 'the completion record reads 2 of 2 phases passed, completed true'],
]) {
  test(`learnerFinishes refuses ${name}`, async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    stubFetch(learnerAnswers(change));
    await assert.rejects(learnerFinishes({ api: 'http://api.test', token: 't', joinCode: 'JOIN1', work: WORK, sleep: noSleep }), { message: refusal });
  });
}

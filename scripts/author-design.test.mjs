import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  AUTHORED_DESIGN_FLOOR,
  AUTHORED_DESIGN_STORIES,
  AUTHORED_DESIGN_WEIGHTS,
  assignBody,
  authorDesign,
  copyBody,
  designTaskBody,
  publishBody,
  startingPointBody,
} from './author-design.mjs';

const require = createRequire(import.meta.url);

test('the design body carries two stories, both contracts, the sequence diagram, a floor inside the caps and weights summing to 1', () => {
  const b = designTaskBody('Overdue design');
  assert.deepEqual(b.design.stories.map((s) => s.id), AUTHORED_DESIGN_STORIES);
  assert.deepEqual(b.design.contracts, { api: true, screens: true });
  assert.equal(b.design.sequence, true);
  assert.ok(b.design.floor.minEntities >= 0 && b.design.floor.minEntities <= 20);
  assert.deepEqual(b.rubric.criteria.map((c) => c.weight), AUTHORED_DESIGN_WEIGHTS);
  assert.equal(Math.round(b.rubric.criteria.reduce((n, c) => n + c.weight, 0) * 1000) / 1000, 1);
  assert.equal(b.artefactType, 'design-doc');
  assert.ok(!('rules' in b) && !('minWords' in b));
});

test('every story line is inside the door caps, and nothing names a file', () => {
  const { design } = designTaskBody('Overdue design');
  for (const s of design.stories) {
    assert.ok(s.id.length <= 16);
    assert.ok(s.title.length <= 400 && s.line.length <= 400);
  }
  assert.ok(!/\.md|\.json/.test(JSON.stringify(designTaskBody('x'))));
  assert.equal(publishBody().version, '1.0.0');
});

test('the floor names every field the door requires, inside the shared caps', () => {
  const { DESIGN_CAPS, DEFAULT_DESIGN_FLOOR } = require('@learnsdlc/shared');
  const { floor } = designTaskBody('Overdue design').design;
  assert.deepEqual(Object.keys(floor).sort(), Object.keys(DEFAULT_DESIGN_FLOOR).sort());
  for (const [key, value] of Object.entries(floor)) {
    if (typeof value === 'number') assert.ok(value >= DESIGN_CAPS[key][0] && value <= DESIGN_CAPS[key][1], key);
  }
});

test('the starting point is a design record the shared validator accepts, below the floor it is graded by', () => {
  const { validateDesignRecord, evaluateDesignFloor } = require('@learnsdlc/shared');
  const start = startingPointBody();
  assert.equal(start.path, 'design/design.json');
  const out = validateDesignRecord(start.content);
  assert.equal(out.error, null);
  assert.deepEqual(out.design.entities.map((e) => e.name), ['Task']);
  // an untouched starting point never passes: the learner's own design does
  const { design } = designTaskBody('Overdue design');
  assert.ok(evaluateDesignFloor({ [start.path]: start.content }, design).some((r) => !r.passed));
});

test('the copy, the publish and the assignment say what they are', () => {
  assert.match(copyBody('A', 'v').slug, /^design-proof-/);
  assert.ok(copyBody('A', 'v').slug.length <= 48);
  assert.equal(copyBody('A', 'v').fromVersionId, 'v');
  assert.equal(assignBody('v').reason, 'This class designs the overdue report the teacher authored.');
});

test('the task title names the project, inside the door cap', () => {
  assert.ok(designTaskBody('x'.repeat(300)).title.length <= 160);
  assert.match(designTaskBody('Library Shelf').title, /^Library Shelf: /);
});

test("the values the proof looks for in the learner's phase are this authoring's own, never TaskTrackr's", () => {
  const body = designTaskBody('Library Shelf');
  assert.deepEqual(body.design.stories.map((one) => one.id), AUTHORED_DESIGN_STORIES);
  assert.deepEqual(body.rubric.criteria.map((one) => one.weight), AUTHORED_DESIGN_WEIGHTS);
  assert.deepEqual(body.design.floor, AUTHORED_DESIGN_FLOOR);
  const pack = JSON.parse(readFileSync(new URL('../content/tasktrackr/phases/02-design/phase.json', import.meta.url), 'utf8'));
  assert.notDeepEqual(pack.checks.stories.map((one) => one.id), AUTHORED_DESIGN_STORIES);
  assert.notDeepEqual(pack.rubric.criteria.map((one) => one.weight), AUTHORED_DESIGN_WEIGHTS);
  // the counts the proof compares differ from the pack's own, so the floor it reads back is the teacher's
  for (const key of ['minEntities', 'minRelations', 'minOperations', 'minEndpoints']) {
    assert.notEqual(pack.checks.floor[key], AUTHORED_DESIGN_FLOOR[key], key);
  }
});

/**
 * A fetch that answers each route from `answers` (keyed "METHOD /route" with
 * ids replaced by :id), records the calls, and answers 200 {} otherwise.
 */
function stubFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const route = String(url).replace('http://api.test', '').replace(/\/(p1|d1|v1|c1)(?=\/|$)/g, '/:id');
    const key = `${init.method} ${route}`;
    calls.push(key);
    const body = key in answers ? answers[key] : {};
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

const HAPPY = {
  'GET /instructor/projects': { library: [{ isDefault: true, publishedVersionId: 'v0' }] },
  'POST /instructor/projects': { project: { id: 'p1' }, draftVersionId: 'd1' },
  'PATCH /instructor/projects/:id/versions/:id/phases/design/tasks/main': {
    phase: { tasks: [{ taskKey: 'main', checkKind: 'design', design: { stories: [{ id: 'US-2' }, { id: 'US-4' }], sequence: true } }] },
  },
  'POST /instructor/projects/:id/versions/:id/publish': { versionId: 'v1' },
  'POST /instructor/cohorts': { id: 'c1', joinCode: 'JOIN1' },
};

test('authorDesign copies, edits, writes the starting point, publishes and assigns, in that order', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(HAPPY);
  const made = await authorDesign({ api: 'http://api.test', token: 't', title: 'T' });
  assert.deepEqual(made, { projectId: 'p1', versionId: 'v1', joinCode: 'JOIN1' });
  assert.deepEqual(calls, [
    'GET /instructor/projects',
    'POST /instructor/projects',
    'PATCH /instructor/projects/:id/versions/:id/phases/design/tasks/main',
    'PUT /instructor/projects/:id/versions/:id/phases/design/files',
    'POST /instructor/projects/:id/versions/:id/publish',
    'POST /instructor/cohorts',
    'PUT /instructor/cohorts/:id/project',
  ]);
});

for (const [name, change, refusal] of [
  ['no published default project', { 'GET /instructor/projects': { library: [{ isDefault: true }] } }, 'the library has no published default project to copy'],
  ['a copy with no draft', { 'POST /instructor/projects': { project: { id: 'p1' } } }, 'the copy answered without a project or a draft'],
  ['a task that is not the authored design task', { 'PATCH /instructor/projects/:id/versions/:id/phases/design/tasks/main': { phase: { tasks: [{ taskKey: 'main', checkKind: 'markdown' }] } } }, 'the Design task did not come back as the authored design task'],
  ['a publish with no version', { 'POST /instructor/projects/:id/versions/:id/publish': {} }, 'the publish answered without a version'],
]) {
  test(`authorDesign refuses ${name}`, async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    stubFetch({ ...HAPPY, ...change });
    await assert.rejects(authorDesign({ api: 'http://api.test', token: 't', title: 'T' }), { message: refusal });
  });
}

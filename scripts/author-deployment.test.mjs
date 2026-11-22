import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AUTHORED_RUNBOOK_FLOOR, authorDeployment, runbookTaskBody, startingRunbookBody } from './author-deployment.mjs';

const require = createRequire(import.meta.url);

test('the runbook body carries the title and the floor only, and names no file', () => {
  const b = runbookTaskBody('Ship it');
  assert.deepEqual(Object.keys(b).sort(), ['runbook', 'title']);
  assert.deepEqual(b.runbook, { floor: AUTHORED_RUNBOOK_FLOOR });
  assert.ok(!/RUNBOOK\.md|runbook\.json/.test(JSON.stringify(b)));
  for (const n of Object.values(AUTHORED_RUNBOOK_FLOOR)) if (typeof n === 'number') assert.ok(n >= 0 && n <= 20);
});
test('the starting runbook holds two environment entries and an empty incident, as a drill phase requires', () => {
  const { path, content } = startingRunbookBody();
  assert.equal(path, 'deployment/runbook.json');
  const record = JSON.parse(content);
  assert.deepEqual(record.environment.map((e) => e.id), ['E1', 'E2']);
  assert.deepEqual(record.incident, { rootCause: '', fix: '', actionItem: '' });
  assert.deepEqual([record.health, record.rollback, record.data], [[], [], []]);
});
test('the floor names every field the door requires, and the starting runbook is one the shared validator accepts', () => {
  const { DEFAULT_RUNBOOK_FLOOR, validateRunbookRecord } = require('@learnsdlc/shared');
  assert.deepEqual(Object.keys(AUTHORED_RUNBOOK_FLOOR).sort(), Object.keys(DEFAULT_RUNBOOK_FLOOR).sort());
  assert.equal(validateRunbookRecord(startingRunbookBody().content).error, null);
});

/** A fetch that answers each route from `answers` (ids replaced by :id), records the calls, and answers 200 {} otherwise. */
function stubFetch(answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const route = String(url).replace('http://api.test', '').replace(/\/(p1|d1|v1|c1)(?=\/|$)/g, '/:id');
    const key = `${init.method} ${route}`;
    calls.push(init.body ? [key, JSON.parse(init.body)] : [key]);
    return { ok: true, status: 200, json: async () => (key in answers ? answers[key] : {}) };
  };
  return calls;
}
const HAPPY = {
  'GET /instructor/projects': { library: [{ isDefault: true, publishedVersionId: 'v0' }] },
  'POST /instructor/projects': { project: { id: 'p1' }, draftVersionId: 'd1' },
  'PATCH /instructor/projects/:id/versions/:id/phases/deployment/tasks/main': { phase: { tasks: [{ taskKey: 'main', runbook: { floor: AUTHORED_RUNBOOK_FLOOR } }] } },
  'POST /instructor/projects/:id/versions/:id/publish': { versionId: 'v1' },
  'POST /instructor/cohorts': { id: 'c1', joinCode: 'JOIN1' },
};

test('authorDeployment copies, saves the title and the floor, writes the starting runbook, publishes and assigns, in that order', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(HAPPY);
  const made = await authorDeployment({ api: 'http://api.test', token: 't', title: 'T' });
  assert.deepEqual(made, { projectId: 'p1', versionId: 'v1', joinCode: 'JOIN1' });
  assert.deepEqual(calls.map(([key]) => key), [
    'GET /instructor/projects',
    'POST /instructor/projects',
    'PATCH /instructor/projects/:id/versions/:id/phases/deployment/tasks/main',
    'PUT /instructor/projects/:id/versions/:id/phases/deployment/files',
    'POST /instructor/projects/:id/versions/:id/publish',
    'POST /instructor/cohorts',
    'PUT /instructor/cohorts/:id/project',
  ]);
  assert.deepEqual(calls[2][1], runbookTaskBody('T'));
  assert.deepEqual(calls[3][1], startingRunbookBody());
});

for (const [name, change, refusal] of [
  ['a task that did not keep the floor', { 'PATCH /instructor/projects/:id/versions/:id/phases/deployment/tasks/main': { phase: { tasks: [{ taskKey: 'main' }] } } }, 'the Deployment task did not come back with the authored floor'],
]) {
  test(`authorDeployment refuses ${name}`, async (t) => {
    const real = globalThis.fetch;
    t.after(() => { globalThis.fetch = real; });
    stubFetch({ ...HAPPY, ...change });
    await assert.rejects(authorDeployment({ api: 'http://api.test', token: 't', title: 'T' }), { message: refusal });
  });
}

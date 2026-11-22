import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AUTHORED_CHANGE_FLOOR, AUTHORED_TICKET, authorMaintenance, changeTaskBody } from './author-maintenance.mjs';

const require = createRequire(import.meta.url);

test('the change body carries the ticket, the switch on and the floor, and names no file', () => {
  const b = changeTaskBody('Comments');
  assert.deepEqual(b.ticket, AUTHORED_TICKET);
  assert.deepEqual(b.change, { contract: true, floor: AUTHORED_CHANGE_FLOOR });
  assert.ok(!/CHANGELOG\.md|change-request\.json/.test(JSON.stringify(b)));
});
test('the ticket is inside the door caps: at most 12 acceptance lines, ids AC-n in order, each line at most 400 characters', () => {
  assert.ok(AUTHORED_TICKET.acceptance.length <= 12);
  AUTHORED_TICKET.acceptance.forEach((a, i) => { assert.equal(a.id, `AC-${i + 1}`); assert.ok(a.line.length <= 400); });
  assert.ok(AUTHORED_TICKET.summary.length <= 2000 && AUTHORED_TICKET.title.length <= 400);   // CHANGE_CAPS.ticketSummary, CHANGE_CAPS.ticketTitle
});
test("every line but AC-6 is TaskTrackr's own, word for word, and AC-6 is reworded", () => {
  const pack = JSON.parse(readFileSync(new URL('../content/tasktrackr/phases/06-maintenance/phase.json', import.meta.url), 'utf8'));
  const own = pack.checks.ticket;
  assert.deepEqual(AUTHORED_TICKET.acceptance.map((a) => a.id), own.acceptance.map((a) => a.id));
  AUTHORED_TICKET.acceptance.forEach((a, i) => (a.id === 'AC-6' ? assert.notEqual(a.line, own.acceptance[i].line) : assert.equal(a.line, own.acceptance[i].line)));
  assert.equal(AUTHORED_TICKET.summary, own.summary);
  const { CHANGE_CAPS, DEFAULT_CHANGE_FLOOR, validateChangeTicket } = require('@learnsdlc/shared');
  assert.doesNotThrow(() => validateChangeTicket(AUTHORED_TICKET));
  assert.deepEqual(Object.keys(AUTHORED_CHANGE_FLOOR).sort(), Object.keys(DEFAULT_CHANGE_FLOOR).sort());
  for (const key of ['minImpact', 'minContract', 'minTests']) assert.ok(AUTHORED_CHANGE_FLOOR[key] >= CHANGE_CAPS[key][0] && AUTHORED_CHANGE_FLOOR[key] <= CHANGE_CAPS[key][1], key);
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
  'PATCH /instructor/projects/:id/versions/:id/phases/maintenance/tasks/main': { phase: { tasks: [{ taskKey: 'main', change: { ticket: AUTHORED_TICKET } }] } },
  'POST /instructor/projects/:id/versions/:id/publish': { versionId: 'v1' },
  'POST /instructor/cohorts': { id: 'c1', joinCode: 'JOIN1' },
};

test('authorMaintenance copies, saves the ticket and the change request, publishes and assigns, in that order', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(HAPPY);
  const made = await authorMaintenance({ api: 'http://api.test', token: 't', title: 'T' });
  assert.deepEqual(made, { projectId: 'p1', versionId: 'v1', joinCode: 'JOIN1' });
  assert.deepEqual(calls.map(([key]) => key), [
    'GET /instructor/projects',
    'POST /instructor/projects',
    'PATCH /instructor/projects/:id/versions/:id/phases/maintenance/tasks/main',
    'POST /instructor/projects/:id/versions/:id/publish',
    'POST /instructor/cohorts',
    'PUT /instructor/cohorts/:id/project',
  ]);
  assert.deepEqual(calls[2][1], changeTaskBody('T'));
});

test('authorMaintenance refuses a task that did not keep the authored ticket', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch({ ...HAPPY, 'PATCH /instructor/projects/:id/versions/:id/phases/maintenance/tasks/main': { phase: { tasks: [{ taskKey: 'main' }] } } });
  await assert.rejects(authorMaintenance({ api: 'http://api.test', token: 't', title: 'T' }), { message: 'the Maintenance task did not come back with the authored ticket' });
});

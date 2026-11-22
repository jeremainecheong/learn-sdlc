import {
  EMPTY_RUNBOOK, evaluateRunbookFloor, filledRunbookCounts, incidentRecorded, isRunbookPath, runbookCarried, runbookChangeSet, runbookFloorSentence,
  runbookReviewProjection, serialiseRunbook, type Runbook, type RunbookFloor,
} from './runbook-record';

const floor: RunbookFloor = { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true };
const good: Runbook = {
  environment: [
    { id: 'E1', name: 'TASKTRACKR_DB', purpose: 'Where the database file lives.', kind: 'config' },
    { id: 'E2', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config', example: 'http://api:8000' },
  ],
  health: [{ id: 'H1', name: 'Selfcheck', how: 'python3 api/main.py --selfcheck', expected: 'selfcheck: web reaches api' }],
  rollback: [
    { id: 'R1', step: 'Retag the previous images', verify: 'docker compose ps shows them' },
    { id: 'R2', step: 'docker compose up -d', verify: 'The selfcheck passes' },
  ],
  data: [{ id: 'D1', what: 'The database file', how: 'sqlite3 .backup nightly', where: 'tasktrackr-data volume' }],
  incident: { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' },
};
const text = (r: Runbook) => serialiseRunbook(r);

describe('evaluateRunbookFloor', () => {
  it('passes a full runbook on every rule, in the fixed order', () => {
    const out = evaluateRunbookFloor(text(good), floor);
    expect(out.map((r) => r.id)).toEqual(['runbook.record', 'runbook.environment.min', 'runbook.health.min', 'runbook.rollback.min', 'runbook.data.min', 'runbook.incident', 'runbook.named']);
    expect(out.every((r) => r.passed)).toBe(true);
    expect(out.map((r) => r.label)).toEqual(['The runbook record', 'At least 2 environment entries', 'At least 1 health check', 'At least 2 rollback steps', 'At least 1 data entry', 'The incident is recorded', 'Every runbook item is named']);
  });
  it('counts only filled items: a name alone, or a whitespace purpose, counts for nothing', () => {
    const named = { ...good, environment: [good.environment[0], { id: 'E2', name: 'API_URL', purpose: '   ', kind: 'config' as const }] };
    const out = evaluateRunbookFloor(text(named), floor);
    expect(out.find((r) => r.id === 'runbook.environment.min')).toEqual({
      id: 'runbook.environment.min', label: 'At least 2 environment entries', passed: false,
      detail: 'Fewer than 2 environment entries with a name and a purpose',
    });
  });
  it.each([
    ['health', { ...good, health: [] }, 'runbook.health.min', 'Fewer than 1 health check with a name, a command and the expected output'],
    ['rollback', { ...good, rollback: [good.rollback[0]] }, 'runbook.rollback.min', 'Fewer than 2 rollback steps with a step and a check'],
    ['data', { ...good, data: [{ ...good.data[0], where: '' }] }, 'runbook.data.min', 'Fewer than 1 data entry saying what is kept, how and where'],
  ])('fails the %s minimum with its sentence', (_list, runbook, id, detail) => {
    expect(evaluateRunbookFloor(text(runbook as Runbook), floor).find((r) => r.id === id)?.detail).toBe(detail);
  });
  it('emits a minimum of 0 as passed', () => {
    const out = evaluateRunbookFloor(text(EMPTY_RUNBOOK), { ...floor, minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false });
    expect(out.filter((r) => r.id.endsWith('.min')).every((r) => r.passed)).toBe(true);
    expect(out.find((r) => r.id === 'runbook.environment.min')?.label).toBe('At least 0 environment entries');
  });
  it('names only the blank incident fields, and says Not required when off', () => {
    const half = { ...good, incident: { rootCause: 'API_URL', fix: ' ', actionItem: '' } };
    expect(evaluateRunbookFloor(text(half), floor).find((r) => r.id === 'runbook.incident')?.detail).toBe('The incident is missing its fix and action item');
    expect(evaluateRunbookFloor(text(EMPTY_RUNBOOK), floor).find((r) => r.id === 'runbook.incident')?.detail).toBe('The incident is missing its root cause, fix and action item');
    expect(evaluateRunbookFloor(text(EMPTY_RUNBOOK), { ...floor, requireIncident: false }).find((r) => r.id === 'runbook.incident')).toMatchObject({ passed: true, detail: 'Not required' });
  });
  it('counts unnamed items in every list, singular and plural', () => {
    const one = { ...good, data: [...good.data, { id: 'D2', what: ' ', how: 'h', where: 'w' }] };
    expect(evaluateRunbookFloor(text(one), floor).find((r) => r.id === 'runbook.named')?.detail).toBe('1 runbook item has no name');
    const three = { ...one, health: [...good.health, { id: 'H2', name: '', how: '', expected: '' }], rollback: [...good.rollback, { id: 'R3', step: '', verify: 'v' }] };
    expect(evaluateRunbookFloor(text(three), floor).find((r) => r.id === 'runbook.named')?.detail).toBe('3 runbook items have no name');
  });
  it('fails the record rule on an unreadable record and scores the rest against the empty one', () => {
    const out = evaluateRunbookFloor('{', floor);
    expect(out[0]).toEqual({ id: 'runbook.record', label: 'The runbook record', passed: false, detail: 'The runbook record is missing or not valid' });
    expect(out).toHaveLength(7);
    expect(evaluateRunbookFloor(undefined, floor)[0].passed).toBe(false);
  });
  it('restates the floor in one line', () => {
    expect(runbookFloorSentence(floor)).toBe("at least 2 environment entries with a name and a purpose; at least 1 health check with a name, a command and the expected output; at least 2 rollback steps with a step and a check; at least 1 data entry saying what is kept, how and where; the incident's root cause, fix and action item; every item named");
    expect(runbookFloorSentence({ minEnvironment: 0, minHealth: 0, minRollback: 0, minData: 0, requireIncident: false })).toBe('every item named');
  });
});

describe('the projection', () => {
  it('cites one path per field, the id in front of each naming path, the rollback order and the timeline', () => {
    const r: Runbook = { ...good, incident: { ...good.incident, timeline: [{ at: '01:00', event: 'Paged' }, { at: '01:20', event: 'Closed' }] }, notes: 'n' };
    const p = runbookReviewProjection(text(r));
    expect(p['runbook/env-1/name']).toBe('E1: TASKTRACKR_DB');
    expect(p['runbook/env-2/example']).toBe('http://api:8000');
    expect(p['runbook/health-1/how']).toBe('python3 api/main.py --selfcheck');
    expect(p['runbook/rollback-2/step']).toBe('R2: docker compose up -d');
    expect(p['runbook/rollback/order']).toBe('R1, R2');
    expect(p['runbook/data-1/where']).toBe('tasktrackr-data volume');
    expect(p['runbook/incident/root-cause']).toBe('API_URL named localhost');
    expect(p['runbook/incident/action-item']).toBe('Lint compose in CI');
    expect(p['runbook/incident/timeline']).toBe('01:00 Paged\n01:20 Closed');
    expect(p['runbook/notes']).toBe('n');
  });
  it('is complete: every leaf of the record appears under exactly one path', () => {
    const r: Runbook = { ...good, data: [{ ...good.data[0], retention: '7 days' }], notes: 'kept' };
    const p = runbookReviewProjection(text(r));
    const leaves = [
      ...r.environment.flatMap((e) => [e.name, e.purpose, e.kind, e.example ?? '']), ...r.health.flatMap((h) => [h.name, h.how, h.expected]),
      ...r.rollback.flatMap((s) => [s.step, s.verify]), ...r.data.flatMap((d) => [d.what, d.how, d.where, d.retention ?? '']),
      r.incident.rootCause, r.incident.fix, r.incident.actionItem, r.notes!,
    ].filter(Boolean);
    const values = Object.values(p).join('\n');
    for (const leaf of leaves) expect(values).toContain(leaf);
    // exactly one path: a leaf the record holds once is the whole value of one path (or follows its id there), never of two
    const once = leaves.filter((leaf) => leaves.indexOf(leaf) === leaves.lastIndexOf(leaf));
    for (const leaf of once) expect(Object.values(p).filter((v) => v === leaf || v.endsWith(`: ${leaf}`))).toHaveLength(1);
  });
  it('is empty for an unreadable record', () => {
    expect(runbookReviewProjection('{')).toEqual({});
  });
});

describe('the change set and the carried list', () => {
  it('numbers by the earlier ids: a removed item yields removals, a renamed id a removal plus an addition', () => {
    const removed = runbookChangeSet(text(good), text({ ...good, environment: [good.environment[1]] }));
    expect(removed.map((c) => c.path)).toEqual(['runbook/env-1/name', 'runbook/env-1/purpose', 'runbook/env-1/kind']);
    expect(removed.every((c) => c.after === undefined)).toBe(true);
    const renamed = runbookChangeSet(text(good), text({ ...good, health: [{ ...good.health[0], id: 'H9' }] }));
    expect(renamed.map((c) => [c.path, Boolean(c.before), Boolean(c.after)])).toEqual([
      ['runbook/health-1/name', true, false], ['runbook/health-1/how', true, false], ['runbook/health-1/expected', true, false],
      ['runbook/health-2/name', false, true], ['runbook/health-2/how', false, true], ['runbook/health-2/expected', false, true],
    ]);
  });
  it('reads a reordered rollback as the order path alone', () => {
    const moved = runbookChangeSet(text(good), text({ ...good, rollback: [good.rollback[1], good.rollback[0]] }));
    expect(moved).toEqual([{ path: 'runbook/rollback/order', before: 'R1, R2', after: 'R2, R1' }]);
  });
  it('carries every id, and the incident in a drill phase', () => {
    expect(runbookCarried(text(good), false)).toEqual(['environment entry E1', 'environment entry E2', 'health check H1', 'rollback step R1', 'rollback step R2', 'data entry D1']);
    expect(runbookCarried(text(good), true).at(-1)).toBe('the incident');
    expect(runbookCarried('{', true)).toEqual([]);
  });
});

describe('the floor\'s counters and the review path test', () => {
  it('counts filled items per list', () => {
    expect(filledRunbookCounts(good)).toEqual({ environment: 2, health: 1, rollback: 2, data: 1 });
    const half = { ...good, health: [{ ...good.health[0], expected: ' ' }], data: [{ ...good.data[0], where: '' }] };
    expect(filledRunbookCounts(half)).toEqual({ environment: 2, health: 0, rollback: 2, data: 0 });
    expect(filledRunbookCounts(EMPTY_RUNBOOK)).toEqual({ environment: 0, health: 0, rollback: 0, data: 0 });
  });
  it('calls the incident recorded only when all three fields are filled, and a missing incident not recorded', () => {
    expect(incidentRecorded(good.incident)).toBe(true);
    expect(incidentRecorded({ ...good.incident, fix: ' ' })).toBe(false);
    expect(incidentRecorded(null)).toBe(false);
    expect(incidentRecorded(undefined)).toBe(false);
  });
  it('takes a runbook review path and refuses a file under a runbook folder or another root', () => {
    expect(isRunbookPath('runbook/notes')).toBe(true);
    expect(isRunbookPath('runbook/incident/timeline')).toBe(true);
    expect(isRunbookPath('runbook/notes.md')).toBe(false);
    expect(isRunbookPath('runbook.json')).toBe(false);
    expect(isRunbookPath('change/notes')).toBe(false);
  });
});

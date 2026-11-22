import {
  EMPTY_CHANGE_REQUEST, changeFloorIds, changeFloorSentence, changeRequestCarried, changeRequestChangeSet, changeRequestReviewProjection,
  coveredAcceptance, evaluateChangeFloor, impactEntries, isChangePath, serialiseChangeRequest, type ChangeFloorSpec, type ChangeRequest,
} from './change-record';

const ticket = { id: 'CR-2', title: 'Comments', summary: 's', acceptance: [{ id: 'AC-1', line: 'one' }, { id: 'AC-2', line: 'two' }, { id: 'AC-3', line: 'three' }] };
const spec: ChangeFloorSpec = { contract: true, ticket, floor: { minImpact: 3, minContract: 2, minTests: 2, requireRelease: true, traceEveryAcceptance: true } };
const good: ChangeRequest = {
  impact: { operations: ['listComments', 'addComment'], screens: [], files: ['api/routes/comments.py'] },
  contract: [
    { id: 'C1', method: 'GET', path: '/api/tasks/{id}/comments', change: 'added', why: 'reads comments' },
    { id: 'C2', method: 'POST', path: '/api/tasks/{id}/comments', change: 'added', why: 'adds one' },
  ],
  tests: [
    { id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1', 'AC-2'], result: 'pass' },
    { id: 'T2', suite: 'web TaskRow', covers: ['AC-3'], result: 'not-run' },
  ],
  release: { version: '2.1.0', summary: 'Comments', changes: [{ id: 'L1', line: 'Comments on a task', covers: [] }], rollback: 'redeploy 2.0.0' },
};
const text = (c: ChangeRequest) => serialiseChangeRequest(c);
const rule = (c: ChangeRequest | string, id: string, s = spec) => evaluateChangeFloor(typeof c === 'string' ? c : text(c), s).find((r) => r.id === id);

describe('evaluateChangeFloor', () => {
  it('passes a full change request on every rule, in the fixed order, with the contract rule only when on', () => {
    const out = evaluateChangeFloor(text(good), spec);
    expect(out.map((r) => r.id)).toEqual(['change.record', 'change.impact.min', 'change.contract.min', 'change.tests.min', 'change.release', 'change.trace', 'change.named']);
    expect(out.every((r) => r.passed)).toBe(true);
    expect(evaluateChangeFloor(text(good), { ...spec, contract: false }).map((r) => r.id)).not.toContain('change.contract.min');
    expect(changeFloorIds(false)).toEqual(['change.record', 'change.impact.min', 'change.tests.min', 'change.release', 'change.trace', 'change.named']);
  });
  it('labels every rule and says what passed, plural and singular', () => {
    expect(evaluateChangeFloor(text(good), spec).map(({ label, detail }) => [label, detail])).toEqual([
      ['The change request record', 'The record is well formed'],
      ['At least 3 impact entries', '3 entries named in the impact'],
      ['At least 2 contract amendments', '2 contract amendments with a method, a path and a reason'],
      ['At least 2 tests', '2 tests naming a suite and the acceptance items they cover'],
      ['The release is recorded', 'The release has a version and a change line'],
      ['Every acceptance item is covered', 'Every acceptance item is covered'],
      ['Every change request item is named', 'Every change request item is named'],
    ]);
    const one: ChangeRequest = { ...good, impact: { operations: ['listComments'], screens: [], files: [] }, contract: [good.contract[0]], tests: [{ ...good.tests[0], covers: ['AC-1', 'AC-2', 'AC-3'] }] };
    const ones = { ...spec, floor: { ...spec.floor, minImpact: 1, minContract: 1, minTests: 1 } };
    expect(evaluateChangeFloor(text(one), ones).filter((r) => r.id.endsWith('.min')).map(({ label, detail }) => [label, detail])).toEqual([
      ['At least 1 impact entry', '1 entry named in the impact'],
      ['At least 1 contract amendment', '1 contract amendment with a method, a path and a reason'],
      ['At least 1 test', '1 test naming a suite and the acceptance items it covers'],
    ]);
  });
  it('fails each minimum with its sentence, singular and plural', () => {
    expect(rule({ ...good, impact: { operations: ['a'], screens: [' '], files: [] } }, 'change.impact.min')?.detail).toBe('Fewer than 3 operations, screens or files named in the impact');
    expect(rule({ ...good, impact: { operations: [], screens: [], files: [] } }, 'change.impact.min', { ...spec, floor: { ...spec.floor, minImpact: 1 } })?.detail).toBe('Fewer than 1 operation, screen or file named in the impact');
    expect(rule({ ...good, contract: [{ ...good.contract[0], why: '' }, good.contract[1]] }, 'change.contract.min')?.detail).toBe('Fewer than 2 contract amendments with a method, a path and a reason');
    expect(rule({ ...good, tests: [good.tests[0], { ...good.tests[1], covers: [] }] }, 'change.tests.min')?.detail).toBe('Fewer than 2 tests naming a suite and the acceptance items they cover');
    expect(rule({ ...good, tests: [] }, 'change.tests.min', { ...spec, floor: { ...spec.floor, minTests: 1 } })?.detail).toBe('Fewer than 1 test naming a suite and the acceptance items it covers');
  });
  it('asks the release for a version and a named change line', () => {
    expect(rule({ ...good, release: { ...good.release, version: ' ' } }, 'change.release')?.detail).toBe('The release has no version or no change line');
    expect(rule({ ...good, release: { ...good.release, changes: [{ id: 'L1', line: '', covers: ['AC-1'] }] } }, 'change.release')?.passed).toBe(false);
    expect(rule(text(EMPTY_CHANGE_REQUEST), 'change.release', { ...spec, floor: { ...spec.floor, requireRelease: false } })).toMatchObject({ passed: true, detail: 'Not required' });
  });
  it('traces by covers ids of named items only, in ticket order, singular and plural', () => {
    const twoLeft = { ...good, tests: [{ ...good.tests[0], covers: ['AC-2'] }] };
    expect(rule(twoLeft, 'change.trace')?.detail).toBe('Acceptance items not covered by any change line or test: AC-1, AC-3');
    const unnamedLine = { ...good, tests: [{ ...good.tests[0], covers: ['AC-1', 'AC-3'] }], release: { ...good.release, changes: [{ id: 'L1', line: ' ', covers: ['AC-2'] }] } };
    expect(rule(unnamedLine, 'change.trace')?.detail).toBe('Acceptance item not covered by any change line or test: AC-2');
    const uncited: ChangeRequest = { ...good, tests: good.tests.map((t) => ({ ...t, covers: [] })) };
    const noAcceptance = { ...spec, ticket: { ...ticket, acceptance: [] } };
    expect(rule(uncited, 'change.record', noAcceptance)?.passed).toBe(true);
    expect(rule(uncited, 'change.trace', noAcceptance)).toMatchObject({ passed: true, detail: 'No acceptance items to trace' });
    expect(rule(twoLeft, 'change.trace', { ...spec, floor: { ...spec.floor, traceEveryAcceptance: false } })).toMatchObject({ passed: true, detail: 'Not required' });
  });
  it('counts unnamed items, the contract paths only when the contract is on', () => {
    const blanks = { ...good, impact: { ...good.impact, screens: [''] }, contract: [{ ...good.contract[0], path: '' }] };
    expect(rule(blanks, 'change.named')?.detail).toBe('2 items in the change request have no name');
    expect(rule(blanks, 'change.named', { ...spec, contract: false })?.detail).toBe('1 item in the change request has no name');
  });
  it('fails the record rule on a covers id outside the ticket', () => {
    const stray = { ...good, tests: [{ ...good.tests[0], covers: ['AC-9'] }] };
    expect(rule(stray, 'change.record')).toEqual({ id: 'change.record', label: 'The change request record', passed: false, detail: 'The change request record is missing or not valid' });
  });
  it('restates the floor in one line', () => {
    expect(changeFloorSentence(spec.floor, true)).toBe('at least 3 operations, screens or files in the impact; at least 2 contract amendments with a method, a path and a reason; at least 2 tests naming a suite and the acceptance items they cover; a release with a version and a change line; every acceptance item covered by a test or a change line; every item named');
    expect(changeFloorSentence({ ...spec.floor, minTests: 1 }, false)).toBe('at least 3 operations, screens or files in the impact; at least 1 test naming a suite and the acceptance items it covers; a release with a version and a change line; every acceptance item covered by a test or a change line; every item named');
  });
});

describe('the projection, the change set and the carried list', () => {
  it('cites one path per field, the contract only when on', () => {
    const p = changeRequestReviewProjection(text({ ...good, release: { ...good.release, risks: ['a', 'b'] }, notes: 'n' }), true);
    expect(p['change/impact/operations']).toBe('listComments\naddComment');
    expect(p['change/contract-2/path']).toBe('C2: /api/tasks/{id}/comments');
    expect(p['change/test-1/covers']).toBe('AC-1, AC-2');
    expect(p['change/test-2/suite']).toBe('T2: web TaskRow');
    expect(p['change/release/version']).toBe('2.1.0');
    expect(p['change/release/risks']).toBe('a\nb');
    expect(p['change/release/change-1/line']).toBe('L1: Comments on a task');
    expect(p['change/notes']).toBe('n');
    expect(Object.keys(changeRequestReviewProjection(text(good), false)).some((path) => path.startsWith('change/contract-'))).toBe(false);
  });
  it('is complete: every leaf appears in the projection, the contract only when on', () => {
    const c: ChangeRequest = { ...good, impact: { ...good.impact, screens: ['#/tasks'] }, release: { ...good.release, risks: ['r1'] }, notes: 'kept' };
    const values = Object.values(changeRequestReviewProjection(text(c), true)).join('\n');
    const leaves = [...c.impact.operations, ...c.impact.screens, ...c.impact.files, ...c.contract.flatMap((a) => [a.method, a.path, a.change, a.why]),
      ...c.tests.flatMap((t) => [t.suite, t.covers.join(', '), t.result]), c.release.version, c.release.summary, c.release.rollback, ...(c.release.risks ?? []),
      ...c.release.changes.flatMap((l) => [l.line, l.covers.join(', ')]), c.notes!].filter(Boolean);
    for (const leaf of leaves) expect(values).toContain(leaf);
    // exactly one path: a leaf the record holds once is the whole value of one path, follows its id there, or is one line of one list path
    const p = Object.values(changeRequestReviewProjection(text(c), true));
    const once = leaves.filter((leaf) => leaves.indexOf(leaf) === leaves.lastIndexOf(leaf));
    for (const leaf of once) expect(p.filter((v) => v === leaf || v.endsWith(`: ${leaf}`) || v.split('\n').includes(leaf))).toHaveLength(1);
    const off = Object.values(changeRequestReviewProjection(text(c), false)).join('\n');
    for (const amendment of c.contract) expect(off).not.toContain(amendment.why);
  });
  it('numbers by the earlier ids and ignores a switched-off contract', () => {
    const changes = changeRequestChangeSet(text(good), text({ ...good, tests: [good.tests[1]] }), true);
    expect(changes.map((c) => c.path)).toEqual(['change/test-1/suite', 'change/test-1/covers', 'change/test-1/result']);
    expect(changeRequestChangeSet(text(good), text({ ...good, contract: [] }), false)).toEqual([]);
  });
  it('carries every id; the contract ids only when on', () => {
    expect(changeRequestCarried(text(good), true)).toEqual(['contract amendment C1', 'contract amendment C2', 'test T1', 'test T2', 'change line L1']);
    expect(changeRequestCarried(text(good), false)).toEqual(['test T1', 'test T2', 'change line L1']);
  });
});

describe('the floor\'s counters and the review path test', () => {
  it('counts non-blank impact entries over the three lists', () => {
    expect(impactEntries(good)).toBe(3);
    expect(impactEntries({ ...good, impact: { operations: [' '], screens: ['#/tasks', ''], files: [] } })).toBe(1);
    expect(impactEntries(EMPTY_CHANGE_REQUEST)).toBe(0);
  });
  it('collects the acceptance ids of named tests and named change lines only', () => {
    expect([...coveredAcceptance(good)].sort()).toEqual(['AC-1', 'AC-2', 'AC-3']);
    const unnamed: ChangeRequest = {
      ...good, tests: [{ ...good.tests[0], suite: ' ' }, good.tests[1]],
      release: { ...good.release, changes: [{ id: 'L1', line: 'named', covers: ['AC-1'] }, { id: 'L2', line: '', covers: ['AC-2'] }] },
    };
    expect([...coveredAcceptance(unnamed)].sort()).toEqual(['AC-1', 'AC-3']);
  });
  it('takes a change review path and refuses a file under a change folder or another root', () => {
    expect(isChangePath('change/release/version')).toBe(true);
    expect(isChangePath('change/test-1/covers')).toBe(true);
    expect(isChangePath('change/notes.md')).toBe(false);
    expect(isChangePath('change-request.json')).toBe(false);
    expect(isChangePath('runbook/notes')).toBe(false);
  });
});

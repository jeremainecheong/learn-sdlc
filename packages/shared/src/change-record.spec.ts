import {
  CHANGE_CAPS, DEFAULT_CHANGE_FLOOR, EMPTY_CHANGE_REQUEST, ONLY_MAINTENANCE_CHANGE, changeRequestSaveRefusal, serialiseChangeRequest,
  validateChangeRequestRecord, validateChangeTicket, type ChangeRequest,
} from './change-record';

const AC = ['AC-1', 'AC-2'];
const full: ChangeRequest = {
  impact: { operations: ['listComments'], screens: ['#/lists/1'], files: ['api/routes/comments.py'] },
  contract: [{ id: 'C1', method: 'GET', path: '/api/tasks/{id}/comments', change: 'added', why: 'CR-2 reads comments' }],
  tests: [{ id: 'T1', suite: 'tests/test_comments_api.py', covers: ['AC-1'], result: 'pass' }],
  release: { version: '2.1.0', summary: 'Comments on a task', changes: [{ id: 'L1', line: 'Comments can be added', covers: ['AC-2'] }], rollback: 'Redeploy 2.0.0', risks: ['none'] },
  notes: 'n',
};

describe('validateChangeRequestRecord', () => {
  it('accepts a full record, keeps the schema keys in order and drops the rest', () => {
    const out = validateChangeRequestRecord(JSON.stringify({ ...full, extra: true, release: { ...full.release, tag: 'v' } }), AC);
    expect(out.error).toBeNull();
    expect(Object.keys(out.change!)).toEqual(['impact', 'contract', 'tests', 'release', 'notes']);
    expect(Object.keys(out.change!.release)).toEqual(['version', 'summary', 'changes', 'rollback', 'risks']);
  });
  it('round-trips, and the empty record is valid against any ticket', () => {
    const text = serialiseChangeRequest(full);
    expect(serialiseChangeRequest(validateChangeRequestRecord(text, AC).change!)).toBe(text);
    expect(validateChangeRequestRecord(serialiseChangeRequest(EMPTY_CHANGE_REQUEST), []).error).toBeNull();
    expect(EMPTY_CHANGE_REQUEST).toEqual({ impact: { operations: [], screens: [], files: [] }, contract: [], tests: [], release: { version: '', summary: '', changes: [], rollback: '' } });
  });
  it('accepts every list at 20 entries, 12 covers, a method of 16, a version of 40 and every text at 2000 characters', () => {
    const twelve = Array.from({ length: CHANGE_CAPS.covers }, (_, i) => `AC-${i + 1}`);
    const atCap: ChangeRequest = {
      impact: { operations: Array.from({ length: 20 }, () => 'o'.repeat(2000)), screens: Array.from({ length: 20 }, () => 's'), files: Array.from({ length: 20 }, () => 'f') },
      contract: Array.from({ length: 20 }, (_, i) => ({ id: `C${i + 1}`, method: 'M'.repeat(CHANGE_CAPS.method), path: 'p'.repeat(2000), change: 'changed' as const, why: 'w'.repeat(2000) })),
      tests: Array.from({ length: 20 }, (_, i) => ({ id: `T${i + 1}`, suite: 's'.repeat(2000), covers: twelve, result: 'not-run' as const })),
      release: { version: '9'.repeat(CHANGE_CAPS.version), summary: 's'.repeat(2000), changes: Array.from({ length: 20 }, (_, i) => ({ id: `L${i + 1}`, line: 'l'.repeat(2000), covers: twelve })), rollback: 'r'.repeat(2000), risks: Array.from({ length: 20 }, () => 'r') },
      notes: 'n'.repeat(2000),
    };
    expect(validateChangeRequestRecord(JSON.stringify(atCap), twelve).error).toBeNull();
  });
  it('accepts a covers item of exactly 16 characters, with or without the ticket', () => {
    const id = 'A'.repeat(CHANGE_CAPS.acceptanceId);
    const text = JSON.stringify({ ...full, tests: [{ ...full.tests[0], covers: [id] }] });
    expect(validateChangeRequestRecord(text, [...AC, id]).error).toBeNull();
    expect(validateChangeRequestRecord(text, null).error).toBeNull();
  });
  it('checks covers against the ticket only when the ticket is given', () => {
    const unknown = JSON.stringify({ ...full, tests: [{ ...full.tests[0], covers: ['AC-9'] }] });
    expect(validateChangeRequestRecord(unknown, AC).error).toBe('test T1 covers AC-9, which is not an acceptance item of the ticket');
    expect(validateChangeRequestRecord(unknown, null).error).toBeNull();
  });
  it.each([
    ['not json', '{', 'The change request record is not valid JSON'],
    ['impact as a list', JSON.stringify({ ...full, impact: [] }), 'impact is not an object'],
    ['21 screens', JSON.stringify({ ...full, impact: { ...full.impact, screens: Array.from({ length: 21 }, () => 's') } }), 'impact screens has more than 20 items'],
    ['a long method', JSON.stringify({ ...full, contract: [{ ...full.contract[0], method: 'G'.repeat(17) }] }), 'contract amendment C1 method is longer than 16 characters'],
    ['an unknown change', JSON.stringify({ ...full, contract: [{ ...full.contract[0], change: 'renamed' }] }), 'contract amendment C1 has an unknown change'],
    ['an unknown result', JSON.stringify({ ...full, tests: [{ ...full.tests[0], result: 'green' }] }), 'test T1 has an unknown result'],
    ['13 covers', JSON.stringify({ ...full, tests: [{ ...full.tests[0], covers: Array.from({ length: 13 }, () => 'AC-1') }] }), 'test T1 covers has more than 12 items'],
    ['a long cover', JSON.stringify({ ...full, release: { ...full.release, changes: [{ ...full.release.changes[0], covers: ['A'.repeat(17)] }] } }), 'change line L1 covers item 1 is not text of at most 16 characters'],
    ['a long version', JSON.stringify({ ...full, release: { ...full.release, version: '1'.repeat(41) } }), 'release version is longer than 40 characters'],
    ['21 risks', JSON.stringify({ ...full, release: { ...full.release, risks: Array.from({ length: 21 }, () => 'r') } }), 'release risks has more than 20 items'],
    ['a repeated change line id', JSON.stringify({ ...full, release: { ...full.release, changes: [full.release.changes[0], full.release.changes[0]] } }), 'change line id L1 is used twice'],
    ['changes as text', JSON.stringify({ ...full, release: { ...full.release, changes: 'x' } }), 'release changes is not a list'],
  ])('refuses %s', (_name, text, message) => {
    expect(validateChangeRequestRecord(text, AC).error).toBe(message);
  });
  it('says the save refusal in one sentence', () => {
    expect(changeRequestSaveRefusal('notes is not text')).toBe('The change request was not saved: notes is not text.');
  });
  it('holds the defaults, and the empty record is frozen all the way down', () => {
    expect(DEFAULT_CHANGE_FLOOR).toEqual({ minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true });
    for (const frozen of [EMPTY_CHANGE_REQUEST, EMPTY_CHANGE_REQUEST.impact, EMPTY_CHANGE_REQUEST.impact.operations, EMPTY_CHANGE_REQUEST.impact.screens,
      EMPTY_CHANGE_REQUEST.impact.files, EMPTY_CHANGE_REQUEST.contract, EMPTY_CHANGE_REQUEST.tests, EMPTY_CHANGE_REQUEST.release, EMPTY_CHANGE_REQUEST.release.changes]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });
  it('says which phase carries a ticket and a change request, once, for the loader and the authoring door', () => {
    expect(ONLY_MAINTENANCE_CHANGE).toBe('Only Maintenance carries a ticket and a change request.');
  });
});

describe('validateChangeTicket', () => {
  const ticket = { id: 'CR-2', title: 'Comments on a task', summary: 'Let people comment.', acceptance: [{ id: 'AC-1', line: 'add_comment stores one comment.' }] };
  it('accepts a ticket and keeps only its keys', () => {
    expect(validateChangeTicket({ ...ticket, extra: 1 })).toEqual(ticket);
  });
  it('accepts a ticket at every cap', () => {
    const atCap = {
      id: 'C'.repeat(CHANGE_CAPS.ticketId), title: 't'.repeat(CHANGE_CAPS.ticketTitle), summary: 's'.repeat(CHANGE_CAPS.ticketSummary),
      acceptance: Array.from({ length: CHANGE_CAPS.acceptance }, (_, i) => ({ id: `${i + 1}`.padStart(CHANGE_CAPS.acceptanceId, 'A'), line: 'x'.repeat(CHANGE_CAPS.acceptanceLine) })),
    };
    expect(validateChangeTicket(atCap)).toEqual(atCap);
  });
  it.each([
    ['not an object', [], 'ticket must be an object.'],
    ['a blank id', { ...ticket, id: ' ' }, 'The ticket needs an id.'],
    ['a long id', { ...ticket, id: 'C'.repeat(17) }, 'A ticket id is at most 16 characters.'],
    ['a blank title', { ...ticket, title: '' }, 'The ticket needs a title.'],
    ['a long title', { ...ticket, title: 't'.repeat(401) }, 'The ticket title is at most 400 characters.'],
    ['a long summary', { ...ticket, summary: 's'.repeat(2001) }, 'The ticket summary is at most 2000 characters.'],
    ['13 acceptance lines', { ...ticket, acceptance: Array.from({ length: 13 }, (_, i) => ({ id: `AC-${i + 1}`, line: 'x' })) }, 'A ticket has at most 12 acceptance lines.'],
    ['a repeated acceptance id', { ...ticket, acceptance: [ticket.acceptance[0], ticket.acceptance[0]] }, 'Acceptance ids are unique: AC-1 is used twice.'],
    ['a blank acceptance line', { ...ticket, acceptance: [{ id: 'AC-1', line: ' ' }] }, 'Acceptance AC-1 needs a line.'],
    ['a long acceptance line', { ...ticket, acceptance: [{ id: 'AC-1', line: 'x'.repeat(401) }] }, 'Acceptance AC-1 is longer than 400 characters.'],
    ['a summary that is a number', { ...ticket, summary: 1 }, 'The ticket summary must be text.'],
    ['acceptance that is not a list', { ...ticket, acceptance: 'AC-1' }, 'The ticket acceptance lines must be a list.'],
    ['an acceptance line that is text', { ...ticket, acceptance: ['AC-1'] }, 'Acceptance line 1 must be an object.'],
    ['an acceptance line with no id', { ...ticket, acceptance: [{ id: ' ', line: 'x' }] }, 'Acceptance line 1 needs an id.'],
    ['a 17-character acceptance id', { ...ticket, acceptance: [{ id: 'A'.repeat(17), line: 'x' }] }, 'Acceptance line 1 has an id longer than 16 characters.'],
  ])('refuses %s', (_name, raw, message) => {
    expect(() => validateChangeTicket(raw)).toThrow(message);
  });
});

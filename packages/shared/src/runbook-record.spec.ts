import {
  DEFAULT_RUNBOOK_FLOOR, EMPTY_RUNBOOK, ONLY_DEPLOYMENT_RUNBOOK, RUNBOOK_CAPS, defaultRunbookFloor, incidentIsEmpty, nextItemId, runbookSaveRefusal,
  serialiseRunbook, validateRunbookRecord, type Runbook,
} from './runbook-record';

const full: Runbook = {
  environment: [{ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'Where the database file lives; default /data/tasktrackr.db.', kind: 'config', example: '/data/tasktrackr.db' }],
  health: [{ id: 'H1', name: 'API healthcheck', how: 'python3 api/main.py --selfcheck', expected: 'selfcheck: web reaches api' }],
  rollback: [{ id: 'R1', step: 'docker compose up -d with the previous tag', verify: 'The selfcheck passes again.' }],
  data: [{ id: 'D1', what: 'The database file', how: 'Copied nightly', where: 'The tasktrackr-data volume', retention: '7 days' }],
  incident: { rootCause: 'API_URL named localhost', fix: 'API_URL is http://api:8000', actionItem: 'Add a compose check to CI', timeline: [{ at: '2026-10-15T01:00:00Z', event: 'Paged' }] },
  notes: 'none',
};

describe('validateRunbookRecord', () => {
  it('accepts a full record and stores only the schema keys, in the schema order', () => {
    const out = validateRunbookRecord(JSON.stringify({ ...full, extra: 1, environment: [{ ...full.environment[0], colour: 'red' }] }));
    expect(out.error).toBeNull();
    expect(Object.keys(out.runbook!)).toEqual(['environment', 'health', 'rollback', 'data', 'incident', 'notes']);
    expect(Object.keys(out.runbook!.environment[0])).toEqual(['id', 'name', 'purpose', 'kind', 'example']);
    expect(Object.keys(out.runbook!.incident)).toEqual(['rootCause', 'fix', 'actionItem', 'timeline']);
  });
  it('reads null as absent for every optional field', () => {
    const out = validateRunbookRecord(JSON.stringify({ ...full, notes: null, environment: [{ ...full.environment[0], example: null }], data: [{ ...full.data[0], retention: null }], incident: { ...full.incident, timeline: null } }));
    expect(out.error).toBeNull();
    expect('notes' in out.runbook!).toBe(false);
    expect('example' in out.runbook!.environment[0]).toBe(false);
    expect('retention' in out.runbook!.data[0]).toBe(false);
    expect('timeline' in out.runbook!.incident).toBe(false);
  });
  it('round-trips through serialiseRunbook byte for byte, and the empty record is valid', () => {
    const text = serialiseRunbook(full);
    expect(text.endsWith('}\n')).toBe(true);
    expect(serialiseRunbook(validateRunbookRecord(text).runbook!)).toBe(text);
    expect(validateRunbookRecord(serialiseRunbook(EMPTY_RUNBOOK)).error).toBeNull();
  });
  it('accepts every list at its cap, every text at 2000 characters, and a timeline at 20 with each `at` at 40 characters', () => {
    const t = (c: string) => c.repeat(RUNBOOK_CAPS.fieldChars);
    const atCap = <T>(make: (i: number) => T) => Array.from({ length: RUNBOOK_CAPS.listItems }, (_, i) => make(i));
    const runbook: Runbook = {
      environment: atCap((i) => ({ id: `E${i + 1}`, name: t('n'), purpose: t('p'), kind: 'secret', example: t('x') })),
      health: atCap((i) => ({ id: `H${i + 1}`, name: t('n'), how: t('h'), expected: t('e') })),
      rollback: atCap((i) => ({ id: `R${i + 1}`, step: t('s'), verify: t('v') })),
      data: atCap((i) => ({ id: `D${i + 1}`, what: t('w'), how: t('h'), where: t('w'), retention: t('r') })),
      incident: {
        rootCause: t('c'), fix: t('f'), actionItem: t('a'),
        timeline: Array.from({ length: RUNBOOK_CAPS.timeline }, () => ({ at: 'x'.repeat(RUNBOOK_CAPS.timelineAt), event: t('e') })),
      },
      notes: t('n'),
    };
    expect(validateRunbookRecord(JSON.stringify(runbook)).error).toBeNull();
  });
  it('accepts an item id of exactly 16 characters', () => {
    const out = validateRunbookRecord(JSON.stringify({ ...full, health: [{ ...full.health[0], id: 'H'.repeat(RUNBOOK_CAPS.itemId) }] }));
    expect(out.error).toBeNull();
  });
  it.each([
    ['not json', '{', 'The runbook record is not valid JSON'],
    ['not an object', '[]', 'The runbook record is not an object'],
    ['no health list', JSON.stringify({ ...full, health: undefined }), 'health is not a list'],
    ['21 rollback steps', JSON.stringify({ ...full, rollback: Array.from({ length: 21 }, (_, i) => ({ id: `R${i + 1}`, step: 's', verify: 'v' })) }), 'more than 20 rollback steps'],
    ['an entry that is text', JSON.stringify({ ...full, data: ['x'] }), 'data entry 1 is not an object'],
    ['no id', JSON.stringify({ ...full, health: [{ ...full.health[0], id: ' ' }] }), 'health check 1 has no id'],
    ['a long id', JSON.stringify({ ...full, health: [{ ...full.health[0], id: 'H'.repeat(17) }] }), 'health check 1 has an id longer than 16 characters'],
    ['a repeated id', JSON.stringify({ ...full, environment: [full.environment[0], { ...full.environment[0] }] }), 'environment entry id E1 is used twice'],
    ['a name over the cap', JSON.stringify({ ...full, environment: [{ ...full.environment[0], name: 'n'.repeat(2001) }] }), 'environment entry E1 name is longer than 2000 characters'],
    ['an unknown kind', JSON.stringify({ ...full, environment: [{ ...full.environment[0], kind: 'flag' }] }), 'environment entry E1 has an unknown kind'],
    ['a step that is a number', JSON.stringify({ ...full, rollback: [{ ...full.rollback[0], step: 1 }] }), 'rollback step R1 step is not text'],
    ['no incident', JSON.stringify({ ...full, incident: undefined }), 'incident is not an object'],
    ['21 timeline entries', JSON.stringify({ ...full, incident: { ...full.incident, timeline: Array.from({ length: 21 }, () => ({ at: 'a', event: 'e' })) } }), 'more than 20 timeline entries'],
    ['a long at', JSON.stringify({ ...full, incident: { ...full.incident, timeline: [{ at: 'x'.repeat(41), event: 'e' }] } }), 'timeline entry 1 at is longer than 40 characters'],
    ['long notes', JSON.stringify({ ...full, notes: 'x'.repeat(2001) }), 'notes is longer than 2000 characters'],
  ])('refuses %s', (_name, text, message) => {
    const out = validateRunbookRecord(text);
    expect(out.runbook).toBeNull();
    expect(out.error).toBe(message);
  });
});

describe('defaults, ids and sentences', () => {
  it('holds the default floor and the empty runbook', () => {
    expect(DEFAULT_RUNBOOK_FLOOR).toEqual({ minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: false });
    expect(defaultRunbookFloor(true).requireIncident).toBe(true);
    expect(EMPTY_RUNBOOK).toEqual({ environment: [], health: [], rollback: [], data: [], incident: { rootCause: '', fix: '', actionItem: '' } });
    expect(Object.isFrozen(EMPTY_RUNBOOK.environment)).toBe(true);
  });
  it('mints the next free number after the letter', () => {
    expect(nextItemId([], 'E')).toBe('E1');
    expect(nextItemId(['E1', 'E3'], 'E')).toBe('E4');
    expect(nextItemId(['X9', 'E2'], 'E')).toBe('E3');
    expect(nextItemId(['AC-1', 'AX2'], 'AC-')).toBe('AC-2');
    expect(nextItemId(['AX2'], 'A.')).toBe('A.1');
  });
  it('reads an incident as empty only with three blank fields and no timeline', () => {
    expect(incidentIsEmpty({ rootCause: ' ', fix: '', actionItem: '' })).toBe(true);
    expect(incidentIsEmpty({ rootCause: '', fix: '', actionItem: '', timeline: [{ at: 'a', event: 'e' }] })).toBe(false);
  });
  it('says the save refusal in one sentence', () => {
    expect(runbookSaveRefusal('notes is longer than 2000 characters')).toBe('The runbook was not saved: notes is longer than 2000 characters.');
  });
  it('says which phase carries a runbook, once, for the loader and the authoring door', () => {
    expect(ONLY_DEPLOYMENT_RUNBOOK).toBe('Only Deployment carries a runbook.');
  });
});

import { isAuthorableTask, splittableCheckKind } from './authoring';
import {
  DEFAULT_DESIGN_CONTRACTS, DEFAULT_DESIGN_FLOOR, DEFAULT_DESIGN_SEQUENCE, DESIGN_RELATION_KINDS, EMPTY_DESIGN, ENTITY_KINDS, designDocumentPaths, foldLegacyDesign, isLegacyDesignShape,
  decidedOn, designDocumentError, readDesignRecord, serialiseDesign, validateApiContract, validateDesignRecord, validateScreenContract, type Design,
} from './design-record';

const full: Design = {
  entities: [
    { id: 'E1', name: 'Task', kind: 'class', attributes: [{ name: 'due_date', type: 'date', note: 'null is never overdue' }, { name: 'status' }], responsibilities: ['knows when it is overdue'], satisfies: ['US-4'] },
    { id: 'E2', name: 'List', kind: 'class', attributes: [{ name: 'id', type: 'integer' }], responsibilities: [], satisfies: ['US-1'] },
  ],
  relations: [{ id: 'R1', from: 'E2', to: 'E1', kind: 'composition', fromCard: '1', toCard: '*', label: 'holds' }],
  operations: [{ id: 'O1', name: 'getOverdue(today)', inputs: ['today'], returns: 'Task[]', errors: ['invalid_date'], satisfies: ['US-4'], note: 'boundary: due today is not overdue' }],
  decisions: [{ id: 'D1', title: 'Clock from the caller', choice: 'today is a parameter', alternative: 'the server clock', rationale: 'tests replay one boundary', tradeOff: 'every caller sends a date', context: 'the report and its tests must agree on today', consequences: ['every caller sends a date', 'replays are exact'], status: 'accepted', satisfies: ['US-4'], decidedAt: '2026-10-14T00:00:00Z' }],
  sequence: 'Browser -> Api: getOverdue(today)',
  notes: 'none',
};

describe('validateDesignRecord', () => {
  it('accepts a full record and stores only the schema keys', () => {
    const out = validateDesignRecord(JSON.stringify({ ...full, fields: [], board: 1, entities: [{ ...full.entities[0], colour: 'red' }, full.entities[1]] }));
    expect(out.error).toBeNull();
    expect(Object.keys(out.design!)).toEqual(['entities', 'relations', 'operations', 'decisions', 'sequence', 'notes']);
    expect(Object.keys(out.design!.entities[0])).toEqual(['id', 'name', 'kind', 'attributes', 'responsibilities', 'satisfies']);
    expect(Object.keys(out.design!.relations[0])).toEqual(['id', 'from', 'to', 'kind', 'fromCard', 'toCard', 'label']);
    expect(Object.keys(out.design!.operations[0])).toEqual(['id', 'name', 'inputs', 'returns', 'errors', 'satisfies', 'note']);
    expect(Object.keys(out.design!.decisions[0])).toEqual(['id', 'title', 'choice', 'alternative', 'rationale', 'tradeOff', 'context', 'consequences', 'status', 'satisfies', 'decidedAt']);
  });
  it('keeps a superseded decision\'s link as a field, and reads a null link as none', () => {
    const out = validateDesignRecord(JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], status: 'superseded', supersededBy: 'D2' }, { ...full.decisions[0], id: 'D2', supersededBy: null }] }));
    expect(out.error).toBeNull();
    expect(Object.keys(out.design!.decisions[0])).toEqual(['id', 'title', 'choice', 'alternative', 'rationale', 'tradeOff', 'context', 'consequences', 'status', 'supersededBy', 'satisfies', 'decidedAt']);
    expect(out.design!.decisions[0].supersededBy).toBe('D2');
    expect('supersededBy' in out.design!.decisions[1]).toBe(false);
  });
  it('accepts what the board lets a learner save: 30 responsibilities and 6 consequences, blank lines included', () => {
    const out = validateDesignRecord(JSON.stringify({ ...full,
      entities: [{ ...full.entities[0], responsibilities: Array.from({ length: 30 }, (_, i) => (i === 29 ? '' : `r${i}`)) }, full.entities[1]],
      decisions: [{ ...full.decisions[0], consequences: ['one', '', 'three', 'four', 'five', 'six'] }] }));
    expect(out.error).toBeNull();
    expect(out.design!.entities[0].responsibilities).toHaveLength(30);
    expect(out.design!.decisions[0].consequences).toEqual(['one', '', 'three', 'four', 'five', 'six']);
  });
  it('accepts a dependency relation with no cardinalities and an operation with no note', () => {
    const out = validateDesignRecord(JSON.stringify({ ...full, relations: [{ id: 'R1', from: 'E1', to: 'E2', kind: 'dependency' }], operations: [{ ...full.operations[0], note: undefined }] }));
    expect(out.error).toBeNull();
    expect(out.design!.relations[0]).toEqual({ id: 'R1', from: 'E1', to: 'E2', kind: 'dependency' });
    expect('note' in out.design!.operations[0]).toBe(false);
  });
  it('round-trips through serialiseDesign byte for byte', () => {
    const text = serialiseDesign(full);
    expect(text.endsWith('}\n')).toBe(true);
    expect(serialiseDesign(validateDesignRecord(text).design!)).toBe(text);
  });
  it('accepts the empty record', () => {
    expect(validateDesignRecord(serialiseDesign(EMPTY_DESIGN)).error).toBeNull();
  });
  it('reads null as absent in every optional text field, as an Agentic proposal writes it', () => {
    const out = validateDesignRecord(JSON.stringify({
      ...full,
      entities: [{ ...full.entities[0], attributes: [{ name: 'due_date', type: null, note: null }] }, full.entities[1]],
      relations: [{ ...full.relations[0], fromCard: null, toCard: null, label: null }],
      operations: [{ ...full.operations[0], note: null }],
      decisions: [{ ...full.decisions[0], context: null }],
      sequence: null,
      notes: null,
    }));
    expect(out.error).toBeNull();
    expect(out.design!.entities[0].attributes).toEqual([{ name: 'due_date' }]);
    expect(out.design!.relations[0]).toEqual({ id: 'R1', from: 'E2', to: 'E1', kind: 'composition' });
    expect('note' in out.design!.operations[0]).toBe(false);
    expect('context' in out.design!.decisions[0]).toBe(false);
    expect(Object.keys(out.design!)).toEqual(['entities', 'relations', 'operations', 'decisions']);
  });
  it.each([
    ['not json', '{', 'The design record is not valid JSON'],
    ['not an object', '[]', 'The design record is not an object'],
    ['no entities list', JSON.stringify({ ...full, entities: undefined }), 'entities is not a list'],
    ['21 entities', JSON.stringify({ ...full, entities: Array.from({ length: 21 }, (_, i) => ({ id: `E${i + 1}`, name: 'x', kind: 'class', attributes: [], responsibilities: [], satisfies: [] })), relations: [] }), 'more than 20 entities'],
    ['31 attributes', JSON.stringify({ ...full, entities: [{ ...full.entities[0], attributes: Array.from({ length: 31 }, () => ({ name: 'a' })) }, full.entities[1]] }), 'entity E1 has more than 30 attributes'],
    ['duplicate id', JSON.stringify({ ...full, entities: [full.entities[0], { ...full.entities[1], id: 'E1' }], relations: [] }), 'entity id E1 is used twice'],
    ['long id', JSON.stringify({ ...full, operations: [{ ...full.operations[0], id: 'O'.repeat(17) }] }), 'operation 1 has an id longer than 16 characters'],
    ['a relation end longer than an id', JSON.stringify({ ...full, relations: [{ ...full.relations[0], to: 'E'.repeat(17) }] }), 'relation R1 points at an id longer than 16 characters, which is not an entity'],
    ['dangling relation', JSON.stringify({ ...full, relations: [{ ...full.relations[0], to: 'E9' }] }), 'relation R1 points at E9, which is not an entity'],
    ['unknown entity kind', JSON.stringify({ ...full, entities: [{ ...full.entities[0], kind: 'actor' }, full.entities[1]] }), 'entity E1 has an unknown kind'],
    ['responsibilities as text', JSON.stringify({ ...full, entities: [{ ...full.entities[0], responsibilities: 'knows' }, full.entities[1]] }), 'entity E1 responsibilities is not a list'],
    ['31 responsibilities', JSON.stringify({ ...full, entities: [{ ...full.entities[0], responsibilities: Array.from({ length: 31 }, () => 'r') }, full.entities[1]] }), 'entity E1 responsibilities has more than 30 items'],
    ['unknown relation kind', JSON.stringify({ ...full, relations: [{ ...full.relations[0], kind: 'uses' }] }), 'relation R1 has an unknown kind'],
    ['long cardinality', JSON.stringify({ ...full, relations: [{ ...full.relations[0], toCard: '*'.repeat(17) }] }), 'relation R1 toCard is longer than 16 characters'],
    ['long operation note', JSON.stringify({ ...full, operations: [{ ...full.operations[0], note: 'n'.repeat(4001) }] }), 'operation O1 note is longer than 4000 characters'],
    ['consequences as text', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], consequences: 'one writer' }] }), 'decision D1 consequences is not a list'],
    ['7 consequences', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], consequences: Array.from({ length: 7 }, (_, i) => `c${i}`) }] }), 'decision D1 consequences has more than 6 items'],
    ['a long superseded-by link', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], status: 'superseded', supersededBy: 'D'.repeat(17) }] }), 'decision D1 supersededBy is longer than 16 characters'],
    ['inputs as text', JSON.stringify({ ...full, operations: [{ ...full.operations[0], inputs: 'today' }] }), 'operation O1 inputs is not a list'],
    ['unknown status', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], status: 'maybe' }] }), 'decision D1 has an unknown status'],
    ['old trade-off key only', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], tradeOff: undefined, tradeoff: 'x' }] }), 'decision D1 tradeOff is not text'],
    ['long note', JSON.stringify({ ...full, notes: 'x'.repeat(4001) }), 'notes is longer than 4000 characters'],
    ['11 decisions', JSON.stringify({ ...full, decisions: Array.from({ length: 11 }, (_, i) => ({ ...full.decisions[0], id: `D${i + 1}` })) }), 'more than 10 decisions'],
    ['21 satisfies', JSON.stringify({ ...full, operations: [{ ...full.operations[0], satisfies: Array.from({ length: 21 }, (_, i) => `US-${i}`) }] }), 'operation O1 satisfies has more than 20 items'],
    ['a long decidedAt', JSON.stringify({ ...full, decisions: [{ ...full.decisions[0], decidedAt: 'x'.repeat(41) }] }), 'decision D1 decidedAt is longer than 40 characters'],
  ])('refuses %s', (_name, text, message) => {
    const out = validateDesignRecord(text);
    expect(out.design).toBeNull();
    expect(out.error).toBe(message);
  });
});

describe('the contracts', () => {
  it('accepts the seeded contracts and the TaskTrackr shape with its extra keys', () => {
    expect(validateApiContract('{\n  "operations": [],\n  "errors": {}\n}\n')).toBeNull();
    expect(validateApiContract(JSON.stringify({ $comment: 'x', version: '2.0.0', entities: {}, operations: [{ id: 'listLists', method: 'GET' }], errors: {} }))).toBeNull();
    expect(validateScreenContract(JSON.stringify({ $comment: 'x', router: 'hash', screens: [{ route: '#/', component: 'ListsPage' }] }))).toBeNull();
  });
  it.each([
    [validateApiContract, '{', 'The API contract is not valid JSON'],
    [validateApiContract, '{"errors":{}}', 'The API contract has no operations list'],
    [validateApiContract, '{"operations":[1]}', 'API contract operation 1 is not an object'],
    [validateApiContract, '{"operations":[],"errors":[]}', 'The API contract errors is not an object'],
    [validateScreenContract, '{"screens":{}}', 'The screen contract has no screens list'],
    [validateScreenContract, '{"screens":[{"title":"x"}]}', 'Screen 1 has no route'],
  ])('refuses %#', (validate, text, message) => {
    expect(validate(text)).toBe(message);
  });
});

describe('defaults and paths', () => {
  it('holds the defaults', () => {
    expect(DEFAULT_DESIGN_CONTRACTS).toEqual({ api: true, screens: false });
    expect(DEFAULT_DESIGN_SEQUENCE).toBe(false);
    expect(DEFAULT_DESIGN_FLOOR).toEqual({ minEntities: 2, minRelations: 1, minOperations: 2, operationShape: true, minDecisions: 1, decisionShape: true, traceEveryStory: true, minEndpoints: 2, requireErrorCatalogue: true, minScreens: 1, screenShape: true });
  });
  it('freezes the shared constants, so no caller widens or fills them for every other caller', () => {
    for (const value of [EMPTY_DESIGN, EMPTY_DESIGN.entities, EMPTY_DESIGN.relations, EMPTY_DESIGN.operations, EMPTY_DESIGN.decisions, DEFAULT_DESIGN_FLOOR, DEFAULT_DESIGN_CONTRACTS, ENTITY_KINDS, DESIGN_RELATION_KINDS]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(() => EMPTY_DESIGN.entities.push({ id: 'E1', name: 'x', kind: 'class', attributes: [], responsibilities: [], satisfies: [] })).toThrow(TypeError);
  });
  it('lists the documents that are on, record first', () => {
    expect(designDocumentPaths({ api: true, screens: true })).toEqual(['design/design.json', 'shared/contract/api.json', 'shared/contract/screens.json']);
    expect(designDocumentPaths({ api: false, screens: false })).toEqual(['design/design.json']);
  });
});

describe('foldLegacyDesign', () => {
  const taskTrackr = {
    fields: [{ name: 'id', type: 'integer', required: true, note: 'assigned by the database', satisfies: ['US-1'] }],
    operations: [{ name: 'completeTask(id)', satisfies: '', inputs: '', returns: '', errors: '' }, { name: 'listTasks(listId, filters)', satisfies: 'US-3', inputs: 'listId, status', returns: 'Task[]', ordering: 'priority first', errors: '' }],
    decisions: [{ id: 'D1', choice: 'one JSON file', alternative: 'sqlite', rationale: 'simple', tradeoff: 'no joins', context: 'small app', consequences: ['one writer', ' ', 'no joins across files'], status: 'proposed', stories: ['US-1'], supersededBy: null }],
  };
  it('folds decisions beyond the record\'s 10 into the notes as whole lines, and names them', () => {
    const decisions = Array.from({ length: 12 }, (_, i) => ({ id: `D${i + 1}`, title: `T${i + 1}`, choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', status: 'accepted' }));
    const out = foldLegacyDesign({ fields: [], decisions })!;
    expect(out.design.decisions).toHaveLength(10);
    expect(out.design.notes).toContain('Decision D11: {');
    expect(out.design.notes).toContain('"title":"T12"');
    expect(out.folded).toContain("2 decisions beyond the record's 10 kept in the notes");
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('applies the board\'s limits to endpoints (30), each endpoint\'s refusals (30) and a decision\'s stories (8), each cut named', () => {
    const refusals = Array.from({ length: 31 }, (_, i) => ({ status: 400, code: `c${i}` }));
    const endpoints = Array.from({ length: 31 }, (_, i) => ({ method: 'GET', path: `/e${i}`, ...(i === 0 ? { refusals } : {}) }));
    const stories = Array.from({ length: 9 }, (_, i) => `US-${i + 1}`);
    const out = foldLegacyDesign({ fields: [], endpoints, decisions: [{ id: 'D1', title: 'x', choice: 'c', alternative: 'a', rationale: 'r', tradeOff: 't', status: 'accepted', stories }] })!;
    expect(out.cut).toEqual([
      "1 story of D1 left out: over the board's limit of 8",
      "1 endpoint left out: over the board's limit of 30",
      "1 refusal of endpoint 1 left out: over the board's limit of 30",
    ]);
    expect(out.design.decisions[0].satisfies).toHaveLength(8);
  });
  it('joins an operation\'s and an attribute\'s note parts only while they fit the 4000-character cap, the cut named', () => {
    const long = 'w'.repeat(2500);
    const out = foldLegacyDesign({ fields: [{ name: 'id', required: true, note: 'x'.repeat(3995) }], operations: [{ name: 'op', boundary: long, example: long }] })!;
    expect(out.design.entities[0].attributes[0].note).toBe('x'.repeat(3995));
    expect(out.design.operations[0].note).toBe(`boundary: ${long}`);
    expect(out.cut).toEqual(['1 part of the note of attribute 1 of E1 left out: over the 4000-character cap', '1 part of the note of O1 left out: over the 4000-character cap']);
  });
  it('writes an endpoint with no method or path without a stray space', () => {
    expect(foldLegacyDesign({ fields: [], endpoints: [{ purpose: 'the report' }] })!.design.notes).toBe('Endpoint: the report');
  });

  it('recognises the board shape, folds fields into an entity named Model, and keeps a decision whole', () => {
    expect(isLegacyDesignShape(taskTrackr)).toBe(true);
    expect(isLegacyDesignShape(full)).toBe(false);
    const out = foldLegacyDesign(taskTrackr)!;
    expect(out.design.entities).toEqual([{ id: 'E1', name: 'Model', kind: 'class', attributes: [{ name: 'id', type: 'integer', note: 'required, assigned by the database' }], responsibilities: [], satisfies: ['US-1'] }]);
    expect(out.design.operations[1]).toEqual({ id: 'O2', name: 'listTasks(listId, filters)', inputs: ['listId, status'], returns: 'Task[]', errors: [], satisfies: ['US-3'], note: 'ordering: priority first' });
    expect('note' in out.design.operations[0]).toBe(false);
    expect(out.design.decisions[0]).toEqual({ id: 'D1', title: 'one JSON file', choice: 'one JSON file', alternative: 'sqlite', rationale: 'simple', tradeOff: 'no joins', context: 'small app', consequences: ['one writer', 'no joins across files'], status: 'proposed', satisfies: ['US-1'] });
    expect(out.design.notes).toBeUndefined();
    expect(out.folded).toEqual(['1 field became the attributes of the entity Model', 'the ordering of O2 kept in its note']);
    // a fold that only moves words cuts nothing
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('folds an operation\'s ordering, boundary and example into its note, in that order, only the parts present', () => {
    const out = foldLegacyDesign({ fields: [], operations: [{ name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'today', returns: 'Task[]', example: '2 days late', boundary: 'due today is not overdue', errors: '' }], decisions: [] })!;
    expect(out.design.operations[0].note).toBe('boundary: due today is not overdue; example: 2 days late');
    expect(out.design.notes).toBeUndefined();
    expect(out.folded).toEqual(['the boundary and example of O1 kept in its note']);
  });
  it('keeps the drawn entities whole, keeps fields as notes beside them, and retires endpoints into notes', () => {
    const out = foldLegacyDesign({ ...full, entities: [{ id: 'E1', name: 'Task', kind: 'service', attributes: [], responsibilities: ['knows its due date', ''] }], relations: [], fields: [{ name: 'due_date', type: 'date' }], endpoints: [{ method: 'GET', path: '/api/tasks/overdue', purpose: 'the report', refusals: [{ status: '400', code: 'invalid_date', when: 'bad today' }] }] })!;
    expect(out.design.entities).toEqual([{ id: 'E1', name: 'Task', kind: 'service', attributes: [], responsibilities: ['knows its due date'], satisfies: [] }]);
    expect(out.design.notes).toContain('none');
    expect(out.design.notes).not.toContain('responsibilities');
    expect(out.design.notes).toContain('Field due_date: date');
    expect(out.design.notes).toContain('Endpoint GET /api/tasks/overdue: the report; refuses 400 invalid_date when bad today');
    expect(out.folded).toEqual(['1 field kept in the notes', '1 endpoint kept in the notes; the API contract is the one place for endpoints']);
  });
  it('keeps a dependency and its cardinalities as fields, never as label text', () => {
    const out = foldLegacyDesign({ fields: [], entities: [{ id: 'E1', name: 'A', attributes: [] }, { id: 'E2', name: 'B', kind: 'component', attributes: [], responsibilities: [] }], relations: [{ id: 'R1', from: 'E1', to: 'E2', kind: 'dependency', fromCard: '1', toCard: '*', label: 'uses' }, { id: 'R2', from: 'E2', to: 'E1', kind: 'association', fromCard: '', toCard: '', label: '' }], operations: [], decisions: [] })!;
    expect(out.design.relations).toEqual([
      { id: 'R1', from: 'E1', to: 'E2', kind: 'dependency', fromCard: '1', toCard: '*', label: 'uses' },
      { id: 'R2', from: 'E2', to: 'E1', kind: 'association' },
    ]);
    expect(out.design.entities.map((e) => e.kind)).toEqual(['class', 'component']);
    expect(out.folded).toEqual([]);
  });
  it('names what it reads differently, and keeps a superseded-by link as a field', () => {
    const out = foldLegacyDesign({ fields: [], entities: [{ id: 'E1', name: 'A', kind: 'actor', attributes: [] }], relations: [], operations: [], decisions: [{ id: 'D1', choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', status: 'superseded', supersededBy: 'D2' }] })!;
    expect(out.design.entities[0].kind).toBe('class');
    expect(out.design.decisions[0]).toMatchObject({ status: 'superseded', supersededBy: 'D2' });
    expect(out.folded).toEqual(['the kind "actor" of E1 read as class']);
  });
  it('keeps a field\'s stories in its notes line, and writes a bare field with no trailing separator', () => {
    const out = foldLegacyDesign({ entities: [{ id: 'E1', name: 'Task' }], fields: [{ name: 'due_date', type: 'date', required: true, satisfies: ['US-4', 'US-5'] }, { name: 'x' }, { name: 'y', satisfies: 'US-6' }], operations: [], decisions: [] })!;
    expect(out.design.notes!.split('\n')).toEqual(['Field due_date: date, required; serves US-4, US-5', 'Field x', 'Field y; serves US-6']);
  });
  it('keeps whole endpoint lines in order up to the notes cap, names the cut, and leaves the drawn parts untouched', () => {
    const drawn = { entities: full.entities, relations: full.relations, operations: full.operations, decisions: full.decisions };
    const refusals = [1, 2, 3].map((n) => ({ status: 400 + n, code: `code_${n}`, when: 'w'.repeat(40) }));
    const endpoints = Array.from({ length: 12 }, (_, i) => ({ method: 'GET', path: `/api/e${i + 1}`, purpose: 'p'.repeat(200), refusals }));
    const out = foldLegacyDesign({ ...drawn, endpoints })!;
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
    expect(out.design.notes!.length).toBeLessThanOrEqual(4000);
    const kept = out.design.notes!.split('\n');
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    const refuses = refusals.map((r) => `${r.status} ${r.code} when ${r.when}`).join(', ');
    kept.forEach((line, i) => expect(line).toBe(`Endpoint GET /api/e${i + 1}: ${'p'.repeat(200)}; refuses ${refuses}`));
    expect(out.folded).toEqual([
      `${kept.length} endpoints kept in the notes; the API contract is the one place for endpoints`,
      `${12 - kept.length} endpoint lines left out of the notes: over the 4000-character cap`,
    ]);
    // the cuts alone, structured, so a caller that must never cut (the migration from markdown designs) refuses without reading text
    expect(out.cut).toEqual([`${12 - kept.length} endpoint lines left out of the notes: over the 4000-character cap`]);
    expect(out.design.entities).toEqual(full.entities);
    expect(out.design.relations).toEqual(full.relations);
    expect(out.design.operations).toEqual(full.operations);
    expect(out.design.decisions).toEqual(full.decisions);
  });
  it('keeps whole field lines up to the notes cap, and names every cut after it', () => {
    const fields = Array.from({ length: 30 }, (_, i) => ({ name: `f${i + 1}`, type: 't', note: 'n'.repeat(200) }));
    const out = foldLegacyDesign({ entities: [{ id: 'E1', name: 'Task' }], fields, endpoints: [{ method: 'GET', path: '/x' }] })!;
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
    const kept = out.design.notes!.split('\n');
    kept.forEach((line, i) => expect(line).toBe(`Field f${i + 1}: t, ${'n'.repeat(200)}`));
    expect(out.folded).toEqual([
      `${kept.length} fields kept in the notes`,
      `${30 - kept.length} field lines left out of the notes: over the 4000-character cap`,
      '1 endpoint line left out of the notes: over the 4000-character cap',
    ]);
    expect(out.cut).toEqual(out.folded.slice(1));
  });
  it('applies the board\'s own limits before validation and names each cut', () => {
    const out = foldLegacyDesign({
      fields: [],
      entities: [{ id: 'E1', name: 'A', attributes: Array.from({ length: 31 }, (_, i) => ({ name: `a${i + 1}` })), responsibilities: Array.from({ length: 31 }, (_, i) => `r${i + 1}`) }],
      relations: [], operations: [],
      decisions: [{ id: 'D1', title: 't', choice: 'c', alternative: 'a', rationale: 'r', tradeOff: 't', status: 'accepted', consequences: Array.from({ length: 7 }, (_, i) => `c${i + 1}`) }],
    })!;
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
    expect(out.design.decisions[0].consequences).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(out.design.entities[0].attributes).toHaveLength(30);
    expect(out.design.entities[0].responsibilities).toHaveLength(30);
    expect(out.folded).toEqual([
      "1 attribute of E1 left out: over the board's limit of 30",
      "1 responsibility of E1 left out: over the board's limit of 30",
      "1 consequence of D1 left out: over the board's limit of 6",
    ]);
    expect(out.cut).toEqual(out.folded);
  });
  it('cuts entities past 20 and relations past 40, as the board does', () => {
    const entities = Array.from({ length: 21 }, (_, i) => ({ id: `E${i + 1}`, name: `N${i + 1}` }));
    const relations = Array.from({ length: 41 }, (_, i) => ({ id: `R${i + 1}`, from: 'E1', to: 'E2', kind: 'association' }));
    const out = foldLegacyDesign({ fields: [], entities, relations, operations: [], decisions: [] })!;
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
    expect(out.design.entities).toHaveLength(20);
    expect(out.design.relations).toHaveLength(40);
    expect(out.folded).toEqual(["1 entity left out: over the board's limit of 20", "1 relation left out: over the board's limit of 40"]);
    expect(out.cut).toEqual(out.folded);
  });
  it('gives a missing id one no other item has, and a repeated id a fresh one', () => {
    const out = foldLegacyDesign({ fields: [], entities: [{ id: 'E2', name: 'A' }, { name: 'B' }, { id: 'E2', name: 'C' }], relations: [], operations: [{ name: 'x' }, { id: 'O1', name: 'y' }], decisions: [] })!;
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
    expect(out.design.entities.map((e) => e.id)).toEqual(['E2', 'E3', 'E4']);
    expect(out.design.operations.map((o) => o.id)).toEqual(['O2', 'O1']);
    expect(out.folded).toEqual(['the repeated id E2 of entity 3 read as E4']);
  });
  it('reads an operation as older when its inputs are text, it has no id, or it carries an ordering, boundary or example', () => {
    const op = full.operations[0];
    expect(isLegacyDesignShape({ ...full, operations: [{ ...op, inputs: 'today' }] })).toBe(true);
    expect(isLegacyDesignShape({ ...full, operations: [{ ...op, id: undefined }] })).toBe(true);
    for (const key of ['ordering', 'boundary', 'example']) expect(isLegacyDesignShape({ ...full, operations: [{ ...op, [key]: 'x' }] })).toBe(true);
  });
  it('reads a decision as older when it has the lowercase tradeoff or no title, and a listed consequences as the schema\'s own', () => {
    const decision = full.decisions[0];
    expect(isLegacyDesignShape({ ...full, decisions: [{ ...decision, tradeoff: 'x' }] })).toBe(true);
    expect(isLegacyDesignShape({ ...full, decisions: [{ ...decision, title: undefined }] })).toBe(true);
    expect(isLegacyDesignShape({ ...full, decisions: [{ ...decision, consequences: ['one'] }] })).toBe(false);
  });
  it('keeps an operation\'s sequence and every other key it does not read in its note, an object as canonical JSON', () => {
    const sequence = 'Browser -> Api: completeTask(id)\nApi -> Store: save(task)';
    const out = foldLegacyDesign({ fields: [], operations: [{ name: 'completeTask(id)', satisfies: 'US-2', inputs: 'id', returns: 'Task', errors: '', ordering: 'none', sequence, steps: { to: 'Api', from: 'Browser' }, owner: null, tags: [] }], decisions: [] })!;
    expect(out.design.operations[0].note).toBe(`ordering: none; sequence: ${sequence}; steps: {"from":"Browser","to":"Api"}`);
    expect(out.folded).toEqual(['the ordering, sequence and steps of O1 kept in its note']);
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('keeps an entity\'s and a decision\'s unread keys as lines in the notes, named in folded', () => {
    const out = foldLegacyDesign({
      fields: [], notes: 'kept',
      entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], colour: 'blue', meta: { b: 1, a: [2] }, blank: '' }],
      operations: [],
      decisions: [{ id: 'D1', choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', status: 'accepted', satisfies: ['US-1'], stories: ['US-9'], reviewAt: 'week 6', weight: 3 }],
    })!;
    expect(out.design.notes!.split('\n')).toEqual(['kept', 'Entity E1 colour: blue', 'Entity E1 meta: {"a":[2],"b":1}', 'Decision D1 stories: ["US-9"]', 'Decision D1 reviewAt: week 6', 'Decision D1 weight: 3']);
    expect(out.design.entities[0]).toEqual({ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] });
    expect(out.design.decisions[0].satisfies).toEqual(['US-1']);
    expect(out.folded).toEqual(['the colour and meta of E1 kept in the notes', 'the stories, reviewAt and weight of D1 kept in the notes']);
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('cuts an unread key\'s line at the notes cap, so a caller that must never cut refuses', () => {
    const out = foldLegacyDesign({
      fields: [], notes: 'n'.repeat(3990), operations: [],
      entities: [{ id: 'E1', name: 'Task', colour: 'x'.repeat(50) }],
      decisions: [{ id: 'D1', choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', status: 'accepted', reviewAt: 'week 6' }],
    })!;
    expect(out.design.notes).toBe('n'.repeat(3990));
    expect(out.cut).toEqual([
      '1 entity key line left out of the notes: over the 4000-character cap',
      '1 decision key line left out of the notes: over the 4000-character cap',
    ]);
    expect(out.folded).toEqual(out.cut);
  });
  it('keeps a relation\'s unread keys and an unknown kind in its label, and an undrawn relation\'s in its notes line', () => {
    const out = foldLegacyDesign({
      fields: [], operations: [], decisions: [],
      entities: [{ id: 'E1', name: 'A' }, { id: 'E2', name: 'B' }],
      relations: [
        { id: 'R1', from: 'E1', to: 'E2', kind: 'uses', label: 'calls', weight: 2, via: { port: 80 } },
        { id: 'R2', from: 'E1', to: 'E9', kind: 'association', label: 'x', style: 'dashed' },
      ],
    })!;
    expect(out.design.relations).toEqual([{ id: 'R1', from: 'E1', to: 'E2', kind: 'association', label: 'calls; kind: uses; weight: 2; via: {"port":80}' }]);
    expect(out.design.notes).toBe('Relation R2: E1 to E9 x; kind: association; style: dashed');
    expect(out.folded).toEqual([
      'the kind "uses" of R1 read as association', 'the weight and via of R1 kept in its label',
      'relation R2 kept in the notes: it points at no entity', 'the kind and style of R2 kept in its notes line',
    ]);
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('keeps an attribute\'s unread keys in its note, and an entry of a list that is not an item in the notes', () => {
    const out = foldLegacyDesign({ fields: [], operations: [], decisions: [], entities: [{ id: 'E1', name: 'Task', attributes: [{ name: 'due', type: 'date', note: 'may be null', default: null, unique: true, format: 'ISO' }, 'stray'] }] })!;
    expect(out.design.entities[0].attributes).toEqual([{ name: 'due', type: 'date', note: 'may be null; unique: true; format: ISO' }]);
    expect(out.design.notes).toBe('Entity E1 attributes: ["stray"]');
    expect(out.folded).toEqual(['the unique and format of attribute 1 of E1 kept in its note', 'the attributes of E1 kept in the notes']);
    expect(out.cut).toEqual([]);
  });
  it('keeps a field\'s unread and unusable values in its attribute note, or in its notes line', () => {
    const model = foldLegacyDesign({ fields: [{ name: 'id', type: 'integer', required: 'yes', satisfies: 'US-1 and the login', unique: true }], operations: [], decisions: [] })!;
    expect(model.design.entities[0].attributes).toEqual([{ name: 'id', type: 'integer', note: 'required: yes; satisfies: US-1 and the login; unique: true' }]);
    expect(model.design.entities[0].satisfies).toEqual(['US-1']);
    expect(model.folded).toEqual(['1 field became the attributes of the entity Model', 'the required, satisfies and unique of field 1 kept in its note']);
    const lines = foldLegacyDesign({ entities: [{ id: 'E1', name: 'Task' }], fields: [{ name: 'x', type: 't', colour: 'red' }] })!;
    expect(lines.design.notes).toBe('Field x: t; colour: red');
    expect(lines.folded).toEqual(['1 field kept in the notes', 'the colour of field 1 kept in its notes line']);
    expect(lines.cut).toEqual([]);
  });
  it('keeps an endpoint\'s and a refusal\'s unread keys in the endpoint\'s notes line', () => {
    const out = foldLegacyDesign({ fields: [], operations: [], decisions: [], endpoints: [{ method: 'GET', path: '/x', purpose: 'p', auth: 'token', refusals: [{ status: 404, code: 'missing', when: 'no row', retry: false }, 'stray'] }] })!;
    expect(out.design.notes).toBe('Endpoint GET /x: p; refuses 404 missing when no row (retry: false); auth: token; refusals: ["stray"]');
    expect(out.folded).toEqual([
      '1 endpoint kept in the notes; the API contract is the one place for endpoints',
      'the auth and refusals of endpoint 1 kept in its notes line', 'the retry of refusal 1 of endpoint 1 kept in its notes line',
    ]);
    expect(out.cut).toEqual([]);
  });
  it('keeps the record\'s own unread keys and unusable values as canonical JSON lines in the notes', () => {
    const out = foldLegacyDesign({ fields: [], operations: [], decisions: [], entities: [{ id: 'E1', name: 'A' }, 'stray'], sequence: 42, title: 'Board', layout: { zoom: 2, at: [1, 2] } })!;
    expect(out.design.notes!.split('\n')).toEqual(['entities: ["stray"]', 'sequence: 42', 'title: "Board"', 'layout: {"at":[1,2],"zoom":2}']);
    expect(out.design.sequence).toBeUndefined();
    expect(out.folded).toEqual(['the entities, sequence, title and layout of the record kept in the notes']);
    expect(out.cut).toEqual([]);
  });
  it('keeps a value it reads but cannot use as text: a satisfies that is not story ids, a wrong type, an unknown status', () => {
    const out = foldLegacyDesign({
      fields: [],
      entities: [{ id: 'E1', name: 5, satisfies: 'US-1, US-2' }],
      operations: [{ id: 'O1', name: 'run', inputs: ['a', 3], returns: 'x', errors: '', satisfies: 'the login story' }],
      decisions: [{ id: 'D1', choice: 'c', alternative: 'a', rationale: 'r', tradeoff: 't', status: 'rejected', satisfies: ['S1', 7] }],
    })!;
    expect(out.design.entities[0]).toMatchObject({ name: '', satisfies: ['US-1', 'US-2'] });
    expect(out.design.operations[0]).toMatchObject({ inputs: ['a'], satisfies: [], note: 'inputs: [3]; satisfies: the login story' });
    // a listed satisfies keeps its text entries as ids, as the learner named their stories
    expect(out.design.decisions[0]).toMatchObject({ status: 'proposed', satisfies: ['S1'] });
    expect(out.design.notes!.split('\n')).toEqual(['Entity E1 name: 5', 'Decision D1 status: rejected', 'Decision D1 satisfies: [7]']);
    expect(out.folded).toEqual([
      'the name of E1 kept in the notes', 'the inputs and satisfies of O1 kept in its note',
      'the status "rejected" of D1 read as proposed', 'the satisfies of D1 kept in the notes',
    ]);
    expect(out.cut).toEqual([]);
    expect(validateDesignRecord(serialiseDesign(out.design)).error).toBeNull();
  });
  it('keeps an undrawn relation\'s kind and cardinalities in its notes line, named', () => {
    const out = foldLegacyDesign({ fields: [], operations: [], decisions: [], entities: [{ id: 'E1', name: 'A' }], relations: [{ id: 'R1', from: 'E1', to: 'E9', kind: 'composition', fromCard: '1..*', toCard: '0..1', label: 'has' }] })!;
    expect(out.design.relations).toEqual([]);
    expect(out.design.notes).toBe('Relation R1: E1 to E9 has; kind: composition; fromCard: 1..*; toCard: 0..1');
    expect(out.folded).toEqual(['relation R1 kept in the notes: it points at no entity', 'the kind, fromCard and toCard of R1 kept in its notes line']);
    expect(out.cut).toEqual([]);
  });
  it('cuts a record key line at the notes cap', () => {
    const out = foldLegacyDesign({ fields: [], operations: [], decisions: [], notes: 'n'.repeat(3990), title: 'x'.repeat(20) })!;
    expect(out.design.notes).toBe('n'.repeat(3990));
    expect(out.cut).toEqual(['1 record key line left out of the notes: over the 4000-character cap']);
    expect(out.folded).toEqual(out.cut);
  });
  it('is null for something that is not an object', () => {
    expect(foldLegacyDesign([])).toBeNull();
  });
});

describe('the authoring predicates', () => {
  it('reads a design task as written work a teacher authors', () => {
    expect(splittableCheckKind('design')).toBe(true);
    expect(isAuthorableTask('design', 'design-doc')).toBe(true);
    expect(isAuthorableTask('design', 'document')).toBe(false);
  });
});

describe('designDocumentError', () => {
  it('names what is wrong with each of the three documents by its path, and nothing for a good one or another path', () => {
    expect(designDocumentError('design/design.json', '{')).toBe('The design record is not valid: The design record is not valid JSON.');
    expect(designDocumentError('design/design.json', '{"entities":[]}')).toBe('The design record is not valid: relations is not a list.');
    expect(designDocumentError('design/design.json', serialiseDesign(EMPTY_DESIGN))).toBeNull();
    expect(designDocumentError('shared/contract/api.json', '{"errors":{}}')).toBe('The API contract is not valid: The API contract has no operations list.');
    expect(designDocumentError('shared/contract/api.json', '{"operations":[]}')).toBeNull();
    expect(designDocumentError('shared/contract/screens.json', '[]')).toBe('The screen contract is not valid: The screen contract is not an object.');
    expect(designDocumentError('shared/contract/screens.json', '{"screens":[]}')).toBeNull();
    expect(designDocumentError('notes.md', '{')).toBeNull();
  });
});

describe('the readers', () => {
  it('reads a valid record as it is, an older board record folded, and says why anything else cannot be read', () => {
    expect(readDesignRecord(serialiseDesign(full))).toEqual({ design: validateDesignRecord(serialiseDesign(full)).design, folded: false, error: null });
    const older = JSON.stringify({ fields: [{ name: 'id', type: 'integer' }], operations: [{ name: 'getOverdue(today)', inputs: 'today', returns: '', errors: '', boundary: 'due today is not overdue' }], decisions: [] });
    const read = readDesignRecord(older);
    expect(read.folded).toBe(true);
    expect(read.design?.entities[0]).toMatchObject({ id: 'E1', name: 'Model', attributes: [{ name: 'id', type: 'integer' }] });
    expect(read.design?.operations[0]).toMatchObject({ id: 'O1', inputs: ['today'], note: 'boundary: due today is not overdue' });
    expect(readDesignRecord('{')).toEqual({ design: null, folded: false, error: 'The design record is not valid JSON' });
    expect(readDesignRecord('[]')).toEqual({ design: null, folded: false, error: 'The design record is not an object' });
    expect(readDesignRecord('')).toEqual({ design: null, folded: false, error: null });
  });
  it('says the day a decision was accepted, in UTC, and nothing for no stamp or one that is not a date', () => {
    expect(decidedOn('2026-03-04T23:50:00.000Z')).toBe('4 March 2026');
    expect(decidedOn(null)).toBe('');
    expect(decidedOn(undefined)).toBe('');
    expect(decidedOn('not a date')).toBe('');
  });
});

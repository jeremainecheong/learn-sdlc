import { DEFAULT_DESIGN_FLOOR, serialiseDesign, type Design } from './design-record';
import { designCarried, designChangeSet, designFloorIds, designItemPlaces, designFloorSentence, designReviewProjection, evaluateDesignFloor, operationBaseName } from './design-floor';

const R = 'design/design.json', A = 'shared/contract/api.json', S = 'shared/contract/screens.json';
const good: Design = {
  entities: [
    { id: 'E1', name: 'Task', kind: 'class', attributes: [{ name: 'due_date', type: 'date' }], responsibilities: ['knows when it is overdue'], satisfies: ['US-4'] },
    { id: 'E2', name: 'List', kind: 'class', attributes: [], responsibilities: [], satisfies: ['US-3'] },
  ],
  relations: [{ id: 'R1', from: 'E2', to: 'E1', kind: 'composition', fromCard: '1', toCard: '*', label: 'holds' }],
  operations: [
    { id: 'O1', name: 'getOverdue(today)', inputs: ['today'], returns: 'Task[]', errors: ['invalid_date'], satisfies: ['US-4'], note: 'boundary: due today is not overdue' },
    { id: 'O2', name: 'completeTask(id)', inputs: ['id'], returns: 'Task', errors: ['task_not_found'], satisfies: ['US-2'] },
  ],
  decisions: [{ id: 'D1', title: 'Clock', choice: 'a parameter', alternative: 'server clock', rationale: 'replayable', tradeOff: 'callers send it', context: 'tests replay one day', consequences: ['every caller sends today'], status: 'accepted', satisfies: ['US-4'] }],
  sequence: 'Browser -> Api: getOverdue(today)\nApi --> Browser: Task[]',
  notes: 'E2E-PASS',
};
const api = JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/api/a', summary: 'one', success: { status: 200, body: 'A' } }, { id: 'b', method: 'POST', path: '/api/b', errors: ['bad'] }], errors: { bad: { status: 400, meaning: 'bad input' } }, entities: { tasks: { table: 'tasks', fields: [{ name: 'id', type: 'integer' }] } } });
const screens = JSON.stringify({ screens: [{ route: '#/overdue', title: 'Overdue', shows: 'late tasks', component: 'OverduePage', reads: ['getOverdue'], components: ['OverduePage'], empty: 'Nothing is overdue. You are all caught up.' }] });
const spec = { contracts: { api: true, screens: true }, sequence: true, stories: [{ id: 'US-2', title: 'Complete', line: 'x' }, { id: 'US-3', title: 'Filter', line: 'y' }, { id: 'US-4', title: 'Overdue', line: 'z' }], floor: DEFAULT_DESIGN_FLOOR };
const docs = { [R]: serialiseDesign(good), [A]: api, [S]: screens };

describe('evaluateDesignFloor', () => {
  it('passes good work with every rule, record first', () => {
    const r = evaluateDesignFloor(docs, spec);
    expect(r.map((x) => x.id)).toEqual(['design.record', 'design.entities.min', 'design.relations.min', 'design.operations.min', 'design.operations.shape', 'design.decisions.min', 'design.decisions.shape', 'design.trace', 'design.api.min', 'design.api.errors', 'design.screens.min', 'design.screens.shape', 'design.sequence']);
    expect(r.filter((x) => !x.passed)).toEqual([]);
  });
  // Decisions still count every row: TaskTrackr's scaffold ships one blank decision, and counting named ones only would move the verdict golden.
  it('counts only named entities and operations toward their minimums: a blank row the Add buttons create is not one', () => {
    const blankEntity = { id: 'E3', name: '  ', kind: 'class' as const, attributes: [], responsibilities: [], satisfies: [] };
    const blankOperation = { id: 'O3', name: '', inputs: ['x'], returns: 'y', errors: [], satisfies: [] };
    const blankDecision = { ...good.decisions[0], id: 'D2', title: ' ' };
    const floor = { ...DEFAULT_DESIGN_FLOOR, minEntities: 3, minOperations: 3, minDecisions: 3, traceEveryStory: false };
    const run = (over: Partial<Design>) =>
      evaluateDesignFloor({ ...docs, [R]: serialiseDesign({ ...good, ...over }) }, { ...spec, sequence: false, floor })
        .filter((x) => ['design.entities.min', 'design.operations.min', 'design.decisions.min'].includes(x.id))
        .map((x) => [x.id, x.passed, x.detail]);
    expect(run({ entities: [...good.entities, blankEntity], operations: [...good.operations, blankOperation], decisions: [...good.decisions, blankDecision] })).toEqual([
      ['design.entities.min', false, 'Fewer than 3 entities in the data model'],
      ['design.operations.min', false, 'Fewer than 3 operations'],
      ['design.decisions.min', false, 'Fewer than 3 decisions'],
    ]);
    const named = run({
      entities: [...good.entities, { ...blankEntity, name: 'Tag' }],
      operations: [...good.operations, { ...blankOperation, name: 'tag(id)' }],
      decisions: [...good.decisions, { ...blankDecision, title: 'Storage' }],
    });
    expect(named.map(([id, passed]) => [id, passed])).toEqual([['design.entities.min', true], ['design.operations.min', true], ['design.decisions.min', false]]);
    // a blank decision is counted: one named and two blank make three
    expect(run({ decisions: [...good.decisions, blankDecision, { ...blankDecision, id: 'D3' }] }).at(-1)).toEqual(['design.decisions.min', true, '3 decisions']);
  });
  it('emits no contract rule for a contract that is off', () => {
    const r = evaluateDesignFloor(docs, { ...spec, contracts: { api: false, screens: false } });
    expect(r.map((x) => x.id).some((id) => id.startsWith('design.api') || id.startsWith('design.screens'))).toBe(false);
  });
  // each row isolates one rule, so the helper leaves the sequence diagram off; the sequence rule has its own rows below
  const failing = (over: Partial<Design>, floor = DEFAULT_DESIGN_FLOOR, extra: Record<string, string> = {}) =>
    evaluateDesignFloor({ ...docs, [R]: serialiseDesign({ ...good, ...over }), ...extra }, { ...spec, sequence: false, floor }).filter((x) => !x.passed).map((x) => [x.id, x.detail]);
  it.each([
    ['plural entities', { entities: [{ ...good.entities[0], satisfies: ['US-3', 'US-4'] }], relations: [] }, { ...DEFAULT_DESIGN_FLOOR, minRelations: 0 }, ['design.entities.min', 'Fewer than 2 entities in the data model']],
    ['singular entity', { entities: [], relations: [] }, { ...DEFAULT_DESIGN_FLOOR, minEntities: 1, minRelations: 0, traceEveryStory: false }, ['design.entities.min', 'Fewer than 1 entity in the data model']],
    ['singular relation', { relations: [] }, DEFAULT_DESIGN_FLOOR, ['design.relations.min', 'Fewer than 1 relation between entities']],
    ['plural relations', {}, { ...DEFAULT_DESIGN_FLOOR, minRelations: 3 }, ['design.relations.min', 'Fewer than 3 relations between entities']],
    ['plural operations', { operations: [good.operations[0]] }, { ...DEFAULT_DESIGN_FLOOR, traceEveryStory: false }, ['design.operations.min', 'Fewer than 2 operations']],
    ['singular operation', { operations: [] }, { ...DEFAULT_DESIGN_FLOOR, minOperations: 1, traceEveryStory: false }, ['design.operations.min', 'Fewer than 1 operation']],
    ['one shapeless operation', { operations: [good.operations[0], { ...good.operations[1], returns: ' ' }] }, DEFAULT_DESIGN_FLOOR, ['design.operations.shape', '1 operation has no input or no return']],
    ['two shapeless operations', { operations: good.operations.map((o) => ({ ...o, inputs: [] })) }, DEFAULT_DESIGN_FLOOR, ['design.operations.shape', '2 operations have no input or no return']],
    ['singular decision', { decisions: [] }, DEFAULT_DESIGN_FLOOR, ['design.decisions.min', 'Fewer than 1 decision']],
    ['plural decisions', {}, { ...DEFAULT_DESIGN_FLOOR, minDecisions: 2 }, ['design.decisions.min', 'Fewer than 2 decisions']],
    ['one shapeless decision', { decisions: [{ ...good.decisions[0], tradeOff: '' }] }, DEFAULT_DESIGN_FLOOR, ['design.decisions.shape', '1 decision has no rationale or no trade-off']],
    ['two shapeless decisions', { decisions: [{ ...good.decisions[0], rationale: '' }, { ...good.decisions[0], id: 'D2', rationale: '' }] }, DEFAULT_DESIGN_FLOOR, ['design.decisions.shape', '2 decisions have no rationale or no trade-off']],
    ['one untraced story', { operations: [good.operations[0], { ...good.operations[1], satisfies: [] }] }, DEFAULT_DESIGN_FLOOR, ['design.trace', 'Story not traced by any operation or entity: US-2']],
    ['two untraced stories', { entities: good.entities.map((e) => ({ ...e, satisfies: [] })), operations: good.operations.map((o) => ({ ...o, satisfies: o.id === 'O1' ? ['US-3'] : [] })) }, DEFAULT_DESIGN_FLOOR, ['design.trace', 'Stories not traced by any operation or entity: US-2, US-4']],
  ])('%s', (_name, over, floor, expected) => {
    expect(failing(over as Partial<Design>, floor)).toEqual([expected]);
  });
  it.each([
    ['singular endpoint', { [A]: '{"operations":[],"errors":{"x":{}}}' }, { ...DEFAULT_DESIGN_FLOOR, minEndpoints: 1 }, ['design.api.min', 'Fewer than 1 endpoint in the API contract']],
    ['plural endpoints', {}, { ...DEFAULT_DESIGN_FLOOR, minEndpoints: 3 }, ['design.api.min', 'Fewer than 3 endpoints in the API contract']],
    ['a row without a method and a path is not an endpoint', { [A]: JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/api/a' }, { id: 'b', method: '', path: '' }, { id: 'c', method: 'POST', path: '  ' }, { id: 'd', path: '/api/d' }], errors: { x: {} } }) }, { ...DEFAULT_DESIGN_FLOOR, minEndpoints: 2 }, ['design.api.min', 'Fewer than 2 endpoints in the API contract']],
    ['no catalogue', { [A]: JSON.stringify({ ...JSON.parse(api), errors: {} }) }, DEFAULT_DESIGN_FLOOR, ['design.api.errors', 'The API contract has no error catalogue']],
    ['plural screens', {}, { ...DEFAULT_DESIGN_FLOOR, minScreens: 2 }, ['design.screens.min', 'Fewer than 2 screens in the screen contract']],
    ['singular screen', { [S]: '{"screens":[]}' }, DEFAULT_DESIGN_FLOOR, ['design.screens.min', 'Fewer than 1 screen in the screen contract']],
    ['one incomplete screen', { [S]: JSON.stringify({ screens: [{ ...JSON.parse(screens).screens[0], empty: 'too short' }] }) }, DEFAULT_DESIGN_FLOOR, ['design.screens.shape', '1 screen is missing a component, reads, components or an empty-state sentence']],
    ['two incomplete screens', { [S]: JSON.stringify({ screens: [{ route: '#/a' }, { route: '#/b' }] }) }, DEFAULT_DESIGN_FLOOR, ['design.screens.shape', '2 screens are missing a component, reads, components or an empty-state sentence']],
  ])('%s', (_name, extra, floor, expected) => {
    expect(failing({}, floor, extra as Record<string, string>)).toEqual([expected]);
  });
  it('counts an endpoint with a method and a non-blank path, beside a blank row', () => {
    const two = JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/api/a' }, { id: 'b', method: 'POST', path: '/api/b' }, { id: 'c', method: '', path: '' }], errors: { x: {} } });
    expect(failing({}, { ...DEFAULT_DESIGN_FLOOR, minEndpoints: 2 }, { [A]: two })).toEqual([]);
  });
  it('fails the record and every count when the record is missing, and counts a broken contract as empty', () => {
    const r = evaluateDesignFloor({ [A]: '{', [S]: screens }, spec);
    expect(r[0]).toEqual({ id: 'design.record', label: 'The design record', passed: false, detail: 'The design record is missing or not valid' });
    expect(r.find((x) => x.id === 'design.api.min')!.passed).toBe(false);
  });
  it.each([
    ['no diagram', { sequence: undefined }, false],
    ['a diagram that names no operation', { sequence: 'Browser -> Api: GET /api/tasks/overdue' }, false],
    ['an operation name inside a longer word', { sequence: 'Api -> Repo: getOverdueCount' }, false],
    ['an operation name in another case', { sequence: 'Api -> Repo: getoverdue' }, false],
    ['the bare name, before the parenthesis', { sequence: 'Api -> Repo: getOverdue' }, true],
    ['the name with arguments of its own', { sequence: 'Api -> Repo: completeTask(42)' }, true],
  ])('the sequence rule, on: %s', (_name, over, passes) => {
    const r = evaluateDesignFloor({ ...docs, [R]: serialiseDesign({ ...good, ...over } as Design) }, spec).find((x) => x.id === 'design.sequence')!;
    expect(r.passed).toBe(passes);
    if (!passes) expect(r.detail).toBe('The sequence diagram is missing or names none of the operations');
  });
  it('emits no sequence rule when the sequence diagram is off, whatever the record holds', () => {
    const r = evaluateDesignFloor({ ...docs, [R]: serialiseDesign({ ...good, sequence: undefined }) }, { ...spec, sequence: false });
    expect(r.some((x) => x.id === 'design.sequence')).toBe(false);
    expect(r.filter((x) => !x.passed)).toEqual([]);
  });
  it('counts no $-prefixed key of the error catalogue as an error', () => {
    const commented = JSON.stringify({ ...JSON.parse(api), errors: { $comment: 'every error has a code and a message' } });
    expect(failing({}, DEFAULT_DESIGN_FLOOR, { [A]: commented })).toEqual([['design.api.errors', 'The API contract has no error catalogue']]);
  });
  it('names a story listed twice once in the trace sentence', () => {
    const twice = [...spec.stories, { id: 'US-9', title: 'Gone', line: 'w' }, { id: 'US-9', title: 'Gone', line: 'w' }];
    const r = evaluateDesignFloor(docs, { ...spec, stories: twice }).find((x) => x.id === 'design.trace')!;
    expect(r.detail).toBe('Story not traced by any operation or entity: US-9');
  });
  it('turns every shape rule off when its toggle is off', () => {
    const off = { ...DEFAULT_DESIGN_FLOOR, operationShape: false, decisionShape: false, traceEveryStory: false, requireErrorCatalogue: false, screenShape: false };
    expect(failing({ operations: good.operations.map((o) => ({ ...o, inputs: [], satisfies: [] })), decisions: [{ ...good.decisions[0], rationale: '' }] }, off, { [S]: '{"screens":[{"route":"#/"}]}' })).toEqual([]);
  });
});

describe('designFloorIds and operationBaseName', () => {
  it.each([
    [{ api: true, screens: true }, true],
    [{ api: true, screens: false }, false],
    [{ api: false, screens: true }, true],
    [{ api: false, screens: false }, false],
  ])('names exactly the rules the floor emits for contracts %j and sequence %s', (contracts, sequence) => {
    const ids = designFloorIds({ contracts, sequence });
    expect(evaluateDesignFloor(docs, { ...spec, contracts, sequence }).map((x) => x.id)).toEqual(ids);
    expect(ids.includes('design.api.min')).toBe(contracts.api);
    expect(ids.includes('design.screens.shape')).toBe(contracts.screens);
    expect(ids.includes('design.sequence')).toBe(sequence);
  });
  it('cuts an operation name at its first parenthesis and trims it', () => {
    expect(operationBaseName('getOverdue(today)')).toBe('getOverdue');
    expect(operationBaseName(' listTasks ')).toBe('listTasks');
    expect(operationBaseName('(x)')).toBe('');
  });
});

describe('designFloorSentence', () => {
  it('restates the defaults in one sentence', () => {
    expect(designFloorSentence(DEFAULT_DESIGN_FLOOR, { contracts: { api: true, screens: false }, sequence: false })).toBe(
      'at least 2 entities and 1 relation; at least 2 operations, each with an input and a return; at least 1 decision with a rationale and a trade-off; every story traced to an operation or an entity; at least 2 endpoints and an error catalogue in the API contract',
    );
  });
  it('adds the screen contract and leaves out what is zero or off', () => {
    expect(designFloorSentence({ ...DEFAULT_DESIGN_FLOOR, minEntities: 0, minRelations: 0, minDecisions: 2, traceEveryStory: false }, { contracts: { api: false, screens: true }, sequence: false })).toBe(
      'at least 2 operations, each with an input and a return; at least 2 decisions, each with a rationale and a trade-off; at least 1 screen in the screen contract, each with a component, reads, components and an empty-state sentence',
    );
  });
  it('names a shape rule whose minimum is 0', () => {
    const zero = { ...DEFAULT_DESIGN_FLOOR, minEntities: 0, minRelations: 0, minOperations: 0, minDecisions: 0, traceEveryStory: false, minScreens: 0 };
    expect(designFloorSentence(zero, { contracts: { api: false, screens: true }, sequence: false })).toBe(
      'every operation with an input and a return; every decision with a rationale and a trade-off; '
      + 'every screen in the screen contract with a component, reads, components and an empty-state sentence',
    );
  });
  it('asks for a valid record when no other rule is on, never for nothing', () => {
    const none = {
      ...DEFAULT_DESIGN_FLOOR, minEntities: 0, minRelations: 0, minOperations: 0, operationShape: false, minDecisions: 0, decisionShape: false,
      traceEveryStory: false, minEndpoints: 0, requireErrorCatalogue: false, minScreens: 0, screenShape: false,
    };
    expect(designFloorSentence(none, { contracts: { api: true, screens: true }, sequence: false })).toBe('a valid design record');
  });
  it('ends with the sequence diagram when it is on', () => {
    expect(designFloorSentence(DEFAULT_DESIGN_FLOOR, { contracts: { api: false, screens: false }, sequence: true })).toBe(
      'at least 2 entities and 1 relation; at least 2 operations, each with an input and a return; at least 1 decision with a rationale and a trade-off; every story traced to an operation or an entity; a sequence diagram that names at least one of the operations',
    );
  });
});

describe('designReviewProjection', () => {
  it('gives one citable path per field, in document order', () => {
    const p = designReviewProjection(docs, spec);
    expect(Object.keys(p).slice(0, 6)).toEqual(['design/entity-1/name', 'design/entity-1/kind', 'design/entity-1/attributes', 'design/entity-1/responsibilities', 'design/entity-1/satisfies', 'design/entity-2/name']);
    expect(p['design/entity-1/kind']).toBe('class');
    expect(p['design/entity-1/responsibilities']).toBe('knows when it is overdue');
    expect(p['design/relation-1']).toBe('List (E2) composition Task (E1), 1 to *: holds');
    expect(p['design/operation-1/inputs']).toBe('today');
    expect(p['design/operation-1/note']).toBe('boundary: due today is not overdue');
    expect(p['design/decision-1/trade-off']).toBe('callers send it');
    expect(p['design/decision-1/context']).toBe('tests replay one day');
    expect(p['design/decision-1/consequences']).toBe('every caller sends today');
    expect(p['design/decision-1/superseded-by']).toBe('');
    expect(p['design/decision-1/satisfies']).toBe('US-4');
    expect(p['design/operation-1/name']).toBe('O1: getOverdue(today)');
    expect(p['design/decision-1/title']).toBe('D1: Clock');
    expect(p['api/endpoint-1/id']).toBe('a');
    expect(p['api/dtos']).toBe('');
    expect(p['design/sequence']).toBe('Browser -> Api: getOverdue(today)\nApi --> Browser: Task[]');
    expect(p['design/notes']).toBe('E2E-PASS');
    expect(p['api/endpoint-1/route']).toBe('GET /api/a');
    expect(p['api/endpoint-1/success']).toBe('200 A');
    expect(p['api/endpoint-2/errors']).toBe('bad');
    expect(p['api/errors']).toBe('bad: 400 bad input');
    expect(p['api/entities']).toBe('tasks: id integer');
    expect(p['screens/screen-1/empty']).toBe('Nothing is overdue. You are all caught up.');
  });
  it('projects exactly the review paths below, in their order', () => {
    const shapes = [...new Set(Object.keys(designReviewProjection(docs, spec)).map((k) => k.replace(/-\d+/, '-N')))];
    expect(shapes).toEqual([
      'design/entity-N/name', 'design/entity-N/kind', 'design/entity-N/attributes', 'design/entity-N/responsibilities', 'design/entity-N/satisfies',
      'design/relation-N',
      'design/operation-N/name', 'design/operation-N/inputs', 'design/operation-N/returns', 'design/operation-N/errors', 'design/operation-N/satisfies', 'design/operation-N/note',
      'design/decision-N/title', 'design/decision-N/choice', 'design/decision-N/alternative', 'design/decision-N/rationale', 'design/decision-N/trade-off',
      'design/decision-N/context', 'design/decision-N/consequences', 'design/decision-N/status', 'design/decision-N/superseded-by',
      'design/decision-N/satisfies',
      'design/sequence', 'design/notes',
      'api/entities', 'api/dtos',
      'api/endpoint-N/id', 'api/endpoint-N/route', 'api/endpoint-N/summary', 'api/endpoint-N/query', 'api/endpoint-N/body', 'api/endpoint-N/success', 'api/endpoint-N/errors', 'api/endpoint-N/example',
      'api/errors',
      'screens/screen-N/route', 'screens/screen-N/title', 'screens/screen-N/component', 'screens/screen-N/reads', 'screens/screen-N/shows', 'screens/screen-N/components', 'screens/screen-N/empty',
    ]);
  });
  it('projects no contract that is off, and design/sequence only when the sequence diagram is on', () => {
    const keys = Object.keys(designReviewProjection(docs, { contracts: { api: false, screens: false }, sequence: false }));
    expect(keys.some((k) => k.startsWith('api/') || k.startsWith('screens/'))).toBe(false);
    expect(keys).not.toContain('design/sequence');
  });
  it('renders the consequences list one per line, blank lines left out, and the superseded-by link', () => {
    const record = serialiseDesign({ ...good, decisions: [{ ...good.decisions[0], status: 'superseded', supersededBy: 'D2', consequences: ['one writer', '', 'no joins'] }] });
    const p = designReviewProjection({ [R]: record }, { contracts: { api: false, screens: false }, sequence: false });
    expect(p['design/decision-1/consequences']).toBe('one writer\nno joins');
    expect(p['design/decision-1/superseded-by']).toBe('D2');
  });
  it('is empty for an invalid record and no contracts', () => {
    expect(designReviewProjection({ [R]: '{' }, { contracts: { api: false, screens: false }, sequence: false })).toEqual({});
  });
});

describe('designChangeSet and designCarried', () => {
  it('never hides a change whose two sides would read the same: a number against text, a list against joined text, an empty query part, a written "unstated"', () => {
    const contract = (op: Record<string, unknown>) => JSON.stringify({ operations: [{ id: 'a', method: 'GET', path: '/api/a', ...op }], errors: {} });
    const both = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      designChangeSet({ ...docs, [A]: contract(a) }, { ...docs, [A]: contract(b) }, spec).map((c) => c.path);
    expect(both({ success: { status: 200 } }, { success: { status: '200' } })).toEqual(['api/endpoint-1/success']);
    expect(both({ errors: ['bad', 'gone'] }, { errors: 'bad, gone' })).toEqual(['api/endpoint-1/errors']);
    expect(both({ query: [{ name: 'q', description: 'd' }] }, { query: [{ name: 'q', type: '', description: 'd' }] })).toEqual(['api/endpoint-1/query']);
    const relation = (fromCard?: string) => serialiseDesign({ ...good, relations: [{ ...good.relations[0], fromCard, toCard: '*' }] });
    expect(designChangeSet({ ...docs, [R]: relation(undefined) }, { ...docs, [R]: relation('unstated') }, spec).map((c) => c.path)).toEqual(['design/relation-1']);
    // the review's own text is unchanged: it still reads the two sides the same
    expect(designReviewProjection({ ...docs, [A]: contract({ success: { status: '200' } }) }, spec)['api/endpoint-1/success']).toBe('200');
  });
  it('lists changed, added and removed fields over the three documents', () => {
    const after = { ...docs, [R]: serialiseDesign({ ...good, operations: [...good.operations, { id: 'O3', name: 'listTasks(listId)', inputs: ['listId'], returns: 'Task[]', errors: [], satisfies: ['US-3'] }], notes: '' }) };
    const changes = designChangeSet(docs, after, spec);
    expect(changes).toEqual(expect.arrayContaining([
      { path: 'design/operation-3/name', after: 'O3: listTasks(listId)' },
      { path: 'design/notes', before: 'E2E-PASS' },
    ]));
    expect(changes.some((c) => c.path.startsWith('api/'))).toBe(false);
  });
  it('lists a changed kind and cardinality as ordinary fields', () => {
    const after = { ...docs, [R]: serialiseDesign({ ...good, entities: [{ ...good.entities[0], kind: 'service' }, good.entities[1]], relations: [{ ...good.relations[0], toCard: '0..1' }] }) };
    expect(designChangeSet(docs, after, spec)).toEqual([
      { path: 'design/entity-1/kind', before: 'class', after: 'service' },
      { path: 'design/relation-1', before: 'List (E2) composition Task (E1), 1 to *: holds', after: 'List (E2) composition Task (E1), 1 to 0..1: holds' },
    ]);
  });
  const withApi = (over: Record<string, unknown>) => ({ ...docs, [A]: JSON.stringify({ ...JSON.parse(api), ...over }) });
  const endpoints = JSON.parse(api).operations as Record<string, unknown>[];
  it('renders an object success body as canonical JSON, and lists a change to it', () => {
    const body = (b: unknown) => withApi({ operations: [{ ...endpoints[0], success: { status: 200, body: b } }, endpoints[1]] });
    expect(designReviewProjection(body({ total: 2, items: ['Task'] }), spec)['api/endpoint-1/success']).toBe('200 {"items":["Task"],"total":2}');
    expect(designChangeSet(body({ total: 2, items: ['Task'] }), body({ items: ['Task'], total: 3 }), spec)).toEqual([
      { path: 'api/endpoint-1/success', before: '200 {"items":["Task"],"total":2}', after: '200 {"items":["Task"],"total":3}' },
    ]);
  });
  it('reads a renamed endpoint id as a removal and an addition', () => {
    const changes = designChangeSet(docs, withApi({ operations: [endpoints[0], { ...endpoints[1], id: 'c' }] }), spec);
    expect(changes).toEqual([
      { path: 'api/endpoint-2/id', before: 'b' }, { path: 'api/endpoint-2/route', before: 'POST /api/b' }, { path: 'api/endpoint-2/errors', before: 'bad' },
      { path: 'api/endpoint-3/id', after: 'c' }, { path: 'api/endpoint-3/route', after: 'POST /api/b' }, { path: 'api/endpoint-3/errors', after: 'bad' },
    ]);
  });
  it('lists an added dto in canonical JSON', () => {
    expect(designChangeSet(docs, withApi({ dtos: { Task: { from: 'tasks', adds: [{ type: 'string[]', name: 'tags' }] } } }), spec)).toEqual([
      { path: 'api/dtos', after: 'Task: {"adds":[{"name":"tags","type":"string[]"}],"from":"tasks"}' },
    ]);
  });
  it("lists a change to a decision's stories", () => {
    const after = { ...docs, [R]: serialiseDesign({ ...good, decisions: [{ ...good.decisions[0], satisfies: ['US-3', 'US-4'] }] }) };
    expect(designChangeSet(docs, after, spec)).toEqual([{ path: 'design/decision-1/satisfies', before: 'US-4', after: 'US-3, US-4' }]);
  });
  it('reads a removed operation as removals, never as a chain of renames', () => {
    const o3 = { id: 'O3', name: 'listTasks(listId)', inputs: ['listId'], returns: 'Task[]', errors: [], satisfies: ['US-3'] };
    const before = { ...docs, [R]: serialiseDesign({ ...good, operations: [...good.operations, o3] }) };
    const after = { ...docs, [R]: serialiseDesign({ ...good, operations: [good.operations[1], o3] }) };
    expect(designChangeSet(before, after, spec)).toEqual([
      { path: 'design/operation-1/name', before: 'O1: getOverdue(today)' }, { path: 'design/operation-1/inputs', before: 'today' },
      { path: 'design/operation-1/returns', before: 'Task[]' }, { path: 'design/operation-1/errors', before: 'invalid_date' },
      { path: 'design/operation-1/satisfies', before: 'US-4' }, { path: 'design/operation-1/note', before: 'boundary: due today is not overdue' },
    ]);
  });
  it('places each change-set item, found by its id, at its number in the applied documents', () => {
    const op = (id: string, returns: string) => ({ id, name: `${id.toLowerCase()}()`, inputs: [], returns, errors: [], satisfies: ['US-4'] });
    const before = { ...docs, [R]: serialiseDesign({ ...good, operations: [op('O1', 'Task'), op('O2', 'Task'), op('O3', 'Task'), op('O4', 'Task[]')] }) };
    const after = {
      ...docs,
      [R]: serialiseDesign({ ...good, operations: [op('O5', 'Task'), op('O2', 'Task'), op('O3', 'Task[]'), op('O4', 'Task[]')] }),
      [A]: JSON.stringify({ ...JSON.parse(api), operations: [endpoints[1]] }),
    };
    const places = designItemPlaces(before, after);
    // O1 is removed; O2 to O4 move up past the new O5, which the change set numbers last
    expect(['design/operation-1', 'design/operation-2', 'design/operation-3', 'design/operation-4', 'design/operation-5'].map((at) => places[at]))
      .toEqual([null, 'design/operation-2', 'design/operation-3', 'design/operation-4', 'design/operation-1']);
    expect(designChangeSet(before, after, spec).filter((c) => c.path.endsWith('/returns'))).toEqual([
      { path: 'design/operation-1/returns', before: 'Task' }, { path: 'design/operation-3/returns', before: 'Task', after: 'Task[]' }, { path: 'design/operation-5/returns', after: 'Task' },
    ]);
    // an endpoint by its id, a screen by its route
    expect([places['api/endpoint-1'], places['api/endpoint-2'], places['screens/screen-1'], places['design/entity-2'], places['design/decision-1']])
      .toEqual([null, 'api/endpoint-1', 'screens/screen-1', 'design/entity-2', 'design/decision-1']);
  });
  it('reads a reordered list, attributes included, as no change', () => {
    const attrs = [{ name: 'due_date', type: 'date' }, { name: 'title', type: 'text' }];
    const before = { ...docs, [R]: serialiseDesign({ ...good, entities: [{ ...good.entities[0], attributes: attrs }, good.entities[1]] }) };
    const after = {
      ...docs,
      [R]: serialiseDesign({ ...good, entities: [good.entities[1], { ...good.entities[0], attributes: [...attrs].reverse() }] }),
      [A]: JSON.stringify({ ...JSON.parse(api), operations: [...endpoints].reverse() }),
    };
    expect(designChangeSet(before, after, spec)).toEqual([]);
  });
  it("lists a change to a contract's own keys beside its lists, which the review does not cite", () => {
    const before = withApi({ base: '/api' });
    const changes = designChangeSet(before, withApi({ base: '/v1' }), spec);
    expect(changes).toEqual([{ path: 'api/document', before: '{"base":"/api"}', after: '{"base":"/v1"}' }]);
    expect(Object.keys(designReviewProjection(before, spec))).not.toContain('api/document');
  });
  it('misses no leaf of the three documents: a change to any one of them is listed', () => {
    const record: Design = {
      ...good,
      entities: [{ ...good.entities[0], attributes: [{ name: 'due_date', type: 'date', note: 'may be empty' }] }, good.entities[1]],
      decisions: [{ ...good.decisions[0], status: 'superseded', supersededBy: 'D1', decidedAt: '2026-10-14' }],
    };
    const fullApi = {
      $comment: 'the contract', version: '2.0.0', base: '/api',
      entities: { tasks: { table: 'tasks', description: 'one row a task', fields: [{ name: 'id', type: 'integer', primaryKey: true }] } },
      dtos: { Task: { from: 'tasks', adds: [{ name: 'tags', type: 'string[]' }] } },
      operations: [{
        id: 'a', method: 'GET', path: '/api/a', summary: 'one', satisfies: ['US-4'], auth: 'none',
        query: [{ name: 'today', type: 'date', required: true, description: 'the day' }], body: { name: 'string' },
        success: { status: 200, body: { items: 'Task[]' }, headers: { etag: 'x' } }, errors: ['bad'], 'x-example': { today: '2026-10-14' },
      }],
      errors: { $comment: 'one shape', bad: { status: 400, meaning: 'bad input', retry: false } },
    };
    const fullScreens = {
      $comment: 'the screens', router: 'hash', components: { TaskRow: { props: ['task'] } },
      screens: [{ ...JSON.parse(screens).screens[0], satisfies: ['US-4'], writes: ['completeTask'], testIds: ['overdue-page'] }],
    };
    const base = { [R]: serialiseDesign(record), [A]: JSON.stringify(fullApi), [S]: JSON.stringify(fullScreens) };
    // every leaf, by its route through the document, changed one at a time
    const leaves = (v: unknown, at: (string | number)[] = []): (string | number)[][] =>
      v !== null && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, Array.isArray(v) ? Number(k) : k])) : [at];
    const changed = (doc: unknown, route: (string | number)[]): unknown => {
      const copy = JSON.parse(JSON.stringify(doc));
      const parent = route.slice(0, -1).reduce((o, k) => o[k], copy);
      const last = route[route.length - 1];
      const v = parent[last];
      parent[last] = typeof v === 'string' ? `${v}x` : typeof v === 'number' ? v + 1 : typeof v === 'boolean' ? !v : 'x';
      return copy;
    };
    const documents: [string, unknown][] = [[R, JSON.parse(base[R])], [A, fullApi], [S, fullScreens]];
    for (const [path, doc] of documents) {
      const routes = leaves(doc);
      expect(routes.length).toBeGreaterThan(10);
      for (const route of routes) {
        const after = { ...base, [path]: JSON.stringify(changed(doc, route)) };
        expect([path, route, designChangeSet(base, after, spec).length > 0]).toEqual([path, route, true]);
      }
    }
  });
  it('names the ids and statuses a proposal carries, and nothing else', () => {
    expect(designCarried(docs)).toEqual(['entity E1', 'entity E2', 'operation O1', 'operation O2', 'decision D1', 'the status of D1']);
  });
});

import { DEFAULT_DESIGN_FLOOR, DESIGN_PROPOSAL_REFUSED, DESIGN_PROPOSAL_UNCHANGED, serialiseDesign, type Design } from '@learnsdlc/shared';
import { designBriefing, listsAsWritten, normaliseDesignProposal, statusesAsCarried, validateDesignProposal } from './design-proposal';
import { RefusedProposalException } from './proposal-refusal';
import { structuredReference } from './structured-evidence';

const R = 'design/design.json', A = 'shared/contract/api.json';
const phase = { key: 'design', files: [{ path: R, editable: true }, { path: A, editable: true }],
  checks: { kind: 'design', record: R, contracts: { api: true, screens: false }, sequence: false, stories: [{ id: 'US-4', title: 'Overdue', line: 'x' }], floor: DEFAULT_DESIGN_FLOOR } } as never;
const withSequence = { ...(phase as object), checks: { ...(phase as { checks: object }).checks, sequence: true } } as never;
const live: Design = {
  entities: [{ id: 'E1', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }, { id: 'E2', name: 'List', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }],
  relations: [{ id: 'R1', from: 'E2', to: 'E1', kind: 'composition', fromCard: '1', toCard: '*' }],
  operations: [{ id: 'O1', name: 'getOverdue', inputs: ['today'], returns: 'Task[]', errors: [], satisfies: ['US-4'] }],
  decisions: [{ id: 'D1', title: 't', choice: 'c', alternative: 'a', rationale: 'r', tradeOff: 'o', status: 'proposed', satisfies: [] }],
  sequence: 'Browser -> Api: getOverdue',
};
const liveFiles = { [R]: serialiseDesign(live), [A]: '{"operations":[],"errors":{}}' };

describe('normaliseDesignProposal', () => {
  it('carries a renamed id and a flipped status, and moves the relation with the id', () => {
    const proposed = { ...live, entities: [{ ...live.entities[0], id: 'E9' }, live.entities[1]], relations: [{ ...live.relations[0], to: 'E9' }], decisions: [{ ...live.decisions[0], status: 'accepted' as const }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, liveFiles)[R]);
    expect(out.entities[0].id).toBe('E1');
    expect(out.relations[0].to).toBe('E1');
    expect(out.decisions[0].status).toBe('proposed');
  });
  it('lets a new item keep its own id, and a new decision start as proposed', () => {
    const proposed = { ...live, operations: [...live.operations, { id: 'O2', name: 'completeTask', inputs: ['id'], returns: 'Task', errors: [], satisfies: [] }], decisions: [...live.decisions, { ...live.decisions[0], id: 'D2', status: 'accepted' as const }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, liveFiles)[R]);
    expect(out.operations.map((o: { id: string }) => o.id)).toEqual(['O1', 'O2']);
    expect(out.decisions[1].status).toBe('proposed');
  });
  it('carries only ids and statuses: a proposed kind, cardinality, note, consequence and superseded-by link are kept as proposed', () => {
    const proposed = { ...live, entities: [{ ...live.entities[0], kind: 'service' as const }, live.entities[1]], relations: [{ ...live.relations[0], kind: 'dependency' as const, toCard: '0..1' }],
      operations: [{ ...live.operations[0], note: 'boundary: due today is not overdue' }], decisions: [{ ...live.decisions[0], consequences: ['every caller sends today'], supersededBy: 'D2' }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, liveFiles)[R]);
    expect(out.entities[0].kind).toBe('service');
    expect(out.relations[0]).toMatchObject({ kind: 'dependency', fromCard: '1', toCard: '0..1' });
    expect(out.operations[0].note).toBe('boundary: due today is not overdue');
    expect(out.decisions[0].consequences).toEqual(['every caller sends today']);
    expect(out.decisions[0].supersededBy).toBe('D2');
  });
  it('keeps the saved sequence while the sequence diagram is off, and takes the proposed one when it is on', () => {
    const proposed = { [R]: serialiseDesign({ ...live, sequence: 'Browser -> Api: completeTask' }) };
    expect(JSON.parse(normaliseDesignProposal(proposed, phase, liveFiles)[R]).sequence).toBe('Browser -> Api: getOverdue');
    expect(JSON.parse(normaliseDesignProposal(proposed, withSequence, liveFiles)[R]).sequence).toBe('Browser -> Api: completeTask');
  });
  it.each([
    ['an invalid record', { [R]: '{"entities":[]}' }],
    ['an invalid contract', { [A]: '{"errors":{}}' }],
    ['a contract that is off', { 'shared/contract/screens.json': '{"screens":[]}' }],
    ['a path that is not a document', { 'notes.md': 'x' }],
  ])('refuses %s with the fixed sentence', (_n, files) => {
    expect(() => normaliseDesignProposal(files, phase, liveFiles)).toThrow(DESIGN_PROPOSAL_REFUSED);
  });
  // Added beside the brief's cases: the carry notes of the earlier reviews.
  it('carries the room\'s decided-at stamp with the status it records', () => {
    const stamped = { ...live, decisions: [{ ...live.decisions[0], status: 'accepted' as const, decidedAt: '2026-10-14T00:00:00Z' }] };
    const proposed = { ...stamped, decisions: [{ ...stamped.decisions[0], status: 'proposed' as const, decidedAt: undefined }, { ...live.decisions[0], id: 'D2', decidedAt: '2026-10-15T00:00:00Z' }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, { [R]: serialiseDesign(stamped) })[R]);
    expect(out.decisions[0]).toMatchObject({ status: 'accepted', decidedAt: '2026-10-14T00:00:00Z' });
    expect(out.decisions[1].status).toBe('proposed');
    expect(out.decisions[1].decidedAt).toBeUndefined();
  });
  it('matches a kept item by its id, not its place: a removed O1 and an added O4 are a removal and an addition', () => {
    const three = { ...live, operations: ['O1', 'O2', 'O3'].map((id) => ({ ...live.operations[0], id, name: `op${id}` })) };
    const proposed = { ...three, operations: [three.operations[1], three.operations[2], { ...three.operations[0], id: 'O4', name: 'opO4' }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, { [R]: serialiseDesign(three) })[R]);
    expect(out.operations.map((o: { id: string; name: string }) => `${o.id}:${o.name}`)).toEqual(['O2:opO2', 'O3:opO3', 'O4:opO4']);
  });
  it('gives a new decision written in an accepted one\'s place that decision\'s id, status and stamp, and the change set shows it', () => {
    const stamped: Design = { ...live, decisions: [{ ...live.decisions[0], status: 'accepted', decidedAt: '2026-10-14T00:00:00Z' }] };
    const saved = { [R]: serialiseDesign(stamped) };
    const proposed = { ...stamped, decisions: [{ ...live.decisions[0], id: 'D2', title: 'Replaced', status: 'proposed' as const }] };
    const files = normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, saved);
    expect(JSON.parse(files[R]).decisions[0]).toMatchObject({ id: 'D1', title: 'Replaced', status: 'accepted', decidedAt: '2026-10-14T00:00:00Z' });
    const out = structuredReference(phase, saved, files)!;
    expect(out.changes).toEqual([{ path: 'design/decision-1/title', before: 'D1: t', after: 'D1: Replaced' }]);
    expect(out.carried).toContain('the status of D1');
  });
  it('points a superseded-by link at a renamed decision\'s live id', () => {
    const two: Design = { ...live, decisions: [live.decisions[0], { ...live.decisions[0], id: 'D2', title: 'old', status: 'superseded', supersededBy: 'D1' }] };
    const proposed = { ...two, decisions: [{ ...two.decisions[0], id: 'D9' }, { ...two.decisions[1], supersededBy: 'D9' }] };
    const out = JSON.parse(normaliseDesignProposal({ [R]: serialiseDesign(proposed) }, phase, { [R]: serialiseDesign(two) })[R]);
    expect(out.decisions.map((d: { id: string }) => d.id)).toEqual(['D1', 'D2']);
    expect(out.decisions[1].supersededBy).toBe('D1');
  });
  it('takes a screen contract as sent when both contracts are on', () => {
    const both = { ...(phase as object), checks: { ...(phase as { checks: object }).checks, contracts: { api: true, screens: true } } } as never;
    const screens = '{ "screens": [{ "route": "/overdue", "extra": 1 }] }';
    expect(normaliseDesignProposal({ 'shared/contract/screens.json': screens, [A]: '{"operations":[]}' }, both, liveFiles))
      .toEqual({ 'shared/contract/screens.json': screens, [A]: '{"operations":[]}' });
    expect(() => normaliseDesignProposal({ 'shared/contract/screens.json': '{"screens":[{}]}' }, both, liveFiles)).toThrow(DESIGN_PROPOSAL_REFUSED);
  });
  it('drops a key the record does not have, as the workspace guard does', () => {
    const out = normaliseDesignProposal({ [R]: JSON.stringify({ ...live, padding: 'x' }) }, phase, liveFiles)[R];
    expect(out).toBe(serialiseDesign(live));
  });
});

describe('normaliseDesignProposal for a generated proposal (dropUnchanged)', () => {
  it('leaves out a document that normalises to the saved one, and refuses a proposal that changes nothing', () => {
    // a renamed id is carried back, so the record reads as saved: only the contract is a change
    const renamed = serialiseDesign({ ...live, operations: [{ ...live.operations[0], id: 'O9' }] });
    const contract = '{"operations":[{"id":"a","method":"GET","path":"/api/a"}],"errors":{}}';
    expect(normaliseDesignProposal({ [R]: renamed, [A]: contract }, phase, liveFiles, { dropUnchanged: true })).toEqual({ [A]: contract });
    expect(() => normaliseDesignProposal({ [R]: renamed }, phase, liveFiles, { dropUnchanged: true })).toThrow(DESIGN_PROPOSAL_UNCHANGED);
    // without the option the saved-equal record is kept, as an apply re-check reads it
    expect(Object.keys(normaliseDesignProposal({ [R]: renamed }, phase, liveFiles))).toEqual([R]);
  });
  it('says a valid proposal that changes nothing changed nothing, never that it was not a valid design', () => {
    const asSaved = { [R]: serialiseDesign(live), [A]: liveFiles[A] };
    let thrown: unknown;
    try { normaliseDesignProposal(asSaved, phase, liveFiles, { dropUnchanged: true }); } catch (error) { thrown = error; }
    expect((thrown as Error).message).toBe(DESIGN_PROPOSAL_UNCHANGED);
    expect((thrown as Error).message).not.toBe(DESIGN_PROPOSAL_REFUSED);
    // an invalid one is still refused with the refusal sentence
    expect(() => normaliseDesignProposal({ [R]: 'not a design' }, phase, liveFiles, { dropUnchanged: true })).toThrow(DESIGN_PROPOSAL_REFUSED);
  });
});
describe('normaliseDesignProposal for a learner\'s edit (refuseCarried)', () => {
  it('refuses a changed id, a changed status and a changed switched-off sequence, and stores a kept one as validated', () => {
    const edit = (record: Design) => () => normaliseDesignProposal({ [R]: serialiseDesign(record) }, phase, liveFiles, { refuseCarried: true });
    expect(edit({ ...live, entities: [{ ...live.entities[0], id: 'E9' }, live.entities[1]], relations: [{ ...live.relations[0], to: 'E9' }] })).toThrow(DESIGN_PROPOSAL_REFUSED);
    expect(edit({ ...live, decisions: [{ ...live.decisions[0], status: 'accepted' }] })).toThrow(DESIGN_PROPOSAL_REFUSED);
    expect(edit({ ...live, sequence: 'Browser -> Api: completeTask' })).toThrow(DESIGN_PROPOSAL_REFUSED);
    expect(normaliseDesignProposal({ [R]: JSON.stringify({ ...live, notes: 'n', padding: 1 }) }, phase, liveFiles, { refuseCarried: true })[R]).toBe(serialiseDesign({ ...live, notes: 'n' }));
  });
});

describe('validateDesignProposal (apply)', () => {
  it('passes a normalised proposal and refuses one that would still carry something', () => {
    const proposed = { [R]: serialiseDesign({ ...live, notes: 'more' }) };
    expect(() => validateDesignProposal(normaliseDesignProposal(proposed, phase, liveFiles), phase, liveFiles)).not.toThrow();
    const renamed = { [R]: serialiseDesign({ ...live, entities: [{ ...live.entities[0], id: 'E9' }, live.entities[1]], relations: [] }) };
    expect(() => validateDesignProposal(renamed, phase, liveFiles)).toThrow(DESIGN_PROPOSAL_REFUSED);
  });
  it('refuses a changed status, and a sequence that differs from the saved one while the diagram is off', () => {
    expect(() => validateDesignProposal({ [R]: serialiseDesign({ ...live, decisions: [{ ...live.decisions[0], status: 'accepted' }] }) }, phase, liveFiles)).toThrow(DESIGN_PROPOSAL_REFUSED);
    const sequence = { [R]: serialiseDesign({ ...live, sequence: 'Browser -> Api: completeTask' }) };
    expect(() => validateDesignProposal(sequence, phase, liveFiles)).toThrow(DESIGN_PROPOSAL_REFUSED);
    expect(() => validateDesignProposal(sequence, withSequence, liveFiles)).not.toThrow();
  });
});

describe('designBriefing', () => {
  it('names the schema, the floor and the carry rule, and no project', () => {
    const text = designBriefing(phase);
    expect(text).toContain('tradeOff');
    expect(text).toContain('responsibilities');
    expect(text).toContain('fromCard');
    expect(text).toContain('dependency');
    expect(text).toContain('"consequences":[text, at most 6]');
    // Every list of story ids with its shape, the decisions' included (a model may write it as a text)
    expect(text.match(/"satisfies":\[story ids\]/g)).toHaveLength(3);
    expect(text).toContain('"supersededBy","satisfies":[story ids]}');
    // The status field with its three values (a model may write a word of its own)
    expect(text).toContain('"status" (one of proposed, accepted, superseded; a new decision is proposed)');
    expect(text).toContain('supersededBy');
    expect(text).toContain('every story traced to an operation or an entity');
    expect(text).toContain('never change an id or a decision status');
    expect(text).toContain("Leave the record's sequence as it is");
    expect(text).not.toMatch(/TaskTrackr|overdue/i);
  });
  it('asks for a sequence that names an operation only when the sequence diagram is on', () => {
    const text = designBriefing(withSequence);
    expect(text).toContain('must name at least one of the operations by its name');
    expect(text).toContain('a sequence diagram that names at least one of the operations');
    expect(text).not.toContain("Leave the record's sequence as it is");
  });
});

/** The refusal thrown by `fn`, read for its code, clause and reason. */
const refusalOf = (fn: () => unknown): { code: string; clause: string; detail: string | null; message: string } => {
  try { fn(); } catch (error) {
    const e = error as RefusedProposalException;
    return { code: e.code, clause: e.clause, detail: e.detail, message: e.message };
  }
  throw new Error('nothing was thrown');
};

describe('a refusal says why', () => {
  it('carries the validator\'s own sentence after the fixed one, on the exception and in its message', () => {
    const bad = { [R]: serialiseDesign({ ...live, decisions: [{ ...live.decisions[0], satisfies: 'US-4' as unknown as string[] }] }) };
    const refusal = refusalOf(() => normaliseDesignProposal(bad, phase, liveFiles));
    expect([refusal.code, refusal.clause]).toEqual(['design_proposal_refused', 'invalid_document']);
    expect(refusal.detail).toBe('The design record is not valid: decision D1 satisfies is not a list.');
    expect(refusal.message).toBe(`${DESIGN_PROPOSAL_REFUSED} ${refusal.detail}`);
  });
  it.each([
    ['a document that is off', { 'shared/contract/screens.json': '{"screens":[]}' }, 'path_not_allowed', "`shared/contract/screens.json` is not one of this phase's design documents."],
    ['a path that is not a document', { 'notes.md': 'x' }, 'path_not_allowed', "`notes.md` is not one of this phase's design documents."],
    ['an invalid contract', { [A]: '{"errors":{}}' }, 'invalid_document', 'The API contract is not valid: The API contract has no operations list.'],
    ['a record that is not JSON', { [R]: 'not a design' }, 'invalid_document', 'The design record is not valid: The design record is not valid JSON.'],
    ['an invalid record', { [R]: '{"entities":[]}' }, 'invalid_document', 'The design record is not valid: relations is not a list.'],
  ])('names the rule and the reason for %s', (_n, files, clause, detail) => {
    expect(refusalOf(() => normaliseDesignProposal(files, phase, liveFiles))).toMatchObject({ code: 'design_proposal_refused', clause, detail });
  });
  it('names a learner\'s edit that changes a carried field, and a stored proposal that would', () => {
    const renamed = { [R]: serialiseDesign({ ...live, entities: [{ ...live.entities[0], id: 'E9' }, live.entities[1]], relations: [{ ...live.relations[0], to: 'E9' }] }) };
    expect(refusalOf(() => normaliseDesignProposal(renamed, phase, liveFiles, { refuseCarried: true }))).toMatchObject({ clause: 'carried_changed', detail: 'The edit changes an id, a decision status or the saved sequence, which a proposal keeps as saved.' });
    expect(refusalOf(() => validateDesignProposal(renamed, phase, liveFiles))).toMatchObject({ clause: 'carried_changed', detail: 'The stored proposal would change an id, a decision status or the saved sequence, which a proposal keeps as saved.' });
  });
  it('says a proposal that changes nothing changed nothing, with no reason after it', () => {
    expect(refusalOf(() => normaliseDesignProposal({ [R]: serialiseDesign(live) }, phase, liveFiles, { dropUnchanged: true }))).toEqual({ code: 'design_proposal_unchanged', clause: 'unchanged', detail: null, message: DESIGN_PROPOSAL_UNCHANGED });
  });
});

describe('listsAsWritten: a generated record\'s lone text where the schema has a list of texts', () => {
  const record = (patch: Record<string, unknown>) => JSON.stringify({ ...live, ...patch });
  it.each([
    ['a decision\'s satisfies', { decisions: [{ ...live.decisions[0], satisfies: 'US-4' }] }, (d: Design) => d.decisions[0].satisfies, ['US-4']],
    ['a decision\'s consequences', { decisions: [{ ...live.decisions[0], consequences: 'callers send today' }] }, (d: Design) => d.decisions[0].consequences, ['callers send today']],
    ['an entity\'s responsibilities', { entities: [{ ...live.entities[0], responsibilities: 'holds the due date' }, live.entities[1]] }, (d: Design) => d.entities[0].responsibilities, ['holds the due date']],
    ['an entity\'s satisfies', { entities: [{ ...live.entities[0], satisfies: 'US-4' }, live.entities[1]] }, (d: Design) => d.entities[0].satisfies, ['US-4']],
    ['an operation\'s inputs', { operations: [{ ...live.operations[0], inputs: 'today' }] }, (d: Design) => d.operations[0].inputs, ['today']],
    ['an operation\'s errors', { operations: [{ ...live.operations[0], errors: 'invalid_date' }] }, (d: Design) => d.operations[0].errors, ['invalid_date']],
    ['an operation\'s satisfies', { operations: [{ ...live.operations[0], satisfies: 'US-4' }] }, (d: Design) => d.operations[0].satisfies, ['US-4']],
  ])('reads %s as the one-item list it means', (_n, patch, pick, want) => {
    expect(pick(JSON.parse(listsAsWritten(record(patch))) as Design)).toEqual(want);
  });
  it.each([
    ['a comma list', 'US-3, US-4', ['US-3', 'US-4']],
    ['an "and" list', 'US-3 and US-4', ['US-3', 'US-4']],
    ['an id named twice', 'US-4 and US-4', ['US-4']],
    ['one id', 'US-4', ['US-4']],
    ['a text that names no id', 'the login story', ['the login story']],
  ])('reads a lone satisfies text that is %s as the story ids it names, in every section', (_n, text, want) => {
    const out = JSON.parse(listsAsWritten(record({
      entities: [{ ...live.entities[0], satisfies: text }, live.entities[1]],
      operations: [{ ...live.operations[0], satisfies: text }],
      decisions: [{ ...live.decisions[0], satisfies: text }],
    }))) as Design;
    expect([out.entities[0].satisfies, out.operations[0].satisfies, out.decisions[0].satisfies]).toEqual([want, want, want]);
  });
  it('keeps a lone text in a free-text list as the one-item list, even when it names several story ids', () => {
    const text = 'US-3, US-4';
    const out = JSON.parse(listsAsWritten(record({
      entities: [{ ...live.entities[0], responsibilities: text }, live.entities[1]],
      operations: [{ ...live.operations[0], inputs: text, errors: text }],
      decisions: [{ ...live.decisions[0], consequences: text }],
    }))) as Design;
    expect([out.entities[0].responsibilities, out.operations[0].inputs, out.operations[0].errors, out.decisions[0].consequences]).toEqual([[text], [text], [text], [text]]);
  });
  it('a generated proposal whose satisfies names two story ids in one text proposes both ids, and Apply\'s re-check reads it unchanged', () => {
    const asText = { [R]: serialiseDesign({ ...live, notes: 'n', decisions: [{ ...live.decisions[0], satisfies: 'US-3, US-4' as unknown as string[] }] }) };
    const generated = normaliseDesignProposal(asText, phase, liveFiles, { dropUnchanged: true });
    expect(JSON.parse(generated[R]).decisions[0].satisfies).toEqual(['US-3', 'US-4']);
    expect(() => validateDesignProposal(generated, phase, liveFiles)).not.toThrow();
  });
  it('reads a blank text as the empty list, and leaves a list, a number, an object and a missing field as written', () => {
    const out = JSON.parse(listsAsWritten(record({ decisions: [{ ...live.decisions[0], satisfies: '  ', consequences: 3, context: 'c' }], operations: [{ ...live.operations[0], inputs: ['a', 'b'], errors: { e: 1 } }] })));
    expect(out.decisions[0]).toMatchObject({ satisfies: [], consequences: 3, context: 'c' });
    expect(out.operations[0]).toMatchObject({ inputs: ['a', 'b'], errors: { e: 1 } });
    expect(out.decisions[0]).not.toHaveProperty('decidedAt');
  });
  it('returns the text itself when nothing is read differently, when it is not JSON, and when it is not an object', () => {
    const same = serialiseDesign(live);
    expect(listsAsWritten(same)).toBe(same);
    expect(listsAsWritten('not a design')).toBe('not a design');
    expect(listsAsWritten('[1]')).toBe('[1]');
    expect(listsAsWritten('{"entities":"x","decisions":[1,"two"]}')).toBe('{"entities":"x","decisions":[1,"two"]}');
  });
  it('a generated proposal with a decision\'s satisfies written as a text proposes the one-item list; a learner\'s edit of it is refused as written', () => {
    const asText = { [R]: serialiseDesign({ ...live, notes: 'n', decisions: [{ ...live.decisions[0], satisfies: 'US-4' as unknown as string[] }] }) };
    const generated = normaliseDesignProposal(asText, phase, liveFiles, { dropUnchanged: true });
    expect(JSON.parse(generated[R]).decisions[0].satisfies).toEqual(['US-4']);
    expect(JSON.parse(generated[R]).notes).toBe('n');
    // the stored proposal is the validator's own output, so Apply's re-check reads it unchanged
    expect(() => validateDesignProposal(generated, phase, liveFiles)).not.toThrow();
    expect(refusalOf(() => normaliseDesignProposal(asText, phase, liveFiles, { refuseCarried: true }))).toMatchObject({ clause: 'invalid_document', detail: 'The design record is not valid: decision D1 satisfies is not a list.' });
    expect(refusalOf(() => normaliseDesignProposal(asText, phase, liveFiles))).toMatchObject({ clause: 'invalid_document' });
  });
});

describe('statusesAsCarried: a generated record\'s decision status that is not one of the three', () => {
  const record = (patch: Record<string, unknown>) => JSON.stringify({ ...live, ...patch });
  const withStatus = (status: string) => ({ decisions: [{ ...live.decisions[0], status }] });
  it.each([['decided'], ['approved'], ['final'], ['open'], [''], [undefined]])('reads the status %p as proposed, the one a proposal never decides', (status) => {
    const out = JSON.parse(statusesAsCarried(record(withStatus(status as string)))) as Design;
    expect(out.decisions[0].status).toBe('proposed');
  });
  it('leaves a record whose statuses are the schema\'s own as written, byte for byte', () => {
    for (const status of ['proposed', 'accepted', 'superseded']) {
      const text = record(withStatus(status));
      expect(statusesAsCarried(text)).toBe(text);
    }
  });
  it('leaves a text that is not a record, or has no decisions list, as written', () => {
    expect(statusesAsCarried('not a design')).toBe('not a design');
    expect(statusesAsCarried('{"entities":[]}')).toBe('{"entities":[]}');
  });
  it('lets a generated proposal through with the saved status carried: proposed for a new decision, the saved one for a kept decision', () => {
    const grown = { ...live, entities: [{ ...live.entities[0], responsibilities: ['holds the due date'] }, live.entities[1]] };
    const files = { [R]: serialiseDesign({ ...grown, decisions: [{ ...live.decisions[0], status: 'decided' as unknown as 'proposed' }] }) };
    const out = normaliseDesignProposal(files, phase, liveFiles, { dropUnchanged: true });
    expect(JSON.parse(out[R]).decisions[0].status).toBe('proposed');
    const accepted = { ...live, decisions: [{ ...live.decisions[0], status: 'accepted' as const, decidedAt: '2026-10-14T00:00:00Z' }] };
    const acceptedFiles = { [R]: serialiseDesign(accepted), [A]: liveFiles[A] };
    const kept = normaliseDesignProposal({ [R]: serialiseDesign({ ...grown, decisions: [{ ...live.decisions[0], status: 'final' as unknown as 'proposed' }] }) }, phase, acceptedFiles, { dropUnchanged: true });
    expect(JSON.parse(kept[R]).decisions[0]).toMatchObject({ status: 'accepted', decidedAt: '2026-10-14T00:00:00Z' });
  });
  it('counts the statuses it reads as proposed for the caller\'s one log line, and counts nothing it leaves as written', () => {
    const counts: number[] = [];
    const two = record({ decisions: [{ ...live.decisions[0], status: 'decided' }, { ...live.decisions[0], id: 'D2', status: 'proposed' }, { ...live.decisions[0], id: 'D3' , status: 'final' }] });
    statusesAsCarried(two, (count) => counts.push(count));
    expect(counts).toEqual([2]);
    for (const text of [record(withStatus('accepted')), 'not a design', '{"entities":[]}']) statusesAsCarried(text, (count) => counts.push(count));
    expect(counts).toEqual([2]);
  });
  it('tells a generated proposal\'s caller how many statuses were read as proposed, and never a learner\'s edit or Apply\'s re-check', () => {
    const grown = { ...live, entities: [{ ...live.entities[0], responsibilities: ['holds the due date'] }, live.entities[1]] };
    const files = { [R]: serialiseDesign({ ...grown, decisions: [{ ...live.decisions[0], status: 'decided' as unknown as 'proposed' }] }) };
    const counts: number[] = [];
    normaliseDesignProposal(files, phase, liveFiles, { dropUnchanged: true, onStatusRead: (count) => counts.push(count) });
    expect(counts).toEqual([1]);
    const known = { [R]: serialiseDesign({ ...grown }) };
    normaliseDesignProposal(known, phase, liveFiles, { dropUnchanged: true, onStatusRead: (count) => counts.push(count) });
    expect(counts).toEqual([1]);
    expect(() => normaliseDesignProposal(files, phase, liveFiles, { refuseCarried: true, onStatusRead: (count) => counts.push(count) })).toThrow();
    expect(counts).toEqual([1]);
  });
  it('still refuses a learner\'s own edit that writes an unknown status, with the validator\'s reason', () => {
    const edit = { [R]: serialiseDesign({ ...live, decisions: [{ ...live.decisions[0], status: 'decided' as unknown as 'proposed' }] }) };
    expect(refusalOf(() => normaliseDesignProposal(edit, phase, liveFiles, { refuseCarried: true }))).toMatchObject({ clause: 'invalid_document', detail: 'The design record is not valid: decision D1 has an unknown status.' });
  });
});

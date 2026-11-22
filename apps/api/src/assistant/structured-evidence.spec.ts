import { DEFAULT_DESIGN_FLOOR, DEFAULT_STORY_FLOOR, EMPTY_DESIGN, EMPTY_STORY, STORY_JSON, serialiseDesign, serialiseStory, type Design } from '@learnsdlc/shared';
import { STRUCTURED_EVIDENCE_NO_FILES, STRUCTURED_EVIDENCE_RECORD_HALF, STRUCTURED_EVIDENCE_RULE, STRUCTURED_MIXED_EVIDENCE_RULE } from './explanation-assessment';
import { explanationReference, structuredReference } from './structured-evidence';

describe('structuredReference', () => {
  it('is the field change set for a story proposal', () => {
    const phase = { key: 'requirements', checks: { kind: 'story', record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: DEFAULT_STORY_FLOOR } } as never;
    const before = { [STORY_JSON]: serialiseStory({ ...EMPTY_STORY, title: 'a' }) };
    const out = structuredReference(phase, before, { [STORY_JSON]: serialiseStory({ ...EMPTY_STORY, title: 'b' }) })!;
    expect(out.changes).toEqual([{ path: 'story/title', before: 'a', after: 'b' }]);
    expect(out.carried).toEqual(['id']);
  });
  it('is the field change set for a design proposal', () => {
    const phase = { key: 'design', checks: { kind: 'design', record: 'design/design.json', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR } } as never;
    const out = structuredReference(phase, { 'design/design.json': serialiseDesign(EMPTY_DESIGN) }, { 'design/design.json': serialiseDesign({ ...EMPTY_DESIGN, notes: 'n' }) })!;
    expect(out.changes).toEqual([{ path: 'design/notes', after: 'n' }]);
  });
  it('numbers a design change by the saved ids: a removed O1 and an added O4 are operation-1 removed and operation-4 added', () => {
    const phase = { key: 'design', checks: { kind: 'design', record: 'design/design.json', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR } } as never;
    const op = (id: string) => ({ id, name: `op${id}`, inputs: ['x'], returns: 'y', errors: [], satisfies: [] });
    const before: Design = { ...EMPTY_DESIGN, operations: [op('O1'), op('O2'), op('O3')] };
    const after: Design = { ...EMPTY_DESIGN, operations: [op('O2'), op('O3'), op('O4')] };
    const out = structuredReference(phase, { 'design/design.json': serialiseDesign(before) }, { 'design/design.json': serialiseDesign(after) })!;
    expect(out.changes).toContainEqual({ path: 'design/operation-1/name', before: 'O1: opO1' });
    expect(out.changes).toContainEqual({ path: 'design/operation-4/name', after: 'O4: opO4' });
    expect(out.changes.some((c) => c.path.startsWith('design/operation-2') || c.path.startsWith('design/operation-3'))).toBe(false);
    // carried names only what the proposal keeps: the removed O1 is a removal, never kept, and the new O4 is new
    expect(out.carried).toEqual(['operation O2', 'operation O3']);
  });
  it('never names a removed item as carried: an entity and an accepted decision removed are removals, not kept', () => {
    const phase = { key: 'design', checks: { kind: 'design', record: 'design/design.json', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR } } as never;
    const entity = (id: string) => ({ id, name: `n${id}`, kind: 'class' as const, attributes: [], responsibilities: [], satisfies: [] });
    const decision = { id: 'D1', title: 't', choice: 'c', alternative: 'a', rationale: 'r', tradeOff: 'o', status: 'accepted' as const, satisfies: [] };
    const op = { id: 'O1', name: 'opO1', inputs: ['x'], returns: 'y', errors: [], satisfies: [] };
    const before: Design = { ...EMPTY_DESIGN, entities: [entity('E1'), entity('E2')], operations: [op], decisions: [decision] };
    const after: Design = { ...EMPTY_DESIGN, entities: [entity('E2')], operations: [op] };
    const out = structuredReference(phase, { 'design/design.json': serialiseDesign(before) }, { 'design/design.json': serialiseDesign(after) })!;
    expect(out.changes).toContainEqual({ path: 'design/entity-1/name', before: 'nE1 (E1)' });
    expect(out.changes).toContainEqual({ path: 'design/decision-1/status', before: 'accepted' });
    expect(out.carried).toEqual(['entity E2', 'operation O1']);
  });
  it('is null for a design proposal with no files, as an inadequate request leaves it', () => {
    const phase = { key: 'design', checks: { kind: 'design', record: 'design/design.json', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR } } as never;
    expect(structuredReference(phase, { 'design/design.json': serialiseDesign(EMPTY_DESIGN) }, {})).toBeNull();
  });
  it('is null for any other phase, so its explanation call is unchanged', () => {
    expect(structuredReference({ key: 'implementation', checks: { kind: 'code' } } as never, {}, { 'a.py': 'x' })).toBeNull();
  });
  it('says what the change set stands for', () => {
    expect(STRUCTURED_EVIDENCE_RULE).toContain('reference.changes');
    // carried vouches for an item's id and status, never its other fields: the judge reads changes for those
    expect(STRUCTURED_EVIDENCE_RULE).toContain("it vouches for an item's id and status only, never for the item's other fields");
    expect(STRUCTURED_EVIDENCE_RULE).not.toContain('exactly as saved');
  });
  it('tells the judge there are no before or proposed files, and what a claim about the later edit is compared with', () => {
    expect(STRUCTURED_EVIDENCE_RULE).toContain('There is no reference.before and no proposedFiles here');
    expect(STRUCTURED_EVIDENCE_RULE).toContain('compare the previous proposal files in reference.latestEdit with the proposed change as reference.changes and reference.carried describe it');
  });
});

describe('explanationReference', () => {
  const design = { key: 'design', checks: { kind: 'design', record: 'design/design.json', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR } } as never;
  const story = { key: 'requirements', checks: { kind: 'story', record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: DEFAULT_STORY_FLOOR } } as never;
  const head = { originalRequest: 'r', proposalHash: 'h', latestEdit: null };
  it('is the change set for a design proposal, with the change-set keys and no files', () => {
    const out = explanationReference(design, { 'design/design.json': serialiseDesign(EMPTY_DESIGN) }, { 'design/design.json': serialiseDesign({ ...EMPTY_DESIGN, notes: 'n' }) }, head);
    expect(out.reference.changes).toEqual([{ path: 'design/notes', after: 'n' }]);
    expect(Object.keys(out.reference)).toEqual(['originalRequest', 'changes', 'carried', 'proposalHash', 'latestEdit']);
    expect(out).toMatchObject({ structured: true, mixed: false });
  });
  it('is the change set for a story proposal too: the story, design, runbook and change request read it', () => {
    const before = { [STORY_JSON]: serialiseStory(EMPTY_STORY) };
    const after = { [STORY_JSON]: serialiseStory({ ...EMPTY_STORY, title: 'b' }) };
    const out = explanationReference(story, before, after, head);
    expect({ changes: out.reference.changes, carried: out.reference.carried }).toEqual(structuredReference(story, before, after));
    expect(Object.keys(out.reference)).toEqual(['originalRequest', 'changes', 'carried', 'proposalHash', 'latestEdit']);
    expect(out).toMatchObject({ structured: true, mixed: false });
  });
});

describe('STRUCTURED_MIXED_EVIDENCE_RULE', () => {
  const recordHalf = STRUCTURED_EVIDENCE_RULE.slice(0, STRUCTURED_EVIDENCE_RULE.indexOf(' There is no reference.before'));
  it('keeps the structured rule\'s record half verbatim and says the files beside the record are in before and proposedFiles', () => {
    expect(STRUCTURED_MIXED_EVIDENCE_RULE.startsWith(recordHalf)).toBe(true);
    expect(STRUCTURED_MIXED_EVIDENCE_RULE).not.toContain('There is no reference.before');
    expect(STRUCTURED_MIXED_EVIDENCE_RULE).toContain('reference.before and reference.proposedFiles hold only those other files');
  });
  it('composes both rules from one record half, the base rule byte for byte as it was, so no Requirements or Design request moves', () => {
    expect(STRUCTURED_EVIDENCE_RULE).toBe('For a structured record, reference.changes lists every field the proposal changes, each with its value before and after (a side is absent when that field was empty or not there), and reference.carried names what the proposal keeps from the saved record by its id: it vouches for an item\'s id and status only, never for the item\'s other fields, so read reference.changes for those; an item the proposal removes appears in reference.changes as a removal and is never carried. There is no reference.before and no proposedFiles here: reference.changes and reference.carried stand in for both, so compare the learner\'s claims about the full proposed change with them, and for a claim about the later edit, compare the previous proposal files in reference.latestEdit with the proposed change as reference.changes and reference.carried describe it.');
    expect(STRUCTURED_EVIDENCE_RULE).toBe(`${STRUCTURED_EVIDENCE_RECORD_HALF} ${STRUCTURED_EVIDENCE_NO_FILES}`);
    expect(STRUCTURED_MIXED_EVIDENCE_RULE.startsWith(`${STRUCTURED_EVIDENCE_RECORD_HALF} `)).toBe(true);
    expect(STRUCTURED_EVIDENCE_NO_FILES.startsWith('There is no reference.before')).toBe(true);
  });
});

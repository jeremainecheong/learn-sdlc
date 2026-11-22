// apps/api/src/assistant/story-proposal.spec.ts
import { STORY_PROPOSAL_REFUSED, normaliseStoryProposal, storyCarried, storyChangeSet, storyPartValue, validateStoryProposal } from './story-proposal';
import { RefusedProposalException } from './proposal-refusal';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, evaluateStoryFloor, serialiseStory, storyRecordCheck, validateStoryRecord } from '@learnsdlc/shared';
const phase = { key: 'requirements', checks: { kind: 'story', record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: DEFAULT_STORY_FLOOR } } as never;
const before = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', benefit: 'see what slipped', scopeExclusions: [] });
describe('validateStoryProposal', () => {
  it('accepts a valid record', () => { expect(() => validateStoryProposal({ [STORY_JSON]: before }, phase)).not.toThrow(); });
  it('refuses an invalid record with the fixed sentence, the validator\'s reason after it', () => {
    let thrown: unknown;
    try { validateStoryProposal({ [STORY_JSON]: '{"id":"US-4"' }, phase); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(RefusedProposalException);
    const refusal = thrown as RefusedProposalException;
    expect([refusal.code, refusal.clause, refusal.detail]).toEqual(['story_proposal_refused', 'invalid_record', 'The story record is not valid: The story record is not valid JSON.']);
    expect(refusal.message).toBe(`${STORY_PROPOSAL_REFUSED} The story record is not valid: The story record is not valid JSON.`);
  });
  it('refuses a changed story id', () => {
    expect(() => validateStoryProposal({ [STORY_JSON]: before.replace('"US-4"', '"US-9"') }, phase)).toThrow(STORY_PROPOSAL_REFUSED);
  });
});
describe('validateStoryProposal: the carried fields (id, epics, parent epic)', () => {
  const epics = [{ id: 'EP-1', title: 'Overdue work', outcome: 'Leads see slipped work' }];
  const saved = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', epics, parentEpicId: 'EP-1' });
  const picks = { key: 'requirements', checks: { kind: 'story', record: STORY_JSON, providedStories: [], learnerStory: { id: 'learner-picks', hints: {} }, floor: DEFAULT_STORY_FLOOR } } as never;
  it('accepts a proposal that keeps them and changes a field', () => {
    const next = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue tasks', epics, parentEpicId: 'EP-1' });
    expect(() => validateStoryProposal({ [STORY_JSON]: next }, phase, saved)).not.toThrow();
  });
  it('refuses a proposal that drops the epics', () => {
    const next = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue tasks', parentEpicId: 'EP-1' });
    expect(() => validateStoryProposal({ [STORY_JSON]: next }, phase, saved)).toThrow(`${STORY_PROPOSAL_REFUSED} The proposal changes the story id, its epics or its parent epic, which a proposal keeps as saved.`);
  });
  it('refuses a proposal that edits an epic or changes or drops the parent epic', () => {
    const edited = serialiseStory({ ...EMPTY_STORY, id: 'US-4', epics: [{ ...epics[0], title: 'Renamed' }], parentEpicId: 'EP-1' });
    const moved = serialiseStory({ ...EMPTY_STORY, id: 'US-4', epics, parentEpicId: 'EP-2' });
    const dropped = serialiseStory({ ...EMPTY_STORY, id: 'US-4', epics });
    for (const next of [edited, moved, dropped]) expect(() => validateStoryProposal({ [STORY_JSON]: next }, phase, saved)).toThrow(STORY_PROPOSAL_REFUSED);
  });
  it('refuses a proposal that adds epics or a parent epic the saved record does not have', () => {
    const plain = serialiseStory({ ...EMPTY_STORY, id: 'US-4' });
    expect(() => validateStoryProposal({ [STORY_JSON]: saved }, phase, plain)).toThrow(STORY_PROPOSAL_REFUSED);
    expect(() => validateStoryProposal({ [STORY_JSON]: saved }, phase, undefined)).toThrow(STORY_PROPOSAL_REFUSED);
  });
  it('under learner-picks, refuses a proposal that changes the id the learner picked', () => {
    const mine = serialiseStory({ ...EMPTY_STORY, id: 'SHELF-7', title: 'Loans' });
    expect(() => validateStoryProposal({ [STORY_JSON]: serialiseStory({ ...EMPTY_STORY, id: 'SHELF-7', title: 'Loans due' }) }, picks, mine)).not.toThrow();
    expect(() => validateStoryProposal({ [STORY_JSON]: serialiseStory({ ...EMPTY_STORY, id: 'SHELF-8', title: 'Loans due' }) }, picks, mine)).toThrow(STORY_PROPOSAL_REFUSED);
  });
  it('names the carried fields the saved record holds', () => {
    expect(storyCarried(saved)).toEqual(['id', 'epics', 'parentEpicId']);
    expect(storyCarried(serialiseStory({ ...EMPTY_STORY, id: 'US-4' }))).toEqual(['id']);
    expect(storyCarried(undefined)).toEqual([]);
  });
});
describe('storyChangeSet', () => {
  it('lists a changed field, an added criterion and a removed exclusion', () => {
    const after = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Overdue', benefit: 'chase it first',
      criteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'boundary' }], scopeExclusions: [] });
    const changes = storyChangeSet(before.replace('"scopeExclusions": []', '"scopeExclusions": ["reminders"]'), after);
    // the whole list, in the projection's order, so an extra or an empty entry fails
    expect(changes.filter((change) => change.path === 'story/so-that' || change.path.startsWith('story/ac-1/') || change.path.startsWith('story/scope/'))).toEqual([
      { path: 'story/so-that', before: 'see what slipped', after: 'chase it first' },
      // the saved version's paths first, then the paths only the proposal has
      { path: 'story/scope/1', before: 'reminders' },
      { path: 'story/ac-1/given', after: 'g' },
      { path: 'story/ac-1/when', after: 'w' },
      { path: 'story/ac-1/then', after: 't' },
      { path: 'story/ac-1/tag', after: 'boundary' },
    ]);
    expect(changes.every((change) => (change.before ?? '') !== (change.after ?? ''))).toBe(true);
  });
  it('never reports the id, the epics or the parent epic as a change', () => {
    const a = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'Same', epics: [{ id: 'EP-1', title: 't', outcome: 'o' }], parentEpicId: 'EP-1' });
    const b = serialiseStory({ ...EMPTY_STORY, id: 'US-9', title: 'Same' });
    expect(storyChangeSet(a, b)).toEqual([]);
  });
});

describe('storyPartValue: the sentence parts without the sentence\'s own words', () => {
  it('cleans the exact values a model wrote into the parts', () => {
    expect(storyPartValue('persona', 'a team member')).toBe('a team member');
    expect(storyPartValue('capability', 'I want tasks due before today to show an overdue badge')).toBe('tasks due before today to show an overdue badge');
    expect(storyPartValue('benefit', 'so that I can quickly identify overdue tasks')).toBe('I can quickly identify overdue tasks');
  });
  it('takes only a leading "As", in any case, with or without a comma, and keeps the article the model wrote', () => {
    for (const typed of ['As a team member', 'as a team member', 'As, a team member', 'As a team member,', '  a team member.  ']) expect(storyPartValue('persona', typed)).toBe('a team member');
    expect(storyPartValue('persona', 'As an MBA student')).toBe('an MBA student');
    expect(storyPartValue('persona', 'an MBA student')).toBe('an MBA student');
    expect(storyPartValue('persona', 'As a user')).toBe('a user');
    expect(storyPartValue('persona', 'As As a user')).toBe('a user');
  });
  it('leaves a persona without "As", and words that only start like it, as written', () => {
    for (const clean of ['team member', 'a team member', 'A team member', 'user', 'administrator', 'Ashley, the team lead', 'Anna, the team lead', 'A/B tester', 'person who runs TaskTrackr every morning', 'the team lead']) expect(storyPartValue('persona', clean)).toBe(clean);
  });
  it('takes only "I want" and "so that": "to …" and "so I can …" stay', () => {
    expect(storyPartValue('capability', 'I want to filter tasks')).toBe('to filter tasks');
    expect(storyPartValue('capability', 'I wanted reports')).toBe('I wanted reports');
    expect(storyPartValue('benefit', 'So that, I spot late work.')).toBe('I spot late work');
    expect(storyPartValue('benefit', 'so I can spot late work')).toBe('so I can spot late work');
  });
  it('is idempotent, and keeps a part the lead words are all of', () => {
    for (const [part, text] of [['persona', 'As As a team member'], ['capability', 'I want I want x'], ['benefit', 'so that so that y']] as const) {
      expect(storyPartValue(part, storyPartValue(part, text))).toBe(storyPartValue(part, text));
    }
    expect(storyPartValue('capability', 'I want')).toBe('I want');
    expect(storyPartValue('benefit', '  ')).toBe('');
  });
});

describe('normaliseStoryProposal', () => {
  const writtenRecord = { ...EMPTY_STORY, id: 'US-1', title: 'Overdue task badge', persona: 'a team member', capability: 'I want tasks due before today to show an overdue badge',
    benefit: 'so that I can quickly identify overdue tasks',
    criteria: [{ id: 'AC-1', given: 'a task is due yesterday', when: 'the task is displayed', then: 'the task shows the overdue badge', tag: 'happy' as const },
      { id: 'AC-2', given: 'a task is due today', when: 'the task is displayed', then: 'the task does not show the overdue badge', tag: 'boundary' as const }],
    scopeExclusions: ['Reminders and notifications are out of scope.'] };
  const pack = { key: 'requirements', checks: { kind: 'story', record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-1', hints: {} }, floor: DEFAULT_STORY_FLOOR } } as never;
  const scaffold = serialiseStory({ ...EMPTY_STORY, id: 'US-1' });
  it('cleans the three parts of a generated record and nothing else, so the Compare reads "a team member"', () => {
    const out = normaliseStoryProposal({ [STORY_JSON]: serialiseStory(writtenRecord) }, pack, scaffold);
    expect(out[STORY_JSON]).toBe(serialiseStory({ ...writtenRecord, persona: 'a team member', capability: 'tasks due before today to show an overdue badge', benefit: 'I can quickly identify overdue tasks' }));
    expect(storyChangeSet(scaffold, out[STORY_JSON]).filter((change) => ['story/as-a', 'story/i-want', 'story/so-that'].includes(change.path))).toEqual([
      { path: 'story/as-a', after: 'a team member' },
      { path: 'story/i-want', after: 'tasks due before today to show an overdue badge' },
      { path: 'story/so-that', after: 'I can quickly identify overdue tasks' },
    ]);
    expect(normaliseStoryProposal(out, pack, scaffold)).toBe(out);
  });
  it('returns the same files, text untouched, when nothing needs cleaning', () => {
    const files = { [STORY_JSON]: JSON.stringify({ ...writtenRecord, persona: 'team member', capability: 'x', benefit: 'y' }) };
    expect(normaliseStoryProposal(files, pack, scaffold)).toBe(files);
  });
  it('keeps the saved wording of a part that reads the same once cleaned, so it is never shown as a change', () => {
    const saved = serialiseStory({ ...writtenRecord, persona: 'a team lead', capability: 'see overdue tasks', benefit: 'see what slipped' });
    const echoed = serialiseStory({ ...writtenRecord, persona: 'a team lead', capability: 'I want to see overdue tasks', benefit: 'chase it first' });
    const out = validateStoryRecord(normaliseStoryProposal({ [STORY_JSON]: echoed }, pack, saved)[STORY_JSON]).story!;
    expect([out.persona, out.capability, out.benefit]).toEqual(['a team lead', 'to see overdue tasks', 'chase it first']);
    const same = serialiseStory({ ...writtenRecord, persona: 'As a team lead', capability: 'see overdue tasks', benefit: 'so that see what slipped' });
    expect(storyChangeSet(saved, normaliseStoryProposal({ [STORY_JSON]: same }, pack, saved)[STORY_JSON]).map((change) => change.path)).not.toEqual(expect.arrayContaining(['story/as-a']));
  });
  it('keeps unknown keys and their order, and passes another phase, another file and an unreadable record through', () => {
    const files = { [STORY_JSON]: JSON.stringify({ id: 'US-1', extra: 1, persona: 'As a team member' }), 'notes.md': 'As a a' };
    expect(JSON.parse(normaliseStoryProposal(files, pack)[STORY_JSON])).toEqual({ id: 'US-1', extra: 1, persona: 'a team member' });
    expect(Object.keys(JSON.parse(normaliseStoryProposal(files, pack)[STORY_JSON]))).toEqual(['id', 'extra', 'persona']);
    expect(normaliseStoryProposal(files, pack)['notes.md']).toBe('As a a');
    const design = { key: 'design', checks: { kind: 'design' } } as never;
    expect(normaliseStoryProposal(files, design)).toBe(files);
    const broken = { [STORY_JSON]: '{"persona":' };
    expect(normaliseStoryProposal(broken, pack)).toBe(broken);
  });
  it('the story checks still pass, five of five, on the uncleaned record and on a clean draft once cleaned', () => {
    // The Deadline badge pack's reference-work story, copied as the model drafted it.
    const cleanDraft = { id: 'US-1', title: 'Overdue badge', persona: 'team member', capability: 'a badge on a task that is past its due date',
      benefit: 'I spot late work before the weekly meeting',
      criteria: [{ id: 'AC-1', given: 'a task due yesterday', when: 'I open the task list', then: 'the task shows the overdue badge', tag: 'happy' },
        { id: 'AC-2', given: 'a task due today', when: 'I open the task list', then: 'the task has no overdue badge', tag: 'boundary' }],
      scopeExclusions: ['Reminders and notifications'], notes: '' };
    for (const record of [serialiseStory(writtenRecord), `${JSON.stringify(cleanDraft, null, 2)}\n`]) {
      const text = normaliseStoryProposal({ [STORY_JSON]: record }, pack, scaffold)[STORY_JSON];
      expect(() => validateStoryProposal({ [STORY_JSON]: text }, pack, scaffold)).not.toThrow();
      const story = validateStoryRecord(text, 'US-1').story!;
      const checks = [storyRecordCheck(text, 'US-1'), ...evaluateStoryFloor(story, DEFAULT_STORY_FLOOR)];
      expect(checks.map((check) => [check.id, check.passed])).toEqual([
        ['story.record', true], ['story.sentence', true], ['story.criteria.min', true], ['story.criteria.tags', true], ['story.scope.min', true],
      ]);
    }
    // the clean draft is already clean: the same text comes back
    const clean = `${JSON.stringify(cleanDraft, null, 2)}\n`;
    expect(normaliseStoryProposal({ [STORY_JSON]: clean }, pack, scaffold)[STORY_JSON]).toBe(clean);
  });
});

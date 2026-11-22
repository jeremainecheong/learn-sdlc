import {
  DEFAULT_STORY_FLOOR, EMPTY_STORY, LEARNER_PICKS, andList, evaluateStoryFloor, floorSentence, serialiseStory,
  storyFloorShown, storyRecordCheck, storyReviewProjection, validateStoryRecord, type Story,
} from './requirements-story';

const full: Story = {
  ...EMPTY_STORY, id: 'US-4', title: 'Overdue report', persona: 'team lead', capability: 'a report', benefit: 'I chase it first',
  criteria: [
    { id: 'AC-1', given: 'a task due yesterday', when: 'I open the report', then: 'it is listed', tag: 'happy' },
    { id: 'AC-2', given: 'a task due today', when: 'I open the report', then: 'it is not listed', tag: 'boundary' },
  ],
  scopeExclusions: ['reminders'], notes: 'none',
};

describe('evaluateStoryFloor', () => {
  it('passes a story that meets the default floor', () => {
    const r = evaluateStoryFloor(full, DEFAULT_STORY_FLOOR);
    expect(r.map(x => x.id)).toEqual(['story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
    expect(r.every(x => x.passed)).toBe(true);
  });
  it.each([
    ['sentence', { ...full, benefit: ' ' }, 'story.sentence', 'As a / I want / So that are not all filled'],
    ['count', { ...full, criteria: full.criteria.slice(0, 1) }, 'story.criteria.min', 'Story has fewer than 2 acceptance criteria'],
    ['tag', { ...full, criteria: full.criteria.map(c => ({ ...c, tag: 'happy' as const })) }, 'story.criteria.tags', 'No boundary case among the criteria'],
    ['scope', { ...full, scopeExclusions: [] }, 'story.scope.min', 'Fewer than 1 out-of-scope lines'],
  ])('fails on %s', (_n, story, id, detail) => {
    const hit = evaluateStoryFloor(story, DEFAULT_STORY_FLOOR).find(x => x.id === id)!;
    expect(hit.passed).toBe(false);
    expect(hit.detail).toBe(detail);
  });
  it('labels the criteria row in the singular for one and the plural for more', () => {
    const one = evaluateStoryFloor(full, { ...DEFAULT_STORY_FLOOR, minCriteria: 1 });
    expect(one.find(x => x.id === 'story.criteria.min')!.label).toBe('At least 1 acceptance criterion');
    const many = evaluateStoryFloor(full, { ...DEFAULT_STORY_FLOOR, minCriteria: 2 });
    expect(many.find(x => x.id === 'story.criteria.min')!.label).toBe('At least 2 acceptance criteria');
    // The scope row keeps "lines": TaskTrackr's floor of 1 reaches its review request, whose golden stays as recorded.
    expect(one.find(x => x.id === 'story.scope.min')!.label).toBe('At least 1 out-of-scope lines');
  });
  // Where the review shows the scope row, a count of one reads in the singular.
  it('shows the scope row in the singular for one, and leaves every other count and sentence as it was', () => {
    expect(storyFloorShown('At least 1 out-of-scope lines')).toBe('At least 1 out-of-scope line');
    expect(storyFloorShown('Fewer than 1 out-of-scope lines')).toBe('Fewer than 1 out-of-scope line');
    expect(storyFloorShown('✓ 1 out-of-scope lines')).toBe('✓ 1 out-of-scope line');
    for (const kept of ['At least 0 out-of-scope lines', 'At least 2 out-of-scope lines', '11 out-of-scope lines', '21 out-of-scope lines', 'At least 1 acceptance criterion', 'A full story sentence']) {
      expect(storyFloorShown(kept)).toBe(kept);
    }
  });
  it('ignores a criterion with a blank Given or Then when counting', () => {
    const story = { ...full, criteria: [...full.criteria, { id: 'AC-3', given: '', when: 'x', then: 'y', tag: 'error' as const }] };
    const r = evaluateStoryFloor(story, { ...DEFAULT_STORY_FLOOR, requiredTags: ['error'] });
    expect(r.find(x => x.id === 'story.criteria.tags')!.passed).toBe(false);
  });
  it('demands one criterion per required tag even when minCriteria is lower', () => {
    const r = evaluateStoryFloor(full, { ...DEFAULT_STORY_FLOOR, minCriteria: 1, requiredTags: ['happy', 'boundary', 'error'] });
    expect(r.find(x => x.id === 'story.criteria.tags')!.detail).toBe('No error case among the criteria');
  });
});

describe('validateStoryRecord', () => {
  it('accepts a serialised story and drops unknown keys', () => {
    const out = validateStoryRecord(serialiseStory({ ...full, renderHash: 'x' } as Story));
    expect(out.error).toBeNull();
    expect(out.story).not.toHaveProperty('renderHash');
  });
  it.each([
    ['not json', '{', 'not valid JSON'],
    ['not an object', '[]', 'not an object'],
    ['bad tag', JSON.stringify({ ...full, criteria: [{ ...full.criteria[0], tag: 'odd' }] }), 'AC-1 has an unknown tag'],
    ['non-sequential ids', JSON.stringify({ ...full, criteria: [{ ...full.criteria[0], id: 'AC-7' }] }), 'criteria are not numbered AC-1, AC-2, …'],
    ['too many criteria', JSON.stringify({ ...full, criteria: Array.from({ length: 21 }, (_, i) => ({ ...full.criteria[0], id: `AC-${i + 1}` })) }), 'more than 20 criteria'],
    ['field too long', JSON.stringify({ ...full, title: 'x'.repeat(4001) }), 'title is longer than 4000 characters'],
    ['wrong id', JSON.stringify({ ...full, id: 'US-9' }), 'the story id must be US-4'],
  ])('refuses %s', (_n, text, message) => {
    const out = validateStoryRecord(text, 'US-4');
    expect(out.story).toBeNull();
    expect(out.error).toContain(message);
  });
  it('keeps epics and parentEpicId unchanged', () => {
    const epics = [{ id: 'EP-1', title: 'Reporting', outcome: 'leads see overdue work' }, { id: 'EP-2', title: 'Alerts', outcome: 'nobody misses a date' }];
    const out = validateStoryRecord(JSON.stringify({ ...full, epics, parentEpicId: 'EP-2' }), 'US-4');
    expect(out.error).toBeNull();
    expect(out.story!.epics).toEqual(epics);
    expect(out.story!.parentEpicId).toBe('EP-2');
  });
  const epic = { id: 'EP-1', title: 'Reporting', outcome: 'leads see overdue work' };
  it.each([
    ['too many epics', JSON.stringify({ ...full, epics: Array.from({ length: 21 }, (_, i) => ({ ...epic, id: `EP-${i + 1}` })) }), 'more than 20 epics'],
    ['an epic title too long', JSON.stringify({ ...full, epics: [{ ...epic, title: 'x'.repeat(4001) }] }), 'epic 1 title is longer than 4000 characters'],
    ['an epic with a numeric id', JSON.stringify({ ...full, epics: [{ ...epic, id: 7 }] }), 'epic 1 id is not text'],
    ['a parentEpicId too long', JSON.stringify({ ...full, parentEpicId: 'x'.repeat(4001) }), 'parentEpicId is longer than 4000 characters'],
  ])('refuses %s', (_n, text, message) => {
    const out = validateStoryRecord(text, 'US-4');
    expect(out.story).toBeNull();
    expect(out.error).toBe(message);
  });
  it('accepts any id when expectedId is learner-picks', () => {
    expect(validateStoryRecord(JSON.stringify({ ...full, id: 'SH-9' }), 'learner-picks').error).toBeNull();
  });
});

describe('storyRecordCheck and projection', () => {
  it('turns an invalid record into a failed story.record result', () => {
    const r = storyRecordCheck('{', 'US-4');
    expect(r).toMatchObject({ id: 'story.record', passed: false });
  });
  it('projects every field to one citable path', () => {
    const p = storyReviewProjection(full);
    expect(Object.keys(p)).toEqual(['story/title', 'story/as-a', 'story/i-want', 'story/so-that',
      'story/ac-1/given', 'story/ac-1/when', 'story/ac-1/then', 'story/ac-1/tag',
      'story/ac-2/given', 'story/ac-2/when', 'story/ac-2/then', 'story/ac-2/tag', 'story/scope/1', 'story/notes']);
    expect(p['story/ac-2/then']).toBe('it is not listed');
  });
  it('writes the floor as one sentence', () => {
    expect(floorSentence(DEFAULT_STORY_FLOOR)).toBe('a full story sentence, at least 2 criteria including a happy path and a boundary case, and at least 1 out-of-scope line');
  });
  it('says criterion for one and criteria for more', () => {
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 1, requiredTags: ['happy'] })).toContain('at least 1 criterion including a happy path,');
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 1, requiredTags: [] })).toBe(
      'a full story sentence, at least 1 criterion, and at least 1 out-of-scope line',
    );
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 3 })).toContain('at least 3 criteria including');
  });
  it('says the tag count when the minimum is below the number of required cases', () => {
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 1, requiredTags: ['happy', 'boundary', 'error'] })).toBe(
      'a full story sentence, at least 3 criteria including a happy path, a boundary case and an error case, and at least 1 out-of-scope line',
    );
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 1 })).toContain('at least 2 criteria including a happy path and a boundary case');
    // at or above the tag count, the minimum itself is said
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 2 })).toContain('at least 2 criteria including');
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, minCriteria: 4 })).toContain('at least 4 criteria including');
  });
  it('gives the error case its article', () => {
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, requiredTags: ['happy', 'boundary', 'error'] })).toContain(
      'including a happy path, a boundary case and an error case,',
    );
    expect(floorSentence({ ...DEFAULT_STORY_FLOOR, requiredTags: ['error'] })).toContain('including an error case,');
  });
});

describe('validateStoryRecord under learner-picks', () => {
  it('refuses an empty id with the desk\'s sentence and caps the id at 40', () => {
    expect(validateStoryRecord(serialiseStory({ ...EMPTY_STORY, id: '' }), LEARNER_PICKS).error).toBe('Give your story an id.');
    expect(validateStoryRecord(serialiseStory({ ...EMPTY_STORY, id: 'x'.repeat(41) }), LEARNER_PICKS).error).toBe('the story id is longer than 40 characters');
    expect(validateStoryRecord(serialiseStory({ ...EMPTY_STORY, id: 'SHELF-7' }), LEARNER_PICKS).error).toBeNull();
    // a fixed id is checked as before; no picked id applies
    expect(validateStoryRecord(serialiseStory({ ...EMPTY_STORY, id: '' })).error).toBeNull();
  });
});

describe('andList', () => {
  it('joins items as a sentence says them', () => {
    expect([andList([]), andList(['a']), andList(['a', 'b']), andList(['a', 'b', 'c'])]).toEqual(['', 'a', 'a and b', 'a, b and c']);
  });
});

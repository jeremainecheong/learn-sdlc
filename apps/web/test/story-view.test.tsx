import { describe, expect, test } from 'vitest';
import { readStoryRecord, storyView } from '@/components/workspace/panels/requirements/useStory';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, LEARNER_PICKS, serialiseStory } from '@learnsdlc/shared';

const spec = { id: 'US-4', hints: { persona: 'team lead' }, floor: DEFAULT_STORY_FLOOR, providedStories: [] };

test('an empty record is not started and fails the floor', () => {
  const v = storyView('', spec);
  expect(v.started).toBe(false);
  expect(v.story.id).toBe('US-4');
  expect(v.results.filter(r => r.passed)).toHaveLength(0);
});

test('a saved record is parsed and the floor is evaluated with the phase floor', () => {
  const v = storyView(serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'x', persona: 'p', capability: 'c', benefit: 'b' }), spec);
  expect(v.started).toBe(true);
  expect(v.results.find(r => r.id === 'story.sentence')!.passed).toBe(true);
});

describe('storyView beyond the brief', () => {
  test('the rows are the grader’s: the record check first, then the floor, under the floor ids', () => {
    const v = storyView(serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 'x' }), spec);
    expect(v.results.map(r => r.id)).toEqual(['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
    expect(v.results[0].passed).toBe(true);
    expect(v.canRecord).toBe(true);
  });

  test('a fixed id is the phase’s, whatever the record says, so a save is never refused for it', () => {
    const v = storyView(serialiseStory({ ...EMPTY_STORY, id: 'US-9', title: 'x' }), { ...spec, id: 'SH-5' });
    expect(v.story.id).toBe('SH-5');
    expect(storyView('{broken', { ...spec, id: 'SH-5' }).story.id).toBe('SH-5');
  });

  test('a broken record fails the record row and grades the floor on nothing', () => {
    const v = storyView('{broken', spec);
    expect(v.results[0]).toMatchObject({ id: 'story.record', passed: false });
    expect(v.results.filter(r => r.passed)).toHaveLength(0);
  });

  test('when the learner picks the id, an empty id stays empty and a typed one is kept', () => {
    const picks = { ...spec, id: LEARNER_PICKS };
    expect(storyView('', picks).story.id).toBe('');
    expect(storyView(serialiseStory({ ...EMPTY_STORY, id: '', title: 'x' }), picks).story.id).toBe('');
    expect(storyView(serialiseStory({ ...EMPTY_STORY, id: 'BK-2', title: 'x' }), picks).story.id).toBe('BK-2');
  });

  test('a phase with no story spec cannot record and draws no checks', () => {
    const v = storyView('', undefined);
    expect(v.canRecord).toBe(false);
    expect(v.results).toEqual([]);
  });

  test('a record read with no spec keeps the id it wrote, never a default', () => {
    expect(readStoryRecord(serialiseStory({ ...EMPTY_STORY, id: '', title: 'x' })).id).toBe('');
    expect(readStoryRecord(JSON.stringify({ title: 'broken: no other fields' })).id).toBe('');
    expect(readStoryRecord(JSON.stringify({ id: 'SH-5', title: 'x' })).title).toBe('x');
    expect(readStoryRecord(serialiseStory({ ...EMPTY_STORY, id: 'US-9' }), 'SH-5').id).toBe('SH-5');
  });
});


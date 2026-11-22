// apps/api/src/feedback/story-report.spec.ts
import { buildStoryPartial, storyWorkspaceForReview } from './story-report';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
const checks = { kind: 'story' as const, record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: DEFAULT_STORY_FLOOR };
const rubric = { passThreshold: 70, criteria: [{ key: 'a', title: 'A', weight: 0.5, description: 'x' }, { key: 'b', title: 'B', weight: 0.5, description: 'y' }] };
const good = serialiseStory({ ...EMPTY_STORY, id: 'US-4', title: 't', persona: 'p', capability: 'c', benefit: 'b',
  criteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy' }, { id: 'AC-2', given: 'g', when: 'w', then: 't', tag: 'boundary' }], scopeExclusions: ['x'], notes: '' });

describe('buildStoryPartial', () => {
  it('scores 100 on every criterion when the record and the floor pass', () => {
    const p = buildStoryPartial(rubric, checks, good);
    expect(p.checks.map(c => c.id)).toEqual(['story.record', 'story.sentence', 'story.criteria.min', 'story.criteria.tags', 'story.scope.min']);
    expect(p.checks.every(c => c.status === 'passed')).toBe(true);
    expect(p.criteria.map(c => c.score)).toEqual([100, 100]);
    expect(p.overall).toBe(100);
  });
  it('fails the record check and scores the floor as failed when the record is missing', () => {
    const p = buildStoryPartial(rubric, checks, undefined);
    expect(p.checks[0]).toMatchObject({ id: 'story.record', status: 'failed' });
    expect(p.checks.slice(1).every(c => c.status === 'failed')).toBe(true);
    expect(p.overall).toBe(0);
  });
  it('gives a partial score when one floor check fails', () => {
    const p = buildStoryPartial(rubric, checks, serialiseStory({ ...JSON.parse(good), scopeExclusions: [] }));
    expect(p.checks.find(c => c.id === 'story.scope.min')!.status).toBe('failed');
    expect(p.overall).toBe(80);
  });
  // The review's evidence lines read a count of one in the singular; the check the reviewer model is
  // sent keeps its label and detail byte for byte, and no score or status moves.
  it('shows "1 out-of-scope line" in the evidence lines and keeps the check\'s own words', () => {
    const met = buildStoryPartial(rubric, checks, good);
    expect(met.criteria[0].evidence).toContain('✓ At least 1 out-of-scope line');
    expect(met.checks.find(c => c.id === 'story.scope.min')).toMatchObject({ label: 'At least 1 out-of-scope lines', detail: '1 out-of-scope lines', status: 'passed' });
    const unmet = buildStoryPartial(rubric, checks, serialiseStory({ ...JSON.parse(good), scopeExclusions: [] }));
    expect(unmet.criteria[0].evidence).toContain('✗ At least 1 out-of-scope line: Fewer than 1 out-of-scope line');
    expect(unmet.checks.find(c => c.id === 'story.scope.min')).toMatchObject({ label: 'At least 1 out-of-scope lines', detail: 'Fewer than 1 out-of-scope lines', status: 'failed' });
    expect([met.overall, unmet.overall]).toEqual([100, 80]);
  });
});
describe('storyWorkspaceForReview', () => {
  it('projects a valid record and is empty for an invalid one', () => {
    expect(Object.keys(storyWorkspaceForReview(good))).toContain('story/ac-2/then');
    expect(storyWorkspaceForReview('{')).toEqual({});
  });
});

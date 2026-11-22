// apps/api/src/workflow/phase-detail-story.spec.ts
import { phaseDetailStory } from './phase-detail-story';
describe('phaseDetailStory', () => {
  it('is undefined for a markdown phase', () => {
    expect(phaseDetailStory({ kind: 'markdown', targets: ['x'], rules: [] } as never)).toBeUndefined();
  });
  it('copies id, hints, floor and provided stories for a story phase', () => {
    const out = phaseDetailStory({ kind: 'story', record: 'requirements/story.json', providedStories: [{ id: 'US-1', title: 't', persona: 'p', capability: 'c', benefit: 'b' }],
      learnerStory: { id: 'US-4', hints: { persona: 'lead' } }, floor: { minCriteria: 2, requiredTags: ['happy'], minExclusions: 1, requireSentence: true } });
    expect(out).toEqual({ id: 'US-4', hints: { persona: 'lead' }, floor: { minCriteria: 2, requiredTags: ['happy'], minExclusions: 1, requireSentence: true },
      providedStories: [{ id: 'US-1', title: 't', persona: 'p', capability: 'c', benefit: 'b' }] });
  });
  it('copies the criteria of each provided story rather than sharing them with the pack', () => {
    const criterion = { id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy' as const };
    const checks = { kind: 'story' as const, record: 'requirements/story.json', providedStories: [{ id: 'US-1', title: 't', persona: 'p', capability: 'c', benefit: 'b', criteria: [criterion] }],
      learnerStory: { id: 'US-4', hints: {} }, floor: { minCriteria: 2, requiredTags: ['happy' as const], minExclusions: 1, requireSentence: true } };
    const out = phaseDetailStory(checks)!;
    expect(out.providedStories).toEqual(checks.providedStories);
    expect(out.providedStories[0].criteria).not.toBe(checks.providedStories[0].criteria);
    expect(out.providedStories[0].criteria![0]).not.toBe(criterion);
  });
});

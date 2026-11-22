import { BadRequestException } from '@nestjs/common';
import { refuseInvalidStoryRecord } from './story-record-guard';
import { LEARNER_PICKS, STORY_CAPS } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
const checks = { kind: 'story' as const, record: STORY_JSON, providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: DEFAULT_STORY_FLOOR };
describe('refuseInvalidStoryRecord', () => {
  it('lets a valid record through', () => {
    expect(() => refuseInvalidStoryRecord(STORY_JSON, serialiseStory({ ...EMPTY_STORY, id: 'US-4' }), checks)).not.toThrow();
  });
  it('refuses a malformed record with the fixed sentence', () => {
    expect(() => refuseInvalidStoryRecord(STORY_JSON, '{', checks)).toThrow(new BadRequestException('The story record is not valid: The story record is not valid JSON.'));
  });
  it('refuses 500 criteria', () => {
    const big = JSON.stringify({ ...EMPTY_STORY, id: 'US-4', criteria: Array.from({ length: 500 }, (_, i) => ({ id: `AC-${i + 1}`, given: 'g', when: 'w', then: 't', tag: 'happy' })) });
    expect(() => refuseInvalidStoryRecord(STORY_JSON, big, checks)).toThrow(/more than 20 criteria/);
  });
  it('returns the record as validated, so an unknown key is never stored, even one of 150,000 characters', () => {
    const story = { ...EMPTY_STORY, id: 'US-4', title: 'Overdue' };
    const sent = JSON.stringify({ ...story, padding: 'x'.repeat(150_000), criteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy', extra: 'y' }] });
    const stored = refuseInvalidStoryRecord(STORY_JSON, sent, checks);
    expect(stored).toBe(serialiseStory({ ...story, criteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't', tag: 'happy' }] }));
    expect(stored).not.toContain('padding');
    expect(stored).not.toContain('extra');
  });
  it('under learner-picks, refuses an empty id with the desk\'s sentence, and an id longer than the desk\'s 40', () => {
    const picks = { ...checks, learnerStory: { id: LEARNER_PICKS, hints: {} } };
    expect(() => refuseInvalidStoryRecord(STORY_JSON, serialiseStory({ ...EMPTY_STORY, id: '  ' }), picks)).toThrow(new BadRequestException('Give your story an id.'));
    expect(() => refuseInvalidStoryRecord(STORY_JSON, serialiseStory({ ...EMPTY_STORY, id: 'x'.repeat(STORY_CAPS.learnerPickedId + 1) }), picks)).toThrow(/longer than 40 characters/);
    expect(refuseInvalidStoryRecord(STORY_JSON, serialiseStory({ ...EMPTY_STORY, id: 'x'.repeat(STORY_CAPS.learnerPickedId) }), picks)).toContain('"id"');
  });
  it('ignores other paths and other kinds', () => {
    expect(refuseInvalidStoryRecord('design/x.json', '{', checks)).toBe('{');
    expect(refuseInvalidStoryRecord(STORY_JSON, '{', { kind: 'markdown', targets: [], rules: [] } as never)).toBe('{');
  });
});

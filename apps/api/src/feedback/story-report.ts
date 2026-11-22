import { evaluateStoryFloor, storyRecordCheck, storyReviewProjection, validateStoryRecord, type PhaseRubric } from '@learnsdlc/shared';
import type { StoryChecks } from '../content/content.types';
import { floorPartial, type FloorPartial } from './floor-partial';

export type StoryPartial = FloorPartial;

export function buildStoryPartial(rubric: PhaseRubric, checks: StoryChecks, recordText: string | undefined): StoryPartial {
  const record = storyRecordCheck(recordText ?? '', checks.learnerStory.id);
  const parsed = recordText ? validateStoryRecord(recordText, checks.learnerStory.id).story : null;
  const floor = parsed
    ? evaluateStoryFloor(parsed, checks.floor)
    : evaluateStoryFloor({ id: '', title: '', persona: '', capability: '', benefit: '', criteria: [], scopeExclusions: [], notes: '' }, checks.floor);
  return floorPartial(rubric, [record, ...floor]);
}

export function storyWorkspaceForReview(recordText: string | undefined): Record<string, string> {
  const out = recordText ? validateStoryRecord(recordText) : { story: null };
  return out.story ? storyReviewProjection(out.story) : {};
}

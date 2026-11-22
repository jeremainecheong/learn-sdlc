import { BadRequestException } from '@nestjs/common';
import { STORY_ID_NEEDED, serialiseStory, validateStoryRecord } from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/**
 * A save to the story record: refused with a fixed sentence when the record is
 * not valid, and otherwise answered with the bytes to store, the record as
 * validated (`serialiseStory`), so a key the record does not have is never
 * stored. Any other path, or a phase of another kind, is stored as sent.
 */
export function refuseInvalidStoryRecord(path: string, content: string, checks: PhaseChecks): string {
  if (checks.kind !== 'story' || path !== checks.record) return content;
  const out = validateStoryRecord(content, checks.learnerStory.id);
  if (out.error === STORY_ID_NEEDED) throw new BadRequestException(STORY_ID_NEEDED);
  if (out.story === null) throw new BadRequestException(`The story record is not valid: ${out.error}.`);
  return serialiseStory(out.story);
}

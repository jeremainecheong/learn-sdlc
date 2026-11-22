/** The story record's shared contract, as the Requirements panels import it. */
export { CRITERION_TAGS, STORY_JSON, EMPTY_STORY, renumber, newCriterion, parseStoryJson, serialiseStory } from '@learnsdlc/shared';
export type { CriterionTag, AcceptanceCriterion, Story } from '@learnsdlc/shared';
import { EMPTY_STORY, parseStoryJson, validateStoryRecord, type Story } from '@learnsdlc/shared';

/**
 * The story id a desk shows. `EMPTY_STORY.id` is the
 * reference story's default ('US-4'), which a record with no id of its own
 * reads as: so off the reference room (`useReferenceScaffolding`) the desk
 * shows the learner's own id only where it differs from that default, and no
 * id otherwise. A reference room always shows the id.
 */
export function shownStoryId(id: string, reference: boolean): string {
  return reference || id !== EMPTY_STORY.id ? id : '';
}

const BLANK: Story = { ...EMPTY_STORY, id: '' };

/** The id a record holds as written: '' where it has none, never a default. */
function writtenId(json: string): string {
  try {
    const raw: unknown = JSON.parse(json);
    const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/**
 * The story a record's text holds. A record the validator accepts is read
 * exactly; one it refuses is read as far as it goes, under the id it wrote.
 * `fixedId`, where the phase fixes one, is the id whatever the record says.
 * `validated` is the validator's answer for this text when the caller has it.
 * No React here, so pure code such as the design board's contradiction check
 * can read a record too.
 */
export function readStoryRecord(json: string, fixedId?: string, validated?: { story: Story | null }): Story {
  if (!json.trim()) return { ...BLANK, id: fixedId ?? '' };
  const story = (validated ?? validateStoryRecord(json)).story ?? { ...parseStoryJson(json), id: writtenId(json) };
  return fixedId === undefined ? story : { ...story, id: fixedId };
}

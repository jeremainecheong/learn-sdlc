// apps/api/src/assistant/story-proposal.ts
import { LEARNER_PICKS, projectionChangeSet, storyReviewProjection, validateStoryRecord, type FieldChange, type Story } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { RefusedProposalException, STORY_PROPOSAL_REFUSED } from './proposal-refusal';
export { STORY_PROPOSAL_REFUSED };

/**
 * The record's fields a proposal never changes: the story id, its epics and
 * its parent epic. They are carried from the saved record, so a proposal that
 * holds anything else for them is refused, and Apply, which re-checks against
 * the live record, writes them exactly as they are saved.
 */
export type StoryCarriedField = 'id' | 'epics' | 'parentEpicId';
const epicsOf = (story: Story) => JSON.stringify((story.epics ?? []).map(e => [e.id, e.title, e.outcome]));
const parentOf = (story: Story) => story.parentEpicId ?? '';

/**
 * Refuses a story proposal that is not a valid record, or that changes a
 * carried field against `saved`, the record the proposal is read against (the
 * saved one, or the pack's scaffold when nothing is saved). With no readable
 * saved record, the proposal may hold no epics and no parent epic. The refusal
 * carries the validator's reason, or names the carried fields.
 */
export function validateStoryProposal(files: Record<string, string>, phase: PhaseContent, saved?: string): void {
  if (phase.checks?.kind !== 'story') return;
  const text = files[phase.checks.record];
  if (text === undefined) return;
  const read = validateStoryRecord(text, phase.checks.learnerStory.id);
  const proposed = read.story;
  if (!proposed) throw new RefusedProposalException('story_proposal_refused', 'invalid_record', `The story record is not valid: ${read.error}.`);
  const base = saved === undefined ? null : validateStoryRecord(saved).story;
  const differs = base
    ? epicsOf(proposed) !== epicsOf(base) || parentOf(proposed) !== parentOf(base) || (phase.checks.learnerStory.id === LEARNER_PICKS && proposed.id !== base.id)
    : (proposed.epics?.length ?? 0) > 0 || parentOf(proposed) !== '';
  if (differs) throw new RefusedProposalException('story_proposal_refused', 'carried_changed', 'The proposal changes the story id, its epics or its parent epic, which a proposal keeps as saved.');
}

/** The three parts of the story sentence, as the record names them. */
export type StoryPart = 'persona' | 'capability' | 'benefit';
const STORY_PARTS: StoryPart[] = ['persona', 'capability', 'benefit'];
/**
 * The sentence's own words at the start of a part: "As" before the persona
 * (the persona keeps its article: "a team member", "an MBA student", so the
 * model's article is never thrown away and the renderer adds one only where
 * there is none); "I want" before the capability; "so that" before the
 * benefit. The renderer writes them, so a part that holds them would read
 * "As as a team member, I want I want …".
 */
const LEAD: Record<StoryPart, RegExp> = {
  persona: /^as\b[\s,]+/i,
  capability: /^i\s+want\b[\s,]*/i,
  benefit: /^so\s+that\b[\s,]*/i,
};

/**
 * A sentence part without the sentence's own words: the lead above, the
 * surrounding whitespace and a trailing comma or full stop. A part those words
 * are all of is kept as written, so a filled part never becomes an empty one.
 * Idempotent: a clean part comes back unchanged.
 */
export function storyPartValue(part: StoryPart, text: string): string {
  const written = text.trim();
  let out = written;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(LEAD[part], '').replace(/[\s,.]+$/, '').trim();
  }
  return out || written;
}

/**
 * A generated story proposal with its three sentence parts as the record holds
 * them: the model may write "As a team member", "I want …" and "so that …"
 * into the fields, and the Compare, the explanation gate's change set and Apply
 * all read the proposal, so it is cleaned once, here, before any of them sees
 * it. A part that reads the same as the saved one once both are cleaned keeps
 * the saved wording, so a proposal never shows the learner's own words as a
 * change. Only the three parts change; everything else in the record, its keys
 * and their order stay as written, and a record with nothing to clean is
 * returned as the same text. Run after `validateStoryProposal`.
 */
export function normaliseStoryProposal(files: Record<string, string>, phase: PhaseContent, saved?: string): Record<string, string> {
  if (phase.checks?.kind !== 'story') return files;
  const path = phase.checks.record;
  const text = files[path];
  if (text === undefined) return files;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text) as Record<string, unknown>; } catch { return files; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return files;
  const base = saved === undefined ? null : validateStoryRecord(saved).story;
  let changed = false;
  for (const part of STORY_PARTS) {
    const value = raw[part];
    if (typeof value !== 'string') continue;
    const clean = storyPartValue(part, value);
    const next = base && storyPartValue(part, base[part]) === clean ? base[part] : clean;
    if (next !== value) { raw[part] = next; changed = true; }
  }
  return changed ? { ...files, [path]: `${JSON.stringify(raw, null, 2)}\n` } : files;
}

/** The carried fields the saved record holds, which the overlay names as kept rather than changed. */
export function storyCarried(saved: string | undefined): StoryCarriedField[] {
  const base = saved === undefined ? null : validateStoryRecord(saved).story;
  if (!base) return [];
  return [...(base.id ? ['id' as const] : []), ...(base.epics?.length ? ['epics' as const] : []), ...(parentOf(base) ? ['parentEpicId' as const] : [])];
}

/** The field-by-field changes, over the review's fields only: a carried field is never a change. */
export function storyChangeSet(before: string | undefined, after: string): FieldChange[] {
  const a = before ? validateStoryRecord(before).story : null;
  const b = validateStoryRecord(after).story;
  const pa = a ? storyReviewProjection(a) : {};
  const pb = b ? storyReviewProjection(b) : {};
  return projectionChangeSet(pa, pb);
}

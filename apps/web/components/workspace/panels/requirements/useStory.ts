'use client';

import { useMemo } from 'react';
import {
  EMPTY_STORY,
  LEARNER_PICKS,
  evaluateStoryFloor,
  recordCheckOf,
  validateStoryRecord,
  type PhaseDetail,
  type Story,
  type StoryFloorResult,
} from '@learnsdlc/shared';
import type { PhasePanelProps } from '../types';
import { STORY_JSON, readStoryRecord } from './story';

// The record reader lives in the React-free module, so pure code (the design
// board's contradiction check) can import it; it is re-exported here for the
// room's callers.
export { readStoryRecord };

/**
 * What a Requirements phase without a story spec says in place of the form.
 * Such a phase still holds its story as markdown, which the room does not
 * read or write; the project's owner re-saves it to move it to the record.
 */
export const OLDER_FORMAT_SENTENCE = "This project's Requirements task is in an older format; its owner needs to re-save it.";

export interface StoryView {
  /** The record as the form shows it, with the phase's fixed story id. */
  story: Story;
  /**
   * The checks the review grades the record with, in the review's order: the
   * record itself, then the phase's floor. None on a phase with no story spec.
   */
  results: StoryFloorResult[];
  /** The record holds something the learner wrote. */
  started: boolean;
  /** The phase has a story spec, so the form can keep a record. */
  canRecord: boolean;
}

const BLANK: Story = { ...EMPTY_STORY, id: '' };

/** Whether a story has been written at all: any field, not only the title. */
export function storyStarted(story: Story): boolean {
  return Boolean(
    story.title.trim() ||
      story.persona.trim() ||
      story.capability.trim() ||
      story.benefit.trim() ||
      story.criteria.length ||
      story.scopeExclusions.some((line) => line.trim()) ||
      story.notes.trim(),
  );
}

/**
 * Everything the room draws, derived from the record's text and the phase's
 * story spec. The record is not held in React state: `story.json` is the
 * single copy, so the backlog, the editor and the rail can never drift apart.
 *
 * The checks are the grader's own (`buildStoryPartial` in the API): the
 * record check against the phase's id, then the floor over the record as the
 * validator reads it, or over a blank story when it cannot. A list that
 * disagreed with the grader would be worse than none. The text is validated
 * once, against the phase's id, as the grader validates it.
 */
export function storyView(json: string, spec: PhaseDetail['story']): StoryView {
  const fixedId = spec && spec.id !== LEARNER_PICKS ? spec.id : undefined;
  const validated = validateStoryRecord(json, spec?.id);
  const story = readStoryRecord(json, fixedId, validated);
  const started = Boolean(json.trim()) && storyStarted(story);
  const results = spec ? [recordCheckOf(validated), ...evaluateStoryFloor(validated.story ?? BLANK, spec.floor)] : [];
  return { story, results, started, canRecord: Boolean(spec) };
}

/** The same view, memoised for a component that holds the record's text. */
export function useStoryFrom(json: string, spec: PhaseDetail['story']): StoryView {
  return useMemo(() => storyView(json, spec), [json, spec]);
}

/** The view for a panel drawn in the IDE, which reads the record through its helpers. */
export function useStoryView({ detail, helpers }: PhasePanelProps): StoryView {
  return useStoryFrom(helpers.fileText(STORY_JSON), detail.story);
}

/**
 * Whether a criterion's outcome could become a test. A blank clause is
 * unfinished; a hedged outcome ("handled sensibly") is a decision the learner
 * has not made yet, which is exactly what the product owner asks about.
 */
const HEDGED =
  /\b(sensibl[ey]|appropriate(ly)?|properly|correctly|reasonabl[ey]|gracefully|as expected|somehow|makes? sense|handled well)\b/i;
const VAGUE = /\b(user-friendly|user friendly|fast|quick|nice|etc\.?|and so on|as needed|intuitive)\b/i;

export type CriterionState = 'blank' | 'weak' | 'runnable';

export function criterionState(c: { given: string; when: string; then: string }): CriterionState {
  if (!c.given.trim() || !c.when.trim() || !c.then.trim()) return 'blank';
  const outcome = c.then;
  if (HEDGED.test(outcome) || VAGUE.test(outcome)) return 'weak';
  return 'runnable';
}

export const CRITERION_WORD: Record<CriterionState, string> = {
  blank: 'Unfinished',
  weak: 'Not testable yet',
  runnable: 'Runnable',
};

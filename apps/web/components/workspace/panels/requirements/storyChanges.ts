/**
 * What a story proposal's `changes` say, read without React: which fields
 * really change, how many things that is, and which sections of the story they
 * fall in.
 *
 * The field paths are the review projection's (`storyReviewProjection` in the
 * shared package), which is how the API names a story proposal's `changes`:
 * `story/title`, `story/as-a`, `story/i-want`, `story/so-that`,
 * `story/ac-N/given|when|then|tag`, `story/scope/N` and `story/notes`, with
 * criteria and out-of-scope lines numbered from 1 by position.
 */

export type SectionKey = 'title' | 'as-a' | 'i-want' | 'so-that' | 'criteria' | 'scope' | 'notes';

export const SECTION_ORDER: SectionKey[] = ['title', 'as-a', 'i-want', 'so-that', 'criteria', 'scope', 'notes'];

export const SECTION_LABEL: Record<SectionKey, string> = {
  title: 'Title',
  'as-a': 'As a',
  'i-want': 'I want',
  'so-that': 'So that',
  criteria: 'Acceptance criteria',
  scope: 'Out of scope',
  notes: 'Open questions',
};

export interface StoryChange { path: string; before?: string; after?: string }

/** The section a change path belongs to, or null for a path this view does not know. */
export function sectionOf(path: string): SectionKey | null {
  if (/^story\/ac-\d+\//.test(path)) return 'criteria';
  if (/^story\/scope\/\d+$/.test(path)) return 'scope';
  const key = path.replace(/^story\//, '');
  return key === 'title' || key === 'as-a' || key === 'i-want' || key === 'so-that' || key === 'notes' ? key : null;
}

/**
 * The paths whose two sides really differ. A side the API leaves out and a side
 * it sends as '' mean the same thing, an empty field, so an entry whose sides
 * are equal once both are read that way changes nothing and is dropped.
 */
export function changedPaths(changes: readonly StoryChange[]): Set<string> {
  return new Set(changes.filter(change => (change.before ?? '') !== (change.after ?? '')).map(change => change.path));
}

/**
 * How many things a proposal changes, as a learner would count them: each
 * story field, each criterion (however many of its clauses moved) and each
 * out-of-scope line is one.
 */
export function changeCount(changed: ReadonlySet<string>): number {
  return new Set([...changed].map(path => path.match(/^story\/ac-\d+/)?.[0] ?? path)).size;
}

/** The sections at least one changed path falls in, in the form's order. */
export function touchedSections(changed: ReadonlySet<string>): SectionKey[] {
  const touched = new Set([...changed].map(sectionOf));
  return SECTION_ORDER.filter(key => touched.has(key));
}

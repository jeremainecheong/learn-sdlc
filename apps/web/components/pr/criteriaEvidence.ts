/**
 * One list for the checks every criterion shares.
 *
 * A floor-graded phase (the story, the design, a record) scores every rubric
 * criterion by the same floor rules and gives each the same evidence lines
 * (the API's `floorPartial`), so a review listed the same five checks under
 * every criterion. When every criterion's list is the same, the review shows
 * the list once, under the criteria; otherwise each criterion keeps its own.
 */
export function sharedEvidence(lists: readonly (readonly string[])[]): string[] | null {
  if (lists.length < 2) return null;
  const [first] = lists;
  if (first.length === 0) return null;
  const same = lists.every((list) => list.length === first.length && list.every((line, i) => line === first[i]));
  return same ? [...first] : null;
}

/** The line over the shared list. */
export const SHARED_EVIDENCE_LEAD = 'Every criterion above rests on the same checks:';

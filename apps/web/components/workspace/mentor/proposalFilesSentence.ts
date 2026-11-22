/**
 * The file sentence the API stores as, or after, a proposal's summary when the
 * model's words name a file the proposal does not hold or leave a held file
 * out: "Files in this proposal: a, b.", the held paths in the proposal's own
 * order (`PROPOSAL_FILES_LEAD` and `proposalFilesSentence` in
 * apps/api/src/assistant/proposal-edits.ts, kept to the byte here; the test
 * summary-files-once.test.tsx reads the API's source to hold the two
 * together).
 *
 * The card and the Compare window leave such a summary out where the inventory
 * right below it, headed "Files in this proposal", lists the same files.
 */
export const PROPOSAL_FILES_LEAD = 'Files in this proposal: ';

/**
 * Whether `summary` is exactly the API's file sentence over `held` (the
 * proposal's paths in its own order): the whole summary, not a sentence a model
 * could also have written before other words, and not the paths in another
 * order. Never true for a proposal holding no file, for which the API writes none.
 */
export function isProposalFilesSentence(summary: string | null | undefined, held: readonly string[]): boolean {
  return held.length > 0 && summary === `${PROPOSAL_FILES_LEAD}${held.join(', ')}.`;
}

/**
 * What of `summary` to draw above a list that already names every one of `held`
 * under "Files in this proposal": the summary without the API's file
 * sentence at its head, so the heading is said once. The API stores that
 * sentence alone, or followed by its own sentence about a file the answer named
 * and the proposal does not change ("Files in this proposal: a, b. The mentor's
 * answer also named c; ..."); the second is kept. '' when the summary is only
 * the sentence; any other summary is returned whole.
 */
export function summaryBesideList(summary: string | null | undefined, held: readonly string[]): string {
  if (!summary) return '';
  if (isProposalFilesSentence(summary, held)) return '';
  const lead = `${PROPOSAL_FILES_LEAD}${held.join(', ')}. `;
  return held.length > 0 && summary.startsWith(lead) ? summary.slice(lead.length).trim() : summary;
}

import { RefusedProposalException, refusedProposalMessage } from './proposal-refusal';

/** A pack-authored record path is named in the prompt only when it is a plain path token. */
export const PLAIN_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/**
 * The one regeneration. A generated answer the server
 * refuses (an edit list it cannot expand, a file map it cannot take, a record
 * or document its validator refuses) is asked for once more inside the same
 * call, with the refusal's own words at the end of the briefing, and only when
 * the route's one 55 s budget (`AGENTIC_REQUEST_TIMEOUT_MS`, which counts the
 * queue, every model call and the save) leaves room: more than twice what the
 * first generation took plus the reply's 5 s, and never less than 15 s. The
 * second call is the same call, data, schema, label and token cap; it runs
 * under the same deadline, so it can end the turn as the deadline, never past
 * it. A Design-length generation (about 30 s) never leaves that room. The
 * regeneration never changes the budget, the timeout, the gate or the
 * explanation.
 */
export const REGENERATION_REPLY_MS = 5_000;
export const REGENERATION_MIN_LEFT_MS = 15_000;
export const regenerationFits = (leftMs: number, firstMs: number): boolean =>
  leftMs > Math.max(REGENERATION_MIN_LEFT_MS, 2 * firstMs + REGENERATION_REPLY_MS);

/**
 * The completeness re-ask's own two bounds, on top of `regenerationFits` and the cut-off
 * `REGENERATION_REPLY_MS` before the route's deadline, never instead of them. They bound the learner's wait,
 * not the route: the 55 s budget, `OPENAI_TIMEOUT_MS` and `regenerationFits` still apply.
 * Measured on a real model (strict edit list, full payload): on a small project a first answer takes about
 * 5 to 8 s and a re-ask about 6 s, so the re-ask pays for itself there. On TaskTrackr's four-file Maintenance
 * request first answers took about 13 to 15 s, the re-ask fired in 7 of 25 turns and seldom supplied the
 * missing file, and a second answer returned as whole files took up to 31.2 s, making a 48.7 s turn and a
 * median turn 5 to 7 s slower. So the re-ask starts only when the first generation took at most
 * `INCOMPLETE_REASK_FIRST_MAX_MS`, and its call is stopped `INCOMPLETE_REASK_SECOND_MAX_MS` after it starts
 * (or at the earlier cut-off), the first answer standing: a re-ask adds at most about 12 s to a first answer
 * of at most 10 s. The regeneration of a refused answer is not bound by either.
 */
export const INCOMPLETE_REASK_FIRST_MAX_MS = 10_000;
export const INCOMPLETE_REASK_SECOND_MAX_MS = 12_000;

/** What a refusal must be for the answer to be asked for again: a design that came back as saved (`unchanged`) or a learner's carried field is not; an empty answer or one equal to the saved files is. */
export const regenerable = (error: unknown): error is RefusedProposalException =>
  error instanceof RefusedProposalException && error.clause !== 'unchanged' && error.clause !== 'carried_changed';

/**
 * The sentence the regeneration's briefing ends with: the refusal as the
 * learner would have read it (its fixed sentence and the rule's reason, never
 * the model's words), then the ask; under the edit-list contract, the way out
 * of an anchor that is not unique.
 */
export function regenerationSentence(refused: RefusedProposalException, mode: 'files' | 'edits'): string {
  return ` Your previous answer to this request was refused, so nothing was proposed: ${refusedProposalMessage(refused.code, refused.detail)} Answer the same request again under the same contract.${mode === 'edits' ? ' A file whose edits would quote text that is not exactly once in that file is returned whole in files instead.' : ''}`;
}

/**
 * The completeness regeneration: a model may return two of the three documents a first
 * Maintenance proposal asks for while the answer's own summary describes the third. A FIRST answer to a first proposal (not a chat refinement) the route's
 * checks keep, but that left out a file `reaskPaths` finds (one the learner's request writes
 * out and the summary names, or an entry for a code or configuration file that changed
 * nothing), is asked for once more through
 * the regeneration path: the same call, data, schema, label and token cap, under the same deadline
 * and only when `regenerationFits` and the first generation took at most `INCOMPLETE_REASK_FIRST_MAX_MS`,
 * with this clause's reason at the end of the briefing.
 * The second answer is never asked for again and never refused for being incomplete (the stored
 * summary then names the file, `checkSummaryPaths`); it replaces the first only when it holds
 * every file the first held and at least as much of what was named (`secondAnswerKept`); if it is refused for any other reason, its
 * call fails, or it is still running `REGENERATION_REPLY_MS` before the route's deadline or
 * `INCOMPLETE_REASK_SECOND_MAX_MS` after it started, whichever comes first, the first answer stands. A refused first answer keeps its one
 * regeneration and nothing more, and no turn regenerates twice.
 */
export const INCOMPLETE_REGENERATION = { code: 'proposal_incomplete', clause: 'incomplete' } as const;

/**
 * The incomplete clause's sentence at the end of the regeneration's briefing: the files the
 * previous answer named and did not change (each a plain path token, else "a file", or "files"
 * when there are several), then the ask in the contract's own terms. Platform words and editable
 * paths only, never the model's. Under the edit-list contract it asks for whole files only, edits
 * as []: in a 20-turn run, every Maintenance answer made only of whole files held all three
 * documents, while every incomplete one, and every incomplete second answer asked for "files or
 * edits", held one edit and one whole file. The schema and `expandEditList`
 * accept such an answer, and the contract's own words allow it ("Both arrays are required; use []
 * for the one you do not need"); this sentence, the last of the briefing, sets aside its "Prefer
 * edits" for this one answer, and says so with "this time".
 */
export function incompleteRegenerationSentence(paths: readonly string[], mode: 'files' | 'edits'): string {
  const one = paths.length === 1;
  const named = paths.every(path => PLAIN_PATH.test(path)) ? paths.join(', ') : one ? 'a file' : 'files';
  const ask = mode === 'edits'
    ? ', this time with edits as []: give every file the request changes its complete revised contents as its own entry in files'
    : ': give every file the request changes its complete revised contents in files';
  return ` Your previous answer to this request named ${named} and did not change ${one ? 'it' : 'them'}. Answer the same request again under the same contract${ask}, and name in the summary only the files your answer changes.`;
}

/** What a regeneration's briefing ends with: a refused first answer's refusal, or the files an incomplete one left unchanged. */
export type Regeneration = { refused: RefusedProposalException } | { incomplete: readonly string[] };

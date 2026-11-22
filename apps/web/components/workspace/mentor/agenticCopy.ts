/**
 * The Agentic panel's fixed words for a turn: the sentence a wait shows, the
 * step it names beside its clock, and what a failed turn says when the server
 * gives no sentence of its own.
 */
import type { AgentTurn } from '@/lib/api-mentor';

/** `notRetryable`: the API's refusal said `retryable: false` (the read-only refusal), so the same words get no retry button. */
export type DisplayTurn = AgentTurn & { localState?: 'sending' | 'unconfirmed'; localError?: string; deliveryMissing?: boolean; notRetryable?: boolean };

/**
 * The one sentence that is true at every instant of a wait. A chat turn's second
 * server call writes the proposed files, and `stage` is the server saying that
 * call has started; an absent or unrecognised stage means there is nothing to
 * report, so the sentence stays the plain waiting sentence. The pre-stage chat
 * wording keeps the words "is reading": `apps/web/test/agentic-panel.test.tsx`
 * matches them.
 *
 * It changes at most once per turn, because `replaceTurn` keeps a stage the
 * server has already reported. Whether a screen reader speaks that one change is
 * not established: the sentence lives inside the transcript, which carries
 * `aria-busy` for the whole pending window, and assistive technology may hold a
 * change inside a busy region until it settles. That is true of the sentence
 * being replaced as well, so this is a limit inherited rather than added;
 * narrowing the busy window is a deliberate change to `operationBusy`, which
 * also gates the composer, Apply and the editable proposal files.
 */
export const waitLine = (turn: DisplayTurn, mentor: string) => turn.kind === 'explain'
  ? `${mentor} is reviewing your explanation… Apply stays locked while you wait.`
  : turn.stage === 'proposing'
    ? `${mentor} is writing the proposed files… Nothing in your workspace changes yet.`
    : `${mentor} is reading your message… You can keep drafting below.`;

/**
 * What a failed turn says when the server gives no sentence of its own (a
 * refused structured proposal carries its fixed sentence and reason in
 * `errorMessage`). The codes are `failTurn`'s and `settleStaleTurn`'s:
 * `assessment_unavailable` is a model call that failed, came back unreadable
 * or ran out of the route's 55 s budget; `request_expired` a turn a restart
 * found past that budget; `proposal_changed` saved work or a proposal that
 * moved under the request; `provider_busy` a request the AI's queue
 * turned away, or whose budget ran out while it waited there, because the
 * rest of the class was using every slot. Each says what happened and that
 * nothing was changed, in one line; the retry beside it is the same step again
 * (none for an explanation whose proposal moved: it says to explain the current version). The
 * catch-all `request_failed` and a code this client does not know keep the
 * generic sentence.
 */
const FAILED_CHAT: Record<string, string> = {
  assessment_unavailable: 'The mentor did not answer in time, or its answer could not be read. Nothing was proposed and your work is unchanged.',
  request_expired: 'This request ran past its time limit and was stopped. Nothing was proposed and your work is unchanged.',
  provider_busy: 'The mentor is busy with the rest of the class, so nothing was proposed. Your work is unchanged; try again in a minute.',
  proposal_changed: 'Your saved work or the proposal changed while the mentor was working, so nothing was proposed. Send your request again as a new message to use your current work.',
};
const FAILED_EXPLAIN: Record<string, string> = {
  assessment_unavailable: 'The review of your explanation did not come back in time, or could not be read. Your explanation is kept and Apply stays locked.',
  request_expired: 'This explanation ran past its time limit and was stopped. Your explanation is kept and Apply stays locked.',
  provider_busy: 'The mentor is busy with the rest of the class, so your explanation was not reviewed. It is kept and Apply stays locked; try again in a minute.',
  proposal_changed: 'The proposal changed while your explanation was being reviewed. Apply stays locked; explain the current version.',
};
export const failureLine = (turn: DisplayTurn) => turn.localError || turn.errorMessage || (turn.kind === 'explain'
  ? FAILED_EXPLAIN[turn.errorCode ?? ''] ?? 'Your explanation is kept, but its review could not be completed. Apply stays locked. Retry when you are ready.'
  : FAILED_CHAT[turn.errorCode ?? ''] ?? 'The mentor could not complete this reply. Your message is kept. Retry when you are ready.');

/**
 * The step the server has reported, in fixed words, beside the seconds since the
 * turn was recorded. It reads the same `stage` as `waitLine`,
 * so it moves at most once and never backwards; no step is marked done, and no
 * percentage or estimate is drawn. It sits outside the status sentence, so the
 * ticking count is never announced: the sentence above stays the one heard.
 */
export const waitStepName = (turn: DisplayTurn) => turn.kind === 'explain'
  ? 'Checking your explanation'
  : turn.stage === 'proposing' ? 'Writing the proposal' : 'Reading your request';

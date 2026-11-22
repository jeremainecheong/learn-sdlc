/**
 * The prompt assessment re-ask: what the
 * API may tell agentic.classify about its own answer when the propose route
 * could not use it, and nothing more.
 *
 * The propose route reads the classify answer as `{adequate, feedback,
 * questions}` with exactly one question when the request is inadequate and
 * none when it is adequate. A model occasionally answers outside that shape
 * although it answered in seconds; ending the learner's proposal there with a
 * 503 ("The AI returned an incomplete prompt assessment. No proposal was
 * approved.") would waste the call. So the route asks once more inside the
 * same call, and this file writes the one note the second request adds.
 *
 * The rule is the same for both: the second answer is read by exactly the
 * same rule, nothing is proposed from an answer that breaks it, and a second
 * failure fails the proposal as a first one would without the re-ask. The note is neutral: it never says
 * whether the request is adequate.
 *
 * What may reach the note: fixed copy chosen by a fixed token. Never a word of
 * the refused answer (its feedback or its questions) and never a word of the
 * learner's prompt (the first request already carried it unchanged).
 *
 * Like `explanation-reask.ts`, this module imports nothing that could reach a
 * decorator or a database.
 */
import { reaskFits } from './re-ask';

/** Which rule the refused answer broke: not a readable assessment, or the one-question rule. */
export type IntentRefusal = 'assessment' | 'one_question';

/**
 * Reads a refused classify answer for the rule it broke. `one_question` when
 * the answer is a readable verdict with a list of non-empty question texts
 * whose count does not fit that verdict (an inadequate request takes exactly
 * one, an adequate one none); `assessment` for anything else the route
 * refused. Only a token comes back: nothing of the answer is kept.
 */
export function readIntentRefusal(answer: unknown): IntentRefusal {
  const row = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>) : null;
  const questions = row && Array.isArray(row.questions) ? (row.questions as unknown[]) : null;
  const readable = !!row && typeof row.adequate === 'boolean' && typeof row.feedback === 'string' && !!questions &&
    questions.every((question) => typeof question === 'string' && !!question.trim());
  return readable && questions!.length !== (row!.adequate ? 0 : 1) ? 'one_question' : 'assessment';
}

export const CLASSIFY_REASK_OPEN = 'Your previous answer to this prompt assessment was refused because the server could not use it, so nothing was proposed.';
export const CLASSIFY_REASK_CLOSE = 'Assess the same request again from the prompt and the workspace alone; this note does not say whether the request is adequate. Return {"adequate":boolean,"feedback":string,"questions":string[]}: when the request is inadequate, feedback names the one blocking ambiguity and questions holds exactly one question; when it is adequate, questions is empty.';

const SENTENCE: Record<IntentRefusal, string> = {
  assessment: 'It was not one object holding adequate as true or false, feedback as a text and questions as a list of non-empty texts',
  one_question: 'Its questions did not match its verdict: an inadequate request takes exactly one question and an adequate one none',
};

/** The second request's one added note: fixed copy only. */
export function classifyReaskNote(refusal: IntentRefusal): string {
  return `${CLASSIFY_REASK_OPEN}\n${SENTENCE[refusal]}.\n${CLASSIFY_REASK_CLOSE}`;
}

/**
 * The least of the Agentic route's 55 s budget that must be left for the
 * second ask to be sent: ten seconds of margin plus the classify call at its
 * slowest. Measured over 100 calls, `agentic.classify` took 1.8 s at the
 * median, 2.4 s at p95 and 3.9 s at most, so 14 s is 10 s plus the maximum
 * rounded up, the explanation re-ask's floor on the same figures. The ask itself is still
 * cut off by the route's own deadline; the budget is never raised.
 */
export const CLASSIFY_REASK_FLOOR_MS = 14_000;

/** The margin above the first ask's own duration (the floor's own ten seconds). */
export const CLASSIFY_REASK_MARGIN_MS = 10_000;

/**
 * Whether the second ask may be sent: at least the floor, and at least as
 * long as the first ask itself took plus the margin, must be left of the
 * route's budget (the explanation re-ask's rule). A slow first ask says a
 * second may be as slow, and one that cannot finish would only make the
 * learner wait to the deadline for the same refused proposal.
 */
export const classifyReaskFits = (remainingMs: number, firstMs: number): boolean =>
  reaskFits(remainingMs, firstMs, CLASSIFY_REASK_FLOOR_MS, CLASSIFY_REASK_MARGIN_MS);

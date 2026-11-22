/**
 * What a question to the reviewer costs, and what happened to the answer.
 *
 * Two things the mentor column and the learner's report must get right: the
 * count is of the learner's questions, because that is what the score counts,
 * not of the reviewer's turns; and a reply refused for running out of budget
 * stays labelled as refused after a reload, because the outcome is read back
 * off the stored row.
 *
 * This module is the one source for those. Every number in it comes from
 * `@learnsdlc/shared`, which is the same module `scoreProcess` in the API
 * subtracts by, so the sentence on screen and the arithmetic in the grade
 * cannot drift apart. Nothing here fetches: everything it reads is already in
 * the page.
 *
 * It is deliberately pure and deliberately not a component. The reviewer's
 * column is drawn in five rooms and memoised in three places; the arithmetic
 * belongs where a unit test can reach it without a browser.
 */
import { HINT_FREE_ALLOWANCE, hintMarksLost } from '@learnsdlc/shared';
import type { AssistantMessageView, MentorReplyOutcome, PhaseKey } from '@learnsdlc/shared';

/** The rubric criterion hints are charged against, on the phases that carry one. */
export const PROCESS_CRITERION = 'process';

/**
 * Questions asked, on the definition the score uses.
 *
 * `hintsForPhase` in the API is `count({ phaseStateId, role: 'user' })`: every
 * question, including the ones the guardrail refused, redirected or answered
 * out of the cache. Counting assistant turns would agree only by accident (one
 * question writes one reply) and is a different rule. Counting the same rows
 * the grader counts is what makes the number on
 * screen the number that is charged.
 */
export function questionsAsked(thread: AssistantMessageView[]): number {
  let asked = 0;
  for (const m of thread) if (m.role === 'user') asked += 1;
  return asked;
}

/**
 * Which question each message belongs to, keyed by message id.
 *
 * The counter moves on the question, and the reply beneath it inherits the same
 * number: one exchange, one ordinal, whichever half of it you are looking at.
 * A reply with no question above it (impossible through `chat()`, and not
 * impossible in a repaired database) gets no number at all rather than a zero.
 */
export function questionOrdinals(thread: AssistantMessageView[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  let asked = 0;
  for (const m of thread) {
    if (m.role === 'user') ordinals.set(m.id, ++asked);
    else if (asked > 0) ordinals.set(m.id, asked);
  }
  return ordinals;
}

/**
 * What happened to one reply, as one word.
 *
 * The order is a product decision and not an accident of how the flags are
 * declared, so it is written down here: a refusal is what happened to the
 * *question*, and it stays the label even when the answer that came with it was
 * replayed from the cache. Do not reorder these to match the shape of the meta
 * object.
 *
 * `budget` is derived rather than trusted. `meta.budgetExceeded` is set on the
 * reply the request returns and is not a stored column, so it is absent on
 * every row read back from `GET /assistant/history/:id`, which is to say, on
 * every reply a learner sees after a reload. A stored `guardrail` row comes
 * from one of three branches: a daily budget cap, which sets no flag and which
 * `chat()` does not apply today (stored rows still carry it); the off-phase
 * redirect, which sets `scopeRedirected`; and the solution request, which sets
 * `redacted`. So a guardrail row wearing neither flag is the budget one, and
 * its text stays visible as history, not as a current limit.
 */
export function replyOutcome(meta: AssistantMessageView['meta']): MentorReplyOutcome {
  if (!meta) return 'answered';
  if (meta.redacted) return 'withheld';
  if (meta.scopeRedirected) return 'redirected';
  if (meta.budgetExceeded || (meta.provider === 'guardrail' && !meta.redacted && !meta.scopeRedirected)) {
    return 'budget';
  }
  if (meta.cached) return 'cached';
  return 'answered';
}

/**
 * The API stores a provider as its machine id. The column is read by learners,
 * so it carries the name a person would say.
 *
 * `local-mentor` reads "Built-in mentor" and not "Offline mentor": on a laptop
 * with no key it is the normal path and nothing is broken, and "offline" says
 * something is. The fallback tidies an id nobody has named rather than showing
 * a learner a hyphenated slug.
 */
const PROVIDER_LABELS: Record<string, string> = {
  'local-mentor': 'Built-in mentor',
  openai: 'OpenAI',
  guardrail: 'Guardrail',
  'rubric-review': 'Rubric review',
};

export function providerLabel(id: string): string {
  const known = PROVIDER_LABELS[id];
  if (known) return known;
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/** The rule a withheld answer was withheld under, said in the reviewer's voice. */
export const WITHHELD_REASON: Record<PhaseKey, string> = {
  requirements: 'I will not write the criterion for you (rule 3)',
  design: 'I will not make the decision for you (rule 3)',
  implementation: 'I will not write the fix for you (rule 3)',
  testing: 'I will not write the test for you (rule 3)',
  deployment: 'I will not fix the pipeline for you (rule 3)',
  maintenance: 'I will not make the change for you (rule 3)',
};

/**
 * The one explaining line under a reply, or null where none is owed.
 *
 * An ordinary answer gets nothing: the absence of a label is the label, and a
 * sentence saying "this is a normal reply" under every normal reply would train
 * a learner to stop reading the ones that are not.
 *
 * The withheld sentence is `WITHHELD_REASON`'s, word for word: it is the best
 * copy on the page, and the "because" in it is the point. Keep it verbatim.
 */
export function outcomeLine(
  outcome: MentorReplyOutcome,
  phaseKey: PhaseKey,
  phaseTitle: string,
): string | null {
  switch (outcome) {
    case 'withheld':
      return `because ${WITHHELD_REASON[phaseKey]}`;
    case 'redirected':
      return `You asked about another phase. This room is ${phaseTitle}, so the reviewer pointed you back.`;
    case 'cached':
      return 'This exact question has been asked on this phase with your files in this state. The same answer, and no tokens spent.';
    case 'budget':
      return 'This saved reply was withheld under an earlier daily token limit. Daily token limits no longer apply.';
    default:
      return null;
  }
}

/**
 * The line under the reliance figures in the learner's own report, or null on a
 * phase where questions cost nothing.
 *
 * Drawn from the very verdict it explains: the report carries the criteria it
 * was scored on, so the weight is the one that was actually applied and not a
 * second copy of it.
 */
export function relianceCostLine(hints: number, scoresProcess: boolean): string | null {
  if (!scoresProcess) return null;
  const lost = hintMarksLost(hints);
  const asked = hints === 1 ? 'You asked for one Guided hint' : `You asked for ${hints} Guided hints`;
  if (lost === 0) {
    return `${asked} this phase, all within the ${HINT_FREE_ALLOWANCE} that cost nothing.`;
  }
  return `${asked} this phase, and spent ${lost} of the 100 marks for process on them.`;
}

/** The label the provider word carries, or null when the row does not name one. */
export function providerFor(meta: AssistantMessageView['meta']): string | null {
  return meta?.provider ? providerLabel(meta.provider) : null;
}

/**
 * Why this provider answered, for the provider word's own title.
 *
 * It is a title and not a line in the feed on purpose: on a laptop with no
 * model key every reply comes from the built-in mentor, and a sentence under
 * every one of them would be noise that teaches a learner to stop reading the
 * lines that matter. The word itself is the label; this is the footnote.
 */
export function providerNote(provider: string | undefined): string | undefined {
  if (provider === 'local-mentor') {
    return 'This reply came from the mentor that ships with the product, not from a model. It is the same every time you ask the same thing.';
  }
  if (provider === 'guardrail') {
    return 'This reply came from the rule, not from a model. No tokens were spent on it.';
  }
  return provider || undefined;
}

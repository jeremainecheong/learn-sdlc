import { GUIDED_REVIEW_SAFE_EXEMPLARS } from './guided-review';
import { replaceSpanOnce } from './prompt-twin';

/**
 * The Guided draft checks itself the way its reviewer will, before the
 * reviewer sees it.
 *
 * A first draft the reviewer withholds costs the learner two more model calls
 * (a repair draft and a fresh review). The reviewer's checks, its decision
 * procedure and the server's remaining-reasoning rule (`parseGuidedReview`'s
 * `substantive` rule) are therefore stated on the draft's side too, so the
 * draft can aim at them.
 *
 * What it carries, and what it does not:
 * - the three check names and one sentence of what each asks;
 * - the reviewer's procedure (name the one decision left to the learner, cut
 *   any other assigned decision) and the rule that a question already
 *   answered by the reply is not remaining reasoning;
 * - the two SAFE exemplars, verbatim from the reviewer's own prompt.
 *
 * The two UNSAFE exemplars are described in words and never quoted: a
 * complete over-helping answer in the generator's own system message is text
 * it could imitate, or repeat to a learner, and the solution redactor is keyed
 * on this phase's sources, not on a generic eligibility example.
 *
 * It is part of the draft's system message only. The reviewer's prompt,
 * schema, parser, provenance checks and `substantive` rule do not include it,
 * and the reviewer sees only the exact fresh candidate. This text is not part
 * of `GUIDED_REVIEW_VERSION`; it joins `mentorInstructionIdentity` instead, so
 * any later edit to it keys the reply cache apart on its own.
 */
export const GUIDED_DRAFT_SELF_CHECK = `
Before you answer, check your reply the way its independent reviewer will. A reply that fails any check is withheld from the learner:
- limited_step: name to yourself the one decision you are leaving to the learner. If your reply resolves any other decision of the assigned unfinished work, cut it. That includes every condition of a function's return decision listed in prose, a finished method body or artefact text, and a plan that covers several unfinished functions, even when every fact is already in the brief and even after a refusal.
- grounded: every assertion must fit the supplied phase context and recorded evidence. Never claim a run or a pass that is not recorded.
- learner_reasoning: answer the question usefully and leave one concrete question for the learner. A question whose answer is already contained in what you just wrote is not remaining reasoning: a reply that leaves only syntax assembly or a confirmation is withheld, whatever else it does well.
Replies the reviewer accepts look like these:
${GUIDED_REVIEW_SAFE_EXEMPLARS.join('\n')}`;

/**
 * The same self-check for a teacher's phase. It quotes the authored reviewer's
 * SAFE exemplar, which differs from TaskTrackr's in one span, so it rewrites
 * the same span, exactly once, or refuses to load.
 */
export const AUTHORED_GUIDED_DRAFT_SELF_CHECK = replaceSpanOnce(
  GUIDED_DRAFT_SELF_CHECK, 'Trace the supplied due-today example', 'Trace the supplied boundary example', 'GUIDED_DRAFT_SELF_CHECK',
);

/**
 * The two overview numbers: checklist done and concept mastery.
 *
 * The overview gives the checklist as one intuitive percentage. This file is
 * the arithmetic, and nothing else: no repository,
 * no entity, no clock. It lives in the shared package because the API computes
 * both numbers in two services that must not drift from each other, the
 * learner dashboard and the class overview, and a definition with two copies
 * is not a definition.
 *
 * **Neither number replaces anything, and neither is a summand of the other.**
 *
 * `checklistPercent` is *how much of the checklist is done*: required tasks
 * passed over required tasks declared, counted over the **pinned version's**
 * tasks and weighted by task, so a phase with four required tasks counts for
 * four and not for one sixth.
 *
 * It is a different question from `progressPercent`, which is passed phases
 * over the `phase_states` rows an enrolment **holds**.
 * The two usually agree because `writeEnrollment` saves every phase's row in
 * one statement; they disagree on a board short of a row, which is reachable
 * because `analytics.forLearner` calls neither `reconcileToPack` nor
 * `fillMissingPhaseStates`, and there `checklistPercent` is the one that is
 * right. Asserting the identity flatly would pin a coincidence, so the spec
 * states the precondition instead.
 *
 * `masteryPercent` is *how well the concepts are understood*: the mean best
 * score over quiz tasks that have one. It is `null` and never `0` when there is
 * no quiz or none has been attempted: a blank and a zero are different facts,
 * which is the gradebook's own stated rule. A required quiz already moves the
 * phase's score once, through the roll-up's mean over required keys, so this is
 * a second reading of the same rows for a different question.
 *
 * Both round with `Math.round`, as `progressPercent` and `averageScore`
 * do: the rounding is part of the agreement, not a
 * detail beside it.
 */

/**
 * What the checklist counts for one phase, which is exactly the shape
 * `taskCountsOf` already answers with. Structural on purpose: this module
 * imports nothing, so it can never be in a cycle and the API can hand it a
 * `PhaseTaskCounts` unchanged.
 */
export interface ChecklistCounts {
  /** How many of this phase's pinned tasks are required. */
  required: number;
  /** How many of those have passed. */
  passedRequired: number;
}

/**
 * One phase's checklist percentage, 0..100.
 *
 * `0` when the phase declares no required task. That is the honest answer for
 * a gate with nothing in it: the phase has no checklist to be done with, and a
 * phase that reported 100 for declaring nothing would make the overall number
 * climb when a teacher removes work.
 */
export function checklistPercentOf(counts: ChecklistCounts): number {
  if (counts.required <= 0) return 0;
  return Math.round((counts.passedRequired / counts.required) * 100);
}

/**
 * The checklist percentage across a whole pinned version, 0..100.
 *
 * Task weighted: the sums are taken first and divided once, so a phase with
 * four required tasks carries four times the weight of a phase with one. Taking
 * the mean of `checklistPercentOf` per phase would weight every phase equally
 * and is a different number; this task-weighted one is the `checklistPercent`
 * that `instructor.service.ts` and `analytics.service.ts` report.
 */
export function overallChecklistPercent(phases: readonly ChecklistCounts[]): number {
  let required = 0;
  let passed = 0;
  for (const phase of phases) {
    required += phase.required;
    passed += phase.passedRequired;
  }
  return checklistPercentOf({ required, passedRequired: passed });
}

/**
 * The mastery percentage over a set of quiz tasks, 0..100, or `null`.
 *
 * The argument is every quiz task in scope, a phase's for the phase number,
 * the pinned version's for the overall one, carrying each one's best score, or
 * `null` where that task has no score to read. Such a quiz is left out of the
 * mean rather than counted as a zero: it is a question the learner has not
 * answered, not one they answered badly.
 *
 * **Two states read `null` here and the caller cannot tell them apart:** a
 * quiz nobody has attempted, and one a teacher has **reset**, which withdraws
 * the pass and the best score together. Both are *no score to read*, which is
 * what this mean is defined over; a reader who needs the difference wants the
 * papers, which a reset never deletes.
 *
 * `null` when the set is empty or nothing in it has a score. Never `0`.
 */
export function masteryPercentOf(bestScores: readonly (number | null | undefined)[]): number | null {
  const scored = bestScores.filter((score): score is number => typeof score === 'number');
  if (!scored.length) return null;
  return Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length);
}

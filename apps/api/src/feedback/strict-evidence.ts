import { reviewerVerdictIsAdvice, type ArtifactKind, type FeedbackReport, type PhaseRubric } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';

/**
 * Binary gate: every required automated check and every semantic criterion must
 * agree, for **one task**.
 *
 * The task's rubric is what the evidence is counted against, and the task's
 * check kind decides whether a suite has to be green. The clauses are read in
 * this order, and the first that fails refuses the pass:
 *
 * 1. The reviewer answered: a provider that did not answer, or an assessment
 *    that errored, refuses.
 * 2. The reviewer's evidence covers the rubric exactly: one entry per
 *    criterion, no key twice, no key the rubric lacks.
 * 3. There is at least one required check (every check but `process`), and
 *    each is `passed` or `info`.
 * 4. A code or tests task has a suite that ran at least one test, all of them
 *    passed, none failed and none errored.
 * 5. The reviewer's verdict: `pass`, with every criterion met, evidenced and
 *    free of an issue. At a rule-based score of exactly 100 this clause is
 *    advice rather than a refusal while the reviewer found strictly more than
 *    half of the criteria met (`reviewerVerdictIsAdvice`): the report keeps the
 *    reviewer's words and the web shows them as advice. A reviewer that finds
 *    most criteria unmet is refusing the work, so at 100 its verdict gates
 *    exactly as it does at any score below 100.
 *
 * **Clause 4 is unconditional on whether the task is sealed.** Firing it on
 * sealedness rather than on kind would make the decision weaker: it would
 * return `true` on a red, empty or absent suite where it must return `false`.
 * Two independent barriers keep an unsealed or assisted task from passing on a
 * suite that did not run: a red suite is a `failed` check and clause 3 refuses
 * it, and a suite that collects nothing can exit zero, so only `total > 0`
 * catches it.
 *
 * Sealedness decides not whether a task passes but whether its pass **opens the
 * phase**, and that lives one layer up.
 */
export function strictTaskEvidencePassed(
  task: { rubric: PhaseRubric; checkKind: ArtifactKind },
  report: GateReport,
  review: FeedbackReport['aiReview'],
): boolean {
  if (review.provider === 'unavailable' || review.assessmentError) return false;
  const evidence = review.criteriaEvidence;
  if (!evidence?.length || evidence.length !== task.rubric.criteria.length) return false;
  const keys = new Set(evidence.map(e => e.key));
  if (keys.size !== evidence.length || task.rubric.criteria.some(c => !keys.has(c.key))) return false;
  const required = report.checks.filter(c => c.id !== 'process');
  if (!required.length || required.some(c => c.status !== 'passed' && c.status !== 'info')) return false;
  if (task.checkKind === 'code' || task.checkKind === 'tests') {
    if (!report.tests || report.tests.total <= 0 || report.tests.passed !== report.tests.total || report.tests.failed > 0 || report.tests.errored > 0) return false;
  }
  if (reviewerVerdictIsAdvice(report.overall, evidence)) return true;
  if (review.verdict !== 'pass') return false;
  if (evidence.some(e => !e.met || !e.evidence?.trim() || e.issue?.trim())) return false;
  return true;
}

/**
 * What the gate reads of a report. `overall` is the stored rule-based score:
 * the weighted criterion total the checkers wrote, rounded, before the reviewer
 * was asked (a weighted 99.5 rounds to 100), and the reviewer never moves it.
 * It is optional because a caller may hand the gate only checks and tests; a
 * report with no score is judged with the reviewer's verdict gating, since no
 * score is never 100.
 */
export type GateReport = Pick<FeedbackReport, 'checks' | 'tests'> & { overall?: number };

/**
 * Whether a quiz paper passed.
 *
 * A sibling, written beside `strictTaskEvidencePassed` and not inside it, so
 * that the other check kinds keep their clauses unchanged. It is what decides
 * `passed` on a quiz report at `buildReport`'s last line, because that
 * function's **first** clause refuses a review whose provider did
 * not answer, and no provider is asked to score set equality, so left alone a
 * perfect quiz would never pass and a deployment with no provider could not
 * pass one at all.
 *
 * **That is one site of five, and the other four are why this is a sibling
 * rather than a fork.** `advance` evaluates the gate a second time and
 * independently, over the *stored* report, and so do project completion and
 * three instructor readers. Forking at five call sites is five places that can
 * disagree about one gate. So the repair is in the report: a quiz report
 * carries exactly one `FeedbackCheck` (id `quiz`) whose status is this
 * function's answer, and one met criterion with `provider: 'not-applicable'`,
 * which makes `strictTaskEvidencePassed` answer exactly `quizPassed` at every
 * one of the five sites, by construction. The spec beside this function is that
 * equivalence written down, so the report shape cannot drift without a red
 * test.
 *
 * `>=` and not `>`: a pass mark is a mark a learner can reach. Four of five
 * against a mark of 80 passes.
 */
export function quizPassed(overall: number, passMark: number): boolean {
  return overall >= passMark;
}

/**
 * Binary gate for a whole phase: every required automated check and every
 * semantic criterion must agree.
 *
 * It delegates to `strictTaskEvidencePassed` with the phase's rubric and check
 * kind. On a phase whose compiled list is the synthesised sole task the two
 * functions are the same question asked twice (the sole task's rubric *is* the
 * phase's and its check kind *is* the phase's), so the delegation decides
 * nothing of its own.
 */
export function strictEvidencePassed(phase: PhaseContent, report: GateReport, review: FeedbackReport['aiReview']): boolean {
  return strictTaskEvidencePassed({ rubric: phase.rubric, checkKind: phase.checks.kind }, report, review);
}

import { CONFIG_SMOKE_KEY, FIXED_SCORER_KEYS } from '@learnsdlc/shared';
import { lockedCriteriaOf } from './checks-validation';
import type { PhaseChecks } from './content.types';
import type { GradedUnit } from './pack-compiler';

/*
 * The rubric keys the grader actually scores, by `checks.kind`. `code` and
 * `tests` phases are scored from a fixed set of literals in
 * `feedback.service.ts` (`buildCodeReport`, `buildTestsReport`); `config`
 * phases are scored from the criteria their own rules name, plus
 * `build_smoke`.
 *
 * `assembleCriteria` reads `scores.get(criterion.key) ?? 0`, so a rubric key
 * the grader never sets is indistinguishable from a real zero and carries no
 * evidence: every learner of that pack loses that criterion's whole weight and
 * nothing says why. The loader holds each pack's rubric against this set at
 * boot instead. Both key sets (`FIXED_SCORER_KEYS`, `CONFIG_SMOKE_KEY`) live
 * in the shared package, so the web's builders lock the same keys.
 */

/**
 * `scoredRubricKeys`'s answer for a story phase: the floor scores every
 * criterion the rubric declares, so the set holds this sentinel rather than
 * names. Read it through `scoredKeysFor`, which expands it against the rubric.
 */
export const STORY_SCORES_ALL = '*';

/**
 * The rubric keys the grader will set for a phase with these checks, and,
 * given a task's graded units, the keys it will set **for that task**.
 *
 * `units` omitted is the phase's own question, answered over the whole phase:
 * `loadRubric`'s boot check on every shipped pack passes nothing and gets the
 * phase-wide set, so a phase-level rubric is judged against every key. A synthesised
 * sole task owns every unit its phase declares, so its answer is that same set
 * too.
 *
 * No arm narrows by `units`: every phase holds one graded task beside its
 * quizzes, and that task owns every unit the phase declares.
 */
export function scoredRubricKeys(checks: PhaseChecks, units?: readonly GradedUnit[]): Set<string> {
  switch (checks.kind) {
    case 'code':
    case 'tests': {
      const keys = new Set(FIXED_SCORER_KEYS[checks.kind]);
      // a change request scores every other key: the sentinel `scoredKeysFor` expands
      if (checks.kind === 'code' && checks.change) keys.add(STORY_SCORES_ALL);
      return keys;
    }
    case 'config': {
      const keys = new Set(lockedCriteriaOf(checks));
      // a runbook scores every other key: the sentinel `scoredKeysFor` expands
      if (checks.runbook) keys.add(STORY_SCORES_ALL);
      return keys;
    }
    // A quiz: exactly one key, and it is the quiz's own. A quiz
    // derives one criterion, weight 1, keyed `checks.criterion`, and
    // `quiz-rubric-key-is-the-quiz's` holds the task's rubric to it, because
    // `assembleCriteria` reads `scores.get(key) ?? 0` and a mismatch is a flat
    // zero with no evidence, which on a required quiz is a bar nobody clears.
    case 'quiz':
      return new Set([checks.criterion]);
    case 'story':
    case 'design':
      return new Set([STORY_SCORES_ALL]);
  }
}

/**
 * The rubric keys the grader will set for a phase with these checks and this
 * rubric. For a story or design phase that is every criterion the rubric
 * declares, because the floor scores them all; for a phase with a record it
 * is the locked keys and every other key of the rubric, the record's floor
 * scoring those; for every other kind it is
 * `scoredRubricKeys`'s answer. The boot-time rubric check and the
 * content-check CLI both ask through here, so neither sees the sentinel.
 */
export function scoredKeysFor(
  checks: PhaseChecks,
  rubric: { criteria: readonly { key: string }[] },
): Set<string> {
  if (checks.kind === 'story' || checks.kind === 'design') return new Set(rubric.criteria.map((c) => c.key));
  const keys = scoredRubricKeys(checks);
  if (!keys.has(STORY_SCORES_ALL)) return keys;
  // the locked keys, and every other key of the rubric as a record criterion
  keys.delete(STORY_SCORES_ALL);
  for (const c of rubric.criteria) keys.add(c.key);
  return keys;
}

/** Where a phase with these checks gets its scores, for the boot-time message. */
export function scorerSourceFor(checks: PhaseChecks): string {
  const kind = checks.kind;
  if (kind === 'config') {
    return checks.runbook
      ? 'the file rules, the build check and the runbook floor'
      : `this phase's rules (checks.rules[].criterion) and the build check ("${CONFIG_SMOKE_KEY}")`;
  }
  if (kind === 'code' && checks.change) return 'the code grader and the change request floor';
  // There is no quiz grader: a paper is scored by set
  // equality against the sealed key, so the sentence names the field instead.
  if (kind === 'quiz') return "this quiz's own criterion (checks.criterion)";
  if (kind === 'story' || kind === 'design') return 'the floor';
  return `the ${kind} grader`;
}

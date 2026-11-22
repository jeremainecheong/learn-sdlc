/**
 * The floor rules a teacher set to zero.
 *
 * A record phase's floor ("at least n data entries") is graded as one check
 * per rule, and a rule whose floor is 0 passes whatever the record holds. The
 * report still lists it, ticked, which reads as something the learner did
 * ("At least 0 data entries"). Which rules have a floor of 0 is read from the
 * phase's own floor (`PhaseDetail.story`, `.design`, `.runbook`, `.change`),
 * never from the words of the check: the review pages draw such a rule as not
 * required rather than as passed. Nothing graded changes.
 */
import type { PhaseDetail } from '@learnsdlc/shared';

/** The parts of a phase that hold a floor. */
export type FloorSource = Partial<Pick<PhaseDetail, 'story' | 'design' | 'runbook' | 'change'>> | null | undefined;

/** Each minimum rule's check id (as the shared package emits it) and where its floor is read. */
const MIN_RULES: readonly [id: string, floor: (phase: NonNullable<FloorSource>) => number | undefined][] = [
  ['story.scope.min', (p) => p.story?.floor.minExclusions],
  ['story.criteria.min', (p) => p.story?.floor.minCriteria],
  ['design.entities.min', (p) => p.design?.floor.minEntities],
  ['design.relations.min', (p) => p.design?.floor.minRelations],
  ['design.operations.min', (p) => p.design?.floor.minOperations],
  ['design.decisions.min', (p) => p.design?.floor.minDecisions],
  ['design.api.min', (p) => p.design?.floor.minEndpoints],
  ['design.screens.min', (p) => p.design?.floor.minScreens],
  ['runbook.environment.min', (p) => p.runbook?.floor.minEnvironment],
  ['runbook.health.min', (p) => p.runbook?.floor.minHealth],
  ['runbook.rollback.min', (p) => p.runbook?.floor.minRollback],
  ['runbook.data.min', (p) => p.runbook?.floor.minData],
  ['change.impact.min', (p) => p.change?.floor.minImpact],
  ['change.contract.min', (p) => p.change?.floor.minContract],
  ['change.tests.min', (p) => p.change?.floor.minTests],
];

/** The ids of the checks whose floor is 0 on this phase. Empty when the phase holds no floor. */
export function zeroFloorChecks(phase: FloorSource): ReadonlySet<string> {
  if (!phase) return new Set();
  return new Set(MIN_RULES.filter(([, floor]) => floor(phase) === 0).map(([id]) => id));
}

/** The word a not-required rule is drawn with, in place of Passed. */
export const NOT_REQUIRED_WORD = 'Not required';

/**
 * A criterion's evidence lines without the lines of rules whose floor is 0.
 * The API writes a passed rule's line as "✓ " and the check's own label
 * (`floorPartial`), so a line is matched to its check by that label, from the
 * same report.
 */
export function withoutZeroFloor(
  lines: readonly string[],
  checks: readonly { id: string; label: string }[],
  zero: ReadonlySet<string>,
): string[] {
  if (zero.size === 0) return [...lines];
  const hidden = new Set(checks.filter((check) => zero.has(check.id)).map((check) => `✓ ${check.label}`));
  return lines.filter((line) => !hidden.has(line));
}

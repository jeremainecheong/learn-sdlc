/**
 * A project holds the phases its teacher chose, so every view that
 * counts phases or names them by number reads the project's own: its count,
 * its places, and the key that says what kind of phase each is.
 */
import type { PhaseKey, PhaseStatus } from '@learnsdlc/shared';

/** Every phase of this project passed: the completion line everywhere it is drawn. */
export function allPassed(phases: readonly { status: PhaseStatus }[] | undefined): boolean {
  return !!phases && phases.length > 0 && phases.every((one) => one.status === 'passed');
}

/** "2 / 3 phases passed": the project's own count. */
export function phaseCountLine(passed: number, count: number): string {
  return `${passed} ${phaseCountUnit(count)}`;
}

/** "/ 3 phases passed": the line after the number, where the number is drawn on its own. */
export function phaseCountUnit(count: number): string {
  return `/ ${count} phase${count === 1 ? '' : 's'} passed`;
}

/**
 * Requirements and Design are reviewed as written work; every other phase is
 * worked as a pull request. Read by the key, never by the order.
 */
export function isWrittenPhase(key: PhaseKey): boolean {
  return key === 'requirements' || key === 'design';
}

/**
 * The IDE's and the kill matrix's Submit: "Submit for review" on a written
 * phase, else the pull request named by the phase's place in its own project
 * ("Submit PR-3" in TaskTrackr, "Submit PR-1" for an Implementation that opens
 * its project), and "Submit again" once there is one.
 */
export function submitLabel(phase: { key: PhaseKey; place: number }, hasPr: boolean): string {
  if (hasPr) return 'Submit again';
  return isWrittenPhase(phase.key) ? 'Submit for review' : `Submit PR-${phase.place}`;
}

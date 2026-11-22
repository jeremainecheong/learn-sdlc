/**
 * The Testing builder's pure half: which task it edits, its three steps and
 * which are done, and the rubric keys the grader scores itself. Nothing here
 * touches React, the network or the DOM.
 */
import { FIXED_SCORER_KEYS, type DraftPhaseView, type DraftTaskView } from '@learnsdlc/shared';
import { fixedCriteriaStepsDone } from '../implementation/implementation-builder-model';

export const TESTING_STEP_LABELS = ['Brief', 'Tests and runs', 'Criteria'] as const;

/** The three keys the grader scores itself on a tests phase: their key and removal are locked, and no other key is taken. */
export const LOCKED_TESTING_KEYS = FIXED_SCORER_KEYS.tests;

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels: Testing's one tests task. A concept quiz beside it
 * keeps its own row. A read-only draft draws the builder without inputs, so
 * the task is the builder's either way.
 */
export function testingBuilderTask(phase: DraftPhaseView, _editable: boolean): DraftTaskView | null {
  if (phase.key !== 'testing') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  return work.length === 1 && work[0].checkKind === 'tests' ? work[0] : null;
}

/** Testing's three steps, done or not. */
export function testingStepsDone(phase: DraftPhaseView, task: DraftTaskView): boolean[] {
  return fixedCriteriaStepsDone(phase, task, LOCKED_TESTING_KEYS);
}

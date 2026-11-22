/**
 * The Implementation builder's pure half: which task it edits, its three
 * steps and which are done, and the rubric keys the grader scores itself.
 * Nothing here touches React, the network or the DOM.
 */
import { FIXED_SCORER_KEYS, type DraftPhaseView, type DraftTaskView } from '@learnsdlc/shared';
import { WEIGHT_TOLERANCE } from '../requirements/builder-model';

export const IMPLEMENTATION_STEP_LABELS = ['Brief', 'Code and runs', 'Criteria'] as const;

/** The four keys the grader scores itself on a code phase: their key and removal are locked, and no other key is taken. */
export const LOCKED_IMPLEMENTATION_KEYS = FIXED_SCORER_KEYS.code;

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels: Implementation's one code task (a code task with a
 * change request is Maintenance's shape, never this one). A concept quiz
 * beside it keeps its own row. A read-only draft draws the builder without
 * inputs, so the task is the builder's either way.
 */
export function implementationBuilderTask(phase: DraftPhaseView, _editable: boolean): DraftTaskView | null {
  if (phase.key !== 'implementation') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  return work.length === 1 && work[0].checkKind === 'code' && !work[0].change ? work[0] : null;
}

/**
 * Which of the three steps are done, read from what the server holds: Brief
 * has an intro and a title; the runs always (they come with the project);
 * Criteria has every fixed key, no other, and weights summing to 1.
 */
export function fixedCriteriaStepsDone(phase: DraftPhaseView, task: DraftTaskView, fixed: readonly string[]): boolean[] {
  const criteria = task.rubric?.criteria ?? [];
  const sum = criteria.reduce((total, one) => total + one.weight, 0);
  const keys = criteria.map((one) => one.key);
  return [
    phase.intro.trim().length > 0 && task.title.trim().length > 0,
    true,
    Math.abs(sum - 1) <= WEIGHT_TOLERANCE && fixed.every((key) => keys.includes(key)) && keys.every((key) => fixed.includes(key)),
  ];
}

/** Implementation's three steps, done or not. */
export function implementationStepsDone(phase: DraftPhaseView, task: DraftTaskView): boolean[] {
  return fixedCriteriaStepsDone(phase, task, LOCKED_IMPLEMENTATION_KEYS);
}

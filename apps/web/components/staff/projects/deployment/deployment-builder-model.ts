/**
 * The Deployment builder's pure half: which task it edits, which steps are
 * done, which rubric keys the phase's own checks grade, the runbook body the
 * server holds, and the two warnings it says (the starting record that
 * already meets the floor, and a brief that still names a file the phase no
 * longer has). Nothing here touches React, the network or the DOM.
 */
import {
  CONFIG_SMOKE_KEY,
  evaluateRunbookFloor,
  type DraftPhaseView,
  type DraftTaskView,
  type RunbookChecksBody,
  type RunbookFloor,
  type TaskMutationResult,
  type UpdateTaskBody,
} from '@learnsdlc/shared';
import { WEIGHT_TOLERANCE } from '../requirements/builder-model';

export const DEPLOYMENT_STEP_LABELS = ['Brief', 'Files and checks', 'Runbook', 'Criteria'] as const;

/** The publish warning when the starting record already meets the floor; it never refuses. */
export const STARTING_RUNBOOK_MEETS_FLOOR =
  'The starting runbook already meets the floor, so a learner who changes nothing passes it. Raise the floor or empty the starting record.';

/**
 * The task the builder edits on this phase, or null where the editor keeps
 * its generic panels: Deployment's one config task, when the payload carries
 * its runbook view (a task still in the older format carries the read-time
 * view). A concept quiz beside it keeps its own row. A read-only draft draws
 * the builder without inputs, so the task is the builder's either way.
 */
export function deploymentBuilderTask(phase: DraftPhaseView, _editable: boolean): DraftTaskView | null {
  if (phase.key !== 'deployment') return null;
  const work = phase.tasks.filter((one) => one.checkKind !== 'quiz' && !one.quiz);
  if (work.length !== 1 || work[0].checkKind !== 'config' || !work[0].runbook) return null;
  return work[0];
}

/**
 * The rubric keys the phase's own checks grade: the file rules' criteria and
 * `build_smoke`, read from the config view, the task view's one view of the
 * file rules.
 */
export function lockedDeploymentKeys(task: DraftTaskView): string[] {
  return [...new Set([...(task.config?.fileRules ?? []).map((rule) => rule.criterion), CONFIG_SMOKE_KEY])];
}

/**
 * Which of the four steps are done: Brief has an intro and a title; Files and
 * checks always; Runbook once saved (a structured task's is, as Design counts
 * a structured task; an older one only after its first runbook save);
 * Criteria has weights summing to 1 and at least one criterion the phase's
 * own checks do not grade.
 */
export function deploymentStepsDone(phase: DraftPhaseView, task: DraftTaskView, saved: { runbook: boolean }): boolean[] {
  const criteria = task.rubric?.criteria ?? [];
  const sum = criteria.reduce((total, one) => total + one.weight, 0);
  const locked = new Set(lockedDeploymentKeys(task));
  return [
    phase.intro.trim().length > 0 && task.title.trim().length > 0,
    true,
    saved.runbook || (Boolean(task.runbook) && !task.recordOlderFormat),
    Math.abs(sum - 1) <= WEIGHT_TOLERANCE && criteria.some((one) => !locked.has(one.key)),
  ];
}

/** The runbook body the task carries (the converted floor on a task still in the older format). */
export function runbookBodyOf(task: DraftTaskView): RunbookChecksBody {
  return { floor: { ...task.runbook!.floor } };
}

/** The runbook body the server holds on this task, or null on one still in the older format (or none). */
export function savedRunbookBody(task: DraftTaskView | undefined): RunbookChecksBody | null {
  return task?.runbook && !task.recordOlderFormat ? runbookBodyOf(task) : null;
}

/** The line the builder shows on a task still in the older format, editable and read-only. */
export const RUNBOOK_OLDER_FORMAT_NOTICE = 'This task is in the older format. Saving the brief, the runbook floor or the criteria converts it.';
export const RUNBOOK_OLDER_FORMAT_NOTICE_READONLY = 'This task is in the older format.';

/**
 * A save that writes the task through the builder's one queue: given the
 * runbook body the server holds when its turn comes (null on a task still in
 * the older format), the body to send.
 */
export type DeploymentTaskWrite = (build: (held: RunbookChecksBody | null) => UpdateTaskBody) => Promise<TaskMutationResult>;

/** The publish warning when the starting record already passes every floor check, or null. */
export function startingRunbookWarning(startingText: string, floor: RunbookFloor): string | null {
  return evaluateRunbookFloor(startingText, floor).every((one) => one.passed) ? STARTING_RUNBOOK_MEETS_FLOOR : null;
}

/** The warning line when the brief or an objective still names a file this phase no longer has, or null. */
export function briefNamesOldFile(task: DraftTaskView, file: 'RUNBOOK.md' | 'CHANGELOG.md'): string | null {
  return [task.brief, ...task.objectives].some((text) => text.includes(file))
    ? `The brief still names ${file}, which this phase no longer has.`
    : null;
}

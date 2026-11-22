/**
 * "Start this task over" and "Retry this task" (or "Retry this phase"): the
 * routes the reset control talks to (`PhasesController`,
 * `GET`/`POST /phases/:id/tasks/:taskKey/reset`, and `/phases/:id/reset` for a
 * sole task).
 *
 * The plan is read first and drawn as the confirm, so the learner is told what
 * the reset restores, re-seeds and keeps before they press anything; the reset
 * then quotes the workspace version the tab holds, and a version that has moved
 * on is the save's own 409 (`workspace_changed`) with nothing written.
 */
import type { ResetTaskInput, TaskResetPlanView, TaskResetResult } from '@learnsdlc/shared';
import { request } from './api';

/**
 * A sole task (TaskTrackr's) has the empty key, which a path segment cannot
 * carry, so its retry is the phase-level pair, `/phases/:id/reset`, which
 * answers the phase's only task.
 */
function resetPath(phaseId: string, taskKey: string): string {
  const phase = `/phases/${encodeURIComponent(phaseId)}`;
  return taskKey === '' ? `${phase}/reset` : `${phase}/tasks/${encodeURIComponent(taskKey)}/reset`;
}

export const taskResetApi = {
  /** What a reset of this task would do, and the one sentence it would be refused with. Writes nothing. */
  plan: (phaseId: string, taskKey: string) => request<TaskResetPlanView>('GET', resetPath(phaseId, taskKey)),
  /** Start the task over against the version this tab last loaded (null: never saved). */
  reset: (phaseId: string, taskKey: string, baseVersion: string | null) =>
    request<TaskResetResult>('POST', resetPath(phaseId, taskKey), { baseVersion } satisfies ResetTaskInput),
};

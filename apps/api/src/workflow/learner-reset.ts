import {
  BadRequestException,
  ConflictException,
  type HttpException,
} from '@nestjs/common';
import { In, IsNull, type EntityManager } from 'typeorm';
import type { TaskResetPlanView, TaskResetProtectedPath, TaskRetryPlan } from '@learnsdlc/shared';
import { isQuizTask, type CompiledTask } from '../content/pack-compiler';
import type { PhaseContent } from '../content/content.types';
import { soleTaskList } from '../content/task-units';
import {
  ExecutionRunEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
} from '../db/entities';
import { AgentProposalEntity } from '../assistant/agent-proposal.entity';
import { submissionId } from '../feedback/submission-id';
import { unknownTask } from '../feedback/task-resolution';
import { stampEndingRun } from './reset-epoch';

/**
 * "Start this task over", the learner's own reset of one task of an authored
 * task list, and "Retry this task" (or "Retry this phase"), the same reset of
 * a task that has PASSED.
 *
 * A retry is the reset with two differences. It is allowed on a passed task,
 * and on a passed sole-task phase (TaskTrackr's, whose one task is the phase);
 * and it puts the task's status back to `in_progress` for a new attempt
 * (the phase row's too, when the task is required and the phase had passed),
 * keeping everything else: every submission, the pass date (`passedAt`), the
 * best score, the attempt count, a teacher's signature, the release records and
 * the completion record. The task counts as passed again only once a new
 * submission passes the same review: on an authored task the earlier run's
 * revisions are stamped with their epoch (`stampEndingRun`) and the strict
 * gate reads only the current run; on a sole-task phase the phase row is the
 * gate's own conjunct, and only a new verdict writes it `passed` again.
 *
 * The rules live here, beside the two routes' service methods in
 * `WorkflowService` (`planTaskReset`, `resetTask`), so the plan the confirm
 * draws and the reset that runs read ONE analysis: whatever the plan says the
 * reset would restore, re-seed or keep is exactly what it does.
 *
 * Each refusal is one sentence, and nothing is written before the last one.
 */
export const RESET_REFUSALS = {
  locked: 'This phase is not open yet, so there is nothing of it to start over.',
  soleTask: 'This phase has a single task. Your instructor can reset its files for you.',
  quiz: 'A quiz has no files to start over. Your instructor can reset it.',
  awaitingSignOff: 'Your teacher is reviewing this task. Reset once they have answered.',
  submissionInFlight: 'Your last submission is still being checked. Reset once its result is back.',
  runInFlight: 'A run is still going. Reset once it finishes.',
} as const;

/**
 * The retry's own refusals, in the retry's words: a passed task is retried
 * once nothing of it is in flight and no teacher review is pending. A quiz is
 * refused in the reset's sentence (a quiz is reset by the teacher), and so is
 * a locked phase.
 */
export const RETRY_REFUSALS = {
  awaitingSignOff: 'Your teacher is reviewing this task. Retry once they have answered.',
  submissionInFlight: 'Your last submission is still being checked. Retry once its result is back.',
  runInFlight: 'A run is still going. Retry once it finishes.',
} as const;

/** The refusal as the POST route raises it: a state the learner can wait out is a 409. */
export function refusalException(sentence: string): HttpException {
  const waitable: string[] = [
    RESET_REFUSALS.awaitingSignOff,
    RESET_REFUSALS.submissionInFlight,
    RESET_REFUSALS.runInFlight,
    ...Object.values(RETRY_REFUSALS),
  ];
  return waitable.includes(sentence)
    ? new ConflictException(sentence)
    : new BadRequestException(sentence);
}

/** What one reset of one task would do, as both routes read it. */
export interface ResetAnalysis {
  /** Owned paths whose learner copy is deleted (the pinned starter reads again). */
  restores: string[];
  /** Owned paths the server seeds: deleted, then seeded again. */
  reseeds: string[];
  /** Owned paths a passed sibling shares, kept as they are. */
  protectedBy: TaskResetProtectedPath[];
  /**
   * True when this task is the phase's only non-quiz task: the shape of
   * every executable phase, where it owns every executable unit, so the
   * phase's `links`, `drill` and `ranBeforeSubmit` are its own to clear, and a
   * Run of the phase is its to wait for. On a split written phase they are
   * not the task's, and the reset leaves them alone.
   */
  ownsExecution: boolean;
}

/**
 * The paths a reset of `task` touches, and which of them it may not.
 *
 * Owned = the pinned task's `owns` that the phase declares editable. A path
 * shared with a sibling task is deleted only if no sibling sharing it has
 * passed; otherwise it is kept and named with that sibling (the confirm says
 * which). `seeded` is the set of paths the server seeds on this phase.
 */
export function analyseReset(
  phase: Pick<PhaseContent, 'files'>,
  tasks: readonly CompiledTask[],
  task: CompiledTask,
  rows: readonly Pick<TaskStateEntity, 'taskKey' | 'status'>[],
  seeded: ReadonlySet<string>,
): ResetAnalysis {
  const editable = new Set(phase.files.filter((file) => file.editable).map((file) => file.path));
  const owned = [...new Set(task.owns)].filter((path) => editable.has(path)).sort();
  const passed = new Set(rows.filter((row) => row.status === 'passed').map((row) => row.taskKey));
  const restores: string[] = [];
  const reseeds: string[] = [];
  const protectedBy: TaskResetProtectedPath[] = [];
  for (const path of owned) {
    const keeper = tasks.find(
      (sibling) =>
        sibling.taskKey !== task.taskKey && sibling.owns.includes(path) && passed.has(sibling.taskKey),
    );
    if (keeper) protectedBy.push({ path, siblingTitle: keeper.title });
    else if (seeded.has(path)) reseeds.push(path);
    else restores.push(path);
  }
  const nonQuiz = tasks.filter((one) => !isQuizTask(one));
  return {
    restores,
    reseeds,
    protectedBy,
    ownsExecution: nonQuiz.length === 1 && nonQuiz[0].taskKey === task.taskKey,
  };
}

/**
 * Whether this reset is a retry: the task has passed. A sole task has no row,
 * so its status is the phase row's; an authored task's is its own row's.
 */
export function isRetry(
  held: Pick<PhaseStateEntity, 'status'>,
  tasks: readonly CompiledTask[],
  row: Pick<TaskStateEntity, 'status'> | null,
): boolean {
  return soleTaskList(tasks) ? held.status === 'passed' : row?.status === 'passed';
}

/**
 * The refusal the reset would meet, in the order the POST route asks, or null.
 * Rule 9 (a stale `baseVersion`) is the POST's own and is not asked here.
 *
 * `row` is the task's row as read (absent: the reset would mint it, and a
 * minted row is `in_progress`). A passed task is a retry (`isRetry`), refused
 * only in the retry's own words; a sole-task phase that has not passed is
 * still refused by name, because starting TaskTrackr's work over is the
 * instructor's lever and only a retry of completed work is the learner's.
 */
export async function resetRefusal(
  manager: EntityManager,
  held: Pick<PhaseStateEntity, 'id' | 'userId' | 'status'>,
  tasks: readonly CompiledTask[],
  task: CompiledTask | undefined,
  taskKey: string,
  row: Pick<TaskStateEntity, 'status' | 'awaitingSignOff'> | null,
  analysis: ResetAnalysis | null,
): Promise<string | null> {
  if (held.status === 'locked') return RESET_REFUSALS.locked;
  const retry = isRetry(held, tasks, row);
  if (soleTaskList(tasks) && !retry) return RESET_REFUSALS.soleTask;
  if (!task) throw unknownTask(taskKey);
  if (isQuizTask(task)) return RESET_REFUSALS.quiz;
  const said = retry ? RETRY_REFUSALS : RESET_REFUSALS;
  if (row?.awaitingSignOff) return said.awaitingSignOff;
  const marking = await manager.exists(SubmissionEntity, {
    where: { phaseStateId: held.id, taskKey: task.taskKey, status: In(['queued', 'running']) },
  });
  if (marking) return said.submissionInFlight;
  if (analysis?.ownsExecution) {
    const running = await manager.exists(ExecutionRunEntity, {
      where: {
        phaseStateId: held.id,
        userId: held.userId,
        kind: 'run',
        status: In(['queued', 'running']),
      },
    });
    if (running) return said.runInFlight;
  }
  return null;
}

/**
 * Whether a pending Agentic proposal exists on this phase. Its approval is
 * bound to the hash of every editable file of the phase, so a reset of ANY
 * task drops it: the next apply meets the hash conflict.
 */
export function pendingProposal(
  manager: EntityManager,
  held: Pick<PhaseStateEntity, 'id' | 'userId'>,
): Promise<boolean> {
  return manager.exists(AgentProposalEntity, {
    where: { phaseStateId: held.id, userId: held.userId, appliedAt: IsNull() },
  });
}

/** The facts a retry's plan sentence names. */
export interface RetryFacts {
  /** A sole-task phase: the phase is what is retried. */
  wholePhase: boolean;
  /** A teacher countersigned the earlier pass (`signedOffBy`). */
  signedOff: boolean;
  /** The learner has already moved on to a later phase. */
  movedOn: boolean;
  /** The project is complete (`enrollments.completed`). */
  completed: boolean;
}

/**
 * What a retry keeps and when it counts again, as the confirm says it: the
 * earlier attempts first, then each further thing kept that is true of this
 * learner (and, for one who has moved on but not finished, that the project
 * cannot complete until this passes again), then the one condition for
 * counting again.
 */
export function retryKeeps(facts: RetryFacts): string {
  return [
    'Your earlier pass, its date, your best score and every attempt stay in your history.',
    facts.signedOff ? "Your teacher's signature stays with that earlier pass." : null,
    facts.movedOn ? 'The phases you have opened since stay open.' : null,
    // The completion arm asks every phase's strict pass again, so a learner
    // still on the way is told now, not at the last phase.
    facts.movedOn && !facts.completed ? 'You need to pass it again before you can complete the project.' : null,
    facts.completed ? 'Your project stays complete.' : null,
    `${facts.wholePhase ? 'This phase' : 'This task'} counts as passed again once a new submission passes the same review.`,
  ]
    .filter((sentence): sentence is string => !!sentence)
    .join(' ');
}

/**
 * The retry facts for the plan, or null when the reset is not a retry: the
 * task has not passed, or it is a quiz (refused, and reset by the teacher),
 * or there is no such task, or the phase is locked.
 */
export function retryFactsOf(
  held: Pick<PhaseStateEntity, 'status' | 'phaseOrder'>,
  tasks: readonly CompiledTask[],
  task: CompiledTask | undefined,
  row: Pick<TaskStateEntity, 'status' | 'signedOffBy'> | null,
  enrollment: { completed: boolean; currentPhaseOrder: number },
): RetryFacts | null {
  if (!task || isQuizTask(task) || held.status === 'locked' || !isRetry(held, tasks, row)) return null;
  return {
    wholePhase: soleTaskList(tasks),
    signedOff: !!row?.signedOffBy,
    movedOn: enrollment.currentPhaseOrder > held.phaseOrder,
    completed: enrollment.completed,
  };
}

/** The plan view, from one analysis. `retry` is set exactly when the task has passed. */
export function planView(
  analysis: ResetAnalysis | null,
  dropsPendingProposal: boolean,
  refusal: string | null,
  retry: RetryFacts | null = null,
): TaskResetPlanView {
  const plan: TaskRetryPlan | null = retry ? { wholePhase: retry.wholePhase, keeps: retryKeeps(retry) } : null;
  return {
    restores: analysis?.restores ?? [],
    reseeds: analysis?.reseeds ?? [],
    protectedBy: analysis?.protectedBy ?? [],
    dropsPendingProposal,
    refusal,
    retry: plan,
  };
}

/**
 * What a retry writes beyond a reset, decided by the caller from the same
 * reads the refusal made: the task's status goes back to `in_progress`, and
 * `phaseBack` says the phase row's does too (a sole-task phase, whose status
 * IS its task's, or a REQUIRED authored task of a phase that had passed,
 * the teacher's `task-reset` brings the phase row down by the same rule, and
 * `carriedTaskPass` relies on a phase that lost a required pass not reading
 * `passed`). An optional task moves no gate and moves no phase row.
 */
export interface RetryWrite {
  phaseBack: boolean;
}

/**
 * The writes, after every refusal, on the reset's own transaction under the
 * enrolment lock:
 *
 * 1. one `task_resets` row with the pre-reset bytes of the deleted keys, only
 *    when one of them held bytes: the table's writer, pruned by
 *    `RetentionService.pruneResetCopies`; `id` is a UUIDv7 so the prune's
 *    `createdAt DESC, id DESC` order is total on sqlite's one-second clock.
 *    Its `taskStateId` is the task row's, or on a sole-task phase (a retry,
 *    the only reset a sole task has) the phase row's, which IS its row;
 * 2. ONE narrow compare-and-swap on the phase row, stamped with
 *    `saveWorkspace`'s own formula, never `save(state)`; `links`,
 *    `drill` and `ranBeforeSubmit` only when the task owns the phase's
 *    execution; `status: 'in_progress'` on a retry that brings the phase
 *    back; `affected === 0` is the caller's 409;
 * 3. on an authored task, the task's NULL-epoch revisions stamped with the
 *    run that ends;
 * 4. on an authored task, the task row: `ranBeforeSubmit = false`, `resetAt`,
 *    `resetCount + 1`, and on a retry `status: 'in_progress'`. `bestScore`,
 *    `attempts`, `passedAt` and a signature stay; no submission is deleted.
 *
 * A sole task has no row, so 3 and 4 are not written for it: its revisions
 * keep the NULL epoch every sole-task revision carries, and its retry is the
 * phase row's status alone.
 *
 * Returns the new version, or null when the swap lost (the caller's 409).
 */
export async function writeReset(
  manager: EntityManager,
  held: PhaseStateEntity,
  row: TaskStateEntity | null,
  analysis: ResetAnalysis,
  workspace: Record<string, string>,
  taken: Record<string, string>,
  now: Date,
  retry: RetryWrite | null = null,
): Promise<string | null> {
  if (Object.keys(taken).length) {
    await manager.insert(TaskResetEntity, {
      id: submissionId(now.getTime()),
      taskStateId: row?.id ?? held.id,
      userId: held.userId,
      files: taken,
    });
  }
  const stored = held.workspaceUpdatedAt ?? '';
  const version = new Date(Math.max(now.getTime(), (Date.parse(stored) || 0) + 1)).toISOString();
  const swapped = await manager.update(
    PhaseStateEntity,
    { id: held.id, workspaceUpdatedAt: stored || IsNull() },
    {
      workspace,
      workspaceUpdatedAt: version,
      ...(analysis.ownsExecution ? { links: null, drill: null, ranBeforeSubmit: false } : {}),
      ...(retry?.phaseBack ? { status: 'in_progress' as const } : {}),
    },
  );
  if (!swapped.affected) return null;
  if (!row) return version;
  await stampEndingRun(manager, row);
  await manager.update(
    TaskStateEntity,
    { id: row.id },
    {
      ranBeforeSubmit: false,
      resetAt: now.toISOString(),
      resetCount: row.resetCount + 1,
      ...(retry ? { status: 'in_progress' as const } : {}),
    },
  );
  return version;
}

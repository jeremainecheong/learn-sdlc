import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { CompiledTask } from '../content/pack-compiler';

/*
 * Which task a revision or a request is about, and the two refusals a task
 * key can earn. Pure: every route, the grader and the teacher's console
 * resolve a task through these, so one key gets one answer everywhere.
 */

/**
 * The task a stored revision is graded as.
 *
 * **"The phase's only task", never `SOLE_TASK_KEY`.** A phase holding one task
 * has one owner for its history whatever key the row carries, and the key a row
 * carries is not yet an answer: `submissions.taskKey` is the column's default
 * `''` until the per-task submit path names it, while every phase of every
 * teacher-authored project is keyed `main`. Resolving by key alone would find
 * nothing for those phases and grade nothing; defaulting the key to
 * `SOLE_TASK_KEY` would do the same. `SOLE_TASK_KEY` is a *compiled* key, not a
 * default a reader may assume.
 *
 * The `find` arm answers a phase that holds two or more tasks; the first arm
 * answers every one-task phase. An `undefined` means no task of the list
 * carries the key, never a licence to grade a revision against a task it
 * does not name.
 */
export function taskForRevision(
  tasks: readonly CompiledTask[],
  taskKey: string,
): CompiledTask | undefined {
  // The phase-level route's question, never `soleTaskList` and never `SOLE_TASK_KEY`.
  if (tasks.length === 1) return tasks[0]; // the phase's only task
  return tasks.find((task) => task.taskKey === taskKey);
}

/* ------------------- the two refusals a task key can earn ----------------- */

/**
 * A key the pinned version does not declare, in `getPhase`'s own register.
 *
 * 404 rather than 400: the learner asked for something that is not there, and
 * on a version they are pinned to it may once have been. Never a licence to
 * fall back to another task: grading a revision against work it does not name
 * is the failure the whole task grain exists to prevent.
 */
export function unknownTask(taskKey: string): NotFoundException {
  return new NotFoundException(`unknown task: ${taskKey}`);
}

/**
 * A phase-level request against a phase that holds more than one task.
 *
 * The three kept routes resolve **the phase's only task**, and where there is
 * no only task they refuse by name rather than picking one: picking one is how
 * a learner's work goes to the wrong grader, and a wrong grader is a wrong
 * score on somebody's record. A learner's browser never reaches this: the web
 * sends the key, but a journey script or a tab left open across a publish
 * does.
 */
export function multiTaskRefusal(tasks: readonly CompiledTask[]): BadRequestException {
  const keys = tasks.map((task) => task.taskKey).join(', ');
  return new BadRequestException(
    `This phase has ${tasks.length} tasks. Submit one of them: ${keys}.`,
  );
}

/**
 * Which task a **request** is about.
 *
 * `SOLE_TASK_KEY` is a key the *compiler* mints, not a default a route may
 * assume: `soleTaskList` is false for a one-task phase keyed `main`, which is
 * every phase of every teacher-authored project, so a default of `''` would
 * match nothing and refuse work the product serves. The phase-level route's
 * question is *the phase's only task*; the per-task route's is *this key*.
 *
 * It is the one answer for every route that asks: submit and the revision
 * list in `phases.controller.ts`, the answer door in `solution.service.ts`,
 * the quiz routes and `FeedbackService.submit`. Two copies would give two
 * different refusals for one fact (*"unknown task"* on one route, *"unknown
 * task: key"* on another, about the same key on the same phase).
 */
export function taskForRequest(
  tasks: readonly CompiledTask[],
  taskKey?: string,
): CompiledTask {
  const task =
    taskKey === undefined
      ? tasks.length === 1 // the kept route: the phase's only task, never SOLE_TASK_KEY
        ? tasks[0]
        : undefined
      : tasks.find((entry) => entry.taskKey === taskKey);
  if (!task) throw taskKey === undefined ? multiTaskRefusal(tasks) : unknownTask(taskKey);
  return task;
}

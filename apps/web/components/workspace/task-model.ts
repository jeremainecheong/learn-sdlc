/**
 * The tasks of a phase as the rooms agree about them: which task is selected,
 * where its work lives, which task a submit names, and the counts a room's
 * header and the dashboard say. Pure functions of the phase's task rows, so
 * every room asks here and holds no copy of the reasoning; `TaskPanel.tsx`
 * draws the panel from them and re-exports them.
 */

import type {
  PhaseKey,
  PhaseStatus,
  PhaseSummary,
  PhaseTaskCounts,
  PhaseTaskView,
} from '@learnsdlc/shared';
import { PHASE_ROOM_ARTEFACT, quizHref, roomHref } from '@/components/shell/routes';

/** Has a teacher split this phase? The row, the key and the panel turn on it. */
export function isSplit(tasks: PhaseTaskView[] | undefined): boolean {
  return (tasks?.length ?? 0) > 1;
}

/**
 * The phase's tasks that are pieces of work: everything but the quizzes.
 *
 * A quiz owns no editable path, opens no file and is handed in as a paper from
 * its own room, so it is a row in the list and never the thing the IDE is
 * looking at.
 */
export function workTasks(tasks: PhaseTaskView[] | undefined): PhaseTaskView[] {
  return (tasks ?? []).filter((task) => task.artefactType !== 'quiz');
}

/**
 * Has a teacher split this phase's **work**?
 *
 * `isSplit` and this are two questions and the difference is the whole point.
 * Three IDE behaviours ask *has the work been split*, the room's memory key
 * ({@link viewKeyFor}), the file it opens on and the tab strip it seeds, and
 * the honest answer for a phase whose only extra task is a quiz is **no**:
 * `viewKeyFor`'s own docstring says a key that changed shape would silently
 * reset every learner's open file, caret, scroll, panel and folded folders,
 * and a quiz beside a code task must not do that to a cohort mid-phase.
 *
 * Four behaviours keep `isSplit`, because they are about the **row** and the
 * **key**, which a quiz really does add: the panel itself, the per-task
 * in-flight submission key, the task count line and {@link taskKeyToSend}.
 */
export function isWorkSplit(tasks: PhaseTaskView[] | undefined): boolean {
  return workTasks(tasks).length > 1;
}

/** The phase's tasks in the order the teacher wrote them. */
export function ordered(tasks: PhaseTaskView[]): PhaseTaskView[] {
  return [...tasks].sort((a, b) => a.order - b.order);
}

/**
 * The task a room is working in.
 *
 * `chosen` is whatever the learner last picked. A key the pinned version no
 * longer declares, a stale tab, a link from before a teacher re-cut the
 * phase, falls back to the task the panel itself opens on, so the panel and
 * the room can never be looking at two different pieces of work.
 */
export function chooseTask(
  tasks: PhaseTaskView[] | undefined,
  chosen: string | null | undefined,
): PhaseTaskView | undefined {
  if (!tasks?.length) return undefined;
  const list = ordered(tasks);
  const named = chosen ? list.find((task) => task.key === chosen) : undefined;
  if (named) return named;
  // Where the work is: the first required task still to pass, then the first
  // task still to pass, then the first task there is.
  const landing =
    list.find((task) => task.required && task.status !== 'passed') ??
    list.find((task) => task.status !== 'passed') ??
    list[0];
  // A task that passed its review and waits on the teacher's
  // countersignature has nothing left to do. Where that is the landing, a
  // piece of work still to pass that is not waiting comes first (a required
  // one, then any); a phase where every open task waits keeps the landing
  // above. A quiz is never that piece of work: it is handed in from its own
  // room, and a room's submit must not name it in place of the waiting task.
  if (!waits(landing)) return landing;
  const openWork = (task: PhaseTaskView) => task.status !== 'passed' && !waits(task) && task.artefactType !== 'quiz';
  return list.find((task) => task.required && openWork(task)) ?? list.find(openWork) ?? landing;
}

/** A task that passed its review and waits on the teacher's countersignature. */
function waits(task: PhaseTaskView): boolean {
  return task.status === 'submitted' && task.awaitingSignOff === true;
}

/**
 * The key a room's request names, or nothing at all.
 *
 * Two routes have a per-task twin, the submit and the answer door, and both
 * ask the same question. A phase with one task calls the phase route, which
 * resolves *the phase's only task* itself: never the empty key, which is a key
 * the compiler mints for a project that declares no tasks and is not a default
 * a client may assume. More than one task and the room has to say which,
 * because picking one for the learner is how their work goes to the wrong
 * grader and how they are shown the wrong answer.
 */
export function taskKeyToSend(
  tasks: PhaseTaskView[] | undefined,
  chosen: string | null | undefined,
): string | undefined {
  if (!isSplit(tasks)) return undefined;
  return chooseTask(tasks, chosen)?.key;
}

/**
 * The arguments a room's submit is called with.
 *
 * A phase with one task is submitted with the plain arity,
 * `api.submit(phaseId)` or `api.submit(phaseId, message)`, and not with a
 * trailing `undefined`, because that is the call the phase route expects and
 * what every room's own test records. A trailing
 * argument nobody meant is a difference a learner cannot see and a reviewer
 * has to explain.
 */
export type SubmitArgs = [phaseId: string, message?: string, taskKey?: string];

export function submitArgs(
  phaseId: string,
  message: string | undefined,
  tasks: PhaseTaskView[] | undefined,
  chosen: string | null | undefined,
): SubmitArgs {
  const key = taskKeyToSend(tasks, chosen);
  if (key !== undefined) return [phaseId, message, key];
  if (message !== undefined) return [phaseId, message];
  return [phaseId];
}

/** The files the phases' record rooms are built around (`PHASE_ROOM_ARTEFACT`). */
const RECORD_ROOM_PATHS: ReadonlySet<string> = new Set(
  Object.values(PHASE_ROOM_ARTEFACT).filter((path): path is string => Boolean(path)),
);

/**
 * The task a record room is working in, by the file that room writes.
 *
 * The backlog, the design board and the change request each own one record,
 * so the task is the one whose record that path is rather than whichever the
 * learner last clicked. Only a record room's file is asked about: no other
 * file is a task's own room, so any other path answers nothing and the phase
 * route decides.
 *
 * **The declared artefact path is the answer; ownership is only the fallback.**
 * A record task may carry no artefact path (a story task's record is read from
 * the phase's own file), so the task that owns the file answers where none
 * declares it. The declarer is asked for first, across the whole list, so a
 * task that merely owns the file never outranks the task the file **is**.
 */
export function taskForPath(
  tasks: PhaseTaskView[] | undefined,
  path: string | undefined,
): PhaseTaskView | undefined {
  if (!tasks?.length || !path || !RECORD_ROOM_PATHS.has(path)) return undefined;
  const list = ordered(tasks);
  return list.find((task) => task.artefactPath === path) ?? list.find((task) => task.files?.includes(path));
}

/**
 * The task the phase's own room is built around, where it has one.
 *
 * The same question the backlog, the design board and the change request each
 * ask about themselves, {@link taskForPath} over the artefact that room
 * writes, asked from outside the room, so a panel drawn anywhere can tell a
 * row that belongs to that room from a row that does not. The declarer rule is
 * `taskForPath`'s and is what makes the answer safe where a teacher has put the
 * room's file in a second task's `owns`.
 */
export function phaseRoomTaskKey(
  phaseKey: PhaseKey,
  tasks: PhaseTaskView[] | undefined,
): string | undefined {
  return taskForPath(tasks, PHASE_ROOM_ARTEFACT[phaseKey])?.key;
}

/**
 * Where a task is worked: the room a learner is taken to when they open its row.
 *
 * Three answers, in this order:
 *
 * - a **quiz** is answered as a paper in its own room, `?task=` and all;
 * - a phase with **no record room** (Implementation, Testing) is worked in
 *   the workspace, focused by `?task=`, which is the room the IDE draws for
 *   whichever task is selected;
 * - every other task of a phase with a record room opens that room: the
 *   backlog, the design board, the Runbook tab, the change request. No task
 *   is written anywhere else, so no row opens a written task's own editor.
 *
 * Requirements' own room is `/issue` rather than `roomHref`'s `/interview`:
 * both mount the same component and the story is written in the backlog, so
 * the row opens the pane the work is in.
 */
export function taskRoomHref(
  phase: Pick<PhaseSummary, 'id' | 'key' | 'status'>,
  tasks: PhaseTaskView[] | undefined,
  task: PhaseTaskView,
): string {
  if (phase.status === 'locked') return '/phases';
  if (task.artefactType === 'quiz') return quizHref(phase, task.key);
  if (PHASE_ROOM_ARTEFACT[phase.key] === undefined) {
    return `/workspace/${phase.id}?task=${encodeURIComponent(task.key)}`;
  }
  return phase.key === 'requirements' ? `/workspace/${phase.id}/issue` : roomHref(phase);
}

/**
 * The one piece of work a split phase holds, where it holds exactly one.
 *
 * Four rooms read every revision of the phase they are in, the journal's
 * records, the kill matrix, the pull request, the design board's receipt
 * recovery, and the phase-wide route is refused on a split phase,
 * which is what a teacher adding a quiz to Implementation or Testing makes.
 * The key here is the one that route would have resolved to: a phase whose only
 * extra task is a quiz has exactly one piece of work, and that work's revisions
 * are the ones those rooms are about. A phase with one task keeps the
 * phase-wide route, which is the route that resolves the task itself.
 */
export function soleWorkTaskKey(tasks: PhaseTaskView[] | undefined): string | undefined {
  if (!isSplit(tasks)) return undefined;
  const work = workTasks(tasks);
  return work.length === 1 ? work[0].key : undefined;
}

/**
 * The workspace paths a task owns, in the phase's own order.
 *
 * The tab strip seeds from these on a split phase: a task's siblings' files are
 * in the Explorer like everything else, but opening them for the learner would
 * say this is your work when it is not. A path the task claims and the phase
 * does not mount is dropped rather than opened as an empty editor.
 */
export function taskPaths(
  task: PhaseTaskView | undefined,
  files: readonly { path: string }[],
): string[] {
  const owned = task?.files;
  if (!owned?.length) return [];
  return files.map((file) => file.path).filter((path) => owned.includes(path));
}

/** Where a task opens: the file it is about, then the first one it owns. */
export function taskActivePath(
  task: PhaseTaskView | undefined,
  files: readonly { path: string }[],
): string {
  if (!task) return '';
  const has = (path?: string) => Boolean(path) && files.some((file) => file.path === path);
  if (has(task.primaryPath)) return task.primaryPath as string;
  if (has(task.artefactPath)) return task.artefactPath as string;
  return taskPaths(task, files)[0] ?? '';
}

/**
 * Where a room's memory of itself is kept: the open file, the caret, the scroll,
 * the panel, the folded folders.
 *
 * A phase with one task keeps the plain phase key, to the character. The
 * folded folders live in `localStorage`, so a key that changed shape for every
 * phase in the product would silently reset every learner's file tree.
 *
 * The question is {@link isWorkSplit}, not {@link isSplit}.
 * A quiz added beside a code task is a row in the panel and not a second file
 * tree, so the room this key is the memory of has not moved.
 */
export function viewKeyFor(
  phaseId: string,
  tasks: PhaseTaskView[] | undefined,
  chosen: string | null | undefined,
): string {
  if (!isWorkSplit(tasks)) return phaseId;
  const task = chooseTask(tasks, chosen);
  return task ? `${phaseId}:${task.key}` : phaseId;
}

/**
 * What lights the merge gate.
 *
 * Not the pull request's newest revision: on a split phase the newest revision
 * can be the **optional** task's, and an optional task moves no gate; so the
 * button would light, the learner would press it, and the advance would answer
 * that the phase had to pass first. A split phase reads its required set
 * instead; a phase with one task reads the verdict it just got back, because
 * one task is the phase.
 */
export function mergeGateMet(
  phase: {
    status: PhaseStatus;
    taskCounts?: PhaseTaskCounts;
    evidenceNeeded?: readonly unknown[];
    notReachedYet?: true;
  },
  verdict: boolean,
): boolean {
  // A phase passed ahead of the one the learner stands
  // on is one `advance` refuses until they reach it.
  if (phase.notReachedYet) return false;
  return reviewGateMet(phase, verdict);
}

/**
 * Whether the review this phase is gated on is in, the Pass the pull request
 * reports, whatever the learner's place in the project.
 *
 * {@link mergeGateMet} is this and one thing more: that the learner stands on
 * the phase. As one answer, a learner who earned their own reviewed pass on a
 * phase unlocked early would read "Needs revision" under a review that
 * passed. On an ahead phase the API names the gate's gaps too
 * (`evidenceNeeded` beside `notReachedYet`), so a teacher's board-only Pass
 * there is still not read as a review.
 */
export function reviewGateMet(
  phase: {
    status: PhaseStatus;
    taskCounts?: PhaseTaskCounts;
    evidenceNeeded?: readonly unknown[];
    /** Read by {@link mergeGateMet}, and deliberately not here. */
    notReachedYet?: true;
  },
  verdict: boolean,
): boolean {
  // A phase a teacher passed on the board, whose gate
  // still wants a reviewed pass of a named task, is not a phase Merge can
  // advance: the API refuses it. The banner above offers that task's door.
  if (phase.status === 'passed') return !phase.evidenceNeeded?.length;
  const counts = phase.taskCounts;
  if (counts && counts.total > 1 && counts.required > 0) {
    return counts.passedRequired === counts.required;
  }
  return verdict;
}

/**
 * How far a phase's tasks have got, in one line.
 *
 * One number where every task is required, and two separate ones where an
 * optional task exists: "1 of 2 required done. Optional: 1 of 1 done", so the
 * optional quiz's progress is never read as the required work's.
 */
export function taskCountLine(counts: PhaseTaskCounts | undefined): string {
  if (!counts || counts.total === 0) return '';
  if (counts.total === counts.required) return `${counts.passedRequired} of ${counts.required} required done`;
  // Required work and the optional tasks (a concept quiz) as two separate
  // facts: an optional task's progress never reads as the phase's.
  const optional = counts.total - counts.required;
  const optionalDone = Math.max(0, counts.passed - counts.passedRequired);
  return `${counts.passedRequired} of ${counts.required} required done. Optional: ${optionalDone} of ${optional} done`;
}

/**
 * What a phase's submission count is counting once it holds several tasks.
 *
 * A declared looseness of split phases, in words. `phase_states.attempts` stays
 * one incremental counter for the whole phase, a task's own tries are on its
 * own row, so on a split phase the number is a sum over the tasks and not a
 * revision number for any one of them. A tile that printed it without saying so
 * would read as the latter, which is the reason the sentence exists.
 */
export function taskAttemptsLine(attempts: number, tasks: number): string {
  return `${attempts} ${attempts === 1 ? 'submission' : 'submissions'} across ${tasks} tasks`;
}

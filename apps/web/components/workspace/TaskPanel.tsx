'use client';

/**
 * The tasks of a phase, as a learner's rooms read them.
 *
 * Every phase holds one piece of its own work, and a teacher may add concept
 * quizzes beside it, and five rooms have to
 * agree about the same three questions: which task is selected, where its work
 * lives, and which task a submit names. They agree by asking here. Two rooms
 * answering "which task is this" differently is how a learner's work goes to
 * the wrong grader, so the answers are one exported function each and the rooms
 * hold no copy of the reasoning.
 *
 * **A phase with one task draws nothing.** Every project is a project of
 * one-task phases until a teacher splits one, and a chooser with one answer is
 * a question with one answer. It also means a project nobody has split draws
 * no task panel anywhere.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type {
  PhaseEvidenceGap,
  PhaseSummary,
  PhaseTaskCounts,
  PhaseTaskView,
  SubmissionView,
} from '@learnsdlc/shared';
import { Chip } from '@/components/ui';
import { STATE_LABEL, creditedTaskKeys } from './gate-state';
import { chooseTask, isSplit, ordered, taskCountLine, taskRoomHref } from './task-model';

export {
  isSplit,
  workTasks,
  isWorkSplit,
  chooseTask,
  taskKeyToSend,
  submitArgs,
  taskForPath,
  phaseRoomTaskKey,
  taskRoomHref,
  soleWorkTaskKey,
  taskPaths,
  taskActivePath,
  viewKeyFor,
  mergeGateMet,
  reviewGateMet,
  taskCountLine,
  taskAttemptsLine,
  type SubmitArgs,
} from './task-model';

/**
 * The word for where a task stands, in the phase list's own vocabulary.
 *
 * The last arm is not "In progress" for everything that is not passed,
 * submitted or locked: that would make a task nobody has opened and a task
 * whose last revision was refused read the same, and neither would match
 * what the rest of the product says about those two states. This is one state
 * word a learner reads per task, and the panel is their primary read of how
 * each sibling stands, so it uses the product's own words: **Ready to
 * start** where nothing has been handed in, **Needs revision** where something
 * has and the task is still open.
 *
 * **`submitted` is not "In review".** A task row reads `submitted` only
 * after a verdict has landed on it without a pass, `taskRollup` writes
 * `nextPhaseStatus(held, false)`, and handing a revision in moves no task row
 * at all. So a `submitted` row has been marked, and did not pass: **Needs
 * revision** for written work, **Not passed** for a quiz's paper, the words the
 * teacher's console uses for the same row. "In review" is kept for the one
 * state it is true of, and that is read off the revision rather than the row:
 * the phase's newest revision (`PhaseDetail.lastSubmission`), where the room
 * holds one, names its task and whether it is still queued or running. A
 * passed task stays Passed while a later revision of it is marked, the pass
 * is sticky, and a countersignature still leads, because the verdict is in
 * and what it waits on is a teacher.
 */
function statusWord(
  task: PhaseTaskView,
  newest?: NewestRevision | null,
  following?: ReadonlySet<string>,
  credited?: ReadonlySet<string>,
  phasePassed = false,
): string {
  if (task.awaitingSignOff) return STATE_LABEL.awaiting;
  const marking =
    (!!newest && newest.taskKey === task.key && (newest.status === 'queued' || newest.status === 'running')) ||
    !!following?.has(task.key);
  switch (task.status) {
    case 'passed':
      // Credit on the board is not a reviewed pass: the gate's own
      // `evidenceNeeded` names it, the same source the gate band reads.
      if (credited?.has(task.key)) return STATE_LABEL.credited;
      // And the gate answers only for a passed phase. Inside a split phase
      // still in progress a task row can be passed by the teacher's per-task
      // sign-off with no review behind it, and nothing on the payload tells
      // that from a reviewed pass, so the row keeps the neutral "Passed".
      if (!phasePassed) return 'Passed';
      return task.artefactType === 'quiz' ? 'Passed' : STATE_LABEL.reviewPassed;
    case 'submitted':
      if (marking) return 'In review';
      return task.artefactType === 'quiz' ? 'Not passed' : 'Needs revision';
    case 'locked':
      return 'Locked';
    default:
      if (marking) return 'In review';
      return task.attempts > 0 ? 'Needs revision' : 'Ready to start';
  }
}

/**
 * The phase's newest revision, as much of it as a task row needs: whose it is
 * and whether it is still being marked. `PhaseDetail.lastSubmission` is this
 * shape already, so a room that hands the panel its phase detail hands it this.
 */
export type NewestRevision = Pick<SubmissionView, 'status' | 'taskKey'>;

function attemptsWord(attempts: number): string {
  return attempts === 1 ? '1 attempt' : `${attempts} attempts`;
}

export interface TaskPanelProps {
  tasks: PhaseTaskView[] | undefined;
  /**
   * The phase this panel is drawn in, so every row can name the room its task
   * is worked in.
   *
   * Optional: a room that is not given one draws every row as a plain
   * statement rather than a link to nowhere.
   *
   * `lastSubmission` is the phase's newest revision, where the room holds it:
   * the one fact on the payload that says a task is being marked, so
   * a row says "In review" only while it is. A room that passes its
   * `PhaseDetail` passes it; one that passes nothing says what the rows say.
   */
  phase?: Pick<PhaseSummary, 'id' | 'key' | 'status'> & {
    lastSubmission?: NewestRevision | null;
    /** The gate's answer: a passed task it names is credited, not reviewed. */
    evidenceNeeded?: PhaseEvidenceGap[];
  };
  /**
   * The tasks whose revision the room itself is following while it is marked.
   * A split phase may have two revisions being marked
   * at once, one per task, and the phase's newest revision names only one of
   * them, so a room that handed both in says so of both. Absent, the rows read
   * off `phase.lastSubmission` alone. A room opened fresh onto two
   * revisions it did not start knows only the newest: the payload carries no
   * per-task status (a known limit).
   */
  marking?: ReadonlySet<string>;
  /** Whatever the learner last picked, which may be nothing and may be stale. */
  selected: string | null;
  /**
   * How the room changes task, where it can.
   *
   * The IDE, the answer door and the pull request can: one opens any file of
   * the phase and the other two read any task's answer or verdict. A room built
   * around one artefact, the backlog, the design board, the change request,
   * cannot, because the task there is whichever owns that file; those rooms
   * pass nothing and every row that is not theirs is a **link to the room that
   * task is worked in** ({@link taskRoomHref}): a concept quiz's paper, or the
   * phase's own room.
   */
  onSelect?: (key: string) => void;
  /**
   * The path this panel is drawn on, where the room only takes the tasks whose
   * room it is.
   *
   * The workspace passes `/workspace/:id`: it holds any task whose work is
   * files, and re-keys in place for those, but a task belonging to the backlog
   * or the design board is a door out of it. A room that takes **every** task
   * in place, the answer door, the pull request, which draw a record rather
   * than a workspace, passes nothing and keeps its controls.
   */
  roomPath?: string;
  /**
   * What the room settles before the learner is taken out of it.
   *
   * A room with an editable buffer flushes it on the way out, exactly as it
   * does before Continue: the click is held, the save is awaited, and only then
   * is the push made. A refused flush leaves the learner where they are with
   * the reason under the list, because a door that swallowed it would lose
   * their words.
   */
  onLeave?: () => Promise<void>;
  /** The phase's own totals, where the room has them. */
  counts?: PhaseTaskCounts;
  /**
   * One row, expandable: the rooms whose work is a single board (the
   * backlog, the design board) give the height to the work. The row says
   * which task this room is, where it stands and the phase's totals; one press
   * on it opens the full list, with every row and door.
   */
  compact?: boolean;
  className?: string;
}

/**
 * A row that leads out of this room, with the room's buffer flushed first.
 *
 * `href` stays on the anchor, so it is a real link: ⌘-click, middle click and
 * Open in new tab are the browser's, and the guard below copies the room's own
 * rule for which clicks it is allowed to intercept. It is a component of its
 * own because `useRouter` throws where no router is mounted, and every room
 * that asks for a flush has one.
 */
/** What the room is doing while a door is held open. */
const SAVING_LINE = 'Saving your work…';

/** What the list under the rows is saying, and whether it is a refusal. */
interface LeaveNote {
  text: string;
  failed: boolean;
}
const NO_NOTE: LeaveNote = { text: '', failed: false };

function LeavingRow({
  href,
  onLeave,
  onNote,
  children,
  ...rest
}: {
  href: string;
  onLeave: () => Promise<void>;
  onNote: (note: LeaveNote) => void;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-current'?: 'true' | undefined;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const leave = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (leaving) return;
    setLeaving(true);
    // Said while it happens, not only when it fails. On a slow connection the
    // held click would look exactly like a dead link (the URL does not move,
    // the row does not change, and a second click is swallowed by the guard above),
    // so the row says it is busy and the region below says what for.
    onNote({ text: SAVING_LINE, failed: false });
    void onLeave().then(
      () => {
        setLeaving(false);
        onNote(NO_NOTE);
        router.push(href);
      },
      (err: unknown) => {
        setLeaving(false);
        onNote({
          text: err instanceof Error ? err.message : 'This could not be saved, so nothing was opened.',
          failed: true,
        });
      },
    );
  };
  return (
    <Link href={href} onClick={leave} aria-busy={leaving ? 'true' : undefined} {...rest}>
      {children}
    </Link>
  );
}

/**
 * The switcher, and nothing at all on a phase with one task.
 *
 * Each row carries what a learner needs to choose between two pieces of work:
 * where it sits in the order, what it is called, whether it gates the phase,
 * where it stands, how many tries it has had and what it scored.
 *
 * **A row is a link where its task is worked somewhere else.** Selecting a
 * task re-keys the room the panel is drawn in, and a
 * room can only re-key for a task it can draw: a quiz is answered as a paper in
 * a room of its own, an authored story is written in the workspace, and the
 * phase's own artefact belongs to the room built around it. So the panel is the
 * router, the one place that knows a task's `artefactType` picks a room, and
 * every row leads to the room its task is worked in.
 */
export function TaskPanel({
  tasks,
  phase,
  marking,
  selected,
  onSelect,
  roomPath,
  onLeave,
  counts,
  compact = false,
  className = '',
}: TaskPanelProps) {
  const [leaveNote, setLeaveNote] = useState<LeaveNote>(NO_NOTE);
  if (!isSplit(tasks)) return null;
  const list = ordered(tasks as PhaseTaskView[]);
  const current = chooseTask(list, selected);
  const line = taskCountLine(counts);
  const credited = phase ? creditedTaskKeys(phase.id, phase) : new Set<string>();
  const wordFor = (task: PhaseTaskView) => statusWord(task, phase?.lastSubmission, marking, credited, phase?.status === 'passed');
  const toneFor = (task: PhaseTaskView) =>
    task.status === 'passed' && credited.has(task.key) ? 'warn' : task.status === 'passed' ? 'pass' : 'neutral';
  const row = 'flex w-full min-w-0 flex-wrap items-center gap-2 rounded-ctl border-1.5 border-edge px-2.5 py-2 text-left aria-[current=true]:border-accent aria-[current=true]:bg-tint';
  const counted = line && (
    <span className="label-sm" data-testid="task-counts">
      {line}
    </span>
  );
  const rows = (
      <ul className="flex min-w-0 flex-col gap-1.5">
        {list.map((task) => {
          const isCredited = task.status === 'passed' && credited.has(task.key);
          const face = (
            <>
              <span className="font-mono text-[12px] text-muted">{String(task.order).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{task.title}</span>
              <Chip tone={task.required ? 'accent' : 'outline'}>{task.required ? 'Required' : 'Optional'}</Chip>
              <Chip tone={toneFor(task)}>{wordFor(task)}</Chip>
              <span className="label-sm">{attemptsWord(task.attempts)}</span>
              {/* A written task's score before it passes is the rules' score,
                  not a verdict, and "Best 100" beside "Needs revision" would
                  read as a pass. It is shown once the task has
                  passed; a quiz's is its best paper's mark, and always shown. */}
              {/* Nor beside a credited task: its score was never a reviewed pass. */}
              {task.bestScore !== null && !isCredited && (task.status === 'passed' || task.artefactType === 'quiz') && (
                <span className="label-sm">Best {Math.round(task.bestScore)}</span>
              )}
            </>
          );
          const here = current?.key === task.key ? 'true' : undefined;
          // Where this task is worked, asked of the task rather than of the
          // room. A room that takes every task in place (the answer door, the
          // pull request) names no path and keeps its controls; the workspace
          // names its own, so a task that belongs to the backlog or the design
          // board is a door out of it rather than a re-key it cannot honour.
          const isQuiz = task.artefactType === 'quiz';
          const to = phase && (isQuiz || !here) ? taskRoomHref(phase, list, task) : null;
          // A quiz is a link even where it is the open row, as it has been
          // since quizzes landed: no room but the quiz room draws a paper, so
          // there is no control any other room could offer for it.
          const elsewhere =
            to && (isQuiz || !onSelect || (roomPath !== undefined && to.split('?')[0] !== roomPath));
          return (
            <li key={task.key} className="min-w-0">
              {elsewhere && to ? (
                onLeave ? (
                  <LeavingRow
                    href={to}
                    onLeave={onLeave}
                    onNote={setLeaveNote}
                    className={`${row} transition-colors hover:border-edge2`}
                    data-testid={`task-open-${task.key}`}
                    aria-current={here}
                  >
                    {face}
                  </LeavingRow>
                ) : (
                  <Link
                    href={to}
                    className={`${row} transition-colors hover:border-edge2`}
                    data-testid={`task-open-${task.key}`}
                    aria-current={here}
                  >
                    {face}
                  </Link>
                )
              ) : onSelect ? (
                <button
                  type="button"
                  className={`${row} transition-colors hover:border-edge2`}
                  data-testid={`task-choose-${task.key}`}
                  aria-current={here}
                  onClick={() => onSelect(task.key)}
                >
                  {face}
                </button>
              ) : (
                <div className={row} data-testid={`task-row-${task.key}`} aria-current={here}>
                  {face}
                </div>
              )}
            </li>
          );
        })}
      </ul>
  );
  /* A declared limit of split phases, said where it bites: the mentor's
     budget is counted on the phase, so moving between tasks does not buy
     another allowance. */
  const budget = <p className="label-sm">Questions are counted for the whole phase, not for each task.</p>;
  /* What a door is waiting for, and why one did not open: the room settles
     its buffer before it lets the learner leave, and this is where it says
     both. The region is always drawn (outside the folded list too) so the
     message is announced when it arrives rather than when a new element
     appears, and it is only red when it is a refusal. */
  const note = (extra = '') => (
    <p className={`label-sm ${leaveNote.failed ? 'text-fail' : ''} ${extra}`.trim()} role="status" data-testid="task-leave-error">
      {leaveNote.text}
    </p>
  );
  if (compact) {
    return (
      <section
        className={`task-switcher-compact flex min-w-0 flex-col rounded-panel border-1.5 border-edge bg-surface ${className}`.trim()}
        data-testid="task-switcher"
        data-compact="true"
        aria-label="Tasks in this phase"
      >
        <details className="min-w-0" data-testid="task-switcher-details">
          <summary
            className="flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5"
            data-testid="task-switcher-toggle"
          >
            <strong className="text-[13.5px] font-semibold text-ink">Tasks in this phase</strong>
            {current && (
              <span className="task-switcher-current flex min-w-0 items-center gap-2" data-testid="task-switcher-current">
                <span className="task-switcher-title min-w-0 truncate text-[13px] font-medium text-ink">{current.title}</span>
                <Chip tone={toneFor(current)} className="task-switcher-chip">{wordFor(current)}</Chip>
              </span>
            )}
            <span className="ml-auto flex items-center gap-2">
              {counted}
              <ChevronDown size={14} aria-hidden="true" className="task-switcher-chevron text-muted" />
            </span>
          </summary>
          <div className="flex min-w-0 flex-col gap-2 px-3 pb-3 pt-1">
            {rows}
            {budget}
          </div>
        </details>
        {/* The one live region, the same node whether it is speaking or not. */}
        {note(leaveNote.text ? 'px-3 pb-2' : 'sr-only')}
      </section>
    );
  }
  return (
    <section
      className={`flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3 ${className}`.trim()}
      data-testid="task-switcher"
      aria-label="Tasks in this phase"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <strong className="text-[13.5px] font-semibold text-ink">Tasks in this phase</strong>
        {counted}
      </header>
      {rows}
      {/* What a door is waiting for, and why one did not open: the room settles
          its buffer before it lets the learner leave, and this is where it says
          both. The region is always drawn so the message is announced when it
          arrives rather than when a new element appears, and it is only red
          when it is a refusal. */}
      {note()}
      {budget}
    </section>
  );
}

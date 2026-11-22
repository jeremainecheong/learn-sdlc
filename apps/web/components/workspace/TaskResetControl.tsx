'use client';

/**
 * "Start this task over".
 *
 * A learner on a teacher's project can put one task of theirs back to where it
 * started. The control is drawn only where the API would let it go ahead:
 * on an authored task list (never a TaskTrackr phase, whose single
 * task is the whole phase and is reset by the instructor), never on a quiz
 * (its reset count is its attempt epoch), never on a task that has passed and
 * never on one a teacher is reviewing. The API refuses all of these anyway;
 * a button that could only ever be refused is not drawn.
 *
 * **The confirm is the API's own plan.** Before anything is pressed the dialog
 * reads `GET …/reset` and names exactly what the reset would do: the files put
 * back to the starter, the files seeded again, the files a passed sibling task
 * keeps (and which task keeps each), and, phase-wide, because an Agentic
 * approval is bound to every editable file of the phase, that a proposal not
 * yet applied is dropped. A plan that carries a refusal shows that one
 * sentence and offers nothing to press.
 *
 * **On a passed task it is a retry** (`TaskRetry.tsx`): "Retry this task", or
 * "Retry this phase" on a TaskTrackr phase, the same plan and confirm in the
 * retry's words, with the API's own sentence on what the retry keeps.
 *
 * **The room settles first.** `prepare` is the room's own flush: whatever is
 * typed is saved (or the reset does not start), so the version the reset
 * quotes is the one the tab really holds. On success the room replaces its
 * buffer, adopts the returned version and drops its local draft, which
 * is `onReset`'s job; a stale version is the save's own 409, handed to the
 * room's conflict handling with nothing written.
 */

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PhaseTaskView, TaskResetPlanView, TaskResetResult } from '@learnsdlc/shared';
import { ApiError, describeError } from '@/lib/api';
import { taskResetApi } from '@/lib/api-task-reset';
import { useViewAs } from '@/lib/view-as';
import { Button } from '@/components/ui';
import {
  RETRY_BUSY,
  RETRY_CHECKING,
  RETRY_CONFIRM,
  RETRY_FAILED,
  RETRY_PLAN_FAILED,
  RetryKeeps,
  retryDone,
  retryHistory,
  retryLabel,
  retryOffered,
  soleList,
} from './TaskRetry';

/** What Tab may land on inside the dialog. */
const FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export const RESET_LABEL = 'Start this task over';
/** The sentence for what a reset never touches. */
export const RESET_KEEPS =
  'Work you have never run or submitted is replaced. Everything you submitted is kept, and your attempt count does not change.';
/** The approval covers every editable file of the phase, so this is phase-wide. */
export const RESET_DROPS_PROPOSAL =
  'A change the assistant proposed on this phase that you have not applied yet is dropped, whichever task it was for.';
export const RESET_DONE = 'This task was started over. Your submissions and attempts are as they were.';
export const RESET_STALE =
  'Nothing was reset: this workspace was saved somewhere else after you opened it. The room now shows that copy; review it before starting over.';

/**
 * Is this a task the learner may start over? The same facts the API refuses
 * on, read off the task view the room holds.
 *
 * A sole-task list is TaskTrackr's shape: one task whose key is the empty key
 * the compiler mints for a project that declares none. A teacher's phase with
 * one inherited `main` task is an authored list, and its phase room offers the
 * reset.
 */
export function resetOffered(
  tasks: readonly PhaseTaskView[] | undefined,
  task: PhaseTaskView | undefined,
  phaseStatus?: string,
): boolean {
  if (!task || !tasks?.length) return false;
  if (tasks.length === 1 && tasks[0].key === '') return false;
  if (!tasks.some((one) => one.key === task.key)) return false;
  if (phaseStatus === 'locked') return false;
  if (task.artefactType === 'quiz') return false;
  if (task.status === 'passed' || task.status === 'locked') return false;
  if (task.awaitingSignOff) return false;
  return true;
}

export interface TaskResetControlProps {
  phaseId: string;
  tasks: readonly PhaseTaskView[] | undefined;
  /** The task this room is working in. */
  task: PhaseTaskView | undefined;
  phaseStatus?: string;
  /** The room's flush: rejects (with a sentence) when the buffer could not be saved. */
  prepare: () => Promise<void>;
  /** The workspace version the tab holds, read after `prepare` has settled. */
  baseVersion: () => string | null;
  /** Replace the buffer, adopt `result.version`, drop the local draft, refresh the task view. */
  onReset: (result: TaskResetResult, plan: TaskResetPlanView) => Promise<void> | void;
  /** The reset met a newer save: nothing was written, and the room loads that copy. */
  onConflict: (body: { version?: string; files?: Record<string, string> }) => Promise<void> | void;
  className?: string;
}

type Phase =
  | { at: 'closed' }
  | { at: 'loading' }
  | { at: 'plan'; plan: TaskResetPlanView; error: string; busy: boolean }
  | { at: 'failed'; error: string };

function PathList({ label, paths, testId }: { label: string; paths: readonly string[]; testId: string }) {
  if (!paths.length) return null;
  return (
    <div className="mt-3" data-testid={testId}>
      <p className="text-[13px] font-semibold text-ink">{label}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {paths.map((path) => (
          <li key={path} className="wrap font-mono text-[12.5px] text-ink">
            {path}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The short form of the history line, for the room's header. */
export const RETRY_NOTE = 'Passed before, new attempt';
/** The short form of a start-over's own status. */
export const RESET_NOTE = 'Task started over';
/** The short form of a start-over that met a newer save. */
export const RESET_STALE_NOTE = 'Nothing was reset';

/**
 * The one-line form of what this control last said, or of the history line,
 * for a place that stays in view while the control sits in a closed menu: the
 * work room's header row (PhaseHeader). Null when there is nothing to say.
 */
export function resetNote(said: string, history: string | null): string | null {
  if (said === RESET_DONE) return RESET_NOTE;
  if (said === RESET_STALE) return RESET_STALE_NOTE;
  if (said || history) return RETRY_NOTE;
  return null;
}

/**
 * Where the header listens for that short form: PhaseHeader provides it around
 * its More menu, where the rooms put this control. Outside a header nothing
 * listens and nothing changes.
 */
export const ResetNoteContext = createContext<((note: string | null) => void) | null>(null);

/**
 * Nothing at all where the reset is not offered: no hook runs, so a room that
 * draws this on a TaskTrackr phase draws nothing extra.
 */
export function TaskResetControl(props: TaskResetControlProps) {
  // Read as state, so starting or stopping a view-as session redraws the room.
  const viewing = useViewAs();
  // What the last retry said, kept here: a TaskTrackr phase back in progress
  // offers no start-over, and the control below goes, but the room still says
  // what happened.
  const [retried, setRetried] = useState('');
  // What the control last said (a start-over, a retry, a stale save), for the header's short form.
  const [said, setSaid] = useState('');
  // Passed before and being retried: said from the task view, so a reload
  // keeps it, beside the control or, on TaskTrackr, where the control was.
  const earlier = retryHistory(props.task);
  // The control lives in the header's More menu, closed most of the time, so
  // the header row keeps a short form of its status and history in view.
  // One line, from the same facts; the full sentences stay here.
  const note = viewing ? null : resetNote(said || retried, earlier);
  const tell = useContext(ResetNoteContext);
  useEffect(() => {
    tell?.(note);
  }, [tell, note]);
  useEffect(() => () => tell?.(null), [tell]);
  if (viewing) return null;
  const retry = retryOffered(props.tasks, props.task, props.phaseStatus);
  const history = earlier ? (
    <p className={`label-sm ${props.className ?? ''}`.trim()} data-testid="task-retry-history">
      {earlier}
    </p>
  ) : null;
  if (!retry && !resetOffered(props.tasks, props.task, props.phaseStatus)) {
    if (!retried && !history) return null;
    return (
      <>
        {retried && <LateStatus className={`label-sm ${props.className ?? ''}`.trim()} text={retried} />}
        {history}
      </>
    );
  }
  return (
    <>
      <ResetControl {...props} retry={retry} onRetried={setRetried} onSaid={setSaid} />
      {history}
    </>
  );
}

/** How long the status region stands empty before its words arrive. */
export const LATE_STATUS_MS = 100;

/**
 * The status that stays once the control has gone (a TaskTrackr phase back in
 * progress after its retry). The control's own status held the words, but this
 * region is new, and a live region that mounts already filled is not announced
 * by some screen readers; so it mounts empty and takes its words a moment
 * later.
 */
function LateStatus({ text, className }: { text: string; className: string }) {
  const [shown, setShown] = useState('');
  const own = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(text), LATE_STATUS_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  // The retry's confirm hands focus back to the button that opened it, and on a TaskTrackr phase that
  // button goes as the phase turns back to in progress, so focus fell to the page's body. Where it has (nothing else
  // holds it), it comes to this sentence, which says what the retry did; focus somewhere else is left where it is.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) own.current?.focus({ preventScroll: true });
  }, []);
  return (
    <p ref={own} tabIndex={-1} className={className} role="status" data-testid="task-reset-status">
      {shown}
    </p>
  );
}

function ResetControl({
  phaseId,
  tasks,
  task,
  prepare,
  baseVersion,
  onReset,
  onConflict,
  className = '',
  retry,
  onRetried,
  onSaid,
}: TaskResetControlProps & { retry: boolean; onRetried: (sentence: string) => void; onSaid?: (sentence: string) => void }) {
  const [state, setState] = useState<Phase>({ at: 'closed' });
  const [said, setSaid] = useState('');
  useEffect(() => {
    onSaid?.(said);
  }, [said, onSaid]);
  const label = retry ? retryLabel(tasks) : RESET_LABEL;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const open = state.at !== 'closed';
  const taskKey = task?.key;
  const alive = useRef(true);
  /** Which question is current: closing the dialog (or a moved task) retires a plan still on its way. */
  const asking = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A moved task (another tab's reset, a pass landing) closes the question.
  useEffect(() => {
    asking.current += 1;
    setState({ at: 'closed' });
  }, [taskKey]);

  useEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof node.showModal === 'function' && !node.open) {
      try {
        node.showModal();
      } catch {
        node.setAttribute('open', '');
      }
    } else if (!node.open) node.setAttribute('open', '');
    node.focus({ preventScroll: true });
    return () => {
      if (typeof node.close === 'function' && node.open) node.close();
      else node.removeAttribute('open');
      const back = trigger.current?.querySelector<HTMLElement>('button') ?? previous;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);

  const close = useCallback(() => {
    asking.current += 1;
    setState({ at: 'closed' });
  }, []);

  const ask = useCallback(async () => {
    // A TaskTrackr task's key is the empty key, which is still a key.
    if (taskKey === undefined) return;
    setSaid('');
    const question = (asking.current += 1);
    setState({ at: 'loading' });
    try {
      const plan = await taskResetApi.plan(phaseId, taskKey);
      if (!alive.current || asking.current !== question) return;
      setState({ at: 'plan', plan, error: '', busy: false });
    } catch (err) {
      if (!alive.current || asking.current !== question) return;
      setState({ at: 'failed', error: describeError(err, retry ? RETRY_PLAN_FAILED : 'What a reset would change could not be read. Nothing was reset.') });
    }
  }, [phaseId, taskKey, retry]);

  const confirm = useCallback(async () => {
    if (state.at !== 'plan' || state.busy || taskKey === undefined) return;
    const plan = state.plan;
    setState({ at: 'plan', plan, error: '', busy: true });
    try {
      await prepare();
    } catch (err) {
      if (!alive.current) return;
      setState({
        at: 'plan',
        plan,
        busy: false,
        error: `${describeError(err, 'Your work could not be saved first.')} Nothing was reset.`,
      });
      return;
    }
    try {
      const result = await taskResetApi.reset(phaseId, taskKey, baseVersion());
      if (!alive.current) return;
      await onReset(result, plan);
      if (!alive.current) return;
      setState({ at: 'closed' });
      if (plan.retry) {
        const done = retryDone(plan.retry.wholePhase || soleList(tasks));
        setSaid(done);
        onRetried(done);
      } else setSaid(RESET_DONE);
    } catch (err) {
      if (!alive.current) return;
      const body = err instanceof ApiError ? ((err.body ?? {}) as { error?: string; version?: string; files?: Record<string, string> }) : {};
      if (err instanceof ApiError && err.status === 409 && body.error === 'workspace_changed') {
        setState({ at: 'closed' });
        setSaid(RESET_STALE);
        await onConflict({ version: body.version, files: body.files });
        return;
      }
      setState({ at: 'plan', plan, busy: false, error: describeError(err, plan.retry ? RETRY_FAILED : 'The task could not be started over. Nothing was reset.') });
    }
  }, [state, taskKey, prepare, phaseId, baseVersion, onReset, onConflict, tasks, onRetried]);

  // The keyboard stays inside while the dialog is up: Tab from the
  // last control goes to the first and Shift+Tab from the first to the last.
  const holdTab = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return;
    const inside = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (!inside.length) {
      event.preventDefault();
      dialog.current?.focus();
      return;
    }
    const first = inside[0];
    const last = inside[inside.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const plan = state.at === 'plan' ? state.plan : null;
  const refusal = plan?.refusal ?? null;
  const error = state.at === 'plan' ? state.error : state.at === 'failed' ? state.error : '';
  const busy = state.at === 'plan' && state.busy;
  // Once the plan is in, it names the dialog, as it already names the body:
  // a stale view that still says passed must not title a start-over a retry.
  const title = plan ? (plan.retry ? retryLabel(tasks) : RESET_LABEL) : label;

  return (
    <div ref={trigger} className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ${className}`.trim()} data-testid="task-reset">
      {/* Wraps its own words on a narrow main (a pinned column at 360 px leaves 128 px), as the strip's buttons do. */}
      <Button size="sm" variant="secondary" className="max-w-full whitespace-normal!" testId="task-reset-open" onClick={() => void ask()}>
        {label}
      </Button>
      <p className="label-sm" role="status" data-testid="task-reset-status">
        {said}
      </p>
      {open && (
        <dialog
          ref={dialog}
          className="m-auto w-[min(34rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto rounded-panel border-1.5 border-edge bg-surface p-4 text-ink"
          aria-labelledby={titleId}
          aria-modal="true"
          tabIndex={-1}
          data-testid="task-reset-dialog"
          onCancel={(event) => {
            event.preventDefault();
            if (!busy) close();
          }}
          onKeyDown={(event) => {
            holdTab(event);
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              if (!busy) close();
            }
          }}
        >
          <h2 id={titleId} className="text-[15px] font-semibold text-ink">
            {title}: {task?.title ?? ''}
          </h2>
          {state.at === 'loading' && (
            <p className="mt-3 text-[13px]" role="status">
              {retry ? RETRY_CHECKING : 'Checking what a reset would change…'}
            </p>
          )}
          {plan && refusal && (
            <p className="mt-3 text-[13px]" data-testid="task-reset-refusal">
              {refusal}
            </p>
          )}
          {plan && !refusal && (
            <>
              <PathList label="Put back to how the task started" paths={plan.restores} testId="task-reset-restores" />
              <PathList label="Set up again from the project" paths={plan.reseeds} testId="task-reset-reseeds" />
              {plan.protectedBy.length > 0 && (
                <div className="mt-3" data-testid="task-reset-protected">
                  <p className="text-[13px] font-semibold text-ink">Kept as they are, because a task that shares them has passed</p>
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {plan.protectedBy.map((kept) => (
                      <li key={kept.path} className="wrap text-[12.5px] text-ink">
                        <span className="font-mono">{kept.path}</span>, kept by {kept.siblingTitle}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.restores.length + plan.reseeds.length === 0 && (
                <p className="mt-3 text-[13px]">No file of this task changes; only its run starts again.</p>
              )}
              {plan.dropsPendingProposal && (
                <p className="mt-3 text-[13px]" data-testid="task-reset-proposal">
                  {RESET_DROPS_PROPOSAL}
                </p>
              )}
              {plan.retry ? (
                <RetryKeeps keeps={plan.retry.keeps} />
              ) : (
                <p className="mt-3 text-[13px]" data-testid="task-reset-keeps">
                  {RESET_KEEPS}
                </p>
              )}
            </>
          )}
          {error && (
            <p className="mt-3 text-[13px] text-fail" role="alert" data-testid="task-reset-error">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="secondary" testId="task-reset-cancel" onClick={close} disabled={busy}>
              {plan && !refusal ? 'Cancel' : 'Close'}
            </Button>
            {plan && !refusal && (
              <Button
                size="sm"
                variant="danger"
                testId="task-reset-confirm"
                busy={busy}
                busyLabel={plan.retry ? RETRY_BUSY : 'Starting over…'}
                onClick={() => void confirm()}
              >
                {plan.retry ? RETRY_CONFIRM : 'Start over'}
              </Button>
            )}
          </div>
        </dialog>
      )}
    </div>
  );
}

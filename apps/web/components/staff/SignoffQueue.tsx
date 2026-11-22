'use client';

/**
 * The class's sign-off queue, with bulk sign-off.
 *
 * A task that needs a countersignature waits here, one row per learner, until
 * a teacher signs it off. A batch is **one task, many learners, one reason**:
 * the reason is what the record of changes keeps against every
 * learner in the batch, so the bulk control is off until a reason of at least
 * `ASSIGNMENT_REASON_MIN` characters is written, and it says so.
 *
 * The API decides who is signed off, one transaction per learner; this page
 * reads its answer back word for word (the learners signed off, and each
 * refusal's own sentence) and reads the queue again.
 *
 * The doors are `SIGNOFF_ROUTES`, a table of their own; nothing here is an
 * authoring route.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BulkSignoffResult, PhaseKey, SignoffQueueRow, SignoffQueueView } from '@learnsdlc/shared';
import { ASSIGNMENT_REASON_MIN, PHASE_ORDER, andList, pluralWord } from '@learnsdlc/shared';
import { Button, Chip, EmptyState, Notice, Section } from '@/components/ui';
import { PHASE_META } from '@/lib/phase';
import { instructorApi } from '@/lib/api-instructor';
import { projectsApi, signoffApi } from '@/lib/api-projects';
import { StaffDialog } from '@/components/staff/StaffDialog';
import { ReasonCount, sinceLabel } from '@/components/staff/primitives';
import { refusalOf } from '@/components/staff/projects/refusal';

interface TaskGroup {
  key: string;
  phaseKey: PhaseKey;
  taskKey: string;
  taskTitle: string;
  rows: SignoffQueueRow[];
}

/** The queue as one group per task, in phase order, each group's learners by name. */
function groupQueue(rows: readonly SignoffQueueRow[]): TaskGroup[] {
  const groups = new Map<string, TaskGroup>();
  for (const row of rows) {
    const key = `${row.phaseKey}-${row.taskKey}`;
    const group =
      groups.get(key) ??
      { key, phaseKey: row.phaseKey, taskKey: row.taskKey, taskTitle: row.taskTitle, rows: [] as SignoffQueueRow[] };
    group.rows.push(row);
    groups.set(key, group);
  }
  const order = (phase: PhaseKey) => PHASE_ORDER.indexOf(phase);
  return [...groups.values()]
    .map((group) => ({ ...group, rows: [...group.rows].sort((a, b) => a.learnerName.localeCompare(b.learnerName)) }))
    .sort((a, b) => order(a.phaseKey) - order(b.phaseKey) || a.taskKey.localeCompare(b.taskKey));
}

/**
 * The queue's place on the class page. The
 * home links each class here (`/teacher/class?class=<id>#signoff-queue`) and
 * the class header links in-page; arriving with this hash moves focus to the
 * queue's heading once the queue is drawn, and at no other time.
 */
export const SIGNOFF_QUEUE_ID = 'signoff-queue';

/** The queue's heading: the `<h2>` that `Section` draws around `title`. */
function headingOf(inside: HTMLElement | null): HTMLHeadingElement | null {
  return inside?.closest('h2') ?? null;
}

/**
 * Focus the queue's heading if it is on the page (the class header's in-page
 * link). True when it did, so the link can keep the hash out of the address:
 * a hash left there would read as a fresh arrival when the queue is redrawn.
 */
export function focusSignoffQueue(): boolean {
  const heading = document.getElementById(SIGNOFF_QUEUE_ID)?.querySelector('h2');
  if (!(heading instanceof HTMLElement)) return false;
  heading.tabIndex = -1;
  heading.focus();
  return true;
}

/**
 * The arrival is spent once it is decided. The hash leaves the
 * address (same entry, same history state), so a later redraw of the queue (a
 * reload of the page's records unmounts it) is never taken for an arrival.
 */
function spendArrival(): void {
  const { pathname, search } = window.location;
  // `null`, the idiom `updatePageQuery` uses, so the app router copies its own
  // state in and its canonical URL drops the hash too. Handing it
  // `history.state` (which carries `__NA`) would skip that.
  window.history.replaceState(null, '', `${pathname}${search}`);
}

/**
 * How a task gets here. A task reaches the queue
 * only from a version published with the task marked (`signOff`), once a
 * learner on that version passes it; the mark is the editor's.
 */
export const SIGNOFF_QUEUE_EMPTY_BODY =
  'Mark a task as needing your sign-off in the project editor. Learners on a version published with that mark appear here once they pass it.';

/**
 * The empty queue of a class known to use sign-off: a learner has waited
 * here or been signed off, by this page's reads or the class's records, or the
 * version the class is on marks a task for sign-off. Then the set-up hint above
 * would tell the teacher to do what is already done (right under "Signed off 1
 * learner.", say), so the queue says only that nothing waits.
 */
export const SIGNOFF_QUEUE_EMPTY_IN_USE_BODY = 'Learners who pass a task marked for your sign-off appear here.';

/**
 * What the queue is for, true on every phase: on the last phase a
 * sign-off opens no next phase, it lets the learner complete the project.
 */
const SIGNOFF_QUEUE_PURPOSE =
  'Tasks a learner has passed that wait for your sign-off. A task you sign off counts as passed; until then a required one keeps its phase from passing. Sign off one task for several learners at once, with one reason.';

/**
 * Whether the version the class is on now marks any task for sign-off,
 * from two reads of existing doors: the class's assignable versions, where the
 * one in force is `current`, then that version's tree (`version.draft`, which
 * any teacher may read for their own or a platform project), whose tasks carry
 * the mark (`DraftTaskView.signOff`, sent only when true). False when the class
 * has no version in force or either read fails: the queue then keeps the
 * set-up hint.
 */
export async function versionInForceMarksSignoff(cohortId: string): Promise<boolean> {
  try {
    const current = (await instructorApi.assignableProjects(cohortId)).find((one) => one.current);
    if (!current) return false;
    const tree = await projectsApi.draft(current.projectId, current.versionId);
    return tree.phases.some((phase) => (phase.tasks ?? []).some((task) => task.signOff === true));
  } catch {
    return false;
  }
}

function learners(count: number): string {
  return `${count} ${pluralWord(count, 'learner')}`;
}

/**
 * A task group's heading: the task's title alone when it is the phase's
 * own title (a one-task phase's task is often named for the phase, which would
 * read "Maintenance, Maintenance"), otherwise "<task>, in <phase>".
 */
export function taskGroupHeading(taskTitle: string, phaseKey: PhaseKey): string {
  const phase = PHASE_META[phaseKey]?.title ?? phaseKey;
  return taskTitle.trim().toLowerCase() === phase.toLowerCase() ? phase : `${taskTitle}, in ${phase}`;
}

/**
 * The confirm's question: it names who is signed off and what the
 * record keeps, without repeating the button's words. "Each gets its own row"
 * only where there are several.
 */
export function signoffQuestion(taskTitle: string, names: string[]): string {
  if (names.length === 1) {
    return `${taskTitle} counts as passed for ${names[0]} once you sign it off. Your reason is kept in their record of changes.`;
  }
  return `${taskTitle} counts as passed for ${andList(names)} once you sign it off. Each of them gets their own row in the record of changes, with your reason.`;
}

function TaskBatch({
  group,
  busy,
  onAsk,
}: {
  group: TaskGroup;
  busy: boolean;
  onAsk: (group: TaskGroup, userIds: string[], reason: string, opener: HTMLButtonElement | null) => void;
}) {
  const id = useId();
  // One learner waiting: they are the batch, so they start chosen.
  const lone = group.rows.length === 1;
  const [picked, setPicked] = useState<string[]>(() => (lone ? [group.rows[0].userId] : []));
  const [reason, setReason] = useState('');
  const go = useRef<HTMLButtonElement>(null);
  const hintId = `${id}-reason-hint`;
  const whyId = `${id}-why`;

  const enough = reason.trim().length >= ASSIGNMENT_REASON_MIN;
  const why =
    picked.length === 0
      ? 'Choose at least one learner to sign off.'
      : !enough
        ? `Write a reason of at least ${ASSIGNMENT_REASON_MIN} characters. It is kept with every sign-off in this batch.`
        : '';
  const all = picked.length === group.rows.length;

  const toggle = (userId: string) =>
    setPicked((was) => (was.includes(userId) ? was.filter((one) => one !== userId) : [...was, userId]));

  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-3 rounded-ctl border-1.5 border-edge p-3"
      data-testid={`signoff-task-${group.key}`}
      disabled={busy}
    >
      <legend className="px-1 text-[13.5px] font-semibold text-ink">
        {taskGroupHeading(group.taskTitle, group.phaseKey)}
      </legend>

      {/* "Every learner" would be a second box for the same one learner when only one waits. */}
      {!lone && (
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={`${id}-all`}
          type="checkbox"
          checked={all}
          data-testid={`signoff-all-${group.key}`}
          onChange={() => setPicked(all ? [] : group.rows.map((row) => row.userId))}
        />
        <label htmlFor={`${id}-all`} className="text-[13px] text-ink">
          {`Every learner waiting on this task (${group.rows.length})`}
        </label>
        <span className={`label-sm ml-auto tabular-nums ${picked.length > 0 ? 'text-accent' : ''}`} data-some={picked.length > 0} aria-hidden="true">
          {`${picked.length} of ${group.rows.length} chosen`}
        </span>
      </div>
      )}

      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {group.rows.map((row) => (
          <li key={row.userId} className="flex min-w-0 items-center gap-2">
            <input
              id={`${id}-${row.userId}`}
              type="checkbox"
              checked={picked.includes(row.userId)}
              data-testid={`signoff-pick-${group.key}-${row.userId}`}
              onChange={() => toggle(row.userId)}
            />
            <label htmlFor={`${id}-${row.userId}`} className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-ink">{row.learnerName}</span>
              <span className="label-sm">{`waiting ${sinceLabel(row.awaitingSince)}`}</span>
            </label>
          </li>
        ))}
      </ul>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          {/* Named for what it is: the class's sign-off tab also holds the regrade's reason. */}
          <label htmlFor={`${id}-reason`} className="block text-[13px] font-medium text-ink">
            Reason for the sign-off
          </label>
          <ReasonCount value={reason} min={ASSIGNMENT_REASON_MIN} />
        </div>
        <textarea
          id={`${id}-reason`}
          className="field mt-1.5 min-h-[64px]"
          aria-describedby={hintId}
          data-testid={`signoff-reason-${group.key}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p id={hintId} className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
          {lone
            ? `At least ${ASSIGNMENT_REASON_MIN} characters. The record of changes keeps it with this sign-off.`
            : `One reason for the whole batch, at least ${ASSIGNMENT_REASON_MIN} characters. The record of changes keeps it against every learner you sign off.`}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <button
          ref={go}
          type="button"
          className="btn btn-sm"
          disabled={Boolean(why)}
          aria-describedby={why ? whyId : undefined}
          data-testid={`signoff-bulk-${group.key}`}
          onClick={() => onAsk(group, [...picked].sort(), reason.trim(), go.current)}
        >
          {picked.length > 0 ? `Sign off ${learners(picked.length)}` : 'Sign off'}
        </button>
        {why && (
          <span id={whyId} className="label-sm" data-testid={`signoff-bulk-${group.key}-reason`}>
            {why}
          </span>
        )}
      </div>
    </fieldset>
  );
}

export function SignoffQueue({
  cohortId,
  refreshRound = 0,
  onSigned,
  onWaiting,
  inUse: classUsesSignoff = false,
  readVersionMarks,
}: {
  cohortId: string;
  /**
   * Bumped by the class page when it reads its records again, so
   * the queue and the table above it are never two reads apart.
   */
  refreshRound?: number;
  /** A batch was signed: the class page reads its table and counters again. */
  onSigned?: () => void;
  /** How many learners wait, for the class page's first row; null until the queue answers. */
  onWaiting?: (count: number | null) => void;
  /** The class's records show a task waiting on or given a sign-off, so the class uses sign-off. */
  inUse?: boolean;
  /**
   * Asked once, when the queue first answers empty and nothing yet shows the
   * class uses sign-off: whether the class's version in force marks a task
   * for sign-off (`versionInForceMarksSignoff` on the class page). Without it
   * the queue asks nothing and reads only its own records.
   */
  readVersionMarks?: (cohortId: string) => Promise<boolean>;
}) {
  const [view, setView] = useState<SignoffQueueView | null>(null);
  const [loadError, setLoadError] = useState('');
  /** A retry of a refused read is in flight: the button waits for it. */
  const [retrying, setRetrying] = useState(false);
  const [asking, setAsking] = useState<{ group: TaskGroup; userIds: string[]; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BulkSignoffResult | null>(null);
  /** Bumped per task after a batch is signed, so its choices and reason start again. */
  const [rounds, setRounds] = useState<Record<string, number>>({});
  const opener = useRef<HTMLButtonElement | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const questionId = useId();
  const alive = useRef(true);
  const titleRef = useRef<HTMLSpanElement>(null);
  /** Focus is moved for an arrival with the hash once per mount, never again. */
  const arrived = useRef(false);
  /** A batch answer to focus once the confirm is closed. */
  const answerWanted = useRef(false);
  /** Whether the class's version in force marks a task for sign-off, once asked. */
  const [versionMarks, setVersionMarks] = useState<{ cohortId: string; marks: boolean } | null>(null);
  /**
   * The one ask per class and its pending answer: a read that starts while the
   * first is still waiting on it waits on the same answer, so neither draws
   * the empty state before the version is known.
   */
  const marksAsk = useRef<{ cohortId: string; answer: Promise<boolean> } | null>(null);
  /** Whether this render already knew the class uses sign-off: then nothing is asked. */
  const knownInUse = useRef(classUsesSignoff);
  const askMarks = useRef(readVersionMarks);
  askMarks.current = readVersionMarks;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const next = await signoffApi.queue(cohortId);
      if (!alive.current) return;
      // An empty queue on a class not yet known to use sign-off: ask once
      // whether its version marks a task, before the empty state is drawn, so
      // the set-up hint is never drawn first and then taken back. Every read
      // waits on that one answer, a read started while it is pending too (a
      // refresh, or the effect run twice); a reader that throws answers false
      // rather than reading as the queue's own load error.
      const ask = askMarks.current;
      if (ask && next.rows.length === 0 && !knownInUse.current) {
        if (marksAsk.current?.cohortId !== cohortId) {
          marksAsk.current = { cohortId, answer: new Promise<boolean>((done) => done(ask(cohortId))).catch(() => false) };
        }
        const marks = await marksAsk.current.answer;
        if (!alive.current) return;
        setVersionMarks({ cohortId, marks });
      }
      setView(next);
      setLoadError('');
    } catch (err) {
      if (alive.current) setLoadError(refusalOf(err, 'The sign-off queue could not be loaded. Try again in a moment.'));
    }
  }, [cohortId]);

  useEffect(() => {
    void read();
  }, [read]);

  // The class page read its records again: the queue follows, without a remount
  // (focus and a batch being written stay where they are).
  const seenRound = useRef(refreshRound);
  useEffect(() => {
    if (seenRound.current === refreshRound) return;
    seenRound.current = refreshRound;
    void read();
  }, [refreshRound, read]);

  const waitingNow = view ? view.rows.length : null;
  const reportWaiting = useRef(onWaiting);
  reportWaiting.current = onWaiting;
  useEffect(() => {
    reportWaiting.current?.(waitingNow);
  }, [waitingNow]);

  // The heading takes focus from script only (tabIndex -1), and only when the
  // page arrived with #signoff-queue, after the queue (or its refusal) is drawn.
  useEffect(() => {
    const heading = headingOf(titleRef.current);
    if (heading) heading.tabIndex = -1;
    if (arrived.current || (view === null && !loadError)) return;
    // Decided once, at the first draw: a later re-read (after a batch) never moves focus.
    arrived.current = true;
    if (typeof window === 'undefined' || window.location.hash !== `#${SIGNOFF_QUEUE_ID}`) return;
    spendArrival();
    // A teacher who has already moved focus while the queue loaded keeps their place.
    const at = document.activeElement;
    if (!at || at === document.body) heading?.focus();
  }, [view, loadError]);

  // The answer takes focus only once nothing is inert.
  useEffect(() => {
    if (!answerWanted.current || asking || !result) return;
    answerWanted.current = false;
    resultRef.current?.focus();
  }, [asking, result]);

  const groups = useMemo(() => groupQueue(view?.rows ?? []), [view]);
  const names = useMemo(
    () => new Map((view?.rows ?? []).map((row) => [row.userId, row.learnerName] as const)),
    [view],
  );

  const sign = async () => {
    if (!asking) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const answer = await signoffApi.bulk(cohortId, {
        phaseKey: asking.group.phaseKey,
        taskKey: asking.group.taskKey,
        userIds: asking.userIds,
        reason: asking.reason,
      });
      if (!alive.current) return;
      const done = asking.group.key;
      // The answer is drawn in the same commit that
      // closes the confirm, so the dialog's inert fence is taken down before
      // the answer is placed, and focus moves to it once it is (the effect
      // below). The batch's controls start again, so focus goes to the answer.
      answerWanted.current = true;
      setResult(answer);
      setRounds((was) => ({ ...was, [done]: (was[done] ?? 0) + 1 }));
      setBusy(false);
      setAsking(null);
      await read();
      // The countersign moved the learners' boards: the class page's table and counters follow.
      if (alive.current) onSigned?.();
    } catch (err) {
      if (alive.current) setError(refusalOf(err, 'The batch could not be signed off. Try again in a moment.'));
    } finally {
      if (alive.current) {
        setBusy(false);
        setAsking(null);
      }
    }
  };

  const waiting = view?.rows.length ?? 0;
  // Sign-off is in use here once a learner has waited in this queue or been
  // signed off from it, or the class's records say so, or the version the
  // class is on marks a task for it.
  const seenWaiting = useRef(false);
  if (waiting > 0 || (result?.signedOff.length ?? 0) > 0) seenWaiting.current = true;
  knownInUse.current = classUsesSignoff || seenWaiting.current;
  const inUse = knownInUse.current || (versionMarks?.cohortId === cohortId && versionMarks.marks);

  return (
    <Section
      id={SIGNOFF_QUEUE_ID}
      title={<span ref={titleRef}>Awaiting your sign-off</span>}
      purpose={SIGNOFF_QUEUE_PURPOSE}
      testId="signoff-queue"
      right={
        // The soft warn the Sign-off tab's count is drawn in, so the two read as one.
        <Chip className={`tabular-nums${waiting > 0 ? ' bg-warntint text-warn' : ''}`} testId="signoff-waiting">
          {`${waiting} waiting`}
        </Chip>
      }
    >
      {loadError && (
        <div className="flex flex-col items-start gap-2">
          <Notice tone="fail" role="alert" testId="signoff-load-error">
            {loadError}
          </Notice>
          <button
            type="button"
            className="btn-secondary btn-sm"
            data-testid="signoff-retry"
            disabled={retrying}
            aria-busy={retrying || undefined}
            onClick={async () => {
              setRetrying(true);
              await read();
              if (alive.current) setRetrying(false);
            }}
          >
            Try again
          </button>
          {retrying && (
            <div className="flex w-full flex-col gap-2" aria-hidden="true">
              <div className="skeleton h-4 w-3/5" />
              <div className="skeleton h-4 w-2/5" />
            </div>
          )}
        </div>
      )}
      {error && (
        <Notice tone="fail" role="alert" testId="signoff-error-box">
          <span data-testid="signoff-error">{error}</span>
        </Notice>
      )}
      {result && (
        <div ref={resultRef} tabIndex={-1} className="outline-none">
          <Notice tone={result.refused.length > 0 ? 'warn' : 'pass'} role="status" testId="signoff-result">
            <span className="block">{`Signed off ${learners(result.signedOff.length)}.`}</span>
            {result.refused.length > 0 && (
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                {result.refused.map((one) => (
                  <li key={one.userId} className="wrap">
                    <span data-testid={`signoff-refused-${one.userId}`}>{one.sentence}</span>
                  </li>
                ))}
              </ul>
            )}
          </Notice>
        </div>
      )}

      {view === null ? (
        !loadError && (
          <div className="flex flex-col gap-2.5">
            <p className="purpose" data-testid="signoff-loading">
              Loading the sign-off queue.
            </p>
            <div className="flex flex-col gap-2" aria-hidden="true">
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
              <div className="skeleton h-10 w-full" />
            </div>
          </div>
        )
      ) : groups.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title="Nothing is waiting for a sign-off"
          body={inUse ? SIGNOFF_QUEUE_EMPTY_IN_USE_BODY : SIGNOFF_QUEUE_EMPTY_BODY}
          testId="signoff-empty"
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {groups.map((group) => (
            <TaskBatch
              key={`${group.key}-${rounds[group.key] ?? 0}`}
              group={group}
              busy={busy}
              onAsk={(chosen, userIds, reason, from) => {
                opener.current = from;
                setError('');
                setAsking({ group: chosen, userIds, reason });
              }}
            />
          ))}
        </div>
      )}

      {asking && (
        <StaffDialog
          title={`Sign off ${asking.group.taskTitle}`}
          describedBy={questionId}
          onClose={() => setAsking(null)}
          closable={!busy}
          returnFocus={opener}
          testId="signoff-confirm"
        >
          <p id={questionId} className="m-0 wrap text-[13.5px] leading-[1.5] text-ink">
            {signoffQuestion(
              asking.group.taskTitle,
              asking.userIds.map((userId) => names.get(userId) ?? 'a learner'),
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Not the form's button word for word: this one confirms it. */}
            <Button busy={busy} busyLabel="Signing off…" testId="signoff-confirm-yes" onClick={() => void sign()}>
              Confirm sign-off
            </Button>
            <Button variant="ghost" disabled={busy} testId="signoff-confirm-no" onClick={() => setAsking(null)}>
              Not yet
            </Button>
          </div>
        </StaffDialog>
      )}
    </Section>
  );
}

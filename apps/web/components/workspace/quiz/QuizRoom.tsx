'use client';

/**
 * The quiz room's body: read the quiz, draw a paper, hand it in, read it back.
 *
 * **What this room deliberately does not mount.** No editor, no run control,
 * no preview and no agentic propose surface. The proposal path is phase-scoped
 * and targets editable files; a quiz owns none, and a mentor proposing edits to
 * the learner's code from inside a quiz would be a room doing something its
 * task cannot be graded on. The only controls here are Start, the paper's own
 * inputs and Hand in.
 *
 * **The one state that is nobody's fault and nobody's to fix here.** When
 * every allowed paper of this run has been handed in and none of them passed,
 * the API says so on the view (`needsInstructorReset`) and the room draws that
 * state: what has happened, that the papers are kept, and that a teacher's
 * reset of this task is what gives the learner another go. No Start control,
 * because the route would refuse it by name; no error styling, because running
 * out of papers is a rule working rather than something going wrong.
 *
 * **And the state after a teacher has answered it.** A reset hands the
 * attempts back by starting a new attempt run, so everything the quiz route
 * counts starts again: which leaves the room reading exactly as it would for
 * a learner who had never opened this quiz, opposite to what it had just
 * promised them. The two facts that outlive a run, `resetAt` and the task's
 * own attempt count, are on the task's row rather than on the quiz view; the
 * page hands them down and `RESET_NOTICE_LINE` is what the room does with
 * them.
 *
 * **Why the verdict arrives through a submission.** Handing a sheet in writes
 * the answers and enqueues the ordinary grading job, so the room watches the
 * revision it gets back exactly as every other room watches its own: no new
 * poller, no second notion of "done", and no request whose latency could carry
 * how many answers were right.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmissionView } from '@learnsdlc/shared';
import { api, describeError } from '@/lib/api';
import { pollUntil, useRecoverWhenBack } from '@/lib/poll';
import { invalidateProject } from '@/lib/useProject';
import { Button, Chip, Detail, EmptyState, Notice } from '@/components/ui';
import { PlainText } from '@/components/PlainText';
import { QuizPaper, RETURNED_SHEET_LINE } from './QuizPaper';
import { QuizResult } from './QuizResult';
import { quizApi, type QuizAnswers, type QuizOpenPaper, type QuizRoomView } from './contract';

/** Has this revision finished grading, whichever way it went? */
const settled = (row: SubmissionView) => row.status === 'completed' || row.status === 'failed';

/** What the counters say about starting another paper, in one sentence. */
export function attemptsAvailableLine(view: QuizRoomView): string {
  const used = view.attemptsUsed === 1 ? '1 paper handed in' : `${view.attemptsUsed} papers handed in`;
  if (view.attemptsLeft === null) return `${used}. There is no limit on how many you may take.`;
  if (view.attemptsLeft <= 0) return `${used}. You have no attempts left.`;
  return view.attemptsLeft === 1 ? `${used}. One attempt left.` : `${used}. ${view.attemptsLeft} attempts left.`;
}

/** The wait between papers, as a fact. Nothing in this room counts down. */
export function cooldownLine(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1
    ? 'Another paper can be started in about a minute.'
    : `Another paper can be started in about ${minutes} minutes.`;
}

/** What the room says while a sheet is being marked. */
export const MARKING_LINE = 'Marking your paper.';

/**
 * The one state a learner cannot leave on their own, said plainly.
 *
 * `QuizRoomView.needsInstructorReset` is the API's answer over the rows,
 * every allowed paper of this run handed in, and this task's row not passed,
 * so the room draws the state rather than a Start control that would be
 * refused by name. Nothing here is styled as an error: running out of papers
 * is a thing the rules allow, and the way out of it is a person rather than a
 * retry.
 */
export const NO_PAPERS_TITLE = 'You have handed in every paper on this quiz';

/**
 * What happens next, which is the half a learner cannot work out for
 * themselves: the papers are kept, and a teacher's reset on this task starts a
 * fresh run with the attempts back. The gate clause is the `required` field
 * beside it: running out of papers on an optional quiz holds nothing up, and
 * telling a learner it does would be a worry they do not owe.
 */
export function noPapersNextLine(required: boolean): string {
  const kept =
    'Every paper you handed in stays in your record. Your instructor can reset this quiz, which draws a fresh paper and gives you your attempts back.';
  return required
    ? `${kept} This quiz is required, so the phase cannot pass until this quiz passes.`
    : `${kept} This quiz is optional, so nothing else is waiting on it.`;
}

/**
 * The promise above, kept on the screen the learner comes back to.
 *
 * Everything `GET …/quiz` says about counting is scoped to the **attempt
 * epoch**, and that is not an oversight: moving the epoch is precisely how a
 * teacher's reset hands the attempts back without deleting a row. The cost is
 * that the room a learner opens after a reset reads `attemptsUsed: 0`,
 * `attemptsLeft: <the whole limit>`, `bestScore: null` and
 * `lastSubmissionId: null`; the same four readings as a quiz nobody has ever
 * opened, and no trace of the papers this room had just told them were kept.
 *
 * So the room says it. One sentence, under the counters it accounts for,
 * covering both of the readings that would otherwise be wrong: the zero, and
 * *Not scored yet* beside a learner who was scored.
 */
export const RESET_NOTICE_LINE =
  'Your instructor reset this quiz. The counters and the best score start again from that reset, and every paper you handed in before it stays in your record.';

/**
 * Beside a best score that only a teacher's credit gave.
 *
 * A Sign off, or a phase-wide Pass, writes a quiz's row `passed` at the pass
 * mark with no paper behind it, and printed bare as "Best score" that number
 * would sit beside papers that scored less. `passCredited` is the API's answer
 * that this is what happened, so the number keeps its place and says whose it
 * is, and one line says what it does not mean.
 */
export const CREDIT_WORD = "your teacher's credit";
export const CREDITED_LINE =
  "Your teacher marked this quiz passed, so the best score is their credit at the pass mark. None of your papers has passed it yet.";

/**
 * The spent limit, once there is nothing left to wait for.
 *
 * True the moment the last paper has a verdict, and only then: the best score
 * is the record's and no further paper can move it.
 */
export const SPENT_LINE = 'Your best score is the one that counts, and it is already recorded.';

/**
 * The same state, while the last paper is still being marked.
 *
 * `SPENT_LINE` is drawn under *This paper is in the record. Its mark is not
 * readable here yet.*: the two are read together, and a learner who reloads
 * the room between the hand-in and the verdict met both at once. *It is
 * already recorded* is not true of a paper nobody has scored, and the one
 * sentence that is wrong is the one about the number that decides their grade.
 *
 * The room is already watching the revision, `settled` is the predicate it
 * polls on, so which of the two sentences is true is a fact it holds. No
 * request is made to find it out.
 */
export const SPENT_WHILE_MARKING_LINE =
  'Your last paper is still being marked. Your best score is the one that counts, and it will include this paper once its mark lands.';

/**
 * What the room owes a learner whose sheet keeps coming back unmarked.
 *
 * A paper whose marking never happened is offered back with `handedInAt` set,
 * and `QuizPaper` says what it is ({@link RETURNED_SHEET_LINE}). While it is on
 * screen the room draws no other control, and `needsInstructorReset` is false:
 * correctly, because the attempts are not what ran out. So a learner whose
 * grading fails a second time has one button and no sentence saying anybody
 * can help them, which is the dead end this line closes.
 *
 * Two facts, both of them the product's to state: the answers are in the
 * record whatever the queue does, and this paper is visible to their instructor;
 * who can mark it, reset the task, or both. It is an ordinary line and not a
 * warning: an outage is not the learner's doing and not their failure.
 */
export const RETURNED_SHEET_HELP_LINE =
  'Your answers are safe in your record. If handing it in again does not work, your instructor can see this paper and help.';

export function QuizRoom({
  phaseId,
  taskKey,
  resetAt = null,
  papersInRecord = 0,
}: {
  phaseId: string;
  taskKey: string;
  /**
   * When this task's row was last reset, or null: `PhaseTaskView.resetAt`,
   * handed down by the page from the phase detail it already holds.
   *
   * **Why it comes from there and not from the quiz route.** `QuizRoomView` is
   * the current run, by design; the task's row is the learner's whole history
   * on this task and is where the two facts that outlive a run are kept. Both
   * are already in the payload the page fetches for the task panel above this
   * room, so reading them costs no request and no new field. If the room ever
   * needs to know this without the phase detail in hand, a room opened on a
   * phase whose summary has not loaded, the honest fix is a `resetAt` on
   * `QuizRoomView` itself, added in the API.
   *
   * It is deliberately fail-closed: the detail is a cached copy up to a minute
   * old, so a reset that lands while the learner is sitting in the room may
   * not be described until the next refresh. A sentence that arrives late is a
   * great deal better than one that arrives wrong.
   */
  resetAt?: string | null;
  /**
   * Papers this learner has handed in on this task across **every** run:
   * `PhaseTaskView.attempts`, which a reset deliberately leaves alone.
   *
   * It is what tells a learner whose reset took something away from them apart
   * from one whose teacher reset a quiz they had never touched: the sentence
   * is about a record, and to somebody with no record it would be a promise
   * about nothing.
   */
  papersInRecord?: number;
}) {
  const [view, setView] = useState<QuizRoomView | null>(null);
  const [paper, setPaper] = useState<QuizOpenPaper | null>(null);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [submission, setSubmission] = useState<SubmissionView | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [handingIn, setHandingIn] = useState(false);
  const [marking, setMarking] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /* The quiz, its counters, and the paper this learner already has open. */
  useEffect(() => {
    let stale = false;
    quizApi
      .read(phaseId, taskKey)
      .then(async (next) => {
        if (stale) return;
        setView(next);
        setPaper(next.paper);
        // An open paper starts blank; a sheet offered back starts as the
        // record has it. The route grades the answers already on the row
        // (`handIn` writes a sheet only while the row is open), so a blank
        // here would be the room collecting a paper it knows will be thrown
        // away. `selected` is absent on an open paper, which is why this
        // reads as one expression rather than as a branch.
        setAnswers(next.paper?.selected ?? {});
        setError('');
        // A paper is open: whatever was marked before is behind it now.
        if (next.paper) {
          setSubmission(null);
          return;
        }
        // No paper open, but a sheet already in the record: draw it back, so
        // returning to this room shows the marked paper rather than a Start
        // control that says nothing about what happened last time. A read that
        // names no revision leaves whatever the room is already showing:
        // this read happens again the moment a hand-in lands, and a mark the
        // learner is reading must not blink out because the row it came from
        // has not caught up.
        if (next.lastSubmissionId) {
          try {
            const row = await api.getSubmission(next.lastSubmissionId);
            if (!stale) setSubmission(row);
          } catch {
            // The marked paper could not be fetched. The counters above are
            // still true and the room is still usable, so nothing is said.
          }
        }
      })
      .catch((err: unknown) => {
        if (!stale) setError(describeError(err, 'This quiz could not be opened.'));
      });
    return () => {
      stale = true;
    };
  }, [phaseId, taskKey, attempt]);

  useRecoverWhenBack(Boolean(error) && !view, reload);

  const start = useCallback(async () => {
    setStarting(true);
    setError('');
    try {
      const next = await quizApi.start(phaseId, taskKey);
      if (!alive.current) return;
      setPaper(next);
      setAnswers({});
      setSubmission(null);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'The paper could not be started.'));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [phaseId, taskKey]);

  const handIn = useCallback(async () => {
    if (!paper) return;
    setHandingIn(true);
    setError('');
    let started: SubmissionView;
    try {
      started = await quizApi.handIn(phaseId, taskKey, paper.attemptId, answers);
    } catch (err) {
      if (alive.current) {
        setHandingIn(false);
        setError(describeError(err, 'The sheet could not be handed in.'));
      }
      return;
    }
    if (!alive.current) return;
    // The sheet is in the record from here on, whatever the grading job does,
    // so the paper is put away and the room is watching a revision.
    setPaper(null);
    setSubmission(started);
    setHandingIn(false);
    setMarking(true);
    try {
      const done = await pollUntil(() => api.getSubmission(started.id), settled);
      if (!alive.current) return;
      setSubmission(done);
      // The verdict is what moves the phase's task counts, and the panel of
      // tasks above this room is drawn from the shell's copy of the phase: so
      // it would read "0 of 3 required done" straight after a pass until a
      // reload. The shell keeps its copy on screen and fetches a fresh
      // one; a hand-in alone moves nothing it draws, so it is told here.
      invalidateProject();
    } catch (err) {
      if (alive.current) setError(describeError(err, 'Your paper is in. The mark could not be read back just yet.'));
    } finally {
      if (alive.current) {
        setMarking(false);
        // The counters, attempts used, attempts left, best score, are the
        // API's to say, and they have just moved.
        reload();
      }
    }
  }, [answers, paper, phaseId, reload, taskKey]);

  /**
   * The room's own announcer: one polite region, mounted with the room and
   * filled a commit later.
   *
   * Two sentences reach it, the interim *Marking your paper.* and the one
   * that says the papers have run out, and neither may be written into a
   * node created at the same moment. A live region has to be in the
   * accessibility tree *before* its text changes or the message is best
   * effort, which `QuizResult` also relies on for the score. Keeping the
   * words in state and setting them in an effect makes that true however the
   * region got on screen. Every visible copy of these sentences is an
   * ordinary paragraph, so nothing is announced twice.
   */
  // Said only where it is also drawn: an open paper is the room's subject
  // whatever the counters read, and announcing a state the screen is not in
  // would be the announcer disagreeing with the page.
  const needsReset = view?.needsInstructorReset === true && !paper;
  // A sheet already in the record, offered back because nothing marked it.
  // Said in full, what happened and who can help, because the last thing
  // this region said was *Marking your paper.*, and a learner who cannot see
  // the notice beside the paper has otherwise been left on that sentence.
  const returned = Boolean(paper?.handedInAt);
  const roomLine = marking
    ? MARKING_LINE
    : returned
      ? `${RETURNED_SHEET_LINE} ${RETURNED_SHEET_HELP_LINE}`
      : needsReset
        ? `${NO_PAPERS_TITLE}. ${noPapersNextLine(view?.required === true)}`
        : '';
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(roomLine);
  }, [roomLine]);
  const announcer = (
    <p className="sr-only" role="status" aria-live="polite" data-testid="quiz-live">
      {said}
    </p>
  );

  if (error && !view) {
    return (
      <div className="flex max-w-[540px] flex-col items-start gap-3">
        {announcer}
        <Notice tone="fail" testId="room-error">
          {error}
        </Notice>
        <Button testId="room-retry" onClick={reload}>
          Try again
        </Button>
      </div>
    );
  }

  if (!view)
    return (
      <div className="flex min-w-0 flex-col">
        {announcer}
        <p className="label">Loading the quiz…</p>
        {/* The paper's shape while it loads: a title line and two question cards. */}
        <div className="room-skeleton mt-3 flex flex-col gap-3" aria-hidden="true">
          <div className="skeleton h-5 w-2/5" />
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      </div>
    );

  const report = submission?.report?.quiz ?? null;
  const spent = view.attemptsLeft !== null && view.attemptsLeft <= 0;
  // The revision the room is watching has not finished grading. The same
  // predicate the hand-in polls on, asked of the row the room already holds:
  // which is also the row a learner who reloaded mid-marking gets back.
  const awaitingMark = submission !== null && !settled(submission);
  const waiting = (view.cooldownSecondsLeft ?? 0) > 0;
  // The run is fresh, the learner is not: a reset has happened and there are
  // papers behind it. Once a paper of this run is in, the counters describe
  // themselves and the sentence has nothing left to account for.
  const wasReset = Boolean(resetAt) && view.attemptsUsed === 0 && papersInRecord > 0;

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {announcer}
      {error && (
        <Notice tone="fail" testId="quiz-error">
          {error}
        </Notice>
      )}

      <section className="flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3" data-testid="quiz-header">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <strong className="text-[13.5px] font-semibold text-ink">{view.title}</strong>
          <Chip tone={view.required ? 'accent' : 'outline'}>{view.required ? 'Required' : 'Optional'}</Chip>
        </div>
        {view.brief && <PlainText className="text-[13px] leading-[1.65] text-ink" text={view.brief} commentsHidden />}
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Detail label="Questions">{String(view.drawn)}</Detail>
          <Detail label="Pass mark">{`${view.passMark}%`}</Detail>
          <div className="contents" data-testid="quiz-best-score">
            <Detail label="Best score">
              {view.bestScore === null
                ? 'Not scored yet'
                : view.passCredited
                  ? `${Math.round(view.bestScore)}%, ${CREDIT_WORD}`
                  : `${Math.round(view.bestScore)}%`}
            </Detail>
          </div>
        </div>
        {view.passCredited && (
          // Beside the counters it explains, an ordinary
          // line. The number above is the teacher's credit at the pass mark,
          // and the papers under it did not earn it.
          <p className="label-sm wrap" data-testid="quiz-credited">
            {CREDITED_LINE}
          </p>
        )}
        <p className="label-sm wrap" data-testid="quiz-attempts-available">
          {attemptsAvailableLine(view)}
        </p>
        {wasReset && (
          // Beside the counters, because it is the counters it explains, and
          // an ordinary line rather than a notice: a teacher reaching a
          // learner who was stuck is the rules working.
          <p className="label-sm wrap" data-testid="quiz-was-reset">
            {RESET_NOTICE_LINE}
          </p>
        )}
      </section>

      {paper ? (
        <>
          <QuizPaper
            paper={paper}
            answers={answers}
            onChange={setAnswers}
            onHandIn={handIn}
            busy={handingIn}
          />
          {returned && (
            // Under the sheet, beside the control it is about: the learner
            // meets what the paper is first, then the button, then what to do
            // if the button does not work. An ordinary line: the announcer
            // above is the one region that speaks, and nothing here is an
            // error at somebody an outage happened to.
            <p className="label-sm wrap" data-testid="quiz-returned-help">
              {RETURNED_SHEET_HELP_LINE}
            </p>
          )}
        </>
      ) : marking ? (
        // A plain paragraph: the announcer above is the one region that speaks,
        // and a second one carrying these same words would say them twice.
        <p className="label" data-testid="quiz-marking">
          {MARKING_LINE}
        </p>
      ) : report ? (
        <QuizResult report={report} passed={submission?.passed ?? null} />
      ) : submission ? (
        <p className="label" data-testid="quiz-no-report">
          This paper is in the record. Its mark is not readable here yet.
        </p>
      ) : null}

      {!paper && !marking && (
        <div className="flex flex-wrap items-center gap-2.5">
          {needsReset ? (
            // Every paper of this run is in, and none of them passed. The way
            // out is a teacher's reset of this task, so the room says that
            // instead of a control the route would refuse by name: and says
            // it in the neutral shape an expected state is drawn in, not as a
            // failure the learner has to fix.
            <EmptyState
              icon="people"
              title={NO_PAPERS_TITLE}
              body={noPapersNextLine(view.required)}
              testId="quiz-needs-reset"
            />
          ) : spent ? (
            <EmptyState
              icon="lock"
              title="You have used every attempt on this quiz"
              // Which of the two is true is a fact about the revision the room
              // is already holding, and the one directly above this state says
              // the mark is not readable yet. Both sentences are read together,
              // so they have to agree.
              body={awaitingMark ? SPENT_WHILE_MARKING_LINE : SPENT_LINE}
              testId="quiz-spent"
            />
          ) : waiting ? (
            <p className="label-sm" data-testid="quiz-cooldown">
              {cooldownLine(view.cooldownSecondsLeft ?? 0)}
            </p>
          ) : (
            <Button onClick={start} busy={starting} busyLabel="Drawing a paper" testId="quiz-start">
              {view.attemptsUsed > 0 ? 'Take it again' : 'Start the quiz'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

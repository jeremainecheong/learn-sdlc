'use client';

/**
 * The quick concept check, taken once before a phase and once after.
 *
 * It runs on the quiz room's own doors and its own paper (`quizApi`,
 * `QuizPaper`), under the task key `concept-before` or `concept-after`. What
 * it leaves out is everything that belongs to a graded quiz: no pass mark, no
 * best-of attempts, no "take it again". One paper, then the score and the
 * explanation of every question, then the way back to the phase.
 *
 * The hand-in answers with the marked revision. When it comes back already
 * marked it is drawn at once; when it is still being marked the room watches
 * it the way the quiz room does. A check taken earlier shows its score.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuizReport, SubmissionView } from '@learnsdlc/shared';
import { ApiError, api, describeError } from '@/lib/api';
import { pollUntil } from '@/lib/poll';
import { Button, Chip, Notice } from '@/components/ui';
import { PlainText } from '@/components/PlainText';
import { QuizPaper } from '@/components/workspace/quiz/QuizPaper';
import { quizApi, type QuizAnswers, type QuizOpenPaper, type QuizRoomView } from '@/components/workspace/quiz/contract';
import { CONCEPT_AFTER_LOCKED, CONCEPT_BEFORE_CLOSED, conceptTaskKey, pct, type ConceptKind } from '@/lib/api-concept';

const settled = (row: SubmissionView) => row.status === 'completed' || row.status === 'failed';

export function conceptScoreLine(report: Pick<QuizReport, 'correctCount' | 'drawn'>): string {
  const percent = report.drawn > 0 ? Math.round((report.correctCount / report.drawn) * 100) : 0;
  return `You got ${report.correctCount} of ${report.drawn} right (${percent}%).`;
}

export const CONCEPT_INTRO: Record<ConceptKind, string> = {
  before:
    'A few multiple-choice questions on the ideas this chapter teaches, taken before you start. It is not graded and does not lock anything. Answer from what you know now; the same ideas come back in a check after the phase, so you can see what you learned.',
  after:
    'The same ideas as the check before the phase, now that you have done it. It is not graded and does not lock anything.',
};

function ConceptResult({ report }: { report: QuizReport }) {
  const line = conceptScoreLine(report);
  const [said, setSaid] = useState('');
  useEffect(() => setSaid(line), [line]);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="concept-result" aria-label="Your marked check">
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      <p className="rounded-panel border-1.5 border-edge bg-surface p-3 text-[14px] font-semibold text-ink" data-testid="concept-score">
        {line}
      </p>
      {report.questions.length === 0 && (
        <p className="label-sm" data-testid="concept-answers-later">
          The answers and explanations come with the check after this phase.
        </p>
      )}
      {report.questions.length > 0 && (
      <ol className="flex min-w-0 list-none flex-col gap-2.5 p-0">
        {report.questions.map((question, index) => {
          const right = question.outcome === 'right';
          return (
            <li
              key={question.id}
              className="flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3"
              data-testid={`concept-marked-${question.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="label-sm">
                  Question {index + 1} of {report.drawn}
                </span>
                <Chip tone={right ? 'pass' : 'fail'}>{right ? 'Right' : 'Wrong'}</Chip>
              </div>
              <PlainText className="text-[13.5px] leading-[1.65] text-ink" text={question.stem} commentsHidden />
              <ul className="flex min-w-0 list-none flex-col gap-1.5 p-0">
                {question.options.map((option) => {
                  const mine = question.selected.includes(option.id);
                  return (
                    <li
                      key={option.id}
                      className={`flex min-w-0 items-start gap-2.5 rounded-ctl border-1.5 px-2.5 py-2 ${mine ? 'border-accent bg-tint' : 'border-edge'}`}
                    >
                      <span className="label-sm w-[86px] shrink-0">{mine ? 'Your answer' : ''}</span>
                      <PlainText className="flex-1 text-[13px] leading-[1.65] text-ink" text={option.text} commentsHidden />
                    </li>
                  );
                })}
              </ul>
              {question.selected.length === 0 && <p className="label-sm">You left this one blank.</p>}
              {question.explanation && (
                <div className="flex min-w-0 flex-col gap-1 rounded-ctl border-1.5 border-edge2 bg-tint px-2.5 py-2">
                  {question.concept && <span className="label-sm font-medium">{question.concept}</span>}
                  <PlainText className="text-[13px] leading-[1.65] text-ink" text={question.explanation} commentsHidden />
                </div>
              )}
            </li>
          );
        })}
      </ol>
      )}
    </section>
  );
}

export function ConceptRoom({ phaseId, kind, backHref }: { phaseId: string; kind: ConceptKind; backHref: string }) {
  const taskKey = conceptTaskKey(kind);
  const [view, setView] = useState<QuizRoomView | null>(null);
  const [paper, setPaper] = useState<QuizOpenPaper | null>(null);
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [report, setReport] = useState<QuizReport | null>(null);
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

  useEffect(() => {
    let stale = false;
    quizApi.read(phaseId, taskKey).then(
      async (next) => {
        if (stale) return;
        setView(next);
        setPaper(next.paper);
        setAnswers(next.paper?.selected ?? {});
        setError('');
        if (!next.paper && next.lastSubmissionId) {
          try {
            const row = await api.getSubmission(next.lastSubmissionId);
            if (!stale && row.report?.quiz) setReport(row.report.quiz);
          } catch {
            // The score above still says how it went.
          }
        }
      },
      (err: unknown) => {
        if (!stale) setError(describeError(err, 'This check could not be opened.'));
      },
    );
    return () => {
      stale = true;
    };
  }, [phaseId, taskKey, attempt]);

  const start = useCallback(async () => {
    setStarting(true);
    setError('');
    try {
      const next = await quizApi.start(phaseId, taskKey);
      if (!alive.current) return;
      setPaper(next);
      setAnswers({});
      setReport(null);
    } catch (err) {
      if (!alive.current) return;
      // Taken already (another tab, another device): read the room again.
      if (err instanceof ApiError && err.status === 409) reload();
      else setError(describeError(err, 'The check could not be started.'));
    } finally {
      if (alive.current) setStarting(false);
    }
  }, [phaseId, taskKey, reload]);

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
        setError(describeError(err, 'Your answers could not be handed in.'));
      }
      return;
    }
    if (!alive.current) return;
    setPaper(null);
    setHandingIn(false);
    if (started?.report?.quiz && settled(started)) {
      setReport(started.report.quiz);
      reload();
      return;
    }
    setMarking(true);
    try {
      const done = await pollUntil(() => api.getSubmission(started.id), settled);
      if (alive.current && done.report?.quiz) setReport(done.report.quiz);
    } catch (err) {
      if (alive.current) setError(describeError(err, 'Your answers are in. The score could not be read back just yet.'));
    } finally {
      if (alive.current) {
        setMarking(false);
        reload();
      }
    }
  }, [answers, paper, phaseId, reload, taskKey]);

  const back = (
    <Button href={backHref} variant={report || (view && view.attemptsUsed > 0) ? 'primary' : 'secondary'} testId="concept-back-to-phase">
      Back to the phase
    </Button>
  );

  if (error && !view) {
    return (
      <div className="flex max-w-[540px] flex-col items-start gap-3">
        <Notice tone="fail" testId="room-error">
          {error}
        </Notice>
        <div className="flex flex-wrap gap-2.5">
          <Button testId="room-retry" onClick={reload}>
            Try again
          </Button>
          {back}
        </div>
      </div>
    );
  }

  if (!view)
    return (
      <>
        <p className="label">Loading the check…</p>
        <div className="room-skeleton mt-3 flex flex-col gap-3" aria-hidden="true">
          <div className="skeleton h-5 w-2/5" />
          <div className="skeleton h-24 w-full" />
        </div>
      </>
    );

  const taken = view.attemptsUsed > 0;
  // A slot the API will not start (a closed before check
  // reads `locked` here, as does the after check before the phase is passed)
  // says why, in place of a Start the route would refuse. A paper drawn while
  // the slot was open is still drawn below and may be handed in.
  const shut = view.status === 'locked' && !taken && !paper && !report && !marking;

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {error && (
        <Notice tone="fail" testId="concept-error">
          {error}
        </Notice>
      )}
      {shut && (
        <p className="rounded-panel border-1.5 border-edge bg-surface p-3 text-[13.5px] text-ink wrap" data-testid="concept-closed">
          {kind === 'after' ? CONCEPT_AFTER_LOCKED : CONCEPT_BEFORE_CLOSED}
        </p>
      )}
      {!shut && !taken && !paper && !report && !marking && (
        <section className="flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3" data-testid="concept-intro">
          <p className="text-[13.5px] text-ink wrap">{CONCEPT_INTRO[kind]}</p>
          <p className="label-sm">{`${view.drawn} questions. Nothing is timed.`}</p>
        </section>
      )}

      {paper ? (
        <QuizPaper paper={paper} answers={answers} onChange={setAnswers} onHandIn={handIn} busy={handingIn} />
      ) : marking ? (
        <p className="label" role="status" data-testid="concept-marking">
          Marking your answers.
        </p>
      ) : report ? (
        <ConceptResult report={report} />
      ) : taken ? (
        <p className="rounded-panel border-1.5 border-edge bg-surface p-3 text-[13.5px] text-ink" data-testid="concept-taken">
          {view.bestScore === null
            ? 'You have taken this check. Its score is being worked out.'
            : `You have taken this check. You scored ${pct(view.bestScore)}.`}
        </p>
      ) : null}

      {!paper && !marking && (
        <div className="flex flex-wrap items-center gap-2.5">
          {!shut && !taken && !report && (
            <Button onClick={start} busy={starting} busyLabel="Drawing the questions" testId="concept-start">
              Start the check
            </Button>
          )}
          {back}
        </div>
      )}
    </div>
  );
}

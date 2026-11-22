'use client';

/**
 * The paper, marked.
 *
 * What is drawn here is the whole of what a learner is ever told about a
 * question, and the shape of it is the seal:
 *
 * - **Right or wrong, and what they picked.** Always, on every scored attempt.
 *   That is the hidden test's real analogue: it names what failed and not what
 *   passes.
 * - **The explanation and the concept.** Only when the API has released them,
 *   which it does once this learner is finished with that question: their
 *   attempt passed, their attempts are spent, or the quiz is an optional one
 *   with no limit. On an optional quiz the teacher may choose instead:
 *   after every attempt, or only after a pass or the last
 *   attempt. The room does not decide this and holds no flag for it: a
 *   sealed explanation arrives as `null` and there is nothing here to draw.
 * - **The answer key: never.** No route carries it, so nothing below can draw
 *   it. The options are listed in the order the paper drew them and **not one
 *   of them is marked correct**; the only mark is the learner's own.
 *
 * Two accessibility rules are load-bearing rather than decorative. The score is
 * announced through a polite live region, because a verdict that lands while
 * focus is on the Hand in button is a change a sighted learner sees and a
 * screen-reader learner is otherwise never told about: and that region is
 * mounted empty and filled on the commit after, because this whole screen
 * arrives in one go when the mark lands, and a region that arrives with its
 * sentence already inside it is not reliably read out. The sentence a sighted
 * learner reads is the plain paragraph beside it: one announcer, announced
 * once. And every outcome is carried by a **word**, "Right", "Wrong", "Your
 * answer", with colour doing nothing on its own, which is the house rule and
 * is also the only reading of this screen that survives a greyscale print-out.
 */

import { useEffect, useState } from 'react';
import type { QuizReport } from '@learnsdlc/shared';
import { PlainText } from '@/components/PlainText';
import { Chip } from '@/components/ui';
import { scoreLine } from './contract';

/** What is left to try, said once, under the score. */
export function attemptsLine(attempt: number, attemptsLeft: number | null): string {
  const taken = `Attempt ${attempt}.`;
  if (attemptsLeft === null) return `${taken} You may take it again as often as you like.`;
  if (attemptsLeft <= 0) return `${taken} That was your last attempt.`;
  return attemptsLeft === 1 ? `${taken} One attempt left.` : `${taken} ${attemptsLeft} attempts left.`;
}

export function QuizResult({ report, passed }: { report: QuizReport; passed: boolean | null }) {
  const line = scoreLine(report.correctCount, report.drawn, report.passMark, passed === true);

  // The announcer is empty on the render that mounts it and holds the verdict
  // on the next one, so the sentence lands as a change inside a region the
  // screen reader is already watching rather than as a node that appears with
  // its words already in it.
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(line);
  }, [line]);

  return (
    <section className="flex min-w-0 flex-col gap-3.5" data-testid="quiz-result" aria-label="Your marked paper">
      {/* Polite, not assertive: the verdict is worth hearing at the next pause
          and is never worth interrupting a learner mid-sentence for. It is the
          only live region here: a second one carrying the same words would
          read the verdict out twice. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="quiz-score-live">
        {said}
      </p>
      <div className="flex min-w-0 flex-col gap-1 rounded-panel border-1.5 border-edge bg-surface p-3">
        <p className="text-[13.5px] font-semibold text-ink wrap" data-testid="quiz-score">
          {line}
        </p>
        <p className="label-sm wrap" data-testid="quiz-attempts">
          {attemptsLine(report.attempt, report.attemptsLeft)}
        </p>
      </div>

      <ol className="flex min-w-0 list-none flex-col gap-2.5 p-0">
        {report.questions.map((question, index) => {
          const right = question.outcome === 'right';
          return (
            <li
              key={question.id}
              className="flex min-w-0 flex-col gap-2 rounded-panel border-1.5 border-edge bg-surface p-3"
              data-testid={`quiz-marked-${question.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="label-sm">
                  Question {index + 1} of {report.drawn}
                </span>
                {/* The word is the outcome. The tone only agrees with it. */}
                <Chip tone={right ? 'pass' : 'fail'} testId={`quiz-outcome-${question.id}`}>
                  {right ? 'Right' : 'Wrong'}
                </Chip>
              </div>
              <PlainText className="text-[13.5px] leading-[1.65] text-ink" text={question.stem} commentsHidden />
              <ul className="flex min-w-0 list-none flex-col gap-1.5 p-0">
                {question.options.map((option) => {
                  const mine = question.selected.includes(option.id);
                  return (
                    <li
                      key={option.id}
                      className={`flex min-w-0 items-start gap-2.5 rounded-ctl border-1.5 px-2.5 py-2 ${mine ? 'border-accent bg-tint' : 'border-edge'}`}
                      data-testid={`quiz-option-${question.id}-${option.id}`}
                    >
                      <span className="label-sm w-[86px] shrink-0">{mine ? 'Your answer' : ''}</span>
                      <PlainText className="flex-1 text-[13px] leading-[1.65] text-ink" text={option.text} commentsHidden />
                    </li>
                  );
                })}
              </ul>
              {question.selected.length === 0 && (
                <p className="label-sm" data-testid={`quiz-blank-${question.id}`}>
                  You left this one blank.
                </p>
              )}
              {question.explanation && (
                <div className="flex min-w-0 flex-col gap-1 rounded-ctl border-1.5 border-edge2 bg-tint px-2.5 py-2">
                  {question.concept && (
                    <span className="label-sm font-medium" data-testid={`quiz-concept-${question.id}`}>
                      {question.concept}
                    </span>
                  )}
                  <PlainText className="text-[13px] leading-[1.65] text-ink" text={question.explanation} commentsHidden />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

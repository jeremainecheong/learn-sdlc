/**
 * One quiz's numbers as text, then its charts.
 *
 * Attempts handed in, how many of the class attempted it, passed it and have
 * not yet passed it, the pass rate, and the mean and median best score. A quiz
 * nobody has sat says so and draws nothing else.
 */
import type { ReactNode } from 'react';
import { QUIZ_RESULTS_COPY, type QuizTaskSummary } from '@learnsdlc/shared';
import { formatPercent, formatScore, quizName } from './format';

export function QuizSummaryCard({
  quiz,
  learnersInClass,
  children,
}: {
  quiz: QuizTaskSummary;
  learnersInClass: number;
  /** The quiz's charts, drawn only once someone has sat it. */
  children?: ReactNode;
}) {
  const titleId = `quiz-card-title-${quiz.project}-${quiz.phaseKey}-${quiz.taskKey}`.replace(/[^A-Za-z0-9_-]/g, '-');
  const sat = quiz.attempts > 0 || quiz.learnersAttempted > 0;
  const stats: [string, string][] = [
    ['Attempts', String(quiz.attempts)],
    ['Attempted', String(quiz.learnersAttempted)],
    ['Passed', String(quiz.learnersPassed)],
    ['Not yet passed', String(quiz.learnersNotYetPassed)],
    ['Pass rate', formatPercent(quiz.passRate)],
    ['Mean best score', formatScore(quiz.meanBestScore)],
    ['Median best score', formatScore(quiz.medianBestScore)],
  ];
  return (
    <article className="exp-panel quiz-card" data-testid={`quiz-card-${quiz.taskKey}`} aria-labelledby={titleId}>
      <h3 id={titleId}>{quizName(quiz)}</h3>
      {sat ? (
        <>
          <p className="quiz-card-line">
            {`${quiz.learnersAttempted} of ${learnersInClass} learners in the class attempted`}
          </p>
          <dl className="quiz-stats">
            {stats.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {children}
        </>
      ) : (
        <p className="quiz-card-line">{QUIZ_RESULTS_COPY.noAttempts}</p>
      )}
    </article>
  );
}

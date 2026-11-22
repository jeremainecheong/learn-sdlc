/**
 * The pass rate of every quiz in the class, one bar each.
 *
 * A bar is the learners who attempted the quiz: the part that passed in the
 * pass colour, the part not yet passed in quiet ink. A quiz nobody has sat gets
 * words, not a bar.
 */
import { QUIZ_RESULTS_COPY, type QuizTaskSummary } from '@learnsdlc/shared';
import { BarChart, type BarRow } from './BarChart';
import { formatPercent, quizIdentity, quizName } from './format';

export function PassRateChart({ quizzes }: { quizzes: QuizTaskSummary[] }) {
  const rows: BarRow[] = quizzes.map((quiz) => {
    const sat = quiz.learnersAttempted > 0;
    return {
      key: quizIdentity(quiz),
      label: quizName(quiz),
      segments: sat
        ? [
            { share: quiz.learnersPassed / quiz.learnersAttempted, tone: 'pass' },
            { share: quiz.learnersNotYetPassed / quiz.learnersAttempted, tone: 'neutral', rest: true },
          ]
        : null,
      valueText: sat ? `${formatPercent(quiz.passRate)} passed` : QUIZ_RESULTS_COPY.noAttempts,
    };
  });
  const name = `Pass rate by quiz. ${quizzes
    .map((quiz) =>
      quiz.learnersAttempted > 0
        ? `${quizName(quiz)}: ${formatPercent(quiz.passRate)} passed, ${quiz.learnersPassed} of ${quiz.learnersAttempted}.`
        : `${quizName(quiz)}: ${QUIZ_RESULTS_COPY.noAttempts}`,
    )
    .join(' ')}`;
  return (
    <section className="exp-panel quiz-section" aria-labelledby="quiz-pass-rate-title">
      <h2 id="quiz-pass-rate-title" className="quiz-section-title">
        Pass rate by quiz
      </h2>
      <p className="quiz-section-note">Learners passed out of learners who attempted.</p>
      <BarChart
        testId="quiz-pass-rate-chart"
        name={name}
        rows={rows}
        table={{
          head: ['Quiz', 'Attempted', 'Passed', 'Pass rate'],
          numeric: [false, true, true, true],
          rows: quizzes.map((quiz) => ({
            key: quizIdentity(quiz),
            cells: [
              quizName(quiz),
              String(quiz.learnersAttempted),
              String(quiz.learnersPassed),
              quiz.learnersAttempted > 0 ? formatPercent(quiz.passRate) : QUIZ_RESULTS_COPY.noAttempts,
            ],
          })),
        }}
      />
    </section>
  );
}

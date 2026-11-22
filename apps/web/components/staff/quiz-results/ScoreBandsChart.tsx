/**
 * How a quiz's best scores spread, in the five bands of
 * QUIZ_SCORE_BANDS. One learner counts once, by their best stored score. Ink
 * only: a band is not a pass or a miss, the pass mark is the quiz's own.
 */
import { QUIZ_SCORE_BANDS, pluralWord, type QuizTaskSummary } from '@learnsdlc/shared';
import { BarChart, type BarRow } from './BarChart';
import { quizName } from './format';

export function ScoreBandsChart({ quiz }: { quiz: QuizTaskSummary }) {
  if (quiz.learnersAttempted === 0) return null;
  const counts = QUIZ_SCORE_BANDS.map((band) => ({
    band: band.key,
    learners: quiz.bestScoreBands.find((one) => one.band === band.key)?.learners ?? 0,
  }));
  const whole = Math.max(quiz.learnersAttempted, ...counts.map((one) => one.learners), 1);
  const rows: BarRow[] = counts.map((one) => ({
    key: one.band,
    label: one.band,
    segments: [{ share: one.learners / whole, tone: 'neutral' }],
    valueText: String(one.learners),
  }));
  return (
    <BarChart
      testId={`quiz-bands-${quiz.taskKey}`}
      heading="Best scores in five bands"
      name={`Best scores in five bands, ${quizName(quiz)}. ${counts
        .map((one) => `${one.band}: ${one.learners} ${pluralWord(one.learners, 'learner')}.`)
        .join(' ')}`}
      rows={rows}
      table={{
        head: ['Best score', 'Learners'],
        numeric: [false, true],
        rows: counts.map((one) => ({ key: one.band, cells: [one.band, String(one.learners)] })),
      }}
    />
  );
}

/**
 * How often each question of a quiz was answered
 * right, by its questionId only (the class file's rows). It reads the id and
 * three numbers and nothing else, so no question text, option or key can reach
 * the page through it.
 */
import type { QuizTaskSummary } from '@learnsdlc/shared';
import { BarChart, type BarRow } from './BarChart';
import { formatPercent, quizName } from './format';

export function QuestionBarsChart({ quiz }: { quiz: QuizTaskSummary }) {
  if (quiz.questions.length === 0) return null;
  const questions = quiz.questions.map(({ questionId, drawn, right, percentRight }) => ({
    questionId,
    drawn,
    right,
    percentRight,
  }));
  const rows: BarRow[] = questions.map((one) => ({
    key: one.questionId,
    label: one.questionId,
    segments: one.percentRight === null ? null : [{ share: one.percentRight / 100, tone: 'neutral' }],
    valueText:
      one.percentRight === null ? 'Not drawn yet' : `${formatPercent(one.percentRight)} right (${one.right} of ${one.drawn})`,
  }));
  return (
    <BarChart
      testId={`quiz-questions-${quiz.taskKey}`}
      heading="Answered right, by question"
      name={`Answered right, by question, ${quizName(quiz)}. ${questions
        .map((one) =>
          one.percentRight === null
            ? `${one.questionId}: not drawn yet.`
            : `${one.questionId}: ${formatPercent(one.percentRight)} right, ${one.right} of ${one.drawn}.`,
        )
        .join(' ')}`}
      rows={rows}
      table={{
        head: ['Question', 'Drawn', 'Right', 'Right rate'],
        numeric: [false, true, true, true],
        rows: questions.map((one) => ({
          key: one.questionId,
          cells: [one.questionId, String(one.drawn), String(one.right), formatPercent(one.percentRight)],
        })),
      }}
    />
  );
}

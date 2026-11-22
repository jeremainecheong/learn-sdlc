/**
 * Each learner's result on each quiz, in the
 * learners file's order: attempts used, best score and whether they passed.
 *
 * By name, with no email column: the page is shown on a screen, and the
 * learners file beside it carries the email for a teacher who needs it.
 */
import type { QuizLearnerResult, QuizTaskSummary } from '@learnsdlc/shared';
import { formatScore, quizIdentity, quizName } from './format';

function passedText(passed: boolean | null): string {
  if (passed === null) return '—';
  return passed ? 'Yes' : 'Not yet';
}

export function LearnerResultsTable({
  learners,
  quizzes,
}: {
  learners: QuizLearnerResult[];
  quizzes: QuizTaskSummary[];
}) {
  if (learners.length === 0) return null;
  const names = new Map(quizzes.map((quiz) => [quizIdentity(quiz), quizName(quiz)]));
  return (
    <section className="exp-panel quiz-section" data-testid="quiz-learner-table">
      <h2 id="quiz-learners-title" className="quiz-section-title">
        Each learner
      </h2>
      <div className="quiz-table-scroll" role="region" aria-labelledby="quiz-learners-title" tabIndex={0}>
        <table className="quiz-table">
          <thead>
            <tr>
              <th scope="col">Learner</th>
              <th scope="col">Quiz</th>
              <th scope="col" className="is-number">
                Attempts used
              </th>
              <th scope="col" className="is-number">
                Best score
              </th>
              <th scope="col">Passed</th>
            </tr>
          </thead>
          <tbody>
            {learners.map((row, index) => (
              <tr key={index}>
                <th scope="row">{row.displayName}</th>
                <td>{names.get(quizIdentity(row)) ?? row.taskKey}</td>
                <td className="is-number">{String(row.attemptsUsed)}</td>
                <td className="is-number">{formatScore(row.bestScore)}</td>
                <td>{passedText(row.passed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

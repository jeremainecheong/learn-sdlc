/**
 * A quiz-results fixture as the summary route answers it.
 *
 * Class "Monday 10am", four learners in the class. `design-check` was sat by
 * three of them (A: 33.3 then 100; B: 0, 33.3, 66.7; C: 33.3 plus one voided
 * paper; D holds only an open paper, which no file counts). `deployment-check`
 * is on the class's assigned version and nobody has sat it.
 *
 * Test-only. `apps/api/src/instructor/quiz-results-summary.spec.ts` seeds the
 * same class and numbers on the API side.
 */
import type { QuizResultsSummary } from '@learnsdlc/shared';

export const FIXTURE_CLASS_ID = 'class monday/10';

export function quizFixture(): QuizResultsSummary {
  return {
    cohortId: FIXTURE_CLASS_ID,
    className: 'Monday 10am',
    learnersInClass: 4,
    quizzes: [
      {
        project: 'fixture-project',
        phaseKey: 'design',
        taskKey: 'design-check',
        title: 'Design check',
        declared: true,
        attempts: 6,
        learnersAttempted: 3,
        learnersPassed: 2,
        learnersNotYetPassed: 1,
        passRate: 67,
        meanBestScore: 66.7,
        medianBestScore: 66.7,
        bestScoreBands: [
          { band: '0-19', learners: 0 },
          { band: '20-39', learners: 1 },
          { band: '40-59', learners: 0 },
          { band: '60-79', learners: 1 },
          { band: '80-100', learners: 1 },
        ],
        questions: [
          { questionId: 'q1', drawn: 6, right: 4, percentRight: 67 },
          { questionId: 'q2', drawn: 6, right: 2, percentRight: 33 },
          { questionId: 'q3', drawn: 6, right: 2, percentRight: 33 },
        ],
      },
      {
        project: 'fixture-project',
        phaseKey: 'deployment',
        taskKey: 'deployment-check',
        title: 'Deployment check',
        declared: true,
        attempts: 0,
        learnersAttempted: 0,
        learnersPassed: 0,
        learnersNotYetPassed: 0,
        passRate: null,
        meanBestScore: null,
        medianBestScore: null,
        bestScoreBands: [
          { band: '0-19', learners: 0 },
          { band: '20-39', learners: 0 },
          { band: '40-59', learners: 0 },
          { band: '60-79', learners: 0 },
          { band: '80-100', learners: 0 },
        ],
        questions: [],
      },
    ],
    learners: [
      learner('Learner A', 'learner-a@example.test', 2, 0, 100, 100, true),
      learner('Learner B', 'learner-b@example.test', 3, 0, 66.7, 66.7, true),
      learner('Learner C', 'learner-c@example.test', 1, 1, 33.3, 33.3, false),
    ],
  };
}

function learner(
  displayName: string,
  email: string,
  attemptsUsed: number,
  attemptsVoided: number,
  bestScore: number,
  latestScore: number,
  passed: boolean,
): QuizResultsSummary['learners'][number] {
  return {
    email,
    displayName,
    project: 'fixture-project',
    phaseKey: 'design',
    taskKey: 'design-check',
    attemptsUsed,
    attemptsVoided,
    bestScore,
    latestScore,
    passed,
  };
}

/**
 * Text that must never reach the page: what a question, an option, a key or an
 * explanation would say. The summary never carries them; the tests smuggle them
 * in as extra fields to prove the page draws only the fields it names.
 */
export const SEALED_TEXT = [
  'SEALED STEM which pattern fits',
  'SEALED OPTION observer',
  'SEALED KEY b',
  'SEALED EXPLANATION because',
] as const;

/** The fixture with sealed text riding on every object the page reads. */
export function quizFixtureWithSealedText(): QuizResultsSummary {
  const summary = quizFixture();
  const [stem, option, key, explanation] = SEALED_TEXT;
  for (const quiz of summary.quizzes) {
    Object.assign(quiz, { stem, options: [option], key, explanation });
    for (const question of quiz.questions) Object.assign(question, { stem, options: [option], key, explanation });
  }
  for (const row of summary.learners) Object.assign(row, { picks: [option], key });
  return summary;
}

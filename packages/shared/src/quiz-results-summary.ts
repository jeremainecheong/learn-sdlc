/**
 * The shared contract for a class's quiz-results dashboard.
 *
 * A teacher's class gets a quiz-results dashboard: charts and a table drawn
 * from one JSON read that sits beside the four quiz-results CSVs and agrees
 * with them value for value. The API's summary route answers
 * `QuizResultsSummary`; the web page draws it. Nothing here grades, regrades
 * or reads a sealed key: every number is a count or a stored score the CSVs
 * already carry.
 *
 * Rules this file keeps:
 *
 * - **Append only.** Add names; never rename one.
 * - **No imports.** It needs nothing from a sibling module.
 */

/* ============ The class quiz-results summary (one JSON read beside the four CSVs) ============ */

/** Best-score bands, low to high; `from` inclusive, `below` exclusive (the top band holds 100). */
export const QUIZ_SCORE_BANDS = Object.freeze([
  Object.freeze({ key: '0-19', from: 0, below: 20 }),
  Object.freeze({ key: '20-39', from: 20, below: 40 }),
  Object.freeze({ key: '40-59', from: 40, below: 60 }),
  Object.freeze({ key: '60-79', from: 60, below: 80 }),
  Object.freeze({ key: '80-100', from: 80, below: 101 }),
] as const);
export type QuizScoreBandKey = (typeof QUIZ_SCORE_BANDS)[number]['key'];

/**
 * The band a stored 0..100 score falls in.
 *
 * A score below 0 counts in the first band and one above 100 in the last, so
 * a stray stored value is still drawn somewhere rather than dropped. NaN is
 * not a score and throws: a caller skips a blank before it asks.
 */
export function quizScoreBand(score: number): QuizScoreBandKey {
  if (Number.isNaN(score)) throw new RangeError('quizScoreBand: a score must be a number, not NaN');
  const first = QUIZ_SCORE_BANDS[0];
  const last = QUIZ_SCORE_BANDS[QUIZ_SCORE_BANDS.length - 1];
  if (score < first.from) return first.key;
  for (const band of QUIZ_SCORE_BANDS) {
    if (score >= band.from && score < band.below) return band.key;
  }
  return last.key;
}

/** GET /instructor/quiz-results/summary?cohort=<classId>[&project=<slug>] */
export interface QuizResultsSummary {
  cohortId: string;
  /** The class's name; null for the unattached learners (admin only) or a nameless class. */
  className: string | null;
  /** Learners in this class (the CSVs' scope narrowed to it), whatever they have sat. */
  learnersInClass: number;
  /** One per project × quiz task; ordered project, phase order, taskKey (quiz-class.csv's order). */
  quizzes: QuizTaskSummary[];
  /** quiz-learners.csv's rows for this class, same order and values. */
  learners: QuizLearnerResult[];
}

export interface QuizTaskSummary {
  project: string;
  phaseKey: string;
  taskKey: string;
  /** The task's title on the version read; null when it cannot be read. */
  title: string | null;
  /** On the class's assigned version. False when only papers name it. */
  declared: boolean;
  /** Handed-in papers, voided excluded (= Σ learners.csv `attempts used` = attempts.csv rows with status `submitted`). */
  attempts: number;
  /** = quiz-class.csv `learners attempted`. */
  learnersAttempted: number;
  /** = quiz-class.csv `learners passed` (= learners.csv rows with passed `yes`). */
  learnersPassed: number;
  /** learnersAttempted − learnersPassed. */
  learnersNotYetPassed: number;
  /** Math.round(100 × passed / attempted); null when attempted is 0. */
  passRate: number | null;
  /** Over each attempting learner's learners.csv `best score` (blanks skipped), rounded to one decimal; null when none. */
  meanBestScore: number | null;
  /** As `meanBestScore`, the median: over the same best scores, rounded to one decimal; null when none. */
  medianBestScore: number | null;
  /** Learners per best-score band; all five bands, QUIZ_SCORE_BANDS order, zeros included. */
  bestScoreBands: { band: QuizScoreBandKey; learners: number }[];
  /** quiz-class.csv's rows for this task, same order and values (`percentRight` null where the CSV is blank). */
  questions: { questionId: string; drawn: number; right: number; percentRight: number | null }[];
}

export interface QuizLearnerResult {
  email: string;
  displayName: string;
  project: string;
  phaseKey: string;
  taskKey: string;
  attemptsUsed: number;
  attemptsVoided: number;
  bestScore: number | null;
  latestScore: number | null;
  /** learners.csv `passed`: yes → true, no → false, blank → null. */
  passed: boolean | null;
}

/** The fixed copy of the page (lint-clean, no course named). `noQuizzesCut` is an alternative empty-state line for a page that lists only handed-in quizzes; the page does not use it. */
export const QUIZ_RESULTS_COPY = Object.freeze({
  link: 'Quiz results',
  eyebrow: 'Quiz results',
  back: 'Back to class',
  noLearners: 'No learners have joined this class yet.',
  noQuizzes: "This class's project has no quiz yet.",
  noQuizzesCut: 'No quiz has been handed in by this class yet.',
  noAttempts: 'No attempts yet.',
  bestScoreNote: "Scores are each learner's best stored score. Nothing is regraded.",
  downloads: 'Download this class as CSV',
} as const);

/**
 * The class quiz-results contract.
 *
 * `quiz-results-summary.ts` is the class quiz-results summary: one JSON read beside the
 * four quiz-results CSVs, which the teacher's quiz dashboard draws. The API's
 * summary route and the web page both code against it, so a value or a key
 * that drifts fails here before either side trusts it:
 *
 * - (a) The five best-score bands, in order, and `quizScoreBand` at every
 *   boundary (`from` inclusive, `below` exclusive, 100 in the top band).
 * - (b) The band list, each band and the page copy are frozen.
 * - (c) The summary's shapes hold exactly their declared keys, and a learner's
 *   row is named for nothing sealed (no key, answer, stem, option,
 *   explanation, id or uuid).
 * - (d) The page copy is the nine strings, each non-empty, copy-lint clean
 *   and naming no course.
 * - (e) The package index exports every runtime name of quiz-results-summary.ts as the
 *   very same value, so nothing is shadowed.
 *
 * The type-level assertions are real assertions: ts-jest compiles this file
 * with diagnostics on, so a member that appears or disappears is a failed
 * compile of this suite.
 */

import {
  QUIZ_RESULTS_COPY,
  QUIZ_SCORE_BANDS,
  quizScoreBand,
  type QuizLearnerResult,
  type QuizResultsSummary,
  type QuizScoreBandKey,
  type QuizTaskSummary,
} from './index';
import * as shared from './index';
import * as quizResultsSummary from './quiz-results-summary';

/** True exactly when `K` may be left out of a `T`: an optional field. */
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

/** True exactly when `T`'s members are `K`, no more and no fewer, optional ones included. */
type HasExactlyKeys<T, K extends PropertyKey> = [keyof T] extends [K]
  ? [K] extends [keyof T]
    ? true
    : false
  : false;

/** True exactly when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * The web's copy lint (apps/web/scripts/copy-lint.mjs) for one string, as the
 * teacher-path contract spec (teacher-path.spec.ts) writes it: no
 * pipe or middle dot standing in for a word,
 * and it opens as a sentence does. Plus the product rule that no copy names a
 * course, a module or the reference project.
 */
function copyLintFindings(text: string): string[] {
  const out: string[] = [];
  if (text.trim() === '') out.push('empty');
  if (/[·|]/.test(text)) out.push('separator');
  if (!/^[A-Z0-9"“']/.test(text)) out.push('not a sentence start');
  if (/\b(course|module|CS\d{3,4}|TaskTrackr)\b/i.test(text)) out.push('names a course, module or the reference project');
  return out;
}

/* -------------------------------- (a) the bands -------------------------------- */

describe('(a) five best-score bands, low to high, and the band a score falls in', () => {
  it('the band keys are exactly the five, in order', () => {
    const keyed: true = true satisfies Equals<QuizScoreBandKey, '0-19' | '20-39' | '40-59' | '60-79' | '80-100'>;
    expect(keyed).toBe(true);
    expect(QUIZ_SCORE_BANDS.map((band) => band.key)).toEqual(['0-19', '20-39', '40-59', '60-79', '80-100']);
  });

  it('each band is `from` inclusive to `below` exclusive, contiguous, and the top band holds 100', () => {
    expect(QUIZ_SCORE_BANDS.map((band) => [band.from, band.below])).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
      [60, 80],
      [80, 101],
    ]);
    for (let at = 1; at < QUIZ_SCORE_BANDS.length; at += 1) {
      expect(QUIZ_SCORE_BANDS[at].from).toBe(QUIZ_SCORE_BANDS[at - 1].below);
    }
    for (const band of QUIZ_SCORE_BANDS) expect(Object.keys(band).sort()).toEqual(['below', 'from', 'key']);
  });

  it.each<[number, QuizScoreBandKey]>([
    [0, '0-19'],
    [19.99, '0-19'],
    [20, '20-39'],
    [33.3, '20-39'],
    [39.9, '20-39'],
    [40, '40-59'],
    [59.99, '40-59'],
    [60, '60-79'],
    [66.7, '60-79'],
    [79.99, '60-79'],
    [80, '80-100'],
    [100, '80-100'],
  ])('a stored score of %p falls in %s', (score, band) => {
    expect(quizScoreBand(score)).toBe(band);
  });

  it('clamps below 0 to the first band and above 100 to the last', () => {
    expect(quizScoreBand(-0.1)).toBe('0-19');
    expect(quizScoreBand(-50)).toBe('0-19');
    expect(quizScoreBand(-Infinity)).toBe('0-19');
    expect(quizScoreBand(100.5)).toBe('80-100');
    expect(quizScoreBand(101)).toBe('80-100');
    expect(quizScoreBand(Infinity)).toBe('80-100');
  });

  it('throws on NaN', () => {
    expect(() => quizScoreBand(Number.NaN)).toThrow();
  });
});

/* ------------------------------- (b) frozen values ------------------------------- */

describe('(b) the bands and the copy are frozen', () => {
  it('the band list and every band are frozen', () => {
    expect(Object.isFrozen(QUIZ_SCORE_BANDS)).toBe(true);
    for (const band of QUIZ_SCORE_BANDS) expect([band.key, Object.isFrozen(band)]).toEqual([band.key, true]);
  });

  it('QUIZ_RESULTS_COPY is frozen', () => {
    expect(Object.isFrozen(QUIZ_RESULTS_COPY)).toBe(true);
  });
});

/* ------------------------------ (c) the summary shapes ------------------------------ */

describe('(c) the summary holds exactly its declared keys, and a learner row names nothing sealed', () => {
  it('QuizResultsSummary, QuizTaskSummary and QuizLearnerResult have exactly their keys, none optional', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<QuizResultsSummary, 'cohortId' | 'className' | 'learnersInClass' | 'quizzes' | 'learners'>,
      true satisfies HasExactlyKeys<
        QuizTaskSummary,
        | 'project'
        | 'phaseKey'
        | 'taskKey'
        | 'title'
        | 'declared'
        | 'attempts'
        | 'learnersAttempted'
        | 'learnersPassed'
        | 'learnersNotYetPassed'
        | 'passRate'
        | 'meanBestScore'
        | 'medianBestScore'
        | 'bestScoreBands'
        | 'questions'
      >,
      true satisfies HasExactlyKeys<
        QuizLearnerResult,
        | 'email'
        | 'displayName'
        | 'project'
        | 'phaseKey'
        | 'taskKey'
        | 'attemptsUsed'
        | 'attemptsVoided'
        | 'bestScore'
        | 'latestScore'
        | 'passed'
      >,
      true satisfies Equals<IsOptional<QuizTaskSummary, 'title'>, false>,
      true satisfies Equals<IsOptional<QuizResultsSummary, 'className'>, false>,
    ];
    expect(exact).toHaveLength(5);
  });

  it('the shapes nest and carry their declared value types', () => {
    const typed: true[] = [
      true satisfies Equals<QuizResultsSummary['quizzes'], QuizTaskSummary[]>,
      true satisfies Equals<QuizResultsSummary['learners'], QuizLearnerResult[]>,
      true satisfies Equals<QuizResultsSummary['className'], string | null>,
      true satisfies Equals<QuizTaskSummary['title'], string | null>,
      true satisfies Equals<QuizTaskSummary['declared'], boolean>,
      true satisfies Equals<QuizTaskSummary['passRate'], number | null>,
      true satisfies Equals<QuizTaskSummary['meanBestScore'], number | null>,
      true satisfies Equals<QuizTaskSummary['medianBestScore'], number | null>,
      true satisfies Equals<QuizTaskSummary['bestScoreBands'], { band: QuizScoreBandKey; learners: number }[]>,
      true satisfies Equals<
        QuizTaskSummary['questions'],
        { questionId: string; drawn: number; right: number; percentRight: number | null }[]
      >,
      true satisfies Equals<QuizLearnerResult['bestScore'], number | null>,
      true satisfies Equals<QuizLearnerResult['latestScore'], number | null>,
      true satisfies Equals<QuizLearnerResult['passed'], boolean | null>,
    ];
    expect(typed).toHaveLength(13);
  });

  it('no key of a learner row is named like key, answer, stem, option, explanation, id or uuid', () => {
    type SealedLike =
      | `${string}${'key' | 'Key'}${string}`
      | `${string}${'answer' | 'Answer'}${string}`
      | `${string}${'stem' | 'Stem'}${string}`
      | `${string}${'option' | 'Option'}${string}`
      | `${string}${'explanation' | 'Explanation'}${string}`
      | 'id'
      | `${string}Id`
      | `${string}${'uuid' | 'Uuid' | 'UUID'}${string}`;
    // `phaseKey` and `taskKey` are the CSVs' own columns, not a sealed key; every other key is checked.
    type Checked = Exclude<keyof QuizLearnerResult, 'phaseKey' | 'taskKey'>;
    const none: true = true satisfies Equals<Extract<Checked, SealedLike>, never>;
    expect(none).toBe(true);
    const sealed: true = true satisfies Equals<
      Extract<keyof QuizLearnerResult, 'key' | 'answer' | 'stem' | 'option' | 'options' | 'explanation' | 'id' | 'uuid' | 'correct'>,
      never
    >;
    expect(sealed).toBe(true);
  });
});

/* -------------------------------- (d) the page copy -------------------------------- */

describe('(d) the page copy is nine strings, each copy-lint clean and naming no course', () => {
  it('holds exactly the nine keys', () => {
    const exact: true = true satisfies HasExactlyKeys<
      typeof QUIZ_RESULTS_COPY,
      | 'link'
      | 'eyebrow'
      | 'back'
      | 'noLearners'
      | 'noQuizzes'
      | 'noQuizzesCut'
      | 'noAttempts'
      | 'bestScoreNote'
      | 'downloads'
    >;
    expect(exact).toBe(true);
    expect(Object.keys(QUIZ_RESULTS_COPY)).toHaveLength(9);
  });

  it.each(Object.entries(QUIZ_RESULTS_COPY))('%s is non-empty and copy-lint clean', (_key, line) => {
    expect(typeof line).toBe('string');
    expect(line.trim().length).toBeGreaterThan(0);
    expect(copyLintFindings(line)).toEqual([]);
  });
});

/* ------------------------ (e) the package index exports it all ------------------------ */

describe('(e) the package index exports quiz-results-summary.ts, and nothing is shadowed', () => {
  const RUNTIME_EXPORTS = ['QUIZ_RESULTS_COPY', 'QUIZ_SCORE_BANDS', 'quizScoreBand'];
  const ownNames = Object.keys(quizResultsSummary).filter((key) => key !== '__esModule');

  it('quiz-results-summary.ts exports exactly these runtime names', () => {
    expect([...ownNames].sort()).toEqual([...RUNTIME_EXPORTS].sort());
  });

  it('the index exports every runtime name of quiz-results-summary.ts as the very same value', () => {
    const index = shared as unknown as Record<string, unknown>;
    const own = quizResultsSummary as unknown as Record<string, unknown>;
    for (const name of ownNames) expect([name, index[name] === own[name]]).toEqual([name, true]);
  });
});

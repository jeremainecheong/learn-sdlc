/**
 * The limits a web form and an API DTO both enforce, and the small shared
 * helpers both apps read: each value pinned, so a change is a deliberate edit
 * here as well as in the module.
 */

import {
  AI_BROWSER_DEADLINE_MS,
  AI_ROUTE_BUDGET_MS,
  ASSIGNMENT_REASON_MAX,
  CLASS_NAME_MAX,
  CLASS_NAME_MIN,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  DRILL_ANSWER_MAX,
  DRILL_ANSWER_MIN,
  EXPORT_WITHHELD_HEADER,
  INSTRUCTOR_NOTE_MAX,
  INSTRUCTOR_NOTE_MIN,
  MIN_TESTS_MAX,
  OVERRIDE_REASON_MIN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROFILE_BIO_MAX,
  PROFILE_GOALS_MAX,
  PROJECT_TITLE_MAX,
  REQUEST_ID_HEADER,
  RUNBOOK_CAPS,
  STARTER_ARCHIVES,
  STARTER_ARCHIVE_NAMES,
  STUCK_ANSWER_MAX,
  STUCK_ANSWER_MIN,
  STUCK_QUESTION_MAX,
  STUCK_QUESTION_MIN,
  STUCK_TRIED_MAX,
  TASK_KEY_MAX_LENGTH,
  TASK_KEY_PATTERN,
  TEACHER_FEEDBACK_MAX,
  TEACHER_FEEDBACK_MIN,
  numberWord,
  pluralWord,
  reviewerVerdictIsAdvice,
  withThousands,
} from './index';

describe('form and DTO limits', () => {
  it('holds every limit at the value the API validates', () => {
    expect({
      PASSWORD_MIN_LENGTH,
      PASSWORD_MAX_LENGTH,
      DISPLAY_NAME_MIN,
      DISPLAY_NAME_MAX,
      PROFILE_BIO_MAX,
      PROFILE_GOALS_MAX,
      STUCK_QUESTION_MIN,
      STUCK_QUESTION_MAX,
      STUCK_TRIED_MAX,
      STUCK_ANSWER_MIN,
      STUCK_ANSWER_MAX,
      DRILL_ANSWER_MIN,
      DRILL_ANSWER_MAX,
      CLASS_NAME_MIN,
      CLASS_NAME_MAX,
      INSTRUCTOR_NOTE_MIN,
      INSTRUCTOR_NOTE_MAX,
      TEACHER_FEEDBACK_MIN,
      TEACHER_FEEDBACK_MAX,
      OVERRIDE_REASON_MIN,
      ASSIGNMENT_REASON_MAX,
      PROJECT_TITLE_MAX,
      MIN_TESTS_MAX,
    }).toEqual({
      PASSWORD_MIN_LENGTH: 8,
      PASSWORD_MAX_LENGTH: 100,
      DISPLAY_NAME_MIN: 2,
      DISPLAY_NAME_MAX: 60,
      PROFILE_BIO_MAX: 1000,
      PROFILE_GOALS_MAX: 1000,
      STUCK_QUESTION_MIN: 10,
      STUCK_QUESTION_MAX: 400,
      STUCK_TRIED_MAX: 400,
      STUCK_ANSWER_MIN: 10,
      STUCK_ANSWER_MAX: 1000,
      DRILL_ANSWER_MIN: 20,
      DRILL_ANSWER_MAX: 2000,
      CLASS_NAME_MIN: 2,
      CLASS_NAME_MAX: 80,
      INSTRUCTOR_NOTE_MIN: 10,
      INSTRUCTOR_NOTE_MAX: 500,
      TEACHER_FEEDBACK_MIN: 2,
      TEACHER_FEEDBACK_MAX: 4000,
      OVERRIDE_REASON_MIN: 10,
      ASSIGNMENT_REASON_MAX: 1000,
      PROJECT_TITLE_MAX: 120,
      MIN_TESTS_MAX: 500,
    });
  });

  it('caps a drill answer at the runbook record field cap', () => {
    expect(DRILL_ANSWER_MAX).toBe(RUNBOOK_CAPS.fieldChars);
  });

  it('caps an authored task key at the length its pattern accepts', () => {
    expect(TASK_KEY_MAX_LENGTH).toBe(32);
    expect(TASK_KEY_PATTERN.test(`a${'b'.repeat(TASK_KEY_MAX_LENGTH - 1)}`)).toBe(true);
    expect(TASK_KEY_PATTERN.test(`a${'b'.repeat(TASK_KEY_MAX_LENGTH)}`)).toBe(false);
  });
});

describe('the HTTP exchange', () => {
  it('names the two response headers both apps read', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
    expect(EXPORT_WITHHELD_HEADER).toBe('x-export-withheld');
  });

  it("keeps an AI route's budget under the browser's deadline", () => {
    expect(AI_ROUTE_BUDGET_MS).toBe(55_000);
    expect(AI_BROWSER_DEADLINE_MS).toBe(60_000);
    expect(AI_ROUTE_BUDGET_MS).toBeLessThan(AI_BROWSER_DEADLINE_MS);
  });
});

describe('the starter archive names', () => {
  it('lists the two downloads in guide order, frozen', () => {
    expect(STARTER_ARCHIVE_NAMES).toEqual(['starter', 'shelf']);
    expect(STARTER_ARCHIVE_NAMES).toEqual([...STARTER_ARCHIVES]);
    expect(Object.isFrozen(STARTER_ARCHIVE_NAMES)).toBe(true);
  });
});

describe('reviewerVerdictIsAdvice', () => {
  const met = (...flags: boolean[]) => flags.map((flag) => ({ met: flag }));

  it('is advice only at exactly 100 with strictly more than half the criteria met', () => {
    expect(reviewerVerdictIsAdvice(100, met(true, true, false))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(true, true))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(true))).toBe(true);
    expect(reviewerVerdictIsAdvice(100, met(true, false))).toBe(false);
    expect(reviewerVerdictIsAdvice(100, met(true, false, false))).toBe(false);
    expect(reviewerVerdictIsAdvice(100, [])).toBe(false);
  });

  it('is never advice below 100 or without a score', () => {
    expect(reviewerVerdictIsAdvice(99, met(true, true, true))).toBe(false);
    expect(reviewerVerdictIsAdvice(undefined, met(true))).toBe(false);
    expect(reviewerVerdictIsAdvice(null, met(true))).toBe(false);
  });
});

describe('counts in a sentence', () => {
  it('writes zero to twelve as words and larger numbers as digits', () => {
    expect([0, 1, 2, 10, 12, 13].map((n) => numberWord(n))).toEqual(['no', 'one', 'two', 'ten', 'twelve', '13']);
  });

  it("writes digits past the caller's own bound", () => {
    expect(numberWord(6, 6)).toBe('six');
    expect(numberWord(7, 6)).toBe('7');
    expect(numberWord(10, 10)).toBe('ten');
    expect(numberWord(11, 10)).toBe('11');
  });

  it('writes digits for a negative or fractional count', () => {
    expect(numberWord(-1)).toBe('-1');
    expect(numberWord(1.5)).toBe('1.5');
  });

  it('chooses the singular for 1 and the plural for any other count', () => {
    expect(pluralWord(1, 'test', 'tests')).toBe('test');
    expect(pluralWord(0, 'test', 'tests')).toBe('tests');
    expect(pluralWord(2, 'entry', 'entries')).toBe('entries');
    expect(pluralWord(3, 'file')).toBe('files');
  });

  it('groups a large number in thousands with commas, whatever the locale', () => {
    expect([0, 999, 1000, 2000, 1234567].map(withThousands)).toEqual(['0', '999', '1,000', '2,000', '1,234,567']);
  });
});

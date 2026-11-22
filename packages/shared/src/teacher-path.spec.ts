/**
 * The teacher-path contract.
 *
 * `teacher-path.ts` is four regions. This spec holds the four things the API and
 * the web app read from it, so a value that drifts fails here before either
 * side trusts it:
 *
 * - (a) `UPLOAD_REFUSAL_HELP` is keyed on exactly the 29 wire codes of
 *   `UPLOAD_REFUSAL_CODES`, and every title and fix is non-empty
 *   and passes the web's copy lint (no pipe or middle dot, a sentence's start).
 * - (b) The upload answers `ProjectUploadResultWithWarnings`: `ProjectUploadResult`'s
 *   six keys plus optional `warnings`. `ProjectUploadResult` itself keeps
 *   its six keys, so `upload-contract.spec.ts` and the recorded upload
 *   exchange stay byte-identical.
 * - (c) The learner preview's shapes hold exactly their allowed keys, and none
 *   is named for sealed content.
 * - (d) The two staff downloads, `['starter', 'shelf']`.
 *
 * The index block pins the names teacher-path.ts must export and checks every
 * name it exports reaches the index unshadowed, as the very same value.
 *
 * The type-level assertions are real assertions: ts-jest compiles this file
 * with diagnostics on, so a member that appears or a key that stops being
 * optional is a failed compile of this suite.
 */

import {
  LEARNER_PREVIEW_FILE_KEYS,
  LEARNER_PREVIEW_FORBIDDEN_KEYS,
  LEARNER_PREVIEW_INTERVIEW_KEYS,
  LEARNER_PREVIEW_PHASE_KEYS,
  LEARNER_PREVIEW_QUESTION_KEYS,
  LEARNER_PREVIEW_QUIZ_KEYS,
  LEARNER_PREVIEW_TASK_KEYS,
  LEARNER_PREVIEW_VIEW_KEYS,
  STARTER_ARCHIVES,
  UPLOAD_REFUSAL_CODES,
  UPLOAD_REFUSAL_FALLBACK,
  UPLOAD_REFUSAL_HELP,
  type LearnerPreviewFile,
  type LearnerPreviewInterview,
  type LearnerPreviewPhase,
  type LearnerPreviewQuiz,
  type LearnerPreviewQuizQuestion,
  type LearnerPreviewTask,
  type LearnerPreviewView,
  type ProjectUploadResult,
  type ProjectUploadResultWithWarnings,
  type StarterArchiveName,
  type UploadRefusalCode,
} from './index';
import * as shared from './index';
import * as teacherPath from './teacher-path';

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
 * The web's copy lint (apps/web/scripts/copy-lint.mjs) for one string: no pipe
 * or middle dot standing in for a word, and it opens as a sentence does. Plus
 * the product rule that no copy names a course, a module or the reference
 * project.
 */
function copyLintFindings(text: string): string[] {
  const out: string[] = [];
  if (text.trim() === '') out.push('empty');
  if (/[·|]/.test(text)) out.push('separator');
  if (!/^[A-Z0-9"“']/.test(text)) out.push('not a sentence start');
  if (/\b(course|module|CS\d{3,4}|TaskTrackr)\b/i.test(text)) out.push('names a course, module or the reference project');
  return out;
}

/* ------------------------------ (a) refusal help ------------------------------ */

describe('(a) the refusal help is keyed on the 29 wire codes', () => {
  it('has exactly the keys of UPLOAD_REFUSAL_CODES, no more and no fewer', () => {
    const keyed: true = true satisfies Equals<keyof typeof UPLOAD_REFUSAL_HELP, UploadRefusalCode>;
    expect(keyed).toBe(true);
    expect(UPLOAD_REFUSAL_CODES).toHaveLength(29);
    expect(UPLOAD_REFUSAL_CODES).toContain('ZIP64_OR_SIZE_MISMATCH');
    expect(Object.keys(UPLOAD_REFUSAL_HELP).sort()).toEqual([...UPLOAD_REFUSAL_CODES].sort());
  });

  it('holds none of the six internal pack/archive codes the door maps to wire codes', () => {
    for (const internal of [
      'PACK_INVALID',
      'PACK_NOT_TEXT',
      'PACK_COMPILE',
      'UPLOAD_TITLE_INVALID',
      'ARCHIVE_NOT_BASE64',
      'ARCHIVE_MALFORMED',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(UPLOAD_REFUSAL_HELP, internal)).toBe(false);
    }
  });

  it.each([...UPLOAD_REFUSAL_CODES])('%s: a title and a fix, each non-empty and copy-lint clean, and a guide anchor', (code) => {
    const help = UPLOAD_REFUSAL_HELP[code];
    expect(Object.keys(help).sort()).toEqual(['fix', 'guideAnchor', 'title']);
    expect(copyLintFindings(help.title)).toEqual([]);
    expect(copyLintFindings(help.fix)).toEqual([]);
    expect(help.fix.trim().length).toBeGreaterThan(0);
    expect(help.guideAnchor).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('the fallback for an answer with no code is copy-lint clean and is not one of the codes', () => {
    expect(copyLintFindings(UPLOAD_REFUSAL_FALLBACK.title)).toEqual([]);
    expect(copyLintFindings(UPLOAD_REFUSAL_FALLBACK.fix)).toEqual([]);
    expect(UPLOAD_REFUSAL_FALLBACK.guideAnchor).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(Object.values(UPLOAD_REFUSAL_HELP)).not.toContain(UPLOAD_REFUSAL_FALLBACK);
  });
});

/* ---------------------------- (b) the upload result ---------------------------- */

describe('(b) the upload result adds optional warnings, and the upload\'s own result is unchanged', () => {
  it('ProjectUploadResultWithWarnings is the six upload keys plus optional warnings', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<
        ProjectUploadResultWithWarnings,
        'projectId' | 'versionId' | 'slug' | 'version' | 'compile' | 'validation' | 'warnings'
      >,
      true satisfies IsOptional<ProjectUploadResultWithWarnings, 'warnings'>,
      true satisfies Equals<NonNullable<ProjectUploadResultWithWarnings['warnings']>, string[]>,
      true satisfies Equals<Omit<ProjectUploadResultWithWarnings, 'warnings'>, ProjectUploadResult>,
    ];
    expect(exact).toHaveLength(4);
  });

  it('ProjectUploadResult still holds exactly its six keys, with no warnings', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<
        ProjectUploadResult,
        'projectId' | 'versionId' | 'slug' | 'version' | 'compile' | 'validation'
      >,
      true satisfies Equals<'warnings' extends keyof ProjectUploadResult ? true : false, false>,
    ];
    expect(exact).toHaveLength(2);
    // A result with no warnings still has the extension's shape: the key is absent, not null.
    const plain = {} as ProjectUploadResult;
    const widened: ProjectUploadResultWithWarnings = plain;
    expect(widened).toBe(plain);
  });
});

/* --------------------------- (c) the learner preview --------------------------- */

describe('(c) the learner preview holds exactly its allowed keys, and none names sealed content', () => {
  it('every preview shape has exactly the keys of its list', () => {
    const exact: true[] = [
      true satisfies HasExactlyKeys<LearnerPreviewView, (typeof LEARNER_PREVIEW_VIEW_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewPhase, (typeof LEARNER_PREVIEW_PHASE_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewFile, (typeof LEARNER_PREVIEW_FILE_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewTask, (typeof LEARNER_PREVIEW_TASK_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewQuiz, (typeof LEARNER_PREVIEW_QUIZ_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewQuizQuestion, (typeof LEARNER_PREVIEW_QUESTION_KEYS)[number]>,
      true satisfies HasExactlyKeys<LearnerPreviewInterview, (typeof LEARNER_PREVIEW_INTERVIEW_KEYS)[number]>,
    ];
    expect(exact).toHaveLength(7);
  });

  it('the shapes nest as the view is drawn: view, phases, then files, tasks, quizzes, questions and the interview card', () => {
    const nested: true[] = [
      true satisfies Equals<LearnerPreviewView['phases'], LearnerPreviewPhase[]>,
      true satisfies Equals<LearnerPreviewPhase['files'], LearnerPreviewFile[]>,
      true satisfies Equals<LearnerPreviewPhase['tasks'], LearnerPreviewTask[]>,
      true satisfies Equals<LearnerPreviewPhase['quizzes'], LearnerPreviewQuiz[]>,
      true satisfies Equals<LearnerPreviewQuiz['questions'], LearnerPreviewQuizQuestion[]>,
      true satisfies Equals<LearnerPreviewPhase['interview'], LearnerPreviewInterview | null>,
      true satisfies HasExactlyKeys<LearnerPreviewInterview['persona'], 'name' | 'role'>,
    ];
    expect(nested).toHaveLength(7);
  });

  it('no key of any preview shape, at any depth, is a forbidden (sealed or scoring) name', () => {
    type AnyPreviewKey =
      | keyof LearnerPreviewView
      | keyof LearnerPreviewPhase
      | keyof LearnerPreviewFile
      | keyof LearnerPreviewTask
      | keyof LearnerPreviewQuiz
      | keyof LearnerPreviewQuizQuestion
      | keyof LearnerPreviewInterview
      | keyof LearnerPreviewInterview['persona'];
    const none: true = true satisfies Equals<
      Extract<AnyPreviewKey, (typeof LEARNER_PREVIEW_FORBIDDEN_KEYS)[number]>,
      never
    >;
    expect(none).toBe(true);

    const allowed = [
      ...LEARNER_PREVIEW_VIEW_KEYS,
      ...LEARNER_PREVIEW_PHASE_KEYS,
      ...LEARNER_PREVIEW_FILE_KEYS,
      ...LEARNER_PREVIEW_TASK_KEYS,
      ...LEARNER_PREVIEW_QUIZ_KEYS,
      ...LEARNER_PREVIEW_QUESTION_KEYS,
      ...LEARNER_PREVIEW_INTERVIEW_KEYS,
      'name',
      'role',
    ] as string[];
    const forbidden = new Set<string>(LEARNER_PREVIEW_FORBIDDEN_KEYS);
    expect(allowed.filter((key) => forbidden.has(key))).toEqual([]);
  });

  it('the forbidden list names every sealed store, and each allowed list has no repeat', () => {
    const forbidden = new Set<string>(LEARNER_PREVIEW_FORBIDDEN_KEYS);
    for (const name of [
      'checks',
      'hidden',
      'solution',
      'reference',
      'impl',
      'mutants',
      'drill',
      'facts',
      'answer',
      'keywords',
      'correct',
      'explanation',
      'rubric',
      'unknownReply',
      'refusal',
      'systemPrompt',
    ]) {
      expect([name, forbidden.has(name)]).toEqual([name, true]);
    }
    for (const list of [
      LEARNER_PREVIEW_VIEW_KEYS,
      LEARNER_PREVIEW_PHASE_KEYS,
      LEARNER_PREVIEW_FILE_KEYS,
      LEARNER_PREVIEW_TASK_KEYS,
      LEARNER_PREVIEW_QUIZ_KEYS,
      LEARNER_PREVIEW_QUESTION_KEYS,
      LEARNER_PREVIEW_INTERVIEW_KEYS,
      LEARNER_PREVIEW_FORBIDDEN_KEYS,
    ] as readonly (readonly string[])[]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

/* ---------------------------- (d) the staff downloads ---------------------------- */

describe('(d) the starter downloads', () => {
  it("are exactly ['starter', 'shelf'], in the order the guide lists them", () => {
    const exact: true[] = [
      true satisfies Equals<StarterArchiveName, 'starter' | 'shelf'>,
      true satisfies Equals<typeof STARTER_ARCHIVES, readonly ['starter', 'shelf']>,
    ];
    expect(exact).toHaveLength(2);
    expect([...STARTER_ARCHIVES]).toEqual(['starter', 'shelf']);
  });
});

/* ------------------------ the package index exports it all ------------------------ */

describe('the package index exports teacher-path.ts, and nothing is shadowed', () => {
  /** The runtime names teacher-path.ts is pinned to export. A rename or a removal is a red here; an append is not. */
  const RUNTIME_EXPORTS = [
    'GUIDE_STEPS',
    'GUIDE_STEP_KEYS',
    'INLINE_HELP',
    'INLINE_HELP_KEYS',
    'LEARNER_PREVIEW_FILE_KEYS',
    'LEARNER_PREVIEW_FORBIDDEN_KEYS',
    'LEARNER_PREVIEW_INTERVIEW_KEYS',
    'LEARNER_PREVIEW_PHASE_KEYS',
    'LEARNER_PREVIEW_QUESTION_KEYS',
    'LEARNER_PREVIEW_QUIZ_KEYS',
    'LEARNER_PREVIEW_TASK_KEYS',
    'LEARNER_PREVIEW_VIEW_KEYS',
    'NO_INTERVIEW_HINT',
    'PREVIEW_STEP_HELP',
    'STARTER_ARCHIVES',
    'STARTER_WARNING',
    'TEACHER_GUIDE_OWN_SECTIONS',
    'TEACHER_GUIDE_PATH',
    'UPLOAD_REFUSAL_FALLBACK',
    'UPLOAD_REFUSAL_HELP',
    'UPLOAD_WARNINGS_SENTENCE',
  ];

  /** Every runtime name teacher-path.ts exports, the pinned ones and any appended after them. */
  const ownNames = Object.keys(teacherPath).filter((key) => key !== '__esModule');

  it('teacher-path.ts exports every one of these runtime names', () => {
    expect(RUNTIME_EXPORTS.filter((name) => !ownNames.includes(name))).toEqual([]);
  });

  it('the index exports every runtime name of teacher-path.ts as the very same value', () => {
    const index = shared as unknown as Record<string, unknown>;
    const own = teacherPath as unknown as Record<string, unknown>;
    for (const name of ownNames) expect([name, index[name] === own[name]]).toEqual([name, true]);
  });
});

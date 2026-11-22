import {
  ARTEFACT_PATH_CHECK_ID,
  EXECUTABLE_SPLIT_NOT_READY,
  MULTI_TASK_CHECK_ID,
  REQUIRED_TASK_CHECK_ID,
  SUPPORTED_STACK_CHECK_ID,
  duplicateArtefactPathRefusal,
  multiTaskPublishRefusal,
  noRequiredTaskRefusal,
  notApplicableLine,
  refusesMultiTaskPublish,
  unsupportedLibraryRefusal,
} from '@learnsdlc/shared';
// The whole authoring module, so the safety gate's open arm can be driven
// here. Nothing else in this file reads it.
import type { SupportedStacks, ValidationCheck, ValidationReport } from '@learnsdlc/shared';
import { fixtureQuizChecks, fixtureQuizQuestions } from '../../test/quiz-fixture';
import {
  COMPILE_CHECK_ID,
  DEEP_TIER_CHECK_IDS,
  QUIZ_DRAW_CHECK_ID,
  QUIZ_PASS_MARK_CHECK_ID,
  QUIZ_QUESTIONS_CHECK_ID,
  QUIZ_RETAKE_CHECK_ID,
  QUIZ_REVEAL_CHECK_ID,
  DEEP_RECEIPT_CHECK_ID,
  deepReceiptRefusal,
  fastValidation,
} from './validation';
import type { ScenarioValidationInput, ValidationInput, ValidationPhaseInput } from './validation';
import {
  APPLICATION_CHECK_ID,
  BACKLOG_ONE_DOCUMENT_CHECK_ID,
  BACKLOG_SHAPE_CHECK_ID,
  BRIEF_NAMES_REMOVED_STAKEHOLDER_CHECK_ID,
  BRIEF_NAMES_STAKEHOLDER_CHECK_ID,
  INHERITED_TASK_SCENARIO_CHECK_ID,
  INTERVIEW_SEALED_ROW_CHECK_ID,
  INTERVIEW_WELL_FORMED_CHECK_ID,
  SCENARIO_ONE_PROJECT_CHECK_ID,
} from './validation';
import { applicationPhasesSentence } from '@learnsdlc/shared';

/** The four ids a quiz adds, in the order the tier reports them. */
const QUIZ_CHECK_IDS = [
  QUIZ_QUESTIONS_CHECK_ID,
  QUIZ_DRAW_CHECK_ID,
  QUIZ_PASS_MARK_CHECK_ID,
  QUIZ_RETAKE_CHECK_ID,
] as const;

const STACKS: SupportedStacks = {
  python: ['flask', 'pytest'],
  node: ['react'],
  tools: ['esbuild'],
  sentence: 'This deployment runs Flask and React. Adding a library is a platform change, not a content change.',
};

const task = (over: Partial<ValidationPhaseInput['tasks'][number]> = {}) => ({
  taskKey: 'main',
  title: 'Write the stories',
  required: true,
  artefactPath: 'requirements/draft.md',
  ...over,
});

const phase = (over: Partial<ValidationPhaseInput> = {}): ValidationPhaseInput => ({
  key: 'requirements',
  title: 'Requirements',
  checkKind: 'story',
  hasDrill: false,
  tasks: [task()],
  ...over,
});

const input = (over: Partial<ValidationInput> = {}): ValidationInput => ({
  phases: [phase()],
  runtime: null,
  hasBuild: false,
  hasPreview: false,
  compileError: null,
  ...over,
});

const rowsFor = (report: ValidationReport, id: string): ValidationCheck[] =>
  report.checks.filter((check) => check.id === id);

/**
 * The fast tier: what a teacher reads while drafting, and the same words the
 * door will use.
 *
 * The property this file is here for is the one the contract states and
 * nothing else enforces: on a `failed` row the sentence is **word for word**
 * the sentence publish refuses with. A teacher who reads one wording in the
 * editor and another at the door learns that the editor is a guess.
 */
describe('the fast validation tier', () => {
  it('passes a one-task, one-required-task draft with nothing to say', () => {
    const report = fastValidation(input(), STACKS, '2026-09-19T00:00:00.000Z');

    expect(report.tier).toBe('fast');
    expect(report.ranAt).toBe('2026-09-19T00:00:00.000Z');
    expect(report.publishable).toBe(true);
    expect(report.blocking).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.checks.length - report.notApplicable);
  });

  it('refuses a written phase holding three graded tasks, in the general sentence and not the wall\'s', () => {
    const report = fastValidation(
      input({
        phases: [
          phase({
            tasks: [
              task(),
              task({ taskKey: 'late-marker', artefactPath: 'requirements/my-story-late-marker.md' }),
              task({ taskKey: 'badge', artefactPath: 'requirements/my-story-badge.md' }),
            ],
          }),
        ],
      }),
      STACKS,
    );

    const gate = rowsFor(report, MULTI_TASK_CHECK_ID);
    expect(gate).toHaveLength(1);
    // Every phase holds one graded task beside quizzes: three is refused, and
    // the row names the phase and the count in the general one-task sentence.
    expect(gate[0].status).toBe('failed');
    expect(gate[0].phaseKey).toBe('requirements');
    expect(gate[0].sentence).toBe(multiTaskPublishRefusal('Requirements', 3, 'story'));
    expect(gate[0].sentence).not.toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(report.publishable).toBe(false);
    expect(refusesMultiTaskPublish(3, 'story')).toBe(true);
    // the written phase's refusal is the two-argument sentence, not the wall's
    expect(multiTaskPublishRefusal('Requirements', 3, 'story')).toBe(
      multiTaskPublishRefusal('Requirements', 3),
    );
  });

  it('refuses a three-task executable phase by the one sentence, whatever the gate says', () => {
    const report = fastValidation(
      input({
        phases: [
          phase({
            key: 'implementation',
            title: 'Implementation',
            checkKind: 'code',
            tasks: [
              task({ taskKey: 'api', artefactPath: null }),
              task({ taskKey: 'store', artefactPath: null }),
              task({ taskKey: 'web', artefactPath: null }),
            ],
          }),
        ],
      }),
      STACKS,
    );

    const gate = rowsFor(report, MULTI_TASK_CHECK_ID);
    expect(gate[0].status).toBe('failed');
    expect(gate[0].sentence).toBe(multiTaskPublishRefusal('Implementation', 3, 'code'));
    // the one sentence, verbatim: the same string the compiler's own wall is
    // built out of, so a teacher reads it in the editor and at the door
    expect(gate[0].sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(report.blocking).toContain(gate[0].sentence);
    expect(report.publishable).toBe(false);
  });

  it('leaves the gate passing while a phase holds what the runtime can serve', () => {
    const report = fastValidation(input(), STACKS);
    const gate = rowsFor(report, MULTI_TASK_CHECK_ID);

    expect(refusesMultiTaskPublish(1)).toBe(false);
    expect(gate[0].status).toBe('passed');
    expect(gate[0].sentence).not.toBe(multiTaskPublishRefusal('Requirements', 1));
  });

  it('refuses a three-task phase of either kind, the executable one in the wall\'s words', () => {
    const three = [
      task(),
      task({ taskKey: 'late-marker', artefactPath: 'requirements/my-story-late-marker.md' }),
      task({ taskKey: 'badge', artefactPath: 'requirements/my-story-badge.md' }),
    ];
    const report = fastValidation(
      input({
        phases: [
          phase({ tasks: three }),
          phase({
            key: 'implementation',
            title: 'Implementation',
            checkKind: 'code',
            tasks: three.map((one) => ({ ...one, artefactPath: null })),
          }),
        ],
      }),
      STACKS,
    );

    const gate = rowsFor(report, MULTI_TASK_CHECK_ID);
    const written = gate.find((one) => one.phaseKey === 'requirements')!;
    const executable = gate.find((one) => one.phaseKey === 'implementation')!;

    // every phase holds one graded task beside quizzes, the written one too, in the general sentence
    expect(written.status).toBe('failed');
    expect(written.sentence).toBe(multiTaskPublishRefusal('Requirements', 3, 'story'));
    expect(written.sentence).not.toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(executable.status).toBe('failed');
    expect(executable.sentence).toBe(multiTaskPublishRefusal('Implementation', 3, 'code'));
    expect(executable.sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(report.blocking).toEqual([written.sentence, executable.sentence]);
    expect(report.publishable).toBe(false);
  });

  it('refuses a phase no learner could ever pass, in the phase title', () => {
    const report = fastValidation(
      input({ phases: [phase({ tasks: [task({ required: false })] })] }),
      STACKS,
    );

    const required = rowsFor(report, REQUIRED_TASK_CHECK_ID);
    expect(required[0].status).toBe('failed');
    expect(required[0].sentence).toBe(noRequiredTaskRefusal('Requirements'));
    expect(report.blocking).toContain(noRequiredTaskRefusal('Requirements'));
  });

  it('names the task already holding an artefact path, across the whole version', () => {
    const report = fastValidation(
      input({
        phases: [
          phase({ tasks: [task({ title: 'Write the stories' })] }),
          phase({
            key: 'design',
            title: 'Design',
            tasks: [task({ taskKey: 'shape', title: 'Shape the design' })],
          }),
        ],
      }),
      STACKS,
    );

    const clash = rowsFor(report, ARTEFACT_PATH_CHECK_ID).find((one) => one.status === 'failed');
    expect(clash).toBeDefined();
    expect(clash?.sentence).toBe(
      duplicateArtefactPathRefusal('requirements/draft.md', 'Write the stories'),
    );
    expect(clash?.files).toEqual(['requirements/draft.md']);
  });

  it('measures a runtime block against the runner, one row per package', () => {
    const report = fastValidation(
      input({
        runtime: {
          python: { version: '3.11', packages: ['pandas==2.2.0'] },
          node: { version: '20', packages: { vue: '3.4.0' }, tools: {} },
        },
      }),
      STACKS,
    );

    const stack = rowsFor(report, SUPPORTED_STACK_CHECK_ID);
    expect(stack.map((one) => one.sentence)).toEqual([
      unsupportedLibraryRefusal('python', 'pandas'),
      unsupportedLibraryRefusal('node', 'vue'),
    ]);
    expect(report.publishable).toBe(false);
  });

  it('reports a project with no runtime block as neutral, never as a near-miss', () => {
    const report = fastValidation(input(), STACKS);
    const stack = rowsFor(report, SUPPORTED_STACK_CHECK_ID);

    expect(stack).toHaveLength(1);
    expect(stack[0].status).toBe('not-applicable');
    expect(report.publishable).toBe(true);
  });

  it('collapses the sandbox proofs a markdown-only project has nothing to prove', () => {
    const report = fastValidation(input(), STACKS);
    const neutral = report.checks.filter((one) => one.status === 'not-applicable');

    // a project with no code, tests, config, build or preview
    expect(neutral.map((one) => one.id)).toEqual(
      expect.arrayContaining([...DEEP_TIER_CHECK_IDS]),
    );
    expect(report.notApplicable).toBe(neutral.length);
    expect(report.notApplicableLine).toBe(notApplicableLine(neutral.length));
    expect(report.publishable).toBe(true);
  });

  it('says what a project has no proof for without a stray article', () => {
    const report = fastValidation(input(), STACKS);
    const sentence = (id: string) => report.checks.find((one) => one.id === id)?.sentence;
    expect(sentence('front-end-suite-runs')).toBe('This project has no front end to build, so there is nothing here to prove.');
    expect(sentence('preview-starts')).toBe('This project has no preview to start, so there is nothing here to prove.');
    expect(sentence('solution-passes-hidden')).toBe('This project has no code phase, so there is nothing here to prove.');
    expect(sentence('mutants-die')).toBe('This project has no tests phase, so there is nothing here to prove.');
    expect(sentence('drill-breaks-smoke')).toBe('This project has no deployment drill, so there is nothing here to prove.');
    expect(sentence('forged-entrypoint-refused')).toBe('This project has no config phase, so there is nothing here to prove.');
    for (const id of DEEP_TIER_CHECK_IDS) expect(sentence(id)).not.toMatch(/ no an? /);
  });

  it('keeps the sandbox proofs off the report for a project that has an application', () => {
    const report = fastValidation(
      input({
        phases: [
          phase(),
          phase({ key: 'implementation', title: 'Implementation', checkKind: 'code', tasks: [task({ taskKey: 'api', artefactPath: null })] }),
          phase({ key: 'testing', title: 'Testing', checkKind: 'tests', tasks: [task({ taskKey: 'suite', artefactPath: null })] }),
          phase({ key: 'deployment', title: 'Deployment', checkKind: 'config', hasDrill: true, tasks: [task({ taskKey: 'ship', artefactPath: 'deployment/runbook.json' })] }),
        ],
        hasBuild: true,
        hasPreview: true,
        runtime: { python: { version: '3.11', packages: ['flask==3.0.3'] } },
      }),
      STACKS,
    );

    for (const id of DEEP_TIER_CHECK_IDS) {
      expect(report.checks.find((one) => one.id === id)).toBeUndefined();
    }
    expect(report.notApplicable).toBe(0);
    expect(report.notApplicableLine).toBeNull();
  });

  it('carries a compile refusal into the report rather than throwing it at a teacher', () => {
    const report = fastValidation(
      input({ compileError: 'tasktrackr/requirements: no task owns the editable file "requirements/draft.md"' }),
      STACKS,
    );

    const compiles = rowsFor(report, COMPILE_CHECK_ID);
    expect(compiles[0].status).toBe('failed');
    expect(compiles[0].sentence).toContain('no task owns the editable file');
    expect(report.blocking).toContain(compiles[0].sentence);
  });

  it('never lets publishable and blocking disagree', () => {
    const report = fastValidation(
      input({ phases: [phase({ tasks: [task({ required: false }), task({ taskKey: 'two', artefactPath: 'requirements/my-story-two.md', required: false })] })] }),
      STACKS,
    );

    expect(report.publishable).toBe(report.blocking.length === 0);
    expect(report.failed).toBe(report.blocking.length);
    expect(report.blocking).toEqual(
      report.checks.filter((one) => one.status === 'failed').map((one) => one.sentence),
    );
  });
});

/* ---------------------------------- quizzes ---------------------------------- */

describe('the fast tier holds a quiz to its own fields', () => {
  /**
   * Four ids, appended and never renamed, and none of them has a compiler
   * twin: every one is a question about a quiz's own fields, which the
   * compiler cannot ask without the teacher's authored shape in front of it.
   * They still refuse a publish, because publish reads `report.publishable`.
   */

  const quizTask = (quiz = fixtureQuizChecks(), over: Partial<ValidationPhaseInput['tasks'][number]> = {}) =>
    task({ taskKey: 'check', title: 'The concept check', required: false, artefactPath: null, checkKind: 'quiz', quiz, ...over });

  const withQuiz = (quiz = fixtureQuizChecks(), over: Partial<ValidationPhaseInput['tasks'][number]> = {}) =>
    input({ phases: [phase({ tasks: [task(), quizTask(quiz, over)] })] });

  it('says nothing at all about a draft with no quiz', () => {
    const report = fastValidation(input(), STACKS, '2026-09-19T00:00:00.000Z');
    for (const id of QUIZ_CHECK_IDS) expect(rowsFor(report, id)).toEqual([]);
  });

  it('passes a well-formed quiz beside a required artefact task', () => {
    const report = fastValidation(withQuiz(), STACKS);
    expect(report.publishable).toBe(true);
    for (const id of QUIZ_CHECK_IDS) {
      const rows = rowsFor(report, id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('passed');
      expect(rows[0].taskKey).toBe('check');
      expect(rows[0].phaseKey).toBe('requirements');
    }
  });

  it('refuses a question a learner could not answer, one sentence at a time', () => {
    const bad = (over: Partial<ReturnType<typeof fixtureQuizChecks>>, match: RegExp) => {
      const report = fastValidation(withQuiz(fixtureQuizChecks(over)), STACKS);
      const rows = rowsFor(report, QUIZ_QUESTIONS_CHECK_ID);
      expect(rows[0].status).toBe('failed');
      expect(rows[0].sentence).toMatch(match);
      expect(report.blocking).toContain(rows[0].sentence);
      expect(report.publishable).toBe(false);
    };
    const one = fixtureQuizQuestions(1);
    bad({ questions: [], drawn: undefined }, /no questions/);
    bad({ questions: [{ ...one[0], stem: '  ' }], drawn: 1 }, /has no text/);
    bad({ questions: [{ ...one[0], explanation: '' }], drawn: 1 }, /no explanation/);
    bad({ questions: [{ ...one[0], options: [one[0].options[0]] }], drawn: 1 }, /between 2 and 8/);
    bad(
      { questions: [{ ...one[0], options: [one[0].options[0], { ...one[0].options[1], id: 'a' }] }], drawn: 1 },
      /two options keyed "a"/,
    );
    bad({ questions: [{ ...one[0], correct: [] }], drawn: 1 }, /marks no option correct/);
    bad({ questions: [{ ...one[0], correct: ['zz'] }], drawn: 1 }, /not one of its options/);
    bad({ questions: [{ ...one[0], correct: ['a', 'b'] }], drawn: 1 }, /marks every option correct/);
    // A key naming one option twice is ONE answer to the scorer, which folds
    // `correct` into a set, so measured as an array the paper would draw a
    // checkbox group, tell the learner to pick every answer that applies, and
    // mark them wrong for doing it. The learner-facing half already measures
    // the set; this is the sentence the teacher gets, where they can fix it.
    bad({ questions: [{ ...one[0], correct: ['a', 'a'] }], drawn: 1 }, /marks "a" correct twice/);

    // a question id is a graded unit's id, so two in one phase cannot share it
    const twin = fixtureQuizChecks({ questions: fixtureQuizQuestions(2), drawn: 1 });
    const report = fastValidation(
      input({
        phases: [
          phase({
            tasks: [
              task(),
              quizTask(twin),
              quizTask(twin, { taskKey: 'again', title: 'The second check' }),
            ],
          }),
        ],
      }),
      STACKS,
    );
    const rows = rowsFor(report, QUIZ_QUESTIONS_CHECK_ID);
    expect(rows[1].status).toBe('failed');
    expect(rows[1].sentence).toMatch(/is also asked by The concept check/);
  });

  it('refuses a paper its pool cannot fill', () => {
    const over = fastValidation(withQuiz(fixtureQuizChecks({ drawn: 9 })), STACKS);
    const rows = rowsFor(over, QUIZ_DRAW_CHECK_ID);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].sentence).toMatch(/draws 9 questions from a pool of 5/);
    expect(over.publishable).toBe(false);

    const none = fastValidation(withQuiz(fixtureQuizChecks({ drawn: 0 })), STACKS);
    expect(rowsFor(none, QUIZ_DRAW_CHECK_ID)[0].status).toBe('failed');
  });

  it('warns about an unreachable pass mark without refusing the version', () => {
    // A pass mark that no paper can hit exactly is allowed: a five-question
    // paper scores 0, 20, 40, 60, 80 or 100, so a mark of 70 is a mark of 80
    // wearing a different number. That is a teacher's decision to make
    // knowingly rather than a version to refuse, and the tier has three statuses.
    const report = fastValidation(
      withQuiz(fixtureQuizChecks({ drawn: 5, passMark: 70 })),
      STACKS,
    );
    const rows = rowsFor(report, QUIZ_PASS_MARK_CHECK_ID);
    expect(rows[0].status).toBe('passed');
    expect(rows[0].sentence).toMatch(/cannot land on/);
    expect(rows[0].sentence).toMatch(/4 of 5, which is 80%/);
    expect(report.publishable).toBe(true);
    expect(report.blocking).toEqual([]);

    const exact = fastValidation(withQuiz(fixtureQuizChecks({ drawn: 5, passMark: 80 })), STACKS);
    expect(rowsFor(exact, QUIZ_PASS_MARK_CHECK_ID)[0].sentence).toMatch(/land on exactly/);
  });

  it('refuses a required quiz that is the same paper twice', () => {
    const required = { required: true } as const;
    const unlimited = fastValidation(
      withQuiz(fixtureQuizChecks({ attempts: { max: null, cooldownSeconds: null } }), required),
      STACKS,
    );
    expect(rowsFor(unlimited, QUIZ_RETAKE_CHECK_ID)[0].status).toBe('failed');
    expect(rowsFor(unlimited, QUIZ_RETAKE_CHECK_ID)[0].sentence).toMatch(/re-sat without limit/);

    const wholePool = fastValidation(
      withQuiz(fixtureQuizChecks({ drawn: undefined }), required),
      STACKS,
    );
    expect(rowsFor(wholePool, QUIZ_RETAKE_CHECK_ID)[0].status).toBe('failed');
    expect(rowsFor(wholePool, QUIZ_RETAKE_CHECK_ID)[0].sentence).toMatch(/every time/);

    // an OPTIONAL quiz is free to be either, because it gates nothing
    const formative = fastValidation(
      withQuiz(fixtureQuizChecks({ drawn: undefined, attempts: { max: null, cooldownSeconds: null } })),
      STACKS,
    );
    expect(rowsFor(formative, QUIZ_RETAKE_CHECK_ID)[0].status).toBe('passed');
    expect(formative.publishable).toBe(true);
  });

  // The reveal is an optional quiz's choice only.
  it('quiz-reveal-optional-only: a row only where a quiz carries the choice, refused on a required quiz', () => {
    // absent draws no row at all, so a report of a quiz without the choice
    // is unchanged
    const plain = fastValidation(withQuiz(), STACKS);
    expect(rowsFor(plain, QUIZ_REVEAL_CHECK_ID)).toEqual([]);
    expect(QUIZ_REVEAL_CHECK_ID).toBe('quiz-reveal-optional-only');

    const optional = fastValidation(
      withQuiz(fixtureQuizChecks({ attempts: { max: 2, cooldownSeconds: null }, revealExplanation: 'always' })),
      STACKS,
    );
    const passed = rowsFor(optional, QUIZ_REVEAL_CHECK_ID);
    expect(passed).toHaveLength(1);
    expect(passed[0].status).toBe('passed');
    expect(passed[0].taskKey).toBe('check');
    expect(passed[0].sentence).toMatch(/after every attempt/);
    expect(optional.publishable).toBe(true);

    const required = fastValidation(
      withQuiz(fixtureQuizChecks({ revealExplanation: 'on-pass' }), { required: true }),
      STACKS,
    );
    const refused = rowsFor(required, QUIZ_REVEAL_CHECK_ID);
    expect(refused[0].status).toBe('failed');
    expect(refused[0].sentence).toMatch(/is required, and only an optional quiz chooses when its explanations are shown/);
    // one sentence: it ends once, on a full stop
    expect(refused[0].sentence.trim().split(/[.!?](\s|$)/).filter((part) => part && part.trim()).length).toBe(1);
    expect(required.publishable).toBe(false);
  });

  it('the gate counts the non-quiz tasks, so the editor agrees with the door', () => {
    // A `code` phase holding its one inherited task and a quiz publishes, so
    // the row that says otherwise would be the editor telling a teacher their
    // version cannot ship while the door let it through.
    const report = fastValidation(
      input({ phases: [phase({ checkKind: 'code', tasks: [task(), quizTask()] })] }),
      STACKS,
    );
    const gate = rowsFor(report, MULTI_TASK_CHECK_ID);
    expect(gate[0].status).toBe('passed');
    expect(gate[0].sentence).not.toContain(EXECUTABLE_SPLIT_NOT_READY);
    expect(report.blocking).toEqual([]);
    // A code phase is not "a written phase": it holds one graded task and a
    // quiz, and the row says so.
    expect(gate[0].sentence).toBe(
      'Requirements holds 1 graded task and 1 quiz, which a learner can work on.',
    );
    expect(gate[0].sentence).not.toContain('written phase');

    // two graded tasks is still a split, and still the wall's own sentence
    const split = fastValidation(
      input({
        phases: [
          phase({
            checkKind: 'code',
            tasks: [task(), task({ taskKey: 'web', artefactPath: null, checkKind: 'code' }), quizTask()],
          }),
        ],
      }),
      STACKS,
    );
    const blocked = rowsFor(split, MULTI_TASK_CHECK_ID);
    expect(blocked[0].status).toBe('failed');
    expect(blocked[0].sentence).toBe(multiTaskPublishRefusal('Requirements', 2, 'code'));

    // a task whose kind the caller does not name is counted, so every caller
    // written before quizzes reads exactly what it read
    const legacy = fastValidation(
      input({ phases: [phase({ checkKind: 'code', tasks: [task(), task({ taskKey: 'web' })] })] }),
      STACKS,
    );
    expect(rowsFor(legacy, MULTI_TASK_CHECK_ID)[0].status).toBe('failed');
  });
});

/* ---- a scenario's rows ---- */

describe("the rows a teacher's own scenario adds", () => {
  const scenario = (over: Partial<ScenarioValidationInput> = {}): ScenarioValidationInput => ({
    referenceName: 'Reference',
    interviews: [],
    documents: [],
    backlog: null,
    unnamedStakeholder: [],
    removedStakeholder: [],
    writtenPhases: [],
    application: false,
    ...over,
  });
  const ids = (report: ValidationReport) => report.checks.map((check) => check.id);

  it('draws none of them for a caller that names no scenario, so every earlier report reads as it did', () => {
    const plain = fastValidation(input(), STACKS, 'now');
    const empty = fastValidation(input({ scenario: scenario() }), STACKS, 'now');
    expect(ids(empty)).toEqual(ids(plain));
    expect(empty).toEqual(plain);
  });

  it('refuses a brief the loader refuses, a sealed row out of step, and one document holding two sets of bytes', () => {
    const report = fastValidation(
      input({
        scenario: scenario({
          interviews: [{ key: 'requirements', title: 'Requirements', present: true, facts: 2, refusal: 'interview.opening must be a non-empty string', sealedRows: 1, sealedMatches: false }],
          documents: [{ path: 'requirements/provided-stories.md', phases: [{ key: 'requirements', title: 'Requirements' }, { key: 'design', title: 'Design' }], sameBytes: false }],
        }),
      }),
      STACKS,
      'now',
    );
    expect(rowsFor(report, INTERVIEW_WELL_FORMED_CHECK_ID).map((one) => [one.status, one.sentence])).toEqual([
      ['failed', 'interview.opening must be a non-empty string'],
    ]);
    expect(rowsFor(report, INTERVIEW_SEALED_ROW_CHECK_ID).map((one) => one.status)).toEqual(['failed']);
    expect(rowsFor(report, BACKLOG_ONE_DOCUMENT_CHECK_ID).map((one) => one.status)).toEqual(['failed']);
    expect(report.publishable).toBe(false);
  });

  it("names the interview by its phase's title with no possessive on the title, a retitled phase included", () => {
    const report = fastValidation(
      input({
        scenario: scenario({
          interviews: [
            { key: 'requirements', title: 'Requirements', present: true, facts: 7, refusal: null, sealedRows: 1, sealedMatches: true },
            { key: 'design', title: 'Discovery', present: true, facts: 1, refusal: null, sealedRows: 1, sealedMatches: false },
          ],
        }),
      }),
      STACKS,
      'now',
    );
    expect(rowsFor(report, INTERVIEW_WELL_FORMED_CHECK_ID).map((one) => one.sentence)).toEqual([
      'The Requirements interview is well formed: 7 facts for a learner to settle.',
      'The Discovery interview is well formed: 1 fact for a learner to settle.',
    ]);
    expect(rowsFor(report, INTERVIEW_SEALED_ROW_CHECK_ID).map((one) => one.sentence)).toEqual([
      "The Requirements interview's sealed row holds exactly its interview, so its answers can never be mounted where a learner reads them.",
      "The Discovery interview's sealed row does not hold the interview's bytes, so the rule that keeps the answers out of every learner's file cannot see them. Save the interview again.",
    ]);
  });

  it('a phase whose title already ends in "interview" is never "interview interview"', () => {
    const report = fastValidation(
      input({
        scenario: scenario({
          interviews: [{ key: 'requirements', title: 'Stakeholder Interview', present: true, facts: 2, refusal: null, sealedRows: 1, sealedMatches: true }],
        }),
      }),
      STACKS,
      'now',
    );
    expect(rowsFor(report, INTERVIEW_WELL_FORMED_CHECK_ID).map((one) => one.sentence)).toEqual([
      'The Stakeholder Interview is well formed: 2 facts for a learner to settle.',
    ]);
    expect(rowsFor(report, INTERVIEW_SEALED_ROW_CHECK_ID).map((one) => one.sentence)).toEqual([
      "The Stakeholder Interview's sealed row holds exactly its interview, so its answers can never be mounted where a learner reads them.",
    ]);
  });

  it('draws every warning and the note as a passed row carrying its sentence, and blocks nothing', () => {
    const report = fastValidation(
      input({
        scenario: scenario({
          backlog: { key: 'requirements', title: 'Requirements', path: 'requirements/provided-stories.md', stories: 3, missing: null },
          unnamedStakeholder: [{ key: 'requirements', taskKey: 'booking', title: 'Book a room', persona: 'Priya Nair' }],
          removedStakeholder: [{ key: 'design', taskKey: 'main', title: 'Design', name: 'Someone Gone' }],
          writtenPhases: [
            { key: 'requirements', title: 'Requirements', scenarioOwn: true, teachers: true, inheritedReference: { taskKey: 'main', title: 'Story' } },
            { key: 'design', title: 'Design', scenarioOwn: false, teachers: false, inheritedReference: { taskKey: 'main', title: 'Design doc' } },
          ],
          application: true,
        }),
      }),
      STACKS,
      'now',
    );
    for (const id of [
      BACKLOG_SHAPE_CHECK_ID,
      BRIEF_NAMES_STAKEHOLDER_CHECK_ID,
      BRIEF_NAMES_REMOVED_STAKEHOLDER_CHECK_ID,
      SCENARIO_ONE_PROJECT_CHECK_ID,
      INHERITED_TASK_SCENARIO_CHECK_ID,
          APPLICATION_CHECK_ID,
    ]) {
      const rows = rowsFor(report, id);
      expect([id, rows.length]).toEqual([id, 1]);
      expect([id, rows[0].status, rows[0].sentence.length > 20]).toEqual([id, 'passed', true]);
    }
    expect(rowsFor(report, SCENARIO_ONE_PROJECT_CHECK_ID)[0].sentence).toContain("Design still asks for Reference's");
    expect(rowsFor(report, APPLICATION_CHECK_ID)[0].sentence).toBe(applicationPhasesSentence('Reference'));
    expect(report.publishable).toBe(true);
  });

  /*
   * A warning never blocks, but a row
   * whose sentence asks for a fix is marked a warning, and a row that only
   * says a fact a note, so the report does not let either read as a plain
   * pass. A real pass carries no mark.
   */
  it('marks each warning row a warning and each note a note, and a real pass neither', () => {
    const report = fastValidation(
      input({
        scenario: scenario({
          backlog: { key: 'requirements', title: 'Requirements', path: 'requirements/provided-stories.md', stories: 3, missing: null },
          unnamedStakeholder: [{ key: 'requirements', taskKey: 'booking', title: 'Book a room', persona: 'Priya Nair' }],
          removedStakeholder: [{ key: 'design', taskKey: 'main', title: 'Design', name: 'Someone Gone' }],
          writtenPhases: [
            { key: 'requirements', title: 'Requirements', scenarioOwn: true, teachers: true, inheritedReference: { taskKey: 'main', title: 'Story' } },
            { key: 'design', title: 'Design', scenarioOwn: false, teachers: false, inheritedReference: { taskKey: 'main', title: 'Design doc' } },
          ],
          application: true,
        }),
      }),
      STACKS,
      'now',
    );
    for (const id of [
      BACKLOG_SHAPE_CHECK_ID,
      BRIEF_NAMES_STAKEHOLDER_CHECK_ID,
      BRIEF_NAMES_REMOVED_STAKEHOLDER_CHECK_ID,
      SCENARIO_ONE_PROJECT_CHECK_ID,
      INHERITED_TASK_SCENARIO_CHECK_ID,
        ]) {
      expect([id, rowsFor(report, id).map((one) => one.advisory)]).toEqual([id, ['warning']]);
    }
    expect(rowsFor(report, APPLICATION_CHECK_ID).map((one) => one.advisory)).toEqual(['note']);
    const marked = report.checks.filter((one) => one.advisory !== undefined);
    expect(marked.every((one) => one.status === 'passed')).toBe(true);
    expect(report.checks.filter((one) => one.status === 'passed' && one.advisory === undefined).length).toBeGreaterThan(0);
    expect(report.publishable).toBe(true);
  });
});

/* The live builder's post-receipt rule, tested. */
describe('rawPackManifestOf (publish re-runs the run-shape rule over the compiled version)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { rawPackManifestOf } = require('./validation') as typeof import('./validation');
  const file = (path: string, editable: boolean) => ({ path, content: 'x\n', editable });
  const phase = (key: string, files: ReturnType<typeof file>[]) =>
    ({ key, title: key, artifactKind: 'story', files, checks: { kind: 'story' } }) as never;

  it('a learner-editable file is never a shipped argv script, even where another phase mounts it locked', () => {
    const raw = rawPackManifestOf({
      phases: [
        phase('design', [file('canonical/serve.sh', false), file('scripts/run.sh', false)]),
        phase('implementation', [file('scripts/run.sh', true)]),
      ],
      warmup: { check: {}, files: [file('canonical/warm.sh', false), file('warm/edit.sh', true)] },
    } as never);
    expect([...raw.shippedFiles].sort()).toEqual(['canonical/serve.sh', 'canonical/warm.sh']);
  });
});

/**
 * The rows an uploaded project's teacher reads on the projector, in plain
 * words. Words only: the ids and statuses are the stored reports' own.
 */
describe('the validation rows in plain words', () => {
  const executable = (over: Partial<NonNullable<ValidationInput['executable']>> = {}): NonNullable<ValidationInput['executable']> => ({
    budget: [],
    runtime: [],
    runShapes: [],
    phases: [{ key: 'implementation', title: 'Implementation', reference: false, deepCurrent: false }],
    publishing: true,
    ...over,
  });

  it('says a phase holds tasks a learner can work on, for one task, a task beside a quiz, and none', () => {
    const report = fastValidation(
      input({
        phases: [
          phase(),
          phase({ key: 'design', title: 'Discovery', checkKind: 'code', tasks: [task({ taskKey: 'd', artefactPath: null }), task({ taskKey: 'check', title: 'The concept check', required: false, artefactPath: null, checkKind: 'quiz', quiz: fixtureQuizChecks() })] }),
          phase({ key: 'testing', title: 'Testing', tasks: [] }),
        ],
      }),
      STACKS,
      'now',
    );
    const rows = rowsFor(report, MULTI_TASK_CHECK_ID);
    expect(rows.map((one) => [one.label, one.status, one.sentence])).toEqual([
      ['A phase holds tasks a learner can work on', 'passed', 'Requirements holds 1 task, which a learner can work on.'],
      ['A phase holds tasks a learner can work on', 'passed', 'Discovery holds 1 graded task and 1 quiz, which a learner can work on.'],
      ['A phase holds tasks a learner can work on', 'passed', 'Testing holds no task yet.'],
    ]);
    // the refusal is the shared wall's own sentence, unchanged
    const split = fastValidation(input({ phases: [phase({ tasks: [task(), task({ taskKey: 'two', artefactPath: null })] })] }), STACKS, 'now');
    expect(rowsFor(split, MULTI_TASK_CHECK_ID)[0]).toMatchObject({
      label: 'A phase holds tasks a learner can work on',
      status: 'failed',
      sentence: multiTaskPublishRefusal('Requirements', 2, 'story'),
    });
  });

  it('says no task writes a file of its own, and that a project naming no packages has nothing to check', () => {
    const report = fastValidation(input({ phases: [phase({ tasks: [task({ artefactPath: null })] })], runtime: null }), STACKS, 'now');
    expect(rowsFor(report, ARTEFACT_PATH_CHECK_ID).map((one) => one.sentence)).toEqual([
      'No task in this version writes a file of its own, so no two can collide.',
    ]);
    expect(rowsFor(report, SUPPORTED_STACK_CHECK_ID).map((one) => [one.status, one.sentence])).toEqual([
      ['not-applicable', 'This project declares no runtime packages, so there is nothing to check.'],
    ]);
  });

  it("an uploaded project's deep-receipt sentence does not name the reference application; a copy's keeps it", () => {
    const uploaded = fastValidation(input({ executable: executable({ uploaded: true }) }), STACKS, 'now');
    const copy = fastValidation(input({ executable: executable() }), STACKS, 'now');
    const deep = (report: ValidationReport) =>
      report.checks.filter((one) => one.id === DEEP_RECEIPT_CHECK_ID).map((one) => [one.status, one.sentence]);
    expect(deep(uploaded)).toEqual([
      ['failed', 'Implementation has no current deep validation. Run deep validation on this draft and publish once it passes.'],
    ]);
    expect(deep(copy)).toEqual([
      [
        'failed',
        "Implementation is not the reference project's application as it shipped, and it has no current deep validation. Run deep validation on this draft and publish once it passes.",
      ],
    ]);
    // words only: the same status, and publish refuses with the row's own sentence
    expect(uploaded.blocking).toContain(deepReceiptRefusal('Implementation', { uploaded: true }));
    expect(copy.blocking).toContain(deepReceiptRefusal('Implementation'));
    expect(uploaded.publishable).toBe(copy.publishable);
    // the whole list, row by row: the same ids, statuses, advisories, keys,
    // files and labels in the same order, and the same counts; only the deep
    // receipt's sentence differs
    const shape = (report: ValidationReport) =>
      report.checks.map(({ id, label, status, advisory, phaseKey, taskKey, files }) => [id, label, status, advisory, phaseKey, taskKey, files]);
    expect(uploaded.checks.length).toBeGreaterThan(1);
    expect(shape(uploaded)).toEqual(shape(copy));
    const counts = (report: ValidationReport) => [
      report.passed,
      report.failed,
      report.notApplicable,
      report.blocking.length,
      report.notApplicableLine,
    ];
    expect(counts(uploaded)).toEqual(counts(copy));
    const differing = uploaded.checks.filter((one, at) => one.sentence !== copy.checks[at]!.sentence).map((one) => one.id);
    expect(differing.length).toBeGreaterThan(0);
    expect(new Set(differing)).toEqual(new Set([DEEP_RECEIPT_CHECK_ID]));
  });
});

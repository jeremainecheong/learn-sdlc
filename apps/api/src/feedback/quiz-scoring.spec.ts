import 'reflect-metadata';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { EMPTY_STORY, serialiseStory, type FeedbackReport, type QuizChecks } from '@learnsdlc/shared';
import { writtenPhase } from '../../test/quiz-fixture';
import type { CompiledTask } from '../content/pack-compiler';
import {
  AssistantMessageEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  SubmissionEntity,
  TaskStateEntity,
} from '../db/entities';
import { optionToken, QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { FeedbackService } from './feedback.service';
import { quizPassed, strictTaskEvidencePassed } from './strict-evidence';

/**
 * How a paper becomes a verdict.
 *
 * Five things are proved here and each of them is a decision the rest of the
 * design leans on:
 *
 * - **no model scores an MCQ**: the assistant double is asserted to
 *   receive zero calls, and the two required fields a skipped review would
 *   have left unanswered (`aiReview` and `integrity`) carry real values
 *   rather than a stub and a zero;
 * - **one check, and the second evaluator agrees**:
 *   `strictTaskEvidencePassed` of the built report answers exactly
 *   `quizPassed`, at the mark, above it and at 100, which is what keeps the
 *   four callers that re-ask it of a *stored* report from making 100% the real
 *   pass mark;
 * - **the seal**: `correct` is in no payload at any point,
 *   and the explanation appears only once the learner is finished with the
 *   question;
 * - **a quiz is handed in as a paper or not at all**: `submit`
 *   refuses a quiz task that names none, and writes and spends nothing;
 * - **the quiz exemption**: a quiz hand-in does not dilute the
 *   hints-to-attempts ratio, and `checkers.ts`'s formula has no quiz case.
 *
 * A real sqlite schema, because what half of this is about is what the service
 * **writes**: the attempt row, the submission, the two counters.
 */

/* ------------------------------- the fixtures ----------------------------- */

const QUESTIONS: QuizChecks['questions'] = [
  {
    id: 'invest',
    stem: 'A story that cannot be built without another story first is failing which INVEST letter?',
    options: [
      { id: 'a', text: 'Independent' },
      { id: 'b', text: 'Negotiable' },
      { id: 'c', text: 'Estimable' },
    ],
    correct: ['a'],
    explanation: 'I is for independent: a story that waits on another cannot be scheduled on its own.',
    concept: 'INVEST',
  },
  {
    id: 'criterion',
    stem: 'Which of these is an acceptance criterion rather than an implementation instruction?',
    options: [
      { id: 'a', text: 'Add a boolean column to the tasks table.' },
      { id: 'b', text: 'A completed task no longer appears in the open list.' },
      { id: 'c', text: 'Use a repository class.' },
    ],
    correct: ['b'],
    explanation: 'A criterion says what is true afterwards; an instruction says how to get there.',
  },
  {
    id: 'grammar',
    stem: 'Which two parts does the role/goal/benefit grammar require beyond the role?',
    options: [
      { id: 'a', text: 'A goal' },
      { id: 'b', text: 'A benefit' },
      { id: 'c', text: 'An estimate' },
      { id: 'd', text: 'A sprint' },
    ],
    correct: ['a', 'b'],
    explanation: 'The benefit is the half teams drop, and it is the half that says why the goal is worth it.',
    concept: 'user stories',
  },
  {
    id: 'nfr',
    stem: 'Which of these is a non-functional requirement?',
    options: [
      { id: 'a', text: 'The list loads within two seconds on a class laptop.' },
      { id: 'b', text: 'A learner can reopen a completed task.' },
    ],
    correct: ['a'],
    explanation: 'A non-functional requirement constrains how well the system does something, not what it does.',
  },
  {
    id: 'stakeholder',
    stem: 'A stakeholder asks for a spreadsheet export. What is the need behind it?',
    options: [
      { id: 'a', text: 'A spreadsheet export.' },
      { id: 'b', text: 'Whatever they are doing with the numbers once they are out.' },
    ],
    correct: ['b'],
    explanation: 'A proposed solution is not a need; the need is the job the solution was reached for.',
  },
];

/** A clearly fake fixture quiz. The starter questions are written by the teaching team. */
const quizChecks = (over: Partial<QuizChecks> = {}): QuizChecks => ({
  kind: 'quiz',
  questions: QUESTIONS,
  shuffleOptions: false,
  passMark: 80,
  attempts: { max: 3, cooldownSeconds: null },
  criterion: 'concepts',
  ...over,
});

const quizTask = (over: Partial<CompiledTask> = {}): CompiledTask =>
  ({
    taskKey: 'concepts',
    order: 2,
    required: true,
    signOff: false,
    checkKind: 'quiz',
    artefactType: 'quiz',
    artefactPath: null,
    title: 'Requirements concept check',
    brief: 'Five questions on what a good story looks like.',
    objectives: [],
    owns: [],
    gradedUnits: QUESTIONS.map((question) => ({ kind: 'question', id: question.id })),
    rubric: {
      passThreshold: 60,
      criteria: [
        { key: 'concepts', title: 'Concepts', weight: 1, description: 'Scored by the quiz your teacher set.' },
      ],
    },
    checks: quizChecks(),
    ...over,
  }) as unknown as CompiledTask;

/** The phase's story checks (Shelf's Requirements, the quiz fixture's written phase), which grade one record. */
const STORY_CHECKS = writtenPhase().checks;
const STORY_RECORD = 'requirements/story.json';

const artefactTask: CompiledTask = {
  taskKey: 'main',
  order: 1,
  required: true,
  signOff: false,
  checkKind: 'story',
  artefactType: 'user-story',
  artefactPath: null,
  title: 'The user story',
  brief: 'Write the story.',
  objectives: [],
  owns: [STORY_RECORD],
  gradedUnits: [{ kind: 'record', id: STORY_RECORD }],
  rubric: {
    passThreshold: 70,
    criteria: [{ key: 'story', title: 'Story', weight: 100, description: '' }],
  },
  checks: STORY_CHECKS,
} as unknown as CompiledTask;

const phase = {
  key: 'requirements',
  title: 'Requirements',
  taskPanel: 'The phase brief.',
  intro: '',
  objectives: [],
  language: 'json',
  files: [
    { path: STORY_RECORD, content: serialiseStory(EMPTY_STORY), editable: true, language: 'json' },
  ],
  rubric: {
    passThreshold: 70,
    criteria: [{ key: 'story', title: 'Story', weight: 100, description: '' }],
  },
  checks: STORY_CHECKS,
} as any;

/** The sheet that gets four of five right: `grammar` is answered half-way. */
const FOUR_OF_FIVE: Record<string, string[]> = {
  invest: ['a'],
  criterion: ['b'],
  grammar: ['a'],
  nfr: ['a'],
  stakeholder: ['b'],
};

const ALL_FIVE: Record<string, string[]> = { ...FOUR_OF_FIVE, grammar: ['a', 'b'] };

const ONE_OF_FIVE: Record<string, string[]> = {
  invest: ['b'],
  criterion: ['a'],
  grammar: ['c'],
  nfr: ['a'],
  stakeholder: ['a'],
};

/* -------------------------------- the harness ----------------------------- */

interface Harness {
  dataSource: DataSource;
  service: FeedbackService;
  attempts: QuizAttemptsService;
  quizRows: Repository<QuizAttemptEntity>;
  phaseStates: Repository<PhaseStateEntity>;
  taskStates: Repository<TaskStateEntity>;
  submissions: Repository<SubmissionEntity>;
  messages: Repository<AssistantMessageEntity>;
  reviewSubmission: jest.Mock;
  state: PhaseStateEntity;
  tasks: CompiledTask[];
}

async function build(tasks: CompiledTask[] = [artefactTask, quizTask()]): Promise<Harness> {
  const dataSource = await memoryDataSource();
  const submissions = dataSource.getRepository(SubmissionEntity);
  const phaseStates = dataSource.getRepository(PhaseStateEntity);
  const taskStates = dataSource.getRepository(TaskStateEntity);
  const messages = dataSource.getRepository(AssistantMessageEntity);
  const quizRows = dataSource.getRepository(QuizAttemptEntity);

  const state = await phaseStates.save(
    phaseStates.create({
      enrollmentId: 'e-1',
      userId: 'u-1',
      phaseKey: 'requirements',
      phaseOrder: 1,
      status: 'in_progress',
      attempts: 0,
      workspace: { [STORY_RECORD]: serialiseStory(EMPTY_STORY) },
      ranBeforeSubmit: true,
    }),
  );
  for (const task of tasks) {
    await taskStates.save(
      taskStates.create({ phaseStateId: state.id, userId: 'u-1', taskKey: task.taskKey }),
    );
  }

  const content = {
    executionFiles: jest.fn((one: any, workspace: Record<string, string> | null) =>
      Object.fromEntries(
        one.files.map((file: any) => [
          file.path,
          file.editable && workspace && workspace[file.path] !== undefined
            ? workspace[file.path]
            : file.content,
        ]),
      ),
    ),
    getPhase: jest.fn(() => phase),
    getProject: jest.fn(() => ({ slug: 'ms-tan', version: '1.0.0' })),
    getPhaseForEnrollment: jest.fn(() => phase),
    getForEnrollment: jest.fn(() => ({ slug: 'ms-tan', version: '1.0.0' })),
    getTasksForEnrollment: jest.fn(() => tasks),
  };
  const enrollments = {
    findOneByOrFail: jest.fn(async () => ({
      id: 'e-1',
      userId: 'u-1',
      projectSlug: 'ms-tan',
      projectVersionId: 'v-1',
    })),
    findOne: jest.fn(async () => ({ id: 'e-1', userId: 'u-1', projectSlug: 'ms-tan' })),
  };
  const reviewSubmission = jest.fn(async (_phase: any, _state: any, input: any) => ({
    provider: 'openai',
    verdict: 'pass',
    summary: 'reviewed',
    strengths: [],
    improvements: [],
    processNote: '',
    criteriaEvidence: input.task.rubric.criteria.map((criterion: any) => ({
      key: criterion.key,
      met: true,
      evidence: 'the artefact says so',
      issue: '',
      nextStep: '',
    })),
  }));

  const service = new FeedbackService(
    submissions,
    phaseStates,
    enrollments as any,
    messages,
    content as any,
    {} as any,
    {} as any,
    { reviewSubmission } as any,
    { enqueue: jest.fn(async () => undefined), register: jest.fn(), durable: false } as any,
    { emitJob: jest.fn() } as any,
    { onVerdict: jest.fn(async () => undefined) } as any,
  );

  return {
    dataSource,
    service,
    attempts: new QuizAttemptsService(quizRows),
    quizRows,
    phaseStates,
    taskStates,
    submissions,
    messages,
    reviewSubmission,
    state,
    tasks,
  };
}

/**
 * Draw a paper and answer it, exactly as the quiz routes do.
 *
 * `submittedAt` is nudged to a strictly increasing instant. Two papers handed
 * in inside one millisecond is not a shape a learner can reach: they have to
 * start the second, and `UQ_quiz_attempts_open` will not let them until the
 * first is closed, but a spec that hands in three in a loop does, and *which
 * of two identical instants is newest* is not a question worth asking. Both
 * readers ask it through the same method, so they agree whatever the answer
 * is; this is only so the spec knows the answer too.
 */
let handInClock = 0;

async function handInPaper(
  harness: Harness,
  answers: Record<string, string[]>,
  checks: QuizChecks = quizChecks(),
  taskKey = 'concepts',
  /** Which run of the quiz this paper belongs to: `task_states.resetCount`. */
  epoch = 0,
): Promise<QuizAttemptEntity> {
  const started = await harness.attempts.start({
    phaseStateId: harness.state.id,
    userId: 'u-1',
    taskKey,
    projectVersionId: 'v-1',
    epoch,
    checks,
  });
  await harness.attempts.handIn(started.id, answers);
  handInClock += 1;
  await harness.quizRows.update(
    { id: started.id },
    { submittedAt: new Date(Date.UTC(2026, 8, 21) + handInClock * 1000).toISOString() },
  );
  return harness.quizRows.findOneByOrFail({ id: started.id });
}

const reload = (harness: Harness) =>
  harness.phaseStates.findOneByOrFail({ id: harness.state.id });

/* --------------------------------- the proof ------------------------------ */

describe('a quiz paper becomes a verdict with no model call', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.dataSource.isInitialized) await harness.dataSource.destroy();
  });

  it('asks no provider, and answers for the two fields a skipped review would leave empty', async () => {
    harness = await build();
    await handInPaper(harness, FOUR_OF_FIVE);
    // Six hints and two real attempts at the artefact task, so "live reliance
    // signals, not zeros" is a number this spec can name.
    for (let i = 0; i < 6; i += 1) {
      await harness.messages.save(
        harness.messages.create({
          userId: 'u-1',
          enrollmentId: 'e-1',
          phaseStateId: harness.state.id,
          phaseKey: 'requirements' as any,
          role: 'user',
          content: `hint ${i}`,
        }),
      );
    }
    await harness.phaseStates.update(harness.state.id, { attempts: 2 });

    const report = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );

    // Zero calls. Set equality is not a judgement.
    expect(harness.reviewSubmission).toHaveBeenCalledTimes(0);
    expect(report.aiReview.provider).toBe('not-applicable');
    expect(report.aiReview.verdict).toBe('pass');
    // `'unavailable'` would mean a model was asked and did not answer: the
    // learner's report would draw the degraded-grading banner over a paper
    // that scored 80, and clause 1 of the strict gate would refuse it.
    expect(report.aiReview.provider).not.toBe('unavailable');
    expect(report.aiReview.assessmentError).toBeUndefined();

    // Only the PASTE half is
    // zero. A quiz owns no file, so there is no artefact to find a mentor
    // reply in, and everything else is read off the phase's own counters.
    expect(report.integrity.mentorPasteFlag).toBe(false);
    expect(report.integrity.relianceIndex).toBe(Math.round((100 * 6) / (6 + 2 * 2 + 1)));
    expect(report.integrity.relianceIndex).toBeGreaterThan(0);
    expect(report.aiReliance).toEqual({ hintsThisPhase: 6, index: report.integrity.relianceIndex });
  });

  it('emits exactly one check and carries the per-question half as a section', async () => {
    harness = await build();
    await handInPaper(harness, FOUR_OF_FIVE);
    const report = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );

    // One check, and its id is the one `strictTaskEvidencePassed` will read.
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'quiz', status: 'passed' });
    expect(report.checks[0].detail).toBe('4 of 5 right — 80%, against a pass mark of 80%.');
    // A per-question `failed` check is what would have made 100% the real pass
    // mark for ever; the paper's detail rides in the section instead.
    expect(report.checks.filter((check) => check.status === 'failed')).toHaveLength(0);
    expect(report.quiz?.questions).toHaveLength(5);
    expect(report.quiz?.questions.map((question) => question.outcome)).toEqual([
      'right',
      'right',
      'wrong',
      'right',
      'right',
    ]);
    expect(report.quiz).toMatchObject({
      correctCount: 4,
      drawn: 5,
      passMark: 80,
      attempt: 1,
      attemptsLeft: 2,
    });
    expect(report.overall).toBe(80);
    expect(report.passed).toBe(true);
  });

  it('scores exact set equality over option ids, with no partial credit', async () => {
    harness = await build();
    // `grammar` wants both `a` and `b`. One of two is not half a mark.
    await handInPaper(harness, { ...FOUR_OF_FIVE, grammar: ['a'] });
    const half = await harness.service.buildReport(phase, await reload(harness), harness.tasks, quizTask());
    expect(half.quiz?.questions.find((one) => one.id === 'grammar')?.outcome).toBe('wrong');

    // And a superset is not a pass either: `correct` is a set, not a subset.
    await handInPaper(harness, { ...ALL_FIVE, nfr: ['a', 'b'] });
    const superset = await harness.service.buildReport(phase, await reload(harness), harness.tasks, quizTask());
    expect(superset.quiz?.questions.find((one) => one.id === 'nfr')?.outcome).toBe('wrong');
    expect(superset.overall).toBe(80);
  });

  it('scores a shuffled paper identically to an unshuffled one', async () => {
    // The learner submits option **ids**, never indices, so the permutation the
    // row records is for redrawing the paper and for nothing else.
    const plain = await build();
    await handInPaper(plain, FOUR_OF_FIVE, quizChecks({ shuffleOptions: false }));
    const flat = await plain.service.buildReport(phase, await reload(plain), plain.tasks, quizTask());

    const shuffled = await build();
    const paper = await handInPaper(shuffled, FOUR_OF_FIVE, quizChecks({ shuffleOptions: true }));
    const mixed = await shuffled.service.buildReport(
      phase,
      await reload(shuffled),
      shuffled.tasks,
      quizTask({ checks: quizChecks({ shuffleOptions: true }) }),
    );

    expect(mixed.overall).toBe(flat.overall);
    expect(mixed.quiz?.questions.map((one) => one.outcome)).toEqual(
      flat.quiz?.questions.map((one) => one.outcome),
    );
    // The paper really was permuted, or the row above proves nothing.
    const drawn = paper.paper.map((one) => one.optionIds.join(''));
    const declared = QUESTIONS.map((one) => one.options.map((option) => option.id).join(''));
    expect(drawn).not.toEqual(declared);
    // and the options come back in the paper's own order, not the pool's:
    // each named by that paper's token for it, never by the authored id
    // so the order is the draw's and the names say nothing.
    expect(mixed.quiz?.questions[0].options.map((option) => option.id)).toEqual(
      paper.paper[0].optionIds.map((id) => optionToken(paper.id, paper.paper[0].questionId, id)),
    );

    await plain.dataSource.destroy();
    await shuffled.dataSource.destroy();
    harness = undefined as unknown as Harness;
  });

  it('names every option and every pick by the paper’s own tokens, and a regrade names them alike', async () => {
    // The report is a learner payload and it lists the options in the order
    // the paper drew them. Named by authored ids it would hand back the order
    // the teacher wrote them in (the key by position for a teacher who writes
    // the right answer first) on the very screen that marks the paper.
    harness = await build();
    const checks = quizChecks({ shuffleOptions: true });
    const task = quizTask({ checks });
    const paper = await handInPaper(harness, FOUR_OF_FIVE, checks);
    const report = await harness.service.buildReport(phase, await reload(harness), harness.tasks, task);

    for (const question of report.quiz!.questions) {
      const drawn = paper.paper.find((one) => one.questionId === question.id)!;
      expect(question.options.map((option) => option.id)).toEqual(
        drawn.optionIds.map((id) => optionToken(paper.id, question.id, id)),
      );
      // "Your answer" is the option the learner picked, under the same token
      // the paper served it by.
      expect(question.selected).toEqual(
        (FOUR_OF_FIVE[question.id] ?? []).map((id) => optionToken(paper.id, question.id, id)),
      );
      for (const option of question.options) expect(option.id).toMatch(/^o[0-9a-f]{24}$/);
    }
    // No authored option id is anywhere in the rows the learner reads.
    const rows = JSON.stringify(report.quiz!.questions);
    for (const authored of ['"a"', '"b"', '"c"', '"d"']) expect(rows).not.toContain(authored);

    // Scoring is the authored sheet's and did not move.
    expect(report.overall).toBe(80);
    // and a regrade from the same row names every option the same way
    const again = await harness.service.buildReport(phase, await reload(harness), harness.tasks, task);
    expect(again.quiz!.questions).toEqual(report.quiz!.questions);
  });

  it('is quizPassed at the mark, above it and at 100, and the strict gate agrees', async () => {
    // Asked of the report this service really builds
    // rather than of a hand-written fixture: the equivalence is a property of
    // the SHAPE, so it has to be re-asked of the shape that ships.
    for (const [answers, overall] of [
      [ONE_OF_FIVE, 20],
      [FOUR_OF_FIVE, 80],
      [ALL_FIVE, 100],
    ] as const) {
      const one = await build();
      await handInPaper(one, answers);
      const task = quizTask();
      const report = await one.service.buildReport(phase, await reload(one), one.tasks, task);
      expect(report.overall).toBe(overall);
      expect(report.passed).toBe(quizPassed(overall, 80));
      expect(strictTaskEvidencePassed(task, report, report.aiReview)).toBe(quizPassed(overall, 80));
      await one.dataSource.destroy();
    }
    harness = undefined as unknown as Harness;
  });
});

describe('the seal, on a scored report', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.dataSource.isInitialized) await harness.dataSource.destroy();
  });

  /**
   * The whole serialised report, which is how the seal assertions are
   * written: over the payload rather than field by field.
   *
   * **`QuizReport.correctCount` is the one honest exception and it is renamed
   * here rather than waved through.** The contract's own note says the seal is
   * assertable by the substring `correct`, and the tally's field name is a
   * count of right answers, not a key. Blanking exactly that token leaves the
   * assertion meaning what it says: the *key*, an option id, under any name,
   * is nowhere on the wire.
   */
  const wire = (report: FeedbackReport): string =>
    JSON.stringify(report).replace(/"correctCount"/g, '"tally"');

  it('never carries the key, passed or failed', async () => {
    for (const answers of [ONE_OF_FIVE, ALL_FIVE]) {
      harness = await build();
      await handInPaper(harness, answers);
      const report = await harness.service.buildReport(
        phase,
        await reload(harness),
        harness.tasks,
        quizTask(),
      );
      expect(wire(report)).not.toContain('correct');
      // and there is no field of that name under any spelling
      expect(JSON.stringify(report)).not.toMatch(/"correct"\s*:/);
      // A learner's own row carries these seven keys and no eighth.
      expect(Object.keys(report.quiz!.questions[0]).sort()).toEqual([
        'concept',
        'explanation',
        'id',
        'options',
        'outcome',
        'selected',
        'stem',
      ]);
      // and the learner's outcome is a word, which is what makes the
      // substring assertion possible at all
      expect(new Set(report.quiz!.questions.map((one) => one.outcome))).toEqual(
        new Set(answers === ALL_FIVE ? ['right'] : ['right', 'wrong']),
      );
      await harness.dataSource.destroy();
    }
    harness = undefined as unknown as Harness;
  });

  it('releases an explanation only once the learner is finished with the question', async () => {
    // Failing, with attempts left: sealed. No explanation is released on a
    // failing paper while attempts remain.
    harness = await build();
    await handInPaper(harness, ONE_OF_FIVE);
    const sealed = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );
    expect(sealed.quiz!.questions.map((one) => one.explanation)).toEqual([null, null, null, null, null]);
    expect(sealed.quiz!.questions.map((one) => one.concept)).toEqual([null, null, null, null, null]);
    expect(wire(sealed)).not.toContain('I is for independent');
    await harness.dataSource.destroy();

    // Passed: finished with every drawn question.
    harness = await build();
    await handInPaper(harness, ALL_FIVE);
    const passed = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );
    expect(passed.quiz!.questions[0].explanation).toContain('I is for independent');
    expect(passed.quiz!.questions[0].concept).toBe('INVEST');
    // a question the teacher gave no concept reads null rather than an empty
    // string: a blank and an absent fact are different things
    expect(passed.quiz!.questions[1].concept).toBeNull();
    await harness.dataSource.destroy();

    // Attempts spent: no next paper left to protect.
    harness = await build();
    const oneShot = quizChecks({ attempts: { max: 1, cooldownSeconds: null } });
    await handInPaper(harness, ONE_OF_FIVE, oneShot);
    const spent = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask({ checks: oneShot }),
    );
    expect(spent.quiz!.attemptsLeft).toBe(0);
    expect(spent.quiz!.questions[0].explanation).toContain('I is for independent');
    await harness.dataSource.destroy();

    // Formative: optional, no limit, and telling them straight away is the
    // whole point of setting it.
    harness = await build();
    const open = quizChecks({ attempts: { max: null, cooldownSeconds: null } });
    await handInPaper(harness, ONE_OF_FIVE, open);
    const formative = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask({ required: false, checks: open }),
    );
    expect(formative.quiz!.attemptsLeft).toBeNull();
    expect(formative.quiz!.questions[0].explanation).toContain('I is for independent');

    // …and an unlimited REQUIRED quiz is not formative, so it stays sealed.
    const required = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask({ required: true, checks: open }),
    );
    expect(required.quiz!.questions[0].explanation).toBeNull();
  });

  it('never carries a pool question the paper did not draw', async () => {
    harness = await build();
    const pooled = quizChecks({ drawn: 3 });
    await handInPaper(harness, ALL_FIVE, pooled);
    const report = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask({ required: false, checks: pooled }),
    );
    expect(report.quiz!.drawn).toBe(3);
    expect(report.quiz!.questions).toHaveLength(3);
    const drawnIds = new Set(report.quiz!.questions.map((one) => one.id));
    const undrawn = QUESTIONS.filter((question) => !drawnIds.has(question.id));
    expect(undrawn).toHaveLength(2);
    // A pool exists so that a retake is a different paper. A pool whose
    // undrawn half leaks is not a pool: the explanations of the two questions
    // this learner was not asked are not on the wire at all.
    for (const question of undrawn) {
      expect(wire(report)).not.toContain(question.explanation);
      expect(wire(report)).not.toContain(question.stem);
    }
  });
});

describe('a quiz is handed in as a paper, or not at all', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.dataSource.isInitialized) await harness.dataSource.destroy();
  });

  it('refuses a quiz task with no paper, and writes and spends nothing (proof 22)', async () => {
    harness = await build();
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'concepts'),
    ).rejects.toThrow(/is a quiz/);

    expect(await harness.submissions.count()).toBe(0);
    expect((await reload(harness)).attempts).toBe(0);
    const row = await harness.taskStates.findOneByOrFail({
      phaseStateId: harness.state.id,
      taskKey: 'concepts',
    });
    expect(row.attempts).toBe(0);
  });

  it('refuses a paper named on a task that is not a quiz', async () => {
    harness = await build();
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'main', {
        attemptId: 'whatever',
      }),
    ).rejects.toThrow(/is not a quiz/);
    expect(await harness.submissions.count()).toBe(0);
  });

  it('refuses an unknown paper, another learner’s and a superseded one in one sentence', async () => {
    harness = await build();
    const first = await handInPaper(harness, ONE_OF_FIVE);
    const second = await handInPaper(harness, FOUR_OF_FIVE);

    const refusals: string[] = [];
    for (const attemptId of ['00000000-0000-4000-8000-000000000000', first.id]) {
      await harness.service
        .submit(phase, await reload(harness), undefined, 'concepts', { attemptId })
        .catch((err: Error) => refusals.push(err.message));
    }
    // A paper that is still open reads the same as one that never existed.
    const open = await harness.attempts.start({
      phaseStateId: harness.state.id,
      userId: 'u-1',
      taskKey: 'concepts',
      projectVersionId: 'v-1',
      epoch: 0,
      checks: quizChecks(),
    });
    await harness.service
      .submit(phase, await reload(harness), undefined, 'concepts', { attemptId: open.id })
      .catch((err: Error) => refusals.push(err.message));

    expect(refusals).toHaveLength(3);
    // One sentence for four facts, so a refusal is not an oracle.
    expect(new Set(refusals).size).toBe(1);
    expect(refusals[0]).not.toContain(first.id);
    expect(await harness.submissions.count()).toBe(0);
    // the newest handed-in paper is the one that would be accepted
    expect(second.submittedAt).not.toBeNull();
  });

  /**
   * Quiz consistency: a quiz's `resetCount` is its attempt epoch, so the revision a paper is
   * handed in on carries the paper's own epoch as its `resetEpoch`, one run
   * number for the two rows, never two that can disagree.
   */
  it('a quiz submission\'s resetEpoch equals its paper\'s epoch', async () => {
    harness = await build();
    await harness.taskStates.update({ phaseStateId: harness.state.id, taskKey: 'concepts' }, { resetCount: 2 });
    const paper = await handInPaper(harness, FOUR_OF_FIVE, quizChecks(), 'concepts', 2);
    const view = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    expect(paper.epoch).toBe(2);
    expect((await harness.submissions.findOneByOrFail({ id: view.id })).resetEpoch).toBe(paper.epoch);
  });

  it('accepts the paper waiting to be handed in, and names the revision on it', async () => {
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    const view = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    expect(view.taskKey).toBe('concepts');
    // Linked before the job is enqueued, so a grader can never run against a
    // row that does not yet know which submission it is.
    expect((await harness.quizRows.findOneByOrFail({ id: paper.id })).submissionId).toBe(view.id);
    // and a replay of the same paper is refused, because it is now linked
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      }),
    ).rejects.toThrow(/not the one waiting/);
  });

  it('hands the paper back when the queue never took the job', async () => {
    // The counterpart of the refunded attempt. A 503 from the queue leaves the
    // learner with no verdict, so a paper still naming that failed submission
    // would be a sheet they can never hand in again and an attempt spent on
    // an outage they did not cause.
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    (harness.service as unknown as { jobs: { enqueue: jest.Mock } }).jobs.enqueue.mockRejectedValue(
      new Error('the queue is not answering'),
    );
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      }),
    ).rejects.toThrow(/queue/);
    expect((await harness.quizRows.findOneByOrFail({ id: paper.id })).submissionId).toBeNull();

    // …so the same paper can be handed in again once the queue is back.
    (harness.service as unknown as { jobs: { enqueue: jest.Mock } }).jobs.enqueue.mockResolvedValue(
      undefined,
    );
    const view = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    expect((await harness.quizRows.findOneByOrFail({ id: paper.id })).submissionId).toBe(view.id);
  });

  it('hands the paper back when the marking was lost, and names the new revision on it', async () => {
    // The queue's 503 is not the only way a paper ends up with no verdict. The
    // stall age-out writes a revision `failed` "so the phase is not gated on a
    // job nobody is running", and a pipeline failure on a queue that does not
    // retry writes the same status, and neither takes the paper's link back.
    // A paper still naming a failed revision is a spent attempt, no verdict
    // and a sheet nobody can hand in again; on the last attempt of a required
    // quiz it is the phase and the rest of the project, for a worker death the learner did
    // not cause.
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    const first = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    await harness.submissions.update(
      { id: first.id },
      { status: 'failed', error: 'the worker went away' },
    );

    const second = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    expect(second.id).not.toBe(first.id);
    // The paper names the revision that is actually marking it, and not the
    // one that died: the grader writes its score back through that id.
    expect((await harness.quizRows.findOneByOrFail({ id: paper.id })).submissionId).toBe(second.id);
    // One paper, handed in once: the quiz's own limit did not move.
    expect(await harness.attempts.handedIn(harness.state.id, 'concepts', 0)).toBe(1);

    // And a revision still in flight is not a lost one: the replay refusal
    // above stands wherever a verdict may yet arrive.
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      }),
    ).rejects.toThrow(/not the one waiting/);
  });
});

describe('a revision is scored against the sheet it named', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.dataSource.isInitialized) await harness.dataSource.destroy();
  });

  it('re-grades revision one against revision one’s paper, not the newest one', async () => {
    // `gradeSnapshot` is the one grader that does not arrive through `submit`,
    // so neither of the two refusals that keep the live path exact is standing
    // in front of it: `paperToHandIn` refuses a second paper while the first is still being
    // marked, and `submit` refuses a hand-in that does not name the newest
    // closed sheet. A batch planned against revision one and run a moment
    // later has to answer for revision one's paper whatever the learner has
    // handed in since: otherwise the appeal writes a verdict earned on a
    // sheet that revision never carried, and `taskRollup`'s `Math.max` takes
    // it.
    harness = await build();
    const first = await handInPaper(harness, ONE_OF_FIVE);
    const appealed = await harness.service.submit(
      phase,
      await reload(harness),
      undefined,
      'concepts',
      { attemptId: first.id },
    );
    await harness.submissions.update({ id: appealed.id }, { status: 'completed' });

    const second = await handInPaper(harness, ALL_FIVE);
    await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: second.id,
    });

    const regraded = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      appealed.id,
    );
    expect(regraded.quiz!.correctCount).toBe(1);
    expect(regraded.overall).toBe(20);
    expect(regraded.passed).toBe(false);

    // The newest sheet is still what a grader with no revision in hand reads,
    // which is what every call that is not the regrade makes.
    const newest = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );
    expect(newest.quiz!.correctCount).toBe(5);
  });

  it('counts the attempt as of the paper, and never as of the regrade', async () => {
    // `attempt` and `attemptsLeft` are facts about the sheet, so a regrade of
    // revision one must read the numbers that were true when revision one was
    // handed in. Read as of now, a regrade of the first of three papers says
    // "attempt 3, 0 left", and `attemptsLeft === 0` is one of the three doors
    // `releaseExplanations` opens on, so the appeal would hand back the
    // explanations that paper deliberately withheld.
    harness = await build();
    const first = await handInPaper(harness, ONE_OF_FIVE);
    const appealed = await harness.service.submit(
      phase,
      await reload(harness),
      undefined,
      'concepts',
      { attemptId: first.id },
    );
    await harness.submissions.update({ id: appealed.id }, { status: 'completed' });
    const live = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      appealed.id,
    );
    expect(live.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
    expect(live.quiz!.questions.every((one) => one.explanation === null)).toBe(true);

    // Two more papers, which spends the limit. The first paper's numbers must
    // not move with them.
    for (const answers of [ONE_OF_FIVE, ONE_OF_FIVE]) {
      const next = await handInPaper(harness, answers);
      const view = await harness.service.submit(
        phase,
        await reload(harness),
        undefined,
        'concepts',
        { attemptId: next.id },
      );
      await harness.submissions.update({ id: view.id }, { status: 'completed' });
    }

    const regraded = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      appealed.id,
    );
    expect(regraded.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
    expect(regraded.quiz!.questions.every((one) => one.explanation === null)).toBe(true);

    // The THIRD paper really has spent the limit, and reads so, which is what
    // makes the assertion above a statement about *as-of* rather than about a
    // number that never moves.
    const newest = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );
    expect(newest.quiz).toMatchObject({ attempt: 3, attemptsLeft: 0 });
    expect(newest.quiz!.questions.every((one) => one.explanation !== null)).toBe(true);
  });

  it('numbers a paper by its own run, so a reset starts the count again', async () => {
    // The recovery's half of the same property: after a teacher's reset the
    // first paper of the new run is attempt 1 with the full limit left, and
    // the three papers before it are still in the record and still read as
    // the attempts they were.
    harness = await build();
    const before = await handInPaper(harness, ONE_OF_FIVE);
    const appealed = await harness.service.submit(
      phase,
      await reload(harness),
      undefined,
      'concepts',
      { attemptId: before.id },
    );
    await harness.submissions.update({ id: appealed.id }, { status: 'completed' });

    // The reset: `task_states.resetCount` IS the epoch.
    await harness.taskStates.update(
      { phaseStateId: harness.state.id, taskKey: 'concepts' },
      { status: 'in_progress', passedAt: null, bestScore: null, resetCount: 1 },
    );
    const after = await handInPaper(harness, ALL_FIVE, quizChecks(), 'concepts', 1);
    const view = await harness.service.submit(
      phase,
      await reload(harness),
      undefined,
      'concepts',
      { attemptId: after.id },
    );
    await harness.submissions.update({ id: view.id }, { status: 'completed' });

    const fresh = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      view.id,
    );
    expect(fresh.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
    // And the paper from the run before is untouched by the reset.
    const old = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      appealed.id,
    );
    expect(old.quiz).toMatchObject({ attempt: 1, attemptsLeft: 2 });
    expect(old.quiz!.correctCount).toBe(1);
  });

  it('refuses rather than score a revision against a sheet another revision owns', async () => {
    // A revision whose own sheet is not in the record is a missing record and
    // not a low score, exactly as it is on the live path. The sheet that *is*
    // there belongs to another revision, and borrowing it is the bug.
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    const view = await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });

    await expect(
      harness.service.gradeSnapshot(
        phase,
        await reload(harness),
        harness.tasks,
        quizTask(),
        '00000000-0000-4000-8000-000000000000',
      ),
    ).rejects.toThrow(/no handed-in paper/);
    // Nothing was written on the way to the refusal.
    expect(await harness.quizRows.findOneByOrFail({ id: paper.id })).toMatchObject({
      submissionId: view.id,
      score: null,
      passed: null,
    });
  });

  it('scores a revision whose paper was unlinked by a queue that never took it', async () => {
    // The converse of the refusal above, and the reason it is not simply *"no
    // linked paper, no verdict"*: a 503 from the queue takes the link back and
    // leaves the learner one closed sheet that names no revision. That sheet
    // is that revision's, and a regrade of it is handled correctly.
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    (harness.service as unknown as { jobs: { enqueue: jest.Mock } }).jobs.enqueue.mockRejectedValue(
      new Error('the queue is not answering'),
    );
    await expect(
      harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      }),
    ).rejects.toThrow(/queue/);
    const failed = await harness.submissions.findOneByOrFail({ status: 'failed' });
    expect((await harness.quizRows.findOneByOrFail({ id: paper.id })).submissionId).toBeNull();

    const regraded = await harness.service.gradeSnapshot(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
      failed.id,
    );
    expect(regraded.quiz!.correctCount).toBe(4);
  });
});

describe('the AI-reliance measure exempts a quiz retake (the owner, 21 September)', () => {
  let harness: Harness;

  afterEach(async () => {
    if (harness?.dataSource.isInitialized) await harness.dataSource.destroy();
  });

  it('spends the task’s counter and not the phase’s', async () => {
    harness = await build();
    const paper = await handInPaper(harness, FOUR_OF_FIVE);
    await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });

    // The phase's counter is the reliance index's denominator, and a paper is
    // not one of the goes a learner has had at the phase's work.
    expect((await reload(harness)).attempts).toBe(0);
    // The task's own visible count moves, which is what the panel draws. Two
    // counters, two questions, each with one reader.
    const row = await harness.taskStates.findOneByOrFail({
      phaseStateId: harness.state.id,
      taskKey: 'concepts',
    });
    expect(row.attempts).toBe(1);
  });

  it('leaves a hint-taking learner’s ratio exactly where their own work left it', async () => {
    // The product rule: a quiz hand-in must not dilute the hints-to-attempts
    // ratio. The formula in `checkers.ts` has no quiz case; the exemption is
    // in what reaches its denominator.
    harness = await build();
    for (let i = 0; i < 6; i += 1) {
      await harness.messages.save(
        harness.messages.create({
          userId: 'u-1',
          enrollmentId: 'e-1',
          phaseStateId: harness.state.id,
          phaseKey: 'requirements' as any,
          role: 'user',
          content: `hint ${i}`,
        }),
      );
    }
    // Two real goes at the artefact task.
    await harness.phaseStates.update(harness.state.id, { attempts: 2 });
    const before = (await reload(harness)).attempts;

    for (let take = 0; take < 3; take += 1) {
      const paper = await handInPaper(harness, ONE_OF_FIVE);
      await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      });
    }

    const after = await reload(harness);
    expect(after.attempts).toBe(before);
    const report = await harness.service.buildReport(phase, after, harness.tasks, quizTask());
    // 6 hints against the 2 attempts they actually spent on the work, not
    // against 5. The number a learner reads is about their own work.
    expect(report.integrity.relianceIndex).toBe(Math.round((100 * 6) / (6 + 2 * 2 + 1)));
    expect(report.integrity.relianceIndex).not.toBe(Math.round((100 * 6) / (6 + 2 * 5 + 1)));
  });

  it('leaves a learner with no hints at zero, as it always did', async () => {
    // The zero-hint half, which holds whatever the exemption:
    // `relianceIndex` returns before it divides on `hints === 0`, so no number
    // of papers can move it.
    harness = await build();
    for (let take = 0; take < 5; take += 1) {
      const paper = await handInPaper(harness, ONE_OF_FIVE);
      await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
        attemptId: paper.id,
      });
    }
    const report = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      quizTask(),
    );
    expect(report.integrity.relianceIndex).toBe(0);
    expect(report.integrity.relianceFlag).toBe(false);
    expect(report.aiReliance.index).toBe(0);
  });

  it('does not suppress noEffortFlag, which a spent phase attempt would have', async () => {
    // The second reader of the shared counter. The flag is
    // `attempts <= 1 && !ranBeforeSubmit && hints >= 6`, so without the
    // exemption a quiz taken first would push `attempts` to 1 and quietly take
    // the flag away from the executable task's next report.
    harness = await build();
    await harness.phaseStates.update(harness.state.id, { attempts: 0, ranBeforeSubmit: false });
    for (let i = 0; i < 6; i += 1) {
      await harness.messages.save(
        harness.messages.create({
          userId: 'u-1',
          enrollmentId: 'e-1',
          phaseStateId: harness.state.id,
          phaseKey: 'requirements' as any,
          role: 'user',
          content: `hint ${i}`,
        }),
      );
    }
    const paper = await handInPaper(harness, ONE_OF_FIVE);
    await harness.service.submit(phase, await reload(harness), undefined, 'concepts', {
      attemptId: paper.id,
    });
    const report = await harness.service.buildReport(
      phase,
      await reload(harness),
      harness.tasks,
      artefactTask,
    );
    expect(report.integrity.noEffortFlag).toBe(true);
  });
});

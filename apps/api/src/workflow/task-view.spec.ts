import { ContentService } from '../content/content.service';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import type { CodeChecks, PhaseContent } from '../content/content.types';
import { checksOf, soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import {
  FIXTURE_QUIZ_NOTICE,
  fixtureQuizChecks,
  fixtureQuizRubric,
} from '../../test/quiz-fixture';
import { referenceFiles } from './solution.reference';
import { learnerRubric, learnerText } from './learner-text';
import {
  evidenceOf,
  sealedTask,
  taskCountsOf,
  taskViews,
  type PhaseRowFacts,
  type TaskRowFacts,
} from './task-view';

/**
 * The learner's view of a phase's tasks.
 *
 * Two properties are what this file exists to hold.
 *
 * **`evidence` and `sealed` are derived from the units, never chosen.** A
 * teacher does not pick the word their task's proof is described by; they
 * strengthen the proof and the word follows. So every assertion below reads
 * them off a task's own checks, and one of them hands the builder a task
 * carrying both fields as properties to prove they are ignored.
 *
 * **A sole task's numbers are the phase's own row.** A synthesised sole
 * task has no `task_states` row at all, so the one-element array TaskTrackr
 * answers with has to be built from `phase_states`: status, score, attempts,
 * `passedAt` and the door's `readAt`, or every TaskTrackr phase would draw a
 * task that has never been attempted beside a phase that has passed.
 */

const content = new ContentService();
content.loadAll();

const PHASE_KEYS = [
  'requirements',
  'design',
  'implementation',
  'testing',
  'deployment',
  'maintenance',
] as const;

const phase = (key: string): PhaseContent => content.getPhase('tasktrackr', key);

/** Every TaskTrackr phase, as the loader produces it. */
const phases = (): PhaseContent[] => PHASE_KEYS.map((key) => phase(key));

/** A phase row that has not been attempted. */
const UNSTARTED: PhaseRowFacts = {
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  solutionReadAt: null,
};

/** A task keyed by an author, over the phase's own sole task. */
const authored = (over: Partial<CompiledTask> & { taskKey: string }): CompiledTask => ({
  ...soleTaskFor(phase('requirements')),
  ...over,
});

/** A `task_states` row carrying only what the assertion is about. */
const row = (over: Partial<TaskRowFacts> & { taskKey: string }): TaskRowFacts => ({
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  solutionReadAt: null,
  awaitingSignOff: false,
  resetAt: null,
  ...over,
});

describe('evidence and sealed are derived from the units', () => {
  it('reads the shipped project phase by phase, and never a field of the task', () => {
    // The proof the design states, phase by phase: requirements and design are
    // written and sealed by construction; implementation and maintenance own
    // hidden suites; testing owns a reference suite and its mutants;
    // deployment owns a smoke run. Every one of TaskTrackr's phases is sealed,
    // which is what makes the countersignature conjunct unreachable there.
    const words = Object.fromEntries(
      phases().map((one) => {
        const task = soleTaskFor(one);
        return [one.key, [sealedTask(one, task), evidenceOf(one, task)]];
      }),
    );
    expect(words).toEqual({
      requirements: [true, 'reviewed'],
      design: [true, 'reviewed'],
      implementation: [true, 'automated'],
      testing: [true, 'automated'],
      deployment: [true, 'automated'],
      maintenance: [true, 'automated'],
    });

    // Neither word is a field of the compiled task, so neither can be chosen.
    expect(Object.keys(soleTaskFor(phase('requirements')))).not.toContain('evidence');
    expect(Object.keys(soleTaskFor(phase('requirements')))).not.toContain('sealed');
  });

  it('answers assisted for a code task whose slice seals nothing', () => {
    const impl = phase('implementation');
    const open = impl.checks as CodeChecks;
    const task: CompiledTask = {
      ...soleTaskFor(impl),
      taskKey: 'main',
      checks: { ...open, hiddenTestFiles: {} },
    };
    // Nothing is withheld from the learner, so a pass of this task alone
    // cannot open the phase and the word says so.
    expect(sealedTask(impl, task)).toBe(false);
    expect(evidenceOf(impl, task)).toBe('assisted');
  });

  it('answers reviewed for a stored task of the retired written kind, as it did before the kind was retired', () => {
    const req = phase('requirements');
    const task: CompiledTask = { ...soleTaskFor(req), taskKey: 'main', checks: { kind: 'markdown', rules: [] } as never };
    expect(sealedTask(req, task)).toBe(true);
    expect(evidenceOf(req, task)).toBe('reviewed');
  });

  it('reads an older written phase a pinned version still holds as sealed and reviewed', () => {
    const impl = phase('implementation');
    const written = { ...impl, checks: { kind: 'markdown' } } as unknown as PhaseContent;
    const task = { ...soleTaskFor(impl), taskKey: 'main', checks: written.checks } as CompiledTask;
    expect(sealedTask(written, task)).toBe(true);
    expect(evidenceOf(written, task)).toBe('reviewed');
  });

  it('answers signed-off wherever a countersignature is the remaining half', () => {
    const req = phase('requirements');
    const task = { ...soleTaskFor(req), taskKey: 'main', signOff: true };
    // Sealed is still true (the evidence is in) and the word is the one that
    // says a teacher has still to put their name to it.
    expect(sealedTask(req, task)).toBe(true);
    expect(evidenceOf(req, task)).toBe('signed-off');
  });

  it('ignores an evidence or a sealed a caller wrote onto the task', () => {
    const req = phase('requirements');
    const impl = phase('implementation');
    const open = impl.checks as CodeChecks;
    const lying = {
      ...soleTaskFor(impl),
      taskKey: 'main',
      checks: { ...open, hiddenTestFiles: {} },
      evidence: 'automated',
      sealed: true,
    } as unknown as CompiledTask;
    const [view] = taskViews({ phase: impl, tasks: [lying], state: UNSTARTED });
    expect(view.sealed).toBe(false);
    expect(view.evidence).toBe('assisted');

    const honest = taskViews({ phase: req, tasks: [soleTaskFor(req)], state: UNSTARTED })[0];
    expect(honest.sealed).toBe(true);
    expect(honest.evidence).toBe('reviewed');
  });
});

describe('taskCounts', () => {
  it('counts passed over all tasks and passedRequired over the required set', () => {
    const req = phase('requirements');
    const tasks = [
      authored({ taskKey: 'story', order: 1, required: true }),
      authored({ taskKey: 'criteria', order: 2, required: true }),
      authored({ taskKey: 'scope', order: 3, required: false }),
      authored({ taskKey: 'glossary', order: 4, required: false }),
    ];
    const rows = [
      row({ taskKey: 'story', status: 'passed', passedAt: '2026-09-19T00:00:00.000Z' }),
      row({ taskKey: 'criteria', status: 'passed', passedAt: '2026-09-19T00:01:00.000Z' }),
      row({ taskKey: 'scope', status: 'passed', passedAt: '2026-09-19T00:02:00.000Z' }),
      row({ taskKey: 'glossary', status: 'submitted' }),
    ];
    const views = taskViews({ phase: req, tasks, state: UNSTARTED, rows });
    // "3 of 4 done, 2 of 2 required", both halves, because an optional task
    // is shown, scored and recorded and moves no gate.
    expect(taskCountsOf(views)).toEqual({
      total: 4,
      required: 2,
      passed: 3,
      passedRequired: 2,
    });
  });

  it('does not count a required task whose row is missing', () => {
    const req = phase('requirements');
    const tasks = [
      authored({ taskKey: 'story', order: 1, required: true }),
      authored({ taskKey: 'criteria', order: 2, required: true }),
    ];
    // The missing-row rule, at the surface a learner reads it on: a required key
    // with no row is a key that has not been passed, so the tile says one of
    // two rather than two of two.
    const views = taskViews({
      phase: req,
      tasks,
      state: UNSTARTED,
      rows: [row({ taskKey: 'story', status: 'passed', passedAt: '2026-09-19T00:00:00.000Z' })],
    });
    expect(taskCountsOf(views)).toEqual({
      total: 2,
      required: 2,
      passed: 1,
      passedRequired: 1,
    });
    expect(views[1]).toMatchObject({ key: 'criteria', status: 'in_progress', attempts: 0 });
  });

  it('is the phase’s own answer on a sole-task board', () => {
    for (const one of phases()) {
      const state: PhaseRowFacts = {
        status: 'passed',
        bestScore: 91,
        attempts: 3,
        passedAt: '2026-09-19T00:00:00.000Z',
        solutionReadAt: null,
      };
      const views = taskViews({ phase: one, tasks: [soleTaskFor(one)], state });
      expect(taskCountsOf(views)).toEqual({
        total: 1,
        required: 1,
        passed: 1,
        passedRequired: 1,
      });
    }
  });
});

describe('the two views', () => {
  it('the summary view omits the four heavy fields', () => {
    const req = phase('requirements');
    const tasks = [authored({ taskKey: 'story' })];

    const summary = taskViews({ phase: req, tasks, state: UNSTARTED, view: 'summary' })[0];
    expect(summary.brief).toBeUndefined();
    expect(summary.objectives).toBeUndefined();
    expect(summary.files).toBeUndefined();
    expect(summary.rubric).toBeUndefined();
    // What the tile and the room header draw is still there.
    expect(summary).toMatchObject({
      key: 'story',
      order: 1,
      required: true,
      title: expect.any(String),
      status: 'in_progress',
      attempts: 0,
      bestScore: null,
    });

    const full = taskViews({ phase: req, tasks, state: UNSTARTED, view: 'full' })[0];
    // what a learner reads of the version's texts, plain, HTML comments not shown
    expect(full.brief).toBe(learnerText(tasks[0].brief));
    expect(full.objectives).toEqual(tasks[0].objectives.map(learnerText));
    expect(full.files).toEqual(tasks[0].owns);
    expect(full.rubric).toEqual(learnerRubric(tasks[0].rubric));
  });

  it('defaults to the full view, which is what the room already fetches', () => {
    const req = phase('requirements');
    const full = taskViews({ phase: req, tasks: [soleTaskFor(req)], state: UNSTARTED })[0];
    expect(full.rubric).toEqual(req.rubric);
  });
});

describe('where a task’s numbers come from', () => {
  it('reads a sole task from the phase row, because it has none of its own', () => {
    // At the surface: TaskTrackr writes no `task_states` row at all, so a
    // builder that read only rows would draw six untouched tasks over a
    // finished project.
    for (const one of phases()) {
      const state: PhaseRowFacts = {
        status: 'passed',
        bestScore: 88,
        attempts: 2,
        passedAt: '2026-09-19T00:00:00.000Z',
        solutionReadAt: '2026-09-19T01:00:00.000Z',
      };
      const [view] = taskViews({ phase: one, tasks: [soleTaskFor(one)], state });
      expect(view).toMatchObject({
        key: '',
        order: 1,
        required: true,
        status: 'passed',
        bestScore: 88,
        attempts: 2,
        passedAt: '2026-09-19T00:00:00.000Z',
        awaitingSignOff: false,
        resetAt: null,
      });
      expect(view.solution.readAt).toBe('2026-09-19T01:00:00.000Z');
    }
  });

  it('reads an authored task from its own row and never from the phase', () => {
    const req = phase('requirements');
    const tasks = [
      authored({ taskKey: 'story', order: 1 }),
      authored({ taskKey: 'scope', order: 2, required: false }),
    ];
    const state: PhaseRowFacts = {
      status: 'passed',
      bestScore: 100,
      attempts: 9,
      passedAt: '2026-09-19T00:00:00.000Z',
      solutionReadAt: '2026-09-19T00:00:00.000Z',
    };
    const views = taskViews({
      phase: req,
      tasks,
      state,
      rows: [
        row({
          taskKey: 'story',
          status: 'submitted',
          bestScore: 40,
          attempts: 1,
          solutionReadAt: '2026-09-18T00:00:00.000Z',
          awaitingSignOff: true,
          resetAt: '2026-09-17T00:00:00.000Z',
        }),
      ],
      lastSubmissionIds: new Map([['story', 'sub-1']]),
    });
    expect(views[0]).toMatchObject({
      key: 'story',
      status: 'submitted',
      bestScore: 40,
      attempts: 1,
      passedAt: null,
      awaitingSignOff: true,
      resetAt: '2026-09-17T00:00:00.000Z',
      lastSubmissionId: 'sub-1',
    });
    expect(views[0].solution.readAt).toBe('2026-09-18T00:00:00.000Z');
    // The sibling has no row, so it reads unstarted, and neither task takes
    // the phase's 100, its nine attempts or its stamp.
    expect(views[1]).toMatchObject({
      key: 'scope',
      status: 'in_progress',
      bestScore: null,
      attempts: 0,
      passedAt: null,
      lastSubmissionId: null,
    });
    expect(views[1].solution.readAt).toBeNull();
  });

  it('carries the door the pack answers for that task, and no other', () => {
    // A written task's door is shut by `referenceFiles`' own answer, whatever
    // the gate says; a code task's is the files it answers for.
    const [written] = taskViews({
      phase: phase('requirements'),
      tasks: [soleTaskFor(phase('requirements'))],
      state: UNSTARTED,
    });
    expect(written.solution).toEqual({ available: false, files: 0, readAt: null });

    const impl = phase('implementation');
    const [code] = taskViews({ phase: impl, tasks: [soleTaskFor(impl)], state: UNSTARTED });
    expect(code.solution.available).toBe(true);
    expect(code.solution.files).toBeGreaterThan(0);
  });

  it('answers the tasks in the order the version declares them', () => {
    const req = phase('requirements');
    const views = taskViews({
      phase: req,
      tasks: [
        authored({ taskKey: 'story', order: 1 }),
        authored({ taskKey: 'criteria', order: 2 }),
        authored({ taskKey: 'scope', order: 3, required: false }),
      ],
      state: UNSTARTED,
    });
    expect(views.map((view) => view.key)).toEqual(['story', 'criteria', 'scope']);
    expect(views.map((view) => view.order)).toEqual([1, 2, 3]);
    expect(views.map((view) => view.required)).toEqual([true, true, false]);
  });

  it('names the file the room reads, and the file the IDE opens', () => {
    // a written document task: the prose file it owns is both (on TaskTrackr 4.0.0's Deployment, the frozen older
    // shape: Design is a design phase since 4.0.0, and Deployment's runbook a record since 5.0.0)
    const written = new ContentService().loadProject(layoutFromManifest(olderTaskTrackrPack()).source).phases.find((one) => one.key === 'deployment')!;
    const [doc] = taskViews({
      phase: written,
      tasks: [{ ...soleTaskFor(written), taskKey: 'doc', artefactType: 'document', owns: ['RUNBOOK.md'] }],
      state: UNSTARTED,
    });
    expect(doc.artefactPath).toBe('RUNBOOK.md');
    expect(doc.primaryPath).toBe('RUNBOOK.md');
    // a story task reads no prose file: the room is the story form over its record
    const req = phase('requirements');
    const [story] = taskViews({ phase: req, tasks: [soleTaskFor(req)], state: UNSTARTED });
    expect(story.artefactPath).toBeUndefined();
    expect(story.primaryPath).toBe('requirements/story.json');

    const impl = phase('implementation');
    const [code] = taskViews({ phase: impl, tasks: [soleTaskFor(impl)], state: UNSTARTED });
    // `code` and `tests` have no single artefact file; the room opens the
    // first path the task owns, which is what the IDE falls back to.
    expect(code.artefactPath).toBeUndefined();
    expect(code.primaryPath).toBe(soleTaskFor(impl).owns[0]);
  });
});

/* ---------------------------------- quizzes --------------------------------- */

describe('a quiz is sealed by its key and decided by a machine', () => {
  it('sealedTask reads the questions and evidenceOf answers automated', () => {
    // One of the five sites the compiler finds: a switch returning `boolean`
    // with no default. A quiz is sealed by its key (the answer never leaves
    // the API on any route at any time) so a pass of it alone can open the
    // phase, and `evidenceOf` says `automated` because a paper is
    // machine-decided and deterministic, which is what that word means here.
    const written = phase('design');
    const quiz = authored({
      taskKey: 'check',
      checkKind: 'quiz',
      artefactType: 'quiz',
      artefactPath: null,
      owns: [],
      checks: fixtureQuizChecks(),
    });
    expect(sealedTask(written, quiz)).toBe(true);
    expect(evidenceOf(written, quiz)).toBe('automated');

    // a quiz with no questions seals nothing: the shape
    // `quiz-questions-well-formed` refuses before it can be published
    const empty = { ...quiz, checks: fixtureQuizChecks({ questions: [], drawn: undefined }) };
    expect(sealedTask(written, empty)).toBe(false);
    expect(evidenceOf(written, empty)).toBe('assisted');

    // and a countersignature still answers first, because it is the stronger
    // statement about how the task is settled
    expect(evidenceOf(written, { ...quiz, signOff: true })).toBe('signed-off');
  });
});

/* ------------------- the seal, as a test rather than a claim --------------- */

/**
 * **What the browser is handed for a quiz, field by field.**
 *
 * The whole answer door rests on one sentence about this file: `taskViews`
 * builds `PhaseTaskView` field by field and carries `brief`, `objectives`,
 * `files` and `rubric` and nothing else, so a task's `checks` slice, where
 * `correct`, `explanation` and every undrawn question live, has no way out of
 * the API. That is the same construction that keeps `hiddenTestFiles` and the
 * customer interview's answers out of the browser; this spec makes it a test
 * of the code rather than a claim about it.
 *
 * The loud failure: the key list
 * below is exact, so a later hand that adds `checks` to the construction, or
 * a question, or an explanation, turns a silent leak into a red spec.
 */

/** Every key that appears anywhere in a payload, however deep. */
const keysDeep = (value: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const one of value) keysDeep(one, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, held] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      keysDeep(held, into);
    }
  }
  return into;
};

/**
 * Field names that only ever appear inside a `checks` slice: the quiz's key,
 * its questions and its explanations, and the sealed maps and units a `code` or
 * `tests` phase ships. None of them may appear at any depth of a learner's
 * payload, whatever kind of task the phase holds.
 */
const SEALED_FIELDS = [
  'checks',
  'questions',
  'correct',
  'explanation',
  'options',
  'stem',
  'concept',
  'passMark',
  'criterion',
  'drawn',
  'shuffleOptions',
  'solutionFiles',
  'hiddenTestFiles',
  'referenceTestFiles',
  'mutants',
  'runs',
];

const sealedFieldsIn = (payload: unknown): string[] =>
  [...keysDeep(payload)].filter((key) => SEALED_FIELDS.includes(key)).sort();

/** The fields every full view carries, whatever kind of task it is about. */
const FULL_VIEW_FIELDS = [
  'key',
  'order',
  'required',
  'title',
  'artefactType',
  'evidence',
  'sealed',
  'status',
  'awaitingSignOff',
  'attempts',
  'bestScore',
  'passedAt',
  'lastSubmissionId',
  'resetAt',
  'solution',
  'brief',
  'objectives',
  'files',
  'rubric',
];

/**
 * A quiz task beside whichever phase it is added to: it owns no path, mints no
 * artefact, and declares its own `QuizChecks` slice, which is the shape
 * `quiz-owns-no-file` holds it to and the reason the slice exemption is
 * written for the executable task and never for the quiz.
 */
const quizBeside = (host: PhaseContent, over: Partial<CompiledTask> = {}): CompiledTask => ({
  ...soleTaskFor(host),
  taskKey: 'concepts',
  order: 2,
  required: false,
  checkKind: 'quiz',
  artefactType: 'quiz',
  artefactPath: null,
  owns: [],
  title: 'Fixture quiz "concepts"',
  brief: FIXTURE_QUIZ_NOTICE,
  gradedUnits: fixtureQuizChecks().questions.map((question) => ({
    kind: 'question' as const,
    id: question.id,
  })),
  rubric: fixtureQuizRubric(),
  checks: fixtureQuizChecks(),
  ...over,
});

describe('a quiz reaches the learner sealed', () => {
  it('carries the type, the word, and not one field of its key', () => {
    const written = phase('design');
    const quiz = quizBeside(written);
    const [view] = taskViews({ phase: written, tasks: [quiz], state: UNSTARTED });

    // Proofs 2 and 4, at the surface: the type picks the room, the word says a
    // machine decided it, and the questions stay in the snapshot.
    expect(view.artefactType).toBe('quiz');
    expect(view.evidence).toBe('automated');
    expect(view.sealed).toBe(true);

    // The exact payload. This list is the seal: adding `checks` to the
    // construction at `task-view.ts` fails here rather than in production.
    expect(Object.keys(view).sort()).toEqual([...FULL_VIEW_FIELDS].sort());
    // and neither file field is drawn for a quiz, because a quiz owns no path
    expect(view.artefactPath).toBeUndefined();
    expect(view.primaryPath).toBeUndefined();

    expect(sealedFieldsIn(view)).toEqual([]);

    // The text itself, and not only the field names it would have arrived
    // under: no stem, no option, no explanation, no concept, drawn or undrawn.
    const wire = JSON.stringify(view);
    for (const question of fixtureQuizChecks().questions) {
      expect(wire).not.toContain(question.stem);
      expect(wire).not.toContain(question.explanation);
      expect(wire).not.toContain(question.concept as string);
      for (const option of question.options) expect(wire).not.toContain(option.text);
    }
  });

  it('holds in the summary view as well as the full one', () => {
    const written = phase('design');
    const [summary] = taskViews({
      phase: written,
      tasks: [quizBeside(written)],
      state: UNSTARTED,
      view: 'summary',
    });
    // The summary drops the four heavy fields and nothing else changes about
    // what a quiz is allowed to carry.
    expect(Object.keys(summary).sort()).toEqual(
      FULL_VIEW_FIELDS.filter(
        (field) => !['brief', 'objectives', 'files', 'rubric'].includes(field),
      ).sort(),
    );
    expect(sealedFieldsIn(summary)).toEqual([]);
  });

  it('seals the quiz and the phase’s answer alike, in a code phase', () => {
    // The seal that only matters once a passing task sits beside a phase that
    // ships an answer: the sibling's checks carry `solutionFiles` and
    // `hiddenTestFiles`, and the quiz's carry the key.
    const impl = phase('implementation');
    const open = impl.checks as CodeChecks;
    expect(Object.keys(open.hiddenTestFiles).length).toBeGreaterThan(0);
    expect(Object.keys(open.solutionFiles).length).toBeGreaterThan(0);

    // The slice exemption: the sole non-quiz task declares no slice of its own, so
    // `checksOf` answers the phase's and the snapshot carries them once.
    const code: CompiledTask = { ...soleTaskFor(impl), taskKey: 'main' };
    const quiz = quizBeside(impl);
    const views = taskViews({
      phase: impl,
      tasks: [code, quiz],
      state: UNSTARTED,
      rows: [
        row({
          taskKey: 'main',
          status: 'passed',
          passedAt: '2026-09-19T00:00:00.000Z',
          solutionReadAt: '2026-09-19T01:00:00.000Z',
        }),
      ],
    });

    // Neither task's payload carries a sealed field, and the hidden suite's
    // own paths are nowhere in either.
    expect(sealedFieldsIn(views)).toEqual([]);
    const wire = JSON.stringify(views);
    for (const path of Object.keys(open.hiddenTestFiles)) expect(wire).not.toContain(path);
    for (const question of fixtureQuizChecks().questions) {
      expect(wire).not.toContain(question.stem);
      expect(wire).not.toContain(question.explanation);
    }
    expect(Object.keys(views[0]).sort()).toEqual([...FULL_VIEW_FIELDS, 'primaryPath'].sort());
    expect(Object.keys(views[1]).sort()).toEqual([...FULL_VIEW_FIELDS].sort());

    // And the other side of the same wall, off the same fixture: server-side
    // both slices are whole (the scorer has the quiz's key, the grader has
    // the phase's hidden suite) and neither crossed into the payload above.
    const held = checksOf(impl, quiz);
    expect(held.kind).toBe('quiz');
    if (held.kind !== 'quiz') throw new Error('unreachable');
    expect(held.questions.map((question) => question.correct)).toEqual(
      fixtureQuizChecks().questions.map((question) => question.correct),
    );
    expect((checksOf(impl, code) as CodeChecks).hiddenTestFiles).toBe(open.hiddenTestFiles);

    // The two doors, off one fixture. The quiz's is shut and says why in the
    // pack's own word: a quiz that fell back to the phase's checks would
    // reach `case 'code'` and hand the learner the model answer through a gate
    // its own pass had opened.
    expect(referenceFiles(impl, quiz)).toEqual({ available: false, reason: 'quiz', files: [] });
    expect(views[1].solution).toEqual({ available: false, files: 0, readAt: null });

    // And the executable task's door is the one the pack answers for, still
    // drawn beside it.
    const answer = referenceFiles(impl, code);
    expect(answer.available).toBe(true);
    expect(answer.files.length).toBeGreaterThan(0);
    expect(views[0].solution).toEqual({
      available: true,
      files: answer.files.length,
      readAt: '2026-09-19T01:00:00.000Z',
    });
  });
});

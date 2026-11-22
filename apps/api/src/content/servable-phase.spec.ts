import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { EXECUTABLE_SPLIT_NOT_READY, type PhaseKey, type PhaseRubric } from '@learnsdlc/shared';
import {
  executablePhase,
  fixtureQuizChecks,
  fixtureQuizQuestions,
  soleGradedTask,
  writtenPhase,
} from '../../test/quiz-fixture';
import { ContentService, describeUnservableVersion } from './content.service';
import type {
  CodeChecks,
  ContentFileSpec,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  ProjectContent,
  TestsChecks,
} from './content.types';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledPhaseTasks,
  type CompiledTask,
} from './pack-compiler';

/**
 * The runtime wall, and the one statement it shares with the compiler.
 *
 * `servablePhase` is the second, runtime statement of the executable wall. The
 * compiler refuses at publish; this one refuses at the seam an enrolment
 * resolves through, because a published snapshot is immutable, is installed
 * verbatim, and can arrive from somewhere this build never compiled: a
 * rolling upgrade, the revert of one, a restore from a later build's backup.
 *
 * The compiler refuses a **shape**, not a **count**. A runtime statement that
 * refused on the count would refuse versions the compiler publishes: publish
 * would succeed, `installVersions` would record the version as
 * unservable, and every learner pinned to it would take a 500 on their next
 * board. That failure is invisible at publish and total at resolve, which is
 * why the two statements have to be one statement: the same two arms, the
 * same conjuncts, never a loosened kind test.
 *
 * So the table below is **one fixture read by two readers**. For every shape,
 * the compiler is asked whether it publishes and the runtime is asked whether
 * it serves, and the two answers must be the same answer. The third column is
 * the expected answer, written by hand, so a shape both readers got wrong in the same
 * direction cannot pass quietly.
 *
 * None of these fixtures is TaskTrackr. They are hand-built packs, so the
 * golden nets cannot move.
 */

/* ------------------------------- fixtures --------------------------------- */

const file = (path: string, editable: boolean, language = 'python'): ContentFileSpec => ({
  path,
  content: '# x\n',
  editable,
  language,
});

const run = (id: string, over: Partial<PhaseRun> = {}): PhaseRun => ({
  id,
  language: 'python',
  harness: 'unittest',
  hiddenHarness: 'unittest',
  label: id,
  transform: false,
  testPaths: [],
  visibleTests: [],
  hiddenTestFiles: {},
  learnerTestFiles: [],
  referenceTestFiles: {},
  implFiles: {},
  supportFiles: {},
  ...over,
});

const rubricOf = (...keys: string[]): PhaseRubric => ({
  passThreshold: 70,
  criteria: keys.map((key) => ({ key, title: key, weight: 1 / keys.length, description: 'd' })),
});

const phaseOf = (key: PhaseKey, checks: PhaseChecks, files: ContentFileSpec[]): PhaseContent => ({
  key,
  order: 1,
  title: `the ${key} phase`,
  intro: 'i',
  artifactKind: checks.kind,
  language: 'python',
  canRun: true,
  runLabel: 'Run',
  taskPanel: 'the brief',
  objectives: ['one'],
  files,
  rubric: rubricOf('clarity'),
  checks,
  assistant: { systemPrompt: 's', topics: [], progressive: [] },
  canPreview: false,
});

const packOf = (phase: PhaseContent): ProjectContent => ({
  slug: 'servable-fixture',
  version: '1.0.0',
  title: 'a fixture',
  tagline: 't',
  description: 'd',
  language: 'python',
  languages: ['python'],
  phases: [phase],
});

const TEST_FILE = 'tests/test_acceptance.py';
const IMPL_FILE = 'api/repository/tasks.py';

const testsPhase = (): PhaseContent =>
  phaseOf(
    'testing',
    {
      kind: 'tests',
      learnerTestFiles: [TEST_FILE],
      referenceTestFiles: {},
      implFiles: {},
      mutants: [],
      coverageKeywords: [],
      minTests: 0,
      supportFiles: {},
      runs: [run('api')],
    } satisfies TestsChecks,
    [file(TEST_FILE, true)],
  );

const codePhase = (): PhaseContent =>
  phaseOf(
    'implementation',
    {
      kind: 'code',
      editableTargets: [IMPL_FILE],
      visibleTests: [],
      hiddenTestFiles: {},
      solutionFiles: {},
      solutionSources: [],
      runs: [run('api')],
    } satisfies CodeChecks,
    [file(IMPL_FILE, true)],
  );

/** The phase's one graded task, with the units the phase actually declares. */
const gradedTask = (phase: PhaseContent, over: Partial<AuthoredTask> = {}): AuthoredTask => ({
  ...soleGradedTask(phase),
  gradedUnits: gradedUnitsOf(phase),
  ...over,
});

/** A quiz task, authored: owns nothing, mints nothing, grades its own pool. */
const quizTask = (taskKey: string, order: number, prefix = 'q'): AuthoredTask => {
  const checks = fixtureQuizChecks({ questions: fixtureQuizQuestions(3, prefix) });
  return {
    taskKey,
    order,
    required: false,
    artefactType: 'quiz',
    artefactPath: null,
    owns: [],
    gradedUnits: checks.questions.map((one) => ({ kind: 'question' as const, id: one.id })),
    rubric: {
      passThreshold: 70,
      criteria: [{ key: checks.criterion, title: 'Concepts', weight: 1, description: 'd' }],
    },
    checks,
  };
};

/**
 * An authored task as a snapshot would carry it, hand-built.
 *
 * Hand-built because a shape the compiler **refuses** has no compiled snapshot
 * to read, and the whole point of the runtime wall is what happens when one
 * arrives anyway. The three fields `servablePhase` reads (the kind that
 * scores the task, the units it owns and the paths it owns) are stated here;
 * everything else is the phase's own sole task, which is what the compiler
 * would have filled in.
 */
const asCompiled = (phase: PhaseContent, one: AuthoredTask): CompiledTask => {
  const checks = one.checks ?? phase.checks;
  return {
    ...soleTaskFor(phase),
    taskKey: one.taskKey,
    order: one.order,
    required: one.required !== false,
    checkKind: checks.kind,
    ...(one.artefactType ? { artefactType: one.artefactType } : {}),
    ...(one.artefactPath !== undefined ? { artefactPath: one.artefactPath } : {}),
    owns: [...one.owns],
    gradedUnits: one.gradedUnits.map((unit) => ({ kind: unit.kind, id: unit.id })),
    ...(one.checks ? { checks: one.checks } : {}),
  };
};

type Shape = {
  what: string;
  phase: PhaseContent;
  authored: AuthoredTask[];
  /** What the wall, restated here independently of the code, says about it. */
  published: boolean;
};

/** The compiler's answer, and the rows it wrote when it published. */
const compiled = (shape: Shape): CompiledPhaseTasks[] | null => {
  try {
    return compilePack(packOf(shape.phase), {
      authored: { [shape.phase.key]: shape.authored },
    }).phases;
  } catch {
    return null;
  }
};

/**
 * The runtime's answer, read off the compiler's own rows where it published
 * and off the hand-built ones where it did not.
 */
const servable = (shape: Shape, rows: CompiledPhaseTasks[] | null): boolean => {
  const content = packOf(shape.phase);
  const phases = rows ?? [
    { key: shape.phase.key, tasks: shape.authored.map((one) => asCompiled(shape.phase, one)) },
  ];
  const service = new ContentService();
  service.installVersions([
    { versionId: 'v-1', content, compiler: COMPILER_IDENTITY, phases },
  ]);
  return service.unservableVersions().length === 0;
};

/* ------------------------------ the two arms ------------------------------ */

describe('the runtime wall answers what the compiler answers', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    // `installVersions` prints the refusal at boot, which is the point of it:
    // but a table of ten shapes would print ten lines over the suite.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  const shapes = (): Shape[] => {
    const written = writtenPhase();
    const config = executablePhase(true);
    const tests = testsPhase();
    const code = codePhase();
    const quizOnly = phaseOf('design', fixtureQuizChecks(), []);
    return [
      // Arm one: written work, split. No rule change reaches it.
      {
        what: 'a markdown phase holding its written task and a quiz',
        phase: written,
        authored: [gradedTask(written), quizTask('check', 2)],
        published: true,
      },
      // Arm two: the all-six-phases rule, in all three executable kinds.
      {
        what: 'a config phase holding its one executable task and a quiz',
        phase: config,
        authored: [gradedTask(config), quizTask('check', 2)],
        published: true,
      },
      {
        what: 'a tests phase holding its one executable task and a quiz',
        phase: tests,
        authored: [gradedTask(tests), quizTask('check', 2)],
        published: true,
      },
      {
        what: 'a tests phase holding its one executable task and three quizzes',
        phase: tests,
        authored: [
          gradedTask(tests),
          quizTask('a', 2, 'a'),
          quizTask('b', 3, 'b'),
          quizTask('c', 4, 'c'),
        ],
        published: true,
      },
      // The count conjunct: two tasks that are not quizzes divide the work.
      {
        what: 'a tests phase holding two executable tasks',
        phase: tests,
        authored: [
          gradedTask(tests, { taskKey: 'one', gradedUnits: [{ kind: 'run', id: 'api' }] }),
          gradedTask(tests, {
            taskKey: 'two',
            order: 2,
            gradedUnits: [],
            checks: tests.checks,
          }),
        ],
        published: false,
      },
      // The kind conjunct: exactly one task is not a quiz, and it owns every
      // unit and every path, but it is graded by the wrong grader.
      {
        what: 'a code phase whose one graded task is a story, with a quiz beside it',
        phase: code,
        authored: [
          gradedTask(code, {
            taskKey: 'notes',
            checks: writtenPhase().checks,
          }),
          quizTask('check', 2),
        ],
        published: false,
      },
      // The unit conjunct.
      {
        what: 'a config phase whose one graded task leaves a declared unit unowned',
        phase: config,
        authored: [
          gradedTask(config, { gradedUnits: gradedUnitsOf(config).slice(0, 1) }),
          quizTask('check', 2),
        ],
        published: false,
      },
      // The path conjunct.
      {
        what: 'a config phase whose one graded task owns none of its editable files',
        phase: config,
        authored: [gradedTask(config, { owns: [] }), quizTask('check', 2)],
        published: false,
      },
      // Arm one is not a loosened kind test either: an executable slice on a
      // written phase reaches the executable builders through a phase the
      // phase-level test called written.
      {
        what: 'a markdown phase holding a task graded by the config grader',
        phase: written,
        authored: [
          gradedTask(written),
          gradedTask(written, { taskKey: 'shipped', order: 2, checks: config.checks }),
        ],
        published: false,
      },
      // A phase that is a quiz and nothing else has no sole non-quiz task.
      {
        what: 'a phase whose own checks are quiz, holding two quizzes',
        phase: quizOnly,
        authored: [quizTask('one', 1, 'y'), quizTask('two', 2, 'z')],
        published: false,
      },
    ];
  };

  it.each(shapes().map((shape) => [shape.what, shape] as const))(
    'one statement, two readers: %s',
    (_what, shape) => {
      const rows = compiled(shape);
      // the compiler, first
      expect({ what: shape.what, publishes: rows !== null }).toEqual({
        what: shape.what,
        publishes: shape.published,
      });
      // and the runtime, off the same fixture
      expect({ what: shape.what, servable: servable(shape, rows) }).toEqual({
        what: shape.what,
        servable: shape.published,
      });
    },
  );

  it('a phase of one task is servable whatever grades it, which is the mainline', () => {
    // Not a concession: every phase of every teacher-authored project holds
    // exactly one authored task keyed `main`, of whatever kind the phase is
    // graded by, and refusing those would refuse every teacher project.
    for (const phase of [writtenPhase(), executablePhase(true), testsPhase(), codePhase()]) {
      const shape: Shape = { what: phase.key, phase, authored: [gradedTask(phase)], published: true };
      expect({ key: phase.key, servable: servable(shape, compiled(shape)) }).toEqual({
        key: phase.key,
        servable: true,
      });
    }
  });

  it('the executable task still owns everything the phase declares', () => {
    // The invariant the second arm rests on, read off the rows the compiler
    // actually wrote rather than off the ones the fixture asked for.
    const phase = executablePhase(true);
    const shape: Shape = {
      what: 'config plus a quiz',
      phase,
      authored: [gradedTask(phase), quizTask('check', 2)],
      published: true,
    };
    const rows = compiled(shape) as CompiledPhaseTasks[];
    const [only, quiz] = rows[0].tasks;
    expect(only.gradedUnits).toEqual(gradedUnitsOf(phase));
    for (const at of editablePathsOf(phase)) expect(only.owns).toContain(at);
    expect(quiz.checkKind).toBe('quiz');
    expect(quiz.owns).toEqual([]);
  });
});

/* ----------------------- the seam, and the sentence ----------------------- */

describe('a snapshot with two executable tasks is still refused at the seam', () => {
  const phase = testsPhase();
  const twoExecutable: CompiledPhaseTasks[] = [
    {
      key: phase.key,
      tasks: [
        asCompiled(phase, gradedTask(phase, { taskKey: 'one' })),
        asCompiled(phase, gradedTask(phase, { taskKey: 'two', order: 2, checks: phase.checks })),
      ],
    },
  ];

  const installed = (): { service: ContentService; said: string } => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const service = new ContentService();
      service.installVersions([
        {
          versionId: 'v-split-tests',
          content: packOf(phase),
          compiler: COMPILER_IDENTITY,
          phases: twoExecutable,
        },
      ]);
      return { service, said: warn.mock.calls.map((call) => String(call[0])).join(' ') };
    } finally {
      warn.mockRestore();
    }
  };

  it('is recorded at install and thrown at resolveForEnrollment', () => {
    const { service, said } = installed();
    expect(service.unservableVersions()).toEqual([
      {
        versionId: 'v-split-tests',
        slug: 'servable-fixture',
        version: '1.0.0',
        phaseKey: 'testing',
        tasks: 2,
      },
    ]);
    // An operator reads it at boot rather than when a learner hits it.
    expect(said).toContain('servable-fixture');
    expect(said).toContain('testing');
    expect(said).toContain(EXECUTABLE_SPLIT_NOT_READY);

    // And the seam reads shut for every phase of that version, not only the
    // split one: without this, the executable builders grade both tasks
    // against the whole phase's suite.
    const at = { projectSlug: 'servable-fixture', projectVersionId: 'v-split-tests' };
    expect(() => service.getForEnrollment(at)).toThrow(/testing/);
    expect(() => service.getForEnrollment(at)).toThrow(new RegExp(EXECUTABLE_SPLIT_NOT_READY));
    expect(() => service.getTasksForEnrollment(at, 'testing')).toThrow(/testing/);
  });

  it("names the phase and carries the wall's own sentence", () => {
    const said = describeUnservableVersion({
      versionId: 'v-split-tests',
      slug: 'servable-fixture',
      version: '1.0.0',
      phaseKey: 'testing',
      tasks: 2,
    });
    expect(said).toContain('"testing"');
    expect(said).toContain('2 tasks');
    expect(said).toContain(EXECUTABLE_SPLIT_NOT_READY);
    // The wording moved exactly where the wall's did: it names the two arms a
    // snapshot may take rather than claiming several tasks are only ever
    // written work, which the all-six-phases rule made false.
    expect(said).toContain('neither grades written work alone');
    expect(said).toContain('exactly one task doing its executable work');
    // and the operator's two remedies are where they were
    expect(said).toContain('Deploy a build that can grade it, or publish a version this one can.');
  });
});

/* ------------------- stored rows the compiler does not produce ------------------- */

/**
 * A stored older written phase, outside the table above.
 *
 * The table is one fixture read by two readers, and this shape has only one
 * reader: an upload never publishes markdown checks (the loader converts
 * an older Requirements or Design and refuses the kind under any other key),
 * and when a draft whose conversion was refused reaches Validate, the
 * compiler's wall refuses it there. Such rows can still be stored, published
 * under arm one of the servable rule, and an enrolment resolves through
 * them. So the runtime is asked alone, off hand-built rows, and the expected
 * answers are written by hand.
 */
describe('a stored older written phase, which only the runtime reads', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  /** A phase under `key` whose checks are the older markdown kind. */
  const olderWritten = (key: PhaseKey): PhaseContent =>
    phaseOf(
      key,
      { kind: 'markdown', targets: ['requirements/my-story.md'], rules: [] } as unknown as PhaseChecks,
      [file('requirements/my-story.md', true, 'markdown')],
    );

  /** A written task as such a stored snapshot carries it: graded by the markdown kind. */
  const writtenTask = (phase: PhaseContent, taskKey: string, order: number): CompiledTask => ({
    ...asCompiled(phase, gradedTask(phase, { taskKey, order })),
    checkKind: 'markdown' as never,
  });

  const serves = (phase: PhaseContent, tasks: CompiledTask[]): boolean =>
    servable(
      { what: phase.key, phase, authored: [], published: false },
      [{ key: phase.key, tasks }],
    );

  it.each(['requirements', 'design'] as const)(
    'serves a stored %s of two written tasks and a quiz',
    (key) => {
      const phase = olderWritten(key);
      expect(
        serves(phase, [
          writtenTask(phase, 'story', 1),
          writtenTask(phase, 'criteria', 2),
          asCompiled(phase, quizTask('concepts', 3)),
        ]),
      ).toBe(true);
    },
  );

  it('refuses the same shape under a retired key', () => {
    const phase = olderWritten('testing');
    expect(
      serves(phase, [
        writtenTask(phase, 'story', 1),
        writtenTask(phase, 'criteria', 2),
        asCompiled(phase, quizTask('concepts', 3)),
      ]),
    ).toBe(false);
  });

  it('refuses a stored older Requirements holding a task graded by an executable kind', () => {
    // Not a loosened kind test: the arm reads every task, so one executable
    // slice on the older phase still reaches the executable builders.
    const phase = olderWritten('requirements');
    expect(
      serves(phase, [
        writtenTask(phase, 'story', 1),
        asCompiled(phase, gradedTask(phase, { taskKey: 'shipped', order: 2, checks: executablePhase(true).checks })),
      ]),
    ).toBe(false);
  });

  it('the control: a stored phase of two executable tasks is still refused', () => {
    const phase = testsPhase();
    expect(
      serves(phase, [
        asCompiled(phase, gradedTask(phase, { taskKey: 'one' })),
        asCompiled(phase, gradedTask(phase, { taskKey: 'two', order: 2, checks: phase.checks })),
      ]),
    ).toBe(false);
  });
});

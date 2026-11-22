import 'reflect-metadata';
import {
  API_CONTRACT_JSON,
  DESIGN_JSON,
  EXECUTABLE_SPLIT_NOT_READY,
  type PhaseKey,
  type PhaseRubric,
  type QuizChecks,
} from '@learnsdlc/shared';
import {
  COMPOSE,
  DOCKERFILE,
  STORY_RECORD,
  compiledQuizSnapshot,
  executablePhase,
  fixturePack,
  fixtureQuizChecks,
  fixtureQuizQuestions,
  fixtureQuizTask,
  soleGradedTask,
  writtenPhase,
} from '../../test/quiz-fixture';
import { ARTIFACT_KINDS, ContentService, validateDesignChecks } from './content.service';
import { scoredRubricKeys } from './rubric-scoring';
import { evidenceOf, sealedTask } from '../workflow/task-view';
import type {
  CodeChecks,
  ConfigChecks,
  ContentFileSpec,
  FileRule,
  PhaseChecks,
  PhaseContent,
  PhaseRun,
  ProjectContent,
  StoryChecks,
  TestsChecks,
} from './content.types';
import {
  COMPILER_IDENTITY,
  compilePack,
  contentDigestOf,
  editablePathsOf,
  gradedPathsOf,
  gradedUnitsOf,
  sandboxBudgetFor,
  type AuthoredTask,
} from './pack-compiler';

/**
 * The compile-time rules, and the three walls on a split phase's phase-wide
 * readers.
 *
 * Every rule here is a **publish** error in the style the loader already uses:
 * a sentence naming the phase and the field. A phase with one task passes them
 * all untouched, so the imported default project compiles cleanly. The rules
 * live with the model rather than with the editor, so whatever surface splits a
 * phase, the shapes that cannot be graded are unpublishable: a task nothing scores, a phase-wide test threshold neither of
 * two tasks can read, an incident drill two tasks would each pay a microVM for.
 *
 * The fixtures are hand-built, minimal and deliberately not loaded from disk:
 * the point of each is one rule, and a fixture that had to be a valid pack
 * would test the loader instead.
 */

/* ------------------------------- fixtures --------------------------------- */

const file = (path: string, editable: boolean, language = 'python'): ContentFileSpec => ({
  path,
  content: '# x\n',
  editable,
  language,
});

/** A file rule over `target` (the requirements draft unless named). */
const rule = (id: string, target = 'requirements/draft.md', criterion = 'clarity'): FileRule => ({
  id,
  label: id,
  criterion,
  pattern: 'x',
  required: true,
  failDetail: 'no',
  target,
});
const fileRule = (id: string, target: string, criterion = 'clarity'): FileRule => rule(id, target, criterion);

/** A rubric claiming exactly these criterion keys, weights summing to 1. */
const rubricOf = (...keys: string[]): PhaseRubric => ({
  passThreshold: 70,
  criteria: keys.map((key) => ({ key, title: key, weight: 1 / keys.length, description: 'd' })),
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

const phaseOf = (
  key: PhaseKey,
  checks: PhaseChecks,
  files: ContentFileSpec[],
): PhaseContent => ({
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
  rubric: {
    passThreshold: 70,
    criteria: [{ key: 'clarity', title: 'Clarity', weight: 1, description: 'd' }],
  },
  checks,
  assistant: { systemPrompt: 's', topics: [], progressive: [] },
  canPreview: false,
});

const packOf = (phases: PhaseContent[]): ProjectContent => ({
  slug: 'fixture',
  version: '1.0.0',
  title: 'a fixture',
  tagline: 't',
  description: 'd',
  language: 'python',
  languages: ['python'],
  phases,
});

/** An authored task, with the fields a rule reads and nothing else. */
const task = (taskKey: string, over: Partial<AuthoredTask> = {}): AuthoredTask => ({
  taskKey,
  order: 1,
  required: true,
  owns: [],
  gradedUnits: [],
  ...over,
});

/** The one refusal, so a test asserts a sentence rather than "it threw". */
const refusal = (pack: ProjectContent, authored: Record<string, AuthoredTask[]>): string => {
  try {
    compilePack(pack, { authored });
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('the compiler accepted a pack it must refuse');
};

/* -------------------------------- the rules -------------------------------- */

describe('the pack compiler refuses what cannot be graded', () => {
  // A phase graded by file rules (a config phase's checks, under the requirements key): the one kind left
  // whose graded units are rules, so a rule can be handed to each task. Every refusal below answers before
  // the wall, which is the last rule of a phase.
  const rulesPhase = (files: ContentFileSpec[], rules: FileRule[]): PhaseContent =>
    phaseOf(
      'requirements',
      { kind: 'config', rules, smokeImplFiles: {}, smokeDockerfile: 'api/Dockerfile', smokeCommands: [], expectInOutput: 'ok' },
      files,
    );

  const storyPack = (): ProjectContent =>
    packOf([
      rulesPhase(
        [file('requirements/draft.md', true, 'markdown')],
        [rule('story-format'), rule('gwt-criteria')],
      ),
    ]);

  it('task keys are unique and orders contiguous', () => {
    const pack = storyPack();
    const duplicate = refusal(pack, {
      requirements: [
        task('api', { order: 1, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        task('api', { order: 2, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }] }),
      ],
    });
    expect(duplicate).toContain('requirements');
    expect(duplicate).toContain('"api"');
    expect(duplicate).toMatch(/orders 1 and 2/);

    const gapped = refusal(pack, {
      requirements: [
        task('one', { order: 1, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        task('two', { order: 3, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }] }),
      ],
    });
    expect(gapped).toContain('requirements');
    expect(gapped).toMatch(/contiguous 1\.\.2/);
    expect(gapped).toMatch(/1, 3/);
  });

  it('a phase with no required task is refused', () => {
    const message = refusal(storyPack(), {
      requirements: [
        task('one', {
          order: 1,
          required: false,
          owns: ['requirements/draft.md'],
          gradedUnits: [{ kind: 'rule', id: 'story-format' }],
        }),
        task('two', {
          order: 2,
          required: false,
          owns: ['requirements/draft.md'],
          gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
        }),
      ],
    });
    expect(message).toContain('requirements');
    expect(message).toMatch(/no task is required/);
  });

  it('a task with an empty graded-unit set is refused', () => {
    // `runsFor` fails open on an empty subset and grades such a task
    // against the whole phase's hidden suite, silently.
    const message = refusal(storyPack(), {
      requirements: [
        task('one', {
          order: 1,
          owns: ['requirements/draft.md'],
          gradedUnits: [{ kind: 'rule', id: 'story-format' }],
        }),
        task('web', {
          order: 2,
          owns: ['requirements/draft.md'],
          gradedUnits: [],
        }),
      ],
    });
    expect(message).toContain('requirements');
    expect(message).toContain('"web"');
    expect(message).toMatch(/no graded unit/);
  });

  it('graded units are pairwise disjoint within a phase', () => {
    const files = [file('api/repository/tasks.py', true), file('web/src/lib/overdue.ts', true, 'typescript')];
    const pack = packOf([
      phaseOf(
        'implementation',
        {
          kind: 'code',
          editableTargets: files.map((f) => f.path),
          visibleTests: [],
          hiddenTestFiles: {},
          solutionFiles: {},
          solutionSources: [],
          runs: [run('api'), run('web')],
        },
        files,
      ),
    ]);
    const message = refusal(pack, {
      implementation: [
        task('api', { order: 1, owns: files.map((f) => f.path), gradedUnits: [{ kind: 'run', id: 'api' }] }),
        task('web', {
          order: 2,
          owns: files.map((f) => f.path),
          gradedUnits: [{ kind: 'run', id: 'api' }, { kind: 'run', id: 'web' }],
        }),
      ],
    });
    expect(message).toContain('implementation');
    expect(message).toContain('"api"');
    expect(message).toContain('"web"');
    expect(message).toMatch(/run "api"/);
  });

  it('artefact paths are unique within a phase', () => {
    // three story tasks in one requirements phase.
    const files = [file('requirements/draft.md', true, 'markdown')];
    const pack = packOf([rulesPhase(files, [rule('a'), rule('b'), rule('c')])]);
    const message = refusal(pack, {
      requirements: [
        task('one', { order: 1, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'a' }] }),
        task('two', { order: 2, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'b' }] }),
        task('three', { order: 3, owns: ['requirements/draft.md'], gradedUnits: [{ kind: 'rule', id: 'c' }] }),
      ],
    });
    expect(message).toContain('requirements');
    expect(message).toContain('requirements/draft.md');
    expect(message).toMatch(/artefact path/);
  });

  it('every editable path is owned and every mounted path is owned', () => {
    const files = [
      file('api/repository/tasks.py', true),
      file('web/src/lib/overdue.ts', true, 'typescript'),
    ];
    const checks: PhaseChecks = {
      kind: 'code',
      editableTargets: files.map((f) => f.path),
      visibleTests: [],
      hiddenTestFiles: {},
      solutionFiles: {},
      solutionSources: [],
      runs: [run('api'), run('web')],
    };
    const pack = packOf([phaseOf('implementation', checks, files)]);

    const unowned = refusal(pack, {
      implementation: [
        task('api', { order: 1, owns: ['api/repository/tasks.py'], gradedUnits: [{ kind: 'run', id: 'api' }] }),
        task('web', { order: 2, owns: ['api/repository/tasks.py'], gradedUnits: [{ kind: 'run', id: 'web' }] }),
      ],
    });
    expect(unowned).toContain('implementation');
    expect(unowned).toContain('web/src/lib/overdue.ts');
    expect(unowned).toMatch(/no task owns/);

    // and the other direction: a task graded on bytes it does not own would
    // carry a check about somebody else's file, and its own would be graded by
    // nothing
    const grades = refusal(pack, {
      implementation: [
        task('api', {
          order: 1,
          owns: ['api/repository/tasks.py'],
          gradedUnits: [{ kind: 'run', id: 'api' }],
          checks: { ...checks, editableTargets: files.map((f) => f.path) } as PhaseChecks,
        }),
        task('web', {
          order: 2,
          owns: ['web/src/lib/overdue.ts'],
          gradedUnits: [{ kind: 'run', id: 'web' }],
          checks: { ...checks, editableTargets: ['web/src/lib/overdue.ts'] } as PhaseChecks,
        }),
      ],
    });
    expect(grades).toContain('implementation');
    expect(grades).toContain('"api"');
    expect(grades).toContain('web/src/lib/overdue.ts');
    expect(grades).toMatch(/does not own/);
  });

  it('phase-wide test thresholds are refused on a multi-task phase', () => {
    // `enough-tests` is failed against `checks.minTests`: one number over
    // the whole suite, and one `coverage-<criterion>` check is emitted per
    // keyword group, `failed` when unmatched. Neither is a run, a rule or a
    // mutant, so the partition rule above cannot see either, and a two-task
    // testing phase would publish in which neither task can pass.
    const files = [
      file('tests/test_acceptance.py', true),
      file('web/src/acceptance.test.tsx', true, 'typescript'),
    ];
    const testsChecks = (over: Partial<TestsChecks>): TestsChecks => ({
      kind: 'tests',
      learnerTestFiles: files.map((f) => f.path),
      referenceTestFiles: {},
      implFiles: {},
      mutants: [],
      coverageKeywords: [],
      minTests: 0,
      supportFiles: {},
      runs: [run('api'), run('web')],
      ...over,
    });
    const twoTasks: Record<string, AuthoredTask[]> = {
      testing: [
        task('api', {
          order: 1,
          owns: ['tests/test_acceptance.py'],
          gradedUnits: [{ kind: 'run', id: 'api' }],
          checks: testsChecks({ learnerTestFiles: ['tests/test_acceptance.py'] }),
        }),
        task('web', {
          order: 2,
          owns: ['web/src/acceptance.test.tsx'],
          gradedUnits: [{ kind: 'run', id: 'web' }],
          checks: testsChecks({ learnerTestFiles: ['web/src/acceptance.test.tsx'] }),
        }),
      ],
    };

    const threshold = refusal(packOf([phaseOf('testing', testsChecks({ minTests: 6 }), files)]), twoTasks);
    expect(threshold).toContain('testing');
    expect(threshold).toMatch(/checks\.minTests/);

    const coverage = refusal(
      packOf([
        phaseOf(
          'testing',
          testsChecks({ coverageKeywords: [{ criterion: 'overdue', keywords: ['overdue'] }] }),
          files,
        ),
      ]),
      twoTasks,
    );
    expect(coverage).toContain('testing');
    expect(coverage).toMatch(/checks\.coverageKeywords/);

    // one task plus either is exactly the shipped pack's shape, and passes
    const sole: Record<string, AuthoredTask[]> = {
      testing: [
        task('all', {
          order: 1,
          owns: files.map((f) => f.path),
          gradedUnits: [{ kind: 'run', id: 'api' }, { kind: 'run', id: 'web' }],
        }),
      ],
    };
    expect(() =>
      compilePack(packOf([phaseOf('testing', testsChecks({ minTests: 6 }), files)]), { authored: sole }),
    ).not.toThrow();
    expect(() =>
      compilePack(
        packOf([
          phaseOf(
            'testing',
            testsChecks({ coverageKeywords: [{ criterion: 'overdue', keywords: ['overdue'] }] }),
            files,
          ),
        ]),
        { authored: sole },
      ),
    ).not.toThrow();
  });

  it('a multi-task deployment phase declaring a drill is refused', () => {
    // The drill is a microVM keyed on the phase, off the request path and
    // outside every task's graded units, so two tasks would cost two drill
    // smokes where the phase costs one.
    const files = [file('docker-compose.yml', true, 'yaml'), file('api/Dockerfile', true, 'dockerfile')];
    const checks: ConfigChecks = {
      kind: 'config',
      rules: [fileRule('compose-env', 'docker-compose.yml'), fileRule('docker-workdir', 'api/Dockerfile')],
      smokeImplFiles: {},
      smokeDockerfile: 'api/Dockerfile',
      smokeCommands: [['python3', 'ops/selfcheck.py']],
      expectInOutput: 'ok',
      drill: {
        fault: 'web-points-at-localhost',
        description: 'd',
        faultedFiles: { 'api/Dockerfile': 'FROM scratch\n' },
        expectFailure: true,
      },
    };
    // each task takes its own rule, a partition a teacher can author, so
    // that the only thing left unshareable is the drill
    const message = refusal(packOf([phaseOf('deployment', checks, files)]), {
      deployment: [
        task('runbook', {
          order: 1,
          owns: ['docker-compose.yml'],
          gradedUnits: [{ kind: 'rule', id: 'compose-env' }],
          checks: { ...checks, rules: [checks.rules[0]] },
        }),
        task('image', {
          order: 2,
          owns: ['api/Dockerfile'],
          artefactPath: 'api/Dockerfile',
          gradedUnits: [{ kind: 'rule', id: 'docker-workdir' }],
          checks: { ...checks, rules: [checks.rules[1]] },
        }),
      ],
    });
    expect(message).toContain('deployment');
    expect(message).toMatch(/checks\.drill/);
  });

  it('a workspace file under a reserved path prefix is refused', () => {
    // `project_files` is keyed UNIQUE (projectVersionId, ownerId, path) and a
    // phase's sealed material is stored under its own directory inside that
    // same owner, so a pack mounting `hidden/test_story.md` in the learner's
    // workspace is two roles arguing over one row. Refused with the pack,
    // before a row is written.
    for (const prefix of ['hidden', 'solution', 'reference', 'drill', 'mutants', 'interview']) {
      const at = `${prefix}/notes.md`;
      const message = refusal(
        packOf([rulesPhase([file(at, true, 'markdown')], [rule('story-format', at)])]),
        {},
      );
      expect(message).toContain('requirements');
      expect(message).toContain(at);
      expect(message).toContain(`"${prefix}/"`);
    }
  });

  it('a path that merely starts with those letters is not reserved', () => {
    // The rule is about a path segment, not a substring: `hiddenrules.md` and
    // `solutions/notes.md` are ordinary files and a pack holding one loads.
    for (const at of ['hiddenrules.md', 'solutions/notes.md', 'docs/hidden/notes.md']) {
      expect(() =>
        compilePack(
          packOf([rulesPhase([file(at, true, 'markdown')], [rule('story-format', at)])]),
        ),
      ).not.toThrow();
    }
  });
});

/* ----------------------------- the split phase ----------------------------- */

describe('the pack compiler holds a split phase to its tasks', () => {
  /**
   * Every phase holds one graded task beside its quizzes; a second graded task
   * is walled. Every fixture below is a phase with two or more tasks (most on a
   * phase graded by file rules, so a rule can be handed to each), which is the only shape any of
   * these rules can see: `if (tasks.length < 2) return` answers first, so every
   * phase of the shipped pack and every phase of every copied project, one
   * authored task keyed `main`, reaches none of them.
   *
   * The wall is the **last** statement in `checkPhase`, and that ordering is
   * the reason the three narrower walls above keep their own assertions: a shape a narrower rule catches is refused by the narrower
   * sentence, which is the one a teacher can act on.
   */

  const story = 'requirements/draft.md';
  const scope = 'requirements/scope.md';
  const record = 'requirements/story.json';
  const screens = 'shared/contract/screens.json';
  const design = 'docs/notes.md';

  const written = (
    key: PhaseKey,
    files: ContentFileSpec[],
    checks: ConfigChecks,
    rubric = rubricOf('clarity'),
  ): PhaseContent => ({ ...phaseOf(key, checks, files), rubric });

  // A phase graded by file rules (config checks): the one kind left whose units are rules, so a rule can be
  // handed to each task. `targets` names the files the rules read; each rule carries its own.
  const rulesChecks = (_targets: string[], rules: FileRule[]): ConfigChecks => ({
    kind: 'config',
    rules,
    smokeImplFiles: {},
    smokeDockerfile: 'api/Dockerfile',
    smokeCommands: [],
    expectInOutput: 'ok',
  });

  /** The two-task phase every case below is a variation on: each task takes one rule. */
  const sharedStoryPack = (): { pack: ProjectContent; authored: Record<string, AuthoredTask[]> } => {
    const checks = rulesChecks([story], [rule('story-format'), rule('gwt-criteria')]);
    return {
      pack: packOf([written('requirements', [file(story, true, 'markdown')], checks)]),
      authored: {
        requirements: [
          task('story', {
            order: 1,
            owns: [story],
            gradedUnits: [{ kind: 'rule', id: 'story-format' }],
            checks: { ...checks, rules: [checks.rules[0]] },
            rubric: rubricOf('clarity'),
          }),
          task('criteria', {
            order: 2,
            owns: [story],
            artefactPath: null,
            gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
            checks: { ...checks, rules: [checks.rules[1]] },
            rubric: rubricOf('clarity'),
          }),
        ],
      },
    };
  };

  it('two tasks in a coding, testing or deployment phase are refused by the one sentence', () => {
    // The wall. Each fixture below passes every narrower rule: slices
    // declared, units partitioned, paths owned, so the sentence a teacher
    // reads is `EXECUTABLE_SPLIT_NOT_READY`, verbatim and never reworded.
    const codeFiles = [
      file('api/repository/tasks.py', true),
      file('web/src/lib/overdue.ts', true, 'typescript'),
    ];
    const codeChecks = (editableTargets: string[], runs: PhaseRun[]): CodeChecks => ({
      kind: 'code',
      editableTargets,
      visibleTests: [],
      hiddenTestFiles: {},
      solutionFiles: {},
      solutionSources: [],
      runs,
    });
    const codeMessage = refusal(
      packOf([
        phaseOf(
          'implementation',
          codeChecks(codeFiles.map((f) => f.path), [run('api'), run('web')]),
          codeFiles,
        ),
      ]),
      {
        implementation: [
          task('api', {
            order: 1,
            owns: ['api/repository/tasks.py'],
            gradedUnits: [{ kind: 'run', id: 'api' }],
            checks: codeChecks(['api/repository/tasks.py'], [run('api')]),
          }),
          task('web', {
            order: 2,
            owns: ['web/src/lib/overdue.ts'],
            gradedUnits: [{ kind: 'run', id: 'web' }],
            checks: codeChecks(['web/src/lib/overdue.ts'], [run('web')]),
          }),
        ],
      },
    );
    expect(codeMessage).toContain('implementation');
    expect(codeMessage).toContain(EXECUTABLE_SPLIT_NOT_READY);

    const testFiles = [
      file('tests/test_acceptance.py', true),
      file('web/src/acceptance.test.tsx', true, 'typescript'),
    ];
    const testsChecks = (learnerTestFiles: string[], runs: PhaseRun[]): TestsChecks => ({
      kind: 'tests',
      learnerTestFiles,
      referenceTestFiles: {},
      implFiles: {},
      mutants: [],
      coverageKeywords: [],
      minTests: 0,
      supportFiles: {},
      runs,
    });
    const testsMessage = refusal(
      packOf([
        phaseOf(
          'testing',
          testsChecks(testFiles.map((f) => f.path), [run('api'), run('web')]),
          testFiles,
        ),
      ]),
      {
        testing: [
          task('api', {
            order: 1,
            owns: ['tests/test_acceptance.py'],
            gradedUnits: [{ kind: 'run', id: 'api' }],
            checks: testsChecks(['tests/test_acceptance.py'], [run('api')]),
          }),
          task('web', {
            order: 2,
            owns: ['web/src/acceptance.test.tsx'],
            gradedUnits: [{ kind: 'run', id: 'web' }],
            checks: testsChecks(['web/src/acceptance.test.tsx'], [run('web')]),
          }),
        ],
      },
    );
    expect(testsMessage).toContain('testing');
    expect(testsMessage).toContain(EXECUTABLE_SPLIT_NOT_READY);

    const configFiles = [file('docker-compose.yml', true, 'yaml'), file('api/Dockerfile', true, 'dockerfile')];
    const configRules = [fileRule('compose-env', 'docker-compose.yml'), fileRule('docker-workdir', 'api/Dockerfile')];
    const configChecks = (rules: FileRule[]): ConfigChecks => ({
      kind: 'config',
      rules,
      smokeImplFiles: {},
      smokeDockerfile: 'api/Dockerfile',
      smokeCommands: [['python3', 'ops/selfcheck.py']],
      expectInOutput: 'ok',
      // no drill: the drill wall would otherwise answer first, which is the point of the
      // last test in this describe rather than of this one
    });
    const configMessage = refusal(packOf([phaseOf('deployment', configChecks(configRules), configFiles)]), {
      deployment: [
        task('runbook', {
          order: 1,
          owns: ['docker-compose.yml'],
          gradedUnits: [{ kind: 'rule', id: 'compose-env' }],
          checks: configChecks([configRules[0]]),
        }),
        task('image', {
          order: 2,
          owns: ['api/Dockerfile'],
          artefactPath: 'api/Dockerfile',
          gradedUnits: [{ kind: 'rule', id: 'docker-workdir' }],
          checks: configChecks([configRules[1]]),
        }),
      ],
    });
    expect(configMessage).toContain('deployment');
    expect(configMessage).toContain(EXECUTABLE_SPLIT_NOT_READY);
  });

  it('an authored list keyed "" is refused', () => {
    // A sole-task phase really does declare `SOLE_TASK_KEY`, so a key check
    // alone is not the predicate: with this rule removed, the list below takes
    // `soleTaskList`'s phase-wide arm, where no `task_states` row is written
    // and the verdict is whichever submission landed, so passing the
    // **optional** task would open the phase and serve its answer key.
    const { pack, authored } = sharedStoryPack();
    const message = refusal(pack, {
      requirements: [
        { ...authored.requirements[0], taskKey: '' },
        { ...authored.requirements[1], required: false },
      ],
    });
    expect(message).toContain('requirements');
    expect(message).toMatch(/authored list/);
    expect(message).toMatch(/give this task a name/);

    // And the shape a length test hides: **one** authored task keyed `""`.
    // `soleTaskList` needs both conjuncts and this list satisfies both, so it
    // takes the phase-wide arm of every derivation: no `task_states` row is
    // written, `strictPass` returns before the row conjunct, `unitsOf` hands
    // the task `gradedUnitsOf(phase)` rather than the units it declares, and
    // the three per-task teacher levers are refused by name. A one-element
    // authored list and a synthesised one are otherwise the same shape, which
    // is the whole reason `checkPhase` is told which list it is holding, so
    // this rule stands **above** `if (tasks.length < 2) return`.
    const soleShaped = (taskKey: string): Record<string, AuthoredTask[]> => ({
      requirements: [
        task(taskKey, {
          order: 1,
          owns: [story],
          gradedUnits: [
            { kind: 'rule', id: 'story-format' },
            { kind: 'rule', id: 'gwt-criteria' },
          ],
        }),
      ],
    });
    // the same list under a name compiles, so the key is the only thing refused
    expect(() => compilePack(pack, { authored: soleShaped('main') })).not.toThrow();
    const alone = refusal(pack, soleShaped(''));
    expect(alone).toContain('requirements');
    expect(alone).toMatch(/authored list/);
    expect(alone).toMatch(/give this task a name/);
  });

  it('a task declaring no checks on a split phase is refused', () => {
    // Without it, `checksOf`'s fallback stands in for the omission: the
    // slice-less task is graded by the whole phase's checks, so its sibling's
    // rules become its rules and its sibling's targets become its targets.
    const { pack, authored } = sharedStoryPack();
    const sliceless: AuthoredTask = { ...authored.requirements[1], checks: undefined };
    const message = refusal(pack, {
      requirements: [authored.requirements[0], sliceless],
    });
    expect(message).toContain('requirements');
    expect(message).toContain('"criteria"');
    expect(message).toMatch(/declares no checks of its own/);

    // and on a sole-task phase the rule does not fire: `checksOf`'s fallback is
    // exactly the mechanism a synthesised sole task rests on, and it keeps its
    // job. What it stops doing is standing in for an author's omission.
    expect(() =>
      compilePack(pack, {
        authored: {
          requirements: [
            task('main', {
              order: 1,
              owns: [story],
              gradedUnits: [
                { kind: 'rule', id: 'story-format' },
                { kind: 'rule', id: 'gwt-criteria' },
              ],
            }),
          ],
        },
      }),
    ).not.toThrow();
  });

  it('a graded unit the phase declares and no task owns is refused', () => {
    // disjointness is checked elsewhere; this gives completeness, and without it a
    // graded rule the pinned version declares is evaluated by nobody while the
    // phase reads fully graded
    const checks = rulesChecks([story], [rule('a'), rule('b'), rule('c')]);
    const pack = packOf([written('requirements', [file(story, true, 'markdown')], checks)]);
    const two = (ids: string[][]): Record<string, AuthoredTask[]> => ({
      requirements: [
        task('one', {
          order: 1,
          owns: [story],
          gradedUnits: ids[0].map((id) => ({ kind: 'rule' as const, id })),
          checks: { ...checks, rules: checks.rules.filter((r) => ids[0].includes(r.id)) },
          rubric: rubricOf('clarity'),
        }),
        task('two', {
          order: 2,
          owns: [story],
          artefactPath: null,
          gradedUnits: ids[1].map((id) => ({ kind: 'rule' as const, id })),
          checks: { ...checks, rules: checks.rules.filter((r) => ids[1].includes(r.id)) },
          rubric: rubricOf('clarity'),
        }),
      ],
    });

    const unowned = refusal(pack, two([['a'], ['b']]));
    expect(unowned).toContain('requirements');
    expect(unowned).toMatch(/rule "c"/);
    expect(unowned).toMatch(/owned by no task/);

    // and the other direction: a task owning a unit its phase does not declare
    const stray = refusal(pack, two([['a'], ['b', 'c', 'z']]));
    expect(stray).toContain('"two"');
    expect(stray).toMatch(/rule "z"/);
    expect(stray).toMatch(/does not declare/);
  });

  it('a slice declaring fewer rules than its units name is refused', () => {
    // With this rule removed the task emits one check, strict-passes on it
    // (clause 5 refuses a `failed` check, not an absent one), and two graded
    // rules the pinned version declares and the task owns are never evaluated.
    const checks = rulesChecks([story], [rule('a'), rule('b'), rule('c')]);
    const pack = packOf([written('requirements', [file(story, true, 'markdown')], checks)]);
    const message = refusal(pack, {
      requirements: [
        task('one', {
          order: 1,
          owns: [story],
          gradedUnits: [
            { kind: 'rule', id: 'a' },
            { kind: 'rule', id: 'b' },
          ],
          checks: { ...checks, rules: [checks.rules[0]] },
          rubric: rubricOf('clarity'),
        }),
        task('two', {
          order: 2,
          owns: [story],
          artefactPath: null,
          gradedUnits: [{ kind: 'rule', id: 'c' }],
          checks: { ...checks, rules: [checks.rules[2]] },
          rubric: rubricOf('clarity'),
        }),
      ],
    });
    expect(message).toContain('requirements');
    expect(message).toContain('"one"');
    expect(message).toMatch(/rule "b"/);
    expect(message).toMatch(/nothing would evaluate/);
  });

  it('two tasks owning the story record are refused', () => {
    // `requirements-record-consistency` is emitted by the task that owns the
    // record, so two owners is two tasks accusing one another about one
    // document.
    const checks = rulesChecks([story], [rule('a'), rule('b')]);
    const files = [file(story, true, 'markdown'), file(record, true, 'json')];
    const pack = packOf([written('requirements', files, checks)]);
    const owners = (second: string[]): Record<string, AuthoredTask[]> => ({
      requirements: [
        task('one', {
          order: 1,
          owns: [story, record],
          gradedUnits: [{ kind: 'rule', id: 'a' }],
          checks: { ...checks, rules: [checks.rules[0]] },
          rubric: rubricOf('clarity'),
        }),
        task('two', {
          order: 2,
          owns: second,
          artefactPath: null,
          gradedUnits: [{ kind: 'rule', id: 'b' }],
          checks: { ...checks, rules: [checks.rules[1]] },
          rubric: rubricOf('clarity'),
        }),
      ],
    });

    const message = refusal(pack, owners([story, record]));
    expect(message).toContain('requirements');
    expect(message).toContain(record);
    expect(message).toContain('"one"');
    expect(message).toContain('"two"');
  });

  it('two tasks owning the screen contract are refused', () => {
    // The accepted screen copy is frozen at design→implementation advance and
    // injected read-only into four later phases, where it is graded. With two
    // owners and no rule, an arbitrary task's passing submission becomes the
    // contract those four phases are judged against.
    const checks = rulesChecks([design], [rule('a', design), rule('b', design)]);
    const withScreens = [file(design, true, 'markdown'), file(screens, true, 'json')];
    const pack = packOf([written('design', withScreens, checks)]);
    const owners = (second: string[]): Record<string, AuthoredTask[]> => ({
      design: [
        task('flows', {
          order: 1,
          owns: [design, screens],
          gradedUnits: [{ kind: 'rule', id: 'a' }],
          checks: { ...checks, rules: [checks.rules[0]] },
          rubric: rubricOf('clarity'),
        }),
        task('screens', {
          order: 2,
          owns: second,
          artefactPath: null,
          gradedUnits: [{ kind: 'rule', id: 'b' }],
          checks: { ...checks, rules: [checks.rules[1]] },
          rubric: rubricOf('clarity'),
        }),
      ],
    });

    const message = refusal(pack, owners([design, screens]));
    expect(message).toContain('design');
    expect(message).toContain(screens);
    expect(message).toContain('"flows"');
    expect(message).toContain('"screens"');
    expect(message).toMatch(/four later phases/);
  });

  it('a narrower rule may answer before the wall, and that is the design', () => {
    // Placed last, the wall leaves the minTests, coverage and drill walls
    // answering first for the shapes their own assertions above cover. A
    // teacher would rather read "partition `minTests` onto the tasks" than the
    // general wall's paragraph.
    const testFiles = [
      file('tests/test_acceptance.py', true),
      file('web/src/acceptance.test.tsx', true, 'typescript'),
    ];
    const testsChecks = (learnerTestFiles: string[], runs: PhaseRun[], minTests: number): TestsChecks => ({
      kind: 'tests',
      learnerTestFiles,
      referenceTestFiles: {},
      implFiles: {},
      mutants: [],
      coverageKeywords: [],
      minTests,
      supportFiles: {},
      runs,
    });
    const narrower = refusal(
      packOf([
        phaseOf(
          'testing',
          testsChecks(testFiles.map((f) => f.path), [run('api'), run('web')], 6),
          testFiles,
        ),
      ]),
      {
        testing: [
          task('api', {
            order: 1,
            owns: ['tests/test_acceptance.py'],
            gradedUnits: [{ kind: 'run', id: 'api' }],
            checks: testsChecks(['tests/test_acceptance.py'], [run('api')], 0),
          }),
          task('web', {
            order: 2,
            owns: ['web/src/acceptance.test.tsx'],
            gradedUnits: [{ kind: 'run', id: 'web' }],
            checks: testsChecks(['web/src/acceptance.test.tsx'], [run('web')], 0),
          }),
        ],
      },
    );
    expect(narrower).toMatch(/checks\.minTests/);
    expect(narrower).not.toContain(EXECUTABLE_SPLIT_NOT_READY);
  });
});

describe('the compiled snapshot of the imported default project', () => {
  let project: ProjectContent;

  beforeAll(() => {
    const content = new ContentService();
    content.loadAll();
    project = content.getProject('tasktrackr');
  });

  it('sandboxBudget prices every microVM the phase actually runs', () => {
    const snapshot = compilePack(project);
    expect(snapshot.sandboxBudgetByPhase).toEqual({
      requirements: 0,
      design: 0,
      // two runs, visible plus hidden
      implementation: 4,
      // two reference runs plus eight mutants
      testing: 10,
      // the smoke run **plus the incident drill's smoke**
      deployment: 2,
      maintenance: 4,
    });
    expect(snapshot.sandboxBudget).toBe(20);
  });

  it('compiles to the same snapshot it compiled before the task grain', () => {
    // The split-phase compile rules change no derivation, and a rule that
    // only refuses changes no output, which is why `COMPILER_IDENTITY`
    // stays as it is and `installVersions` records no drift. The shipped
    // pack's snapshot, as `checksOf`, `gradedUnitsOf`, `gradedPathsOf`,
    // `editablePathsOf`, `artefactPathFor`, `soleTaskFor`, `authoredTaskFor`,
    // `sandboxBudgetFor` and `compilePack` assemble it, is pinned below.
    //
    // The digest is recorded so that "no pack bump" is a fact rather than a
    // hope: if it moves without `content/tasktrackr/project.json`'s version
    // moving with it, a change meant only to refuse has produced a different
    // snapshot, and every published version of this pack now disagrees with
    // the build serving it. Regenerating the number is never the fix.
    //
    // A new pack version re-records it in the same change, with the reason:
    // the phases whose content moved are the only ones whose snapshot moves.
    expect(COMPILER_IDENTITY).toBe('block1.pack-compiler.1');
    expect(project.version).toBe('6.0.0');
    expect(contentDigestOf(compilePack(project))).toBe(
      '822e3b527c57a02f41667736b143e151e6cfeb1b73aac35289645be425e10c82',
    );
  });

  it('the compiled snapshot is immutable once published', () => {
    const published = { version: project.version, status: 'published' as const };
    expect(() => compilePack(project, { existing: published })).toThrow(
      /already published/,
    );
    expect(() => compilePack(project, { existing: published })).toThrow(
      /bump project\.json's version/,
    );

    // a draft is mutable, and a *different* published version is the bump path
    const draft = compilePack(project, {
      existing: { version: project.version, status: 'draft' },
    });
    expect(draft.version).toBe(project.version);
    expect(
      compilePack(project, { existing: { version: '1.0.0', status: 'published' } }).version,
    ).toBe(project.version);
  });
});

/* ---------------------------------- quizzes --------------------------------- */

describe('a quiz is a task the compiler can price, partition and refuse', () => {
  /**
   * The fifth kind, and the four sites the compiler is silent about.
   *
   * Every fixture here is hand-built and none of them is TaskTrackr, which
   * declares no quiz and is therefore untouched by every rule below: safe by
   * construction, and the golden nets are what hold it.
   */

  const quizOf = (over: Partial<QuizChecks> = {}): QuizChecks => fixtureQuizChecks(over);

  const codeChecks = (editableTargets: string[], runs: PhaseRun[]): CodeChecks => ({
    kind: 'code',
    editableTargets,
    visibleTests: [],
    hiddenTestFiles: {},
    solutionFiles: {},
    solutionSources: [],
    runs,
  });

  const testsChecks = (over: Partial<TestsChecks> = {}): TestsChecks => ({
    kind: 'tests',
    learnerTestFiles: ['tests/test_acceptance.py'],
    referenceTestFiles: {},
    implFiles: {},
    mutants: [],
    coverageKeywords: [],
    minTests: 0,
    supportFiles: {},
    runs: [run('api')],
    ...over,
  });

  it('gradedUnitsOf mints one question unit per pooled question, and a missing arm is refused by name', () => {
    // The first of the four silent sites. `gradedUnitsOf` is an if-chain, so a
    // fifth kind compiles and answers the EMPTY list, and the only sign of it
    // is `no graded unit` at publish, a sentence about runs, rules and mutants
    // written for a teacher who wrote five questions. The second assertion is
    // that refusal, driven by a task whose units are what the missing arm
    // would have produced: nothing.
    const checks = quizOf();
    expect(gradedUnitsOf({ ...writtenPhase(), checks })).toEqual([
      { kind: 'question', id: 'q1' },
      { kind: 'question', id: 'q2' },
      { kind: 'question', id: 'q3' },
      { kind: 'question', id: 'q4' },
      { kind: 'question', id: 'q5' },
    ]);
    // the POOL and not the draw: `drawn` is 3 and the version declares 5
    expect(checks.drawn).toBe(3);

    const phase = writtenPhase();
    const message = refusal(fixturePack([phase]), {
      design: [
        soleGradedTask(phase),
        fixtureQuizTask('check', 2, { gradedUnits: [] }),
      ],
    });
    expect(message).toContain('design');
    expect(message).toContain('"check"');
    expect(message).toMatch(/declares no graded unit/);
  });

  it('a quiz grades no path, scores one rubric key, is sealed by its questions and costs no microVM', () => {
    // The other three silent sites and two of the five the compiler finds.
    const checks = quizOf();
    expect(gradedPathsOf(checks)).toEqual([]);
    expect([...scoredRubricKeys(checks)]).toEqual(['concepts']);

    const phase = writtenPhase();
    const quizTask = fixtureQuizTask('check', 2);
    const snapshot = compilePack(fixturePack([phase]), {
      authored: { design: [soleGradedTask(phase), quizTask] },
    });
    const [graded, quiz] = snapshot.phases[0].tasks;
    expect(quiz.checkKind).toBe('quiz');
    expect(quiz.artefactType).toBe('quiz');
    expect(sealedTask(phase, quiz)).toBe(true);
    expect(evidenceOf(phase, quiz)).toBe('automated');
    expect(sealedTask(phase, { ...quiz, checks: quizOf({ questions: [] }) })).toBe(false);

    // ZERO microVMs, which is the whole argument for letting a quiz sit beside
    // an executable task: asserted against the same phase without it.
    expect(sandboxBudgetFor(phase, [graded, quiz])).toBe(sandboxBudgetFor(phase, [graded]));
    const executable = executablePhase();
    const only = soleGradedTask(executable);
    const withQuiz = compilePack(fixturePack([executable]), {
      authored: { deployment: [only, fixtureQuizTask('check', 2)] },
    });
    const without = compilePack(fixturePack([executable]), {
      authored: { deployment: [only] },
    });
    expect(withQuiz.sandboxBudgetByPhase.deployment).toBe(
      without.sandboxBudgetByPhase.deployment,
    );
    expect(withQuiz.sandboxBudget).toBe(without.sandboxBudget);
  });

  it('the runtime allow-list admits quiz, so a phase declaring it is not refused at boot for the wrong reason', () => {
    // The fourth silent site: a `readonly ArtifactKind[]` that simply goes
    // stale. Left alone it refuses a quiz phase with *"not one of story,
    // design, code, tests, config"*: a sentence about a list that is wrong.
    expect(ARTIFACT_KINDS).toEqual(['story', 'design', 'code', 'tests', 'config', 'quiz']);
  });

  it('a phase of one story task and one quiz publishes, and the question exemption is what lets it', () => {
    const phase = writtenPhase();
    // The phase declares a record and never questions, so without the exemption
    // in `tasks-partition-units`' second half every quiz would be refused for
    // owning a unit the phase does not declare.
    expect(gradedUnitsOf(phase).some((unit) => unit.kind === 'question')).toBe(false);
    const snapshot = compilePack(fixturePack([phase]), {
      authored: { design: [soleGradedTask(phase), fixtureQuizTask('check', 2)] },
    });
    expect(snapshot.phases[0].tasks.map((one) => one.checkKind)).toEqual(['story', 'quiz']);

    // and the half that still refuses: a RULE the phase does not declare
    const strayRule = refusal(fixturePack([phase]), {
      design: [
        soleGradedTask(phase),
        {
          ...fixtureQuizTask('check', 2),
          gradedUnits: [{ kind: 'rule', id: 'not-a-rule-of-this-phase' }],
        },
      ],
    });
    expect(strayRule).toMatch(/which this phase does not declare/);
  });

  it('the wall still refuses two executable tasks, and a story task beside a code one', () => {
    const files = [file('api/repository/tasks.py', true), file('web/src/lib/overdue.ts', true, 'typescript')];
    const phase = phaseOf(
      'implementation',
      codeChecks(files.map((f) => f.path), [run('api'), run('web')]),
      files,
    );
    const two = refusal(packOf([phase]), {
      implementation: [
        task('api', {
          order: 1,
          owns: ['api/repository/tasks.py'],
          gradedUnits: [{ kind: 'run', id: 'api' }],
          checks: codeChecks(['api/repository/tasks.py'], [run('api')]),
        }),
        task('web', {
          order: 2,
          owns: ['web/src/lib/overdue.ts'],
          gradedUnits: [{ kind: 'run', id: 'web' }],
          checks: codeChecks(['web/src/lib/overdue.ts'], [run('web')]),
        }),
      ],
    });
    expect(two).toContain('implementation');
    expect(two).toContain(EXECUTABLE_SPLIT_NOT_READY);

    // The proposal's wording, *"all but one of its tasks are quizzes"*, is
    // right about the shape and too weak to be a rule, because nothing in it
    // pins the one task's KIND to the phase's. Here exactly one task is not a
    // quiz and it owns every unit and every path, so every conjunct but the
    // kind one holds; the kind conjunct is what refuses it.
    const proseOnCode = refusal(packOf([phase]), {
      implementation: [
        task('notes', {
          order: 1,
          owns: files.map((f) => f.path),
          gradedUnits: [{ kind: 'run', id: 'api' }, { kind: 'run', id: 'web' }],
          // a story slice whose record is a file the task owns, so only the kind conjunct is left to refuse it
          checks: { ...(writtenPhase().checks as StoryChecks), record: files[0].path },
        }),
        fixtureQuizTask('check', 2),
      ],
    });
    expect(proseOnCode).toContain('implementation');
    expect(proseOnCode).toContain('"notes"');
    expect(proseOnCode).toContain(EXECUTABLE_SPLIT_NOT_READY);
  });

  it('a phase whose own checks are quiz may not hold several tasks', () => {
    // `publishableTasksPerPhase` is kind-only and answers 1 for `quiz`, and
    // this is the compiler saying the same thing about a snapshot that never
    // came through the editor.
    const phase = phaseOf('design', quizOf(), []);
    const message = refusal(packOf([phase]), {
      design: [
        fixtureQuizTask('one', 1, { required: true }),
        fixtureQuizTask('two', 2, {}, quizOf({ questions: fixtureQuizQuestions(5, 'z') })),
      ],
    });
    expect(message).toContain('design');
  });

  it('a quiz joins a code, tests or config phase while its one graded task owns everything', () => {
    // The all-six-phases arm, both directions and all three conjuncts.
    for (const phase of [executablePhase(), phaseOf('testing', testsChecks(), [file('tests/test_acceptance.py', true)])]) {
      const key = phase.key;
      const only = soleGradedTask(phase);
      const units = phase.checks.kind === 'tests'
        ? [{ kind: 'run' as const, id: 'api' }]
        : only.gradedUnits;
      const graded: AuthoredTask = { ...only, gradedUnits: units };

      const snapshot = compilePack(fixturePack([phase]), {
        authored: { [key]: [graded, fixtureQuizTask('check', 2)] },
      });
      const compiledGraded = snapshot.phases[0].tasks[0];
      // the executable task still owns everything
      expect(compiledGraded.gradedUnits).toEqual(gradedUnitsOf(phase));
      for (const at of editablePathsOf(phase)) expect(compiledGraded.owns).toContain(at);

      // three quizzes are no different from one
      expect(() =>
        compilePack(fixturePack([phase]), {
          authored: {
            [key]: [
              graded,
              fixtureQuizTask('a', 2, {}, quizOf({ questions: fixtureQuizQuestions(2, 'a') })),
              fixtureQuizTask('b', 3, {}, quizOf({ questions: fixtureQuizQuestions(2, 'b') })),
              fixtureQuizTask('c', 4, {}, quizOf({ questions: fixtureQuizQuestions(2, 'c') })),
            ],
          },
        }),
      ).not.toThrow();

      // Drop either ownership conjunct and the version is refused: by the
      // NARROWER rule, which is the design and not an accident: a unit the
      // phase declares and no task owns, and an editable file no task owns,
      // are each their own sentence and each stands above the wall. With
      // `quiz-owns-no-file` holding the quiz to nothing, the wall's conjuncts
      // are what hold a snapshot some other build compiled.
      if (units.length > 1) {
        const halfUnits = refusal(fixturePack([phase]), {
          [key]: [{ ...graded, gradedUnits: units.slice(0, units.length - 1) }, fixtureQuizTask('check', 2)],
        });
        expect(halfUnits).toContain(key);
        expect(halfUnits).toMatch(/owned by no task|not owned by/);
      }
      const halfPaths = refusal(fixturePack([phase]), {
        [key]: [{ ...graded, owns: [] }, fixtureQuizTask('check', 2)],
      });
      expect(halfPaths).toContain(key);
      expect(halfPaths).toMatch(/no task owns the editable file|not owned by/);
    }
  });

  it('the three narrower walls count the non-quiz tasks, and still refuse a real split', () => {
    const testFiles = [file('tests/test_acceptance.py', true), file('web/src/acceptance.test.tsx', true, 'typescript')];
    const thresholds: Partial<TestsChecks>[] = [
      { minTests: 6 },
      { coverageKeywords: [{ criterion: 'overdue', keywords: ['overdue'] }] },
    ];
    for (const over of thresholds) {
      const checks = testsChecks({ learnerTestFiles: testFiles.map((f) => f.path), runs: [run('api'), run('web')], ...over });
      const phase = phaseOf('testing', checks, testFiles);
      const only: AuthoredTask = {
        taskKey: 'main',
        order: 1,
        required: true,
        owns: testFiles.map((f) => f.path),
        gradedUnits: [{ kind: 'run', id: 'api' }, { kind: 'run', id: 'web' }],
        rubric: phase.rubric,
      };
      // one executable task plus a quiz publishes: the reason the narrow rule
      // states ("neither task could be scored by it") is false of this shape
      expect(() =>
        compilePack(fixturePack([phase]), { authored: { testing: [only, fixtureQuizTask('check', 2)] } }),
      ).not.toThrow();
      // and TWO executable tasks are still refused, in the narrow sentence
      const split = refusal(fixturePack([phase]), {
        testing: [
          { ...only, owns: ['tests/test_acceptance.py'], gradedUnits: [{ kind: 'run', id: 'api' }], checks: testsChecks({ learnerTestFiles: ['tests/test_acceptance.py'] }) },
          { taskKey: 'web', order: 2, required: false, owns: ['web/src/acceptance.test.tsx'], gradedUnits: [{ kind: 'run', id: 'web' }], checks: testsChecks({ learnerTestFiles: ['web/src/acceptance.test.tsx'], runs: [run('web')] }), rubric: phase.rubric },
        ],
      });
      expect(split).toMatch(/checks\.(minTests|coverageKeywords)/);
      expect(split).not.toContain(EXECUTABLE_SPLIT_NOT_READY);
    }

    // the drill, which is priced once per phase
    const drilled = executablePhase(true);
    expect(() =>
      compilePack(fixturePack([drilled]), {
        authored: { deployment: [soleGradedTask(drilled), fixtureQuizTask('check', 2)] },
      }),
    ).not.toThrow();
    const two = refusal(fixturePack([drilled]), {
      deployment: [
        { ...soleGradedTask(drilled), owns: [COMPOSE], gradedUnits: [{ kind: 'rule', id: 'compose-env' }], checks: { ...(drilled.checks as ConfigChecks), rules: [(drilled.checks as ConfigChecks).rules[0]] } },
        { taskKey: 'image', order: 2, required: false, owns: [DOCKERFILE], artefactPath: DOCKERFILE, gradedUnits: [{ kind: 'rule', id: 'docker-workdir' }], checks: { ...(drilled.checks as ConfigChecks), rules: [(drilled.checks as ConfigChecks).rules[1]] }, rubric: drilled.rubric },
      ],
    });
    expect(two).toMatch(/checks\.drill/);
  });

  it('the sole non-quiz task keeps the phase’s checks by fallback, and a second one may not', () => {
    const phase = executablePhase();
    const only = soleGradedTask(phase);
    expect(only.checks).toBeUndefined();
    const snapshot = compilePack(fixturePack([phase]), {
      authored: { deployment: [only, fixtureQuizTask('check', 2)] },
    });
    // the snapshot carries the phase's sealed material ONCE, on the phase
    expect(snapshot.phases[0].tasks[0].checks).toBeUndefined();
    expect(snapshot.phases[0].tasks[1].checks?.kind).toBe('quiz');

    // The exemption is never a QUIZ's, and this is why: a quiz falling back to
    // the phase's checks would be graded by its sibling's rules over its
    // sibling's targets, and on a `code` phase it would reach `case 'code'`
    // in `referenceFiles` and hand the learner the model answer through a gate
    // its own pass had opened.
    const quizNoSlice = refusal(fixturePack([phase]), {
      deployment: [only, { ...fixtureQuizTask('check', 2), checks: undefined }],
    });
    expect(quizNoSlice).toContain('"check"');
    expect(quizNoSlice).toMatch(/graded on "docker-compose\.yml", which it does not own/);

    // nor a SECOND graded task's: with two of them the fallback would stand in
    // for an author's omission, which is the rule's own reason
    const secondNoSlice = refusal(fixturePack([phase]), {
      deployment: [
        {
          ...only,
          owns: [COMPOSE],
          gradedUnits: [{ kind: 'rule', id: 'compose-env' }],
          checks: { ...(phase.checks as ConfigChecks), rules: [(phase.checks as ConfigChecks).rules[0]] },
        },
        {
          taskKey: 'image',
          order: 2,
          required: false,
          owns: [COMPOSE, DOCKERFILE],
          artefactPath: DOCKERFILE,
          gradedUnits: [{ kind: 'rule', id: 'docker-workdir' }],
          rubric: phase.rubric,
        },
      ],
    });
    expect(secondNoSlice).toMatch(/declares no checks of its own/);
  });

  it('a quiz’s rubric key is the quiz’s, on a code phase as much as a written one', () => {
    // The clause is a loop of its own, asked of a quiz in every kind of phase.
    const files = [file('api/repository/tasks.py', true)];
    const phase = phaseOf('implementation', codeChecks([files[0].path], [run('api')]), files);
    const only: AuthoredTask = {
      taskKey: 'main',
      order: 1,
      required: true,
      owns: [files[0].path],
      gradedUnits: [{ kind: 'run', id: 'api' }],
      rubric: phase.rubric,
    };
    const message = refusal(fixturePack([phase]), {
      implementation: [only, fixtureQuizTask('check', 2, { rubric: rubricOf('something-else') })],
    });
    expect(message).toContain('implementation');
    expect(message).toContain('"check"');
    expect(message).toContain('"concepts"');
    expect(message).toMatch(/0 there with no evidence/);

    const two = refusal(fixturePack([phase]), {
      implementation: [only, fixtureQuizTask('check', 2, { rubric: rubricOf('concepts', 'extra') })],
    });
    expect(two).toContain('"check"');
  });

  it('quiz-owns-no-file refuses a quiz that declares a path', () => {
    // `gradedPathsOf` answers `[]` for a quiz, so the coverage rule clears
    // vacuously and cannot catch this. A quiz that named a path would be a
    // second owner of the learner's code.
    const phase = writtenPhase();
    const owns = refusal(fixturePack([phase]), {
      design: [soleGradedTask(phase), fixtureQuizTask('check', 2, { owns: [STORY_RECORD] })],
    });
    expect(owns).toContain('"check"');
    expect(owns).toMatch(/declares a workspace file/);

    const path = refusal(fixturePack([phase]), {
      design: [soleGradedTask(phase), fixtureQuizTask('check', 2, { artefactPath: STORY_RECORD })],
    });
    expect(path).toMatch(/declares a workspace file/);
  });

  it('phase-needs-a-required-artefact-task refuses a phase an MCQ alone could open', () => {
    // Scoped to the REQUIRED set, because that is what `phaseRollup`
    // quantifies over: a required quiz beside an OPTIONAL artefact task would
    // otherwise open a phase on multiple choice alone.
    const phase = writtenPhase();
    const message = refusal(fixturePack([phase]), {
      design: [
        { ...soleGradedTask(phase), required: false },
        fixtureQuizTask('check', 2, { required: true }),
      ],
    });
    expect(message).toContain('design');
    expect(message).toMatch(/no required task of another kind/);

    // a phase of one required quiz and nothing else: the shape the early
    // return would have hidden
    const alone = refusal(fixturePack([phase]), {
      design: [fixtureQuizTask('check', 1, { required: true })],
    });
    expect(alone).toMatch(/no required task of another kind/);

    // both required publishes
    expect(() =>
      compilePack(fixturePack([phase]), {
        authored: { design: [soleGradedTask(phase), fixtureQuizTask('check', 2, { required: true })] },
      }),
    ).not.toThrow();
  });

  it('the hand-over: a compiled quiz version, on a written phase and on an executable one', () => {
    const snapshot = compiledQuizSnapshot();
    expect(snapshot.phases.map((one) => one.key)).toEqual(['design', 'deployment']);
    for (const phase of snapshot.phases) {
      expect(phase.tasks.map((one) => one.checkKind)).toEqual([
        phase.key === 'design' ? 'story' : 'config',
        'quiz',
      ]);
      expect(phase.tasks[1].artefactPath).toBeNull();
      expect(phase.tasks[1].owns).toEqual([]);
    }
    // the budget is the number it was, because a quiz runs nothing
    expect(snapshot.sandboxBudgetByPhase).toEqual({ design: 0, deployment: 1 });
    expect(compiledQuizSnapshot({ required: true }).phases[0].tasks[1].required).toBe(true);
  });
});

describe('a design phase is one task beside any quizzes', () => {
  const design = phaseOf('design', validateDesignChecks({ kind: 'design' }, 'design'), [
    file(DESIGN_JSON, true, 'json'),
    file(API_CONTRACT_JSON, true, 'json'),
  ]);
  const record = { kind: 'record' as const, id: DESIGN_JSON };
  const contract = { kind: 'record' as const, id: API_CONTRACT_JSON };
  const whole = task('main', { owns: [DESIGN_JSON, API_CONTRACT_JSON], gradedUnits: [record, contract], rubric: design.rubric });

  it('grades the record and each contract that is on, and costs no microVM', () => {
    expect(gradedUnitsOf(design)).toEqual([record, contract]);
    expect(gradedPathsOf(design.checks)).toEqual([DESIGN_JSON, API_CONTRACT_JSON]);
    const snapshot = compilePack(packOf([design]), { authored: { design: [whole, fixtureQuizTask('check', 2)] } });
    expect(snapshot.phases[0].tasks.map((one) => one.checkKind)).toEqual(['design', 'quiz']);
    expect(snapshot.sandboxBudgetByPhase.design).toBe(0);
  });

  it('refuses a second work task, by the rule that names it', () => {
    const split = [
      // each carries the design slice and reads both documents; the units split between them
      task('model', { owns: [DESIGN_JSON, API_CONTRACT_JSON], gradedUnits: [record], rubric: design.rubric, checks: design.checks }),
      task('contract', { order: 2, owns: [DESIGN_JSON, API_CONTRACT_JSON], gradedUnits: [contract], rubric: design.rubric, checks: design.checks }),
    ];
    expect(refusal(packOf([design]), { design: split })).toBe(
      'fixture/design: a Design phase holds exactly one task beside any quizzes, and this one holds 2. Move other written work into its own phase.',
    );
  });
});

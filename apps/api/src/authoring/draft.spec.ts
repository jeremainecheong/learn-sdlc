import {
  CANONICAL_FILE_NOTICE,
  INHERITED_TASK_KEY,
  INHERITED_TASK_NOTICE,
  SEALED_FILE_NOTICE,
  isAuthoringReadableRole,
  publishableTasksPerPhase,
  refusesMultiTaskPublish,
} from '@learnsdlc/shared';
import type { PhaseRubric } from '@learnsdlc/shared';
import type { PhaseContent, StoryChecks } from '../content/content.types';
import type {
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
} from '../content/project.entities';
import { fixtureQuizChecks, fixtureQuizRubric, writtenPhase } from '../../test/quiz-fixture';
import { tasktrackrContent, tasktrackrPhase } from '../../test/tasktrackr-phase';
import { recordPack } from '../../test/record-pack';
import { compilePack, soleTaskFor } from '../content/pack-compiler';
import type { CodeChecks, TestsChecks } from '../content/content.types';
import { EXECUTABLE_SPLIT_NOT_READY } from '@learnsdlc/shared';
import { canonicalJson, sha256Hex } from '../content/blob.store';
import {
  authoredTasksFor,
  authoringFileView,
  blobsToRead,
  draftPhaseView,
  draftTaskView,
  isInheritedTask,
  phaseFilesFrom,
  phaseFromTasks,
} from './draft';

/** The phase's story checks (Shelf's Requirements, the quiz fixture's written phase): one record, graded by the floor. */
const STORY = writtenPhase().checks as StoryChecks;
const RECORD = STORY.record;

const rubric = (): PhaseRubric => ({ passThreshold: 70, criteria: [{ key: 'story', title: 'The story', weight: 1, description: 'd' }] });

const phaseContent = (over: Partial<PhaseContent> = {}): PhaseContent =>
  ({
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    intro: 'What the customer needs.',
    artifactKind: 'story',
    language: 'python',
    canRun: false,
    runLabel: '',
    taskPanel: 'Write the stories.',
    objectives: ['Write three stories'],
    files: [
      { path: 'requirements/draft.md', content: '# Stories\n', editable: true, language: 'markdown' },
      { path: 'requirements/brief.md', content: '# Brief\n', editable: false, language: 'markdown' },
    ],
    rubric: rubric(),
    checks: STORY,
    assistant: {} as PhaseContent['assistant'],
    canPreview: false,
    ...over,
  }) as PhaseContent;

const taskRow = (over: Partial<ProjectTaskEntity> = {}): ProjectTaskEntity =>
  ({
    id: `task-${over.taskKey ?? INHERITED_TASK_KEY}`,
    projectPhaseId: 'phase-1',
    taskKey: INHERITED_TASK_KEY,
    order: 1,
    required: true,
    signOff: false,
    artefactType: 'user-story',
    artefactPath: null,
    title: 'Requirements',
    brief: 'Write the stories.',
    objectives: ['Write three stories'],
    primaryPath: null,
    anchor: null,
    rubric: rubric(),
    checks: STORY,
    ...over,
  }) as ProjectTaskEntity;

/**
 * The derivations between the rows a teacher edits and the pack the compiler
 * reads. They are pure on purpose: everything that decides what a task owns,
 * what scores it and whether its bytes may leave is a function, so a spec can
 * ask the question without a database.
 */
describe('the draft derivations', () => {
  describe('what a task owns', () => {
    it('gives the inherited task every editable path the phase mounts', () => {
      const phase = phaseContent();
      const authored = authoredTasksFor(phase, [taskRow()]);

      expect(authored).toHaveLength(1);
      expect(authored[0].taskKey).toBe(INHERITED_TASK_KEY);
      expect(authored[0].owns).toEqual(['requirements/draft.md']);
      // its checks *are* the phase's, so the snapshot carries them once
      expect(authored[0].checks).toBeUndefined();
      expect(authored[0].gradedUnits).toEqual([{ kind: 'record', id: RECORD }]);
    });

    it('carries an edited inherited task as its own slice rather than the phase\'s', () => {
      const phase = phaseContent();
      const edited = taskRow({ checks: { ...STORY, floor: { ...STORY.floor, minCriteria: 3 } } });

      const [authored] = authoredTasksFor(phase, [edited]);

      expect(authored.checks).toEqual(edited.checks);
      // and it still owns everything editable the phase mounts
      expect(authored.owns).toEqual(['requirements/draft.md']);
    });
  });

  describe('the view a teacher reads', () => {
    it('marks an inherited code task read-only, with the Notice and not a dead control', () => {
      const row = taskRow({
        taskKey: INHERITED_TASK_KEY,
        artefactType: 'code',
        title: 'Build the API',
        checks: { kind: 'code', editableTargets: [], visibleTests: [], hiddenTestFiles: {}, solutionFiles: {}, solutionSources: [], runs: [] },
      });

      const view = draftTaskView(row, ['api/repository/tasks.py']);

      expect(view.checkKind).toBe('code');
      expect(view.authorable).toBe(false);
      expect(view.notice).toBe(INHERITED_TASK_NOTICE);
      expect('rules' in view).toBe(false);
    });

    it('marks a story task the teacher may write, with no Notice and no rules', () => {
      const view = draftTaskView(taskRow(), ['requirements/draft.md']);

      expect(view.checkKind).toBe('story');
      expect(view.authorable).toBe(true);
      expect(view.notice).toBeNull();
      expect('rules' in view).toBe(false);
      expect(view.owns).toEqual(['requirements/draft.md']);
    });

    it('knows the inherited key from an authored one', () => {
      expect(isInheritedTask(INHERITED_TASK_KEY)).toBe(true);
      expect(isInheritedTask('late-marker')).toBe(false);
    });
  });

  describe('the seal on a file row', () => {
    const fileRow = (over: Partial<ProjectFileEntity>): ProjectFileEntity =>
      ({
        id: 'file-1',
        projectVersionId: 'version-1',
        ownerKind: 'phase',
        ownerId: 'phase-1',
        path: 'requirements/draft.md',
        role: 'workspace',
        editable: true,
        language: 'markdown',
        blobSha: 'abc',
        ...over,
      }) as ProjectFileEntity;

    it('hands back the bytes of a learner-facing row', () => {
      const view = authoringFileView(fileRow({}), 42, '# Stories\n', 'requirements');

      expect(view.sealed).toBe(false);
      expect(view.content).toBe('# Stories\n');
      expect(view.notice).toBeNull();
      expect(view.size).toBe(42);
      expect(view.phaseKey).toBe('requirements');
    });

    it('withholds the bytes of every sealed row, and says what the row is for', () => {
      for (const role of ['hidden', 'solution', 'reference', 'mutant', 'support', 'drill', 'interview'] as const) {
        const view = authoringFileView(fileRow({ role }), 1200, 'def test_everything(): ...', null);

        expect(isAuthoringReadableRole(role)).toBe(false);
        expect(view.sealed).toBe(true);
        expect(view.content).toBeNull();
        expect(view.notice).toBe(SEALED_FILE_NOTICE);
        // the path, the role and the size still travel: a file tree is a tree
        expect(view.path).toBe('requirements/draft.md');
        expect(view.size).toBe(1200);
      }
    });

    it('withholds the finished application, which is not in the sealed set', () => {
      const view = authoringFileView(fileRow({ role: 'canonical' }), 484_000, 'def real(): ...', null);

      expect(view.sealed).toBe(true);
      expect(view.content).toBeNull();
      expect(view.notice).toBe(CANONICAL_FILE_NOTICE);
    });
  });

  describe('the files a phase mounts', () => {
    // A row the copy brought carries the sha of the base file's own bytes,
    // because that is what a copied row holds (`copyFilesToVersion` copies
    // `blobSha` from rows the importer keyed by `blobShaFor(bytes)`). A
    // made-up sha per path would hide whether `phaseFilesFrom` asks if the
    // row still holds the base bytes.
    const baseSha = new Map(phaseContent().files.map((file) => [file.path, sha256Hex(file.content)]));
    const fileRow = (over: Partial<ProjectFileEntity>): ProjectFileEntity =>
      ({
        id: `file-${over.path}`,
        projectVersionId: 'version-1',
        ownerKind: 'phase',
        ownerId: 'phase-1',
        role: 'workspace',
        editable: true,
        language: 'markdown',
        blobSha: baseSha.get(over.path ?? '') ?? `sha-${over.path}`,
        ...over,
      }) as ProjectFileEntity;

    it('keeps the pack\'s own order, and puts what a teacher added after it', () => {
      const base = phaseContent().files;
      const rows = [
        fileRow({ path: 'requirements/my-story-zebra.md' }),
        fileRow({ path: 'requirements/brief.md', editable: false }),
        fileRow({ path: 'requirements/my-story-alpha.md' }),
        fileRow({ path: 'requirements/draft.md' }),
      ];

      const files = phaseFilesFrom(rows, base, (sha) => `bytes of ${sha}`);

      expect(files.map((file) => file.path)).toEqual([
        'requirements/draft.md',
        'requirements/brief.md',
        'requirements/my-story-alpha.md',
        'requirements/my-story-zebra.md',
      ]);
      // the base already holds the bytes it brought, so a save reads a blob
      // only for the files the teacher has added since
      expect(files[0].content).toBe('# Stories\n');
      expect(files[2].content).toBe('bytes of sha-requirements/my-story-alpha.md');
      expect(files[1].editable).toBe(false);
    });

    it('drops a path the rows no longer hold', () => {
      const files = phaseFilesFrom(
        [fileRow({ path: 'requirements/brief.md', editable: false })],
        phaseContent().files,
        () => '',
      );

      expect(files.map((file) => file.path)).toEqual(['requirements/brief.md']);
    });

    // A row whose bytes a teacher replaced at a path the copy brought holds a
    // new blob; the base still holds the old bytes at that path. Taking the
    // base's bytes by path alone would compile the old document, and the next
    // save would write it back.
    it("reads a replaced file's own blob, not the base's bytes at its path", () => {
      const read: string[] = [];
      const files = phaseFilesFrom(
        [
          fileRow({ path: 'requirements/brief.md', editable: false, blobSha: sha256Hex('# RoomDesk brief\n') }),
          fileRow({ path: 'requirements/draft.md' }),
        ],
        phaseContent().files,
        (sha) => {
          read.push(sha);
          return sha === sha256Hex('# RoomDesk brief\n') ? '# RoomDesk brief\n' : '';
        },
      );

      expect(files.find((file) => file.path === 'requirements/brief.md')?.content).toBe('# RoomDesk brief\n');
      // the untouched row still costs no read
      expect(files.find((file) => file.path === 'requirements/draft.md')?.content).toBe('# Stories\n');
      expect(read).toEqual([sha256Hex('# RoomDesk brief\n')]);
    });

    it("takes the base's bytes again once a row holds them again (the revert)", () => {
      const files = phaseFilesFrom(
        [fileRow({ path: 'requirements/brief.md', editable: false, blobSha: sha256Hex('# Brief\n') })],
        phaseContent().files,
        () => {
          throw new Error('a row holding the base bytes reads no blob');
        },
      );

      expect(files[0].content).toBe('# Brief\n');
    });

    it('names exactly the blobs a load must read, and none the base already holds', () => {
      const rows = [
        fileRow({ path: 'requirements/draft.md' }),
        fileRow({ path: 'requirements/brief.md', editable: false, blobSha: 'sha-new-brief' }),
        fileRow({ path: 'requirements/my-story-alpha.md' }),
      ];

      expect(blobsToRead(rows, phaseContent().files).sort()).toEqual(
        ['sha-new-brief', 'sha-requirements/my-story-alpha.md'].sort(),
      );
    });

    it('asks nothing of an application phase, whose bytes no door writes', () => {
      // A `code`, `tests` or `config` phase: every authoring door refuses its
      // files, so a row there always holds the bytes the copy brought, and a
      // load does not hash half a megabyte of application to learn that.
      const rows = [fileRow({ path: 'requirements/brief.md', editable: false, blobSha: 'sha-unreachable' })];
      const files = phaseFilesFrom(rows, phaseContent().files, () => 'never', { trustBase: true });

      expect(files[0].content).toBe('# Brief\n');
      expect(blobsToRead(rows, phaseContent().files, { trustBase: true })).toEqual([]);
    });
  });

  /* ------------------- the phase a draft compiles to ------------------- */

  describe('the phase a draft compiles to', () => {
    const storyTask = (over: Partial<ProjectTaskEntity> = {}) => taskRow({ taskKey: 'story', order: 1, title: 'The stories', ...over });
    const scopeTask = (over: Partial<ProjectTaskEntity> = {}) => taskRow({ taskKey: 'scope', order: 2, title: 'The scope', ...over });

    it('leaves a written phase, and an executable phase, exactly as it found them', () => {
      const one = phaseContent();
      expect(phaseFromTasks(one, [storyTask()])).toBe(one);
      expect(phaseFromTasks(one, [])).toBe(one);
      // two written tasks are the compiler's to refuse, not this derivation's to merge
      expect(phaseFromTasks(one, [storyTask(), scopeTask()])).toBe(one);

      // the wall is the compiler's sentence to say, not this derivation's: a
      // split `code` phase must reach `checkPhase` shaped as the teacher left it
      const code = phaseContent({
        checks: {
          kind: 'code',
          editableTargets: [],
          visibleTests: [],
          hiddenTestFiles: {},
          solutionFiles: {},
          solutionSources: [],
          runs: [{ id: 'all' }],
        },
      } as unknown as Partial<PhaseContent>);
      expect(phaseFromTasks(code, [storyTask(), scopeTask()])).toBe(code);
    });

    it('is gated in the editor by the same question the report asks', () => {
      // `blocksPublish` is the gate drawn beside the phase rather than only in
      // the report, and the two must never disagree. It therefore has to ask
      // about the phase's own kind, or a teacher could read "this blocks
      // publish" over a report saying it does not.
      const tasks = [
        draftTaskView(storyTask(), ['requirements/draft.md']),
        draftTaskView(scopeTask(), ['requirements/my-story-scope.md']),
      ];
      const phaseRow = { key: 'requirements', order: 1, title: 'Requirements', intro: '', artifactKind: 'story' } as ProjectPhaseEntity;

      expect(draftPhaseView(phaseRow, tasks, 'story').blocksPublish).toBe(refusesMultiTaskPublish(2, 'story'));
      expect(draftPhaseView(phaseRow, tasks, 'code').blocksPublish).toBe(refusesMultiTaskPublish(2, 'code'));
      // and a caller that names no kind still gets the phase row's own, which
      // is what a caller that predates per-task kinds passes
      expect(draftPhaseView(phaseRow, tasks).blocksPublish).toBe(refusesMultiTaskPublish(2, 'story'));

      // every kind publishes one graded task
      expect(draftPhaseView(phaseRow, tasks, 'story').blocksPublish).toBe(true);
      expect(draftPhaseView(phaseRow, tasks, 'code').blocksPublish).toBe(true);
    });
  });
});

/* ---------------------------------- quizzes ---------------------------------- */

describe('the two draft derivations a quiz reaches', () => {
  const QUIZ = fixtureQuizChecks();

  const quizRow = (over: Partial<ProjectTaskEntity> = {}): ProjectTaskEntity =>
    ({
      id: 'task-check',
      projectPhaseId: 'phase-1',
      taskKey: 'check',
      order: 2,
      required: false,
      signOff: false,
      artefactType: 'quiz',
      artefactPath: null,
      title: 'The concept check',
      brief: 'Five questions about this phase.',
      objectives: [],
      primaryPath: null,
      anchor: null,
      rubric: fixtureQuizRubric(),
      checks: QUIZ,
      ...over,
    }) as ProjectTaskEntity;

  const storyRow = (over: Partial<ProjectTaskEntity> = {}): ProjectTaskEntity =>
    taskRow({ taskKey: 'story', order: 1, ...over });

  it('the draft payload carries the quiz and never the key', () => {
    // Proof 3's unit half. `readDraft` and `listTasks` are behind
    // `requireVisibleProject`, which admits every instructor on the deployment
    // for any platform-owned project and any ADMIN for anybody's, so this
    // payload is not the owner's alone and the key is not in it.
    const view = draftTaskView(quizRow(), []);
    expect(view.checkKind).toBe('quiz');
    expect(view.artefactType).toBe('quiz');
    expect(view.authorable).toBe(true);
    expect(view.notice).toBeNull();
    expect('rules' in view).toBe(false);
    expect(view.quiz?.questions.map((one) => one.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(view.quiz?.questions[0].answerCount).toBe(1);
    expect(view.quiz?.passMark).toBe(QUIZ.passMark);
    expect(view.quiz?.drawn).toBe(3);

    // the seal, asserted over the whole serialised payload rather than field
    // by field, which is what `outcome` and `answerCount` exist for
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('correct');
    expect(wire).not.toContain('explanation');
    expect(wire).not.toContain(QUIZ.questions[0].explanation);
    // and the stems and options ARE there, because the editor draws them
    expect(wire).toContain(QUIZ.questions[0].stem);
  });

  it('phaseFromTasks hands a written phase back as it is, a quiz beside its task or not', () => {
    // a phase's checks are its sole non-quiz task's, and a quiz row contributes no unit and no criterion
    const phase = phaseContent();
    expect(phaseFromTasks(phase, [storyRow(), quizRow()])).toBe(phase);

    // The phase's OWN kind answers first, so a quiz row beside a code
    // task never derives a code phase's checks from a task row
    const code = phaseContent({
      checks: {
        kind: 'code',
        editableTargets: [],
        visibleTests: [],
        hiddenTestFiles: {},
        solutionFiles: {},
        solutionSources: [],
        runs: [{ id: 'all' }],
      },
    } as unknown as Partial<PhaseContent>);
    expect(phaseFromTasks(code, [storyRow(), quizRow()])).toBe(code);

    // and a phase of quizzes alone is handed back unchanged, which is the shape
    // `phase-needs-a-required-artefact-task` refuses with its own sentence
    expect(phaseFromTasks(phase, [quizRow({ taskKey: 'a', order: 1 }), quizRow({ taskKey: 'b' })])).toBe(
      phase,
    );
  });

  it('the editor gate counts the non-quiz tasks, so it agrees with the compiler', () => {
    // A `code` phase with one quiz beside its inherited task would otherwise
    // read `blocksPublish: true` in the editor while the compiler published
    // it: the editor telling a teacher their version cannot ship and the door
    // letting it through.
    const phaseRow = {
      key: 'requirements',
      order: 1,
      title: 'Requirements',
      intro: '',
      artifactKind: 'story',
    } as ProjectPhaseEntity;
    const tasks = [
      draftTaskView(storyRow(), ['requirements/draft.md']),
      draftTaskView(quizRow(), []),
    ];
    expect(draftPhaseView(phaseRow, tasks, 'code').blocksPublish).toBe(false);
    expect(draftPhaseView(phaseRow, tasks, 'story').blocksPublish).toBe(false);

    // two graded tasks beside a quiz is still a split, and still blocked
    const split = [
      ...tasks,
      draftTaskView(storyRow({ taskKey: 'scope', order: 3 }), ['requirements/my-story-scope.md']),
    ];
    expect(draftPhaseView(phaseRow, split, 'code').blocksPublish).toBe(
      refusesMultiTaskPublish(2, 'code'),
    );
    expect(draftPhaseView(phaseRow, split, 'story').blocksPublish).toBe(true);

    // and `publishableTasksPerPhase` answers one for every kind
    for (const kind of ['story', 'design', 'code', 'tests', 'config', 'quiz'] as const) {
      expect(publishableTasksPerPhase(kind)).toBe(1);
    }
  });
});

/*
 * The interview as the draft payload shows it
 * carries the stakeholder, the opening, the limits and each fact's topic, and
 * nothing a learner could be handed an answer from: asked of the view builder
 * itself, so a field added to it is caught here and not only by the mounted
 * journey.
 */
import { draftInterviewViewOf } from './draft';
import { ROOMDESK_INTERVIEW } from '../../test/reference-scenario-roomdesk';
import { ContentService as InterviewContentService } from '../content/content.service';

describe('draftInterviewViewOf', () => {
  const content = new InterviewContentService();
  content.loadAll();
  const reference = content.getProject('tasktrackr').phases.find((phase) => phase.key === 'requirements')!.interview!;

  for (const [name, brief] of [
    ['the reference brief', reference],
    ["a teacher's brief", ROOMDESK_INTERVIEW],
  ] as const) {
    it(`shows ${name} with no answer, keyword, unknown reply or refusal`, () => {
      // keywords are shut out by the key sets below (a keyword may equal a fact's id)
      const view = draftInterviewViewOf(brief as never);
      expect(Object.keys(view).sort()).toEqual(['facts', 'factsExpected', 'maxTurns', 'opening', 'persona']);
      expect(Object.keys(view.persona).sort()).toEqual(['name', 'role']);
      for (const fact of view.facts) expect(Object.keys(fact).sort()).toEqual(['id', 'topic']);
      const wire = JSON.stringify(view);
      for (const fact of brief.facts) {
        expect([fact.id, wire.includes(fact.answer)]).toEqual([fact.id, false]);
      }
      expect(wire.includes(brief.unknownReply)).toBe(false);
      expect(wire.includes(brief.refusal)).toBe(false);
    });
  }
});

/* ======================================================================== *
 * The executable arm of `phaseFromTasks`, for                              *
 * the SOLE work task of a code or tests phase. A second work task,         *
 * or a work row of another kind, is handed back untouched so the compiler's *
 * wall (EXECUTABLE_SPLIT_NOT_READY) refuses it.                            *
 * ======================================================================== */
describe('the executable arm of phaseFromTasks', () => {
  /** A copy's materialised `main` row for a reference phase: `createProject`'s loop. */
  const mainRowOf = (phase: PhaseContent): ProjectTaskEntity => {
    const task = soleTaskFor(phase);
    return taskRow({
      taskKey: INHERITED_TASK_KEY,
      order: 1,
      required: task.required,
      artefactType: task.artefactType,
      artefactPath: task.artefactPath,
      title: task.title,
      brief: task.brief,
      objectives: task.objectives,
      rubric: task.rubric,
      // through JSON, as a row read back from the database is
      checks: JSON.parse(JSON.stringify(task.checks ?? phase.checks)),
    });
  };
  const quizRow = (): ProjectTaskEntity =>
    taskRow({
      taskKey: 'check',
      order: 2,
      required: false,
      artefactType: 'quiz',
      artefactPath: null,
      checks: fixtureQuizChecks(),
      rubric: fixtureQuizRubric(),
    });

  it('phaseFromTasks derives hiddenTestFiles and solutionSources', () => {
    const phase = tasktrackrPhase('implementation');
    const row = mainRowOf(phase);
    const checks = row.checks as CodeChecks;
    // an edited task: a new hidden case in the first run, and a new answer:
    // the flat unions on the row left as they were (the shape a sealed write
    // to one run leaves), so only a derivation can make them true
    const run = checks.runs[0];
    const hiddenPath = Object.keys(run.hiddenTestFiles)[0];
    run.hiddenTestFiles = { ...run.hiddenTestFiles, [hiddenPath]: `${run.hiddenTestFiles[hiddenPath]}\n# MARKER-HIDDEN-S2\n` };
    const answered = checks.editableTargets[0];
    checks.solutionFiles = { ...checks.solutionFiles, [answered]: '# MARKER-SOLUTION-S2\n' };

    const derived = phaseFromTasks(phase, [row]);
    expect(derived).not.toBe(phase);
    const out = derived.checks as CodeChecks;
    expect(out.hiddenTestFiles[hiddenPath]).toContain('MARKER-HIDDEN-S2');
    // the union over runs, as the loader builds it
    const union: Record<string, string> = {};
    for (const one of out.runs) Object.assign(union, one.hiddenTestFiles);
    expect(out.hiddenTestFiles).toEqual(union);
    expect(out.solutionSources).toEqual(Object.values(out.solutionFiles));
    expect(out.solutionSources).toContain('# MARKER-SOLUTION-S2\n');
    expect(out.solutionSources.join('\n')).not.toContain(phase.checks.kind === 'code' ? (phase.checks as CodeChecks).solutionFiles[answered] : '');
    // the rest of the slice is the task's: runs, solution files, targets
    expect(out.runs).toEqual(checks.runs);
    expect(out.solutionFiles).toEqual(checks.solutionFiles);
    expect(out.editableTargets).toEqual(checks.editableTargets);
    // and a quiz beside it changes nothing about what is derived
    expect(phaseFromTasks(phase, [row, quizRow()]).checks).toEqual(out);
  });

  it("phaseFromTasks keeps a Maintenance's ticket and change request: the derived checks carry both, and its task the record unit", () => {
    const phase = new InterviewContentService().loadProject(recordPack()).phases.find((one) => one.key === 'maintenance')!;
    const checks = phase.checks as CodeChecks;
    expect(checks.ticket).toBeDefined();
    expect(checks.change).toBeDefined();
    // an untouched copy is the identity
    expect(phaseFromTasks(phase, [mainRowOf(phase)])).toBe(phase);
    // an edited task (a new answer), so the checks are derived afresh from the slice
    const row = mainRowOf(phase);
    const sliced = row.checks as CodeChecks;
    sliced.solutionFiles = { ...sliced.solutionFiles, [sliced.editableTargets[0]]: '# MARKER-SOLUTION-M3\n' };
    const derived = phaseFromTasks(phase, [row]);
    expect(derived).not.toBe(phase);
    const out = derived.checks as CodeChecks;
    expect(out.solutionSources).toContain('# MARKER-SOLUTION-M3\n');
    expect(out.ticket).toEqual(checks.ticket);
    expect(out.change).toEqual(checks.change);
    expect(soleTaskFor(derived).gradedUnits).toContainEqual({ kind: 'record', id: checks.change!.record });
  });

  it("phaseFromTasks derives a tests phase's runs, learnerTestFiles, minTests, coverageKeywords and mutants from its sole work task", () => {
    const phase = tasktrackrPhase('testing');
    const row = mainRowOf(phase);
    const checks = row.checks as TestsChecks;
    checks.minTests = checks.minTests + 2;
    checks.coverageKeywords = [{ criterion: checks.coverageKeywords[0].criterion, keywords: ['shelf'] }];
    checks.mutants = checks.mutants.slice(1);

    const out = phaseFromTasks(phase, [row]).checks as TestsChecks;
    expect(out.minTests).toBe((phase.checks as TestsChecks).minTests + 2);
    expect(out.coverageKeywords).toEqual(checks.coverageKeywords);
    expect(out.mutants.map((one) => one.name)).toEqual(checks.mutants.map((one) => one.name));
    expect(out.runs).toEqual(checks.runs);
    expect(out.learnerTestFiles).toEqual(checks.learnerTestFiles);
  });

  it('a second work task is refused (handed to the compiler wall, never derived from either)', () => {
    const phase = tasktrackrPhase('implementation');
    const first = mainRowOf(phase);
    (first.checks as CodeChecks).solutionFiles = { '# edited': 'x' };
    const second = { ...mainRowOf(phase), id: 'task-second', taskKey: 'second', order: 2 } as ProjectTaskEntity;
    expect(phaseFromTasks(phase, [first, second])).toBe(phase);
    // and the compiler refuses it with its own sentence
    const content = tasktrackrContent().getProject('tasktrackr');
    const phases = content.phases.map((one) => (one.key === 'implementation' ? phaseFromTasks(one, [first, second]) : one));
    const authored = {
      implementation: authoredTasksFor(phase, [first, second]),
    };
    // (the partition question answers first for two copies of one task, the
    // split wall for two distinct ones; either way it is the compiler's
    // sentence about this phase's two tasks, never a crash)
    expect(() => compilePack({ ...content, phases }, { authored })).toThrow(
      new RegExp(`tasktrackr/implementation: (tasks "main" and "second" both own|.*${EXECUTABLE_SPLIT_NOT_READY.slice(0, 20)})`),
    );
  });

  it('a non-quiz row of another kind is refused: never derived, the compiler wall says so', () => {
    const phase = tasktrackrPhase('implementation');
    const written = taskRow({ taskKey: 'notes', order: 1, artefactPath: 'notes.md' });
    expect(phaseFromTasks(phase, [written])).toBe(phase);
    expect(phaseFromTasks(phase, [mainRowOf(phase), written])).toBe(phase);
  });

  it('a new sealed hidden file is graded: it joins its run\'s testPaths, and a solution outside the editable targets is never one', () => {
    const phase = tasktrackrPhase('implementation');
    const row = mainRowOf(phase);
    const out = phaseFromTasks(phase, [row], [
      { role: 'hidden', path: 'hidden/tests/test_extra_hidden.py', bytes: 'import unittest\n' },
      { role: 'solution', path: 'solution/api/not_a_target.py', bytes: '# MARKER-STRAY\n' },
    ]).checks as CodeChecks;
    const api = out.runs.find((run) => run.language === 'python')!;
    expect(api.hiddenTestFiles['tests/test_extra_hidden.py']).toBe('import unittest\n');
    expect(api.testPaths).toContain('tests/test_extra_hidden.py');
    // the loader maps a solution onto the editable targets only
    expect(Object.keys(out.solutionFiles)).not.toContain('api/not_a_target.py');
    expect(out.solutionSources.join('')).not.toContain('MARKER-STRAY');
  });

  it('a new sealed helper or fixture is mounted with its run but never collected as a test', () => {
    const phase = tasktrackrPhase('implementation');
    const out = phaseFromTasks(phase, [mainRowOf(phase)], [
      { role: 'hidden', path: 'hidden/tests/fixtures/data.json', bytes: '{"rows": []}\n' },
      { role: 'hidden', path: 'hidden/tests/hidden_helpers.py', bytes: 'X = 1\n' },
    ]).checks as CodeChecks;
    const api = out.runs.find((run) => run.language === 'python')!;
    expect(api.hiddenTestFiles['tests/hidden_helpers.py']).toBe('X = 1\n');
    expect(api.testPaths).not.toContain('tests/hidden_helpers.py');
    for (const run of out.runs) expect(run.testPaths).not.toContain('tests/fixtures/data.json');
  });

  it("a tests task's new reference file is sorted by its name, *.spec.ts and *_test.py included, and sits under a directory its run already collects (never added to testPaths; title declared)", () => {
    const phase = tasktrackrPhase('testing');
    const out = phaseFromTasks(phase, [mainRowOf(phase)], [
      { role: 'reference', path: 'reference/web/src/extra.spec.ts', bytes: 'test("x", () => {});\n' },
      { role: 'reference', path: 'reference/tests/extra_test.py', bytes: 'def test_x():\n    pass\n' },
      { role: 'reference', path: 'reference/api/helper_impl.py', bytes: 'X = 1\n' },
    ]).checks as TestsChecks;
    expect(Object.keys(out.referenceTestFiles)).toEqual(expect.arrayContaining(['web/src/extra.spec.ts', 'tests/extra_test.py']));
    expect(Object.keys(out.implFiles)).toContain('api/helper_impl.py');
    const web = out.runs.find((run) => run.language === 'typescript')!;
    expect(web.referenceTestFiles['web/src/extra.spec.ts']).toBeDefined();
    expect(web.testPaths.some((at) => 'web/src/extra.spec.ts' === at || 'web/src/extra.spec.ts'.startsWith(`${at.replace(/\/$/, '')}/`))).toBe(true);
  });

  /* ---- collectNew never adds a reference test to a tests run ---- */
  it('a new reference test written to a tests phase lands in referenceTestFiles and never in run.testPaths', () => {
    const phase = tasktrackrPhase('testing');
    const before = (phase.checks as TestsChecks).runs.map((run) => [run.id, [...run.testPaths]]);
    // outside every directory a run already collects ('tests', 'web/src'), as a teacher's new suite file may be
    const at = 'acceptance/test_more_reference.py';
    const out = phaseFromTasks(phase, [mainRowOf(phase)], [
      { role: 'reference', path: `reference/${at}`, bytes: 'def test_more():\n    pass\n' },
    ]).checks as TestsChecks;
    expect(out.referenceTestFiles[at]).toBe('def test_more():\n    pass\n');
    const holder = out.runs.find((run) => run.referenceTestFiles[at] !== undefined);
    expect(holder?.language).toBe('python');
    // the loader's rule: a tests run collects the learner's test files only
    for (const run of out.runs) expect(run.testPaths).not.toContain(at);
    expect(out.runs.map((run) => [run.id, run.testPaths])).toEqual(before);
  });

  it('GUARD › a new hidden test on a code phase lands in its language\'s first run, mounted and collected', () => {
    const phase = tasktrackrPhase('implementation');
    const runs = (phase.checks as CodeChecks).runs;
    const python = runs.find((run) => run.language === 'python')!;
    const at = 'tests/test_s7_guard_hidden.py';
    const out = phaseFromTasks(phase, [mainRowOf(phase)], [{ role: 'hidden', path: `hidden/${at}`, bytes: 'import unittest\n' }]).checks as CodeChecks;
    for (const run of out.runs) {
      const was = runs.find((one) => one.id === run.id)!;
      if (run.id === python.id) {
        expect(run.hiddenTestFiles[at]).toBe('import unittest\n');
        expect(run.testPaths).toEqual([...was.testPaths, at]);
      } else {
        expect(run.hiddenTestFiles[at]).toBeUndefined();
        expect(run.testPaths).toEqual(was.testPaths);
      }
    }
  });

  /* ---- a stored run per sealed row ---- */
  describe('a sealed row may carry its run', () => {
    /**
     * The shelf upload fixture with a second python run in Maintenance
     * (`api-more`), built in a temp folder from the fixture's bytes (the
     * fixture's own folder is not edited and has one python run): the shape
     * "run 2+ of a shared language" needs.
     */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodePath = require('path') as typeof import('path');
    let dir = '';
    let maintenance: PhaseContent;
    beforeAll(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SHELF_DIR } = require('../../test/fixtures/upload-packs/markers') as typeof import('../../test/fixtures/upload-packs/markers');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ContentService } = require('../content/content.service') as typeof import('../content/content.service');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DirectoryPackSource } = require('../content/pack-source') as typeof import('../content/pack-source');
      dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'rx-s11-shelf-'));
      fs.cpSync(SHELF_DIR, dir, { recursive: true });
      const phaseDir = nodePath.join(dir, 'phases', '06-maintenance');
      const phaseJson = JSON.parse(fs.readFileSync(nodePath.join(phaseDir, 'phase.json'), 'utf-8'));
      // the folder layout: the run names no folder (its sealed suite is hidden_tests/<run id>/), and its visible
      // test is a locked mount under readonly/ at its workspace path
      phaseJson.checks.runs.push({
        id: 'api-more', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'More API tests',
        visibleTests: ['tests/test_shelf_order_more.py'], supportFiles: ['tests/conftest.py'],
      });
      fs.writeFileSync(nodePath.join(phaseDir, 'phase.json'), JSON.stringify(phaseJson, null, 2));
      fs.writeFileSync(nodePath.join(phaseDir, 'readonly', 'tests', 'test_shelf_order_more.py'), 'def test_more_visible():\n    assert True\n');
      // a hidden test sits at the workspace path it runs from, under its run's folder
      fs.mkdirSync(nodePath.join(phaseDir, 'hidden_tests', 'api-more', 'tests'), { recursive: true });
      fs.writeFileSync(nodePath.join(phaseDir, 'hidden_tests', 'api-more', 'tests', 'test_hidden_more.py'), 'import unittest\n\n\nclass More(unittest.TestCase):\n    def test_more(self):\n        self.assertTrue(True)\n');
      const project = new ContentService().loadProject(new DirectoryPackSource(dir));
      maintenance = project.phases.find((one) => one.key === 'maintenance')!;
    });
    afterAll(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    /** The row path a run-carrying sealed row is stored at (the reserved segment `\run\<id>` after the role's folder). */
    const RUN_ROW = (role: string, runId: string, at: string) => `${role}/\\run\\${runId}/${at}`;
    const runsOf = (out: CodeChecks) => Object.fromEntries(out.runs.map((run) => [run.id, run]));

    it('› a new hidden test written to the Shelf pack Maintenance\'s second python run lands in run 2 and is graded there', () => {
      const checks = maintenance.checks as CodeChecks;
      expect(checks.runs.filter((run) => run.language === 'python').map((run) => run.id)).toEqual(['api', 'api-more']);
      const at = 'tests/test_hidden_extra.py';
      const out = phaseFromTasks(maintenance, [mainRowOf(maintenance)], [
        { role: 'hidden', path: RUN_ROW('hidden', 'api-more', at), bytes: 'import unittest\n# run two\n' },
      ]).checks as CodeChecks;
      const runs = runsOf(out);
      expect(runs['api-more'].hiddenTestFiles[at]).toBe('import unittest\n# run two\n');
      expect(runs['api-more'].testPaths).toContain(at);
      expect(runs.api.hiddenTestFiles[at]).toBeUndefined();
      expect(runs.api.testPaths).not.toContain(at);
      // no run holds a path that spells the reserved segment
      for (const run of out.runs) expect(Object.keys(run.hiddenTestFiles).some((one) => one.includes('\\'))).toBe(false);
    });

    it('› the same path in run 1 and run 2 is held as two rows with their own bytes', () => {
      const at = 'tests/test_hidden_twice.py';
      const out = phaseFromTasks(maintenance, [mainRowOf(maintenance)], [
        { role: 'hidden', path: RUN_ROW('hidden', 'api-more', at), bytes: '# bytes of run two\n' },
        { role: 'hidden', path: `hidden/${at}`, bytes: '# bytes of run one\n' },
      ]).checks as CodeChecks;
      const runs = runsOf(out);
      expect(runs.api.hiddenTestFiles[at]).toBe('# bytes of run one\n');
      expect(runs['api-more'].hiddenTestFiles[at]).toBe('# bytes of run two\n');
      expect(runs.web.hiddenTestFiles[at]).toBeUndefined();
    });

    it('› the reserved run segment is one no upload path can spell: the zip reader and MemoryPackSource refuse it in an archive, and the sealed door refuses it', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const draft = require('./draft') as typeof import('./draft');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { readZip, zipLimits, UploadRefusal } = require('../content/zip-reader') as typeof import('../content/zip-reader');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { MemoryPackSource } = require('../content/memory-pack-source') as typeof import('../content/memory-pack-source');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { writeZip } = require('../../test/fixtures/upload-packs/archive') as typeof import('../../test/fixtures/upload-packs/archive');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { checkedSealedPath } = require('./sealed-roles') as typeof import('./sealed-roles');

      // the encoding, and its inverse
      const carried = draft.sealedRunRowPath('hidden/tests/test_x.py', 'api-more');
      expect(carried).toBe(RUN_ROW('hidden', 'api-more', 'tests/test_x.py'));
      expect(carried).toContain(draft.SEALED_RUN_MARK);
      expect(draft.sealedRowRunOf(carried)).toEqual({ path: 'hidden/tests/test_x.py', runId: 'api-more' });
      expect(draft.sealedRowRunOf('hidden/tests/test_x.py')).toEqual({ path: 'hidden/tests/test_x.py', runId: null });

      // an archive entry spelling the segment, anywhere in its name, is refused by the reader
      const segment = draft.SEALED_RUN_MARK + 'api-more';
      for (const name of [`phases/06-maintenance/hidden_tests/api/${segment}/test_x.py`, `hidden/${segment}/tests/test_x.py`, `${segment}/x.py`]) {
        let code = '';
        try {
          readZip(writeZip([{ name: 'project.json', data: Buffer.from('{}') }, { name, data: Buffer.from('x = 1\n') }]), zipLimits(1 << 20));
        } catch (error) {
          expect(error).toBeInstanceOf(UploadRefusal);
          code = (error as InstanceType<typeof UploadRefusal>).code;
        }
        expect([name, code]).toEqual([name, 'ARCHIVE_PATH_ESCAPE']);
      }
      // a MemoryPackSource handed such an entry anyway never walks into it
      const source = new MemoryPackSource(
        [
          { name: 'project.json', bytes: Buffer.from('{}') },
          { name: `hidden_tests/${segment}/test_x.py`, bytes: Buffer.from('x = 1\n') },
        ],
        'probe',
      );
      expect(source.exists(`hidden_tests/${segment}/test_x.py`)).toBe(false);
      expect(() => source.read(`hidden_tests/${segment}/test_x.py`)).toThrow(UploadRefusal);
      expect(() => source.child('hidden_tests').child(segment).entries()).toThrow(UploadRefusal);
      // and the sealed door's own path rule refuses it, so no door write spells a carried row either
      expect(() => checkedSealedPath(`${segment}/tests/test_x.py`)).toThrow();
      expect(() => checkedSealedPath(`tests/${segment}/test_x.py`)).toThrow();
    });

    it('GUARD › a hidden row whose path names no run is placed as runForPath places it, or in every run that holds the path', () => {
      const checks = maintenance.checks as CodeChecks;
      const fresh = 'tests/test_hidden_plain.py';
      const held = Object.keys(checks.runs.find((run) => run.id === 'api')!.hiddenTestFiles)[0];
      const out = phaseFromTasks(maintenance, [mainRowOf(maintenance)], [
        { role: 'hidden', path: `hidden/${fresh}`, bytes: '# plain new\n' },
        { role: 'hidden', path: `hidden/${held}`, bytes: '# plain held\n' },
      ]).checks as CodeChecks;
      const runs = runsOf(out);
      // a new path: the first run of its language, the default placement
      expect(runs.api.hiddenTestFiles[fresh]).toBe('# plain new\n');
      expect(runs['api-more'].hiddenTestFiles[fresh]).toBeUndefined();
      // a held path: every run that holds it, and no other
      for (const run of checks.runs) {
        expect([run.id, out.runs.find((one) => one.id === run.id)!.hiddenTestFiles[held]]).toEqual([run.id, held in run.hiddenTestFiles ? '# plain held\n' : undefined]);
      }
    });
  });

  it("GUARD › a fresh copy of a published project compiles to the copy's own phases ('main' and 'main' + quiz shapes)", () => {
    // the executable phases come back as the very object, so nothing the
    // compile overlays differs from the copy's own phase ...
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
      const phase = tasktrackrPhase(key);
      expect(phaseFromTasks(phase, [mainRowOf(phase)])).toBe(phase);
      expect(phaseFromTasks(phase, [mainRowOf(phase), quizRow()])).toBe(phase);
    }
    // ... and the written ones as they are (a 'main' + quiz phase is the same object)
    for (const key of ['requirements', 'design'] as const) {
      const phase = tasktrackrPhase(key);
      expect(phaseFromTasks(phase, [mainRowOf(phase)])).toBe(phase);
      expect(canonicalJson(phaseFromTasks(phase, [mainRowOf(phase), quizRow()]))).toBe(canonicalJson(phase));
    }
  });
});

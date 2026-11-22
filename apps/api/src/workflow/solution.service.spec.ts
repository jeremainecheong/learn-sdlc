import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { INHERITED_TASK_KEY, SOLUTION_LOCKED_MESSAGE, type PhaseRubric } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { strictlyReviewed } from '../../test/strict-evidence-fixture';
import { SolutionService } from './solution.service';
import { STRICT_EVIDENCE_REPORT_BATCH, taskHasStrictEvidence } from './strict-gate';
import { WorkflowService } from './workflow.service';

/**
 * The post-gate reveal.
 *
 * The rules worth a test are the ones the feature is only safe because of: the
 * gate is the key, the first reading is stamped exactly once, and a phase the
 * pack answers nothing for says so instead of drawing an empty page.
 */
describe('SolutionService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: SolutionService;

  let learnerId = '';
  let states: PhaseStateEntity[] = [];
  const phase = (key: string): PhaseStateEntity => states.find((s) => s.phaseKey === key)!;

  const manager = () => dataSource.manager;

  const makeUser = (email: string): Promise<UserEntity> =>
    manager().save(
      manager().create(UserEntity, { email, passwordHash: 'x', displayName: email.split('@')[0] }),
    );

  /** Materialises an enrolment the way `WorkflowService.enroll` does. */
  const enrol = async (userId: string): Promise<PhaseStateEntity[]> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
        packVersion: '1.0.0',
      }),
    );
    const rows: PhaseStateEntity[] = [];
    for (const p of content.getProject('tasktrackr').phases) {
      rows.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId,
            phaseKey: p.key,
            phaseOrder: p.order,
            status: 'in_progress',
            attempts: 0,
            unlockedAt: new Date().toISOString(),
          }),
        ),
      );
    }
    return rows;
  };

  /** The board half of a pass: what a teacher's phase-wide Pass writes, and nothing else. */
  const markPassed = (state: PhaseStateEntity): Promise<unknown> =>
    manager().update(PhaseStateEntity, state.id, {
      status: 'passed',
      passedAt: new Date().toISOString(),
      bestScore: 86,
      attempts: 1,
    });

  /** The phase's sole task's rubric, which is what a review of it is judged against. */
  const rubricOf = (key: string): PhaseRubric => soleTaskFor(content.getPhase('tasktrackr', key)).rubric;

  /**
   * Puts a phase through its gate, with a merged revision behind it: a
   * strictly reviewed one, because that is what the gate requires.
   * `snapshot: null` adds a second, newer passing revision that kept no
   * snapshot, so `mergedFiles`' fallback is still reachable.
   */
  const pass = async (
    state: PhaseStateEntity,
    snapshot: Record<string, string> | null,
  ): Promise<void> => {
    await markPassed(state);
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: state.id,
        userId: learnerId,
        status: 'completed',
        passed: true,
        score: 86,
        workspaceSnapshot: snapshot ?? {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(rubricOf(state.phaseKey)),
        createdAt: new Date(Date.now() - 60_000),
      }),
    );
    if (snapshot === null) {
      await manager().save(
        manager().create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: learnerId,
          status: 'completed',
          passed: true,
          score: 86,
          workspaceSnapshot: null,
          createdAt: new Date(),
        }),
      );
    }
  };

  const audits = () => manager().find(AuditEventEntity, { where: { event: 'solution.read' } });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    const feedback = { latestFor: async () => null } as unknown as FeedbackService;
    const workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      feedback,
      dataSource,
    );
    service = new SolutionService(
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(SubmissionEntity),
      workflow,
      content,
      dataSource,
    );
    learnerId = (await makeUser('lee@class.edu')).id;
    states = await enrol(learnerId);
  });

  it('refuses the reference before the gate has passed', async () => {
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      'the reference opens when this phase passes its gate',
    );
  });

  it('refuses a phase whose status says passed but which carries no stamp', async () => {
    await manager().update(PhaseStateEntity, phase('implementation').id, { status: 'passed' });
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      'the reference opens when this phase passes its gate',
    );
  });

  it('keeps the reference shut on a phase passed on the board with no reviewed pass behind it', async () => {
    // A teacher's phase-wide Pass (or Sign off) writes exactly this: the board
    // reads passed and stamped, and there is no revision at all. The gate
    // still wants a strictly reviewed pass, so the answer key must not open:
    // otherwise the learner reads it, submits it, and earns the very pass the
    // gate was waiting for.
    await markPassed(phase('implementation'));
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );
    // Nothing was read, so nothing is stamped or audited.
    const row = await manager().findOneByOrFail(PhaseStateEntity, { id: phase('implementation').id });
    expect(row.solutionReadAt).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it('a passing revision the strict review did not accept does not open it either', async () => {
    await markPassed(phase('implementation'));
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: phase('implementation').id,
        userId: learnerId,
        status: 'completed',
        passed: true,
        score: 86,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        // A pass, but not a strict one: no review behind it.
        report: { assessmentMode: 'legacy_weighted', passed: true, checks: [] } as never,
      }),
    );
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );
  });

  it('opens once the strictly reviewed pass is in, the way TaskTrackr always opened it', async () => {
    await markPassed(phase('implementation'));
    await expect(service.read(learnerId, phase('implementation').id)).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );
    await pass(phase('implementation'), {});
    const view = await service.read(learnerId, phase('implementation').id);
    expect(view.available).toBe(true);
    expect(view.readAt).not.toBeNull();
  });

  /**
   * The door's question is asked on every read of a passed phase: the room,
   * the shell's summaries, so loading the report of every passing revision of
   * the task at once would be costly. It reads reports a few at a time, newest
   * first, and stops at the first strictly reviewed pass; the answer is the
   * same as reading them all, including for evidence older than the rest.
   */
  describe('the evidence question reads a bounded number of reports', () => {
    const LEGACY = 30;
    const loads = (): number[] => {
      const seen: number[] = [];
      const find = manager().find.bind(manager());
      jest.spyOn(manager(), 'find').mockImplementation((async (entity: unknown, options?: { select?: unknown }) => {
        const rows = await (find as (e: unknown, o?: unknown) => Promise<unknown[]>)(entity, options);
        const select = Array.isArray(options?.select) ? (options!.select as string[]) : [];
        if (entity === SubmissionEntity && select.includes('report')) seen.push(rows.length);
        return rows;
      }) as never);
      return seen;
    };
    const legacyPasses = async (state: PhaseStateEntity, olderThanMs: number): Promise<void> => {
      for (let i = 0; i < LEGACY; i += 1) {
        await manager().save(manager().create(SubmissionEntity, {
          phaseStateId: state.id, userId: learnerId, status: 'completed', passed: true, score: 86,
          workspaceSnapshot: {}, contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
          report: { assessmentMode: 'legacy_weighted', passed: true, checks: [] } as never,
          createdAt: new Date(Date.now() - olderThanMs - i * 1000),
        }));
      }
    };
    const ask = (state: PhaseStateEntity): Promise<boolean> =>
      taskHasStrictEvidence(manager(), { id: state.id }, soleTaskFor(content.getPhase('tasktrackr', state.phaseKey)), true, learnerId);

    afterEach(() => jest.restoreAllMocks());

    it('stops at the newest strictly reviewed pass without loading the older reports', async () => {
      const state = phase('implementation');
      await legacyPasses(state, 10 * 60_000);
      await pass(state, {});
      const seen = loads();
      await expect(ask(state)).resolves.toBe(true);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(STRICT_EVIDENCE_REPORT_BATCH);
    });

    it('still finds a strict pass older than every other revision, a batch at a time', async () => {
      const state = phase('implementation');
      await pass(state, {});
      await legacyPasses(state, 0);
      const seen = loads();
      await expect(ask(state)).resolves.toBe(true);
      expect(Math.max(...seen)).toBeLessThanOrEqual(STRICT_EVIDENCE_REPORT_BATCH);
      expect(seen.reduce((a, b) => a + b, 0)).toBe(LEGACY + 1);
    });

    it('answers no when none of the revisions is a strict pass', async () => {
      const state = phase('implementation');
      await markPassed(state);
      await legacyPasses(state, 0);
      const seen = loads();
      await expect(ask(state)).resolves.toBe(false);
      expect(Math.max(...seen)).toBeLessThanOrEqual(STRICT_EVIDENCE_REPORT_BATCH);
    });
  });

  it("hands back the pack's answer and the learner's merged file, per path", async () => {
    const target = content.getPhase('tasktrackr', 'implementation');
    if (target.checks.kind !== 'code') throw new Error('implementation is a code phase');
    const targets = target.checks.editableTargets;
    await pass(phase('implementation'), { [targets[0]]: 'mine\n' });

    const view = await service.read(learnerId, phase('implementation').id);
    expect(view.available).toBe(true);
    expect(view.unavailableReason).toBeNull();
    expect(view.files.map((f) => f.path)).toEqual(targets);
    expect(view.files[0].yours).toBe('mine\n');
    expect(view.files[0].theirs).toBe(target.checks.solutionFiles[targets[0]]);
    expect(view.bestScore).toBe(86);
    // `loadOwnedState` reconciles the enrolment to the pack it is grading
    // against, so the answer names the pack the reader is actually reading.
    expect(view.packVersion).toBe(content.getProject('tasktrackr').version);
    expect(view.readAt).not.toBeNull();
    // Two languages in one phase, and the listing has to say which is which.
    expect(new Set(view.files.map((f) => f.language)).size).toBeGreaterThan(1);
  });

  it('says the file was not kept when the passing revision has no snapshot and the workspace is empty', async () => {
    await pass(phase('implementation'), null);
    const view = await service.read(learnerId, phase('implementation').id);
    expect(view.available).toBe(true);
    expect(view.files.every((f) => f.yours === null)).toBe(true);
  });

  it('falls back to the workspace when the passing revision kept no snapshot', async () => {
    const target = content.getPhase('tasktrackr', 'implementation');
    if (target.checks.kind !== 'code') throw new Error('implementation is a code phase');
    const path = target.checks.editableTargets[0];
    await manager().update(PhaseStateEntity, phase('implementation').id, {
      workspace: { [path]: 'still in the workspace\n' },
    });
    await pass(phase('implementation'), null);
    const view = await service.read(learnerId, phase('implementation').id);
    expect(view.files.find((f) => f.path === path)?.yours).toBe('still in the workspace\n');
  });

  it('hands back the reference suite for the testing phase', async () => {
    const target = content.getPhase('tasktrackr', 'testing');
    if (target.checks.kind !== 'tests') throw new Error('testing is a tests phase');
    await pass(phase('testing'), {});
    const view = await service.read(learnerId, phase('testing').id);
    expect(view.files.map((f) => f.path)).toEqual(target.checks.learnerTestFiles);
    expect(view.files[0].theirs).toBe(target.checks.referenceTestFiles[target.checks.learnerTestFiles[0]]);
  });

  it('has no answer for a prose phase, and says why', async () => {
    await pass(phase('requirements'), {});
    const view = await service.read(learnerId, phase('requirements').id);
    expect(view.available).toBe(false);
    expect(view.unavailableReason).toBe('prose');
    expect(view.files).toEqual([]);
  });

  it('has no answer for the deployment phase, and says why', async () => {
    await pass(phase('deployment'), {});
    const view = await service.read(learnerId, phase('deployment').id);
    expect(view.unavailableReason).toBe('config');
  });

  it('stamps the read once and writes one audit row, however often it is opened', async () => {
    await pass(phase('implementation'), {});
    const first = await service.read(learnerId, phase('implementation').id);
    const again = await service.read(learnerId, phase('implementation').id);
    expect(again.readAt).toBe(first.readAt);
    expect(await audits()).toHaveLength(1);
    const row = (await audits())[0];
    expect(row.actorUserId).toBe(learnerId);
    expect(row.subjectUserId).toBe(learnerId);
    expect(row.action).toBe('implementation');
  });

  it('records nothing for a phase the pack answers nothing for', async () => {
    await pass(phase('requirements'), {});
    const view = await service.read(learnerId, phase('requirements').id);
    expect(view.readAt).toBeNull();
    expect(await audits()).toHaveLength(0);
  });

  it("refuses another learner's phase in loadOwnedState's own words", async () => {
    const stranger = await makeUser('kim@class.edu');
    await pass(phase('implementation'), {});
    await expect(service.read(stranger.id, phase('implementation').id)).rejects.toThrow(
      'not your phase',
    );
  });
});

/**
 * The door, per task.
 *
 * Two questions that look like one and are not.
 *
 * **Which task is this request about?** A per-task route names a key. A
 * phase-level route names none, and its answer is *the phase's only task*,
 * never `SOLE_TASK_KEY`, which is a key the **compiler** mints for a phase
 * whose list it synthesised. Every phase of every teacher-authored project
 * holds one *authored* task keyed `main`, so `soleTaskList` is false there and
 * a `SOLE_TASK_KEY` default would 404 the door on every one of them:
 * `code` and `tests` phases most of all, because those are the ones with files
 * behind it.
 *
 * **Is it open?** The gate is the task's own two columns, and a task that has
 * never been written a row has not passed. On a sole-task phase that row is
 * the phase state, field for field, which is why TaskTrackr's door is the
 * phase's.
 *
 * One caveat is asserted rather than assumed: a written task's door opens
 * and contains **nothing**, because `referenceFiles` answers
 * `{available:false, reason:'prose'}` for markdown whatever the gate said.
 */
describe('SolutionService, per task', () => {
  const TEACHER = 'ms-tan-tasktrackr';
  const V_MAIN = 'v-teacher-main';
  const V_SPLIT = 'v-teacher-split';
  const learner = 'task-door-learner';

  let dataSource: DataSource;
  let content: ContentService;
  let workflow: WorkflowService;
  let service: SolutionService;
  let taskStates: Repository<TaskStateEntity>;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let ids: Record<string, string>;

  const manager = () => dataSource.manager;
  const phaseOf = (project: ProjectContent, key: string): PhaseContent =>
    project.phases.find((one) => one.key === key) as PhaseContent;

  const taskLike = (base: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
    ...soleTaskFor(base),
    ...over,
  });

  /** One authored task per phase, keyed `main`: what a copied project compiles to. */
  const mainTasks = (project: ProjectContent): CompiledPhaseTasks[] =>
    project.phases.map((one) => ({
      key: one.key,
      tasks: [taskLike(one, { taskKey: INHERITED_TASK_KEY })],
    }));

  /** The same, with `requirements` split into `story` (required) and `scope` (optional). */
  const splitTasks = (project: ProjectContent): CompiledPhaseTasks[] => {
    const requirements = phaseOf(project, 'requirements');
    return mainTasks(project).map((entry) =>
      entry.key !== 'requirements'
        ? entry
        : {
            key: entry.key,
            tasks: [
              taskLike(requirements, { taskKey: 'story', order: 1 }),
              taskLike(requirements, { taskKey: 'scope', order: 2, required: false }),
            ],
          },
    );
  };

  const install = (
    ...versions: { versionId: string; content: ProjectContent; phases: CompiledPhaseTasks[] }[]
  ): void => {
    content.installVersions(versions.map((one) => ({ ...one, compiler: COMPILER_IDENTITY })));
  };

  const enrol = async (): Promise<void> => {
    const view = await workflow.enroll(learner, TEACHER);
    ids = Object.fromEntries(view.phases.map((one) => [one.key, one.id]));
  };

  /** Open a phase row without touching its task rows. */
  const openPhase = (key: string, over: Partial<PhaseStateEntity> = {}): Promise<unknown> =>
    manager().update(PhaseStateEntity, ids[key], { status: 'in_progress', ...over });

  /** Put one task's row through its gate. */
  const passTask = (key: string, taskKey: string, over: Partial<TaskStateEntity> = {}): Promise<unknown> =>
    taskStates.update(
      { phaseStateId: ids[key], taskKey },
      { status: 'passed', passedAt: new Date().toISOString(), bestScore: 77, ...over },
    );

  /**
   * The revision the gate requires behind one task's pass: completed, passed,
   * both snapshots kept, and a report the strict review accepted.
   * `passTask` alone is the board half: what a teacher's Pass or Sign off
   * writes, and opens nothing by itself.
   */
  const reviewTask = (key: string, taskKey: string): Promise<unknown> =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: ids[key],
        userId: learner,
        taskKey,
        status: 'completed',
        passed: true,
        score: 90,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(soleTaskFor(phaseOf(teacher, key)).rubric),
      }),
    );

  const audits = () => manager().find(AuditEventEntity, { where: { event: 'solution.read' } });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    taskStates = dataSource.getRepository(TaskStateEntity);
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)', version: '1.0.0' };
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    content = new ContentService();
    content.loadAll();
    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
    service = new SolutionService(
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(SubmissionEntity),
      workflow,
      content,
      dataSource,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('the kept route serves a teacher-authored one-task phase, of every kind', async () => {
    install({ versionId: V_MAIN, content: teacher, phases: mainTasks(teacher) });
    await enrol();
    const implementation = phaseOf(teacher, 'implementation');
    if (implementation.checks.kind !== 'code') throw new Error('implementation is a code phase');
    await openPhase('implementation', { status: 'passed', passedAt: new Date().toISOString(), bestScore: 84 });
    await passTask('implementation', INHERITED_TASK_KEY);
    await reviewTask('implementation', INHERITED_TASK_KEY);

    // No key: the phase's ONLY task, which here is keyed `main`. With
    // `taskKey = SOLE_TASK_KEY` as the default this is a 404 "unknown task" on
    // every phase of every teacher project.
    const view = await service.read(learner, ids.implementation);
    expect(view.taskKey).toBe(INHERITED_TASK_KEY);
    expect(view.available).toBe(true);
    expect(view.files.map((file) => file.path)).toEqual(implementation.checks.editableTargets);

    // and the `tests` phase, the other kind with files behind the door
    const testing = phaseOf(teacher, 'testing');
    if (testing.checks.kind !== 'tests') throw new Error('testing is a tests phase');
    await openPhase('testing', { status: 'passed', passedAt: new Date().toISOString() });
    await passTask('testing', INHERITED_TASK_KEY);
    await reviewTask('testing', INHERITED_TASK_KEY);
    const suite = await service.read(learner, ids.testing);
    expect(suite.files.map((file) => file.path)).toEqual(testing.checks.learnerTestFiles);
  });

  it("a teacher's Pass or Sign off on a task opens nothing by itself", async () => {
    install({ versionId: V_MAIN, content: teacher, phases: mainTasks(teacher) });
    await enrol();
    // Both halves of a teacher's lever at once: the row passed AND signed off,
    // the phase passed on the board. No revision stands behind either.
    await openPhase('implementation', { status: 'passed', passedAt: new Date().toISOString(), bestScore: 70 });
    await passTask('implementation', INHERITED_TASK_KEY, { signedOffBy: 'a-teacher' } as Partial<TaskStateEntity>);

    await expect(service.read(learner, ids.implementation)).rejects.toThrow(SOLUTION_LOCKED_MESSAGE);
    expect(await audits()).toHaveLength(0);
    const row = await taskStates.findOneByOrFail({ phaseStateId: ids.implementation, taskKey: INHERITED_TASK_KEY });
    expect(row.solutionReadAt).toBeNull();

    // The learner's own strictly reviewed pass is the key, and it still works.
    await reviewTask('implementation', INHERITED_TASK_KEY);
    const view = await service.read(learner, ids.implementation);
    expect(view.available).toBe(true);
    expect(view.files.length).toBeGreaterThan(0);
  });

  it('a reviewed pass of ANOTHER task does not open this one', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol();
    await openPhase('requirements', { status: 'passed', passedAt: new Date().toISOString() });
    await passTask('requirements', 'story');
    await passTask('requirements', 'scope');
    // Only `story` was reviewed; `scope` was passed on the board.
    await reviewTask('requirements', 'story');
    await expect(service.read(learner, ids.requirements, 'scope')).rejects.toThrow(SOLUTION_LOCKED_MESSAGE);
    await expect(service.read(learner, ids.requirements, 'story')).resolves.toMatchObject({ taskKey: 'story' });
  });

  it("a sibling's answers stay locked on a passed phase", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol();
    // The phase is open (the required task passed and rolled it up) and the
    // optional task has not been done.
    await openPhase('requirements', { status: 'passed', passedAt: new Date().toISOString(), bestScore: 90 });
    await passTask('requirements', 'story');
    await reviewTask('requirements', 'story');

    await expect(service.read(learner, ids.requirements, 'scope')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.read(learner, ids.requirements, 'scope')).rejects.toThrow(
      SOLUTION_LOCKED_MESSAGE,
    );

    // The door the learner HAS passed opens, and contains nothing:
    // a written phase has no answer key, and `referenceFiles` says so in the
    // pack's own word.
    const open = await service.read(learner, ids.requirements, 'story');
    expect(open.available).toBe(false);
    expect(open.unavailableReason).toBe('prose');
    expect(open.files).toEqual([]);
    expect(open.taskKey).toBe('story');
    expect(open.taskTitle).toBe(phaseOf(teacher, 'requirements').title);
  });

  it('a task key the pinned version does not declare is 404', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol();
    await openPhase('requirements', { status: 'passed', passedAt: new Date().toISOString() });
    await passTask('requirements', 'story');
    await expect(service.read(learner, ids.requirements, 'epics')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.read(learner, ids.requirements, 'epics')).rejects.toThrow('unknown task');
  });

  it('the phase route refuses a multi-task phase by name', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: splitTasks(teacher) });
    await enrol();
    await openPhase('requirements', { status: 'passed', passedAt: new Date().toISOString() });
    await passTask('requirements', 'story');
    // Not "pick the first": picking one is how a learner's work goes to the
    // wrong grader.
    await expect(service.read(learner, ids.requirements)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const refusal = await service
      .read(learner, ids.requirements)
      .then(() => '', (err: Error) => err.message);
    expect(refusal).toContain('This phase has 2 tasks');
    expect(refusal).toContain('story');
    expect(refusal).toContain('scope');
  });

  it('the view\'s numbers are the row the gate was read from', async () => {
    install({ versionId: V_MAIN, content: teacher, phases: mainTasks(teacher) });
    await enrol();
    // A passed task on a phase that has not opened: without reading `gate` the
    // view would answer `passedAt: null` and the phase's score beside an open
    // door, a view contradicting the gate that just let the reader through.
    await openPhase('implementation', { status: 'in_progress', passedAt: null, bestScore: null });
    const at = '2026-09-18T09:00:00.000Z';
    await passTask('implementation', INHERITED_TASK_KEY, { passedAt: at, bestScore: 63 });
    await reviewTask('implementation', INHERITED_TASK_KEY);

    const view = await service.read(learner, ids.implementation);
    expect(view.passedAt).toBe(at);
    expect(view.bestScore).toBe(63);
    expect(view.available).toBe(true);
  });

  it('the first reading is recorded once, through update', async () => {
    install({ versionId: V_MAIN, content: teacher, phases: mainTasks(teacher) });
    await enrol();
    await openPhase('implementation', { status: 'passed', passedAt: new Date().toISOString() });
    await passTask('implementation', INHERITED_TASK_KEY);
    await reviewTask('implementation', INHERITED_TASK_KEY);
    const update = jest.spyOn(taskStates, 'update');
    const save = jest.spyOn(taskStates, 'save');

    const first = await service.read(learner, ids.implementation);
    const again = await service.read(learner, ids.implementation);
    expect(first.readAt).not.toBeNull();
    expect(again.readAt).toBe(first.readAt);
    expect(await audits()).toHaveLength(1);
    // The stamp lands on the TASK's row, and through `update()`: a whole-row
    // save from this path would post this request's stale copy over an
    // autosave that landed while it was in flight.
    expect(update).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    const row = await taskStates.findOneByOrFail({
      phaseStateId: ids.implementation,
      taskKey: INHERITED_TASK_KEY,
    });
    expect(row.solutionReadAt).toBe(first.readAt);
    // The phase's own column is untouched: this reading was one task's.
    const state = await manager().findOneByOrFail(PhaseStateEntity, { id: ids.implementation });
    expect(state.solutionReadAt).toBeNull();
    expect((await audits())[0].detail).toMatchObject({ taskKey: INHERITED_TASK_KEY });
    expect((await audits())[0].action).toBe('implementation');
  });
});

import 'reflect-metadata';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { EMPTY_STORY, serialiseStory } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent, StoryChecks } from '../content/content.types';
import { writtenPhase } from '../../test/quiz-fixture';
import {
  COMPILER_IDENTITY,
  compilePack,
  editablePathsOf,
  gradedUnitsOf,
  soleTaskFor,
  type AuthoredTask,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskResetEntity,
  TaskStateEntity,
} from '../db/entities';
import { AgentProposalEntity } from '../assistant/agent-proposal.entity';
import { AgentTurnEntity } from '../assistant/agent-turn.entity';
import { AgenticService, workspaceHash } from '../assistant/agentic.service';
import * as understanding from '../assistant/explanation-assessment';
import type { FeedbackService } from '../feedback/feedback.service';
import * as learnerReset from './learner-reset';
import { RESET_REFUSALS } from './learner-reset';
import { WorkflowService } from './workflow.service';
import { legacyDesignPhase } from '../../test/legacy-design-phase';

/**
 * The learner's "Start this task over", one test per rule, and every refusal,
 * on a real sqlite schema. Plus another tab's versioned save after a reset (a
 * 409 that writes nothing) and the reset stamping the task's NULL-epoch
 * revisions with the run it ends.
 */
const SHIPPED = 'tasktrackr';
const TEACHER = 'ms-tan-reset';
const V_FLAT = 'v-flat';
const V_TEACHER = 'v-teacher';

describe('the learner reset', () => {
  let dataSource: DataSource;
  let enrollments: Repository<EnrollmentEntity>;
  let phaseStates: Repository<PhaseStateEntity>;
  let submissions: Repository<SubmissionEntity>;
  let taskStates: Repository<TaskStateEntity>;
  let content: ContentService;
  let workflow: WorkflowService;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  /**
   * The written phase split in two: Design as a story phase holding TaskTrackr
   * 3.0.0's two editable design documents (`legacyDesignPhase`'s files) beside
   * a record of its own, so the reset rules have two paths to divide between
   * two written tasks. No door authors a second written task any more; the
   * runtime still serves and resets a phase whose tasks are all written.
   */
  let written: PhaseContent;
  let E0: string;
  let E1: string;
  const learner = 'learner-reset';

  const inherited = (project: ProjectContent): Record<string, AuthoredTask[]> =>
    Object.fromEntries(
      project.phases.map((phase) => [
        phase.key,
        [{ taskKey: 'main', order: 1, owns: editablePathsOf(phase), gradedUnits: gradedUnitsOf(phase) }],
      ]),
    );

  const taskLike = (over: Partial<CompiledTask>): CompiledTask => ({ ...soleTaskFor(written), ...over });

  /** Design split as given; every other phase its inherited `main`. */
  const install = (split: CompiledTask[]): void => installAt('design', split);
  /** One phase split as given; every other phase its inherited `main`. */
  const installAt = (key: string, split: CompiledTask[]): void => {
    const main = compilePack(teacher, { authored: inherited(teacher) }).phases;
    const phases: CompiledPhaseTasks[] = main.map((entry) =>
      entry.key === key ? { key: entry.key, tasks: split } : entry,
    );
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: V_FLAT,
        content: shipped,
        compiler: COMPILER_IDENTITY,
        phases: shipped.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] })),
      },
      { versionId: V_TEACHER, content: teacher, compiler: COMPILER_IDENTITY, phases },
    ]);
    workflow = new WorkflowService(
      enrollments,
      phaseStates,
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
  };

  /** Exclusive: `story` owns E0, `scope` owns E1. */
  const exclusive = () => [
    taskLike({ taskKey: 'story', order: 1, title: 'The story', owns: [E0] }),
    taskLike({ taskKey: 'scope', order: 2, title: 'The scope note', owns: [E1] }),
  ];
  /** Shared: `story` owns E0 and E1, `scope` owns E1. */
  const shared = () => [
    taskLike({ taskKey: 'story', order: 1, title: 'The story', owns: [E0, E1] }),
    taskLike({ taskKey: 'scope', order: 2, title: 'The scope note', owns: [E1] }),
  ];

  const enrol = async (slug = TEACHER): Promise<Record<string, string>> => {
    const view = await workflow.enroll(learner, slug);
    const ids: Record<string, string> = Object.fromEntries(view.phases.map((phase) => [phase.key, phase.id]));
    // Design opens as though Requirements had passed: the split phase is the one the learner is in
    await phaseStates.update(ids.requirements, { status: 'passed', passedAt: new Date().toISOString() });
    await phaseStates.update(ids.design, { status: 'in_progress', unlockedAt: new Date().toISOString() });
    await enrollments.update({ id: view.id }, { currentPhaseOrder: 2 });
    return ids;
  };
  const row = (phaseStateId: string, taskKey: string) =>
    taskStates.findOneByOrFail({ phaseStateId, taskKey });
  const phaseRow = (id: string) => phaseStates.findOneByOrFail({ id });
  const version = async (id: string) => (await phaseRow(id)).workspaceUpdatedAt ?? null;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    enrollments = dataSource.getRepository(EnrollmentEntity);
    phaseStates = dataSource.getRepository(PhaseStateEntity);
    submissions = dataSource.getRepository(SubmissionEntity);
    taskStates = dataSource.getRepository(TaskStateEntity);
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject(SHIPPED);
    // a copy whose Design is a written phase over two editable documents (see `written`)
    const storyOver = (phase: PhaseContent): PhaseContent => {
      const documents = legacyDesignPhase(phase);
      const record = 'design/story.json';
      return {
        ...documents,
        artifactKind: 'story',
        checks: { ...(writtenPhase().checks as StoryChecks), record },
        // the record last, so the two documents stay the first two editable paths
        files: [...documents.files, { path: record, content: serialiseStory(EMPTY_STORY), editable: true, language: 'json' }],
      };
    };
    teacher = {
      ...shipped,
      slug: TEACHER,
      title: 'TaskTrackr (Ms Reset)',
      version: '1.0.0',
      phases: shipped.phases.map((phase) => (phase.key === 'design' ? storyOver(phase) : phase)),
    };
    written = teacher.phases.find((phase) => phase.key === 'design')!;
    [E0, E1] = editablePathsOf(written);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await dataSource.manager.clear(entity);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('has two editable design paths to split (fixture guard)', () => {
    expect(E0).toBeTruthy();
    expect(E1).toBeTruthy();
    expect(E0).not.toBe(E1);
  });

  it('deletes the exclusively owned path, bumps the version and records the copy; keeps the rest', async () => {
    install(exclusive());
    const ids = await enrol();
    const saved = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words', [E1]: 'scope words' });
    await taskStates.update({ phaseStateId: ids.design, taskKey: 'story' }, {
      status: 'submitted', bestScore: 40, attempts: 2, ranBeforeSubmit: true,
    });
    await phaseStates.update(ids.design, { attempts: 3, bestScore: 40, reflection: 'mine' });
    await submissions.save(submissions.create({
      phaseStateId: ids.design, userId: learner, taskKey: 'story', status: 'completed', passed: false,
    }));

    const plan = await workflow.planTaskReset(learner, ids.design, 'story');
    expect(plan).toEqual({ restores: [E0], reseeds: [], protectedBy: [], dropsPendingProposal: false, refusal: null, retry: null });

    const result = await workflow.resetTask(learner, ids.design, 'story', saved.version);

    expect(result.workspace).toEqual({ [E1]: 'scope words' });
    expect(result.version).not.toBe(saved.version);
    expect(result.version > saved.version).toBe(true);
    expect(await version(ids.design)).toBe(result.version);
    expect(result.task.key).toBe('story');
    const after = await row(ids.design, 'story');
    expect([after.status, after.bestScore, after.attempts, after.resetCount, after.ranBeforeSubmit]).toEqual([
      'submitted', 40, 2, 1, false,
    ]);
    expect(after.resetAt).toEqual(expect.any(String));
    expect((await row(ids.design, 'scope')).resetCount).toBe(0);
    const phase = await phaseRow(ids.design);
    expect([phase.attempts, phase.bestScore, phase.reflection, phase.passedAt]).toEqual([3, 40, 'mine', null]);
    expect(await submissions.count({ where: { phaseStateId: ids.design } })).toBe(1);
    const copies = await dataSource.manager.find(TaskResetEntity);
    expect(copies.map((copy) => [copy.taskStateId, copy.userId, copy.files])).toEqual([
      [after.id, learner, { [E0]: 'story words' }],
    ]);
    // a UUIDv7: the prune's tiebreaker is total
    expect(copies[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('writes no copy when the deleted paths held no bytes of the learner\'s', async () => {
    install(exclusive());
    const ids = await enrol();
    await workflow.resetTask(learner, ids.design, 'story', await version(ids.design));
    expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
    expect((await row(ids.design, 'story')).resetCount).toBe(1);
  });

  it('keeps a shared path a passed sibling holds, and names that sibling', async () => {
    install(shared());
    const ids = await enrol();
    const saved = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words', [E1]: 'shared words' });
    await taskStates.update({ phaseStateId: ids.design, taskKey: 'scope' }, { status: 'passed' });

    const plan = await workflow.planTaskReset(learner, ids.design, 'story');
    expect(plan.restores).toEqual([E0]);
    expect(plan.protectedBy).toEqual([{ path: E1, siblingTitle: 'The scope note' }]);

    const result = await workflow.resetTask(learner, ids.design, 'story', saved.version);
    expect(result.workspace).toEqual({ [E1]: 'shared words' });
  });

  it('deletes a shared path no passed sibling holds', async () => {
    install(shared());
    const ids = await enrol();
    const saved = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'a', [E1]: 'b' });
    const result = await workflow.resetTask(learner, ids.design, 'story', saved.version);
    expect(result.workspace).toEqual({});
  });

  it('leaves links, drill and ranBeforeSubmit alone on a split written phase', async () => {
    install(exclusive());
    const ids = await enrol();
    const links = [{ from: 'US-4', to: 'AC-1', kind: 'covers', at: '2026-09-30T00:00:00.000Z' }];
    await phaseStates.update(ids.design, { links: links as never, ranBeforeSubmit: true });
    await workflow.resetTask(learner, ids.design, 'story', await version(ids.design));
    const phase = await phaseRow(ids.design);
    expect(phase.links).toEqual(links);
    expect(phase.ranBeforeSubmit).toBe(true);
  });

  it('re-seeds a server-seeded path and clears the phase\'s run facts when the task owns them', async () => {
    install(exclusive());
    const ids = await enrol();
    const maintenance = teacher.phases.find((phase) => phase.key === 'maintenance')!;
    const contracts = maintenance.files.find((file) => file.editable && /contracts\.json$/.test(file.path))!;
    const design = teacher.phases.find((phase) => phase.key === 'design')!;
    const designJson = design.files.find((file) => /design\.json$/.test(file.path))!;
    const operations = [{ name: 'list_overdue', method: 'GET', path: '/tasks/overdue', returns: 'Task[]' }];
    await phaseStates.update(ids.design, { workspace: { [designJson.path]: JSON.stringify({ operations }) } });
    await phaseStates.update(ids.maintenance, {
      status: 'in_progress',
      workspace: { [contracts.path]: '{"operations": ["mine"]}' },
      links: [{ from: 'x', to: 'y', kind: 'covers', at: '2026-09-30T00:00:00.000Z' }] as never,
      drill: { step: 1 } as never,
      ranBeforeSubmit: true,
    });
    const plan = await workflow.planTaskReset(learner, ids.maintenance, 'main');
    expect(plan.reseeds).toEqual([contracts.path]);
    expect(plan.restores).not.toContain(contracts.path);

    const result = await workflow.resetTask(learner, ids.maintenance, 'main', null);

    expect(result.workspace[contracts.path]).toBeDefined();
    expect(result.workspace[contracts.path]).not.toContain('mine');
    expect(JSON.parse(result.workspace[contracts.path]).operations.length).toBeGreaterThan(0);
    const phase = await phaseRow(ids.maintenance);
    expect([phase.links, phase.drill, phase.ranBeforeSubmit]).toEqual([null, null, false]);
  });

  it('stamps the task\'s NULL-epoch revisions with the run that ends, and no sibling\'s', async () => {
    install(exclusive());
    const ids = await enrol();
    for (const taskKey of ['story', 'scope']) {
      await submissions.save(submissions.create({
        phaseStateId: ids.design, userId: learner, taskKey, status: 'completed', passed: true,
      }));
    }
    await workflow.resetTask(learner, ids.design, 'story', await version(ids.design));
    const byKey = async (taskKey: string) =>
      (await submissions.find({ where: { phaseStateId: ids.design, taskKey } })).map((one) => one.resetEpoch);
    expect(await byKey('story')).toEqual([0]);
    expect(await byKey('scope')).toEqual([null]);
  });

  describe('refusals, each one sentence, nothing written', () => {
    const unchanged = async (id: string, key: string) => {
      expect((await row(id, key)).resetCount).toBe(0);
      expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
    };

    it('a locked phase', async () => {
      install(exclusive());
      const ids = await enrol();
      // Implementation is still locked (Design, the split phase, is the one open)
      await expect(workflow.resetTask(learner, ids.implementation, 'main', null)).rejects.toThrow();
      expect((await row(ids.implementation, 'main')).resetCount).toBe(0);
    });

    it('a sole-task (TaskTrackr) phase', async () => {
      install(exclusive());
      const ids = await enrol(SHIPPED);
      const plan = await workflow.planTaskReset(learner, ids.design, '');
      expect(plan.refusal).toBe(RESET_REFUSALS.soleTask);
      await expect(workflow.resetTask(learner, ids.design, '', null)).rejects.toThrow(RESET_REFUSALS.soleTask);
      expect(await taskStates.count()).toBe(0);
    });

    it('an unknown key', async () => {
      install(exclusive());
      const ids = await enrol();
      await expect(workflow.resetTask(learner, ids.design, 'nope', null)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a quiz', async () => {
      install([
        ...exclusive(),
        taskLike({ taskKey: 'concepts', order: 3, required: false, checkKind: 'quiz', artefactType: 'quiz' as never, owns: [] }),
      ]);
      const ids = await enrol();
      await expect(workflow.resetTask(learner, ids.design, 'concepts', null)).rejects.toThrow(RESET_REFUSALS.quiz);
      await unchanged(ids.design, 'concepts');
    });

    it('a passed task is not refused: it is a retry (learner-retry.spec.ts)', async () => {
      install(exclusive());
      const ids = await enrol();
      await taskStates.update({ phaseStateId: ids.design, taskKey: 'story' }, { status: 'passed' });
      const plan = await workflow.planTaskReset(learner, ids.design, 'story');
      expect(plan.refusal).toBeNull();
      expect(plan.retry).toMatchObject({ wholePhase: false });
    });

    it('a task awaiting the teacher\'s sign-off (6b)', async () => {
      install(exclusive());
      const ids = await enrol();
      await taskStates.update({ phaseStateId: ids.design, taskKey: 'story' }, { awaitingSignOff: true, status: 'submitted' });
      await expect(workflow.resetTask(learner, ids.design, 'story', null)).rejects.toThrow(RESET_REFUSALS.awaitingSignOff);
      await unchanged(ids.design, 'story');
    });

    it('a submission of this task still being checked', async () => {
      install(exclusive());
      const ids = await enrol();
      await submissions.save(submissions.create({ phaseStateId: ids.design, userId: learner, taskKey: 'story', status: 'queued' }));
      await expect(workflow.resetTask(learner, ids.design, 'story', null)).rejects.toThrow(RESET_REFUSALS.submissionInFlight);
      await unchanged(ids.design, 'story');
      // a sibling's does not hold it
      await expect(workflow.planTaskReset(learner, ids.design, 'scope')).resolves.toMatchObject({ refusal: null });
    });

    it('a run still going, when the task owns the phase\'s execution', async () => {
      install(exclusive());
      const ids = await enrol();
      await phaseStates.update(ids.implementation, { status: 'in_progress' });
      await dataSource.manager.save(dataSource.manager.create(ExecutionRunEntity, {
        phaseStateId: ids.implementation, userId: learner, kind: 'run', status: 'running',
      } as never));
      await expect(workflow.resetTask(learner, ids.implementation, 'main', null)).rejects.toThrow(RESET_REFUSALS.runInFlight);
      expect((await row(ids.implementation, 'main')).resetCount).toBe(0);
    });

    it('a stale baseVersion: 409 workspace_changed, nothing written', async () => {
      install(exclusive());
      const ids = await enrol();
      const first = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'one' });
      await workflow.saveWorkspace(learner, ids.design, { [E0]: 'two' }, first.version);
      const refused = workflow.resetTask(learner, ids.design, 'story', first.version);
      await expect(refused).rejects.toBeInstanceOf(ConflictException);
      await expect(workflow.resetTask(learner, ids.design, 'story', first.version)).rejects.toMatchObject({
        response: expect.objectContaining({ error: 'workspace_changed' }),
      });
      expect((await phaseRow(ids.design)).workspace).toEqual({ [E0]: 'two' });
      await unchanged(ids.design, 'story');
    });
  });

  it('another tab\'s versioned save after a reset is a 409 that writes nothing', async () => {
    install(exclusive());
    const ids = await enrol();
    const tab = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'before' });
    await workflow.resetTask(learner, ids.design, 'story', tab.version);
    await expect(
      workflow.saveWorkspace(learner, ids.design, { [E0]: 'resurrected' }, tab.version),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await phaseRow(ids.design)).workspace).toEqual({});
  });

  it('an autosave that lands between the reset\'s read and its write loses it nothing: 409, nothing written', async () => {
    install(exclusive());
    const ids = await enrol();
    const saved = await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words' });
    const real = learnerReset.writeReset;
    // Another tab's autosave (saveWorkspace takes no enrolment lock) commits
    // after the reset read the row and checked baseVersion, before its swap.
    jest.spyOn(learnerReset, 'writeReset').mockImplementation(async (manager, held, ...rest) => {
      await manager.update(PhaseStateEntity, { id: held.id }, {
        workspace: { [E0]: 'autosaved in between' },
        workspaceUpdatedAt: new Date(Date.parse(saved.version) + 5000).toISOString(),
      });
      return real(manager, held, ...rest);
    });
    await expect(workflow.resetTask(learner, ids.design, 'story', saved.version)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'workspace_changed' }),
    });
    const after = await row(ids.design, 'story');
    expect([after.resetCount, after.resetAt]).toEqual([0, null]);
    expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
  });

  it('says a pending Agentic proposal on the phase is dropped', async () => {
    install(exclusive());
    const ids = await enrol();
    await dataSource.manager.save(dataSource.manager.create(AgentProposalEntity, {
      userId: learner, phaseStateId: ids.design, prompt: 'p', files: {}, proposalHash: 'h',
      baseWorkspaceHash: 'b', assessment: {} as never,
    }));
    expect((await workflow.planTaskReset(learner, ids.design, 'scope')).dropsPendingProposal).toBe(true);
  });

  /**
   * A guard: the plan's `dropsPendingProposal` sentence rests on the Agentic apply being
   * bound to the hash of the phase's editable files. An approved proposal
   * made before a learner reset meets a 409 on apply, and nothing is written.
   */
  it('an Agentic proposal approved before a reset is refused on apply, writing nothing', async () => {
    install(exclusive());
    const ids = await enrol();
    await workflow.saveWorkspace(learner, ids.design, { [E0]: 'story words', [E1]: 'scope words' });
    const agentic = new AgenticService(
      dataSource.getRepository(AgentProposalEntity),
      workflow,
      {} as never,
      {} as never,
      dataSource,
      dataSource.getRepository(ExecutionRunEntity),
      content,
    );
    void AgentTurnEntity;
    const { currentWorkspaceHash } = await agentic.turns(learner, ids.design);
    const files = { [E0]: 'the proposal\'s words' };
    const proposal = await dataSource.manager.save(dataSource.manager.create(AgentProposalEntity, {
      userId: learner, phaseStateId: ids.design, prompt: 'p', files,
      proposalHash: workspaceHash(files), baseWorkspaceHash: currentWorkspaceHash,
      assessment: { adequate: true, feedback: 'ok', questions: [] } as never,
      explanation: 'mine', explanationAssessment: {} as never, approvedAt: '2026-09-30T00:00:00.000Z',
    }));
    jest.spyOn(understanding, 'hasGroundedUnderstanding').mockReturnValue(true);

    const plan = await workflow.planTaskReset(learner, ids.design, 'story');
    expect(plan.dropsPendingProposal).toBe(true);
    await workflow.resetTask(learner, ids.design, 'story', await version(ids.design));
    const afterReset = await phaseRow(ids.design);

    await expect(
      agentic.apply(learner, ids.design, proposal.id, workspaceHash(files)),
    ).rejects.toBeInstanceOf(ConflictException);
    const after = await phaseRow(ids.design);
    expect([after.workspace, after.workspaceUpdatedAt]).toEqual([afterReset.workspace, afterReset.workspaceUpdatedAt]);
    expect((await dataSource.manager.findOneByOrFail(AgentProposalEntity, { id: proposal.id })).appliedAt).toBeNull();
  });

  describe('a story task beside a concept quiz (Requirements)', () => {
    /** Requirements as a teacher authors it: the story task, which owns the record and no artefact path, and a quiz. */
    const storyBesideQuiz = (): CompiledTask[] => {
      const requirements = teacher.phases.find((phase) => phase.key === 'requirements')!;
      const sole = soleTaskFor(requirements);
      return [
        { ...sole, taskKey: 'story', order: 1, title: 'Your story', artefactPath: null },
        { ...sole, taskKey: 'concepts', order: 2, required: false, checkKind: 'quiz', artefactType: 'quiz' as never, artefactPath: null, owns: [], gradedUnits: [] },
      ];
    };
    // As the room writes it: the save stores the record as validated (`serialiseStory`).
    const record = serialiseStory({ id: 'US-4', title: 'Overdue report', persona: 'lead', capability: 'a report', benefit: 'I chase it', criteria: [], scopeExclusions: [], notes: '' });

    it('the story task owns the record, which is the one editable Requirements path (fixture guard)', () => {
      const [story] = storyBesideQuiz();
      expect(story.checkKind).toBe('story');
      expect(story.owns).toEqual(['requirements/story.json']);
    });

    it('starts the story over: the record leaves the workspace, its copy is kept, and the quiz is not touched', async () => {
      installAt('requirements', storyBesideQuiz());
      const view = await workflow.enroll(learner, TEACHER);
      const id = view.phases.find((phase) => phase.key === 'requirements')!.id;
      const saved = await workflow.saveWorkspace(learner, id, { 'requirements/story.json': record });

      const plan = await workflow.planTaskReset(learner, id, 'story');
      expect(plan.refusal).toBeNull();
      expect(plan.restores).toEqual(['requirements/story.json']);
      const result = await workflow.resetTask(learner, id, 'story', saved.version);

      expect(result.workspace).toEqual({});
      expect((await row(id, 'story')).resetCount).toBe(1);
      const copies = await dataSource.manager.find(TaskResetEntity);
      expect(copies.map((copy) => copy.files)).toEqual([{ 'requirements/story.json': record }]);
      await expect(workflow.resetTask(learner, id, 'concepts', null)).rejects.toThrow(RESET_REFUSALS.quiz);
      expect((await row(id, 'concepts')).resetCount).toBe(0);
    });

    it('a sole story task (TaskTrackr\'s Requirements) is refused, nothing written', async () => {
      installAt('requirements', storyBesideQuiz());
      const view = await workflow.enroll(learner, SHIPPED);
      const id = view.phases.find((phase) => phase.key === 'requirements')!.id;
      expect((await workflow.planTaskReset(learner, id, '')).refusal).toBe(RESET_REFUSALS.soleTask);
      await expect(workflow.resetTask(learner, id, '', null)).rejects.toThrow(RESET_REFUSALS.soleTask);
      expect(await dataSource.manager.count(TaskResetEntity)).toBe(0);
    });
  });

  it('answers projectIsDefault from the project row, never the slug', async () => {
    install(exclusive());
    await enrol();
    const view = await workflow.enrollmentView(await enrollments.findOneByOrFail({ userId: learner, projectSlug: TEACHER }));
    expect(view.projectIsDefault).toBe(false);
  });
});

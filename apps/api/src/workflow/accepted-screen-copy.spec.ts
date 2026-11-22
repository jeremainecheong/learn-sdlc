import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import type { AcceptedScreenCopy, FeedbackReport } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, ReleaseRecordEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  editablePathsOf,
  soleTaskFor,
  type CompiledPhaseTasks,
  type CompiledTask,
} from '../content/pack-compiler';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH, screenCopyFromSnapshot, withScreenCopy } from '../content/screen-copy';
import { acceptedDesignScreenCopy, requireAcceptedDesignScreenCopy, resolveScreenCopy } from './accepted-screen-copy';
import { WorkflowService } from './workflow.service';
import { stampEndingRun } from './reset-epoch';
import { FeedbackService } from '../feedback/feedback.service';

// These are explicit mocked semantic verdicts testing storage/gate authority.
// Real-provider quality and the normal gated journey are separate verification.
describe('accepted Design screen-copy handoff', () => {
  let db: DataSource;
  let content: ContentService;
  let workflow: WorkflowService;
  let enrollment: EnrollmentEntity;
  let states: PhaseStateEntity[];
  const phase = (key: string) => states.find(state => state.phaseKey === key)!;
  const snapshot = (title = 'Late work', empty = 'Nothing is overdue. You are all caught up.') => ({
    [SCREEN_CONTRACT_PATH]: JSON.stringify({ screens: [{ route: '#/overdue', title, empty }] }),
  });
  async function pass(key = 'design', overrides: Partial<SubmissionEntity> = {}) {
    const state = phase(key);
    const rubric = content.getPhase('tasktrackr', state.phaseKey).rubric;
    await db.manager.update(PhaseStateEntity, state.id, { status: 'passed' });
    return db.manager.save(SubmissionEntity, db.manager.create(SubmissionEntity, {
      id: randomUUID(), phaseStateId: state.id, userId: enrollment.userId,
      status: 'completed', passed: true, createdAt: new Date('2026-09-01T10:00:00Z'),
      workspaceSnapshot: snapshot(), contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
      report: {
        assessmentMode: 'strict_binary', passed: true,
        checks: [{ id: 'fixture', label: 'Mocked authority fixture', status: 'passed', detail: 'Only database authority is under test.' }],
        tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
        aiReview: { provider: 'mock-ai', verdict: 'pass', criteriaEvidence: rubric.criteria.map(c => ({ key: c.key, met: true, evidence: 'Mocked criterion authority.', issue: '', nextStep: '' })) },
      } as unknown as FeedbackReport,
      ...overrides,
    }));
  }
  beforeAll(async () => {
    db = await memoryDataSource();
    content = new ContentService(); content.loadAll();
    workflow = new WorkflowService(db.getRepository(EnrollmentEntity), db.getRepository(PhaseStateEntity), db.getRepository(ReleaseRecordEntity), content, { latestFor: async () => null } as unknown as FeedbackService, db);
  });
  afterAll(async () => { await db.destroy(); });
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await db.manager.clear(entity);
    await workflow.enroll('screen-copy-learner', 'tasktrackr');
    enrollment = await db.manager.findOneByOrFail(EnrollmentEntity, { userId: 'screen-copy-learner' });
    states = await db.manager.find(PhaseStateEntity, { where: { enrollmentId: enrollment.id } });
  });

  // Asserted FIRST, because it is the
  // assertion that fails the moment the owner lookup names the wrong path.
  it("TaskTrackr's design advance still writes the same accepted screen copy", async () => {
    const accepted = await pass();
    const copy = await acceptedDesignScreenCopy(db.manager, content, enrollment);
    expect(copy).toMatchObject({
      sourceSubmissionId: accepted.id,
      sourcePhaseStateId: phase('design').id,
      title: 'Late work',
      empty: 'Nothing is overdue. You are all caught up.',
    });
    // The owner is looked up on SCREEN_CONTRACT_PATH (the editable file the
    // design phase declares and `screenCopyFromSnapshot` parses) and never on
    // SCREEN_COPY_PATH, the read-only overlay the *later* phases mount, which
    // no task's `owns` can ever contain because `owns` is built from
    // `editablePathsOf`. With the wrong constant `owners` is permanently empty,
    // `requireAcceptedDesignScreenCopy` throws inside `advance`'s transaction on
    // every design → implementation advance including this one, and
    // `resolveScreenCopy` answers null for every later phase, silently.
    const design = content.getPhaseForEnrollment(enrollment, 'design');
    expect(content.getTasksForEnrollment(enrollment, 'design')[0].owns).toContain(SCREEN_CONTRACT_PATH);
    expect(editablePathsOf(design)).not.toContain(SCREEN_COPY_PATH);

    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 2 });
    await workflow.advance(enrollment.userId, phase('design').id);
    const detail = await workflow.phaseDetail(enrollment.userId, phase('implementation').id);
    expect(detail.acceptedScreenCopy).toEqual(copy);
  });

  it('pins the passing snapshot at advancement, ignoring unsent Design edits, and propagates it through all later phases', async () => {
    const accepted = await pass();
    await db.manager.update(PhaseStateEntity, phase('design').id, { workspace: snapshot('UNSUBMITTED TITLE', 'UNSUBMITTED EMPTY') });
    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 2 });
    await workflow.advance(enrollment.userId, phase('design').id);
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance']) {
      const detail = await workflow.phaseDetail(enrollment.userId, phase(key).id);
      expect(detail.acceptedScreenCopy).toMatchObject({ sourceSubmissionId: accepted.id, sourcePhaseStateId: phase('design').id, title: 'Late work', empty: 'Nothing is overdue. You are all caught up.' });
      expect(JSON.parse(detail.files.find(file => file.path === SCREEN_COPY_PATH)!.content)).toMatchObject({ source: 'accepted-design', ...detail.acceptedScreenCopy });
      expect(detail.files.find(file => file.path === SCREEN_COPY_PATH)!.editable).toBe(false);
      if (key !== 'maintenance') { await pass(key); await workflow.advance(enrollment.userId, phase(key).id); }
    }
  });

  it('rejects a Design pass without a retained complete screen contract at the gate', async () => {
    await pass('design', { workspaceSnapshot: snapshot('Late work', '') });
    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 2 });
    await expect(workflow.advance(enrollment.userId, phase('design').id)).rejects.toThrow('screen title and empty-state sentence');
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: phase('implementation').id })).status).toBe('locked');
  });

  it.each(['failed verdict', 'missing snapshot', 'missing context', 'malformed assessment', 'wrong owner'] as const)('does not accept %s', async kind => {
    const overrides: Partial<SubmissionEntity> = kind === 'failed verdict' ? { passed: false }
      : kind === 'missing snapshot' ? { workspaceSnapshot: null }
      : kind === 'missing context' ? { contextSnapshot: null }
      : kind === 'malformed assessment' ? { report: { assessmentMode: 'strict_binary', passed: true } as FeedbackReport }
      : { userId: 'another-learner' };
    await pass('design', overrides);
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow('passing Design submission');
  });

  it('lazily selects only a pass before the original Implementation unlock and preserves that choice across edits and requests', async () => {
    const old = await pass();
    await pass('design', { createdAt: new Date('2026-09-03T10:00:00Z'), workspaceSnapshot: snapshot('Future title', 'Future text') });
    await db.manager.update(PhaseStateEntity, phase('implementation').id, { status: 'in_progress', unlockedAt: '2026-09-02T10:00:00Z' });
    const state = await db.manager.findOneByOrFail(PhaseStateEntity, { id: phase('implementation').id });
    const copies = await Promise.all([resolveScreenCopy(db.manager, content, enrollment, state), resolveScreenCopy(db.manager, content, enrollment, { ...state })]);
    expect(copies[0]?.sourceSubmissionId).toBe(old.id);
    expect(copies[1]).toEqual(copies[0]);
    await db.manager.update(PhaseStateEntity, phase('design').id, { workspace: snapshot('Edited again', 'Edited again') });
    expect((await workflow.phaseDetail(enrollment.userId, state.id)).acceptedScreenCopy).toEqual(copies[0]);
  });

  it('a first Maintenance visit pins the same original Implementation source, never its later unlock cutoff', async () => {
    const old = await pass();
    await pass('design', { createdAt: new Date('2026-09-03T10:00:00Z'), workspaceSnapshot: snapshot('Future title', 'Future text') });
    await db.manager.update(PhaseStateEntity, phase('implementation').id, { status: 'passed', unlockedAt: '2026-09-02T10:00:00Z' });
    await db.manager.update(PhaseStateEntity, phase('maintenance').id, { status: 'in_progress', unlockedAt: '2026-09-04T10:00:00Z' });
    const detail = await workflow.phaseDetail(enrollment.userId, phase('maintenance').id);
    expect(detail.acceptedScreenCopy?.sourceSubmissionId).toBe(old.id);
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: phase('implementation').id })).acceptedScreenCopy).toEqual(detail.acceptedScreenCopy);
  });

  it('uses explicitly labelled reference content if no historical source/cutoff exists, and refuses client writes to it', async () => {
    await pass();
    await db.manager.update(PhaseStateEntity, phase('implementation').id, { status: 'in_progress', unlockedAt: null });
    const detail = await workflow.phaseDetail(enrollment.userId, phase('implementation').id);
    expect(detail.acceptedScreenCopy).toBeNull();
    expect(JSON.parse(detail.files.find(file => file.path === SCREEN_COPY_PATH)!.content)).toMatchObject({ source: 'reference', sourceSubmissionId: null });
    await expect(workflow.saveWorkspace(enrollment.userId, phase('implementation').id, { [SCREEN_COPY_PATH]: JSON.stringify({ title: 'forged' }) })).rejects.toThrow();
    await expect(workflow.phaseDetail('another-learner', phase('implementation').id)).rejects.toThrow('not your phase');
  });

  it('uses identical readonly JSON in all effective file/run maps and never changes the cached pack', async () => {
    const accepted = await pass();
    const copy = (await acceptedDesignScreenCopy(db.manager, content, enrollment))!;
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
      const base = content.getPhase('tasktrackr', key);
      const effective = withScreenCopy(base, copy);
      const files = content.executionFiles(effective, { [SCREEN_COPY_PATH]: 'FORGED CLIENT COPY' });
      expect(JSON.parse(files[SCREEN_COPY_PATH]).sourceSubmissionId).toBe(accepted.id);
      expect(content.workspaceFiles(effective, {}) .find(file => file.path === SCREEN_COPY_PATH)!.content).toBe(files[SCREEN_COPY_PATH]);
      expect(JSON.parse(content.executionFiles(base, {})[SCREEN_COPY_PATH]).source).toBe('reference');
      if (files[SCREEN_CONTRACT_PATH]) expect(JSON.parse(files[SCREEN_CONTRACT_PATH]).screens.find((screen: { route: string }) => screen.route === '#/overdue')).toMatchObject({ title: copy.title, empty: copy.empty });
      if (effective.checks.kind === 'tests') expect(effective.checks.runs.find(run => run.id === 'web')!.supportFiles[SCREEN_COPY_PATH]).toBe(files[SCREEN_COPY_PATH]);
    }
  });

  it('retains the exact copy on enqueue and exports it, while a historical submission without this context stays unpinned', async () => {
    const accepted = await pass();
    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 2 });
    await workflow.advance(enrollment.userId, phase('design').id);
    const held = await workflow.loadOwnedState(enrollment.userId, phase('implementation').id);
    const service = new FeedbackService(
      db.getRepository(SubmissionEntity), db.getRepository(PhaseStateEntity), db.getRepository(EnrollmentEntity),
      {} as any, content, {} as any, {} as any, {} as any,
      { enqueue: jest.fn(), durable: false } as any,
      { emitJob: jest.fn() } as any, { onVerdict: jest.fn(async () => undefined) } as any,
    );
    const queued = await service.submit(held.phase, held.state);
    const original = await db.manager.findOneByOrFail(SubmissionEntity, { id: queued.id });
    expect(original.contextSnapshot?.acceptedScreenCopy?.sourceSubmissionId).toBe(accepted.id);
    expect(original.workspaceSnapshot).not.toHaveProperty(SCREEN_COPY_PATH);
    await db.manager.update(PhaseStateEntity, held.state.id, {
      acceptedScreenCopy: { ...held.state.acceptedScreenCopy!, title: 'A later server state must not affect queued evidence' },
      workspace: { 'api/repository/tasks.py': 'later unsent edit' },
    });
    const grading = jest.spyOn(service, 'buildReport').mockResolvedValue({ overall: 0, passed: false, assessmentMode: 'strict_binary' } as FeedbackReport);
    await service.processSubmission({ id: queued.id });
    expect(grading.mock.calls[0][1].acceptedScreenCopy).toEqual(original.contextSnapshot!.acceptedScreenCopy);
    expect(grading.mock.calls[0][1].workspace).toEqual(original.workspaceSnapshot);
    expect((await service.getSubmission(queued.id, enrollment.userId, { snapshot: true })).acceptedScreenCopy).toEqual(original.contextSnapshot!.acceptedScreenCopy);
    const legacy = await db.manager.save(SubmissionEntity, db.manager.create(SubmissionEntity, {
      id: randomUUID(), phaseStateId: held.state.id, userId: enrollment.userId, status: 'queued',
      workspaceSnapshot: original.workspaceSnapshot,
      contextSnapshot: { links: [], ranBeforeSubmit: false, drill: null },
    }));
    await service.processSubmission({ id: legacy.id });
    expect(grading.mock.calls[1][1].acceptedScreenCopy).toBeNull();
    expect((await service.getSubmission(legacy.id, enrollment.userId, { snapshot: true })).acceptedScreenCopy).toBeNull();
  });

  it('retains exact text including markup-like characters and rejects ambiguous/invalid screen records', () => {
    const record = snapshot('<strong>Late tasks</strong>', '<img src=x onerror=alert(1)> Nothing is overdue.');
    expect(screenCopyFromSnapshot(record, 'submission', 'phase')).toMatchObject({ title: '<strong>Late tasks</strong>', empty: '<img src=x onerror=alert(1)> Nothing is overdue.' });
    expect(screenCopyFromSnapshot({ [SCREEN_CONTRACT_PATH]: '{broken' }, 'submission', 'phase')).toBeNull();
    expect(screenCopyFromSnapshot(snapshot('x'.repeat(241)), 'submission', 'phase')).toBeNull();
    const duplicate = JSON.parse(record[SCREEN_CONTRACT_PATH]); duplicate.screens.push(duplicate.screens[0]);
    expect(screenCopyFromSnapshot({ [SCREEN_CONTRACT_PATH]: JSON.stringify(duplicate) }, 'submission', 'phase')).toBeNull();
  });
});

/**
 * Who owns the screen contract, on a design phase a teacher has split.
 *
 * `design` is a `markdown` phase whose `shared/contract/screens.json` is
 * editable and a `checks.targets` entry, so two tasks *can* claim it: the
 * compiler allows overlapping `owns` on written phases. The accepted screen copy is not a report
 * field: `requireAcceptedDesignScreenCopy` freezes it at design →
 * implementation advance and `withScreenCopy` injects it read-only into four
 * later phases, where it is graded, so an arbitrary task's passing submission
 * becoming the contract is a score harm in four phases, not a cosmetic one.
 *
 * Hence: the lookup is a `filter`, never a `find`. The compile rule
 * `screen-contract-belongs-to-one-task` refuses a version with two owners at
 * publish, and the throw below is the statement that the rule is what makes the
 * single owner true: asserted rather than trusted to the array's order.
 */
describe('the accepted screen copy has exactly one owning task', () => {
  const TEACHER = 'ms-tan-tasktrackr';
  const V_SPLIT = 'v-teacher-design-split';
  const V_TWO_OWNERS = 'v-teacher-two-owners';
  const V_NO_CONTRACT = 'v-teacher-no-contract';

  let db: DataSource;
  let shipped: ProjectContent;
  let teacher: ProjectContent;
  let content: ContentService;
  let workflow: WorkflowService;
  let enrollment: EnrollmentEntity;
  let states: PhaseStateEntity[];

  const learner = 'split-design-learner';
  const phase = (key: string) => states.find((state) => state.phaseKey === key)!;
  const designOf = (project: ProjectContent): PhaseContent =>
    project.phases.find((one) => one.key === 'design') as PhaseContent;

  /** A hand-built compiled task over the phase's own sole task. */
  const taskLike = (base: PhaseContent, over: Partial<CompiledTask>): CompiledTask => ({
    ...soleTaskFor(base),
    ...over,
  });

  /** Every phase at its sole task, with `design` replaced by the list given. */
  const withDesignTasks = (project: ProjectContent, tasks: CompiledTask[]): CompiledPhaseTasks[] =>
    project.phases.map((one) => ({
      key: one.key,
      tasks: one.key === 'design' ? tasks : [soleTaskFor(one)],
    }));

  /** A design phase that mounts no screen contract at all. */
  const withoutContract = (project: ProjectContent): ProjectContent => ({
    ...project,
    phases: project.phases.map((one) =>
      one.key !== 'design'
        ? one
        : {
            ...one,
            files: one.files.filter((file) => file.path !== SCREEN_CONTRACT_PATH),
          },
    ),
  });

  const install = (
    ...versions: { versionId: string; content: ProjectContent; phases: CompiledPhaseTasks[] }[]
  ): void => {
    content.installVersions(versions.map((one) => ({ ...one, compiler: COMPILER_IDENTITY })));
  };

  const snapshot = (title = 'Late work', empty = 'Nothing is overdue. You are all caught up.') => ({
    [SCREEN_CONTRACT_PATH]: JSON.stringify({ screens: [{ route: '#/overdue', title, empty }] }),
  });

  /** A passing, strict-evidenced revision of one task of the design phase. */
  const revision = async (
    taskKey: string,
    over: Partial<SubmissionEntity> = {},
  ): Promise<SubmissionEntity> => {
    const rubric = designOf(teacher).rubric;
    return db.manager.save(
      SubmissionEntity,
      db.manager.create(SubmissionEntity, {
        id: randomUUID(),
        phaseStateId: phase('design').id,
        userId: learner,
        taskKey,
        status: 'completed',
        passed: true,
        createdAt: new Date('2026-09-01T10:00:00Z'),
        workspaceSnapshot: snapshot(),
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [{ id: 'fixture', label: 'Mocked authority fixture', status: 'passed', detail: 'Only database authority is under test.' }],
          tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
          aiReview: {
            provider: 'mock-ai',
            verdict: 'pass',
            criteriaEvidence: rubric.criteria.map((c) => ({ key: c.key, met: true, evidence: 'Mocked criterion authority.', issue: '', nextStep: '' })),
          },
        } as unknown as FeedbackReport,
        ...over,
      }),
    );
  };

  const enrol = async (): Promise<void> => {
    await workflow.enroll(learner, TEACHER);
    enrollment = await db.manager.findOneByOrFail(EnrollmentEntity, { userId: learner });
    states = await db.manager.find(PhaseStateEntity, { where: { enrollmentId: enrollment.id } });
  };

  beforeAll(async () => {
    db = await memoryDataSource();
    const loader = new ContentService();
    loader.loadAll();
    shipped = loader.getProject('tasktrackr');
    teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)', version: '1.0.0' };
  });

  afterAll(async () => {
    if (db.isInitialized) await db.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await db.manager.clear(entity);
    content = new ContentService();
    content.loadAll();
    workflow = new WorkflowService(
      db.getRepository(EnrollmentEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      db,
    );
  });

  it('the accepted copy is the newest passing submission of the task owning the screen contract', async () => {
    const design = designOf(teacher);
    const narrative = taskLike(design, {
      taskKey: 'narrative',
      order: 1,
      owns: editablePathsOf(design).filter((at) => at !== SCREEN_CONTRACT_PATH),
    });
    const screens = taskLike(design, { taskKey: 'screens', order: 2, owns: [SCREEN_CONTRACT_PATH] });
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, [narrative, screens]) });
    await enrol();

    // The sibling's revision is newer and carries a complete screen record of
    // its own. It is not the contract, because it is not the owner's.
    const owned = await revision('screens');
    await revision('narrative', {
      createdAt: new Date('2026-09-04T10:00:00Z'),
      workspaceSnapshot: snapshot('SIBLING TITLE', 'SIBLING EMPTY'),
    });

    const copy = await acceptedDesignScreenCopy(db.manager, content, enrollment);
    expect(copy).toMatchObject({ sourceSubmissionId: owned.id, title: 'Late work' });

    // And with the phase-wide predicate the owner's work is never consulted:
    // delete it and the sibling's copy is never taken. This owner is not the
    // reference's task by its anchor, so with no passing submission of its own
    // the gate answers null and the pack's baseline copy mounts rather than
    // refusing the advance.
    await db.manager.delete(SubmissionEntity, { id: owned.id });
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).resolves.toBeNull();
  });

  /* ---- only the throw is keyed, on the task anchor ---- */

  /** The version's Design owner rewritten, the way a teacher's `updateTask` on the inherited task leaves it. */
  const editedOwner = (): CompiledTask =>
    taskLike(designOf(teacher), { brief: 'Design the booking contract: the reserve operation and what it refuses.' });

  /** A Design pass whose snapshot holds no usable screen record, so no copy can be extracted from it. */
  const passWithoutCopy = (taskKey = '') =>
    revision(taskKey, { workspaceSnapshot: { [SCREEN_CONTRACT_PATH]: JSON.stringify({ screens: [] }) } });

  const advancePastDesign = async () => {
    await db.manager.update(PhaseStateEntity, phase('design').id, { status: 'passed' });
    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 2 });
    await workflow.advance(learner, phase('design').id);
  };

  it("an edited owner's learner with no copy advances onto the pack's baseline, never a throw", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, [editedOwner()]) });
    await enrol();
    await passWithoutCopy();
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).resolves.toBeNull();
    await advancePastDesign();
    const detail = await workflow.phaseDetail(learner, phase('implementation').id);
    expect(detail.acceptedScreenCopy).toBeNull();
    expect(JSON.parse(detail.files.find((file) => file.path === SCREEN_COPY_PATH)!.content)).toMatchObject({ source: 'reference' });
  });

  it("an edited owner's learner with a copy carries it: acceptedDesignScreenCopy is unchanged", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, [editedOwner()]) });
    await enrol();
    const owned = await revision('', { workspaceSnapshot: snapshot('Rooms free now', 'No room is free right now.') });
    await advancePastDesign();
    const detail = await workflow.phaseDetail(learner, phase('implementation').id);
    expect(detail.acceptedScreenCopy).toMatchObject({ sourceSubmissionId: owned.id, title: 'Rooms free now', empty: 'No room is free right now.' });
  });

  it('a learner already past Design keeps the copy retained for them', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, [editedOwner()]) });
    await enrol();
    const retained: AcceptedScreenCopy = { version: 1, sourceSubmissionId: 'kept-submission', sourcePhaseStateId: phase('design').id, title: 'Kept title', empty: 'Kept sentence.' };
    await db.manager.update(PhaseStateEntity, phase('implementation').id, { status: 'in_progress', unlockedAt: '2026-09-02T10:00:00Z', acceptedScreenCopy: retained });
    await db.manager.update(EnrollmentEntity, enrollment.id, { currentPhaseOrder: 3 });
    expect((await workflow.phaseDetail(learner, phase('implementation').id)).acceptedScreenCopy).toEqual(retained);
  });

  it("a fork whose only change is Design's scenario still throws: the owner is still the reference's task", async () => {
    const scenarioOnly: ProjectContent = {
      ...teacher,
      phases: teacher.phases.map((one) =>
        one.key !== 'design'
          ? one
          : {
              ...one,
              intro: '# RoomDesk architecture\n',
              // a read-only document beside the task's own: scenario, owned by no task
              files: [...one.files, { path: 'docs/notes.md', content: '# RoomDesk notes\n', editable: false, language: 'markdown' }],
            },
      ),
    };
    // the fork really differs from the teacher's version, in the intro and in a file the task does not own
    expect(designOf(scenarioOnly).intro).not.toBe(designOf(teacher).intro);
    expect(designOf(scenarioOnly).files.length).toBe(designOf(teacher).files.length + 1);
    expect(soleTaskFor(designOf(scenarioOnly)).owns).not.toContain('docs/notes.md');
    install({ versionId: V_SPLIT, content: scenarioOnly, phases: withDesignTasks(scenarioOnly, [soleTaskFor(designOf(scenarioOnly))]) });
    await enrol();
    await passWithoutCopy();
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow('passing Design submission');
  });

  it('a design phase declaring no screen contract answers null', async () => {
    const bare = withoutContract(teacher);
    install({ versionId: V_NO_CONTRACT, content: bare, phases: withDesignTasks(bare, [soleTaskFor(designOf(bare))]) });
    await enrol();
    await revision('');
    expect(await acceptedDesignScreenCopy(db.manager, content, enrollment)).toBeNull();
  });

  it('two tasks owning the screen contract is a compile refusal, not a silent pick', async () => {
    const design = designOf(teacher);
    const first = taskLike(design, { taskKey: 'flows', order: 1, owns: [SCREEN_CONTRACT_PATH] });
    const second = taskLike(design, { taskKey: 'states', order: 2, owns: [SCREEN_CONTRACT_PATH] });
    install({ versionId: V_TWO_OWNERS, content: teacher, phases: withDesignTasks(teacher, [first, second]) });
    await enrol();
    await revision('flows');

    // Unreachable on a published version (the compile rule
    // `screen-contract-belongs-to-one-task` refuses it) and the throw is what
    // says so. With `find` and no rule the lower-order task's submission
    // silently becomes the contract four later phases are graded against.
    await expect(acceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow(
      /both own "shared\/contract\/screens\.json"/,
    );
    await expect(acceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow(/flows/);
    await expect(acceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow(/states/);
  });

  /* ---- the copy is the CURRENT run's ---- */

  /**
   * A teacher's copy whose Design keeps the reference's own task beside one
   * the teacher added, so the list is not the synthesised sole task and the
   * owner has a `task_states` row a reset moves. `edited` rewrites the owner's
   * brief, which makes it the teacher's task rather than the reference's by
   * its anchor.
   */
  const splitDesign = (edited: boolean): CompiledTask[] => {
    const design = designOf(teacher);
    const owner = edited ? editedOwner() : soleTaskFor(design);
    const notes = taskLike(design, {
      taskKey: 'notes',
      order: 2,
      required: false,
      owns: editablePathsOf(design).filter((at) => at !== SCREEN_CONTRACT_PATH),
    });
    return [{ ...owner, order: 1 }, notes];
  };

  /**
   * Run 0 strict-passes with an overdue row; then a reset of the owner task
   * (what learner-reset, reset-phase and task-reset do under the lock: stamp
   * the ending run's NULL revisions, then bump `resetCount`); then run 1
   * strict-passes with no overdue row.
   */
  const passResetPassWithout = async (resetAt = '2026-09-02T10:00:00.000Z') => {
    const ownerKey = splitDesign(false)[0].taskKey;
    const discarded = await revision(ownerKey, { createdAt: new Date('2026-09-01T10:00:00Z') });
    const row = await db.manager.findOneByOrFail(TaskStateEntity, { phaseStateId: phase('design').id, taskKey: ownerKey });
    expect(await stampEndingRun(db.manager, row)).toBe(1);
    await db.manager.update(TaskStateEntity, { id: row.id }, { resetCount: row.resetCount + 1, resetAt });
    await revision(ownerKey, {
      createdAt: new Date(Date.parse(resetAt) + 3_600_000),
      workspaceSnapshot: { [SCREEN_CONTRACT_PATH]: JSON.stringify({ screens: [] }) },
    });
    await db.manager.update(TaskStateEntity, { id: row.id }, { status: 'passed' });
    return { discarded, ownerKey };
  };

  it("after a reset, the reference's own task refuses rather than carry the discarded run's copy", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(false)) });
    await enrol();
    await passResetPassWithout();
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).rejects.toThrow('passing Design submission');
  });

  it("after a reset, an authored owner mounts the pack's baseline rather than carry the discarded run's copy", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(true)) });
    await enrol();
    await passResetPassWithout();
    await expect(requireAcceptedDesignScreenCopy(db.manager, content, enrollment)).resolves.toBeNull();
    await advancePastDesign();
    const detail = await workflow.phaseDetail(learner, phase('implementation').id);
    expect(detail.acceptedScreenCopy).toBeNull();
    expect(JSON.parse(detail.files.find((file) => file.path === SCREEN_COPY_PATH)!.content)).toMatchObject({ source: 'reference' });
  });

  it('guard: with no reset, the NULL-epoch pass still carries its copy', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(true)) });
    await enrol();
    const kept = await revision(splitDesign(true)[0].taskKey);
    expect(await acceptedDesignScreenCopy(db.manager, content, enrollment)).toMatchObject({ sourceSubmissionId: kept.id, title: 'Late work' });
  });

  it("guard: after a reset, the current run's own copy is carried", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(true)) });
    await enrol();
    await passResetPassWithout();
    const current = await revision(splitDesign(true)[0].taskKey, {
      createdAt: new Date('2026-09-04T10:00:00Z'),
      workspaceSnapshot: snapshot('Due today', 'Nothing is due today.'),
    });
    expect(await acceptedDesignScreenCopy(db.manager, content, enrollment)).toMatchObject({ sourceSubmissionId: current.id, title: 'Due today' });
  });

  it("guard: the historical cutoff read ('before') keeps its reading when the reset came after the cutoff", async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(true)) });
    await enrol();
    // Implementation unlocked on the 5th; the owner task was reset on the 6th.
    const { discarded } = await passResetPassWithout('2026-09-06T10:00:00.000Z');
    expect(await acceptedDesignScreenCopy(db.manager, content, enrollment, new Date('2026-09-05T10:00:00Z'))).toMatchObject({
      sourceSubmissionId: discarded.id,
    });
  });

  it('the historical cutoff read agrees with the advance when the reset came before the cutoff', async () => {
    install({ versionId: V_SPLIT, content: teacher, phases: withDesignTasks(teacher, splitDesign(true)) });
    await enrol();
    await passResetPassWithout('2026-09-02T10:00:00.000Z');
    expect(await acceptedDesignScreenCopy(db.manager, content, enrollment, new Date('2026-09-05T10:00:00Z'))).toBeNull();
  });
});

import 'reflect-metadata';
import { INHERITED_TASK_KEY } from '@learnsdlc/shared';
import { SCREEN_CONTRACT_PATH } from '../content/screen-copy';
import type { FeedbackReport } from '@learnsdlc/shared';
import { EnrollmentEntity, PhaseStateEntity, SubmissionEntity } from '../db/entities';
import { requireAcceptedDesignScreenCopy } from '../workflow/accepted-screen-copy';
import type { ContentService } from '../content/content.service';
import {
  SCREEN_CONTRACT_OWNER_CHECK_ID,
  optionalScreenContractOwnerRefusal,
  screenContractBaselineNote,
  screenContractOwnerRefusal,
} from './validation';
import type { DesignChecks } from '../content/content.types';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import {
  S1_TEACHER,
  copyTaskTrackr,
  draftSnapshot,
  openForkWorld,
  phaseOf,
  tasktrackrPhase,
  type Fork,
  type ForkWorld,
} from '../../test/tasktrackr-phase';

/**
 * A copy whose Design phase owns no screen contract, while a later phase
 * reads the screen copy.
 *
 * Since TaskTrackr 4.0.0 the Design phase holds one design task, which owns
 * `shared/contract/screens.json` while its screen contract switch is on; a
 * teacher who switches the screen contract off leaves the file with no owner. That
 * must never strand a class at Design → Implementation: with no owner the
 * advance mounts the pack's baseline copy and the version publishes with a
 * note saying so. An optional owner that is the reference's task is refused
 * in one sentence, by the fast tier and by publish alike.
 */
describe('a copy that loses its screen contract owner', () => {
  let world: ForkWorld;

  /** The copy's design task with the screen contract switched off: TaskTrackr's own design otherwise, no screen on the floor. */
  const screensOff = (fork: Fork) => {
    const checks = tasktrackrPhase('design').checks as DesignChecks;
    return world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, {
      design: { contracts: { api: true, screens: false }, sequence: checks.sequence, stories: checks.stories, floor: { ...checks.floor, minScreens: 0, screenShape: false } },
    } as never);
  };
  /** A required concept quiz beside the design task: the one task a Design phase can hold beside it. */
  const requiredQuiz = (fork: Fork) =>
    world.service.addTask(S1_TEACHER, fork.projectId, fork.versionId, 'design', {
      taskKey: 'concepts', title: 'Design concepts', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: true,
      quiz: { questions: fixtureQuizQuestions(5), drawn: 3 },
    } as never);
  beforeAll(async () => {
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  /*
   * One learner holds one strictly passing Design submission with a complete
   * screen contract, so the only thing that differs between the two reads is
   * whether a task owns the file. A learner with no submission at all would
   * make the advance throw whether or not a task owned the contract, and
   * prove nothing about owners.
   */
  // With no owner the advance does not refuse.
  // `requireAcceptedDesignScreenCopy` throws only when the
  // single owner is the reference's task by its anchor; with none it answers
  // null and the pack's baseline copy mounts. The owned read returns the copy.
  it('is no longer a dead end: the same passing learner gets their copy when a task owns the contract, and the baseline when none does', async () => {
    const fork = await copyTaskTrackr(world, 's1f-dead-end');
    const owned = phaseOf(await draftSnapshot(world, fork), 'design').tasks;
    const owner = owned.find((task) => task.owns.includes(SCREEN_CONTRACT_PATH))!;
    expect(owner.taskKey).toBe(INHERITED_TASK_KEY);
    await screensOff(fork);
    const { tasks } = phaseOf(await draftSnapshot(world, fork), 'design');
    expect(tasks.some((task) => task.owns.includes(SCREEN_CONTRACT_PATH))).toBe(false);

    const manager = world.dataSource.manager;
    const enrollment = await manager.save(manager.create(EnrollmentEntity, { userId: 's1f-learner', projectSlug: 's1f-dead-end', currentPhaseOrder: 2 }));
    const design = await manager.save(manager.create(PhaseStateEntity, { enrollmentId: enrollment.id, userId: 's1f-learner', phaseKey: 'design', phaseOrder: 2, status: 'passed' }));
    await manager.save(manager.create(SubmissionEntity, {
      phaseStateId: design.id, userId: 's1f-learner', taskKey: owner.taskKey,
      status: 'completed', passed: true, createdAt: new Date('2026-09-01T10:00:00Z'),
      workspaceSnapshot: { [SCREEN_CONTRACT_PATH]: JSON.stringify({ screens: [{ route: '#/overdue', title: 'Late work', empty: 'Nothing is late.' }] }) },
      contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
      report: {
        assessmentMode: 'strict_binary', passed: true,
        checks: [{ id: 'fixture', label: 'Mocked authority fixture', status: 'passed', detail: 'Only the owner is under test.' }],
        aiReview: { provider: 'mock-ai', verdict: 'pass', criteriaEvidence: owner.rubric.criteria.map((c) => ({ key: c.key, met: true, evidence: 'Mocked criterion.', issue: '', nextStep: '' })) },
      } as unknown as FeedbackReport,
    }));
    const reads = (list: typeof tasks) => ({ getTasksForEnrollment: () => list } as unknown as ContentService);

    await expect(requireAcceptedDesignScreenCopy(manager, reads(owned), enrollment)).resolves.toMatchObject({ title: 'Late work', empty: 'Nothing is late.' });
    await expect(requireAcceptedDesignScreenCopy(manager, reads(tasks), enrollment)).resolves.toBeNull();
  });

  /*
   * An OPTIONAL owner is a dead end. The Design
   * gate opens on the required tasks alone, so a learner who passes the
   * teacher's required task sees Design passed, and the advance then refuses
   * until they happen to pass the optional one that owns the contract.
   */
  it('refuses an owner that is optional, in one sentence, and passes it again once required', async () => {
    const fork = await copyTaskTrackr(world, 's1f-optional-owner');
    await requiredQuiz(fork);
    const optional = await world.service.setTaskRequired(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, { required: false });
    const sentence = optionalScreenContractOwnerRefusal('Design', 'Implementation');
    expect(sentence.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(sentence).toContain(SCREEN_CONTRACT_PATH);
    const rows = optional.validation.checks.filter((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID);
    expect(rows).toHaveLength(1);
    expect([rows[0].status, rows[0].sentence]).toEqual(['failed', sentence]);
    expect(optional.validation.publishable).toBe(false);
    await expect(world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' })).rejects.toThrow(sentence);

    const required = await world.service.setTaskRequired(S1_TEACHER, fork.projectId, fork.versionId, 'design', INHERITED_TASK_KEY, { required: true });
    expect(required.validation.checks.find((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID)?.status).toBe('passed');
    expect(required.validation.publishable).toBe(true);
  });

  // Zero owners is an info row (a passed row saying Implementation shows the
  // reference's own screen copy) and the version publishes. The refusal
  // sentence is for the one owner it describes: an optional owner that is the
  // reference's task.
  it('publishes it, with a passed row that says the later phases show the reference copy, and says the same while drafting', async () => {
    const fork = await copyTaskTrackr(world, 's1f-refused');
    const removed = await screensOff(fork);
    const sentence = screenContractBaselineNote('Design', 'Implementation', 'TaskTrackr');
    expect(sentence.match(/[.!?](\s|$)/g)).toHaveLength(1);
    expect(sentence).toContain(SCREEN_CONTRACT_PATH);
    expect(sentence).not.toBe(screenContractOwnerRefusal('Design', 'Implementation'));

    const report = removed.validation;
    const rows = report.checks.filter((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('passed');
    expect(rows[0].phaseKey).toBe('design');
    expect(rows[0].sentence).toBe(sentence);
    // The baseline row says a fact, so it is a note, not a plain pass.
    expect(rows[0].advisory).toBe('note');
    expect(report.publishable).toBe(true);
    expect(report.blocking).toEqual([]);

    await expect(world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' })).resolves.toBeDefined();
  });

  // An optional screen contract owner that is not the reference's task has no shape since 4.0.0: a Design phase holds one
  // design task, and beside a required quiz an optional design task does not compile (the quiz alone would
  // open the phase), so no version can carry an optional screen contract owner of any kind.

  it('publishes the same work when the inherited Design task stays beside the teacher\'s own', async () => {
    // the teacher's own task beside the design task is a concept quiz: a Design phase holds one design task since 4.0.0
    const fork = await copyTaskTrackr(world, 's1f-mixed');
    const added = await requiredQuiz(fork);
    const row = added.validation.checks.find((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID);
    expect(row?.status).toBe('passed');
    expect(added.validation.publishable).toBe(true);
    await expect(world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' })).resolves.toBeDefined();
  });

  it('passes an untouched copy', async () => {
    const fork = await copyTaskTrackr(world, 's1f-untouched');
    const report = await world.service.validate(S1_TEACHER, fork.projectId, fork.versionId);
    expect(report.checks.find((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID)?.status).toBe('passed');
    // An owned contract is a real pass, with no mark.
    expect(report.checks.find((one) => one.id === SCREEN_CONTRACT_OWNER_CHECK_ID)?.advisory).toBeUndefined();
    expect(report.publishable).toBe(true);
  });
});

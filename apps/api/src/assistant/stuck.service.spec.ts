import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { ContentService } from '../content/content.service';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { WorkflowService } from '../workflow/workflow.service';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { StuckService } from './stuck.service';

/**
 * The stuck flag from both ends.
 *
 * The rules under test are the ones a busy lab exposes: one open flag per
 * phase, the learner owns the clearing, an instructor only ever sees their own
 * class, and an answer written against a flag the learner has already cleared
 * is refused rather than silently landing on nothing.
 */
describe('StuckService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: StuckService;

  let learnerId = '';
  let phaseStateId = '';
  let cohortId = '';
  let owner: InstructorCaller;
  let stranger: InstructorCaller;

  const manager = () => dataSource.manager;

  const makeUser = async (
    email: string,
    over: Partial<UserEntity> = {},
  ): Promise<UserEntity> =>
    manager().save(
      manager().create(UserEntity, {
        email,
        passwordHash: 'x',
        displayName: email.split('@')[0],
        ...over,
      }),
    );

  const enrol = async (userId: string): Promise<string> => {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug: 'tasktrackr',
        currentPhaseOrder: 1,
      }),
    );
    let first = '';
    for (const phase of content.getProject('tasktrackr').phases) {
      const row = await manager().save(
        manager().create(PhaseStateEntity, {
          enrollmentId: enrollment.id,
          userId,
          phaseKey: phase.key,
          phaseOrder: phase.order,
          status: phase.order === 1 ? 'in_progress' : 'locked',
          attempts: 0,
        }),
      );
      if (phase.order === 1) first = row.id;
    }
    return first;
  };

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
    // The bell rides both halves of the flag. A real service against
    // the same data source, so the notifications it writes are the ones the
    // running app writes; the gateway is a stub because a socket is not what
    // these assertions are about.
    const notifications = new NotificationsService(dataSource, content, {
      emitNotification: () => undefined,
    } as unknown as EventsGateway);
    service = new StuckService(dataSource, workflow, content, notifications);

    const instructor = await makeUser('ana@class.edu', { role: 'INSTRUCTOR' });
    const cohort = await manager().save(
      manager().create(CohortEntity, {
        name: 'Monday class',
        joinCode: 'MON-1',
        ownerUserId: instructor.id,
      }),
    );
    cohortId = cohort.id;
    await manager().update(UserEntity, instructor.id, { cohort: cohortId });
    owner = { id: instructor.id, role: 'INSTRUCTOR', cohort: cohortId };

    const other = await makeUser('bo@class.edu', { role: 'INSTRUCTOR' });
    const otherCohort = await manager().save(
      manager().create(CohortEntity, {
        name: 'Friday class',
        joinCode: 'FRI-1',
        ownerUserId: other.id,
      }),
    );
    await manager().update(UserEntity, other.id, { cohort: otherCohort.id });
    stranger = { id: other.id, role: 'INSTRUCTOR', cohort: otherCohort.id };

    const learner = await makeUser('lee@class.edu', { cohort: cohortId });
    learnerId = learner.id;
    phaseStateId = await enrol(learnerId);
  });

  /* ------------------------------- learner ------------------------------- */

  it('raises a flag the instructor can see, oldest first', async () => {
    const flag = await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', 'read the task panel');

    expect(flag).toMatchObject({
      question: 'I cannot tell what US-4 needs',
      tried: 'read the task panel',
      answeredAt: null,
      clearedAt: null,
    });

    const list = await service.list(owner);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      phaseStateId,
      userId: learnerId,
      displayName: 'lee',
      phaseKey: 'requirements',
      phaseTitle: 'Requirements',
      projectSlug: 'tasktrackr',
    });
  });

  // The title comes from the version the learner's
  // enrolment holds, not the pack's head, so a teacher's copy (or a learner
  // on an older version) is named by the phase they are actually working.
  it('names the phase from the pinned version the enrolment holds, never the head', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what the brief needs', '');
    const state = await manager().findOneByOrFail(PhaseStateEntity, { id: phaseStateId });
    await manager().update(EnrollmentEntity, state.enrollmentId, { projectVersionId: 'pinned-version-id' });
    const pinned = jest.spyOn(content, 'getPhaseForEnrollment').mockReturnValue({ ...content.getPhase('tasktrackr', 'requirements'), title: 'Requirements, as the pinned version names it' });
    const head = jest.spyOn(content, 'getPhase');
    try {
      const [item] = await service.list(owner);
      expect(item.phaseTitle).toBe('Requirements, as the pinned version names it');
      expect(pinned).toHaveBeenCalledWith({ projectSlug: 'tasktrackr', projectVersionId: 'pinned-version-id' }, 'requirements');
      expect(head).not.toHaveBeenCalled();
      // A version that cannot be served keeps the truthful key, never a 500.
      pinned.mockImplementation(() => { throw new Error('unservable'); });
      expect((await service.list(owner))[0].phaseTitle).toBe('requirements');
      // The answer route names the phase the same way.
      pinned.mockReturnValue({ ...content.getPhase('tasktrackr', 'requirements'), title: 'Requirements, as the pinned version names it' });
      head.mockClear();
      expect((await service.answer(owner, phaseStateId, 'Start from the acceptance criteria.')).phaseTitle).toBe('Requirements, as the pinned version names it');
      expect(head).not.toHaveBeenCalled();
    } finally {
      pinned.mockRestore();
      head.mockRestore();
    }
  });

  it('refuses a second flag while one is open', async () => {
    await service.raise(learnerId, phaseStateId, 'the first thing I am stuck on', '');
    await expect(
      service.raise(learnerId, phaseStateId, 'a second thing entirely', ''),
    ).rejects.toBeInstanceOf(ConflictException);

    // …and once the learner has cleared it, they may raise another.
    await service.clear(learnerId, phaseStateId);
    const second = await service.raise(learnerId, phaseStateId, 'a second thing entirely', '');
    expect(second.question).toBe('a second thing entirely');
  });

  it('accepts exactly one concurrent question without overwriting the winner', async () => {
    const results = await Promise.allSettled([
      service.raise(learnerId, phaseStateId, 'First tab question about the boundary', ''),
      service.raise(learnerId, phaseStateId, 'Second tab question about an example', ''),
    ]);
    const success = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof service.raise>>> => item.status === 'fulfilled');
    expect(success).toHaveLength(1);
    const failure = results.find((item): item is PromiseRejectedResult => item.status === 'rejected')!;
    expect(failure.reason).toBeInstanceOf(ConflictException);
    expect(await service.mine(learnerId, phaseStateId)).toEqual(success[0].value);
  });

  it('cannot clear a reply that arrived after the learner read the request', async () => {
    await service.raise(learnerId, phaseStateId, 'Which date boundary should I investigate?', '');
    const workflow = service['workflow'];
    const original = workflow.loadOwnedState.bind(workflow);
    let release!: () => void, read!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const loaded = new Promise<void>(resolve => { read = resolve; });
    const spy = jest.spyOn(workflow, 'loadOwnedState').mockImplementationOnce(async (...args) => {
      const snapshot = await original(...args);
      read(); await paused;
      return snapshot;
    });
    try {
      const clearing = service.clear(learnerId, phaseStateId);
      await loaded;
      const reply = await service.answer(owner, phaseStateId, 'Compare a task due today with one due yesterday.');
      release();
      await expect(clearing).rejects.toBeInstanceOf(ConflictException);
      const current = await service.mine(learnerId, phaseStateId);
      expect(current?.answer).toBe(reply.answer);
      expect(current?.clearedAt).toBeNull();
    } finally { release(); spy.mockRestore(); }
  });

  it('lets the learner clear their own flag, and nobody else', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');
    await service.answer(owner, phaseStateId, 'Start from the boundary: is due today overdue?');

    // Still on the instructor's page: an answer nobody has read is not done.
    expect(await service.list(owner)).toHaveLength(1);

    const cleared = await service.clear(learnerId, phaseStateId);
    expect(cleared?.clearedAt).not.toBeNull();
    expect(await service.list(owner)).toEqual([]);
    // …and the record of it is still there for anyone who asks for all of them.
    expect(await service.list(owner, { state: 'all' })).toHaveLength(1);
  });

  it('refuses another learner’s phase, through the one ownership check', async () => {
    const bystander = await makeUser('sam@class.edu', { cohort: cohortId });
    await expect(
      service.raise(bystander.id, phaseStateId, 'let me see somebody else’s phase', ''),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.mine(bystander.id, phaseStateId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  /* ------------------------------ instructor ----------------------------- */

  it('answers a flag, names who answered, and writes the answer into the audit trail', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', 'read the panel');

    const answered = await service.answer(
      owner,
      phaseStateId,
      'Start from the boundary: is a task due today overdue?',
    );

    expect(answered.answer).toBe('Start from the boundary: is a task due today overdue?');
    expect(answered.answeredByName).toBe('ana');
    expect(answered.answeredAt).not.toBeNull();

    const audit = await manager().find(AuditEventEntity);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: 'stuck.answer',
      actorUserId: owner.id,
      subjectUserId: learnerId,
      targetId: phaseStateId,
      action: 'answered',
      reason: 'Start from the boundary: is a task due today overdue?',
    });
    expect(audit[0].detail).toMatchObject({ phaseKey: 'requirements', projectSlug: 'tasktrackr' });

    // The learner sees it in their own column.
    const mine = await service.mine(learnerId, phaseStateId);
    expect(mine?.answer).toBe('Start from the boundary: is a task due today overdue?');
  });

  it('refuses an answer written against a flag the learner has already cleared', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');
    await service.clear(learnerId, phaseStateId);

    await expect(service.answer(owner, phaseStateId, 'here is a thought')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('hides a flag from an instructor whose class the learner is not in', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');

    expect(await service.list(stranger)).toEqual([]);
    await expect(service.answer(stranger, phaseStateId, 'let me in')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('shows an admin every class', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');
    const admin: InstructorCaller = { id: 'admin', role: 'ADMIN', cohort: 'default' };
    expect(await service.list(admin)).toHaveLength(1);
  });

  it('narrows to one project when the console asks for one', async () => {
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');
    expect(await service.list(owner, { project: 'tasktrackr' })).toHaveLength(1);
    expect(await service.list(owner, { project: 'other-pack' })).toEqual([]);
  });

  it('is empty, not an error, for an instructor with no class of their own', async () => {
    const fresh: InstructorCaller = { id: 'nobody', role: 'INSTRUCTOR', cohort: 'default' };
    await service.raise(learnerId, phaseStateId, 'I cannot tell what US-4 needs', '');
    expect(await service.list(fresh)).toEqual([]);
  });

  it('filters the authorized class before the oldest-request cap and denies an unowned class filter', async () => {
    const second = await manager().save(manager().create(CohortEntity, { name: 'Second owned class', joinCode: 'OWN-2', ownerUserId: owner.id }));
    const otherLearner = await makeUser('new-class@class.edu', { cohort: second.id });
    const otherPhase = await enrol(otherLearner.id);
    await service.raise(learnerId, phaseStateId, 'An older question in the first class', '');
    await service.raise(otherLearner.id, otherPhase, 'The visible question in the second class', '');
    const cap = StuckService.MAX_OPEN;
    // A smaller cap exercises the same pagination boundary without 50 users.
    Object.defineProperty(StuckService, 'MAX_OPEN', { value: 1, configurable: true });
    try {
      expect(await service.list(owner, { cohortId: second.id })).toEqual([expect.objectContaining({ userId: otherLearner.id })]);
      expect(await service.list(stranger, { cohortId: second.id })).toEqual([]);
      expect(await service.list(owner, { cohortId })).toEqual([expect.objectContaining({ userId: learnerId })]);
    } finally { Object.defineProperty(StuckService, 'MAX_OPEN', { value: cap, configurable: true }); }
  });
});

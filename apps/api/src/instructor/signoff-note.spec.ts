import 'reflect-metadata';
import { Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import { COMPILER_IDENTITY, soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  NotificationEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import type { InstructorCaller } from './cohort-scope';
import { InstructorService } from './instructor.service';
import { SignoffService } from './signoff';
import { SubmissionTeacherFeedbackController } from './submission-feedback.controller';
import { SubmissionTeacherFeedbackService } from './submission-feedback.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The learner sees their teacher's sign-off.
 *
 * A sign-off is not a teacher note, so `GET :id/teacher-feedback` does not
 * carry it, and the learner's feedback page would say "No teacher feedback on
 * this submission yet." beside a task their teacher had signed off.
 * `GET :id/sign-off` reads
 * what the two writers already store (the task row's `signedOffAt`, and the
 * reason on the newest `task-signoff` audit row, bulk or per-learner lever)
 * and writes nothing. No migration: the reason lives only in `audit_events`.
 */

const SLUG = 'signoff-note-copy';
const VERSION = 'v-signoff-note';
const BULK_REASON = 'Interviews heard in the Monday lab, all four.';
const LEVER_REASON = 'Heard this interview in person on Tuesday.';

function splitTasks(requirements: PhaseContent): CompiledTask[] {
  const base = soleTaskFor(requirements);
  return [
    { ...base, taskKey: 'story', order: 1, title: 'The story', gradedUnits: [{ kind: 'rule', id: 'story-format' }] },
    {
      ...base,
      taskKey: 'interview',
      order: 2,
      title: 'The customer interview',
      signOff: true,
      gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
    },
  ];
}

describe('GET /submissions/:id/sign-off', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let signoff: SignoffService;
  let instructor: InstructorService;
  let feedback: SubmissionTeacherFeedbackService;

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let tuesday = '';
  let learner = { id: '', role: 'LEARNER' as const, email: '', cohort: '' };
  let stranger = { id: '', role: 'LEARNER' as const, email: '', cohort: '' };
  let phase!: PhaseStateEntity;

  const manager = () => dataSource.manager;
  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }));

  const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute, 0));

  /** A completed revision of the interview task, at a fixed minute of 6 Oct. */
  const revision = (minute: number, passed: boolean, over: Partial<SubmissionEntity> = {}) =>
    manager().save(
      manager().create(SubmissionEntity, {
        userId: learner.id,
        phaseStateId: phase.id,
        taskKey: 'interview',
        status: 'completed',
        passed,
        score: passed ? 100 : 0,
        report: { assessmentMode: 'strict_binary', passed } as SubmissionEntity['report'],
        createdAt: at(minute),
        ...over,
      }),
    );

  /** Every row the route could write, so "it writes nothing" is a measured claim. */
  const snapshot = async () => ({
    audit: await manager().count(AuditEventEntity),
    tasks: JSON.stringify(await manager().find(TaskStateEntity, { order: { taskKey: 'ASC' } })),
    phases: JSON.stringify(await manager().find(PhaseStateEntity, { order: { id: 'ASC' } })),
    submissions: JSON.stringify(await manager().find(SubmissionEntity, { order: { id: 'ASC' } })),
    notifications: await manager().count(NotificationEntity),
  });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject('tasktrackr');
    const teacher: ProjectContent = { ...shipped, slug: SLUG, title: 'Sign-off copy' };
    const requirements = teacher.phases.find((one) => one.key === 'requirements')!;
    content = new ContentService();
    content.loadAll();
    content.installVersions([
      {
        versionId: VERSION,
        content: teacher,
        compiler: COMPILER_IDENTITY,
        phases: teacher.phases.map((one) =>
          one.key === 'requirements'
            ? { key: one.key, tasks: splitTasks(requirements) }
            : { key: one.key, tasks: [soleTaskFor(one)] },
        ),
      },
    ]);
    signoff = new SignoffService(dataSource, content);
    instructor = new InstructorService(dataSource, content, { tokensToday: async () => 0 } as never);
    feedback = new SubmissionTeacherFeedbackService(dataSource, content, {} as never);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const danaRow = await saveUser({ email: 'dana@rg.test', role: 'INSTRUCTOR', displayName: 'Dana' });
    const samRow = await saveUser({ email: 'sam@rg.test', role: 'INSTRUCTOR', displayName: 'Sam' });
    tuesday = (await manager().save(manager().create(CohortEntity, { name: 'Tuesday', joinCode: 'RGTUES', ownerUserId: danaRow.id }))).id;
    const thursday = (await manager().save(manager().create(CohortEntity, { name: 'Thursday', joinCode: 'RGTHUR', ownerUserId: samRow.id }))).id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday };
    const lee = await saveUser({ email: 'lee@rg.test', displayName: 'Lee', cohort: tuesday });
    const kai = await saveUser({ email: 'kai@rg.test', displayName: 'Kai', cohort: tuesday });
    learner = { id: lee.id, role: 'LEARNER', email: lee.email, cohort: tuesday };
    stranger = { id: kai.id, role: 'LEARNER', email: kai.email, cohort: tuesday };

    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, { userId: lee.id, projectSlug: SLUG, projectVersionId: VERSION, currentPhaseOrder: 1 }),
    );
    phase = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: enrollment.id,
        userId: lee.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'submitted',
        bestScore: 80,
      }),
    );
    await manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: phase.id,
        userId: lee.id,
        taskKey: 'story',
        status: 'passed',
        passedAt: '2026-10-06T09:00:00.000Z',
        bestScore: 80,
      }),
    );
    // What the grader leaves after a strict Pass on a countersigned task.
    await manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: phase.id,
        userId: lee.id,
        taskKey: 'interview',
        status: 'submitted',
        bestScore: 100,
        awaitingSignOff: true,
      }),
    );
  });

  it('is routed beside teacher-feedback, under the same guard and with no role narrower than it', () => {
    const proto = SubmissionTeacherFeedbackController.prototype as unknown as Record<string, unknown>;
    const handler = proto.signOff as object | undefined;
    expect(handler).toBeDefined();
    expect(Reflect.getMetadata('path', handler!)).toBe(':id/sign-off');
    expect(Reflect.getMetadata('roles', handler!)).toEqual(Reflect.getMetadata('roles', proto.list as object));
  });

  it('answers not signed off while the task awaits its countersignature', async () => {
    await revision(1, false);
    const pass = await revision(2, true);
    await expect(feedback.signOff(learner, pass.id)).resolves.toEqual({ signedOff: false, reason: null, signedOffAt: null });
  });

  it('answers signed off, with the reason, after the bulk sign-off, and writes nothing', async () => {
    const first = await revision(1, false);
    const pass = await revision(2, true);
    const result = await signoff.bulk(dana, tuesday, { phaseKey: 'requirements', taskKey: 'interview', userIds: [learner.id], reason: BULK_REASON });
    expect(result.signedOff).toEqual([learner.id]);

    const before = await snapshot();
    const view = await feedback.signOff(learner, pass.id);
    expect(view).toEqual({ signedOff: true, reason: BULK_REASON, signedOffAt: expect.any(String) });
    const row = await manager().findOneByOrFail(TaskStateEntity, { phaseStateId: phase.id, taskKey: 'interview' });
    expect(view.signedOffAt).toBe(new Date(row.signedOffAt!).toISOString());
    // No name, email or id travels with it.
    expect(Object.keys(view).sort()).toEqual(['reason', 'signedOff', 'signedOffAt']);
    const text = JSON.stringify(view);
    for (const secret of [dana.id, learner.id, phase.id, 'Dana', 'dana@rg.test']) expect(text).not.toContain(secret);
    // The older Needs revision was never the signed evidence.
    await expect(feedback.signOff(learner, first.id)).resolves.toMatchObject({ signedOff: false });
    expect(await snapshot()).toEqual(before);
  });

  it('answers signed off, with the reason, after the per-learner lever', async () => {
    const pass = await revision(2, true);
    await instructor.overridePhase(dana, learner.id, phase.id, 'task-signoff', `  ${LEVER_REASON}  `, 'interview');
    await expect(feedback.signOff(learner, pass.id)).resolves.toEqual({ signedOff: true, reason: LEVER_REASON, signedOffAt: expect.any(String) });
  });

  it('is false for an older passing revision, and for one made after the sign-off', async () => {
    const older = await revision(1, true);
    const newest = await revision(2, true);
    await signoff.bulk(dana, tuesday, { phaseKey: 'requirements', taskKey: 'interview', userIds: [learner.id], reason: BULK_REASON });
    const later = await revision(59, true, { createdAt: new Date(Date.now() + 60_000) });
    await expect(feedback.signOff(learner, older.id)).resolves.toMatchObject({ signedOff: false, reason: null, signedOffAt: null });
    await expect(feedback.signOff(learner, newest.id)).resolves.toMatchObject({ signedOff: true });
    await expect(feedback.signOff(learner, later.id)).resolves.toMatchObject({ signedOff: false });
  });

  it('takes the reason from the newest task-signoff row for this learner, phase and task', async () => {
    const pass = await revision(2, true);
    await signoff.bulk(dana, tuesday, { phaseKey: 'requirements', taskKey: 'interview', userIds: [learner.id], reason: BULK_REASON });
    const audit = (over: Partial<AuditEventEntity>) =>
      manager().save(
        manager().create(AuditEventEntity, {
          event: 'task.signoff' as never,
          actorUserId: dana.id,
          subjectUserId: learner.id,
          targetId: phase.id,
          action: 'task-signoff',
          reason: 'not this one',
          detail: { taskKey: 'interview' },
          createdAt: new Date(Date.now() + 120_000),
          ...over,
        }),
      );
    // Newer rows that are about something else never answer.
    await audit({ detail: { taskKey: 'story' }, reason: 'another task' });
    await audit({ subjectUserId: stranger.id, reason: 'another learner' });
    await audit({ targetId: 'another-phase', reason: 'another phase' });
    await audit({ action: 'task-reset', reason: 'another action' });
    await expect(feedback.signOff(learner, pass.id)).resolves.toMatchObject({ reason: BULK_REASON });
    await audit({ reason: '  The newest countersignature.  ', createdAt: new Date(Date.now() + 180_000) });
    await expect(feedback.signOff(learner, pass.id)).resolves.toMatchObject({ reason: 'The newest countersignature.' });
  });

  it('lets the owner and their teacher read it, and refuses another learner and another class s teacher', async () => {
    const pass = await revision(2, true);
    await signoff.bulk(dana, tuesday, { phaseKey: 'requirements', taskKey: 'interview', userIds: [learner.id], reason: BULK_REASON });
    await expect(feedback.signOff(learner, pass.id)).resolves.toMatchObject({ signedOff: true });
    await expect(feedback.signOff({ ...dana, email: 'dana@rg.test' }, pass.id)).resolves.toMatchObject({ signedOff: true, reason: BULK_REASON });
    await expect(feedback.signOff(stranger, pass.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(feedback.signOff({ ...sam, email: 'sam@rg.test' }, pass.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(feedback.signOff(learner, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers a sole-task revision (taskKey "") as not signed off rather than guessing', async () => {
    const sole = await revision(2, true, { taskKey: '' });
    await expect(feedback.signOff(learner, sole.id)).resolves.toEqual({ signedOff: false, reason: null, signedOffAt: null });
  });
});

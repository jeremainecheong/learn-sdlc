import 'reflect-metadata';
import { DataSource } from 'typeorm';
import type { FeedbackReport, PhaseKey } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import {
  ALL_ENTITIES,
  CohortEntity,
  EnrollmentEntity,
  NotificationEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from './notifications.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The learner's bell shows each phase's latest verdict, on the read side only.
 *
 * The shape: revision 1 is a strict Needs revision with threads, so
 * `onVerdict` writes `review.posted`; revision 2 is a strict Pass with no
 * threads on a countersigned task, so the phase moves to `submitted` (not
 * `passed`) and `onVerdict` writes nothing at all. Read as stored, the bell
 * would keep the first "Needs revision" for ever. The answer is a projection
 * when the list is read: no new row, no change to what `onVerdict` writes.
 */
describe('the bell shows each phase\'s latest verdict', () => {
  let dataSource: DataSource;
  let service: NotificationsService;
  let emitted: { userId: string; unread: number }[] = [];
  let learnerId = '';
  let teacherId = '';
  let enrollmentId = '';
  let phaseTitle = '';

  const manager = () => dataSource.manager;
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 10, minute, 0));

  const strict = (passed: boolean, issues = 0): FeedbackReport =>
    ({
      assessmentMode: 'strict_binary',
      overall: passed ? 100 : 0,
      passed,
      passThreshold: 70,
      criteria: [],
      checks: [],
      staticAnalysis: {
        issues: Array.from({ length: issues }, (_, line) => ({
          rule: 'example', path: 'api/shelf.py', line: line + 1, severity: 'warning', message: 'Missing boundary',
        })),
      },
      aiReview: { summary: '', strengths: [], improvements: [], processNote: '' },
      aiReliance: { hintsThisPhase: 0, index: 0 },
      integrity: { relianceFlag: false, mentorPasteFlag: false, noEffortFlag: false },
    }) as unknown as FeedbackReport;

  const phaseState = (phaseKey: PhaseKey = 'implementation', order = 3) =>
    manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId, userId: learnerId, phaseKey, phaseOrder: order, status: 'in_progress', attempts: 0,
      }),
    );

  const taskRow = (state: PhaseStateEntity, taskKey = 'build', over: Partial<TaskStateEntity> = {}) =>
    manager().save(
      manager().create(TaskStateEntity, { phaseStateId: state.id, userId: learnerId, taskKey, status: 'in_progress', ...over }),
    );

  /**
   * One graded revision, through the real emission path: the submission row as
   * the grader leaves it, then `onVerdict` exactly as `FeedbackService` calls it,
   * then the row's clock pinned so the order is the order of events.
   */
  async function graded(
    state: PhaseStateEntity,
    minute: number,
    passed: boolean,
    issues: number,
    taskKey = 'build',
    after: PhaseStateEntity['status'] = passed ? 'submitted' : 'in_progress',
  ): Promise<SubmissionEntity> {
    const report = strict(passed, issues);
    const sub = await manager().save(
      manager().create(SubmissionEntity, {
        userId: learnerId, phaseStateId: state.id, taskKey, status: 'completed', passed, score: report.overall, report, createdAt: at(minute),
      }),
    );
    state.attempts += 1;
    const before = new Set((await manager().find(NotificationEntity)).map((row) => row.id));
    await service.onVerdict(state, sub.id, report, passed, { before: state.status, after, taskKey, taskAttempts: 1 });
    for (const row of await manager().find(NotificationEntity)) {
      if (!before.has(row.id)) await manager().update(NotificationEntity, { id: row.id }, { createdAt: at(minute + 1) });
    }
    return sub;
  }

  const learnerRows = () => manager().find(NotificationEntity, { where: { userId: learnerId }, order: { createdAt: 'ASC', id: 'ASC' } });
  const href = (state: PhaseStateEntity, sub: SubmissionEntity) =>
    `/feedback?phase=${encodeURIComponent(state.id)}&submission=${encodeURIComponent(sub.id)}`;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    emitted = [];
    const content = new ContentService();
    content.loadAll();
    phaseTitle = content.getPhaseForEnrollment({ projectSlug: 'tasktrackr', projectVersionId: null }, 'implementation').title;
    service = new NotificationsService(dataSource, content, {
      emitNotification: (userId: string, event: { unread: number }) => emitted.push({ userId, unread: event.unread }),
    } as unknown as EventsGateway);
    const teacher = await manager().save(manager().create(UserEntity, { email: 't@rg.test', passwordHash: 'x', displayName: 'Teacher', role: 'INSTRUCTOR' }));
    teacherId = teacher.id;
    const cohort = await manager().save(manager().create(CohortEntity, { name: 'RG', joinCode: 'RGBELL', ownerUserId: teacher.id }));
    const learner = await manager().save(manager().create(UserEntity, { email: 'l@rg.test', passwordHash: 'x', displayName: 'Learner', cohort: cohort.id }));
    learnerId = learner.id;
    enrollmentId = (await manager().save(manager().create(EnrollmentEntity, { userId: learnerId, projectSlug: 'tasktrackr' }))).id;
  });

  it('reproduces 6 Oct: Needs revision with threads, then a Pass with none that waits for sign-off', async () => {
    const state = await phaseState();
    const task = await taskRow(state);
    await graded(state, 1, false, 2);
    const written = await learnerRows();
    expect(written.map((row) => row.kind)).toEqual(['review.posted']);

    await manager().update(TaskStateEntity, { id: task.id }, { status: 'submitted', awaitingSignOff: true, bestScore: 100 });
    const pass = await graded(state, 5, true, 0);
    // Emission is unchanged: a thread-less Pass that opens no gate writes no row.
    expect(await learnerRows()).toEqual(written);

    const stored = JSON.stringify(await manager().find(NotificationEntity));
    const subs = JSON.stringify(await manager().find(SubmissionEntity, { order: { id: 'ASC' } }));
    const list = await service.list(learnerId);
    expect(list.unread).toBe(1);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: written[0].id,
      kind: 'review.posted',
      title: `${phaseTitle}: Pass`,
      href: href(state, pass),
    });
    expect(list.items[0].detail).toContain("Waiting for your teacher's sign-off.");
    expect(list.items[0].detail).not.toContain('Signed off');
    // The projection writes nothing.
    expect(JSON.stringify(await manager().find(NotificationEntity))).toBe(stored);
    expect(JSON.stringify(await manager().find(SubmissionEntity, { order: { id: 'ASC' } }))).toBe(subs);
  });

  it('says signed off once the teacher has countersigned that revision', async () => {
    const state = await phaseState();
    const task = await taskRow(state);
    await graded(state, 1, false, 2);
    await manager().update(TaskStateEntity, { id: task.id }, { status: 'submitted', awaitingSignOff: true });
    const pass = await graded(state, 5, true, 0);
    await manager().update(TaskStateEntity, { id: task.id }, {
      status: 'passed', awaitingSignOff: false, signedOffBy: teacherId, signedOffAt: at(30).toISOString(), passedAt: at(30).toISOString(),
    });
    const [item] = (await service.list(learnerId)).items;
    expect(item).toMatchObject({ title: `${phaseTitle}: Pass`, href: href(state, pass) });
    expect(item.detail).toContain('Signed off by your teacher.');
    expect(item.detail).not.toContain('Waiting');
  });

  it('lists only the newest review row of a phase, and the unread count follows what is listed', async () => {
    const state = await phaseState();
    await taskRow(state);
    await graded(state, 1, false, 2);
    await graded(state, 5, false, 1);
    const pass = await graded(state, 9, true, 0);
    const rows = await learnerRows();
    expect(rows.filter((row) => row.kind === 'review.posted')).toHaveLength(2);

    const list = await service.list(learnerId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: rows[1].id, title: `${phaseTitle}: Pass`, href: href(state, pass) });
    expect(list.unread).toBe(1);

    // Reading the one listed row empties the phase: the older one never comes back.
    await expect(service.markRead(learnerId, rows[1].id)).resolves.toEqual({ unread: 0 });
    await expect(service.list(learnerId)).resolves.toEqual({ items: [], unread: 0 });
  });

  it('keeps the newest verdict when it is the Needs revision, and leaves other phases and gates alone', async () => {
    const state = await phaseState();
    await taskRow(state);
    await graded(state, 1, false, 2);
    const latest = await graded(state, 5, false, 1);
    const testing = await phaseState('testing', 4);
    await taskRow(testing);
    const testingFail = await graded(testing, 10, false, 3);
    await service.notify({
      userId: learnerId, audience: 'learner', kind: 'gate.passed', subjectKey: 'gate-subject', title: 'Design: Pass',
      detail: 'Merge it to open Implementation', href: '/workspace/x/pr', phaseKey: 'design',
    });
    const list = await service.list(learnerId);
    expect(list.unread).toBe(3);
    expect(list.items.map((item) => [item.kind, item.title, item.href])).toEqual(
      expect.arrayContaining([
        ['review.posted', `${phaseTitle}: Needs revision`, href(state, latest)],
        ['review.posted', expect.stringMatching(/: Needs revision$/), href(testing, testingFail)],
        ['gate.passed', 'Design: Pass', '/workspace/x/pr'],
      ]),
    );
    expect(list.items).toHaveLength(3);
    // The badge pushed with a new row counts what the list shows, not the hidden row.
    expect(emitted[emitted.length - 1]).toEqual({ userId: learnerId, unread: 3 });
  });

  it('does not let another task s revision relabel a task s verdict', async () => {
    const state = await phaseState();
    await taskRow(state, 'story');
    await taskRow(state, 'interview');
    const story = await graded(state, 1, false, 2, 'story');
    await graded(state, 5, true, 0, 'interview');
    const [item] = (await service.list(learnerId)).items;
    expect(item).toMatchObject({ title: `${phaseTitle}: Needs revision`, href: href(state, story) });
  });
});

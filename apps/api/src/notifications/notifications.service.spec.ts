import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SOLE_TASK_KEY } from '@learnsdlc/shared';
import type { FeedbackReport, PhaseKey, StuckFlag } from '@learnsdlc/shared';
import { STUCK_ATTEMPTS } from '../analytics/signals';
import { nextPhaseStatus } from '../feedback/checkers';
import {
  ALL_ENTITIES,
  CohortEntity,
  CohortPhaseScheduleEntity,
  EnrollmentEntity,
  NotificationEntity,
  PhaseStateEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { ContentService } from '../content/content.service';
import { EventsGateway } from '../events/events.gateway';
import {
  DRILL_UNRESOLVED_HOURS,
  NOTIFICATION_MAX_AGE_DAYS,
  NOTIFICATION_READ_MAX_AGE_DAYS,
  NOTIFICATIONS_KEPT_PER_USER,
  NotificationsService,
  NotifyInput,
  VerdictTransition,
} from './notifications.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The bell.
 *
 * Three things have to hold or it is worse than nothing. It must not repeat
 * itself: a drill open for three days is one row, not one every quarter of an
 * hour, and the partial unique index rather than a read is what settles that
 * against a sweep and a verdict landing together. It must not leak: one
 * learner's row is a 404 to another, never a 403. And it must never be the
 * reason a verdict, a flag or a boot fails, because a notification is a
 * pointer and the grade is the record.
 */
describe('NotificationsService', () => {
  let dataSource: DataSource;
  let service: NotificationsService;
  let emitted: { userId: string; unread: number }[] = [];

  const manager = () => dataSource.manager;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  let learnerId = '';
  let otherLearnerId = '';
  let instructorId = '';
  let cohortId = '';
  let enrollmentId = '';

  const rowsFor = (userId: string) =>
    manager().find(NotificationEntity, { where: { userId }, order: { createdAt: 'ASC' } });

  const input = (over: Partial<NotifyInput> = {}): NotifyInput => ({
    userId: learnerId,
    audience: 'learner',
    kind: 'gate.passed',
    subjectKey: 'ps-1',
    title: 'Testing passed with 86',
    detail: 'Merge it to open Deployment',
    href: '/workspace/ps-1/pr',
    phaseKey: 'testing',
    ...over,
  });

  /**
   * The transition a **sole-task** phase hands the bell.
   *
   * A sole-task phase's roll-up *is* `nextPhaseStatus`, so
   * `after === 'passed' && before !== 'passed'` is `passed && state.status !==
   * 'passed'` term for term: the phase-level form of the guard.
   * `taskAttempts` is null because a sole task has no
   * `task_states` row, which is what keeps `class.stuck` comparing the
   * phase counter.
   */
  const soleTransition = (state: PhaseStateEntity, passed: boolean): VerdictTransition => ({
    before: state.status,
    after: nextPhaseStatus(state.status, passed),
    taskKey: SOLE_TASK_KEY,
    taskAttempts: null,
  });

  /** A phase state on the learner's own enrolment, with whatever is under test on it. */
  const phaseState = async (over: Partial<PhaseStateEntity> = {}): Promise<PhaseStateEntity> =>
    manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId,
        userId: learnerId,
        phaseKey: 'deployment' as PhaseKey,
        phaseOrder: 5,
        status: 'in_progress',
        attempts: 0,
        ...over,
      }),
    );

  const report = (over: Partial<FeedbackReport> = {}): FeedbackReport =>
    ({
      overall: 86,
      passed: true,
      passThreshold: 70,
      criteria: [],
      checks: [],
      aiReview: { summary: '', strengths: [], improvements: [], processNote: '' },
      aiReliance: { hintsThisPhase: 0, index: 0 },
      integrity: { relianceFlag: false, mentorPasteFlag: false, noEffortFlag: false },
      ...over,
    }) as unknown as FeedbackReport;

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
    service = new NotificationsService(dataSource, content, {
      emitNotification: (userId: string, event: { unread: number }) => {
        emitted.push({ userId, unread: event.unread });
      },
    } as unknown as EventsGateway);

    const instructor = await manager().save(
      manager().create(UserEntity, {
        email: 'ana@class.edu',
        passwordHash: 'x',
        displayName: 'Ana Tan',
        role: 'INSTRUCTOR',
      }),
    );
    instructorId = instructor.id;
    const cohort = await manager().save(
      manager().create(CohortEntity, {
        name: 'Monday class',
        joinCode: 'MON-1',
        ownerUserId: instructor.id,
      }),
    );
    cohortId = cohort.id;
    await manager().update(UserEntity, instructor.id, { cohort: cohortId });

    const learner = await manager().save(
      manager().create(UserEntity, {
        email: 'amir@class.edu',
        passwordHash: 'x',
        displayName: 'Amir Rahman',
        cohort: cohortId,
      }),
    );
    learnerId = learner.id;
    const other = await manager().save(
      manager().create(UserEntity, {
        email: 'wei@class.edu',
        passwordHash: 'x',
        displayName: 'Wei Ling',
        cohort: cohortId,
      }),
    );
    otherLearnerId = other.id;

    const enrolment = await manager().save(
      manager().create(EnrollmentEntity, { userId: learnerId, projectSlug: 'tasktrackr' }),
    );
    enrollmentId = enrolment.id;
  });

  /* --------------------------------- notify -------------------------------- */

  it('writes a row and hands back the view the panel draws', async () => {
    const view = await service.notify(input());

    expect(view).toMatchObject({
      kind: 'gate.passed',
      audience: 'learner',
      title: 'Testing passed with 86',
      detail: 'Merge it to open Deployment',
      href: '/workspace/ps-1/pr',
      phaseKey: 'testing',
      readAt: null,
    });
    expect(await rowsFor(learnerId)).toHaveLength(1);
    // The badge arrives with the row, so the panel needs no second request.
    expect(emitted).toEqual([{ userId: learnerId, unread: 1 }]);
  });

  it('writes nothing when an unread row already says the same thing', async () => {
    const first = await service.notify(input());
    const again = await service.notify(input({ title: 'Testing passed with 91' }));

    const rows = await rowsFor(learnerId);
    // The row count, not the return value: this is the partial unique index
    // doing the work, and without it there would be two.
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Testing passed with 86');
    expect(rows[0].id).toBe(first!.id);
    expect(again).toBeNull();
  });

  it('says it again once the first one has been read', async () => {
    const first = await service.notify(input());
    await service.markRead(learnerId, first!.id);

    expect(await service.notify(input())).not.toBeNull();
    expect(await rowsFor(learnerId)).toHaveLength(2);
  });

  it('lists only the unread, newest first, and counts them all', async () => {
    for (let i = 0; i < 3; i += 1) {
      const view = await service.notify(input({ subjectKey: `ps-${i}`, title: `Row ${i}` }));
      // Explicit, so the order is the order they were made rather than whatever
      // fits in one sqlite second: the same trap the audit trail's index
      // comment names, and the reason `id` is the third column of that index.
      await manager()
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({ createdAt: new Date(Date.now() - (3 - i) * 60_000) })
        .where({ id: view!.id })
        .execute();
    }
    const oldest = (await rowsFor(learnerId))[0];
    await service.markRead(learnerId, oldest.id);

    const list = await service.list(learnerId, 1);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].title).toBe('Row 2');
    // The true count, not the length of the page.
    expect(list.unread).toBe(2);
  });

  /* -------------------------------- markRead ------------------------------- */

  it('refuses another learner s row with a 404 and changes nothing', async () => {
    const mine = await service.notify(input());

    await expect(service.markRead(otherLearnerId, mine!.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await rowsFor(learnerId))[0].readAt).toBeNull();
  });

  it('treats a second mark-read as done rather than as an error', async () => {
    const mine = await service.notify(input());
    await service.markRead(learnerId, mine!.id);

    await expect(service.markRead(learnerId, mine!.id)).resolves.toEqual({ unread: 0 });
  });

  it('empties the block on mark-all, and a second call is a no-op', async () => {
    await service.notify(input({ subjectKey: 'a' }));
    await service.notify(input({ subjectKey: 'b' }));

    await expect(service.markAllRead(learnerId)).resolves.toEqual({ unread: 0 });
    await expect(service.markAllRead(learnerId)).resolves.toEqual({ unread: 0 });
    expect((await rowsFor(learnerId)).every((row) => row.readAt)).toBe(true);
  });

  describe('binary notification projections', () => {
    const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`);
    const savedReview = async (state: PhaseStateEntity, day: number, over: Partial<SubmissionEntity> = {}) => manager().save(manager().create(SubmissionEntity, {
      userId: state.userId, phaseStateId: state.id, status: 'completed', passed: true,
      report: report({ assessmentMode: 'strict_binary', passed: true }), createdAt: at(day), ...over,
    }));
    const oldGate = async (state: PhaseStateEntity, day: number, over: Partial<NotificationEntity> = {}) => manager().save(manager().create(NotificationEntity, {
      ...input({ subjectKey: state.id, phaseKey: state.phaseKey }), createdAt: at(day), ...over,
    }));

    it('projects an existing strict Pass from owned first-pass evidence without changing the stored event or report', async () => {
      const state = await phaseState({ phaseKey: 'testing' });
      const submission = await savedReview(state, 1);
      const event = await oldGate(state, 2);
      const before = await manager().findOneByOrFail(SubmissionEntity, { id: submission.id });
      const list = await service.list(learnerId);
      expect(list.items[0]).toMatchObject({ id: event.id, title: 'Testing: Pass', detail: event.detail, href: event.href });
      expect(await manager().findOneByOrFail(NotificationEntity, { id: event.id })).toEqual(event);
      expect(await manager().findOneByOrFail(SubmissionEntity, { id: submission.id })).toEqual(before);
    });

    it('keeps a legacy-mode gate unchanged when a later revision uses binary grading', async () => {
      const state = await phaseState({ phaseKey: 'testing' });
      await savedReview(state, 1, { report: report() });
      await savedReview(state, 3);
      const event = await oldGate(state, 2);
      expect((await service.list(learnerId)).items[0].title).toBe(event.title);
    });

    it.each(['missing', 'later', 'different-owner', 'different-phase', 'ambiguous-time', 'contradictory-report'] as const)('does not relabel %s first-pass evidence as a verified binary event', async kind => {
      const state = await phaseState({ phaseKey: 'testing' });
      if (kind !== 'missing') await savedReview(state, kind === 'later' ? 3 : 1, {
        ...(kind === 'different-owner' ? { userId: otherLearnerId } : {}),
        ...(kind === 'different-phase' ? { phaseStateId: 'unrelated-phase' } : {}),
        ...(kind === 'contradictory-report' ? { report: report({ assessmentMode: 'strict_binary', passed: false }) } : {}),
      });
      if (kind === 'ambiguous-time') await savedReview(state, 1, { report: report() });
      const event = await oldGate(state, 2);
      expect((await service.list(learnerId)).items[0].title).toBe(event.title);
    });

    it('projects exact owned Needs revision feedback, keeps thread information and links that revision', async () => {
      const state = await phaseState({ phaseKey: 'testing' });
      const submission = await savedReview(state, 1, { passed: false, report: report({ assessmentMode: 'strict_binary', passed: false, staticAnalysis: { issues: [{ rule: 'example', path: 'test.py', line: 1, severity: 'warning', message: 'Missing boundary' }] } } as Partial<FeedbackReport>) });
      const event = await oldGate(state, 2, { kind: 'review.posted', subjectKey: submission.id, title: 'The QA lead left 1 thread on your pull request', detail: 'Testing, submission 2' });
      expect((await service.list(learnerId)).items[0]).toMatchObject({
        title: 'Testing: Needs revision', detail: '1 review thread. Testing, submission 2',
        href: `/feedback?phase=${state.id}&submission=${submission.id}`,
      });
      // The row is read as the phase's latest verdict, linking the later
      // revision, so the bell does not stay on the first Needs revision for
      // ever; the stored row is unchanged.
      const later = await savedReview(state, 3);
      expect((await service.list(learnerId)).items[0]).toMatchObject({
        title: 'Testing: Pass', detail: '0 review threads.',
        href: `/feedback?phase=${state.id}&submission=${later.id}`,
      });
      expect(await manager().findOneByOrFail(NotificationEntity, { id: event.id })).toEqual(event);
    });

    it("does not resolve another learner\'s exact review through a forged subject", async () => {
      const state = await phaseState({ phaseKey: 'testing' });
      const submission = await savedReview(state, 1, { userId: otherLearnerId });
      const event = await oldGate(state, 2, { kind: 'review.posted', subjectKey: submission.id });
      expect((await service.list(learnerId)).items[0].title).toBe(event.title);
    });
  });

  /* -------------------------------- onVerdict ------------------------------ */

  describe('onVerdict', () => {
    it('tells the learner their gate opened, and tells nobody about a class they are not in', async () => {
      await manager().update(UserEntity, learnerId, { cohort: 'default' });
      const state = await phaseState({ phaseKey: 'testing', phaseOrder: 4, attempts: 1 });

      await service.onVerdict(state, 'sub-1', report(), true, soleTransition(state, true));

      const rows = await rowsFor(learnerId);
      expect(rows.map((row) => row.kind)).toEqual(['gate.passed']);
      expect(rows[0].title).toBe('Testing passed with 86');
      expect(rows[0].detail).toBe('Merge it to open Deployment');
      // `default` is the absence of a class, so it has no owner to tell.
      expect(await rowsFor(instructorId)).toHaveLength(0);
    });

    it.each([true, false])('writes the strict %s verdict without a numerical score, retaining thread context', async passed => {
      const state = await phaseState({ phaseKey: 'testing', phaseOrder: 4, attempts: 2 });
      await service.onVerdict(state, 'strict-submission', report({
        assessmentMode: 'strict_binary', passed, overall: passed ? 100 : 99,
        staticAnalysis: { issues: [{ rule: 'example', path: 'test.py', line: 1, severity: 'warning', message: 'Review this boundary' }] },
      } as Partial<FeedbackReport>), passed, soleTransition(state, passed));
      const rows = await rowsFor(learnerId);
      expect(rows.find(row => row.kind === 'gate.passed')?.title).toBe(passed ? 'Testing: Pass' : undefined);
      expect(rows.find(row => row.kind === 'review.posted')).toMatchObject({
        title: `Testing: ${passed ? 'Pass' : 'Needs revision'}`,
        detail: '1 review thread. Testing, submission 2',
        href: `/feedback?phase=${state.id}&submission=strict-submission`,
      });
      expect(rows.every(row => !row.title.includes('100') && !row.title.includes('99'))).toBe(true);
    });

    it('says nothing about a gate that had already opened', async () => {
      const state = await phaseState({ phaseKey: 'testing', phaseOrder: 4, status: 'passed' });

      await service.onVerdict(state, 'sub-1', report(), true, soleTransition(state, true));

      expect(await rowsFor(learnerId)).toHaveLength(0);
    });

    it('raises the class queue s own sentence on a second failing attempt', async () => {
      const state = await phaseState({
        phaseKey: 'testing',
        phaseOrder: 4,
        attempts: 2,
        bestScore: 61,
      });

      await service.onVerdict(state, 'sub-2', report({ overall: 55, passed: false }), false, soleTransition(state, false));

      const staff = await rowsFor(instructorId);
      expect(staff).toHaveLength(1);
      expect(staff[0].kind).toBe('class.stuck');
      expect(staff[0].title).toBe('Amir Rahman is stuck in Testing');
      expect(staff[0].detail).toBe('2 submissions; the latest work needs revision.');
      expect(staff[0].href).toBe(`/instructor/learners/${learnerId}`);
    });

    it('says nothing to the instructor about a first failing attempt', async () => {
      const state = await phaseState({ phaseKey: 'testing', phaseOrder: 4, attempts: 1 });

      await service.onVerdict(state, 'sub-1', report({ overall: 40, passed: false }), false, soleTransition(state, false));

      expect(await rowsFor(instructorId)).toHaveLength(0);
    });

    it('raises an integrity flag with the reason the console gives', async () => {
      const state = await phaseState({ phaseKey: 'implementation', phaseOrder: 3, attempts: 1 });

      await service.onVerdict(
        state,
        'sub-3',
        report({
          integrity: { relianceFlag: false, mentorPasteFlag: true, noEffortFlag: false },
        } as Partial<FeedbackReport>),
        true,
        soleTransition(state, true),
      );

      const staff = await rowsFor(instructorId);
      expect(staff.map((row) => row.kind)).toEqual(['class.integrity']);
      expect(staff[0].title).toBe('An integrity flag on Amir Rahman s latest submission'.replace(' s ', "'s "));
      expect(staff[0].detail).toBe('Implementation: a passage matches a mentor reply');
    });

    it('tells the learner how many threads the reviewer left', async () => {
      const state = await phaseState({ phaseKey: 'testing', phaseOrder: 4, attempts: 3 });

      await service.onVerdict(
        state,
        'sub-4',
        report({
          overall: 50,
          passed: false,
          tests: {
            cases: [
              { name: 'a', status: 'failed', frames: [{ path: 'tasktrackr/manager.py', line: 56 }] },
              { name: 'b', status: 'failed', frames: [] },
              { name: 'c', status: 'passed', frames: [] },
            ],
          },
          staticAnalysis: {
            issues: [
              { rule: 'bare-except', path: 'tasktrackr/manager.py', line: 12, severity: 'warning', message: 'x' },
              { rule: 'note', path: 'tasktrackr/manager.py', line: 13, severity: 'info', message: 'x' },
            ],
          },
        } as unknown as Partial<FeedbackReport>),
        false,
        soleTransition(state, false),
      );

      const rows = await rowsFor(learnerId);
      const review = rows.find((row) => row.kind === 'review.posted');
      expect(review?.title).toBe('The QA lead left 2 threads on your pull request');
      expect(review?.detail).toBe('Testing, submission 3');
    });

    it('never throws, so a verdict is never lost to the bell', async () => {
      const state = await phaseState();
      const broken = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ALL_ENTITIES,
        synchronize: false,
      });
      const content = new ContentService();
      content.loadAll();
      const doomed = new NotificationsService(broken, content, {
        emitNotification: () => undefined,
      } as unknown as EventsGateway);

      await expect(
        doomed.onVerdict(state, 'sub-1', report(), true, soleTransition(state, true)),
      ).resolves.toBeUndefined();
    });

    /* ------------ the task grain (teacher-authored projects) --------------- */

    it('rings when the phase opens, not when the first task does', async () => {
      const state = await phaseState({ phaseKey: 'requirements', phaseOrder: 1, attempts: 1 });

      // The first required task of two passes. The verdict is a pass, and the
      // guard written against `passed && state.status !== 'passed'` would ring
      // here: on a gate that has not opened and a Merge button that is dark.
      await service.onVerdict(state, 'sub-1', report(), true, {
        before: 'in_progress',
        after: 'submitted',
        taskKey: 'story',
        taskAttempts: 1,
      });
      expect(await rowsFor(learnerId)).toHaveLength(0);

      // The second one passes and the roll-up opens the phase. That is the news.
      await service.onVerdict(state, 'sub-2', report(), true, {
        before: 'submitted',
        after: 'passed',
        taskKey: 'scope',
        taskAttempts: 1,
      });
      const rows = await rowsFor(learnerId);
      expect(rows.map((row) => row.kind)).toEqual(['gate.passed']);
    });

    it('rings once, however many task verdicts land on an open phase', async () => {
      const state = await phaseState({ phaseKey: 'requirements', phaseOrder: 1, attempts: 3 });

      await service.onVerdict(state, 'sub-3', report(), true, {
        before: 'passed',
        after: 'passed',
        taskKey: 'story',
        taskAttempts: 2,
      });

      expect(await rowsFor(learnerId)).toHaveLength(0);
    });

    it('counts one task s tries for class.stuck, not three first tries', async () => {
      // A three-task phase at one attempt each. The phase counter is a sum
      // over tasks, so it reaches the
      // threshold on three *first* tries, and telling a teacher that a
      // learner is stuck when they have had one go at each of three pieces of
      // work is the bell crying wolf.
      const spread = await phaseState({ phaseKey: 'requirements', phaseOrder: 1, attempts: 3, bestScore: 40 });

      await service.onVerdict(spread, 'sub-1', report({ overall: 40, passed: false }), false, {
        before: 'in_progress',
        after: 'submitted',
        taskKey: 'story',
        taskAttempts: 1,
      });
      expect(await rowsFor(instructorId)).toHaveLength(0);

      // One task at the threshold is stuck, which is what the threshold has
      // always meant.
      await service.onVerdict(spread, 'sub-2', report({ overall: 40, passed: false }), false, {
        before: 'submitted',
        after: 'submitted',
        taskKey: 'story',
        taskAttempts: STUCK_ATTEMPTS,
      });
      const staff = await rowsFor(instructorId);
      expect(staff.map((row) => row.kind)).toEqual(['class.stuck']);
    });

    it('for a sole task the guard is the predicate it is today', async () => {
      // Every status and every verdict, as the bell sees them: with no task
      // row the phase's transition IS `nextPhaseStatus`, so the task-grain
      // guard and the phase-level one answer the same thing.
      for (const before of ['locked', 'in_progress', 'submitted', 'passed'] as const) {
        for (const passed of [true, false]) {
          const transition = soleTransition({ status: before } as PhaseStateEntity, passed);
          expect(transition.after === 'passed' && transition.before !== 'passed').toBe(
            passed && before !== 'passed' && before !== 'locked',
          );
          expect(transition.taskAttempts).toBeNull();
        }
      }
    });
  });

  /* ---------------------------------- notes -------------------------------- */

  describe('the instructor s note', () => {
    const caller = () => ({ id: instructorId, role: 'INSTRUCTOR' as const, cohort: cohortId });

    it('reaches a learner in the caller s class, signed and audited', async () => {
      await expect(service.note(caller(), learnerId, 'Read the boundary rule again.')).resolves.toEqual({
        sent: true,
      });

      const rows = await rowsFor(learnerId);
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('A note from Ana Tan');
      expect(rows[0].detail).toBe('Read the boundary rule again.');
      expect(rows[0].href).toBe('/dashboard');
    });

    it('opens the phase it names', async () => {
      const state = await phaseState({ phaseKey: 'implementation', phaseOrder: 3 });

      await service.note(caller(), learnerId, 'Look at manager.py, line 56.', state.id);

      const rows = await rowsFor(learnerId);
      expect(rows[0].href).toBe(`/workspace/${state.id}`);
      expect(rows[0].phaseKey).toBe('implementation');
    });

    it('refuses a learner in somebody else s class', async () => {
      const stranger = await manager().save(
        manager().create(UserEntity, {
          email: 'bo@class.edu',
          passwordHash: 'x',
          displayName: 'Bo',
          role: 'INSTRUCTOR',
        }),
      );
      const friday = await manager().save(
        manager().create(CohortEntity, {
          name: 'Friday class',
          joinCode: 'FRI-1',
          ownerUserId: stranger.id,
        }),
      );
      await manager().update(UserEntity, stranger.id, { cohort: friday.id });

      await expect(
        service.note({ id: stranger.id, role: 'INSTRUCTOR', cohort: friday.id }, learnerId, 'Hello'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await rowsFor(learnerId)).toHaveLength(0);
    });

    it('never collapses two notes into one, however alike they are', async () => {
      await service.note(caller(), learnerId, 'Same words');
      await service.note(caller(), learnerId, 'Same words');

      expect(await rowsFor(learnerId)).toHaveLength(2);
    });
  });

  /* ---------------------------------- sweep -------------------------------- */

  describe('sweep', () => {
    const drill = (hoursAgo: number, over: Record<string, unknown> = {}) => ({
      fault: 'the entrypoint',
      pagedAt: new Date(Date.now() - hoursAgo * HOUR).toISOString(),
      runbookBefore: null,
      healthRanAt: null,
      healthExit: null,
      fixAppliedAt: null,
      resolvedAt: null,
      incident: null,
      ...over,
    });

    it('says a drill is still open at 25 hours and not at 23', async () => {
      const stale = await phaseState({ drill: drill(DRILL_UNRESOLVED_HOURS + 1) as never });
      await phaseState({ phaseOrder: 6, drill: drill(DRILL_UNRESOLVED_HOURS - 1) as never });

      await service.sweep();

      const rows = (await rowsFor(learnerId)).filter((row) => row.kind === 'drill.unresolved');
      expect(rows).toHaveLength(1);
      expect(rows[0].subjectKey).toBe(stale.id);
      expect(rows[0].title).toBe('INCIDENT-1 is still open');
      expect(rows[0].href).toBe(`/workspace/${stale.id}/drill`);
    });

    it('says nothing about a drill that was resolved, or a phase that passed', async () => {
      await phaseState({ drill: drill(48, { resolvedAt: new Date().toISOString() }) as never });
      await phaseState({ phaseOrder: 6, status: 'passed', drill: drill(48) as never });

      await service.sweep();

      expect(await rowsFor(learnerId)).toHaveLength(0);
    });

    it('writes one row however many times it runs', async () => {
      await phaseState({ drill: drill(48) as never });

      await service.sweep();
      await service.sweep();
      await service.sweep();

      expect(await rowsFor(learnerId)).toHaveLength(1);
    });

    it('tells a class its phase is due, once per due date', async () => {
      await phaseState({ phaseKey: 'design', phaseOrder: 2 });
      const due = new Date(Date.now() + 2 * DAY);
      await manager().save(
        manager().create(CohortPhaseScheduleEntity, {
          cohortId,
          projectSlug: 'tasktrackr',
          phaseKey: 'design',
          opensAt: null,
          dueAt: due.toISOString(),
        }),
      );

      await service.sweep();
      await service.sweep();

      const rows = (await rowsFor(learnerId)).filter((row) => row.kind === 'deadline.near');
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe('Design is due in 2 days');
      expect(rows[0].href).toBe('/phases');
    });

    it('says nothing about a phase that has passed, or a date beyond the window', async () => {
      await phaseState({ phaseKey: 'design', phaseOrder: 2, status: 'passed' });
      await manager().save(
        manager().create(CohortPhaseScheduleEntity, {
          cohortId,
          projectSlug: 'tasktrackr',
          phaseKey: 'design',
          opensAt: null,
          dueAt: new Date(Date.now() + 2 * DAY).toISOString(),
        }),
      );
      await phaseState({ phaseKey: 'testing', phaseOrder: 4 });
      await manager().save(
        manager().create(CohortPhaseScheduleEntity, {
          cohortId,
          projectSlug: 'tasktrackr',
          phaseKey: 'testing',
          opensAt: null,
          dueAt: new Date(Date.now() + 30 * DAY).toISOString(),
        }),
      );

      await service.sweep();

      expect(await rowsFor(learnerId)).toHaveLength(0);
    });

    /** Rows are written through the service, then aged by hand: only `createdAt` is a clock. */
    const aged = async (daysAgo: number, read: boolean, subjectKey: string): Promise<void> => {
      const view = await service.notify(input({ subjectKey }));
      await manager()
        .createQueryBuilder()
        .update(NotificationEntity)
        .set({
          createdAt: new Date(Date.now() - daysAgo * DAY),
          readAt: read ? new Date().toISOString() : null,
        })
        .where({ id: view!.id })
        .execute();
    };

    it('prunes a read row after a week, keeps an unread one, and drops anything past a month', async () => {
      await aged(NOTIFICATION_READ_MAX_AGE_DAYS + 1, true, 'read-old');
      await aged(NOTIFICATION_READ_MAX_AGE_DAYS + 1, false, 'unread-old');
      await aged(NOTIFICATION_MAX_AGE_DAYS + 1, false, 'ancient');
      await aged(1, true, 'read-new');

      const result = await service.sweep();

      expect(result.pruned).toBe(2);
      expect((await rowsFor(learnerId)).map((row) => row.subjectKey).sort()).toEqual([
        'read-new',
        'unread-old',
      ]);
    });

    it('keeps the newest two hundred rows an account has, and no more', async () => {
      const many = Array.from({ length: NOTIFICATIONS_KEPT_PER_USER + 50 }, (_, i) =>
        manager().create(NotificationEntity, {
          userId: learnerId,
          audience: 'learner' as const,
          kind: 'gate.passed' as const,
          subjectKey: `bulk-${i}`,
          title: `Row ${i}`,
          detail: null,
          href: '/dashboard',
          phaseKey: null,
          actorUserId: null,
          // Read, so the per-user cap is the only rule that can touch them.
          readAt: new Date().toISOString(),
          createdAt: new Date(Date.now() - (NOTIFICATIONS_KEPT_PER_USER + 50 - i) * 60_000),
        }),
      );
      await manager().save(many);

      await service.sweep();

      const left = await rowsFor(learnerId);
      expect(left).toHaveLength(NOTIFICATIONS_KEPT_PER_USER);
      expect(left[0].subjectKey).toBe('bulk-50');
    });

    it('swallows its own failure rather than failing a boot', async () => {
      const broken = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ALL_ENTITIES,
        synchronize: false,
      });
      const content = new ContentService();
      content.loadAll();
      const doomed = new NotificationsService(broken, content, {
        emitNotification: () => undefined,
      } as unknown as EventsGateway);

      await expect(doomed.sweepAndLog()).resolves.toEqual({ written: 0, pruned: 0 });
    });
  });

  /* -------------------------------- the flag ------------------------------- */

  describe('the stuck flag', () => {
    const flag = (over: Partial<StuckFlag> = {}): StuckFlag => ({
      raisedAt: '2026-03-05T09:00:00.000Z',
      question: 'I cannot tell whether a task due today belongs in the overdue report',
      tried: 'I read the backlog.',
      answeredAt: null,
      answeredBy: null,
      answeredByName: null,
      answer: null,
      clearedAt: null,
      ...over,
    });

    it('raises the class owner s bell in the learner s own words', async () => {
      const state = await phaseState({ phaseKey: 'deployment', phaseOrder: 5 });

      await service.onStuckRaised(state, flag());

      const staff = await rowsFor(instructorId);
      expect(staff).toHaveLength(1);
      expect(staff[0].kind).toBe('class.help');
      expect(staff[0].title).toBe('Amir Rahman raised a stuck flag in Deployment');
      expect(staff[0].detail).toContain('overdue report');
      expect(staff[0].href).toBe(`/instructor/learners/${learnerId}`);
    });

    it('tells the learner when it is answered, in the room it was raised in', async () => {
      const state = await phaseState({ phaseKey: 'deployment', phaseOrder: 5 });

      await service.onStuckAnswered(
        state,
        flag({ answeredAt: '2026-03-05T09:20:00.000Z', answeredBy: instructorId }),
      );

      const rows = await rowsFor(learnerId);
      expect(rows[0].kind).toBe('stuck.answered');
      expect(rows[0].title).toBe('Your instructor answered your stuck flag');
      expect(rows[0].detail).toBe('Deployment');
      expect(rows[0].href).toBe(`/workspace/${state.id}`);
    });

    it('says nothing to an instructor about an unattached learner', async () => {
      // `default` is the absence of a class rather than a quiet one (decision
      // 2), so even a row that claims to own it owns nobody. The row is here
      // on purpose: without it the sentinel would never be reached, and this
      // would pass for the wrong reason.
      await manager().save(
        manager().create(CohortEntity, {
          id: 'default',
          name: 'Unattached',
          joinCode: 'DEF-1',
          ownerUserId: instructorId,
        }),
      );
      await manager().update(UserEntity, learnerId, { cohort: 'default' });
      const state = await phaseState();

      await service.onStuckRaised(state, flag());

      expect(await rowsFor(instructorId)).toHaveLength(0);
    });
  });
});

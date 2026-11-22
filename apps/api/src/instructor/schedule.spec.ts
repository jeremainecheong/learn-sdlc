import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import {
  ALL_ENTITIES,
  CohortEntity,
  CohortPhaseScheduleEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { InstructorCaller } from './cohort-scope';
import {
  ScheduleService,
  describeInstant,
  effectivePhaseStatus,
  isLate,
  opensAtMessage,
  scheduleForLearner,
  scheduledShut,
} from './schedule.service';
import { memoryDataSource } from '../../test/support/memory-db';

const HOUR = 3_600_000;
const soon = (ms: number): string => new Date(Date.now() + ms).toISOString();

/**
 * The class's dates: when a phase opens, and when its work is due.
 *
 * The one thing these tests exist to hold down is stated as a risk in the
 * plan: if the card computes the effective status but the route reads the row,
 * a learner sees a locked phase and can still submit to it. So every
 * assertion here comes in a pair (what the board says, and what the route
 * does) and both go through the same helper.
 */
describe('the class schedule', () => {
  describe('the pure helpers', () => {
    it('shuts a phase whose open date has not arrived and opens it once it has', () => {
      expect(scheduledShut(soon(HOUR))).toBe(true);
      expect(scheduledShut(soon(-HOUR))).toBe(false);
      expect(scheduledShut(null)).toBe(false);
    });

    it('opens a phase whose date cannot be read, rather than locking a class out over a typo', () => {
      expect(scheduledShut('the ninth of September')).toBe(false);
    });

    it('overlays the row rather than rewriting it', () => {
      expect(effectivePhaseStatus('in_progress', soon(HOUR))).toBe('locked');
      expect(effectivePhaseStatus('in_progress', soon(-HOUR))).toBe('in_progress');
      // A phase that is already passed is still shown against the date it
      // opened on, because the overlay is about reaching the work, not the
      // verdict, and the date is in the past for anyone who has passed it.
      expect(effectivePhaseStatus('passed', soon(-HOUR))).toBe('passed');
      expect(effectivePhaseStatus('in_progress', null)).toBe('in_progress');
    });

    it('derives lateness from the due date, so moving the date moves the answer', () => {
      const made = new Date('2026-09-16T22:00:00.000Z');
      expect(isLate(made, '2026-09-16T23:59:00.000Z')).toBe(false);
      expect(isLate(made, '2026-09-15T23:59:00.000Z')).toBe(true);
      // No date at all is no lateness, which is the state of every class that
      // never opens the panel.
      expect(isLate(made, null)).toBe(false);
    });

    it('says when the phase opens, in a sentence a learner can act on', () => {
      const at = '2026-09-09T01:00:00.000Z';
      expect(describeInstant(at, 'Asia/Singapore')).toBe('9 September at 09:00');
      expect(opensAtMessage(at, 'Asia/Singapore')).toBe(
        'This phase opens on 9 September at 09:00.',
      );
    });
  });

  describe('the panel and the gate', () => {
    let dataSource: DataSource;
    let content: ContentService;
    let schedule: ScheduleService;
    let workflow: WorkflowService;
    let enrollments: Repository<EnrollmentEntity>;
    let phaseStates: Repository<PhaseStateEntity>;
    let releases: Repository<ReleaseRecordEntity>;

    let dana: InstructorCaller;
    let sam: InstructorCaller;
    let cohortId = '';
    let otherCohortId = '';
    let learnerId = '';
    const manager = () => dataSource.manager;

    const saveUser = (fields: Partial<UserEntity>) =>
      manager().save(
        manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }),
      );

    beforeAll(async () => {
      dataSource = await memoryDataSource();
      content = new ContentService();
      content.loadAll();
      enrollments = dataSource.getRepository(EnrollmentEntity);
      phaseStates = dataSource.getRepository(PhaseStateEntity);
      releases = dataSource.getRepository(ReleaseRecordEntity);
      schedule = new ScheduleService(dataSource, content);
      workflow = new WorkflowService(
        enrollments,
        phaseStates,
        releases,
        content,
        { latestFor: async () => null } as unknown as FeedbackService,
        dataSource,
      );
    });

    afterAll(async () => {
      if (dataSource.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
      for (const entity of ALL_ENTITIES) await manager().clear(entity);
      const danaRow = await saveUser({ email: 'dana@learnsdlc.test', role: 'INSTRUCTOR' });
      const samRow = await saveUser({ email: 'sam@learnsdlc.test', role: 'INSTRUCTOR' });
      const tuesday = await manager().save(
        manager().create(CohortEntity, {
          name: 'Tuesday class',
          joinCode: 'ABCDEFGH',
          ownerUserId: danaRow.id,
        }),
      );
      const thursday = await manager().save(
        manager().create(CohortEntity, {
          name: 'Thursday class',
          joinCode: 'JKLMNPQR',
          ownerUserId: samRow.id,
        }),
      );
      cohortId = tuesday.id;
      otherCohortId = thursday.id;
      dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday.id };
      sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday.id };
      learnerId = (
        await saveUser({ email: 'lee@learnsdlc.test', displayName: 'Lee', cohort: tuesday.id })
      ).id;
      await workflow.enroll(learnerId, 'tasktrackr');
    });

    const setDates = (phaseKey: string, opensAt: string | null, dueAt: string | null) =>
      schedule.saveSchedule(dana, cohortId, {
        projectSlug: 'tasktrackr',
        phases: [{ phaseKey: phaseKey as never, opensAt, dueAt }],
      });

    it('starts with every cell blank and nothing scheduled', async () => {
      const view = await schedule.getSchedule(dana, cohortId, 'tasktrackr');
      expect(view.phases).toHaveLength(6);
      expect(view.phases.every((row) => row.opensAt === null && row.dueAt === null)).toBe(true);
      expect(view.projectSlug).toBe('tasktrackr');
    });

    it('draws a phase locked and refuses the route with the same sentence, from the same helper', async () => {
      const opensAt = soon(2 * HOUR);
      await setDates('requirements', opensAt, null);

      const board = await workflow.myEnrollment(learnerId, 'tasktrackr');
      const first = board!.phases.find((phase) => phase.key === 'requirements')!;
      // the card
      expect(first.status).toBe('locked');
      expect(first.opensAt).toBe(opensAt);

      // and the route, which is the half a view-only overlay would have missed
      await expect(workflow.phaseDetail(learnerId, first.id)).rejects.toThrow(ForbiddenException);
      await expect(workflow.phaseDetail(learnerId, first.id)).rejects.toThrow(
        opensAtMessage(opensAt),
      );
      await expect(
        workflow.saveWorkspace(learnerId, first.id, { [STORY_JSON]: serialiseStory(EMPTY_STORY) }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('honours the row again once the open date has passed', async () => {
      await setDates('requirements', soon(-HOUR), null);
      const board = await workflow.myEnrollment(learnerId, 'tasktrackr');
      const first = board!.phases.find((phase) => phase.key === 'requirements')!;
      expect(first.status).toBe('in_progress');
      await expect(workflow.phaseDetail(learnerId, first.id)).resolves.toMatchObject({
        key: 'requirements',
      });
    });

    it('carries a due date onto the phase without blocking anything', async () => {
      const dueAt = soon(48 * HOUR);
      await setDates('requirements', null, dueAt);
      const board = await workflow.myEnrollment(learnerId, 'tasktrackr');
      const first = board!.phases.find((phase) => phase.key === 'requirements')!;
      expect(first.dueAt).toBe(dueAt);
      expect(first.status).toBe('in_progress');
      // The save lands: a due date is a date, not a lock. It answers with the
      // stamp the tab quotes back on its next save.
      const saved = await workflow.saveWorkspace(learnerId, first.id, {
        [STORY_JSON]: serialiseStory(EMPTY_STORY),
      });
      expect(saved.version).toEqual(expect.any(String));
      expect(saved.workspace[STORY_JSON]).toBe(serialiseStory(EMPTY_STORY));
    });

    it('moves what counts as late when the due date moves, because nothing was stored on the row', async () => {
      const made = new Date('2026-09-16T22:00:00.000Z');
      await setDates('requirements', null, '2026-09-16T23:59:00.000Z');
      const before = await scheduleForLearner(manager(), learnerId, 'tasktrackr');
      expect(isLate(made, before.get('requirements')!.dueAt)).toBe(false);

      await setDates('requirements', null, '2026-09-15T23:59:00.000Z');
      const after = await scheduleForLearner(manager(), learnerId, 'tasktrackr');
      expect(isLate(made, after.get('requirements')!.dueAt)).toBe(true);
      // and nothing was written on the submission or the phase to say so
      expect(await manager().count(SubmissionEntity)).toBe(0);
    });

    it('refuses a phase that is due before it opens', async () => {
      await expect(setDates('design', soon(48 * HOUR), soon(HOUR))).rejects.toThrow(
        'A phase cannot be due before it opens.',
      );
      expect(await manager().count(CohortPhaseScheduleEntity)).toBe(0);
    });

    it('clears a date rather than storing a row that says nothing', async () => {
      await setDates('design', soon(HOUR), soon(48 * HOUR));
      expect(await manager().count(CohortPhaseScheduleEntity)).toBe(1);
      await setDates('design', null, null);
      expect(await manager().count(CohortPhaseScheduleEntity)).toBe(0);
      const view = await schedule.getSchedule(dana, cohortId, 'tasktrackr');
      expect(view.phases.find((row) => row.phaseKey === 'design')).toEqual({
        phaseKey: 'design',
        opensAt: null,
        dueAt: null,
      });
    });

    it('replaces the dates a class already had rather than appending to them', async () => {
      await setDates('design', soon(HOUR), null);
      await setDates('design', soon(2 * HOUR), null);
      expect(await manager().count(CohortPhaseScheduleEntity)).toBe(1);
    });

    it("keeps another instructor out of this class's dates, with a 404", async () => {
      await expect(schedule.getSchedule(sam, cohortId, 'tasktrackr')).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        schedule.saveSchedule(sam, cohortId, {
          projectSlug: 'tasktrackr',
          phases: [{ phaseKey: 'design', opensAt: soon(HOUR), dueAt: null }],
        }),
      ).rejects.toThrow(NotFoundException);
      // and the owner of the other class can still set their own
      await expect(
        schedule.saveSchedule(sam, otherCohortId, {
          projectSlug: 'tasktrackr',
          phases: [{ phaseKey: 'design', opensAt: soon(HOUR), dueAt: null }],
        }),
      ).resolves.toMatchObject({ cohortId: otherCohortId });
    });

    it('leaves a learner who has joined no class with no dates at all', async () => {
      await manager().update(UserEntity, { id: learnerId }, { cohort: 'default' });
      await setDates('requirements', soon(2 * HOUR), null);
      const board = await workflow.myEnrollment(learnerId, 'tasktrackr');
      const first = board!.phases.find((phase) => phase.key === 'requirements')!;
      expect([first.status, first.opensAt]).toEqual(['in_progress', null]);
    });

    it('leaves the trail a row saying who set the dates and what they are', async () => {
      await setDates('design', soon(HOUR), soon(48 * HOUR));
      const [row] = await manager().query(
        `SELECT "event", "actorUserId", "targetId", "detail" FROM audit_events`,
      );
      expect(row.event).toBe('cohort.schedule');
      expect(row.actorUserId).toBe(dana.id);
      expect(row.targetId).toBe(cohortId);
      expect(JSON.parse(row.detail).projectSlug).toBe('tasktrackr');
    });
  });
});

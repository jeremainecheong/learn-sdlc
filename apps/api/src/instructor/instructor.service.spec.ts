import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DEFAULT_DESIGN_FLOOR, DESIGN_JSON, type DesignChecksSpec, type FeedbackReport } from '@learnsdlc/shared';
import type { AssistantService } from '../assistant/assistant.service';
import { ContentService } from '../content/content.service';
import type { PhaseContent, ProjectContent } from '../content/content.types';
import {
  COMPILER_IDENTITY,
  soleTaskFor,
  type CompiledTask,
} from '../content/pack-compiler';
import { requiredKeysOf } from '../content/task-units';
// Only one pack ships, so the second project a learner is in is a fixture.
import { SECOND_PROJECT, addSecondProject } from '../../test/second-pack';
import {
  ALL_ENTITIES,
  AssistantMessageEntity,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { phaseRollup } from '../feedback/checkers';
import { QuizAttemptsService } from '../quiz/quiz-attempts.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RepoService } from '../repo/repo.service';
import { AUDIT_MAX_LIMIT, auditTake, recordAudit } from '../audit/audit';
import { ScheduleService } from './schedule.service';
import { InstructorDetailController } from './instructor.controller';
import {
  InstructorCaller,
  InstructorService,
  SOLE_TASK_LEVER_REFUSAL,
  evidenceStillNeededNote,
} from './instructor.service';
import { auditCursor, decodeAuditCursor } from './audit-cursor';
import {
  CSV_COLUMNS,
  GRADEBOOK_COLUMNS,
  conformanceCell,
  csvCell,
  drillCell,
  killMatrixCell,
} from './csv';
import { memoryDataSource } from '../../test/support/memory-db';

describe('csvCell', () => {
  it('quotes a cell holding a comma, a quote or a line break', () => {
    expect(csvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('neutralises text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      '"\'=HYPERLINK(""http://x"")"',
    );
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@me')).toBe("'@me");
  });

  it('leaves numbers, booleans and dates alone and blanks a null', () => {
    expect(csvCell(82.5)).toBe('82.5');
    expect(csvCell(true)).toBe('true');
    expect(csvCell('2026-09-02T00:00:00.000Z')).toBe(
      '2026-09-02T00:00:00.000Z',
    );
    expect(csvCell(null)).toBe('');
  });
});

describe('InstructorService', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: InstructorService;

  const assistant = {
    tokensToday: async () => 0,
  } as unknown as AssistantService;

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let admin: InstructorCaller;
  let learnerId = '';
  let otherLearnerId = '';
  let cohortId = '';
  const missingId = '00000000-0000-4000-8000-000000000000';
  const reason = 'Sandbox outage on 2 Sep swallowed their submissions.';

  const manager = () => dataSource.manager;
  const state = (id: string) =>
    manager().findOneByOrFail(PhaseStateEntity, { id });

  /**
   * The one sentence both reset levers refuse with while a revision is
   * still being marked, written out here rather than imported, so the words a
   * teacher reads are pinned by this file and not only by the function that
   * builds them.
   */
  const inFlightRefusal = (subject: string): string =>
    `${subject} cannot be reset while a revision of it is still being marked; try again once its verdict is in.`;

  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(
      manager().create(UserEntity, {
        passwordHash: 'x',
        displayName: 'Someone',
        ...fields,
      }),
    );

  /** Materialises an enrolment the way WorkflowService.enroll does. */
  async function enrol(
    userId: string,
    projectSlug: string,
  ): Promise<PhaseStateEntity[]> {
    const enrollment = await manager().save(
      manager().create(EnrollmentEntity, {
        userId,
        projectSlug,
        currentPhaseOrder: 1,
      }),
    );
    const states: PhaseStateEntity[] = [];
    for (const phase of content.getProject(projectSlug).phases) {
      states.push(
        await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: phase.order === 1 ? 'in_progress' : 'locked',
          }),
        ),
      );
    }
    return states;
  }

  const report = (mentorPasteFlag: boolean): FeedbackReport => ({
    overall: 82,
    passed: true,
    passThreshold: 70,
    criteria: [],
    checks: [],
    aiReview: {
      summary: '',
      strengths: [],
      improvements: [],
      processNote: '',
      provider: 'local',
    },
    aiReliance: { hintsThisPhase: 2, index: 33 },
    integrity: {
      relianceFlag: false,
      relianceIndex: 33,
      mentorPasteFlag,
      noEffortFlag: false,
      note: mentorPasteFlag ? 'A passage matches a mentor reply verbatim.' : '',
    },
  });

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    addSecondProject(content);
    service = new InstructorService(dataSource, content, assistant);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    jest.restoreAllMocks();

    const danaRow = await saveUser({
      email: 'dana@learnsdlc.test',
      role: 'INSTRUCTOR',
    });
    const samRow = await saveUser({
      email: 'sam@learnsdlc.test',
      role: 'INSTRUCTOR',
    });
    const adminRow = await saveUser({
      email: 'ops@learnsdlc.test',
      role: 'ADMIN',
    });
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
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday.id };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday.id };
    admin = { id: adminRow.id, role: 'ADMIN', cohort: 'default' };

    learnerId = (
      await saveUser({
        email: 'lee@learnsdlc.test',
        displayName: 'Lee, Learner',
        cohort: tuesday.id,
      })
    ).id;
    otherLearnerId = (
      await saveUser({
        email: 'ola@learnsdlc.test',
        displayName: 'Ola Other',
        cohort: thursday.id,
      })
    ).id;

    // Lee: phase 1 passed after two attempts, phase 2 open with work in it.
    const [p1, p2] = await enrol(learnerId, 'tasktrackr');
    await manager().update(PhaseStateEntity, p1.id, {
      status: 'passed',
      bestScore: 82,
      attempts: 2,
      reflection: 'Writing the story first made the tests obvious.',
      passedAt: '2026-09-01T10:00:00.000Z',
    });
    await manager().update(PhaseStateEntity, p2.id, {
      status: 'in_progress',
      attempts: 1,
      workspace: { 'design/design.md': '# Draft' },
      ranBeforeSubmit: true,
    });
    for (const [role, phaseStateId] of [
      ['user', p1.id],
      ['user', p1.id],
      ['assistant', p1.id],
      ['user', p2.id],
    ] as const) {
      await manager().save(
        manager().create(AssistantMessageEntity, {
          userId: learnerId,
          enrollmentId: p1.enrollmentId,
          phaseStateId,
          phaseKey: 'requirements',
          role,
          content: '…',
        }),
      );
    }
    // Two submissions on phase 1; only the newer one carries the paste flag.
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: p1.id,
        userId: learnerId,
        status: 'completed',
        score: 40,
        passed: false,
        report: report(false),
        createdAt: new Date('2026-08-30T10:00:00.000Z'),
      }),
    );
    await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: p1.id,
        userId: learnerId,
        status: 'completed',
        score: 82,
        passed: true,
        report: report(true),
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    );

    await enrol(otherLearnerId, SECOND_PROJECT);
  });

  describe('learnerDetail', () => {
    it('shows every enrolment with phase states and the latest verdict, integrity included', async () => {
      const detail = await service.learnerDetail(dana, learnerId);
      expect(detail).toMatchObject({
        userId: learnerId,
        email: 'lee@learnsdlc.test',
        cohort: cohortId,
        cohortName: 'Tuesday class',
        tokensToday: 0,
      });
      expect(detail).not.toHaveProperty('dailyTokenBudget');
      expect(detail).not.toHaveProperty('effectiveDailyTokenBudget');
      expect(detail.enrollments).toHaveLength(1);
      const [enrollment] = detail.enrollments;
      expect(enrollment.projectSlug).toBe('tasktrackr');
      expect(enrollment.phases.map((p) => p.status)).toEqual([
        'passed',
        'in_progress',
        'locked',
        'locked',
        'locked',
        'locked',
      ]);

      const first = enrollment.phases[0];
      expect(first).toMatchObject({
        key: 'requirements',
        bestScore: 82,
        attempts: 2,
        reflection: null,
        passedAt: '2026-09-01T10:00:00.000Z',
        passThreshold: content.getPhase('tasktrackr', 'requirements').rubric
          .passThreshold,
      });
      // The newer of the two submissions, and the signal the Terms promise
      // reaches instructors.
      expect(first.lastSubmission?.score).toBe(82);
      expect(first.lastSubmission?.verifiedPass).toBe(false);
      expect(first.lastSubmission?.report?.integrity.mentorPasteFlag).toBe(
        true,
      );
      expect(enrollment.phases[1].lastSubmission).toBeNull();
      const retained = await manager().findOneByOrFail(PhaseStateEntity, {
        id: first.id,
      });
      expect(retained.reflection).toBe(
        'Writing the story first made the tests obvious.',
      );
    });

    it('does not verify malformed or unsupported historical passing records', async () => {
      const phase = await manager().findOneByOrFail(PhaseStateEntity, {
        userId: learnerId,
        phaseOrder: 1,
      });
      await manager().update(
        SubmissionEntity,
        { phaseStateId: phase.id, passed: true },
        {
          report: {
            assessmentMode: 'strict_binary',
            passed: true,
            checks: [],
          } as unknown as FeedbackReport,
          workspaceSnapshot: { 'requirements/story.json': 'Retained source' },
          contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
        },
      );
      const detail = await service.learnerDetail(dana, learnerId);
      expect(detail.enrollments[0].phases[0].lastSubmission).toMatchObject({
        passed: true,
        verifiedPass: false,
      });
    });

    it('carries how far the customer interview got, counted not scored', async () => {
      // Two turns, one of which settled nothing and
      // one of which settled the same fact twice: the count is of facts
      // settled, not of answers given.
      const [p1] = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      await manager().update(PhaseStateEntity, p1.id, {
        interview: {
          startedAt: '2026-09-01T09:00:00.000Z',
          closedAt: null,
          turns: [
            {
              id: 't1',
              question: 'Is a task due today overdue?',
              answer: 'No, not until tomorrow.',
              facts: ['F2'],
              provider: 'local-mentor',
              askedAt: '2026-09-01T09:01:00.000Z',
            },
            {
              id: 't2',
              question: 'And one due today at nine?',
              answer: 'Still not overdue.',
              facts: ['F2'],
              provider: 'local-mentor',
              askedAt: '2026-09-01T09:02:00.000Z',
            },
            {
              id: 't3',
              question: 'What is your favourite colour?',
              answer: 'That is not something I can help with.',
              facts: [],
              provider: 'guardrail',
              askedAt: '2026-09-01T09:03:00.000Z',
            },
          ],
        },
      });

      expect((await service.learnerDetail(dana, learnerId)).interview).toEqual({
        questions: 3,
        settled: 1,
      });
    });

    it('says nothing about an interview the learner never held', async () => {
      // Ola is in the other class, so the admin is the caller who can read her.
      expect(
        (await service.learnerDetail(admin, otherLearnerId)).interview,
      ).toBeNull();
    });

    it("counts only the learner's own messages as hints", async () => {
      const [enrollment] = (await service.learnerDetail(dana, learnerId))
        .enrollments;
      expect(enrollment.phases.map((p) => p.hints)).toEqual([2, 1, 0, 0, 0, 0]);
      expect(enrollment.phases[0].relianceIndex).toBeGreaterThan(0);
    });

    it("refuses a learner in another instructor's class, while an admin reaches anyone", async () => {
      await expect(service.learnerDetail(sam, learnerId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.learnerDetail(dana, otherLearnerId)).rejects.toThrow(
        NotFoundException,
      );
      expect((await service.learnerDetail(admin, learnerId)).userId).toBe(
        learnerId,
      );
      expect((await service.learnerDetail(admin, otherLearnerId)).userId).toBe(
        otherLearnerId,
      );
    });

    it('refuses an id that is not a learner, even in the same class', async () => {
      // Dana sits in her own class's cohort column; she is still not a learner.
      await expect(service.learnerDetail(dana, dana.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('answers 404 to a malformed or unknown id', async () => {
      await expect(service.learnerDetail(dana, 'not-a-uuid')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.learnerDetail(dana, missingId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('overridePhase', () => {
    const phases = async () =>
      manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });

    it('pass: marks the phase passed with the rubric gate as the score floor', async () => {
      const [, design] = await phases();
      const threshold = content.getPhase('tasktrackr', 'design').rubric
        .passThreshold;
      const view = await service.overridePhase(
        dana,
        learnerId,
        design.id,
        'pass',
        reason,
      );
      expect(view).toMatchObject({
        id: design.id,
        status: 'passed',
        bestScore: threshold,
      });
      const after = await state(design.id);
      expect(after.status).toBe('passed');
      expect(after.passedAt).toEqual(expect.any(String));
      expect(after.bestScore).toBe(threshold);
    });

    it('pass: keeps a score that was already above the gate', async () => {
      const [, , impl] = await phases();
      await manager().update(PhaseStateEntity, impl.id, { bestScore: 95 });
      await service.overridePhase(dana, learnerId, impl.id, 'pass', reason);
      expect((await state(impl.id)).bestScore).toBe(95);
    });

    it('records who did what to whom, and why, in the log', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const [, design] = await phases();
      await service.overridePhase(
        dana,
        learnerId,
        design.id,
        'pass',
        `  ${reason}  `,
      );
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'phase.override',
          action: 'pass',
          actorId: dana.id,
          learnerId,
          phaseStateId: design.id,
          reason,
        }),
      );
    });

    it('refuses a reason too short to be one, changing nothing', async () => {
      const [, design] = await phases();
      await expect(
        service.overridePhase(dana, learnerId, design.id, 'pass', 'because'),
      ).rejects.toThrow(BadRequestException);
      expect((await state(design.id)).status).toBe('in_progress');
    });

    it('pass on a passed phase and reopen on an open one are conflicts', async () => {
      const [requirements, design] = await phases();
      await expect(
        service.overridePhase(dana, learnerId, requirements.id, 'pass', reason),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.overridePhase(dana, learnerId, design.id, 'reopen', reason),
      ).rejects.toThrow(ConflictException);
    });

    it('reopen: withdraws a pass but keeps the score history', async () => {
      const [requirements] = await phases();
      const view = await service.overridePhase(
        dana,
        learnerId,
        requirements.id,
        'reopen',
        reason,
      );
      expect(view.status).toBe('in_progress');
      const after = await state(requirements.id);
      expect(after.status).toBe('in_progress');
      expect(after.passedAt).toBeNull();
      expect(after.bestScore).toBe(82);
      expect(after.attempts).toBe(2);
    });

    it('reopen: unlocks a locked phase early', async () => {
      const [, , impl] = await phases();
      await service.overridePhase(dana, learnerId, impl.id, 'reopen', reason);
      const after = await state(impl.id);
      expect(after.status).toBe('in_progress');
      expect(after.unlockedAt).toEqual(expect.any(String));
    });

    it('reset-workspace: clears the files and the ran-before-submit credit', async () => {
      const [, design] = await phases();
      await service.overridePhase(
        dana,
        learnerId,
        design.id,
        'reset-workspace',
        reason,
      );
      const after = await state(design.id);
      expect(after.workspace).toBeNull();
      expect(after.ranBeforeSubmit).toBe(false);
      // Status and attempts are the learner's history; a reset is not a reopen.
      expect(after.status).toBe('in_progress');
      expect(after.attempts).toBe(1);
    });

    /**
     * The learner's 700 ms autosave, landing in the window between the read
     * overridePhase makes and the write it makes back. Hooked onto that read
     * rather than raced against it, so the window is hit every run.
     */
    const autosaveDuringOverride = (
      phaseStateId: string,
      workspace: Record<string, string>,
    ): void => {
      const find = manager().findOne.bind(manager());
      let fired = false;
      jest
        .spyOn(manager(), 'findOne')
        .mockImplementation(async (entity: any, options: any) => {
          const row = await find(entity, options);
          if (
            !fired &&
            entity === PhaseStateEntity &&
            (row as PhaseStateEntity | null)?.id === phaseStateId
          ) {
            fired = true;
            await manager().update(PhaseStateEntity, phaseStateId, {
              workspace,
            });
          }
          return row;
        });
    };

    it('keeps the work a learner typed while the instructor was deciding', async () => {
      const [, design] = await phases();
      const typing = {
        'design/design.md': '# Draft\n\nAdded the sequence diagram.',
      };
      autosaveDuringOverride(design.id, typing);

      await service.overridePhase(dana, learnerId, design.id, 'pass', reason);

      const after = await state(design.id);
      expect(after.status).toBe('passed');
      // The pass is the instructor's to write; the files are not.
      expect(after.workspace).toEqual(typing);
    });

    it('reset-workspace still clears the files, autosave or no autosave', async () => {
      const [, design] = await phases();
      autosaveDuringOverride(design.id, {
        'design/design.md': '# Draft\n\nStill typing.',
      });

      await service.overridePhase(
        dana,
        learnerId,
        design.id,
        'reset-workspace',
        reason,
      );

      expect((await state(design.id)).workspace).toBeNull();
    });

    it.each(['reset-workspace', 'reset-phase'] as const)(
      '%s moves the save stamp, so a write that read the row before the reset cannot put the old files back',
      async (action) => {
        const [, design] = await phases();
        const before = '2026-10-01T00:00:00.000Z';
        await manager().update(PhaseStateEntity, design.id, {
          workspace: { 'design/design.json': '{"old":true}' },
          workspaceUpdatedAt: before,
        });

        await service.overridePhase(dana, learnerId, design.id, action, reason);

        const after = await state(design.id);
        expect(after.workspace).toBeNull();
        expect(after.workspaceUpdatedAt! > before).toBe(true);
        // A learner save or a drill resolve quotes the stamp it read: the old one now matches no row.
        const stale = await manager()
          .createQueryBuilder()
          .update(PhaseStateEntity)
          .set({ workspace: { 'design/design.json': '{"old":true}' } })
          .where('id = :id', { id: design.id })
          .andWhere('"workspaceUpdatedAt" = :stamp', { stamp: before })
          .execute();
        expect(stale.affected).toBe(0);
        expect((await state(design.id)).workspace).toBeNull();
      },
    );

    it("refuses another learner's phase even when the path names a learner in my class", async () => {
      const [theirs] = await manager().find(PhaseStateEntity, {
        where: { userId: otherLearnerId },
      });
      await expect(
        service.overridePhase(dana, learnerId, theirs.id, 'pass', reason),
      ).rejects.toThrow(NotFoundException);
      expect((await state(theirs.id)).status).toBe('in_progress');
    });

    it('refuses a learner outside my class', async () => {
      const [, design] = await phases();
      await expect(
        service.overridePhase(sam, learnerId, design.id, 'pass', reason),
      ).rejects.toThrow(NotFoundException);
      expect((await state(design.id)).status).toBe('in_progress');
    });

    it('keeps the override in the audit trail, where the log stream cannot rotate it away', async () => {
      const [, design] = await phases();
      await service.overridePhase(dana, learnerId, design.id, 'pass', reason);
      const rows = await manager().find(AuditEventEntity, {});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event: 'phase.override',
        actorUserId: dana.id,
        subjectUserId: learnerId,
        targetId: design.id,
        action: 'pass',
        reason,
        detail: { projectSlug: 'tasktrackr', phaseKey: 'design' },
      });
    });
  });

  /**
   * The fourth lever. `reopen` plus `reset-workspace` is not this:
   * together they leave the links, the drill, the merge message and the
   * release record behind, and a learner who merges again then loses the race
   * to `UQ_releases_enrollment_phase` and keeps the old release at the old
   * score. So the assertions here are as much about what survives (the
   * revisions, the later phases, `currentPhaseOrder`, `attempts`) as about
   * what goes.
   */
  describe('overridePhase: reset-phase', () => {
    const phases = async () =>
      manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });

    /** A phase with everything a learner can put in one, and a release. */
    const loaded = async () => {
      const [first] = await phases();
      await manager().update(PhaseStateEntity, first.id, {
        workspace: { 'requirements/story.json': '# US-1' },
        links: [{ from: 'test_add', to: 'US-1/AC-1', kind: 'verifies' }],
        drill: null,
        ranBeforeSubmit: true,
      });
      const release = await manager().save(
        manager().create(ReleaseRecordEntity, {
          enrollmentId: first.enrollmentId,
          userId: learnerId,
          phaseStateId: first.id,
          phaseKey: first.phaseKey,
          phaseOrder: first.phaseOrder,
          version: 'v1',
          score: 82,
          notes: 'Merged the requirements after the review.',
        }),
      );
      return { first, release };
    };

    it('clears the work and the verdict, and keeps the revisions and the later phases', async () => {
      const { first } = await loaded();
      const before = await phases();
      const submissions = await manager().count(SubmissionEntity, {
        where: { phaseStateId: first.id },
      });

      const view = await service.overridePhase(
        dana,
        learnerId,
        first.id,
        'reset-phase',
        reason,
      );
      expect(view).toMatchObject({
        id: first.id,
        status: 'in_progress',
        bestScore: null,
      });

      const after = await state(first.id);
      expect([
        after.workspace,
        after.links,
        after.drill,
        after.reflection,
        after.ranBeforeSubmit,
        after.bestScore,
        after.passedAt,
      ]).toEqual([null, null, null, null, false, null, null]);
      expect(after.status).toBe('in_progress');
      // How many goes they have had is a fact about them, not housekeeping:
      // zeroing it would move the reliance index's denominator.
      expect(after.attempts).toBe(before[0].attempts);
      // nothing is deleted from the record
      expect(
        await manager().count(SubmissionEntity, {
          where: { phaseStateId: first.id },
        }),
      ).toBe(submissions);
      // and the rest of the board is exactly where it was
      const later = await phases();
      expect(later.slice(1).map((row) => [row.status, row.workspace])).toEqual(
        before.slice(1).map((row) => [row.status, row.workspace]),
      );
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, {
        id: first.enrollmentId,
      });
      expect(enrollment.currentPhaseOrder).toBe(1);
    });

    it('removes the release and copies it into the trail rather than losing it', async () => {
      const { first, release } = await loaded();
      await service.overridePhase(
        dana,
        learnerId,
        first.id,
        'reset-phase',
        reason,
      );

      expect(
        await manager().findOne(ReleaseRecordEntity, {
          where: { id: release.id },
        }),
      ).toBeNull();
      const row = await manager().findOneByOrFail(AuditEventEntity, {
        targetId: first.id,
      });
      expect(row.event).toBe('phase.override');
      expect(row.action).toBe('reset-phase');
      expect(row.reason).toBe(reason);
      expect(row.detail).toMatchObject({
        projectSlug: 'tasktrackr',
        phaseKey: 'requirements',
        removedRelease: {
          version: 'v1',
          score: 82,
          notes: 'Merged the requirements after the review.',
        },
      });
    });

    it('leaves a phase the learner never reached out of reach', async () => {
      const [, , impl] = await phases();
      expect(impl.status).toBe('locked');
      await service.overridePhase(
        dana,
        learnerId,
        impl.id,
        'reset-phase',
        reason,
      );
      expect((await state(impl.id)).status).toBe('locked');
    });

    it('refuses a reason too short to be one, changing nothing', async () => {
      const { first, release } = await loaded();
      await expect(
        service.overridePhase(dana, learnerId, first.id, 'reset-phase', 'oops'),
      ).rejects.toThrow(BadRequestException);
      expect((await state(first.id)).workspace).toEqual({
        'requirements/story.json': '# US-1',
      });
      expect(
        await manager().findOne(ReleaseRecordEntity, {
          where: { id: release.id },
        }),
      ).toBeTruthy();
    });

    it("refuses a learner in another instructor's class with a 404", async () => {
      const { first } = await loaded();
      await expect(
        service.overridePhase(sam, learnerId, first.id, 'reset-phase', reason),
      ).rejects.toThrow(NotFoundException);
      expect((await state(first.id)).workspace).toEqual({
        'requirements/story.json': '# US-1',
      });
    });

    /**
     * The reset race, narrowed. A revision that is still queued or
     * running was cut from the files the reset is about to clear, and its
     * verdict lands after the reset, so a phase started over comes straight
     * back at the old revision's score. While one is in flight the lever says
     * so in one sentence and writes nothing.
     */
    it.each(['queued', 'running'] as const)(
      'refuses while a revision of the phase is %s, changing nothing',
      async (status) => {
        const { first, release } = await loaded();
        const marking = await manager().save(
          manager().create(SubmissionEntity, {
            phaseStateId: first.id,
            userId: learnerId,
            status,
          }),
        );
        const before = await state(first.id);

        const refused = service.overridePhase(dana, learnerId, first.id, 'reset-phase', reason);
        await expect(refused).rejects.toBeInstanceOf(ConflictException);
        await expect(
          service.overridePhase(dana, learnerId, first.id, 'reset-phase', reason),
        ).rejects.toThrow(inFlightRefusal('Requirements'));

        const after = await state(first.id);
        expect([after.status, after.workspace, after.links, after.ranBeforeSubmit, after.bestScore]).toEqual(
          [before.status, before.workspace, before.links, before.ranBeforeSubmit, before.bestScore],
        );
        expect(
          await manager().findOne(ReleaseRecordEntity, { where: { id: release.id } }),
        ).toBeTruthy();
        expect(await manager().count(AuditEventEntity, { where: { action: 'reset-phase' } })).toBe(0);
        // and the revision is left to finish: the lever never touches it.
        expect((await manager().findOneByOrFail(SubmissionEntity, { id: marking.id })).status).toBe(status);
      },
    );

    it('starts the phase over once that revision’s verdict is in', async () => {
      const { first, release } = await loaded();
      const marked = await manager().save(
        manager().create(SubmissionEntity, {
          phaseStateId: first.id,
          userId: learnerId,
          status: 'running',
        }),
      );
      await expect(
        service.overridePhase(dana, learnerId, first.id, 'reset-phase', reason),
      ).rejects.toBeInstanceOf(ConflictException);

      await manager().update(SubmissionEntity, marked.id, { status: 'completed', passed: false, score: 40 });
      await service.overridePhase(dana, learnerId, first.id, 'reset-phase', reason);

      expect((await state(first.id)).workspace).toBeNull();
      expect(
        await manager().findOne(ReleaseRecordEntity, { where: { id: release.id } }),
      ).toBeNull();
    });
  });

  describe('auditLog', () => {
    // Legacy audit rows remain visible after quota controls are removed. Seed
    // the historic event directly; no current endpoint can create a quota.
    const historicalQuota = (actor: InstructorCaller, subjectUserId: string, value: number) =>
      recordAudit(manager(), {
        event: 'budget.override', actorUserId: actor.id, subjectUserId,
        action: `set ${value}`, detail: { dailyTokenBudget: value },
      });

    const phases = async () =>
      manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });

    /** Two rows a millisecond apart would tie; the trail is read by its clock. */
    const backdate = (event: string, when: string) =>
      manager().update(
        AuditEventEntity,
        { event },
        { createdAt: new Date(when) },
      );

    it('is newest first, with the names of the people on both sides of it', async () => {
      const [, design] = await phases();
      await historicalQuota(dana, learnerId, 5000);
      await service.overridePhase(dana, learnerId, design.id, 'pass', reason);
      await backdate('budget.override', '2026-09-01T09:00:00.000Z');
      await backdate('phase.override', '2026-09-01T10:00:00.000Z');

      const rows = await service.auditLog(dana);
      expect(rows.map((row) => row.event)).toEqual([
        'phase.override',
        'budget.override',
      ]);
      expect(rows[0]).toMatchObject({
        actorUserId: dana.id,
        actorName: 'Someone',
        subjectUserId: learnerId,
        subjectName: 'Lee, Learner',
        action: 'pass',
        reason,
        createdAt: '2026-09-01T10:00:00.000Z',
      });
    });

    it('shows me my own classes; an admin sees every class', async () => {
      await historicalQuota(dana, learnerId, 5000);
      await historicalQuota(sam, otherLearnerId, 7000);

      expect(
        (await service.auditLog(dana)).map((row) => row.subjectUserId),
      ).toEqual([learnerId]);
      expect(
        (await service.auditLog(sam)).map((row) => row.subjectUserId),
      ).toEqual([otherLearnerId]);
      expect(await service.auditLog(admin)).toHaveLength(2);
    });

    it('refuses to filter by a learner outside my class, the same 404 as their detail page', async () => {
      await historicalQuota(dana, learnerId, 5000);
      await expect(service.auditLog(sam, learnerId)).rejects.toThrow(
        NotFoundException,
      );
      expect(await service.auditLog(dana, learnerId)).toHaveLength(1);
    });

    it('takes a page at a time', async () => {
      for (const budget of [1000, 2000, 3000])
        await historicalQuota(dana, learnerId, budget);
      expect(await service.auditLog(dana, undefined, 2)).toHaveLength(2);
      expect(await service.auditLog(dana)).toHaveLength(3);
      expect(auditTake(undefined)).toBe(50);
      expect(auditTake(3)).toBe(3);
      expect(auditTake(10_000)).toBe(AUDIT_MAX_LIMIT);
      expect(auditTake(-5)).toBe(1);
    });

    /**
     * `take` bounds what comes back, not what is read: an offset page is a
     * sort of the whole table however few rows it shows, so it grows with
     * every override, budget change and class move of the term. A keyset
     * cursor makes each page a range on an index that is already in the
     * answer's order.
     */
    describe('the trail is paged from where the last page stopped', () => {
      /** Twelve rows for my class, timestamped so two of them tie. */
      const trail = async (): Promise<void> => {
        const rows = Array.from({ length: 12 }, (_, n) =>
          manager().create(AuditEventEntity, {
            event: 'budget.override',
            actorUserId: dana.id,
            subjectUserId: learnerId,
            action: `set ${n}`,
            // The last two share a second, which is what an override and the
            // budget change beside it look like on a real clock.
            createdAt: new Date(Date.UTC(2026, 8, 1, 9, 0, Math.min(n, 10))),
          } as Partial<AuditEventEntity>),
        );
        await manager().save(rows);
      };

      /** Every page, followed to the end, as ids in the order they arrived. */
      const walk = async (
        caller: InstructorCaller,
        size: number,
      ): Promise<string[]> => {
        const ids: string[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const rows = await service.auditLog(caller, undefined, size, cursor);
          if (!rows.length) break;
          ids.push(...rows.map((row) => row.id));
          cursor = auditCursor(rows[rows.length - 1]);
        }
        return ids;
      };

      it('walks the whole trail in order, with no row seen twice and none missed', async () => {
        await trail();
        const everything = await service.auditLog(
          dana,
          undefined,
          AUDIT_MAX_LIMIT,
        );
        expect(everything).toHaveLength(12);

        const paged = await walk(dana, 5);

        expect(paged).toEqual(everything.map((row) => row.id));
        expect(new Set(paged).size).toBe(12);
      });

      it('does not lose or repeat a row when two of them share a second', async () => {
        await trail();
        const tied = (
          await service.auditLog(dana, undefined, AUDIT_MAX_LIMIT)
        ).filter((row) => row.createdAt === '2026-09-01T09:00:10.000Z');
        expect(tied).toHaveLength(2);

        // A page boundary drawn between the two tied rows: a cursor on the
        // timestamp alone would either skip the second or hand it back again.
        const first = await service.auditLog(dana, undefined, 1);
        expect(first[0].id).toBe(tied[0].id);
        const next = await service.auditLog(
          dana,
          undefined,
          1,
          auditCursor(first[0]),
        );
        expect(next[0].id).toBe(tied[1].id);
      });

      it('pages one learner and a whole deployment the same way', async () => {
        await trail();
        await historicalQuota(sam, otherLearnerId, 7000);

        expect(await walk(admin, 5)).toHaveLength(13);
        const learnerPage = await service.auditLog(dana, learnerId, 5);
        expect(learnerPage).toHaveLength(5);
        const afterLearnerPage = await service.auditLog(
          dana,
          learnerId,
          5,
          auditCursor(learnerPage[4]),
        );
        expect(afterLearnerPage.map((row) => row.id)).not.toEqual(
          expect.arrayContaining(learnerPage.map((row) => row.id)),
        );
      });

      it('treats a cursor it cannot read as the start of the trail', async () => {
        await trail();
        const first = await service.auditLog(dana, undefined, 3);

        for (const nonsense of [
          '',
          'not-a-cursor',
          Buffer.from('no-separator').toString('base64url'),
        ]) {
          expect(
            (await service.auditLog(dana, undefined, 3, nonsense)).map(
              (row) => row.id,
            ),
          ).toEqual(first.map((row) => row.id));
        }
        // and a real one round-trips
        const cursor = auditCursor(first[0]);
        expect(decodeAuditCursor(cursor)).toEqual({
          createdAt: new Date(first[0].createdAt),
          id: first[0].id,
        });
      });

      it('still shows an instructor their own actions on a learner who has left their class', async () => {
        await historicalQuota(dana, learnerId, 5000);
        // The learner moves to another class; the action Dana took is still hers.
        await manager().update(
          UserEntity,
          { id: learnerId },
          { cohort: 'thursday' },
        );

        const rows = await service.auditLog(dana);
        expect(rows.map((row) => row.actorUserId)).toEqual([dana.id]);
      });
    });
  });

  describe('exportCsv', () => {
    const parse = (csv: string) =>
      csv
        .trimEnd()
        .split('\r\n')
        .map((line) => line.split(','));

    it('is one row per learner × phase for my class only, with the class named', async () => {
      const rows = parse(await service.exportCsv(dana));
      expect(rows[0]).toEqual([...CSV_COLUMNS]);
      expect(rows).toHaveLength(1 + 6);
      // "Lee, Learner" holds a comma, so the quoted name splits into two cells here.
      expect(rows[1].slice(0, 5)).toEqual([
        'lee@learnsdlc.test',
        '"Lee',
        ' Learner"',
        'Tuesday class',
        'tasktrackr',
      ]);
      const [
        ,
        ,
        ,
        ,
        ,
        phaseKey,
        status,
        bestScore,
        attempts,
        hints,
        reliance,
        passedAt,
        completed,
      ] = rows[1];
      expect({
        phaseKey,
        status,
        bestScore,
        attempts,
        hints,
        passedAt,
        completed,
      }).toEqual({
        phaseKey: 'requirements',
        status: 'passed',
        bestScore: '82',
        attempts: '2',
        hints: '2',
        passedAt: '2026-09-01T10:00:00.000Z',
        completed: 'false',
      });
      expect(Number(reliance)).toBeGreaterThan(0);
      expect(rows.map((r) => r[0])).not.toContain('ola@learnsdlc.test');
    });

    it('an admin gets every class, and ?project= narrows the rows', async () => {
      const all = parse(await service.exportCsv(admin));
      expect(all).toHaveLength(1 + 6 + 6);
      expect(new Set(all.slice(1).map((r) => r[0]))).toEqual(
        new Set(['lee@learnsdlc.test', 'ola@learnsdlc.test']),
      );

      const js = parse(await service.exportCsv(admin, SECOND_PROJECT));
      expect(js).toHaveLength(1 + 6);
      expect(
        js
          .slice(1)
          .every(
            (r) => r[0] === 'ola@learnsdlc.test' && r[3] === SECOND_PROJECT,
          ),
      ).toBe(true);
    });

    it('refuses an unknown project rather than returning an empty file', async () => {
      await expect(service.exportCsv(dana, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('carries the kill matrix, the conformance ledger and the drill verdict', async () => {
      const states = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      const at = (key: string) => states.find((s) => s.phaseKey === key)!;
      const submit = (phaseStateId: string, extra: Partial<FeedbackReport>) =>
        manager().save(
          manager().create(SubmissionEntity, {
            phaseStateId,
            userId: learnerId,
            status: 'completed',
            score: 70,
            passed: true,
            report: { ...report(false), ...extra },
          }),
        );

      await submit(at('testing').id, {
        mutation: {
          total: 6,
          killed: 4,
          survivors: [{ name: 'overdue_boundary', description: '' }],
        },
      });
      await submit(at('design').id, {
        contract: [
          {
            name: 'complete_task',
            claim: 'returns',
            text: '',
            verdict: 'kept',
            evidence: [],
          },
          {
            name: 'filter_tasks',
            claim: 'ordering',
            text: '',
            verdict: 'kept',
            evidence: [],
          },
          {
            name: 'overdue_tasks',
            claim: 'boundary',
            text: '',
            verdict: 'broken',
            evidence: [],
          },
        ],
      });
      await submit(at('deployment').id, {
        drill: {
          fault: 'workdir-entrypoint-mismatch',
          faultDescription: '',
          failedBeforeFix: true,
          passedAfterFix: true,
          diagnosisNamesFault: false,
          beforeStderr: '',
          afterStdout: '',
        },
      });

      const rows = parse(await service.exportCsv(dana, 'tasktrackr'));
      // Located from the heading rather than hard-coded from the end: the
      // export's contract is that columns are appended, so a fixed negative
      // slice moves whenever another column is appended. The offset is
      // counted from the end because this parser splits
      // on every comma, so a display name holding one shifts each data row.
      const header = rows[0];
      const back = (name: string) => header.length - header.indexOf(name);
      const slice = ['kill matrix', 'conformance', 'drill'].map(back);
      expect(slice.every((at) => at < header.length)).toBe(true);
      const cells = new Map(
        rows
          .slice(1)
          .map((row) => [row[5], slice.map((at) => row[row.length - at])]),
      );
      expect(cells.get('testing')).toEqual(['4/6', '', '']);
      expect(cells.get('design')).toEqual(['', '2/3', '']);
      expect(cells.get('deployment')).toEqual(['', '', 'fixed']);
      // A phase whose report has none of the three leaves them blank.
      expect(cells.get('requirements')).toEqual(['', '', '']);
    });

    it('reads the three phase-report columns (kill matrix, conformance, drill) straight off a report', () => {
      expect(killMatrixCell(null)).toBe('');
      expect(conformanceCell({ ...report(false), contract: [] })).toBe('');
      expect(
        drillCell({
          ...report(false),
          drill: {
            fault: 'f',
            faultDescription: '',
            failedBeforeFix: true,
            passedAfterFix: true,
            diagnosisNamesFault: true,
            beforeStderr: '',
            afterStdout: '',
          },
        }),
      ).toBe('fixed and diagnosed');
      expect(
        drillCell({
          ...report(false),
          drill: {
            fault: 'f',
            faultDescription: '',
            failedBeforeFix: true,
            passedAfterFix: false,
            diagnosisNamesFault: true,
            beforeStderr: '',
            afterStdout: '',
          },
        }),
      ).toBe('not fixed');
    });

    it('is just the header for a class where nobody has started', async () => {
      await manager().delete(EnrollmentEntity, { userId: learnerId });
      await manager().delete(PhaseStateEntity, { userId: learnerId });
      expect(await service.exportCsv(dana)).toBe(
        `${CSV_COLUMNS.join(',')}\r\n`,
      );
    });

    /**
     * The four are appended rather than slotted in beside their
     * neighbours so that anything reading this file by column position keeps
     * working and a term of exports stays comparable.
     */
    it('appends the pack version, the submission time, whether it was late and whether it was regraded', async () => {
      const [first] = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      const newest = await manager().findOneByOrFail(SubmissionEntity, {
        phaseStateId: first.id,
        score: 82,
      });
      await manager().update(
        SubmissionEntity,
        { id: newest.id },
        { packVersion: '0.9.0', regradeOf: 'a-previous-revision' },
      );
      await new ScheduleService(dataSource, content).saveSchedule(
        dana,
        cohortId,
        {
          projectSlug: 'tasktrackr',
          phases: [
            {
              phaseKey: 'requirements',
              opensAt: null,
              dueAt: '2026-08-31T23:59:00.000Z',
            },
          ],
        },
      );

      const rows = parse(await service.exportCsv(dana, 'tasktrackr'));
      const header = rows[0];
      expect(header.slice(-4)).toEqual([
        'packVersion',
        'submittedAt',
        'late',
        'regraded',
      ]);
      const byPhase = new Map(
        rows.slice(1).map((row) => [row[5], row.slice(-4)]),
      );
      // submitted on 1 September against a deadline of 31 August
      expect(byPhase.get('requirements')).toEqual([
        '0.9.0',
        '2026-09-01T10:00:00.000Z',
        'yes',
        'yes',
      ]);
      // A phase with no submission has nothing to say about any of the four,
      // and a blank is not the same claim as a "no".
      expect(byPhase.get('design')).toEqual(['', '', '', '']);
    });

    it('says nothing about lateness for a class that has set no dates', async () => {
      const rows = parse(await service.exportCsv(dana, 'tasktrackr'));
      const byPhase = new Map(
        rows.slice(1).map((row) => [row[5], row.slice(-4)]),
      );
      expect(byPhase.get('requirements')![2]).toBe('');
    });
  });

  /**
   * The grade book: one row per learner and project, one column
   * per phase. A different question from the export above, not a smaller one.
   */
  describe('exportGradebook', () => {
    const parse = (csv: string) =>
      csv
        .trimEnd()
        .split('\r\n')
        .map((line) => line.split(','));

    it('is one row per learner with a column per phase, and blanks a phase with no score', async () => {
      const rows = parse(await service.exportGradebook(dana, 'tasktrackr'));
      expect(rows[0]).toEqual([...GRADEBOOK_COLUMNS]);
      expect(rows).toHaveLength(2);
      // "Lee, Learner" holds a comma, so the quoted name splits in this parser
      const cells = rows[1];
      expect(cells.slice(0, 5)).toEqual([
        'lee@learnsdlc.test',
        '"Lee',
        ' Learner"',
        'Tuesday class',
        'tasktrackr',
      ]);
      // requirements scored 82, everything after it blank rather than zero
      expect(cells.slice(5, 11)).toEqual(['82', '', '', '', '', '']);
      // the mean of the phases that have a score, then the gates and the flag
      expect(cells.slice(11, 14)).toEqual(['82', '1', 'false']);
    });

    it('rounds the average over the phases that have a score, ignoring the rest', async () => {
      const [, design] = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      await manager().update(PhaseStateEntity, design.id, { bestScore: 61 });
      const cells = parse(await service.exportGradebook(dana, 'tasktrackr'))[1];
      // (82 + 61) / 2 = 71.5
      expect(cells.slice(11, 14)).toEqual(['72', '1', 'false']);
    });

    /**
     * Teachers want *"an overview of the checklist as one intuitive
     * percentage"*, and this file is where a teacher
     * takes it away. Both numbers are read off the **pinned version's** tasks,
     * which is a different question from the `gates passed` column beside them.
     */
    describe('the two overview columns', () => {
      it('appends them without moving a single existing column', () => {
        // The header is the contract a spreadsheet import reads: a saved import
        // maps by position, so the prefix has to be byte-identical and the new
        // names have to be at the end.
        expect(GRADEBOOK_COLUMNS.slice(-2)).toEqual([
          'checklist %',
          'quiz mastery %',
        ]);
        expect(GRADEBOOK_COLUMNS.slice(0, -2).join(',')).toBe(
          'email,displayName,class,project,requirements,design,implementation,testing,deployment,maintenance,average,gates passed,completed',
        );
      });

      it('counts the checklist over the version’s required tasks, and blanks mastery where there is no quiz', async () => {
        const cells = parse(await service.exportGradebook(dana, 'tasktrackr'))[1];
        // One of TaskTrackr's six sole tasks has passed, and each of them is
        // required: 1/6 rounds to 17. The `gates passed` column beside it says
        // 1; the same fact counted in phases rather than as a percentage.
        expect(cells.at(-2)).toBe('17');
        // **A blank, and not a `0`.** The shipped project declares no quiz, so
        // there is no concept score to report; a zero would report a failure
        // nobody had. It is also not the word "null", which is what a cell that
        // skipped `csvCell` would print.
        expect(cells.at(-1)).toBe('');
      });

      it('moves the checklist as the version’s required tasks pass', async () => {
        const states = await manager().find(PhaseStateEntity, {
          where: { userId: learnerId },
          order: { phaseOrder: 'ASC' },
        });
        for (const state of states.slice(0, 3))
          await manager().update(PhaseStateEntity, state.id, { status: 'passed' });
        const cells = parse(await service.exportGradebook(dana, 'tasktrackr'))[1];
        expect(cells.at(-2)).toBe('50');
      });

      it('runs every cell through the formula guard, the two new ones included', async () => {
        await manager().update(
          UserEntity,
          { id: learnerId },
          { displayName: '=HYPERLINK("http://x")' },
        );
        const line = parse(await service.exportGradebook(dana, 'tasktrackr'))[1];
        expect(line).toHaveLength(GRADEBOOK_COLUMNS.length);
        // Nothing a spreadsheet would run as a formula survives the export, and
        // the two appended cells are inside the same map as the rest rather
        // than concatenated on after it.
        for (const cell of line) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
      });
    });

    it('covers only the class the caller owns, and is just the header when it is empty', async () => {
      const mine = await service.exportGradebook(dana);
      expect(mine).not.toContain('ola@learnsdlc.test');
      await manager().delete(EnrollmentEntity, { userId: learnerId });
      expect(await service.exportGradebook(dana)).toBe(
        `${GRADEBOOK_COLUMNS.join(',')}\r\n`,
      );
    });

    it('quotes a display name a spreadsheet would otherwise run as a formula', async () => {
      await manager().update(
        UserEntity,
        { id: learnerId },
        { displayName: '=HYPERLINK("http://x")' },
      );
      expect(await service.exportGradebook(dana, 'tasktrackr')).toContain(
        '"\'=HYPERLINK(""http://x"")"',
      );
    });
  });

  /* ------------------------- dossier --------------------------------------- */

  describe('learnerDossier', () => {
    it('prints the learner as the console already scopes them, phases oldest first', async () => {
      const dossier = await service.learnerDossier(dana, learnerId);
      expect(dossier).toMatchObject({
        audience: 'instructor',
        userId: learnerId,
        email: 'lee@learnsdlc.test',
        displayName: 'Lee, Learner',
        cohortName: 'Tuesday class',
        projectSlug: 'tasktrackr',
        phasesPassed: 0,
        totalPhases: 6,
      });
      expect(dossier.phases.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6]);
      const [first] = dossier.phases;
      expect(first.status).toBe('submitted');
      expect(first.passedAt).toBeNull();
      expect(first.revisions.every(row => row.verifiedPass === false)).toBe(true);
      expect(first.bestScore).toBe(82);
      // Two attempts, oldest first, numbered the way the revision list is.
      expect(first.revisions.map((r) => r.attempt)).toEqual([1, 2]);
      expect(first.revisions.map((r) => r.score)).toEqual([40, 82]);
      // The verdict the phase was merged on is the one that passed.
      expect(first.merged?.score).toBe(82);
      expect(first.merged?.report?.passed).toBe(true);
      expect(dossier.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('does not certify imported completion and verifies every strict rubric item and retained context', async () => {
      const phases = await manager().find(PhaseStateEntity, { where: { userId: learnerId }, order: { phaseOrder: 'ASC' } });
      const first = phases[0];
      await manager().update(PhaseStateEntity, { userId: learnerId }, { status: 'passed', passedAt: '2026-09-10T12:00:00Z' });
      await manager().update(EnrollmentEntity, first.enrollmentId, { completedAt: '2026-09-10T12:00:00Z' });
      const legacy = await service.learnerDossier(dana, learnerId);
      expect(legacy.completedAt).toBeNull();
      expect(legacy.phasesPassed).toBe(0);
      expect(legacy.phases.every(phase => phase.status !== 'passed')).toBe(true);
      expect(legacy.phases[0].revisions.map(row => row.score)).toEqual([40, 82]);
      const phase = content.getProject('tasktrackr').phases.find(item => item.key === 'requirements')!;
      const strictReport = {
        ...report(false), assessmentMode: 'strict_binary', overall: 100, passed: true,
        checks: [{ id: 'record', label: 'Recorded checks', status: 'passed', detail: 'Unit fixture evidence' }],
        aiReview: { ...report(false).aiReview, provider: 'unit-test-fixture', verdict: 'pass', criteriaEvidence: phase.rubric.criteria.map(item => ({ key: item.key, met: true, evidence: 'Retained fixture evidence.', issue: '', nextStep: '' })) },
      } as FeedbackReport;
      const submission = await manager().save(manager().create(SubmissionEntity, {
        userId: learnerId, phaseStateId: first.id, status: 'completed', passed: true, score: 100,
        report: strictReport, workspaceSnapshot: { 'requirements/story.json': 'Retained fixture source' },
        contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
      }));
      const valid = await service.learnerDossier(dana, learnerId);
      expect(valid.phasesPassed).toBe(1);
      expect(valid.phases[0].status).toBe('passed');
      expect(valid.phases[0].revisions.find(row => row.id === submission.id)?.verifiedPass).toBe(true);
      expect(valid.completedAt).toBeNull();
      await manager().update(SubmissionEntity, submission.id, { workspaceSnapshot: null });
      expect((await service.learnerDossier(dana, learnerId)).phasesPassed).toBe(0);
      await manager().update(SubmissionEntity, submission.id, { workspaceSnapshot: { 'requirements/story.json': 'Retained fixture source' }, contextSnapshot: null });
      expect((await service.learnerDossier(dana, learnerId)).phasesPassed).toBe(0);
      await manager().update(SubmissionEntity, submission.id, { contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false }, report: { ...strictReport, aiReview: { ...strictReport.aiReview, criteriaEvidence: [] } } });
      expect((await service.learnerDossier(dana, learnerId)).phasesPassed).toBe(0);
      expect((await manager().findOneByOrFail(PhaseStateEntity, { id: first.id })).status).toBe('passed');
    });

    it('carries the mentor as a count and never as text', async () => {
      const dossier = await service.learnerDossier(dana, learnerId);
      const mentorRows = dossier.journal.filter((row) => row.kind === 'hint');
      expect(mentorRows.length).toBeGreaterThan(0);
      for (const row of mentorRows) {
        expect(row.detail).toBe('');
        expect(row.title).toBe('Asked the mentor');
        expect(row.result).toMatch(/^\d+ questions?$/);
      }
      // The phase carries the same number the console's reliance index is
      // drawn from, so nothing had to be recounted to print it.
      expect(dossier.phases[0].hints).toBe(2);
    });

    it('prints the code the merged revision was graded from, and nothing when it was pruned', async () => {
      const phase1 = await manager().findOneOrFail(PhaseStateEntity, {
        where: { userId: learnerId, phaseOrder: 1 },
      });
      await manager().update(
        SubmissionEntity,
        { phaseStateId: phase1.id, passed: true },
        {
          workspaceSnapshot: {
            'requirements/story.json': '# US-4 the overdue report',
          },
        },
      );
      const withFiles = await service.learnerDossier(dana, learnerId);
      expect(withFiles.phases[0].files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'requirements/story.json',
            content: '# US-4 the overdue report',
          }),
        ]),
      );
      // Read-only pack files are not reprinted: a dossier of the scaffold is
      // not a record of the learner.
      expect(
        withFiles.phases[0].files.every((f) =>
          f.path.startsWith('requirements/'),
        ),
      ).toBe(true);

      await manager().update(
        SubmissionEntity,
        { phaseStateId: phase1.id, passed: true },
        { workspaceSnapshot: null },
      );
      const pruned = await service.learnerDossier(dana, learnerId);
      expect(pruned.phases[0].files).toEqual([]);
    });

    it('uses the last submitted evidence for an unfinished phase and excludes private draft decisions', async () => {
      const phase = await manager().findOneByOrFail(PhaseStateEntity, {
        userId: learnerId,
        phaseOrder: 2,
      });
      await manager().update(PhaseStateEntity, phase.id, {
        workspace: {
          'design/design.json': JSON.stringify({
            decisions: [
              {
                id: 'PRIVATE_DRAFT',
                status: 'accepted',
                decidedAt: '2026-09-01T00:00:00Z',
                choice: 'PRIVATE_DRAFT_CHOICE',
                rationale: 'PRIVATE_DRAFT_REASON',
              },
            ],
          }),
        },
        links: [
          { testId: 'PRIVATE_DRAFT_TEST', criterionId: 'private' },
        ] as any,
      });
      const before = await service.learnerDossier(dana, learnerId);
      expect(before.phases[1].files).toEqual([]);
      expect(JSON.stringify(before)).not.toContain('PRIVATE_DRAFT');
      await manager().save(
        manager().create(SubmissionEntity, {
          userId: learnerId,
          phaseStateId: phase.id,
          status: 'completed',
          passed: false,
          workspaceSnapshot: { 'design/design.json': '{"submitted":true}' },
        }),
      );
      const after = await service.learnerDossier(dana, learnerId);
      expect(after.phases[1].files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: 'design/design.json',
            content: '{"submitted":true}',
          }),
        ]),
      );
      expect(JSON.stringify(after)).not.toContain('PRIVATE_DRAFT');
      expect(after.phases[1].links).toEqual([]);
      expect(
        (await state(phase.id)).workspace?.['design/design.json'],
      ).toContain('PRIVATE_DRAFT');
    });

    it("carries the stories a design phase's spec lists, and none on a phase of another kind", async () => {
      // the shipped pack's Design is a design phase since 4.0.0: it carries TaskTrackr's stories, and no other phase any
      const shipped = await service.learnerDossier(dana, learnerId);
      expect(shipped.phases.find((phase) => phase.key === 'design')?.designStories?.map((one) => one.id)).toEqual(['US-2', 'US-3', 'US-4']);
      expect(shipped.phases.find((phase) => phase.key === 'design')?.designContracts).toEqual({ api: true, screens: true });
      expect(shipped.phases.filter((phase) => phase.key !== 'design').every((phase) => phase.designStories === undefined)).toBe(true);
      // the enrolment's own version, with its Design phase given the teacher's own stories
      const stories = [{ id: 'US-3', title: 'Filter, search and order a list', line: 'As a busy learner, I want to filter my tasks.' }];
      const checks: DesignChecksSpec = { kind: 'design', record: DESIGN_JSON, contracts: { api: false, screens: false }, sequence: false, stories, floor: DEFAULT_DESIGN_FLOOR };
      const pinned = content.getForEnrollment.bind(content);
      const spy = jest.spyOn(content, 'getForEnrollment').mockImplementation((enrollment) => {
        const project = pinned(enrollment);
        return { ...project, phases: project.phases.map((phase) => (phase.key === 'design' ? { ...phase, checks } : phase)) };
      });
      try {
        const dossier = await service.learnerDossier(dana, learnerId);
        expect(dossier.phases.find((phase) => phase.key === 'design')?.designStories).toEqual(stories);
        expect(dossier.phases.filter((phase) => phase.key !== 'design').every((phase) => phase.designStories === undefined)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it("carries a code Maintenance's ticket from the version's spec for section 9, copied, and none where the spec has none", async () => {
      // the shipped pack's Maintenance carries CR-2 since TaskTrackr 5.0.0, and no other phase has a ticket
      const shipped = await service.learnerDossier(dana, learnerId);
      expect(shipped.phases.find((phase) => phase.key === 'maintenance')?.changeTicket?.id).toBe('CR-2');
      expect(shipped.phases.filter((phase) => phase.key !== 'maintenance').every((phase) => phase.changeTicket === undefined)).toBe(true);
      const ticket = { id: 'CR-2', title: 'Comments on a task', summary: 'Users want comments.', acceptance: [{ id: 'AC-1', line: 'A comment can be added.' }] };
      const pinned = content.getForEnrollment.bind(content);
      const spy = jest.spyOn(content, 'getForEnrollment').mockImplementation((enrollment) => {
        const project = pinned(enrollment);
        return {
          ...project,
          phases: project.phases.map((phase) =>
            phase.key === 'maintenance' && phase.checks.kind === 'code' ? { ...phase, checks: { ...phase.checks, ticket } } : phase,
          ),
        };
      });
      try {
        const dossier = await service.learnerDossier(dana, learnerId);
        const maintenance = dossier.phases.find((phase) => phase.key === 'maintenance');
        expect(maintenance?.changeTicket).toEqual(ticket);
        // a copy: the dossier never hands out the spec's own objects
        expect(maintenance?.changeTicket).not.toBe(ticket);
        expect(maintenance?.changeTicket?.acceptance[0]).not.toBe(ticket.acceptance[0]);
        expect(dossier.phases.filter((phase) => phase.key !== 'maintenance').every((phase) => phase.changeTicket === undefined)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    });

    it('retains every revision past the former fifty-review window', async () => {
      const phase = await manager().findOneByOrFail(PhaseStateEntity, {
        userId: learnerId,
        phaseOrder: 2,
      });
      await manager().save(
        Array.from({ length: 61 }, (_, index) =>
          manager().create(SubmissionEntity, {
            phaseStateId: phase.id,
            userId: learnerId,
            status: 'completed',
            passed: false,
            commitMessage: `Review ${index + 1}`,
            createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
          }),
        ),
      );
      const dossier = await service.learnerDossier(dana, learnerId);
      expect(dossier.phases[1].revisions).toHaveLength(61);
      expect(dossier.phases[1].revisions.map((row) => row.attempt)).toEqual(
        Array.from({ length: 61 }, (_, index) => index + 1),
      );
    });

    it('is a 404 for a learner in another class and reachable by an admin', async () => {
      await expect(
        service.learnerDossier(sam, learnerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.learnerDossier(dana, missingId),
      ).rejects.toBeInstanceOf(NotFoundException);
      const asAdmin = await service.learnerDossier(admin, learnerId);
      expect(asAdmin.userId).toBe(learnerId);
    });

    it('refuses a project the learner has not started', async () => {
      await expect(
        service.learnerDossier(dana, learnerId, SECOND_PROJECT),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /*
     * Spec 4.3 and 11 (A M-A4, C I2): the completion record over a version of
     * fewer phases. The dossier reads complete when every phase the pinned
     * version holds has a passed, verified state, and never on the board's
     * states alone, because an imported board can hold fewer states than its
     * version and still carry a completion.
     */
    describe('the completion record over a three-phase and a one-phase version', () => {
      const V_THREE = 'v-three';
      const V_ONE = 'v-one';
      const V_NO_TESTING = 'v-no-testing';
      /** TaskTrackr itself, so the learner's own TaskTrackr enrolment (every case's) resolves in this registry too. */
      const V_TASKTRACKR = 'v-tasktrackr';
      const COMPLETED_AT = '2026-09-10T12:00:00.000Z';
      let subsets: ContentService;
      let dossiers: InstructorService;

      /** TaskTrackr's phases cut to a subset and renumbered 1 to n, as the draft compiler numbers them. */
      const subsetOf = (shipped: ProjectContent, slug: string, keys: string[]): ProjectContent => ({
        ...shipped,
        slug,
        phases: shipped.phases.filter((one) => keys.includes(one.key)).map((one, at) => ({ ...one, order: at + 1 })),
      });

      beforeAll(() => {
        subsets = new ContentService();
        subsets.loadAll();
        const shipped = subsets.getProject('tasktrackr');
        subsets.installVersions(
          ([
            [V_THREE, subsetOf(shipped, 'three', ['requirements', 'design', 'implementation'])],
            [V_ONE, subsetOf(shipped, 'one', ['testing'])],
            [V_NO_TESTING, subsetOf(shipped, 'no-testing', ['requirements', 'design', 'implementation', 'deployment', 'maintenance'])],
            [V_TASKTRACKR, shipped],
          ] as const).map(
            ([versionId, project]) => ({
              versionId,
              content: project,
              phases: project.phases.map((one) => ({ key: one.key, tasks: [soleTaskFor(one)] })),
              compiler: COMPILER_IDENTITY,
            }),
          ),
        );
        dossiers = new InstructorService(dataSource, subsets, assistant);
      });

      /** The learner's analytics over this registry, as their dashboard and the class console read them. */
      const analyticsOver = (): AnalyticsService =>
        new AnalyticsService(
          dataSource.getRepository(UserEntity),
          dataSource.getRepository(EnrollmentEntity),
          dataSource.getRepository(PhaseStateEntity),
          dataSource.getRepository(AssistantMessageEntity),
          subsets,
          { tokensToday: async () => 0, recentProviderName: async () => 'local-mentor' } as unknown as AssistantService,
        );

      /**
       * An enrolment pinned to `versionId` carrying a completion, with a state
       * for each of `keys` passed on a retained strict-evidence revision, the
       * rows written directly as an imported enrolment can carry them.
       */
      const completedOn = async (slug: string, versionId: string, keys: string[]): Promise<void> => {
        const enrollment = await manager().save(manager().create(EnrollmentEntity, {
          userId: learnerId, projectSlug: slug, projectVersionId: versionId, currentPhaseOrder: 1,
          completed: true, completedAt: COMPLETED_AT,
        }));
        for (const phase of subsets.getForEnrollment(enrollment).phases.filter((one) => keys.includes(one.key))) {
          const held = await manager().save(manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id, userId: learnerId, phaseKey: phase.key, phaseOrder: phase.order,
            status: 'passed', passedAt: COMPLETED_AT,
          }));
          await manager().save(manager().create(SubmissionEntity, {
            userId: learnerId, phaseStateId: held.id, status: 'completed', passed: true, score: 100,
            report: {
              ...report(false), assessmentMode: 'strict_binary', overall: 100, passed: true,
              checks: [{ id: 'record', label: 'Recorded checks', status: 'passed', detail: 'Unit fixture evidence' }],
              tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] },
              aiReview: { ...report(false).aiReview, provider: 'unit-test-fixture', verdict: 'pass', criteriaEvidence: phase.rubric.criteria.map((item) => ({ key: item.key, met: true, evidence: 'Retained fixture evidence.', issue: '', nextStep: '' })) },
            } as FeedbackReport,
            workspaceSnapshot: { fixture: 'Retained fixture source' },
            contextSnapshot: { links: [], drill: null, ranBeforeSubmit: true },
          }));
        }
      };

      it('the dossier reads complete on a three-phase and on a one-phase version when every phase it holds is passed and verified', async () => {
        await completedOn('three', V_THREE, ['requirements', 'design', 'implementation']);
        const three = await dossiers.learnerDossier(dana, learnerId, 'three');
        expect(three.phases.map((one) => [one.key, one.status])).toEqual([['requirements', 'passed'], ['design', 'passed'], ['implementation', 'passed']]);
        expect(three.completedAt).toBe(COMPLETED_AT);
        expect([three.phasesPassed, three.totalPhases]).toEqual([3, 3]);

        await completedOn('one', V_ONE, ['testing']);
        const one = await dossiers.learnerDossier(dana, learnerId, 'one');
        expect(one.phases.map((phase) => [phase.key, phase.status])).toEqual([['testing', 'passed']]);
        expect(one.completedAt).toBe(COMPLETED_AT);
      });

      it('the dossier reads not complete on a three-phase version whose enrolment holds two passed, verified states and a completedAt', async () => {
        await completedOn('three', V_THREE, ['requirements', 'design']);
        const dossier = await dossiers.learnerDossier(dana, learnerId, 'three');
        expect(dossier.phases.map((one) => [one.key, one.status])).toEqual([['requirements', 'passed'], ['design', 'passed']]);
        expect(dossier.completedAt).toBeNull();
        // every count reads the version's three phases, never the board's two states
        expect([dossier.phasesPassed, dossier.totalPhases]).toEqual([2, 3]);
        const mine = await analyticsOver().forLearner(learnerId, 'three');
        expect([mine.phasesPassed, mine.totalPhases, mine.progressPercent]).toEqual([2, 3, 67]);
        const row = (await analyticsOver().instructorOverview(dana.id, 'three')).learners.find((one) => one.userId === learnerId);
        expect([row?.phasesPassed, row?.progressPercent]).toEqual([2, 67]);
      });

      it("the dossier and the teacher's view of the enrolment leave out a state for a phase the pinned version lacks, and count the version's phases", async () => {
        // An enrolment made on the six and pinned to a version without Testing, as the publish door pins a null
        // row: its Testing state stays in the store, and neither the board nor the record draws or counts it.
        await completedOn('no-testing', V_NO_TESTING, ['requirements']);
        const enrollment = await manager().findOneByOrFail(EnrollmentEntity, { userId: learnerId, projectSlug: 'no-testing' });
        await manager().update(EnrollmentEntity, { id: enrollment.id }, { completed: false, completedAt: null });
        const held = subsets.getForEnrollment(enrollment).phases;
        for (const [key, order, status] of [['design', 2, 'in_progress'], ['implementation', 3, 'locked'], ['testing', 6, 'passed'], ['deployment', 4, 'locked'], ['maintenance', 5, 'locked']] as const) {
          expect(key === 'testing' || held.some((one) => one.key === key && one.order === order)).toBe(true);
          await manager().save(manager().create(PhaseStateEntity, { enrollmentId: enrollment.id, userId: learnerId, phaseKey: key, phaseOrder: order, status }));
        }
        const kept = ['requirements', 'design', 'implementation', 'deployment', 'maintenance'];

        const dossier = await dossiers.learnerDossier(dana, learnerId, 'no-testing');
        expect(dossier.phases.map((one) => one.key)).toEqual(['requirements', 'design', 'implementation', 'deployment', 'maintenance']);
        expect([dossier.phasesPassed, dossier.totalPhases]).toEqual([1, 5]);
        expect(dossier.journal.some((row) => row.phaseKey === 'testing')).toBe(false);

        const detail = await dossiers.learnerDetail(dana, learnerId);
        const view = detail.enrollments.find((one) => one.projectSlug === 'no-testing');
        expect(view?.phases.map((one) => one.key).sort()).toEqual([...kept].sort());

        // the learner's analytics and the class console: the stale Testing pass is no pass, and the version's five are the count
        const mine = await analyticsOver().forLearner(learnerId, 'no-testing');
        expect(mine.phases.map((one) => one.key).sort()).toEqual([...kept].sort());
        expect([mine.phasesPassed, mine.totalPhases, mine.progressPercent]).toEqual([1, 5, 20]);
        const row = (await analyticsOver().instructorOverview(dana.id, 'no-testing')).learners.find((one) => one.userId === learnerId);
        expect([row?.phasesPassed, row?.progressPercent]).toEqual([1, 20]);

        // the repository's README counts the version's phases and their passes
        const chunks: Buffer[] = [];
        await new RepoService(dataSource, subsets).export(learnerId, 'no-testing', async (chunk) => {
          chunks.push(chunk);
        });
        expect(Buffer.concat(chunks).toString('latin1')).toContain('Five phases, one recorded as passed.');
      });
    });

    it('leaves a dossier.read row naming the learner and the project', async () => {
      await service.learnerDossier(dana, learnerId);
      const rows = await manager().find(AuditEventEntity, {
        where: { event: 'dossier.read' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: dana.id,
        subjectUserId: learnerId,
        targetId: 'tasktrackr',
        action: 'read',
      });
      // A refusal is not a read: nothing is written for a learner the caller
      // cannot reach.
      await expect(
        service.learnerDossier(sam, learnerId),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await manager().count(AuditEventEntity, {
          where: { event: 'dossier.read' },
        }),
      ).toBe(1);
    });
  });

  /* ------- teacher-authored projects: the task grain ------------------------ */

  /**
   * A phase with more than one task, and the four surfaces that have to say
   * which task they are talking about.
   *
   * The levers first. A teacher's three per-task levers are refused on a phase
   * whose compiled list is the synthesised sole task **by name**, because such a
   * phase declares `SOLE_TASK_KEY` and a key check alone would accept
   * `task-signoff` on the empty key, take `phaseRollup`'s first arm and flip the
   * phase to `passed` at `Math.max(bestScore ?? 0, 0)`; past `pass`'s
   * already-passed refusal and past its `passThreshold` floor.
   *
   * Then the reporting. A dossier that prints a phase as passed on one task's
   * evidence while `advance` refuses the same phase is two surfaces disagreeing
   * about one gate, and the gate is the one that is right.
   */
  describe('the task grain', () => {
    const TEACHER = 'ms-tan-tasktrackr';
    const V_FLAT = 'v-tasktrackr-head';
    const V_SPLIT = 'v-teacher-split';

    let shipped: ProjectContent;
    let teacher: ProjectContent;
    let requirements: PhaseContent;

    /** A compiled task over the requirements phase's own sole task. */
    const taskLike = (over: Partial<CompiledTask>): CompiledTask => ({
      ...soleTaskFor(requirements),
      ...over,
    });

    /** `story` required, `scope` optional; the split a teacher makes a written phase for. */
    const storyAndScope = (): CompiledTask[] => [
      taskLike({
        taskKey: 'story',
        order: 1,
        title: 'The story',
        gradedUnits: [{ kind: 'rule', id: 'story-format' }],
      }),
      taskLike({
        taskKey: 'scope',
        order: 2,
        required: false,
        title: 'The scope note',
        gradedUnits: [{ kind: 'rule', id: 'scope-note' }],
      }),
    ];

    /**
     * `story` required, `concepts` an **optional quiz**; the shape the two
     * overview columns exist to report on.
     *
     * The questions are a clearly-fake fixture and are deliberately not
     * teaching material: the starter questions are a content task for a person
     * to write and review, and inventing plausible ones here would put
     * unreviewed content in a test file where it reads as reviewed content.
     * Nothing below reads a stem; what is under test is that a quiz task's best
     * score reaches the gradebook and that a task owning no file still counts.
     */
    const storyAndQuiz = (): CompiledTask[] => [
      taskLike({
        taskKey: 'story',
        order: 1,
        title: 'The story',
        gradedUnits: [{ kind: 'rule', id: 'story-format' }],
      }),
      taskLike({
        taskKey: 'concepts',
        order: 2,
        required: false,
        checkKind: 'quiz',
        artefactType: 'quiz',
        artefactPath: null,
        title: 'Check your understanding',
        owns: [],
        gradedUnits: [
          { kind: 'question', id: 'fixture-one' },
          { kind: 'question', id: 'fixture-two' },
        ],
        checks: {
          kind: 'quiz',
          questions: [
            {
              id: 'fixture-one',
              stem: 'Fixture question one.',
              options: [
                { id: 'a', text: 'Fixture option A.' },
                { id: 'b', text: 'Fixture option B.' },
              ],
              correct: ['a'],
              explanation: 'Fixture explanation one.',
            },
            {
              id: 'fixture-two',
              stem: 'Fixture question two.',
              options: [
                { id: 'a', text: 'Fixture option A.' },
                { id: 'b', text: 'Fixture option B.' },
              ],
              correct: ['b'],
              explanation: 'Fixture explanation two.',
            },
          ],
          shuffleOptions: false,
          passMark: 60,
          attempts: { max: 3, cooldownSeconds: null },
          criterion: 'concepts',
        },
      }),
    ];

    /** The same pair with the quiz REQUIRED; the shape the lock is reachable on. */
    const storyAndRequiredQuiz = (): CompiledTask[] =>
      storyAndQuiz().map((task) =>
        task.taskKey === 'concepts' ? { ...task, required: true } : task,
      );

    /** A catalogue holding the shipped pack flat and the copy split as given. */
    const publish = (tasks: CompiledTask[]): ContentService => {
      const loaded = new ContentService();
      loaded.loadAll();
      loaded.installVersions([
        {
          versionId: V_FLAT,
          content: shipped,
          compiler: COMPILER_IDENTITY,
          phases: shipped.phases.map((phase) => ({ key: phase.key, tasks: [soleTaskFor(phase)] })),
        },
        {
          versionId: V_SPLIT,
          content: teacher,
          compiler: COMPILER_IDENTITY,
          phases: teacher.phases.map((phase) =>
            phase.key === 'requirements'
              ? { key: phase.key, tasks }
              : { key: phase.key, tasks: [soleTaskFor(phase)] },
          ),
        },
      ]);
      return loaded;
    };

    const serviceOn = (held: ContentService): InstructorService =>
      new InstructorService(dataSource, held, assistant);

    /** Enrol the class's learner on the split copy, pinned to it. */
    const enrolSplit = async (
      tasks: CompiledTask[],
    ): Promise<{ states: Record<string, PhaseStateEntity>; rows: TaskStateEntity[] }> => {
      const enrollment = await manager().save(
        manager().create(EnrollmentEntity, {
          userId: learnerId,
          projectSlug: TEACHER,
          projectVersionId: V_SPLIT,
          currentPhaseOrder: 1,
        }),
      );
      const states: Record<string, PhaseStateEntity> = {};
      for (const phase of teacher.phases) {
        states[phase.key] = await manager().save(
          manager().create(PhaseStateEntity, {
            enrollmentId: enrollment.id,
            userId: learnerId,
            phaseKey: phase.key,
            phaseOrder: phase.order,
            status: phase.order === 1 ? 'in_progress' : 'locked',
          }),
        );
      }
      const rows: TaskStateEntity[] = [];
      for (const task of tasks) {
        rows.push(
          await manager().save(
            manager().create(TaskStateEntity, {
              phaseStateId: states.requirements.id,
              userId: learnerId,
              taskKey: task.taskKey,
            }),
          ),
        );
      }
      return { states, rows };
    };

    const taskRows = (phaseStateId: string) =>
      manager().find(TaskStateEntity, { where: { phaseStateId }, order: { taskKey: 'ASC' } });

    /**
     * A revision the strict gate accepts for one phase: every criterion of that
     * phase's rubric evidenced, one passing check, and (on an executable
     * phase) a suite that collected something and stayed green, because
     * clause 6 refuses an absent or empty suite unconditionally.
     */
    const strictReport = (phaseKey = 'requirements'): FeedbackReport => {
      const phase = teacher.phases.find((one) => one.key === phaseKey)!;
      const base = report(false);
      const executable = phase.checks.kind === 'code' || phase.checks.kind === 'tests';
      return {
        ...base,
        assessmentMode: 'strict_binary',
        overall: 100,
        passed: true,
        checks: [
          { id: 'record', label: 'Recorded checks', status: 'passed', detail: 'Unit fixture evidence' },
        ],
        ...(executable
          ? { tests: { total: 1, passed: 1, failed: 0, errored: 0, cases: [] } }
          : {}),
        aiReview: {
          ...base.aiReview,
          provider: 'unit-test-fixture',
          verdict: 'pass',
          criteriaEvidence: phase.rubric.criteria.map((item) => ({
            key: item.key,
            met: true,
            evidence: 'Retained fixture evidence.',
            issue: '',
            nextStep: '',
          })),
        },
      } as FeedbackReport;
    };

    /** The two columns a strict pass needs retained beside the report. */
    const retained: Partial<SubmissionEntity> = {
      workspaceSnapshot: { 'requirements/story.json': 'Retained fixture source' },
      contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
    };

    const revise = (
      state: PhaseStateEntity,
      taskKey: string,
      over: Partial<SubmissionEntity>,
    ) =>
      manager().save(
        manager().create(SubmissionEntity, {
          phaseStateId: state.id,
          userId: learnerId,
          taskKey,
          status: 'completed',
          score: 82,
          passed: true,
          report: report(false),
          ...over,
        }),
      );

    beforeAll(() => {
      const loader = new ContentService();
      loader.loadAll();
      shipped = loader.getProject('tasktrackr');
      teacher = { ...shipped, slug: TEACHER, title: 'TaskTrackr (Ms Tan)' };
      requirements = teacher.phases.find((phase) => phase.key === 'requirements')!;
    });

    it('the three task levers are refused on a sole-task phase, by name', async () => {
      const [first] = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      const before = await state(first.id);
      for (const action of ['task-signoff', 'task-reset', 'task-reopen'] as const) {
        await expect(
          service.overridePhase(dana, learnerId, first.id, action, reason, ''),
        ).rejects.toThrow(SOLE_TASK_LEVER_REFUSAL);
      }
      const after = await state(first.id);
      expect({ status: after.status, passedAt: after.passedAt, bestScore: after.bestScore }).toEqual(
        { status: before.status, passedAt: before.passedAt, bestScore: before.bestScore },
      );
      expect(await manager().count(TaskStateEntity)).toBe(0);
    });

    it('an unknown task key is 404, in getPhase’s register', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      await expect(
        split.overridePhase(dana, learnerId, states.requirements.id, 'task-reopen', reason, 'epic'),
      ).rejects.toThrow(/unknown task: epic/);
      await expect(
        split.overridePhase(dana, learnerId, states.requirements.id, 'task-reopen', reason, 'epic'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reopen and reset-phase take the task rows down with the phase', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      await manager().update(PhaseStateEntity, states.requirements.id, {
        status: 'passed',
        passedAt: '2026-09-01T10:00:00.000Z',
        bestScore: 90,
        attempts: 4,
      });
      await manager().update(
        TaskStateEntity,
        { phaseStateId: states.requirements.id },
        {
          status: 'passed',
          passedAt: '2026-09-01T10:00:00.000Z',
          bestScore: 90,
          attempts: 3,
          awaitingSignOff: false,
          solutionReadAt: '2026-09-01T11:00:00.000Z',
          resetCount: 2,
        },
      );

      await split.overridePhase(dana, learnerId, states.requirements.id, 'reopen', reason);
      let rows = await taskRows(states.requirements.id);
      expect(rows.map((row) => [row.status, row.passedAt])).toEqual([
        ['in_progress', null],
        ['in_progress', null],
      ]);
      // A reopen withdraws the pass and keeps the record: the score history,
      // how many goes the learner has had, and how many resets they have had.
      expect(rows.map((row) => [row.bestScore, row.attempts, row.resetCount])).toEqual([
        [90, 3, 2],
        [90, 3, 2],
      ]);

      await split.overridePhase(dana, learnerId, states.requirements.id, 'reset-phase', reason);
      rows = await taskRows(states.requirements.id);
      expect(
        rows.map((row) => [row.bestScore, row.solutionReadAt, row.ranBeforeSubmit]),
      ).toEqual([
        [null, null, false],
        [null, null, false],
      ]);
      // `attempts` is a fact about the learner. The phase lever starts every
      // NON-QUIZ task over, so their `resetCount` rises by one (both tasks
      // here are written tasks); a quiz's count is its attempt epoch and stays.
      expect(rows.map((row) => [row.attempts, row.resetCount])).toEqual([
        [3, 3],
        [3, 3],
      ]);
      expect((await state(states.requirements.id)).attempts).toBe(4);
    });

    it('a reset phase does not come back at its old score', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      await manager().update(PhaseStateEntity, states.requirements.id, {
        status: 'passed',
        bestScore: 90,
      });
      await manager().update(
        TaskStateEntity,
        { phaseStateId: states.requirements.id },
        { status: 'passed', bestScore: 90 },
      );

      await split.overridePhase(dana, learnerId, states.requirements.id, 'reset-phase', reason);
      const after = await state(states.requirements.id);
      expect(after.bestScore).toBeNull();
      // and the roll-up a later verdict goes through has nothing left to carry
      // 90 forward with: the required task's own number is gone too, so a
      // resubmission at 10 rolls the phase up to 10 and not to 90.
      const rows = await taskRows(states.requirements.id);
      expect(rows.every((row) => row.bestScore === null)).toBe(true);
      const rolled = phaseRollup(
        { status: after.status, passedAt: after.passedAt, bestScore: after.bestScore },
        storyAndScope(),
        rows.map((row) =>
          row.taskKey === 'story'
            ? { ...row, status: 'passed' as const, bestScore: 10 }
            : row,
        ),
        { passed: true, overall: 10 },
        '2026-09-05T10:00:00.000Z',
      );
      expect(rolled.bestScore).toBe(10);
    });

    it('pass writes the required task rows and leaves a signOff task alone', async () => {
      const tasks = [
        ...storyAndScope(),
        taskLike({
          taskKey: 'interview',
          order: 3,
          signOff: true,
          title: 'The customer interview',
          gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
        }),
      ];
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));

      const view = await split.overridePhase(
        dana,
        learnerId,
        states.requirements.id,
        'pass',
        reason,
      );
      const rows = await taskRows(states.requirements.id);
      const byKey = new Map(rows.map((row) => [row.taskKey, row]));
      expect(byKey.get('story')!.status).toBe('passed');
      expect(byKey.get('story')!.bestScore).toBe(requirements.rubric.passThreshold);
      // An optional task is shown, scored and recorded, and moves no gate: the
      // teacher's Pass is about the gate, so it leaves the optional row alone.
      expect(byKey.get('scope')!.status).toBe('in_progress');
      // A `signOff` task is passed by a countersignature and by nothing else.
      expect(byKey.get('interview')!.status).toBe('in_progress');
      expect(rows.every((row) => !(row.status === 'passed' && row.awaitingSignOff))).toBe(true);
      expect(view.note).toContain('countersignature');
      expect(view.note).toContain('1 task');
    });

    it('pass writes a required task row the board never got, rather than skipping it', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      // The hole this test is about. `repairBoard` (the one writer that fills
      // it) runs from `reconcileToPack` and `phaseDetail`, which are the
      // learner's own reads; an override reaches neither. So a learner who has
      // not loaded their board since the phase was split, or a row lost to a
      // restore, arrives here with a required key and no row.
      await manager().delete(TaskStateEntity, { phaseStateId: states.requirements.id });

      await split.overridePhase(dana, learnerId, states.requirements.id, 'pass', reason);

      const rows = await taskRows(states.requirements.id);
      const byKey = new Map(rows.map((row) => [row.taskKey, row]));
      // A missing row is a failing row: `phaseRollup` quantifies over the
      // required KEYS and `strictPass` reads the row itself. Skipping it wrote
      // the phase green over a gate that refuses `advance` for ever, and told
      // the teacher nothing, so the row the pinned version declares is
      // created here rather than waited for.
      expect(byKey.get('story')?.status).toBe('passed');
      expect(byKey.get('story')?.bestScore).toBe(requirements.rubric.passThreshold);
      expect(byKey.get('story')?.passedAt).toEqual(expect.any(String));
      expect((await state(states.requirements.id)).status).toBe('passed');
      // The gate's own conjunct, asked the way `advance` asks it.
      expect(
        [...requiredKeysOf(storyAndScope())].every(
          (key) => byKey.get(key)?.status === 'passed',
        ),
      ).toBe(true);
      // And only the gate's rows: an optional task moves no gate, so a Pass
      // about the gate mints nothing for it.
      expect(rows.map((row) => row.taskKey)).toEqual(['story']);
    });

    it('task-reopen on a required task writes the phase row down', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      const passPhase = async () => {
        await manager().update(PhaseStateEntity, states.requirements.id, {
          status: 'passed',
          passedAt: '2026-09-01T10:00:00.000Z',
        });
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id },
          { status: 'passed', passedAt: '2026-09-01T10:00:00.000Z' },
        );
      };

      await passPhase();
      await split.overridePhase(
        dana,
        learnerId,
        states.requirements.id,
        'task-reopen',
        reason,
        'story',
      );
      let after = await state(states.requirements.id);
      expect(after.status).toBe('in_progress');
      expect(after.passedAt).toBeNull();

      await passPhase();
      await split.overridePhase(
        dana,
        learnerId,
        states.requirements.id,
        'task-reopen',
        reason,
        'scope',
      );
      after = await state(states.requirements.id);
      // The optional task moves no gate, so reopening it moves no phase row.
      expect(after.status).toBe('passed');
      expect(after.passedAt).toBe('2026-09-01T10:00:00.000Z');
    });

    it('a sign-off on the last required task racing a sibling’s verdict leaves the phase passed', async () => {
      const tasks = [
        taskLike({ taskKey: 'story', order: 1, gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        taskLike({
          taskKey: 'interview',
          order: 2,
          signOff: true,
          gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
        }),
      ];
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      const phaseStateId = states.requirements.id;

      /** What the grader does when `story`'s verdict lands: the same roll-up. */
      const siblingVerdict = async (): Promise<void> => {
        await manager().transaction(async (tx) => {
          await tx.update(
            TaskStateEntity,
            { phaseStateId, taskKey: 'story' },
            { status: 'passed', passedAt: '2026-09-02T10:00:00.000Z', bestScore: 80 },
          );
          const held = await tx.findOneByOrFail(PhaseStateEntity, { id: phaseStateId });
          const rows = await tx.find(TaskStateEntity, { where: { phaseStateId } });
          await tx.update(
            PhaseStateEntity,
            { id: phaseStateId },
            phaseRollup(
              { status: held.status, passedAt: held.passedAt, bestScore: held.bestScore },
              tasks,
              rows,
              { passed: true, overall: 80 },
              '2026-09-02T10:00:00.000Z',
            ),
          );
        });
      };

      await Promise.all([
        siblingVerdict(),
        split.overridePhase(dana, learnerId, phaseStateId, 'task-signoff', reason, 'interview'),
      ]);

      const rows = await taskRows(phaseStateId);
      expect(rows.every((row) => row.status === 'passed')).toBe(true);
      // Both required tasks are through, so the phase is. Without the lever's
      // own transaction the second writer reads a board the first had not
      // committed, writes `submitted` over it, and nothing later heals it; a
      // countersignature happens once.
      expect((await state(phaseStateId)).status).toBe('passed');
    });

    /**
     * A verdict committing in the window between `overridePhase`'s ownership
     * read and the enrolment lock. Hooked onto that read rather than raced
     * against it, so the window is hit every run; the same idiom the
     * autosave test above uses, and the reason the lock has to serialise the
     * read the patch is computed from and not only the write.
     */
    const verdictDuringOverride = (
      phaseStateId: string,
      fields: Partial<PhaseStateEntity>,
    ): void => {
      const find = manager().findOne.bind(manager());
      let fired = false;
      jest
        .spyOn(manager(), 'findOne')
        .mockImplementation(async (entity: any, options: any) => {
          const row = await find(entity, options);
          if (
            !fired &&
            entity === PhaseStateEntity &&
            (row as PhaseStateEntity | null)?.id === phaseStateId
          ) {
            fired = true;
            await manager().update(PhaseStateEntity, phaseStateId, fields);
          }
          return row;
        });
    };

    it('a verdict landing after the override’s read still takes the phase down with the task', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      const phaseStateId = states.requirements.id;
      await manager().update(
        TaskStateEntity,
        { phaseStateId, taskKey: 'story' },
        { status: 'passed', passedAt: '2026-09-02T09:00:00.000Z' },
      );
      // The grader's verdict opens the phase while the teacher's click is in
      // flight. Reading it before the lock leaves `task-reopen` deciding the
      // phase write-down on a row that no longer exists.
      verdictDuringOverride(phaseStateId, {
        status: 'passed',
        passedAt: '2026-09-02T10:00:00.000Z',
      });

      await split.overridePhase(
        dana,
        learnerId,
        phaseStateId,
        'task-reopen',
        reason,
        'story',
      );

      const after = await state(phaseStateId);
      // `phaseRollup` is monotonic and never un-passes, so nothing heals this
      // later: a phase left green over a reopened required task stays green.
      expect(after.status).toBe('in_progress');
      expect(after.passedAt).toBeNull();
    });

    it('a verdict landing after the override’s read survives the sign-off’s roll-up', async () => {
      const tasks = [
        taskLike({ taskKey: 'story', order: 1, gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        taskLike({
          taskKey: 'interview',
          order: 2,
          signOff: true,
          gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }],
        }),
      ];
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      const phaseStateId = states.requirements.id;
      await manager().update(
        TaskStateEntity,
        { phaseStateId, taskKey: 'story' },
        { status: 'passed', passedAt: '2026-09-02T09:00:00.000Z', bestScore: 40 },
      );
      await manager().update(
        TaskStateEntity,
        { phaseStateId, taskKey: 'interview' },
        { awaitingSignOff: true, bestScore: 40 },
      );
      // The phase's own committed record at the moment the lock is taken.
      verdictDuringOverride(phaseStateId, {
        status: 'passed',
        passedAt: '2026-09-02T10:00:00.000Z',
        bestScore: 90,
      });

      await split.overridePhase(
        dana,
        learnerId,
        phaseStateId,
        'task-signoff',
        reason,
        'interview',
      );

      const after = await state(phaseStateId);
      expect(after.status).toBe('passed');
      // The moment the phase opened is the committed one, not a second one the
      // roll-up minted over a `passedAt` it read as null before the lock; the
      // dossier prints this and `completedAt` reads it.
      expect(after.passedAt).toBe('2026-09-02T10:00:00.000Z');
      // And the roll-up's monotonicity is monotonic over the committed number:
      // computed from a stale `null` it writes the mean of the rows instead.
      expect(after.bestScore).toBe(90);
    });

    /**
     * After a teacher's Sign off and then a Reset of the same task, the
     * console's row must not read "In progress, Not scored yet, signed off
     * 05:21 today". A reset starts the task over (its verdict, its score
     * and its door go) and a countersignature is part of that verdict, so it
     * goes with them. The audit trail keeps both levers.
     */
    it('a task reset takes the sign-off back with the pass', async () => {
      const tasks = storyAndScope();
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      const phaseStateId = states.requirements.id;

      await split.overridePhase(dana, learnerId, phaseStateId, 'task-signoff', reason, 'story');
      const signed = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
      expect(signed.signedOffBy).toEqual(expect.any(String));
      expect(signed.signedOffAt).toEqual(expect.any(String));

      const view = await split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story');

      const reset = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
      expect([reset.status, reset.bestScore, reset.signedOffBy, reset.signedOffAt]).toEqual([
        'in_progress',
        null,
        null,
        null,
      ]);
      expect(view.tasks?.find((one) => one.key === 'story')?.signedOffAt).toBeNull();
      expect(
        await manager().count(AuditEventEntity, { where: { action: 'task-signoff' } }),
      ).toBe(1);

      // A Reopen withdraws the pass the sign-off was, so it withdraws the
      // sign-off too; a later pass of the learner's own is not "signed off".
      await split.overridePhase(dana, learnerId, phaseStateId, 'task-signoff', reason, 'story');
      await split.overridePhase(dana, learnerId, phaseStateId, 'task-reopen', reason, 'story');
      const reopened = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
      expect([reopened.status, reopened.signedOffBy, reopened.signedOffAt]).toEqual(['in_progress', null, null]);
    });

    /**
     * A learner's retry keeps the task's earlier `passedAt` and puts it back
     * in progress (`learner-reset.ts`). A sign-off task the learner retried
     * is passed again only by a teacher's Sign off, and that new pass takes
     * its own date, as `taskRollup` gives any other task's new pass; a pass
     * date held from before no retry is kept as it was.
     */
    it('a sign-off after a learner retry writes the new pass date; a held date with no retry since is kept', async () => {
      const tasks = storyAndScope();
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      const phaseStateId = states.requirements.id;
      const earlier = '2026-09-02T10:00:00.000Z';

      await manager().update(
        TaskStateEntity,
        { phaseStateId, taskKey: 'story' },
        { status: 'in_progress', passedAt: earlier, resetAt: '2026-09-05T10:00:00.000Z', resetCount: 1 },
      );
      const before = new Date().toISOString();
      await split.overridePhase(dana, learnerId, phaseStateId, 'task-signoff', reason, 'story');
      const retried = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
      expect(retried.status).toBe('passed');
      expect(retried.passedAt! >= before).toBe(true);

      await manager().update(
        TaskStateEntity,
        { phaseStateId, taskKey: 'scope' },
        { status: 'submitted', passedAt: earlier, resetAt: null },
      );
      await split.overridePhase(dana, learnerId, phaseStateId, 'task-signoff', reason, 'scope');
      const held = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'scope')!;
      expect([held.status, held.passedAt]).toEqual(['passed', earlier]);
    });

    /**
     * Neither reset lever starts work over while a revision of it
     * is still being marked.
     *
     * The race it narrows is the non-quiz one. A written task's revision is
     * graded from a snapshot taken at submit, and its verdict is written under
     * the enrolment lock whenever the job finishes, so a reset that commits
     * first is followed by a verdict that re-passes the task at the old
     * revision's score, on files the reset was meant to have started over. The
     * check is keyed as `UQ_submissions_in_flight` is: `(phaseStateId,
     * taskKey)` for one task, the whole phase for the phase lever.
     */
    describe('a reset waits for a revision still being marked', () => {
      const marking = (phaseStateId: string, taskKey: string, status: 'queued' | 'running' = 'queued') =>
        manager().save(
          manager().create(SubmissionEntity, { phaseStateId, userId: learnerId, taskKey, status }),
        );

      const passedStory = async (phaseStateId: string): Promise<void> => {
        await manager().update(
          TaskStateEntity,
          { phaseStateId, taskKey: 'story' },
          { status: 'passed', passedAt: '2026-09-02T09:00:00.000Z', bestScore: 90, attempts: 2 },
        );
      };

      it.each(['queued', 'running'] as const)(
        'task-reset refuses while that task has a revision %s, changing nothing',
        async (status) => {
          const { states } = await enrolSplit(storyAndScope());
          const split = serviceOn(publish(storyAndScope()));
          const phaseStateId = states.requirements.id;
          await passedStory(phaseStateId);
          await marking(phaseStateId, 'story', status);

          const refused = split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story');
          await expect(refused).rejects.toBeInstanceOf(ConflictException);
          await expect(
            split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story'),
          ).rejects.toThrow(inFlightRefusal('The story'));

          const story = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
          expect([story.status, story.bestScore, story.passedAt, story.resetCount, story.resetAt]).toEqual([
            'passed',
            90,
            '2026-09-02T09:00:00.000Z',
            0,
            null,
          ]);
          expect(await manager().count(AuditEventEntity, { where: { action: 'task-reset' } })).toBe(0);
        },
      );

      it('task-reset goes through once that revision’s verdict is in', async () => {
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const phaseStateId = states.requirements.id;
        await passedStory(phaseStateId);
        const held = await marking(phaseStateId, 'story', 'running');
        await expect(
          split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story'),
        ).rejects.toBeInstanceOf(ConflictException);

        await manager().update(SubmissionEntity, held.id, { status: 'failed', error: 'marked elsewhere' });
        await split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story');

        const story = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
        expect([story.status, story.bestScore, story.resetCount]).toEqual(['in_progress', null, 1]);
      });

      it('a sibling task’s revision in flight does not hold a task-reset', async () => {
        // The key is the in-flight index's own: two tasks of one phase are two
        // pieces of work, and the scope note being marked says nothing about
        // the story's verdict.
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const phaseStateId = states.requirements.id;
        await passedStory(phaseStateId);
        await marking(phaseStateId, 'scope', 'running');

        await split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story');
        const story = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
        expect([story.status, story.resetCount]).toEqual(['in_progress', 1]);
      });

      it('reset-phase refuses while ANY task of the phase has a revision in flight', async () => {
        // The phase lever clears every row, so any verdict still to land
        // (the optional task's included) would land on a board it had cleared.
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const phaseStateId = states.requirements.id;
        await passedStory(phaseStateId);
        await manager().update(PhaseStateEntity, phaseStateId, {
          workspace: { 'requirements/story.json': '# The story' },
        });
        await marking(phaseStateId, 'scope', 'queued');

        await expect(
          split.overridePhase(dana, learnerId, phaseStateId, 'reset-phase', reason),
        ).rejects.toThrow(inFlightRefusal(requirements.title));

        expect((await state(phaseStateId)).workspace).toEqual({ 'requirements/story.json': '# The story' });
        const story = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
        expect([story.status, story.bestScore]).toEqual(['passed', 90]);
        expect(await manager().count(AuditEventEntity, { where: { action: 'reset-phase' } })).toBe(0);
      });

      /**
       * The race, hit every run rather than hoped for: a revision is queued
       * while the reset waits for the enrolment lock; the moment a submit can
       * commit on Postgres while `overridePhase` blocks on `pessimistic_write`.
       * It is inserted when the transaction's own lock read returns, so a
       * check made anywhere before that read (the ownership lookups outside
       * the transaction included) misses it, and only a check made inside the
       * lock sees it. The row rolls back with the refused transaction, which is
       * a property of the test and not of the product.
       *
       * A submit cannot commit after the check inside the lock either:
       * `FeedbackService.submit` takes the same enrolment lock.
       */
      const queuedAtTheLock = (phaseStateId: string, taskKey: string): { fired: () => boolean } => {
        const read = EntityManager.prototype.findOneOrFail;
        let fired = false;
        jest
          .spyOn(EntityManager.prototype, 'findOneOrFail')
          .mockImplementation(async function (this: EntityManager, entity: any, options: any) {
            const row = await read.call(this, entity, options);
            // The transaction's lock read, and only that one: the ownership
            // lookups before it run on the plain manager.
            if (!fired && entity === EnrollmentEntity && this !== manager()) {
              fired = true;
              await this.insert(SubmissionEntity, { phaseStateId, userId: learnerId, taskKey, status: 'queued' });
            }
            return row;
          });
        return { fired: () => fired };
      };

      it('sees a revision queued while it waited for the lock, because it asks inside the lock', async () => {
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const phaseStateId = states.requirements.id;
        await passedStory(phaseStateId);

        let hook = queuedAtTheLock(phaseStateId, 'story');
        await expect(
          split.overridePhase(dana, learnerId, phaseStateId, 'task-reset', reason, 'story'),
        ).rejects.toThrow(inFlightRefusal('The story'));
        expect(hook.fired()).toBe(true);
        jest.restoreAllMocks();

        hook = queuedAtTheLock(phaseStateId, 'scope');
        await expect(
          split.overridePhase(dana, learnerId, phaseStateId, 'reset-phase', reason),
        ).rejects.toThrow(inFlightRefusal(requirements.title));
        expect(hook.fired()).toBe(true);
        jest.restoreAllMocks();

        const story = (await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')!;
        expect([story.status, story.bestScore, story.resetCount]).toEqual(['passed', 90, 0]);
      });

      it('holds only the two reset levers: a reopen and a workspace reset still go through', async () => {
        // Only the two reset levers have a verdict-after-reset race. A
        // reopen withdraws a verdict and a workspace reset clears files the
        // revision already carries its own copy of; neither is held.
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const phaseStateId = states.requirements.id;
        await passedStory(phaseStateId);
        await manager().update(PhaseStateEntity, phaseStateId, {
          workspace: { 'requirements/story.json': '# The story' },
        });
        await marking(phaseStateId, 'story', 'running');

        await split.overridePhase(dana, learnerId, phaseStateId, 'task-reopen', reason, 'story');
        await split.overridePhase(dana, learnerId, phaseStateId, 'reset-workspace', reason);

        expect((await taskRows(phaseStateId)).find((row) => row.taskKey === 'story')?.status).toBe(
          'in_progress',
        );
        expect((await state(phaseStateId)).workspace).toBeNull();
      });

      /*
       * The pin above drives two of the five levers the docstring says are
       * not held. This drives all five, each with a revision of EVERY
       * task of the phase queued or running (so a refusal keyed on either
       * task, or on the phase, would show) and each on a board where the
       * lever itself is allowed.
       */
      it.each([
        ['pass', undefined],
        ['reopen', undefined],
        ['reset-workspace', undefined],
        ['task-signoff', 'interview'],
        ['task-reopen', 'story'],
      ] as const)('%s goes through while every task has a revision in flight', async (lever, taskKey) => {
        const tasks = [
          taskLike({ taskKey: 'story', order: 1, title: 'The story', gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
          taskLike({ taskKey: 'interview', order: 2, title: 'The interview', signOff: true, gradedUnits: [{ kind: 'rule', id: 'gwt-criteria' }] }),
        ];
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));
        const phaseStateId = states.requirements.id;
        if (lever === 'task-reopen') await passedStory(phaseStateId);
        if (lever === 'reopen') await manager().update(PhaseStateEntity, phaseStateId, { status: 'passed', passedAt: '2026-09-02T09:00:00.000Z' });
        await marking(phaseStateId, 'story', 'running');
        await marking(phaseStateId, 'interview', 'queued');

        await expect(split.overridePhase(dana, learnerId, phaseStateId, lever, reason, taskKey)).resolves.toBeDefined();
        expect(await manager().count(AuditEventEntity, { where: { action: lever } })).toBe(1);
      });
    });

    it('the dossier carries per-task detail', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const split = serviceOn(publish(storyAndScope()));
      await manager().update(
        TaskStateEntity,
        { phaseStateId: states.requirements.id, taskKey: 'story' },
        {
          status: 'passed',
          bestScore: 88,
          attempts: 2,
          passedAt: '2026-09-02T10:00:00.000Z',
          awaitingSignOff: false,
          signedOffAt: '2026-09-02T11:00:00.000Z',
        },
      );
      await revise(states.requirements, 'story', {
        score: 88,
        createdAt: new Date('2026-09-02T09:00:00.000Z'),
      });
      await revise(states.requirements, 'scope', {
        score: 41,
        passed: false,
        createdAt: new Date('2026-09-03T09:00:00.000Z'),
      });

      const detail = await split.learnerDetail(dana, learnerId);
      const enrolment = detail.enrollments.find((one) => one.projectSlug === TEACHER)!;
      const phase = enrolment.phases.find((one) => one.key === 'requirements')!;
      expect(phase.tasks?.map((task) => task.key)).toEqual(['story', 'scope']);
      expect(phase.tasks?.[0]).toMatchObject({
        key: 'story',
        order: 1,
        required: true,
        title: 'The story',
        status: 'passed',
        bestScore: 88,
        attempts: 2,
        passedAt: '2026-09-02T10:00:00.000Z',
        awaitingSignOff: false,
        signedOffAt: '2026-09-02T11:00:00.000Z',
      });
      expect(phase.tasks?.[0].lastSubmission?.score).toBe(88);
      expect(phase.tasks?.[1].lastSubmission?.score).toBe(41);
      // and the phase view's own `lastSubmission` still means the newest
      // revision on this phase, whichever task it was about.
      expect(phase.lastSubmission?.score).toBe(41);
    });

    /**
     * A lever that writes the board `passed` without a revision behind it
     * (Sign off, or the phase-wide Pass) must not leave the teacher reading
     * "Design now reads passed" while `advance` refuses the learner.
     * The gate is right: a countersignature is the second half of a pass, never
     * the first. So the lever's answer says what the gate will still want, and
     * the console's phase view carries the same list the learner's room does.
     */
    describe('what a lever says about the gate it did not open', () => {
      it('a sign-off with no reviewed revision behind it names the task the learner still submits', async () => {
        const tasks = storyAndScope();
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));

        const view = await split.overridePhase(dana, learnerId, states.requirements.id, 'task-signoff', reason, 'story');

        expect(view.status).toBe('passed');
        expect(view.evidenceNeeded).toEqual([{ key: 'story', title: 'The story' }]);
        expect(view.note).toBe(evidenceStillNeededNote(requirements.title, [{ title: 'The story' }]));
        // The console's own read says the same thing afterwards.
        const detail = await split.learnerDetail(dana, learnerId);
        const phase = detail.enrollments
          .find((one) => one.projectSlug === TEACHER)!
          .phases.find((one) => one.key === 'requirements')!;
        expect(phase.evidenceNeeded).toEqual([{ key: 'story', title: 'The story' }]);
      });

      it('the phase-wide Pass says it too', async () => {
        const tasks = storyAndScope();
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));

        const view = await split.overridePhase(dana, learnerId, states.requirements.id, 'pass', reason);

        expect(view.status).toBe('passed');
        expect(view.evidenceNeeded).toEqual([{ key: 'story', title: 'The story' }]);
        expect(view.note).toBe(evidenceStillNeededNote(requirements.title, [{ title: 'The story' }]));
      });

      it('says nothing once the task has a reviewed pass of its own', async () => {
        const tasks = storyAndScope();
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));
        await revise(states.requirements, 'story', { score: 88, report: strictReport(), ...retained });

        const view = await split.overridePhase(dana, learnerId, states.requirements.id, 'task-signoff', reason, 'story');

        expect(view.status).toBe('passed');
        expect('evidenceNeeded' in view).toBe(false);
        expect(view.note).toBeUndefined();
        const detail = await split.learnerDetail(dana, learnerId);
        const phase = detail.enrollments
          .find((one) => one.projectSlug === TEACHER)!
          .phases.find((one) => one.key === 'requirements')!;
        expect('evidenceNeeded' in phase).toBe(false);
      });

      /**
       * A teacher's Pass on a phase AHEAD of the learner (say Unlock early and
       * Pass on Testing) must not answer only "Testing now reads passed.",
       * because the lever's own question promises "the answer says whether one
       * is still owed", nor may the roster cell read plain Pass. The learner's
       * room says it (`notReachedYet` beside `evidenceNeeded`); the teacher is
       * told the same, by the same predicate (`evidenceNeededAhead`).
       */
      it('a Pass on a phase ahead of the learner says a review is still owed, and the roster reads it', async () => {
        const tasks = storyAndScope();
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));
        const design = teacher.phases.find((one) => one.key === 'design')!;

        await split.overridePhase(dana, learnerId, states.design.id, 'reopen', reason);
        const view = await split.overridePhase(dana, learnerId, states.design.id, 'pass', reason);

        expect(view.status).toBe('passed');
        expect(view.evidenceNeeded).toEqual([{ key: '', title: design.title }]);
        expect(view.note).toBe(evidenceStillNeededNote(design.title, [{ title: design.title }], { ahead: true }));
        expect(view.note).toBe(
          `${design.title} reads passed, but the learner has not reached it yet, and once they do they cannot ` +
            `move on until ${design.title} has a reviewed pass of its own. A sign-off or a Pass credits the work ` +
            'here; it does not stand in for the review, so they still submit it for one.',
        );
        // The console's own read carries it, so the roster cell says
        // "Waiting on a reviewed pass" beside the Pass.
        const detail = await split.learnerDetail(dana, learnerId);
        const phase = detail.enrollments
          .find((one) => one.projectSlug === TEACHER)!
          .phases.find((one) => one.key === 'design')!;
        expect(phase.status).toBe('passed');
        expect(phase.evidenceNeeded).toEqual([{ key: '', title: design.title }]);
        // The phase the learner stands on is unchanged by it.
        const current = detail.enrollments
          .find((one) => one.projectSlug === TEACHER)!
          .phases.find((one) => one.key === 'requirements')!;
        expect('evidenceNeeded' in current).toBe(false);
      });

      it('says nothing about a phase ahead whose own reviewed pass is already in', async () => {
        const tasks = storyAndScope();
        const { states } = await enrolSplit(tasks);
        const split = serviceOn(publish(tasks));
        await split.overridePhase(dana, learnerId, states.design.id, 'reopen', reason);
        // Submitted while it was unlocked early, and strictly reviewed.
        await revise(states.design, '', { report: strictReport('design'), ...retained });

        const view = await split.overridePhase(dana, learnerId, states.design.id, 'pass', reason);

        expect(view.status).toBe('passed');
        expect('evidenceNeeded' in view).toBe(false);
        expect(view.note).toBeUndefined();
        const detail = await split.learnerDetail(dana, learnerId);
        const phase = detail.enrollments
          .find((one) => one.projectSlug === TEACHER)!
          .phases.find((one) => one.key === 'design')!;
        expect('evidenceNeeded' in phase).toBe(false);
      });

      it('names every task in one sentence', () => {
        expect(evidenceStillNeededNote('Design', [{ title: 'The brief' }, { title: 'The decision' }])).toBe(
          'Design reads passed, but the learner cannot move on until The brief and The decision have a ' +
            'reviewed pass of their own. A sign-off or a Pass credits the work here; it does not stand in ' +
            'for the review, so they still submit each of them for one.',
        );
      });
    });

    it('the dossier does not print a phase as passed on one task’s evidence', async () => {
      const tasks = [
        taskLike({ taskKey: 'story', order: 1, gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        taskLike({ taskKey: 'scope', order: 2, gradedUnits: [{ kind: 'rule', id: 'scope-note' }] }),
      ];
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      await manager().update(PhaseStateEntity, states.requirements.id, {
        status: 'passed',
        passedAt: '2026-09-04T10:00:00.000Z',
        bestScore: 88,
      });
      // Task A strict-passed. Task B was passed by an instructor and has no
      // revision of its own at all.
      await revise(states.requirements, 'story', {
        score: 88,
        report: strictReport(),
        ...retained,
        createdAt: new Date('2026-09-04T09:00:00.000Z'),
      });

      const dossier = await split.learnerDossier(dana, learnerId, TEACHER);
      const phase = dossier.phases.find((one) => one.key === 'requirements')!;
      expect(phase.status).toBe('submitted');
      expect(phase.passedAt).toBeNull();
      expect(dossier.completedAt).toBeNull();
    });

    it('completedAt needs every required key of every phase', async () => {
      const tasks = [
        taskLike({ taskKey: 'story', order: 1, gradedUnits: [{ kind: 'rule', id: 'story-format' }] }),
        taskLike({ taskKey: 'scope', order: 2, gradedUnits: [{ kind: 'rule', id: 'scope-note' }] }),
      ];
      const { states } = await enrolSplit(tasks);
      const split = serviceOn(publish(tasks));
      const enrollment = await manager().findOneByOrFail(EnrollmentEntity, {
        id: states.requirements.enrollmentId,
      });
      await manager().update(
        PhaseStateEntity,
        { enrollmentId: enrollment.id },
        { status: 'passed', passedAt: '2026-09-04T10:00:00.000Z' },
      );
      await manager().update(EnrollmentEntity, enrollment.id, {
        completed: true,
        completedAt: '2026-09-04T12:00:00.000Z',
      });
      // Every other phase strict-passed; requirements has one required key of
      // two answered.
      for (const [key, held] of Object.entries(states)) {
        if (key === 'requirements') continue;
        await revise(held, '', {
          ...retained,
          report: strictReport(key),
          createdAt: new Date('2026-09-04T09:00:00.000Z'),
        });
      }
      await revise(states.requirements, 'story', {
        ...retained,
        report: strictReport(),
        createdAt: new Date('2026-09-04T09:00:00.000Z'),
      });

      expect((await split.learnerDossier(dana, learnerId, TEACHER)).completedAt).toBeNull();

      await revise(states.requirements, 'scope', {
        ...retained,
        report: strictReport(),
        createdAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      expect((await split.learnerDossier(dana, learnerId, TEACHER)).completedAt).toBe(
        '2026-09-04T12:00:00.000Z',
      );
    });

    it('the CSV’s late column follows the required task, not the newest revision', async () => {
      const { states } = await enrolSplit(storyAndScope());
      const held = publish(storyAndScope());
      const split = serviceOn(held);
      await new ScheduleService(dataSource, held).saveSchedule(dana, cohortId, {
        projectSlug: TEACHER,
        phases: [
          { phaseKey: 'requirements', opensAt: null, dueAt: '2026-09-02T23:59:00.000Z' },
        ],
      });
      // The required task was handed in before the bell; the optional one after.
      await revise(states.requirements, 'story', {
        packVersion: '1.0.0',
        createdAt: new Date('2026-09-01T10:00:00.000Z'),
      });
      await revise(states.requirements, 'scope', {
        packVersion: '2.0.0',
        regradeOf: 'a-previous-revision',
        createdAt: new Date('2026-09-05T10:00:00.000Z'),
      });

      const rows = (await split.exportCsv(dana, TEACHER))
        .trim()
        .split('\r\n')
        .map((line) => line.split(','));
      // "Lee, Learner" holds a comma, so the quoted name splits into two cells
      // here and the phase key sits one column further along.
      const requirementsRow = rows.slice(1).find((row) => row.includes('requirements'))!;
      expect(requirementsRow.slice(-4)).toEqual([
        '1.0.0',
        '2026-09-01T10:00:00.000Z',
        'no',
        'no',
      ]);
    });

    it('on a sole-task phase the four columns are the row they are today', async () => {
      // The shipped pack, through the same build: the sole task is required, so
      // the newest required revision IS the newest revision on the phase state.
      const split = serviceOn(publish(storyAndScope()));
      const mine = await split.exportCsv(dana, 'tasktrackr');
      expect(mine).toEqual(await service.exportCsv(dana, 'tasktrackr'));
      expect(await manager().count(TaskStateEntity)).toBe(0);
    });

    it('every override writes the patch it writes today', async () => {
      const states = await manager().find(PhaseStateEntity, {
        where: { userId: learnerId },
        order: { phaseOrder: 'ASC' },
      });
      const [requirementsState, design, impl] = states;
      const threshold = content.getPhase('tasktrackr', 'design').rubric.passThreshold;

      await service.overridePhase(dana, learnerId, design.id, 'pass', reason);
      const passed = await state(design.id);
      expect(passed.status).toBe('passed');
      expect(passed.bestScore).toBe(threshold);
      expect(passed.passedAt).toEqual(expect.any(String));

      await service.overridePhase(dana, learnerId, requirementsState.id, 'reopen', reason);
      const reopened = await state(requirementsState.id);
      expect([reopened.status, reopened.passedAt, reopened.bestScore, reopened.attempts]).toEqual([
        'in_progress',
        null,
        82,
        2,
      ]);

      await service.overridePhase(dana, learnerId, impl.id, 'reset-workspace', reason);
      expect((await state(impl.id)).status).toBe('locked');

      await service.overridePhase(dana, learnerId, design.id, 'reset-phase', reason);
      const reset = await state(design.id);
      expect([reset.status, reset.bestScore, reset.passedAt, reset.workspace]).toEqual([
        'in_progress',
        null,
        null,
        null,
      ]);
      // Not one task row was written on a board that has none.
      expect(await manager().count(TaskStateEntity)).toBe(0);
    });

    /**
     * The gradebook's two appended columns, read off the
     * pinned version's tasks rather than off the phase rows beside them.
     */
    describe('the gradebook’s two overview columns, on a board that holds a quiz', () => {
      const gradebookRow = async (split: InstructorService) =>
        (await split.exportGradebook(dana, TEACHER))
          .trimEnd()
          .split('\r\n')[1]
          .split(',');

      it('reports the quiz’s best score as mastery and counts only required tasks as the checklist', async () => {
        const { states } = await enrolSplit(storyAndQuiz());
        const split = serviceOn(publish(storyAndQuiz()));
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'story' },
          { status: 'passed', bestScore: 74, passedAt: '2026-09-18T10:00:00.000Z' },
        );
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'concepts' },
          { bestScore: 80, attempts: 2 },
        );

        const cells = await gradebookRow(split);
        // Six required tasks across the version (`story` here and the
        // synthesised sole task of the five phases behind it) one of them
        // passed. The **optional** quiz is not in that denominator, which is
        // the same quantifier the phase gate uses.
        expect(cells.at(-2)).toBe('17');
        // And the quiz's own number, which is a second reading of the same row
        // for a different question rather than a summand of anything.
        expect(cells.at(-1)).toBe('80');
      });

      it('blanks mastery for a quiz nobody has taken, rather than scoring it zero', async () => {
        const { states } = await enrolSplit(storyAndQuiz());
        const split = serviceOn(publish(storyAndQuiz()));
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'story' },
          { status: 'passed', bestScore: 74 },
        );

        const cells = await gradebookRow(split);
        expect(cells.at(-2)).toBe('17');
        // An unanswered quiz is a question the learner has not answered, not
        // one they answered badly.
        expect(cells.at(-1)).toBe('');
      });
    });

    /**
     * The reset lever, which is the only way out of a spent required quiz.
     *
     * A required quiz failed on every allowed attempt locks its phase and the
     * rest of the project. A reset that un-passed a passed quiz without
     * returning an attempt would make that worse rather than better, so a
     * reset starts a new **attempt epoch** (`resetCount`,
     * which this lever already increments, is the epoch) so the spent count
     * and the attempt numbering begin again while every paper the learner ever
     * sat stays exactly where it is.
     */
    describe('resetting a quiz task returns the learner’s attempts', () => {
      const papers = () => manager().getRepository(QuizAttemptEntity);

      /** `count` papers handed in on this task, as the learner's route writes them. */
      const sat = async (phaseStateId: string, count: number, epoch = 0): Promise<string[]> => {
        const ids: string[] = [];
        for (let at = 1; at <= count; at += 1) {
          const row = await papers().save(
            papers().create({
              phaseStateId,
              userId: learnerId,
              taskKey: 'concepts',
              epoch,
              projectVersionId: V_SPLIT,
              paper: [{ questionId: 'fixture-one', optionIds: ['a', 'b'] }],
              answers: { 'fixture-one': ['b'] },
              score: 0,
              passed: false,
              startedAt: `2026-09-18T10:0${at}:00.000Z`,
              submittedAt: `2026-09-18T10:0${at}:30.000Z`,
            }),
          );
          ids.push(row.id);
        }
        return ids;
      };

      it('starts a new epoch, keeps every paper, and voids the one left open', async () => {
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        const spent = await sat(states.requirements.id, 3);
        const openPaper = await papers().save(
          papers().create({
            phaseStateId: states.requirements.id,
            userId: learnerId,
            taskKey: 'concepts',
            epoch: 0,
            projectVersionId: V_SPLIT,
            paper: [{ questionId: 'fixture-two', optionIds: ['a', 'b'] }],
            startedAt: '2026-09-18T11:00:00.000Z',
          }),
        );

        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'concepts',
        );

        // The epoch moved, and it is the column the lever already wrote.
        const row = (await taskRows(states.requirements.id)).find((one) => one.taskKey === 'concepts')!;
        expect(row.resetCount).toBe(1);
        expect([row.status, row.bestScore, row.passedAt]).toEqual(['in_progress', null, null]);

        // Not one paper was deleted; history is the learner's record and an
        // appeal reads it.
        expect(await papers().count()).toBe(4);
        for (const id of spent) {
          const paper = await papers().findOneByOrFail({ id });
          expect(paper.voidedAt).toBeNull();
          expect(paper.epoch).toBe(0);
        }

        // And the paper that was open belongs to a run the teacher has closed:
        // closed so the learner can draw a new one, voided so it is never
        // scored, never counted and never linked to a revision.
        const stranded = await papers().findOneByOrFail({ id: openPaper.id });
        expect(stranded.voidedAt).toEqual(expect.any(String));
        expect(stranded.submittedAt).toBe(stranded.voidedAt);
        expect(stranded.answers).toBeNull();
        expect(stranded.score).toBeNull();
        expect(stranded.submissionId).toBeNull();
      });

      it('hands a passed quiz its attempts back as well as its verdict', async () => {
        // The foot-gun, the other way round. Resetting a PASSED required quiz
        // withdraws the pass; without returning an attempt, a learner who
        // passed on their last go would be left un-passed with nothing to press.
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        await sat(states.requirements.id, 3);
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'concepts' },
          { status: 'passed', bestScore: 100, passedAt: '2026-09-18T10:03:30.000Z' },
        );

        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'concepts',
        );

        const row = (await taskRows(states.requirements.id)).find((one) => one.taskKey === 'concepts')!;
        expect([row.status, row.bestScore, row.passedAt, row.resetCount]).toEqual([
          'in_progress',
          null,
          null,
          1,
        ]);
        // THE ATTEMPTS ARE BACK, which is the half the lever did not do
        // before: three papers in the record, and none of them spent against
        // the run the learner is now on.
        const writer = new QuizAttemptsService(papers());
        expect(await writer.handedIn(states.requirements.id, 'concepts', row.resetCount)).toBe(0);
        expect(await writer.handedIn(states.requirements.id, 'concepts', 0)).toBe(3);
        // The phase comes down with a required task, exactly as it does for
        // any other kind.
        expect((await state(states.requirements.id)).status).not.toBe('passed');
      });

      it('names the task and the voided paper in the audit row', async () => {
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        const openPaper = await papers().save(
          papers().create({
            phaseStateId: states.requirements.id,
            userId: learnerId,
            taskKey: 'concepts',
            epoch: 0,
            projectVersionId: V_SPLIT,
            paper: [],
            startedAt: '2026-09-18T11:00:00.000Z',
          }),
        );

        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'concepts',
        );

        const [event] = await manager().find(AuditEventEntity, {
          where: { action: 'task-reset' },
          order: { createdAt: 'DESC' },
        });
        expect(event.detail).toMatchObject({
          taskKey: 'concepts',
          attemptEpoch: 1,
          voidedQuizAttemptId: openPaper.id,
        });
      });

      it('writes no quiz row when the task reset is not a quiz', async () => {
        // The guard is `isQuizTask`, so a written task's reset costs no read
        // and its audit row gains no field that would read as a quiz fact.
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));

        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'story',
        );

        const [event] = await manager().find(AuditEventEntity, {
          where: { action: 'task-reset' },
          order: { createdAt: 'DESC' },
        });
        expect(event.detail).toMatchObject({ taskKey: 'story' });
        expect(event.detail).not.toHaveProperty('attemptEpoch');
        expect(event.detail).not.toHaveProperty('voidedQuizAttemptId');
      });

      it('clears the quiz’s mastery with its pass, and leaves the papers to read', async () => {
        // **What `masteryPercent` and `bestScore` read after a reset**, pinned
        // rather than discovered. A reset clears the task's pass and its best
        // score exactly as it does for a written task; the learner is being
        // asked to do it again, and a mastery number carried over from a run
        // that has been withdrawn would be a number about work that no longer
        // counts. The papers stay in `quiz_attempts` for the teacher's view
        // and for the export; they are history, not a score.
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        /** The `quiz mastery %` cell, which is the appended last column. */
        const mastery = async (): Promise<string> =>
          (await split.exportGradebook(dana, TEACHER)).trimEnd().split('\r\n')[1].split(',').at(-1) ??
          '';

        // What a learner who has never opened the quiz reads, kept so that the
        // cell after the reset can be held against it rather than described.
        const neverAttempted = await mastery();
        expect(neverAttempted).toBe('');

        await sat(states.requirements.id, 3);
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'concepts' },
          { status: 'passed', bestScore: 90, passedAt: '2026-09-18T10:03:30.000Z' },
        );
        expect(await mastery()).toBe('90');

        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'concepts',
        );

        // A blank, and never a zero: the learner has not answered badly, they
        // have been asked again.
        expect(await mastery()).toBe('');
        // And it is the SAME cell a learner who never opened the quiz gets.
        // That is the intended reading of this column and it is also the one
        // thing a spreadsheet cannot infer, so `exportGradebook`'s docstring
        // says it in words and this line holds it to them: three papers sat
        // and a reset is indistinguishable here from never having started.
        // The papers are where the difference lives, and a reset deletes none.
        expect(await mastery()).toBe(neverAttempted);
        expect(await papers().count()).toBe(3);
      });

      it('tells the teacher which quiz has run out of papers, and which has not', async () => {
        // The console's half: a teacher cannot reset what they cannot see is
        // stuck. `quizAttemptsSpent` is the same two facts the learner's room
        // reads; every allowed paper handed in this run, and not passed.
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        await sat(states.requirements.id, 3);

        const tasksOf = async (): Promise<Record<string, boolean | undefined>> => {
          const detail = await split.learnerDetail(dana, learnerId);
          const phase = detail.enrollments
            .flatMap((one) => one.phases)
            .find((one) => one.id === states.requirements.id)!;
          return Object.fromEntries(
            (phase.tasks ?? []).map((task) => [task.key, task.quizAttemptsSpent]),
          );
        };

        // A task that is not a quiz never carries the field at all.
        expect(await tasksOf()).toEqual({ story: undefined, concepts: true });

        // A reset returns the attempts, and the flag goes with them.
        await split.overridePhase(
          dana,
          learnerId,
          states.requirements.id,
          'task-reset',
          reason,
          'concepts',
        );
        expect(await tasksOf()).toEqual({ story: undefined, concepts: false });

        // And a quiz that is passed is not waiting for anybody, however many
        // papers it took.
        await sat(states.requirements.id, 3, 1);
        expect((await tasksOf()).concepts).toBe(true);
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'concepts' },
          { status: 'passed', bestScore: 100 },
        );
        expect((await tasksOf()).concepts).toBe(false);
      });

      /*
       * A Sign off on a REQUIRED quiz the learner has run
       * out of papers on. The row reads passed, the phase rolls up passed, and
       * the gate still wants a passing paper the room cannot hand out, so the
       * lever's note, the gate's list and the console's out-of-papers flag all
       * have to say Reset, not "they still submit it".
       */
      it('says a Reset is the way out when a signed-off quiz has no paper left', async () => {
        const { states } = await enrolSplit(storyAndRequiredQuiz());
        const split = serviceOn(publish(storyAndRequiredQuiz()));
        await revise(states.requirements, 'story', { score: 88, report: strictReport(), ...retained });
        await manager().update(
          TaskStateEntity,
          { phaseStateId: states.requirements.id, taskKey: 'story' },
          { status: 'passed', bestScore: 88, passedAt: '2026-09-18T09:00:00.000Z' },
        );
        // Three papers, each marked and none a pass: the room refuses a fourth.
        for (const id of await sat(states.requirements.id, 3)) {
          const marked = await revise(states.requirements, 'concepts', { status: 'completed', passed: false, score: 0 });
          await papers().update({ id }, { submissionId: marked.id });
        }

        const view = await split.overridePhase(dana, learnerId, states.requirements.id, 'task-signoff', reason, 'concepts');

        expect(view.status).toBe('passed');
        const gap = { key: 'concepts', title: 'Check your understanding', noPapersLeft: true as const };
        expect(view.evidenceNeeded).toEqual([gap]);
        expect(view.note).toBe(evidenceStillNeededNote(requirements.title, [gap]));
        expect(view.note).toContain('no papers left');
        expect(view.note).not.toContain('still submit');
        expect(view.tasks?.find((task) => task.key === 'concepts')?.quizAttemptsSpent).toBe(true);
        // The console's own read says the same afterwards.
        const detail = await split.learnerDetail(dana, learnerId);
        const phase = detail.enrollments.flatMap((one) => one.phases).find((one) => one.id === states.requirements.id)!;
        expect(phase.evidenceNeeded).toEqual([gap]);
        expect(phase.tasks?.find((task) => task.key === 'concepts')?.quizAttemptsSpent).toBe(true);

        // Reset hands the papers back: the flag and the gap's reset clause go.
        const reset = await split.overridePhase(dana, learnerId, states.requirements.id, 'task-reset', reason, 'concepts');
        expect(reset.status).toBe('in_progress');
        expect('evidenceNeeded' in reset).toBe(false);
        expect(reset.tasks?.find((task) => task.key === 'concepts')?.quizAttemptsSpent).toBe(false);
      });

      it('names a spent quiz and a submittable task apart, in one note', () => {
        expect(
          evidenceStillNeededNote('Requirements', [
            { title: 'The story' },
            { title: 'Booking concepts check', noPapersLeft: true },
          ]),
        ).toBe(
          'Requirements reads passed, but the learner cannot move on until The story and Booking concepts ' +
            'check have a reviewed pass of their own. A sign-off or a Pass credits the work here; it does not ' +
            'stand in for the review, so they still submit The story for one. Booking concepts check has no ' +
            'papers left, so the learner cannot sit it again until you use Reset on it, which starts a fresh set ' +
            'of attempts and takes the credit back until they pass.',
        );
      });
    });

    /**
     * Every reset that moves a
     * non-quiz, non-sole task row from k to k+1 first stamps that task's
     * NULL-epoch revisions with k, in the same transaction and under the
     * enrolment lock, so afterwards NULL means "the current run" exactly. A
     * quiz keeps its paper rule (its `resetCount` is the attempt epoch), and a
     * sole-task (TaskTrackr) phase has no row and is never stamped.
     */
    describe('a reset closes the run it ends', () => {
      const epochs = async (phaseStateId: string, taskKey: string) =>
        (
          await manager().find(SubmissionEntity, {
            where: { phaseStateId, taskKey },
            order: { id: 'ASC' },
          })
        ).map((row) => row.resetEpoch);

      it('reset-phase bumps only the non-quiz rows and stamps only their NULL revisions', async () => {
        const { states } = await enrolSplit(storyAndQuiz());
        const split = serviceOn(publish(storyAndQuiz()));
        const id = states.requirements.id;
        await manager().update(TaskStateEntity, { phaseStateId: id, taskKey: 'story' }, { resetCount: 2 });
        await manager().update(TaskStateEntity, { phaseStateId: id, taskKey: 'concepts' }, { resetCount: 1 });
        await revise(states.requirements, 'story', { id: 'sub-1', resetEpoch: null });
        await revise(states.requirements, 'story', { id: 'sub-2', resetEpoch: 1 });
        await revise(states.requirements, 'concepts', { id: 'sub-3', resetEpoch: null });

        await split.overridePhase(dana, learnerId, id, 'reset-phase', reason);

        const rows = await taskRows(id);
        expect(rows.map((row) => [row.taskKey, row.resetCount])).toEqual([
          ['concepts', 1],
          ['story', 3],
        ]);
        expect(await epochs(id, 'story')).toEqual([2, 1]);
        expect(await epochs(id, 'concepts')).toEqual([null]);
      });

      it('task-reset stamps the NULL revisions of that task with the run it ends, and no sibling', async () => {
        const { states } = await enrolSplit(storyAndScope());
        const split = serviceOn(publish(storyAndScope()));
        const id = states.requirements.id;
        await revise(states.requirements, 'story', { id: 'sub-1', resetEpoch: null });
        await revise(states.requirements, 'scope', { id: 'sub-2', resetEpoch: null });

        await split.overridePhase(dana, learnerId, id, 'task-reset', reason, 'story');

        expect(await epochs(id, 'story')).toEqual([0]);
        expect(await epochs(id, 'scope')).toEqual([null]);
        expect((await taskRows(id)).find((row) => row.taskKey === 'story')!.resetCount).toBe(1);
      });

      it('task-reset on a quiz leaves its revisions to the paper rule', async () => {
        const { states } = await enrolSplit(storyAndQuiz());
        const split = serviceOn(publish(storyAndQuiz()));
        const id = states.requirements.id;
        await revise(states.requirements, 'concepts', { id: 'sub-1', resetEpoch: null });

        await split.overridePhase(dana, learnerId, id, 'task-reset', reason, 'concepts');

        expect(await epochs(id, 'concepts')).toEqual([null]);
      });

      it('a sole-task (TaskTrackr) phase reset stamps nothing', async () => {
        const [first] = await manager().find(PhaseStateEntity, {
          where: { userId: learnerId },
          order: { phaseOrder: 'ASC' },
        });
        await revise(first, '', { id: 'sub-sole', resetEpoch: null, passed: false });

        await service.overridePhase(dana, learnerId, first.id, 'reset-phase', reason);

        const after = await epochs(first.id, '');
        expect(after.length).toBeGreaterThan(0);
        expect(after.every((epoch) => epoch === null)).toBe(true);
      });
    });
  });


  /**
   * The class page's "Download this class's grade book". The optional
   * `cohort` narrows both class exports to one class of the caller's; without
   * it the files cover every class in scope; a class outside the caller's scope is the module's 404.
   */
  describe('the optional cohort on both exports', () => {
    let wednesdayId = '';
    beforeEach(async () => {
      const danaRow = await manager().findOneByOrFail(UserEntity, { email: 'dana@learnsdlc.test' });
      const wednesday = await manager().save(
        manager().create(CohortEntity, { name: 'Wednesday class', joinCode: 'WXYZWXYZ', ownerUserId: danaRow.id }),
      );
      wednesdayId = wednesday.id;
      const wes = await saveUser({ email: 'wes@learnsdlc.test', displayName: 'Wes Wednesday', cohort: wednesday.id });
      await enrol(wes.id, 'tasktrackr');
    });

    const emails = (csv: string) =>
      csv
        .trimEnd()
        .split('\r\n')
        .slice(1)
        .map((line) => line.split(',')[0]);

    it('the grade book without a class covers every class of the caller', async () => {
      expect(new Set(emails(await service.exportGradebook(dana)))).toEqual(
        new Set(['lee@learnsdlc.test', 'wes@learnsdlc.test']),
      );
    });

    it('the grade book of one class holds that class only', async () => {
      expect(emails(await service.exportGradebook(dana, undefined, cohortId))).toEqual(['lee@learnsdlc.test']);
      expect(emails(await service.exportGradebook(dana, undefined, wednesdayId))).toEqual(['wes@learnsdlc.test']);
      // the header stays the contract a spreadsheet import reads
      expect((await service.exportGradebook(dana, undefined, wednesdayId)).split('\r\n')[0]).toBe(
        GRADEBOOK_COLUMNS.join(','),
      );
    });

    it("another teacher's class is a 404 on both exports, never a file", async () => {
      const thursday = await manager().findOneByOrFail(CohortEntity, { name: 'Thursday class' });
      await expect(service.exportGradebook(dana, undefined, thursday.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.exportCsv(dana, undefined, thursday.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.exportGradebook(dana, undefined, 'not-a-class')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.exportGradebook(dana, undefined, 'default')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the long export of one class holds that class only, and every class without one', async () => {
      expect(new Set(emails(await service.exportCsv(dana, undefined, wednesdayId)))).toEqual(
        new Set(['wes@learnsdlc.test']),
      );
      expect(new Set(emails(await service.exportCsv(dana, undefined, cohortId)))).toEqual(
        new Set(['lee@learnsdlc.test']),
      );
      expect(new Set(emails(await service.exportCsv(dana)))).toEqual(
        new Set(['lee@learnsdlc.test', 'wes@learnsdlc.test']),
      );
    });

    it('an admin may name any class that exists, and nothing else', async () => {
      const thursday = await manager().findOneByOrFail(CohortEntity, { name: 'Thursday class' });
      expect(emails(await service.exportGradebook(admin, undefined, thursday.id))).toEqual(['ola@learnsdlc.test']);
      await expect(service.exportGradebook(admin, undefined, missingId)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('names the class in a file name in characters a file name can carry', async () => {
      expect(await service.classFileLabel(cohortId)).toBe('tuesday-class');
      await manager().update(CohortEntity, { id: wednesdayId }, { name: '¡¡¡' });
      expect(await service.classFileLabel(wednesdayId)).toBe(wednesdayId.slice(0, 8).toLowerCase());
    });

    it('the routes put the class in the file name and leave it out without one', async () => {
      const controller = new InstructorDetailController(service, {} as never, {} as never, {} as never, {} as never, {} as never);
      const headers: Record<string, string> = {};
      const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as never;
      await controller.gradebook(dana as never, { cohort: cohortId }, res);
      expect(headers['content-disposition']).toBe('attachment; filename="learnsdlc-gradebook-class-tuesday-class.csv"');
      await controller.gradebook(dana as never, {}, res);
      expect(headers['content-disposition']).toBe('attachment; filename="learnsdlc-gradebook.csv"');
      await controller.export(dana as never, { cohort: cohortId }, res);
      expect(headers['content-disposition']).toBe('attachment; filename="learnsdlc-grades-class-tuesday-class.csv"');
    });
  });

});

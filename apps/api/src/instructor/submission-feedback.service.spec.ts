import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthUser } from '../auth/auth.decorators';
import {
  ALL_ENTITIES,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
// The history's project, when the request names none, is resolved by the
// workflow's resolution order rather than by a literal.
import { WorkflowService } from '../workflow/workflow.service';
import { CohortsService } from './cohorts.service';
import { SubmissionTeacherFeedbackEntity } from './submission-feedback.entity';
import { SubmissionTeacherFeedbackService } from './submission-feedback.service';
import { ContentService } from '../content/content.service';
import type { CompiledTask } from '../content/pack-compiler';
import { memoryDataSource } from '../../test/support/memory-db';

describe('immutable teacher feedback and optional membership', () => {
  let source: DataSource;
  let feedback: SubmissionTeacherFeedbackService;
  let cohorts: CohortsService;
  let teacher: AuthUser;
  let otherTeacher: AuthUser;
  let learner: AuthUser;
  let stranger: AuthUser;
  let submission: SubmissionEntity;
  let phase: PhaseStateEntity;
  let enrollment: EnrollmentEntity;
  /**
   * What the pinned version declares.
   *
   * Both default to the phase-level shape (one criterion on the phase, and
   * no task list this build can name) so most assertions here ask the
   * phase-level question.
   */
  let phaseCriteria: string[] = ['story'];
  let pinnedTasks: CompiledTask[] = [];
  beforeAll(async () => {
    source = await memoryDataSource();
    const project = () => ({
      phases: [
        {
          key: 'requirements',
          rubric: { criteria: phaseCriteria.map((key) => ({ key })) },
          checks: { kind: 'story' },
        },
      ],
    });
    const content = {
      getProject: project,
      // The panel re-derives the gate
      // against the task the revision names, so the stub has to be able to
      // name one. Empty by default; a build that cannot name a phase's tasks
      // falls back to the phase's own rubric.
      getTasksForEnrollment: () => pinnedTasks,
      // The panel re-derives the gate against the version the
      // enrolment holds. The rows here carry no pin, so this is the same
      // project; which version a pinned enrolment gets is `portability.spec.ts`'s.
      getForEnrollment: project,
      // The later steps of the resolution ask the registry which projects
      // this deployment holds. These rows are settled by the first step
      // (every learner here has one enrolment) so the catalogue is honestly
      // empty.
      listProjects: () => [],
      headVersionIdFor: () => null,
    } as unknown as ContentService;
    feedback = new SubmissionTeacherFeedbackService(
      source,
      content,
      new WorkflowService(
        source.getRepository(EnrollmentEntity),
        source.getRepository(PhaseStateEntity),
        source.getRepository(ReleaseRecordEntity),
        content,
        {} as never,
        source,
      ),
    );
    cohorts = new CohortsService(source);
  });
  afterAll(async () => {
    await source.destroy();
  });
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await source.manager.clear(entity);
    phaseCriteria = ['story'];
    pinnedTasks = [];
    async function user(
      name: string,
      role: AuthUser['role'],
    ): Promise<AuthUser> {
      const saved = await source.manager.save(
        source.manager.create(UserEntity, {
          email: `${name}@feedback.test`,
          displayName: name,
          role,
          passwordHash: 'unused',
        }),
      );
      return {
        id: saved.id,
        email: saved.email,
        role: saved.role,
        cohort: saved.cohort,
      };
    }
    teacher = await user('Teacher', 'INSTRUCTOR');
    otherTeacher = await user('OtherTeacher', 'INSTRUCTOR');
    learner = await user('Learner', 'LEARNER');
    stranger = await user('Stranger', 'LEARNER');
    const classroom = await cohorts.create(teacher.id, 'Feedback class');
    await cohorts.join(learner.id, classroom.joinCode);
    learner.cohort = classroom.id;
    enrollment = await source.manager.save(
      source.manager.create(EnrollmentEntity, {
        userId: learner.id,
        projectSlug: 'tasktrackr',
      }),
    );
    phase = await source.manager.save(
      source.manager.create(PhaseStateEntity, {
        userId: learner.id,
        enrollmentId: enrollment.id,
        phaseKey: 'requirements',
        phaseOrder: 1,
        status: 'passed',
        attempts: 1,
        workspace: { 'story.md': 'Current draft' },
      }),
    );
    submission = await source.manager.save(
      source.manager.create(SubmissionEntity, {
        userId: learner.id,
        phaseStateId: phase.id,
        status: 'completed',
        passed: true,
        score: 100,
        workspaceSnapshot: { 'story.md': 'Submitted story' },
        contextSnapshot: { links: [], drill: null, ranBeforeSubmit: false },
        report: {
          assessmentMode: 'strict_binary',
          passed: true,
          checks: [
            {
              id: 'story',
              label: 'Story',
              status: 'passed',
              detail: 'Unit test evidence.',
            },
          ],
          aiReview: {
            provider: 'unit-test-fixture',
            verdict: 'pass',
            criteriaEvidence: [
              {
                key: 'story',
                met: true,
                evidence: 'Unit test evidence.',
                issue: '',
                nextStep: '',
              },
            ],
          },
        } as SubmissionEntity['report'],
      }),
    );
  });
  const comment = (
    text = 'Explain the boundary with one concrete example.',
  ) => ({ requestId: randomUUID(), action: 'comment' as const, text });

  it('stores comments on exact submissions without changing the verdict, snapshot, or phase', async () => {
    const before = await source.manager.findOneByOrFail(SubmissionEntity, {
      id: submission.id,
    });
    const note = await feedback.add(teacher, submission.id, {
      ...comment(),
      action: 'request_revision',
    });
    expect(note.submissionId).toBe(submission.id);
    expect(
      await source.manager.findOneByOrFail(SubmissionEntity, {
        id: submission.id,
      }),
    ).toEqual(before);
    expect(
      (await source.manager.findOneByOrFail(PhaseStateEntity, { id: phase.id }))
        .status,
    ).toBe('passed');
    expect(
      (await feedback.list(learner, submission.id)).map((row) => row.id),
    ).toEqual([note.id]);
  });
  it('returns the same saved feedback when a request is retried concurrently', async () => {
    const body = comment();
    const rows = await Promise.all(
      Array.from({ length: 5 }, () =>
        feedback.add(teacher, submission.id, body),
      ),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    expect(await source.manager.count(SubmissionTeacherFeedbackEntity)).toBe(1);
  });
  it('rejects changing an already used feedback request', async () => {
    const body = comment();
    await feedback.add(teacher, submission.id, body);
    await expect(
      feedback.add(teacher, submission.id, {
        ...body,
        text: 'Changed content',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('refuses a teacher outside the class and another learner', async () => {
    await expect(
      feedback.list(otherTeacher, submission.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      feedback.evidence(otherTeacher, submission.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(feedback.list(stranger, submission.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      feedback.add(learner, submission.id, comment()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('returns only submitted evidence, never the current draft or private chats', async () => {
    const result = await feedback.evidence(teacher, submission.id);
    expect(result.workspaceSnapshot).toEqual({ 'story.md': 'Submitted story' });
    expect(result).not.toHaveProperty('chat');
    expect(result).not.toHaveProperty('workspace');
  });
  it('refuses whitespace feedback and malformed submission ids', async () => {
    await expect(
      feedback.add(teacher, submission.id, comment('   ')),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(feedback.list(teacher, 'invalid')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('leaving a class preserves enrollment, saved work, reviews and feedback while revoking teacher access', async () => {
    const note = await feedback.add(teacher, submission.id, comment());
    const before = await source.manager.findOneByOrFail(PhaseStateEntity, {
      id: phase.id,
    });
    await cohorts.leave(learner.id);
    expect(await cohorts.classroom(learner.id)).toBeNull();
    expect(
      await source.manager.findOneByOrFail(PhaseStateEntity, { id: phase.id }),
    ).toEqual(before);
    expect(await source.manager.count(EnrollmentEntity)).toBe(1);
    expect(await source.manager.count(SubmissionEntity)).toBe(1);
    expect((await feedback.list(learner, submission.id))[0].id).toBe(note.id);
    await expect(
      feedback.evidence(teacher, submission.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      feedback.add(teacher, submission.id, comment()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('moving to a new class preserves old feedback for its learner but hides it from the new teacher', async () => {
    await feedback.add(teacher, submission.id, comment());
    const next = await cohorts.create(otherTeacher.id, 'Another class');
    await cohorts.join(learner.id, next.joinCode);
    expect(await feedback.list(otherTeacher, submission.id)).toEqual([]);
    expect(await feedback.list(learner, submission.id)).toHaveLength(1);
    await feedback.add(
      otherTeacher,
      submission.id,
      comment('A follow-up from the new class.'),
    );
    expect(await feedback.list(learner, submission.id)).toHaveLength(2);
    await expect(feedback.list(teacher, submission.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
  it('duplicate leave requests are idempotent and preserve concurrent profile edits', async () => {
    await source.manager.update(UserEntity, learner.id, {
      bio: 'Keep this profile text.',
    });
    await Promise.all([
      cohorts.leave(learner.id),
      cohorts.leave(learner.id),
      cohorts.leave(learner.id),
    ]);
    const after = await source.manager.findOneByOrFail(UserEntity, {
      id: learner.id,
    });
    expect(after.cohort).toBe('default');
    expect(after.bio).toBe('Keep this profile text.');
    expect(await source.manager.count(SubmissionEntity)).toBe(1);
  });

  it('preserves legacy pass verdicts without certifying them as strict evidence', async () => {
    await source.manager.update(SubmissionEntity, submission.id, {
      report: { passed: true } as SubmissionEntity['report'],
    });
    const legacy = (await feedback.history(learner, {})).items[0];
    expect(legacy.passed).toBe(true);
    expect(legacy.verifiedPass).toBe(false);
  });

  /**
   * The panel's `verifiedPass` is
   * re-derived against **the task the revision names**, not against the phase.
   *
   * A teacher-created task's rubric is derived from its own rules, so a phase
   * with two tasks has a rubric neither of them has. Counting one task's
   * evidence against the phase's rubric never closes (the arithmetic cannot)
   * and a teacher would be told that a revision which strict-passed did not.
   */
  it('verifies a revision against the task it names, not against the phase', async () => {
    phaseCriteria = ['story', 'scope'];
    pinnedTasks = [
      { taskKey: 'story', rubric: { criteria: [{ key: 'story' }] }, checkKind: 'markdown' },
      { taskKey: 'scope', rubric: { criteria: [{ key: 'scope' }] }, checkKind: 'markdown' },
    ] as unknown as CompiledTask[];
    await source.manager.update(SubmissionEntity, submission.id, { taskKey: 'story' });

    const mine = (await feedback.history(learner, {})).items[0];
    expect(mine.verifiedPass).toBe(true);
    expect((await feedback.evidence(teacher, submission.id)).verifiedPass).toBe(true);

    // A revision naming the sibling is counted against the sibling, and its
    // evidence is for the wrong criterion.
    await source.manager.update(SubmissionEntity, submission.id, { taskKey: 'scope' });
    expect((await feedback.history(learner, {})).items[0].verifiedPass).toBe(false);
  });

  it('does not verify a pass without the originally submitted supporting context', async () => {
    await source.manager.update(SubmissionEntity, submission.id, {
      contextSnapshot: null,
    });
    const history = await feedback.history(learner, {});
    expect(history.items[0]).toMatchObject({
      passed: true,
      verifiedPass: false,
    });
  });

  it.each(['missing report', 'malformed provider evidence', 'failed job', 'needs revision', 'pass', 'pending'])(
    'reports review availability for %s without changing stored evidence or phase state',
    async kind => {
      const report = structuredClone(submission.report!);
      const unavailable = ['missing report', 'malformed provider evidence', 'failed job'].includes(kind);
      if (kind !== 'pass') {
        report.passed = false;
        report.aiReview.verdict = 'needs_revision';
        report.aiReview.criteriaEvidence = [{ key: 'story', met: false, evidence: 'The submitted story leaves the boundary unspecified.', issue: 'The overdue boundary is missing.', nextStep: 'Clarify which dates are included.' }];
      }
      if (kind === 'malformed provider evidence') report.aiReview.assessmentError = 'invalid_assessment';
      await source.manager.update(SubmissionEntity, submission.id, {
        status: kind === 'failed job' ? 'failed' : kind === 'pending' ? 'queued' : 'completed',
        passed: kind === 'pass',
        report: ['missing report', 'pending', 'failed job'].includes(kind) ? null : report,
      });
      const before = await source.manager.findOneByOrFail(SubmissionEntity, { id: submission.id });
      const phaseBefore = await source.manager.findOneByOrFail(PhaseStateEntity, { id: phase.id });
      for (const result of [await feedback.history(learner, {}), await feedback.history(teacher, {}, learner.id)]) {
        expect(result.items[0]).toMatchObject({ id: submission.id, reviewUnavailable: unavailable, verifiedPass: kind === 'pass' });
        expect(result.items[0]).not.toHaveProperty('report');
        expect(result.items[0]).not.toHaveProperty('workspaceSnapshot');
      }
      expect(await source.manager.findOneByOrFail(SubmissionEntity, { id: submission.id })).toEqual(before);
      expect(await source.manager.findOneByOrFail(PhaseStateEntity, { id: phase.id })).toEqual(phaseBefore);
    },
  );

  it('pages beyond fifty reviews without omissions, duplicate boundaries, or private payloads', async () => {
    const instant = new Date('2026-09-10T00:00:00.000Z');
    await source.manager.update(SubmissionEntity, submission.id, {
      createdAt: instant,
    });
    for (let index = 0; index < 125; index++) {
      await source.manager.save(
        source.manager.create(SubmissionEntity, {
          userId: learner.id,
          phaseStateId: phase.id,
          status: 'completed',
          passed: false,
          createdAt: instant,
          workspaceSnapshot: { 'story.md': `Snapshot ${index}` },
          report: { passed: false } as SubmissionEntity['report'],
        }),
      );
    }
    const first = await feedback.history(learner, {});
    expect(first.items).toHaveLength(100);
    expect(first.total).toBe(126);
    expect(first.nextCursor).toBeTruthy();
    const second = await feedback.history(learner, {
      after: first.nextCursor!,
    });
    expect(second.items).toHaveLength(26);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((row) => row.id)).size,
    ).toBe(126);
    expect(first.items[0]).not.toHaveProperty('report');
    expect(first.items[0]).not.toHaveProperty('workspaceSnapshot');
    expect(
      [...first.items, ...second.items].filter((row) => row.verifiedPass),
    ).toHaveLength(1);
    const teacherPage = await feedback.history(
      teacher,
      { phaseId: phase.id },
      learner.id,
    );
    expect(teacherPage.total).toBe(126);
    await expect(
      feedback.history(otherTeacher, {}, learner.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      feedback.history(learner, { after: randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

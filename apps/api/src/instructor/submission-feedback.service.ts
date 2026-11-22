import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, MoreThan } from 'typeorm';
import type { AuthUser } from '../auth/auth.decorators';
import {
  AuditEventEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { scopedLearner } from './cohort-scope';
import { SubmissionTeacherFeedbackEntity } from './submission-feedback.entity';
import {
  SubmissionHistoryQuery,
  SubmissionTeacherFeedbackDto,
} from './submission-feedback.dto';
import { recordAudit } from '../audit/audit';
import { atomic, rowLock } from '../db/atomic';
import { ContentService, EnrollmentPin } from '../content/content.service';
import { strictEvidencePassed } from '../feedback/feedback.service';
import { taskForRevision } from '../feedback/task-resolution';
import { strictTaskEvidencePassed } from '../feedback/strict-evidence';
// Which project a request is about when it names none is one question with
// one answer, and `WorkflowService` gives it.
import { WorkflowService } from '../workflow/workflow.service';
// The one reading of "is this revision signed off",
// shared with the bell so the two never disagree.
import { taskSignOffOf } from '../notifications/notifications.service';

/** What `GET /submissions/:id/sign-off` answers. No name, email or id. */
export interface SubmissionSignOffView {
  signedOff: boolean;
  reason: string | null;
  signedOffAt: string | null;
}

@Injectable()
export class SubmissionTeacherFeedbackService {
  constructor(
    private readonly source: DataSource,
    private readonly content: ContentService,
    private readonly workflow: WorkflowService,
  ) {}

  private async access(manager: EntityManager, caller: AuthUser, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new NotFoundException('submission not found');
    const submission = await manager.findOneBy(SubmissionEntity, { id });
    if (!submission) throw new NotFoundException('submission not found');
    if (caller.role === 'LEARNER') {
      if (submission.userId !== caller.id)
        throw new NotFoundException('submission not found');
      return {
        submission,
        learner: await manager.findOneByOrFail(UserEntity, { id: caller.id }),
      };
    }
    return {
      submission,
      learner: await scopedLearner(manager, caller, submission.userId),
    };
  }

  async list(caller: AuthUser, submissionId: string) {
    const { learner } = await this.access(
      this.source.manager,
      caller,
      submissionId,
    );
    return this.source.manager.find(SubmissionTeacherFeedbackEntity, {
      where: {
        submissionId,
        ...(caller.role === 'LEARNER' ? {} : { cohortId: learner.cohort }),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Whether the teacher signed this revision off, and the reason they gave. A
   * sign-off is not a note, so `list` does not carry it, and without this the
   * learner would read "No teacher feedback" beside a signed-off task.
   *
   * Signed off only when both hold: the revision's task row carries
   * `signedOffAt`, and this revision is that task's newest completed passing
   * revision at or before it (`taskSignOffOf`). The reason is on the newest
   * `task-signoff` audit row for this learner, phase state and task; the bulk
   * sign-off (`class.bulk-signoff`) and the per-learner lever (`task.signoff`)
   * both write `targetId` = the phase state and `detail.taskKey`. The task row
   * has no reason column, so the audit row is where the reason is read from.
   *
   * Access is `list`'s: the owner, or staff who may read the learner. It writes
   * nothing and returns no name, email or id.
   */
  async signOff(caller: AuthUser, submissionId: string): Promise<SubmissionSignOffView> {
    const manager = this.source.manager;
    const { submission } = await this.access(manager, caller, submissionId);
    const none: SubmissionSignOffView = { signedOff: false, reason: null, signedOffAt: null };
    if (submission.status !== 'completed' || submission.passed !== true) return none;
    const scope = { phaseStateId: submission.phaseStateId, userId: submission.userId };
    const rows = await manager.find(TaskStateEntity, { where: scope });
    const completed = await manager.find(SubmissionEntity, {
      where: { ...scope, status: 'completed', passed: true },
      select: ['id', 'taskKey', 'passed', 'createdAt'],
    });
    const read = taskSignOffOf(submission, rows, completed);
    if (!read.signedOff || !read.taskKey) return none;
    const audits = await manager.find(AuditEventEntity, {
      where: {
        subjectUserId: submission.userId,
        targetId: submission.phaseStateId,
        action: 'task-signoff',
      },
      select: ['id', 'reason', 'detail', 'createdAt'],
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const newest = audits.find((row) => row.detail?.taskKey === read.taskKey);
    const reason = typeof newest?.reason === 'string' ? newest.reason.trim() : '';
    return { signedOff: true, reason: reason || null, signedOffAt: read.signedOffAt };
  }

  /** Chronological cursor pages contain no snapshots, private chats or provider inputs. */
  async history(
    caller: AuthUser,
    query: SubmissionHistoryQuery,
    requestedUserId?: string,
  ) {
    const manager = this.source.manager;
    const userId = requestedUserId ?? caller.id;
    if (requestedUserId) await scopedLearner(manager, caller, requestedUserId);
    // Which project a review history is about, when the request names none, is
    // a question about the **subject** and not about the reader; the teacher's
    // page sends no `?project` for exactly that reason, and says so
    // (`api-experience.ts`'s `teacherSubmissions`). A literal 'tasktrackr'
    // would answer an empty page rather than a 404 for a learner on any other
    // project, so nothing would report it. The resolution order answers it:
    // their own enrolment, their class's assignment, the slug an
    // operator named, the project the importer flagged.
    const projectSlug =
      query.project ?? (await this.workflow.projectVersionForLearner({ id: userId }))?.projectSlug;
    const enrollment = projectSlug
      ? await manager.findOneBy(EnrollmentEntity, { userId, projectSlug })
      : null;
    if (!enrollment) return { items: [], nextCursor: null, total: 0 };
    const phases = await manager.find(PhaseStateEntity, {
      where: { enrollmentId: enrollment.id, userId },
      select: ['id', 'phaseKey'],
    });
    const phaseIds = phases
      .map((phase) => phase.id)
      .filter((id) => !query.phaseId || id === query.phaseId);
    if (query.phaseId && !phaseIds.length)
      throw new NotFoundException('phase not found');
    if (!phaseIds.length) return { items: [], nextCursor: null, total: 0 };
    const scope = { userId, phaseStateId: In(phaseIds) };
    const cursor = query.after
      ? await manager.findOneBy(SubmissionEntity, { ...scope, id: query.after })
      : null;
    if (query.after && !cursor)
      throw new NotFoundException('review cursor not found');
    const rows = await manager.find(SubmissionEntity, {
      where: cursor
        ? [
            { ...scope, createdAt: MoreThan(cursor.createdAt) },
            { ...scope, createdAt: cursor.createdAt, id: MoreThan(cursor.id) },
          ]
        : scope,
      select: [
        'id',
        'phaseStateId',
        'status',
        'passed',
        'report',
        'createdAt',
        'commitMessage',
        'workspaceSnapshot',
        'contextSnapshot',
        // Which task this revision is
        // about, so the strict gate below is asked of that task's rubric.
        'taskKey',
      ],
      order: { createdAt: 'ASC', id: 'ASC' },
      take: 101,
    });
    const page = rows.slice(0, 100);
    return {
      items: page.map((row) => ({
        id: row.id,
        phaseStateId: row.phaseStateId,
        status: row.status,
        passed: row.passed,
        reviewUnavailable:
          row.status === 'failed' ||
          (row.status === 'completed' &&
            (!row.report || Boolean(row.report.aiReview?.assessmentError))),
        verifiedPass: this.verified(
          row,
          enrollment,
          phases.find((phase) => phase.id === row.phaseStateId)?.phaseKey,
        ),
        createdAt: row.createdAt.toISOString(),
        commitMessage: row.commitMessage,
      })),
      nextCursor: rows.length > 100 ? page[page.length - 1].id : null,
      total: await manager.count(SubmissionEntity, { where: scope }),
    };
  }

  /**
   * Whether this revision passes the strict gate, re-derived rather than read
   * back off the row; against the version the learner's enrolment holds.
   *
   * The panel does not trust a stored verdict, so the phase it
   * resolves is what decides whether a teacher is shown a verified pass. It
   * takes the enrolment rather than the slug because a published change to the
   * rubric must not retract a pass a learner already earned under the version
   * that graded them: both callers hold the enrolment already, so this is the
   * pin and not a lookup.
   *
   * It is asked of **the task the
   * revision names**. A teacher-created task's rubric is derived from its own
   * rules, so a split phase has a rubric that neither of its tasks has, and
   * counting one task's evidence against the phase's never closes; the panel
   * would tell a teacher that a revision which strict-passed did not.
   * `taskForRevision` answers *the phase's only task* for a one-task phase
   * whatever key the row carries, which is what keeps a revision written before
   * the column existed readable. With no task list this build can name, the
   * question falls back to the phase's own.
   */
  private verified(
    row: SubmissionEntity,
    enrollment: EnrollmentPin,
    phaseKey?: string,
  ): boolean {
    if (
      row.status !== 'completed' ||
      row.passed !== true ||
      !row.workspaceSnapshot ||
      !row.contextSnapshot ||
      row.report?.assessmentMode !== 'strict_binary' ||
      !row.report.passed ||
      !row.report.aiReview ||
      !Array.isArray(row.report.checks)
    )
      return false;
    const phase = this.content
      .getForEnrollment(enrollment)
      .phases.find((item) => item.key === phaseKey);
    if (!phase) return false;
    const task = phaseKey
      ? taskForRevision(this.content.getTasksForEnrollment(enrollment, phaseKey), row.taskKey)
      : undefined;
    return task
      ? strictTaskEvidencePassed(task, row.report, row.report.aiReview)
      : strictEvidencePassed(phase, row.report, row.report.aiReview);
  }

  async evidence(caller: AuthUser, submissionId: string) {
    const { submission } = await this.access(
      this.source.manager,
      caller,
      submissionId,
    );
    const state = await this.source.manager.findOneByOrFail(PhaseStateEntity, {
      id: submission.phaseStateId,
      userId: submission.userId,
    });
    const enrollment = await this.source.manager.findOneByOrFail(
      EnrollmentEntity,
      {
        id: state.enrollmentId,
        userId: submission.userId,
      },
    );
    // Explicit allowlist: never include provider inputs or private conversations.
    return {
      verifiedPass: this.verified(submission, enrollment, state.phaseKey),
      id: submission.id,
      status: submission.status,
      passed: submission.passed,
      score: submission.score,
      report: submission.report,
      error: submission.error,
      createdAt: submission.createdAt,
      workspaceSnapshot: submission.workspaceSnapshot,
      acceptedScreenCopy: submission.contextSnapshot?.acceptedScreenCopy ?? null,
      commitMessage: submission.commitMessage,
      runClock: submission.runClock,
    };
  }

  async add(
    caller: AuthUser,
    submissionId: string,
    dto: SubmissionTeacherFeedbackDto,
  ) {
    const text = dto.text.trim();
    if (text.length < 2)
      throw new BadRequestException('Write feedback the learner can act on.');
    return atomic(this.source, async (manager) => {
      const { submission } = await this.access(manager, caller, submissionId);
      if (caller.role === 'LEARNER')
        throw new NotFoundException('submission not found');
      const author = await manager.findOneOrFail(UserEntity, {
        where: { id: caller.id },
        ...rowLock(this.source),
      });
      // Serialize feedback with membership changes and duplicate teacher writes.
      await manager.findOne(UserEntity, {
        where: { id: submission.userId },
        ...rowLock(this.source),
      });
      const learner = await scopedLearner(manager, caller, submission.userId);
      const prior = await manager.findOneBy(SubmissionTeacherFeedbackEntity, {
        authorUserId: caller.id,
        requestId: dto.requestId,
      });
      if (prior) {
        if (
          prior.submissionId !== submissionId ||
          prior.action !== dto.action ||
          prior.text !== text
        ) {
          throw new ConflictException(
            'This feedback request was already used for different content.',
          );
        }
        return prior;
      }
      const row = await manager.save(
        manager.create(SubmissionTeacherFeedbackEntity, {
          submissionId,
          phaseStateId: submission.phaseStateId,
          userId: learner.id,
          cohortId: learner.cohort,
          authorUserId: caller.id,
          authorName: author.displayName,
          requestId: dto.requestId,
          action: dto.action,
          text,
        }),
      );
      await recordAudit(manager, {
        event: 'instructor.note',
        actorUserId: caller.id,
        subjectUserId: learner.id,
        targetId: submissionId,
        action: dto.action,
        detail: { feedbackId: row.id },
      });
      return row;
    });
  }
}

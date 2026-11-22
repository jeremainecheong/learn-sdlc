import { ForbiddenException } from '@nestjs/common';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ContentService } from '../content/content.service';
import { SCREEN_COPY_PATH, withScreenCopy } from '../content/screen-copy';
import { DataSource } from 'typeorm';
import {
  buildProjectMap,
  type AssistantMessageView,
  type EnrollmentView,
  type ExecutionRunView,
  type LearnerAnalytics,
  type PhaseDetail,
  type ProjectMapData,
  type SubmissionView,
  type ViewAsSession,
  type WorkspaceFile,
} from '@learnsdlc/shared';
import { AnalyticsService } from '../analytics/analytics.service';
import { AssistantService } from '../assistant/assistant.service';
import {
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { ExecutionService } from '../execution/execution.service';
import { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { summaryFiles } from '../workflow/workflow-helpers';
import { recordAudit } from '../audit/audit';
import { InstructorCaller, scopedLearner } from './cohort-scope';

/**
 * Teacher inspection of submitted evidence, using the learner screen's shape.
 * Each read is membership-scoped; live drafts and conversations stay private.
 *
 * ## Why this is six read routes and not an impersonation token
 *
 * A token carrying an impersonated subject would have to be refused by every
 * one of the forty-odd learner write routes, and a single one missed is an
 * instructor writing into a learner's coursework under the learner's name,
 * with nothing in the trail to say it was not them. Six reads that each go
 * through `scopedLearner` are provably read-only: they need no change to
 * `JwtAuthGuard`, `RolesGuard`, `AuthService.authenticate` or any write route,
 * and there is no credential that could leak.
 *
 * The instructor's own bearer token is what reaches the API the whole time, so
 * the learner write routes keep answering `ForbiddenException('not your
 * phase')` from `WorkflowService.loadOwnedState`, even to a request made by
 * hand. The browser refuses those requests too, but the browser is the
 * convenience; this is the enforcement.
 *
 */
@Injectable()
export class ViewAsService {
  private readonly logger = new Logger(ViewAsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly workflow: WorkflowService,
    private readonly feedback: FeedbackService,
    private readonly execution: ExecutionService,
    private readonly assistant: AssistantService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly content?: ContentService,
  ) {}

  /**
   * Start a session. The only write this whole feature makes: an audit row
   * saying who looked at whose work and when, because reading a learner's
   * coursework is a thing that happened to them even though nothing changed.
   */
  async start(
    caller: InstructorCaller,
    userId: string,
  ): Promise<ViewAsSession> {
    const manager = this.dataSource.manager;
    const learner = await scopedLearner(manager, caller, userId);
    this.logger.log({
      event: 'instructor.view-as',
      actorId: caller.id,
      learnerId: learner.id,
    });
    await recordAudit(manager, {
      event: 'instructor.view-as',
      actorUserId: caller.id,
      subjectUserId: learner.id,
      action: 'start',
      detail: { displayName: learner.displayName },
    });
    return {
      userId: learner.id,
      displayName: learner.displayName,
      email: learner.email,
      cohort: learner.cohort,
    };
  }

  /* ------------------------- the six read routes ------------------------ */

  async enrollment(
    caller: InstructorCaller,
    userId: string,
    projectSlug?: string,
  ): Promise<EnrollmentView | null> {
    const manager = this.dataSource.manager;
    const learner = await scopedLearner(manager, caller, userId);
    const slug = projectSlug ?? (await this.ownProject(learner));
    // `write: false`: this is a read of somebody else's coursework, and both
    // of the things a board read does to it are writes; the repair puts back
    // `phase_states` rows carrying the learner's own `userId`, and the stamp
    // rewrites `packVersion` on an enrolment with no pin (one written where the
    // deployment held no version rows). An instructor opening a page must not be
    // how either happens; the learner's own next read does both.
    const enrollment = slug
      ? await this.workflow.myEnrollment(learner.id, slug, false)
      : null;
    if (!enrollment) return null;
    const releases = await manager.find(ReleaseRecordEntity, {
      where: { enrollmentId: enrollment.id, userId: learner.id },
    });
    return {
      ...enrollment,
      phases: enrollment.phases.map((phase) => ({
        ...phase,
        reflection:
          releases.find((release) => release.phaseStateId === phase.id)
            ?.notes ?? null,
      })),
    };
  }

  async phase(
    caller: InstructorCaller,
    userId: string,
    phaseStateId: string,
  ): Promise<PhaseDetail> {
    const learner = await scopedLearner(
      this.dataSource.manager,
      caller,
      userId,
    );
    return this.learnerPhase(learner.id, phaseStateId, 'full');
  }

  /**
   * The learner's `GET /phases/summaries`, as a teacher viewing them sees it.
   *
   * The dashboard, the sidebar and the palette all draw from this one batch,
   * so it needs a view-as route of its own: sent to the phase route,
   * "summaries" would read as a phase id. Each phase is {@link learnerPhase}'s
   * answer in the summary view (the submitted snapshot and never the live
   * draft, exactly as the phase route shows it) and nothing here writes.
   * The project is the learner's own when the browser names none, as
   * {@link enrollment} resolves it.
   */
  async summaries(
    caller: InstructorCaller,
    userId: string,
    projectSlug?: string,
  ): Promise<PhaseDetail[]> {
    const learner = await scopedLearner(this.dataSource.manager, caller, userId);
    return this.openPhases(learner, projectSlug, 'summary');
  }

  /**
   * The learner's `GET /phases/records`: each open phase's submissions and
   * submitted runs, and an empty mentor thread; the conversation stays the
   * learner's here as it does on the transcript route.
   */
  async records(
    caller: InstructorCaller,
    userId: string,
    projectSlug?: string,
  ): Promise<
    Record<string, { submissions: SubmissionView[]; runs: ExecutionRunView[]; chat: AssistantMessageView[] }>
  > {
    const learner = await scopedLearner(this.dataSource.manager, caller, userId);
    const phases = await this.openPhases(learner, projectSlug, 'summary');
    const rows = await Promise.all(
      phases.map(async (phase) => {
        const [submissions, runs] = await Promise.all([
          this.feedback.listFor(phase.id, learner.id).catch(() => []),
          this.submittedRuns(learner.id, phase.id).catch(() => []),
        ]);
        return [phase.id, { submissions, runs, chat: [] as AssistantMessageView[] }] as const;
      }),
    );
    return Object.fromEntries(rows);
  }

  /**
   * The learner's project map, from the same phases the phase route shows,
   * not the teacher's own map for that slug.
   */
  async projectMap(
    caller: InstructorCaller,
    userId: string,
    projectSlug: string,
    opts: { compact: boolean; showLocked: boolean },
  ): Promise<ProjectMapData> {
    const learner = await scopedLearner(this.dataSource.manager, caller, userId);
    const enrollment = await this.workflow.myEnrollment(learner.id, projectSlug, false);
    if (!enrollment) return { nodes: [], edges: [] };
    const details: Record<string, PhaseDetail> = {};
    for (const phase of enrollment.phases.filter((one) => one.status !== 'locked')) {
      details[phase.id] = await this.learnerPhase(learner.id, phase.id, 'full');
    }
    return buildProjectMap(enrollment, details, opts);
  }

  /** Every open phase of the learner's enrolment in one project, in one view. */
  private async openPhases(
    learner: Pick<UserEntity, 'id' | 'cohort' | 'role'>,
    projectSlug: string | undefined,
    view: 'summary' | 'full',
  ): Promise<PhaseDetail[]> {
    const learnerId = learner.id;
    const slug = projectSlug ?? (await this.ownProject(learner));
    // `write: false`, as `enrollment` above: no repair, no stamp.
    const enrollment = slug ? await this.workflow.myEnrollment(learnerId, slug, false) : null;
    if (!enrollment) return [];
    const built = await Promise.all(
      enrollment.phases
        .filter((phase) => phase.status !== 'locked')
        .map((phase) => this.learnerPhase(learnerId, phase.id, view).catch(() => null)),
    );
    return built.filter((detail): detail is PhaseDetail => detail !== null);
  }

  /**
   * One phase as the teacher sees it: the learner's board, with the files of
   * their latest submission in place of the live draft.
   */
  private async learnerPhase(
    learnerId: string,
    phaseStateId: string,
    view: 'summary' | 'full',
  ): Promise<PhaseDetail> {
    const learner = { id: learnerId };
    // `repair: false, write: false` for the same reason as `enrollment` above:
    // the six reads this service makes are the feature's whole safety
    // argument, so none of them may write. The second flag is the one that
    // covers the room's two other writes; the pack stamp and the retained
    // Design screen copy, which Implementation, Testing, Deployment and
    // Maintenance all reach.
    const detail = await this.workflow.phaseDetail(learner.id, phaseStateId, view, false, false);
    // The summary view carries a file index, not bodies: a file this read
    // fills from the snapshot is folded to the same index, so the shell never
    // holds a body it was told is not there.
    const shaped = (file: WorkspaceFile): WorkspaceFile =>
      view === 'summary'
        ? { ...summaryFiles([file])[0], ...(file.touched !== undefined ? { touched: file.touched } : {}) }
        : file;
    const submitted = await this.dataSource.manager.findOne(SubmissionEntity, {
      where: { phaseStateId, userId: learner.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const release = await this.dataSource.manager.findOne(ReleaseRecordEntity, {
      where: { phaseStateId, userId: learner.id },
    });
    const snapshot = submitted?.workspaceSnapshot;
    const acceptedScreenCopy = submitted?.contextSnapshot?.acceptedScreenCopy ?? null;
    // The learner's own version. `detail` already came from it
    // (`phaseDetail` resolves through the pin) so resolving the head here
    // would pair one version's file list with another version's declaration of
    // this one file, and an instructor would be shown a room that does not
    // match the room the learner is in. That match is the whole of what the six
    // read routes promise. Still a read: `enrollmentFor` selects two columns
    // and writes nothing.
    const pin = this.content
      ? await this.enrollmentFor(learner.id, phaseStateId, detail.projectSlug)
      : null;
    const retainedCopy = this.content && pin && this.content.workspaceFiles(
      withScreenCopy(this.content.getPhaseForEnrollment(pin, detail.key), acceptedScreenCopy), null,
    ).find(file => file.path === SCREEN_COPY_PATH);
    return {
      ...detail,
      acceptedScreenCopy,
      files: detail.files.flatMap((file) => {
        if (file.path === SCREEN_COPY_PATH) return retainedCopy ? [shaped(retainedCopy)] : [];
        if (!file.editable) return [file];
        if (
          !snapshot ||
          !Object.prototype.hasOwnProperty.call(snapshot, file.path)
        )
          return [];
        const content = snapshot[file.path];
        return [
          shaped({
            ...file,
            content,
            lines: content.split('\n').length,
            touched: true,
          }),
        ];
      }),
      reflection: release?.notes ?? null,
      links: submitted?.contextSnapshot?.links ?? [],
      drill: submitted?.contextSnapshot?.drill ?? null,
      runClock: submitted?.runClock ?? null,
      workspaceUpdatedAt: submitted?.createdAt?.toISOString() ?? null,
      canRun: false,
      canPreview: false,
    };
  }

  /**
   * One phase's revisions, or one task's where `taskKey` names it; the twin
   * of the learner's per-task route. Narrowed on the learner's own
   * id as well as the phase, so a phase or a key that is not theirs answers an
   * empty list and nothing else; nothing here writes.
   */
  async submissions(
    caller: InstructorCaller,
    userId: string,
    phaseStateId: string,
    taskKey?: string,
  ): Promise<SubmissionView[]> {
    const learner = await scopedLearner(
      this.dataSource.manager,
      caller,
      userId,
    );
    return taskKey === undefined
      ? this.feedback.listFor(phaseStateId, learner.id)
      : this.feedback.listFor(phaseStateId, learner.id, taskKey);
  }

  async runs(
    caller: InstructorCaller,
    userId: string,
    phaseStateId: string,
  ): Promise<ExecutionRunView[]> {
    const learner = await scopedLearner(
      this.dataSource.manager,
      caller,
      userId,
    );
    return this.submittedRuns(learner.id, phaseStateId);
  }

  /** The learner's submitted runs of one phase; exploratory runs stay private. */
  private async submittedRuns(learnerId: string, phaseStateId: string): Promise<ExecutionRunView[]> {
    const submittedRuns = await this.dataSource.manager.find(
      ExecutionRunEntity,
      {
        where: { phaseStateId, userId: learnerId, kind: 'submit' },
        order: { createdAt: 'ASC', id: 'ASC' },
      },
    );
    return submittedRuns.map((run) => this.execution.toView(run));
  }

  async transcript(
    caller: InstructorCaller,
    userId: string,
    phaseStateId: string,
  ): Promise<AssistantMessageView[]> {
    await scopedLearner(this.dataSource.manager, caller, userId);
    throw new ForbiddenException(
      'Private mentor conversations are visible only to their learner.',
    );
  }

  async learnerAnalytics(
    caller: InstructorCaller,
    userId: string,
    projectSlug?: string,
  ): Promise<LearnerAnalytics> {
    const learner = await scopedLearner(
      this.dataSource.manager,
      caller,
      userId,
    );
    return this.analytics.forLearner(learner.id, projectSlug);
  }

  /**
   * The pin behind one phase state, for the one content read this file makes
   * that `WorkflowService` does not make for it.
   *
   * Two lean selects rather than a second `loadOwnedState`: that call re-runs
   * the gate and, without its `write: false` flag, re-stamps the row, and this
   * service's whole argument is that none of its reads writes. The rows are
   * already known to exist and to be this learner's, because `phaseDetail`
   * refused the request otherwise; a row that vanished between the two reads
   * falls back to the slug the detail carries with no pin, which is the
   * published head.
   */
  private async enrollmentFor(
    userId: string,
    phaseStateId: string,
    projectSlug: string,
  ): Promise<{ projectSlug: string; projectVersionId: string | null }> {
    const manager = this.dataSource.manager;
    const state = await manager.findOne(PhaseStateEntity, {
      where: { id: phaseStateId, userId },
      select: ['id', 'enrollmentId'],
    });
    const enrollment = state
      ? await manager.findOne(EnrollmentEntity, {
          where: { id: state.enrollmentId, userId },
          select: ['id', 'projectSlug', 'projectVersionId'],
        })
      : null;
    return enrollment ?? { projectSlug, projectVersionId: null };
  }

  /**
   * Which project to show when the console did not say: the one the learner's
   * own `GET /enrollments/mine` answers for a request that names none
   * (`WorkflowService.projectVersionForLearner`; their own enrolment their
   * membership still reaches, else their class's assignment, else the
   * deployment's default).
   *
   * Not simply the oldest enrolment: a class given a project of its own sets
   * aside the default row the learner started first, and a teacher pressing
   * View as would be shown that set-aside board, which the learner never
   * sees. The resolution only reads
   * (the enrolments, the projects, the class's assignment) so the twins stay
   * write-free.
   */
  private async ownProject(learner: Pick<UserEntity, 'id' | 'cohort' | 'role'>): Promise<string | null> {
    const pin = await this.workflow.projectVersionForLearner({
      id: learner.id,
      cohort: learner.cohort,
      role: learner.role,
    });
    return pin?.projectSlug ?? null;
  }
}

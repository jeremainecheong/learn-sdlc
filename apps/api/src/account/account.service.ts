import { PasswordWorkService } from '../auth/password-work.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { compareProjectVersions } from "@learnsdlc/shared";
import { DataSource, EntityManager, In, Not } from "typeorm";
import {
  AssistantMessageEntity,
  AgentProposalEntity,
  // The content model names people in four columns of its own
  CohortProjectAssignmentEntity,
  ProjectEntity,
  ProjectVersionEntity,
  // The rows a teacher's own authoring writes, which the export carries
  ProjectPhaseEntity,
  ProjectTaskEntity,
  // The files a teacher replaced, and their bytes
  ProjectFileEntity,
  ContentBlobEntity,
  AgentTurnEntity,
  SubmissionTeacherFeedbackEntity,
  AuditEventEntity,
  CohortEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  // One learner's paper on one quiz task
  QuizAttemptEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  // A learner's state on one task of a phase, and what a reset took
  TaskResetEntity,
  TaskStateEntity,
  UserEntity,
  WarmupStateEntity,
  NotificationEntity,
  PreviewSessionEntity,
} from "../db/entities";
import type { UpdateProfileDto } from "../dto";
import { AuthService } from "../auth/auth.service";
import { config } from "../config";
import { CognitoService } from "../auth/cognito.service";
import { recordAudit } from "../audit/audit";
import { isReferenceInterview } from "../content/reference-content";
import { learnerExplanationAssessment } from "../assistant/explanation-assessment";
import type { AgentTurnResponse } from "../assistant/agentic.service";
import { optionToken, sheetInTokens } from "../quiz/quiz-attempts.service";
import { isOlderWritten, isOlderWrittenKind } from "../content/older-written";
import { rowLock } from '../db/atomic';
import { BUMP_TOKEN_VERSION } from '../db/token-version';
import { isoText } from '../db/timestamps';

/** Keep learner text and history, without exporting a rejected reference answer
 * through an alternate endpoint. This is the same presentation as mentor reads. */
function exportProposal<T extends Pick<AgentProposalEntity, 'files' | 'explanationAssessment'>>(row: T): T {
  return { ...row, explanationAssessment: learnerExplanationAssessment(row.explanationAssessment, Object.keys(row.files)) };
}

/**
 * A learner's paper, in the language the learner was shown it in.
 *
 * `paper[].optionIds` and `answers` are stored in the teacher's authored ids,
 * which the scorer, a regrade and the teacher's own views need. They are also
 * the order the options were written in, and the paper stores them in the
 * order this learner saw them, so handed back as they are, they tell the
 * learner which option on screen was written first, on an open paper as much
 * as on a marked one. Every learner payload names an option by the paper's
 * token instead (`optionToken`), and so does this one: the same token for the
 * same option on the same paper, so the export, the room and the report agree
 * with one another and with nothing else. Every other column is the row's.
 */
function exportPaper(row: QuizAttemptEntity): QuizAttemptEntity {
  return {
    ...row,
    paper: (row.paper ?? []).map((question) => ({
      questionId: question.questionId,
      optionIds: question.optionIds.map((id) => optionToken(row.id, question.questionId, id)),
    })),
    answers: row.answers ? sheetInTokens(row.id, row.answers) : row.answers,
  };
}

function exportTurn(row: AgentTurnEntity): AgentTurnEntity {
  const response = row.response as AgentTurnResponse | null;
  if (!response) return row;
  const proposal = response.proposal ? exportProposal(response.proposal) : null;
  const assessment = proposal?.explanationAssessment;
  return { ...row, response: { ...response, proposal,
    ...(response.kind === 'explanation' && assessment && !assessment.adequate
      ? { reply: assessment.feedback, questions: assessment.questions } : {}),
  } };
}

/** A table whose rows belong to a learner through a plain `userId` column. */
type UserScopedEntity = new () => { userId: string };

/** Operational ownership is not coursework. Capability hashes are never an
 * export field. On erasure the missing user immediately revokes every door;
 * the preview reaper retains these minimal instructions only until the runner
 * is confirmed terminal, then purges them. Deleting them first would orphan
 * running learner code. Every userId entity must belong to exactly one list. */
export const CLEANUP_SCOPED_ENTITIES: readonly UserScopedEntity[] = [PreviewSessionEntity];

/**
 * Every table a learner's rows live in, parents first, each with the key it
 * takes in the export. The order carries meaning in both directions: the
 * export reads it forwards so the JSON runs from enrolment through to
 * transcript, and the deletion reads it backwards so a child row is never left
 * behind pointing at a parent that has already gone.
 *
 * `users` is deliberately absent: it is keyed by `id`, not `userId`, and both
 * operations handle it separately.
 */
export const USER_SCOPED_ENTITIES: ReadonlyArray<{
  readonly exportKey: string;
  readonly entity: UserScopedEntity;
}> = [
  { exportKey: "agentProposals", entity: AgentProposalEntity },
  { exportKey: "agentTurns", entity: AgentTurnEntity },
  { exportKey: "teacherFeedback", entity: SubmissionTeacherFeedbackEntity },
  { exportKey: "enrollments", entity: EnrollmentEntity },
  { exportKey: "phaseStates", entity: PhaseStateEntity },
  // The learner's state on each authored task of a phase, and what a
  // reset of one took away. Parents first, as this list reads: a task row hangs
  // off a phase state and a reset hangs off a task row, so `phaseStates`,
  // `taskStates`, `taskResets`; and the deletion, which reads the list
  // backwards, takes the reset, then the task row, then the phase state. A
  // sole-task phase has no row here at all, so a learner of the imported
  // default project exports two empty arrays and erases the same.
  { exportKey: "taskStates", entity: TaskStateEntity },
  { exportKey: "taskResets", entity: TaskResetEntity },
  { exportKey: "submissions", entity: SubmissionEntity },
  // The learner's quiz papers. Immediately after `submissions`,
  // because an attempt hangs off one (`submissionId` names the revision the
  // grader scored) and this list is read parents-first by the export and
  // backwards by the deletion, so listing it here is what takes the attempt
  // away before the submission it points at.
  //
  // A paper is a draw and a permutation, so the row carries the ids of the
  // questions this learner was shown and the options in the order they were
  // shown them, and it carries neither the key nor the explanation nor a
  // question the draw passed over: a property of the table, see
  // QuizAttemptEntity. What the row does carry is the teacher's option ids,
  // and those are the order the options were written in: a teacher who always
  // writes the right answer first would leak the key by position, on an
  // open paper, before a single answer. So the export renames the
  // options and the answers into the paper's own tokens on the way out
  // (`exportPaper` below) exactly as the room and the report name them.
  { exportKey: "quizAttempts", entity: QuizAttemptEntity },
  { exportKey: "executionRuns", entity: ExecutionRunEntity },
  { exportKey: "mentorMessages", entity: AssistantMessageEntity },
  { exportKey: "releases", entity: ReleaseRecordEntity },
  // The warm-up is the learner's own work in the learner's own
  // files, so it exports and erases with the rest of their coursework. Last in
  // the list because nothing hangs off it.
  { exportKey: "warmup", entity: WarmupStateEntity },
  // The bell. A notification is a pointer rather than a record, so
  // the export carries what the account was told and the erasure takes it with
  // everything else; the facts they point at are kept in their own tables.
  // Listed because the row is keyed by `userId` and the spec above asserts
  // this list covers every such table.
  { exportKey: "notifications", entity: NotificationEntity },
];

/**
 * Tables that name a person without a `userId` column, and so cannot be caught
 * by the list above or by the assertion that keeps it honest.
 *
 * `audit_events` names two people: the staff member who acted and the learner
 * they acted on, and an override's `reason` is an instructor's writing about
 * that learner, kept indefinitely. The policy this file implements: an export
 * returns every row where the account appears at either end, and a deletion
 * *tombstones* the rows where it is the subject, nulling `subjectUserId` and
 * keeping everything else.
 *
 * Deleting those rows outright would take the record of the deletion with
 * them and take an instructor's override out of the trail the moment the
 * learner it was about left, so the one question an appeal asks weeks
 * later (who did this and why) would have no answer at all. A tombstone
 * answers it without keeping a person: the id is gone, and
 * `auditViews` renders a subject that no longer resolves as a nameless one.
 * Rows where the account was only the actor are somebody else's record and are
 * left exactly as they are.
 */
export const SUBJECT_SCOPED_ENTITIES: ReadonlyArray<{
  readonly exportKey: string;
  readonly entity: typeof AuditEventEntity;
}> = [{ exportKey: "auditEvents", entity: AuditEventEntity }];

/**
 * The third way a table names a person: as the **actor** of a record that is
 * somebody else's.
 *
 * `deleteAccount` is available to any account, instructors included, and
 * refusing only for owning a *populated* class is not enough. The content
 * model names people in four more columns: a project's author, a version's
 * publisher, a class assignment's actor, and a task's countersigner, and not
 * one of them is visible to either decorator scan above. Without this list a
 * teacher deletes their account, the suite stays green, and a live class's
 * content provenance dangles.
 *
 * The policies differ, so they are named rather than looped over:
 *
 * - **`cohorts.ownerUserId`**: refused while anybody is still in the class,
 *   and the class is closed with the account when it is empty.
 * - **`projects.ownerUserId`**: refused while an enrolment pins one of its
 *   published versions, because a version an enrolment pins cannot be
 *   withdrawn; otherwise the project is **archived**, not deleted. The blobs
 *   are shared by sha, so deleting the rows would save nothing and lose a
 *   fork's lineage. `platformOwned` stays false, which is why that column is
 *   explicit: an ownerless project must never read as platform content.
 *   This column is not *only* an actor column: a teacher's
 *   project holds titles, briefs and rubric rules they wrote, so the export
 *   carries them too, through `authoredProjects` and not through this list;
 *   the compiled snapshot and the file rows stay behind, for the reason given
 *   there.
 * - **`project_versions.publishedByUserId`** and
 *   **`cohort_project_assignments.assignedByUserId`**: left exactly as they
 *   are, which is already the policy for an actor: *"rows where the account was
 *   only the actor are somebody else's record"*. The id stops resolving and the
 *   view renders a publisher with no name, exactly as `auditViews` does for a
 *   tombstoned subject. This is not a convenience: the phase gate reads whether
 *   a sign-off is set, so nulling an actor would reclose a phase a teacher had
 *   opened, for every learner they had ever signed off, on the day they left.
 *
 * The spec asserts this list covers exactly the columns the decorators declare,
 * so the next such column fails the suite rather than the class.
 */
export const ACTOR_SCOPED_ENTITIES: ReadonlyArray<{
  readonly entity: new () => object;
  readonly column: string;
  readonly policy: "refused-then-closed" | "refused-then-archived" | "kept";
}> = [
  { entity: CohortEntity, column: "ownerUserId", policy: "refused-then-closed" },
  { entity: ProjectEntity, column: "ownerUserId", policy: "refused-then-archived" },
  { entity: ProjectVersionEntity, column: "publishedByUserId", policy: "kept" },
  { entity: CohortProjectAssignmentEntity, column: "assignedByUserId", policy: "kept" },
  // The countersignature. `kept`, and the third bullet above is
  // exactly why: the gate reads whether a sign-off is set, so nulling this
  // column would reclose a phase a teacher had opened, for every learner they
  // had ever signed off, on the day they left.
  { entity: TaskStateEntity, column: "signedOffBy", policy: "kept" },
];

/**
 * The two rights the privacy policy promises, implemented rather than
 * described: take everything with you, or remove all of it.
 *
 * Both walk USER_SCOPED_ENTITIES. The entities are scoped by a `userId`
 * column rather than joined by a foreign key, so nothing cascades on its own:
 * if a table is added and not listed there, an export silently omits it and a
 * deletion silently orphans it. That is why the list lives in one constant used
 * by both operations, and why account.service.spec.ts asserts it covers every
 * entity in ALL_ENTITIES that declares a userId column: adding such a table
 * without listing it fails the suite.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  /**
   * AuthService is optional only so the spec can drive the data path with a
   * bare DataSource; in the running app Nest always supplies it. Without it a
   * bumped tokenVersion still revokes, just after the session cache TTL.
   */
  constructor(
    private readonly passwords: PasswordWorkService,
    private readonly dataSource: DataSource,
    @Optional() private readonly auth?: AuthService,
    @Optional() private readonly cognito?: CognitoService,
  ) {}

  /** All learner-owned rows, with rejected explanation rationales presented as in the mentor. */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const manager = this.dataSource.manager;
    const user = await manager.findOne(UserEntity, { where: { id: userId } });
    if (!user) throw new NotFoundException("account not found");

    const tables = await Promise.all(
      USER_SCOPED_ENTITIES.map(async ({ exportKey, entity }) => ({
        exportKey,
        rows: await manager.find(entity, { where: { userId } }),
      })),
    );

    const data: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      note: config.authProvider === 'cognito'
        ? "This contains your LearnSDLC account data and learner-facing assessment feedback. Internal rationale for rejected understanding assessments is excluded; your text, verdicts, evidence and history are retained. Managed sign-in data is held by the configured identity provider; no password or authentication token is included."
        : "This contains your LearnSDLC account data and learner-facing assessment feedback. Internal rationale for rejected understanding assessments is excluded; your text, verdicts, evidence and history are retained. Your password hash is not included.",
      account: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar,
        bio: user.bio,
        goals: user.goals,
        onboardingCompleted: user.onboardingCompleted,
        role: user.role,
        cohort: user.cohort,
        dailyTokenBudget: user.dailyTokenBudget,
        createdAt: user.createdAt,
      },
    };
    for (const { exportKey, rows } of tables) {
      data[exportKey] = exportKey === 'agentProposals' ? (rows as AgentProposalEntity[]).map(exportProposal)
        : exportKey === 'agentTurns' ? (rows as AgentTurnEntity[]).map(exportTurn)
        : exportKey === 'quizAttempts' ? (rows as QuizAttemptEntity[]).map(exportPaper) : rows;
    }

    // Staff actions naming this account, at either end. Not part of the list
    // above because the columns are actorUserId and subjectUserId; see
    // SUBJECT_SCOPED_ENTITIES for why they are exported and what a deletion
    // does with them.
    for (const { exportKey, entity } of SUBJECT_SCOPED_ENTITIES) {
      data[exportKey] = await manager.find(entity, {
        where: [{ subjectUserId: userId }, { actorUserId: userId }],
        order: { createdAt: "ASC" },
      });
    }

    // What a teacher *wrote*, which the lists above cannot reach.
    data.authoredProjects = await this.authoredProjects(manager, userId);
    return data;
  }

  /**
   * The projects this account authored, as the teacher wrote them.
   *
   * `projects.ownerUserId` is more than an actor column recording who
   * imported a pack. A teacher writes a project's title, a phase's
   * title and intro, and a task's title, brief, objectives and the rubric rules
   * they invented: user-generated content in the plainest sense, reachable by
   * neither USER_SCOPED_ENTITIES (no `userId` column) nor SUBJECT_SCOPED_ENTITIES
   * (no subject). Erasure already covers it, `deleteAccount` nulls the owner and
   * archives the versions; without this the right to *take it with you* would
   * stop at the door, and a teacher who left would get none of their own work back.
   *
   * **What is deliberately not here.** `project_versions.compiled` is the whole
   * compiled pack by value: the platform's hidden suites, solutions, mutants
   * and canonical application baked in, and `project_files` rows point at
   * blobs of the same. Exporting either would hand a departing account the
   * sealed material of the project they copied, which no authoring door will
   * give them while they are here. The teacher's own prose and rules are on the
   * rows below, and that is what they wrote.
   */
  private async authoredProjects(manager: EntityManager, userId: string): Promise<unknown[]> {
    const projects = await manager.find(ProjectEntity, {
      where: { ownerUserId: userId },
      order: { createdAt: "ASC" },
    });
    const out: unknown[] = [];
    for (const project of projects) {
      const versions = await manager.find(ProjectVersionEntity, {
        where: { projectId: project.id },
        order: { createdAt: "ASC" },
        // Named columns, never the row: `compiled` is the pack by value.
        select: ["id", "version", "status", "notes", "publishedAt", "createdAt", "forkedFromVersionId"],
      });
      const phases = versions.length
        ? await manager.find(ProjectPhaseEntity, {
            where: { projectVersionId: In(versions.map((one) => one.id)) },
            order: { order: "ASC" },
          })
        : [];
      const tasks = phases.length
        ? await manager.find(ProjectTaskEntity, {
            where: { projectPhaseId: In(phases.map((one) => one.id)) },
            order: { order: "ASC" },
          })
        : [];
      const tasksByPhase = new Map<string, ProjectTaskEntity[]>();
      for (const task of tasks) {
        tasksByPhase.set(task.projectPhaseId, [...(tasksByPhase.get(task.projectPhaseId) ?? []), task]);
      }
      // The files whose bytes the teacher wrote.
      const ownFiles = await this.authoredFiles(manager, project.id, versions, phases);
      out.push({
        slug: project.slug,
        title: project.title,
        origin: project.origin,
        createdAt: project.createdAt,
        versions: versions.map((version) => ({
          version: version.version,
          status: version.status,
          notes: version.notes,
          publishedAt: version.publishedAt,
          createdAt: version.createdAt,
          phases: phases
            .filter((phase) => phase.projectVersionId === version.id)
            .map((phase) => ({
              key: phase.key,
              order: phase.order,
              title: phase.title,
              intro: phase.intro,
              // The interview only when it is the
              // teacher's. A copied brief is the reference's, and its answers
              // are sealed material this door never hands out.
              ...(phase.interview && !isReferenceInterview(phase.interview) ? { interview: phase.interview } : {}),
              ...(ownFiles.has(phase.id) ? { files: ownFiles.get(phase.id) } : {}),
              tasks: (tasksByPhase.get(phase.id) ?? []).map((task) => {
                // a stored row's checks, read as the older written kind they may still be
                const older: unknown = task.checks;
                return {
                  taskKey: task.taskKey,
                  order: task.order,
                  required: task.required,
                  title: task.title,
                  brief: task.brief,
                  objectives: task.objectives ?? [],
                  artefactType: task.artefactType,
                  artefactPath: task.artefactPath,
                  // The rules a teacher wrote, and only those: an older written
                  // task's rules are prose about prose. A code or tests task's `checks`
                  // hold hidden suites and solutions by value and are never a
                  // teacher's writing, so they do not come out here.
                  rules: isOlderWritten(older) ? older.rules : [],
                  rubric: isOlderWritten(older) ? task.rubric : null,
                };
              }),
            })),
        })),
      });
    }
    return out;
  }

  /**
   * Per phase row, the learner-readable files of these
   * versions whose bytes differ from the same file of the version the copy
   * came from: `{path, content}` only, never a role, a sha or a sealed row.
   *
   * The source is the first version up the fork chain that belongs to another
   * project (the pack the teacher copied), so a later version of the teacher's
   * own copy still hands back the backlog an earlier one replaced. Only
   * `workspace` rows are read: a hidden suite, a mutant, the interview row and
   * the canonical application are sealed, and their blobs never leave. A
   * project with no source (nothing was copied) has no bytes to compare, and
   * hands back every workspace file of its written phases as its own.
   */
  private async authoredFiles(
    manager: EntityManager,
    projectId: string,
    versions: ProjectVersionEntity[],
    phases: ProjectPhaseEntity[],
  ): Promise<Map<string, { path: string; content: string }[]>> {
    const out = new Map<string, { path: string; content: string }[]>();
    if (!versions.length) return out;
    const rows = await manager.find(ProjectFileEntity, {
      where: { projectVersionId: In(versions.map((one) => one.id)), role: "workspace" },
    });
    if (!rows.length) return out;
    const sourceShas = new Map<string, Map<string, string>>(); // version id -> "phaseKey\u0000path" -> sha
    const sourceOf = async (version: ProjectVersionEntity): Promise<Map<string, string> | null> => {
      let from = version.forkedFromVersionId ?? null;
      for (let hop = 0; from && hop < 64; hop += 1) {
        const held = await manager.findOne(ProjectVersionEntity, {
          where: { id: from },
          select: ["id", "projectId", "forkedFromVersionId"],
        });
        if (!held) return null;
        if (held.projectId !== projectId) {
          const cached = sourceShas.get(held.id);
          if (cached) return cached;
          const sourcePhases = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: held.id }, select: ["id", "key"] });
          const keyOf = new Map(sourcePhases.map((one) => [one.id, one.key]));
          const sourceRows = await manager.find(ProjectFileEntity, { where: { projectVersionId: held.id, role: "workspace" } });
          const shas = new Map(sourceRows.filter((one) => keyOf.has(one.ownerId)).map((one) => [`${keyOf.get(one.ownerId)}\u0000${one.path}`, one.blobSha]));
          sourceShas.set(held.id, shas);
          return shas;
        }
        from = held.forkedFromVersionId ?? null;
      }
      return null;
    };
    const byId = new Map(phases.map((one) => [one.id, one]));
    const wanted: { phaseId: string; path: string; sha: string }[] = [];
    for (const version of versions) {
      const source = await sourceOf(version);
      for (const row of rows) {
        if (row.projectVersionId !== version.id || row.ownerKind !== "phase") continue;
        const phase = byId.get(row.ownerId);
        if (!phase) continue;
        if (source) {
          if (source.get(`${phase.key}\u0000${row.path}`) === row.blobSha) continue;
        } else if (!isOlderWrittenKind(phase.artifactKind)) {
          continue;
        }
        wanted.push({ phaseId: phase.id, path: row.path, sha: row.blobSha });
      }
    }
    if (!wanted.length) return out;
    const blobs = await manager.find(ContentBlobEntity, { where: { sha: In([...new Set(wanted.map((one) => one.sha))]) } });
    const bytes = new Map(blobs.map((one) => [one.sha, one.bytes]));
    for (const one of wanted.sort((a, b) => a.path.localeCompare(b.path))) {
      out.set(one.phaseId, [...(out.get(one.phaseId) ?? []), { path: one.path, content: bytes.get(one.sha) ?? "" }]);
    }
    return out;
  }

  /**
   * Rename yourself. The only profile field a learner owns.
   *
   * One scoped statement, naming the one column this operation owns. Loading
   * the row and saving it back would carry every other column along with it,
   * so a suspension written between the load and the save would be undone by
   * a rename; see changePassword for the same reasoning at length.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const patch: Partial<UserEntity> = { displayName: dto.displayName.trim() };
    if (dto.avatar !== undefined) patch.avatar = dto.avatar;
    if (dto.bio !== undefined) patch.bio = dto.bio.trim();
    if (dto.goals !== undefined) patch.goals = dto.goals.trim();
    if (dto.onboardingCompleted !== undefined)
      patch.onboardingCompleted = dto.onboardingCompleted;
    const versioned = dto.baseVersion !== undefined;
    const { affected } = await this.dataSource.manager.update(
      UserEntity,
      { id: userId, ...(versioned ? { profileVersion: dto.baseVersion } : {}) },
      { ...patch, profileVersion: () => '"profileVersion" + 1' },
    );
    if (!affected) {
      if (
        versioned &&
        (await this.dataSource.manager.existsBy(UserEntity, { id: userId }))
      ) {
        throw new ConflictException(
          "Your profile changed in another tab. Your draft is still here; reload the saved profile before applying your changes.",
        );
      }
      throw new NotFoundException("account not found");
    }
    const user = await this.dataSource.manager.findOneByOrFail(UserEntity, {
      id: userId,
    });
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      cohort: user.cohort,
      avatar: user.avatar,
      bio: user.bio,
      goals: user.goals,
      onboardingCompleted: user.onboardingCompleted,
      profileVersion: user.profileVersion,
      createdAt: isoText(user.createdAt),
    };
  }

  /**
   * Change your password, proving you know the current one first.
   *
   * That check is what stops a borrowed session from locking the real owner
   * out: without it, anyone who walks up to an unlocked laptop can take the
   * account permanently. A forgotten password is RecoveryService's job (the
   * emailed link proves mailbox control instead), not this method's.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ changed: true }> {
    const manager = this.dataSource.manager;
    const user = await manager.findOne(UserEntity, { where: { id: userId } });
    if (!user) throw new NotFoundException("account not found");

    if (config.authProvider === 'cognito') {
      if (!this.cognito?.enabled() || !this.auth || !user.cognitoSub) throw new ServiceUnavailableException('Managed password change is unavailable. Use your sign-in provider or contact the LearnSDLC host.');
      if (user.disabledAt) throw new BadRequestException('This account is suspended.');
      if (currentPassword === newPassword) throw new BadRequestException('The new password must differ from the current one.');
      await this.cognito.changePassword(user.email,user.cognitoSub,currentPassword,newPassword);
      await this.auth.signOut(userId);
      await recordAudit(manager,{event:'password.change',actorUserId:userId,subjectUserId:userId,
        action:'managed password changed',detail:{sessionsRevoked:true}});
      return {changed:true};
    }
    if (!(await this.passwords.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException("current password is not correct");
    }
    if (await this.passwords.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException(
        "the new password must differ from the current one",
      );
    }

    // One statement carries both: a new hash with the old version would leave
    // every token issued before the change (the stolen one included) valid
    // for the rest of its week. The guard compares the token's `ver` to this
    // column, so bumping it signs every existing session out; the caller logs
    // in again with the new password and gets a token minted at the new
    // version.
    //
    // It is an update naming two columns rather than a save of the row read
    // above, for two reasons. Hashing at cost 12 takes about a quarter of a
    // second, and an admin can suspend this account inside that window; saving
    // the row would carry the `disabledAt: null` read before the suspension
    // back over it and quietly restore the account. And the version is added
    // to in SQL, so two revocations racing each other advance it twice rather
    // than both writing the same number.
    const passwordHash = await this.passwords.hash(newPassword);
    const { affected } = await manager.update(
      UserEntity,
      { id: userId },
      { passwordHash, tokenVersion: BUMP_TOKEN_VERSION },
    );
    // The account was deleted while the hash was being computed. Nothing was
    // written, and saying so is better than reporting a change that is not there.
    if (!affected) throw new NotFoundException("account not found");
    this.auth?.forgetSession(userId);

    // The account holder is both ends of this one. It is in the trail because
    // a password change is the write a stolen session makes first, and an
    // account taken over on a Tuesday should not be indistinguishable from one
    // whose owner simply chose a new password. No password is recorded: what
    // an appeal asks is that it happened, to whom, and when.
    await recordAudit(manager, {
      event: "password.change",
      actorUserId: userId,
      subjectUserId: userId,
      action: "password changed",
      detail: { sessionsRevoked: true },
    });

    this.logger.log(`password changed for ${userId}; earlier sessions revoked`);
    return { changed: true };
  }

  /**
   * Permanent deletion, in one transaction so a failure part-way cannot leave
   * an account that exists with its coursework gone (or the reverse).
   *
   * Children are removed before the user so that a crash between statements
   * never leaves rows pointing at a userId that no longer resolves.
   */
  async deleteAccount(
    userId: string,
    confirmEmail: string,
  ): Promise<{ deleted: true }> {
    if (config.authProvider === 'cognito') throw new BadRequestException({code:'MANAGED_ACCOUNT_ACTION_REQUIRED',
      message:'Managed account deletion needs identity-provider and coursework removal together. Contact the LearnSDLC host; no data has been deleted.'});
    await this.dataSource.transaction(async (manager) => {
      const user = await manager.findOne(UserEntity, {
        where: { id: userId },
        // Preview launch/audit publication locks this same authority row. A
        // deletion must serialize its tombstone sweep with those publishers.
        ...rowLock(manager),
      });
      if (!user) throw new NotFoundException("account not found");

      // The confirmation is checked here, against the row, rather than in the
      // browser: a client-side check protects nobody.
      if (
        confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()
      ) {
        throw new BadRequestException(
          "type your account email exactly to confirm deletion",
        );
      }

      const owned = await this.ownedCohorts(manager, userId);
      const populated = owned.filter((cohort) => cohort.occupied);
      if (populated.length)
        throw new BadRequestException(classesStillOwned(populated));

      // The same question about the other thing an instructor owns. A
      // version an enrolment resolves cannot be withdrawn, so this is that
      // invariant read from the other end: the account cannot leave while a
      // class is working its content. "Resolves", not "pins": an enrolment with
      // a null pin (which is every enrolment through the ordinary door) takes
      // the newest published version, so asking only about the pin would make
      // this refusal unreachable and the archive below unconditional.
      const pinned = await this.pinnedOwnedVersions(manager, userId);
      if (pinned.length) throw new BadRequestException(projectsStillPinned(pinned));

      // The classes that are left are empty, and an empty class with no owner
      // is worse than none: nobody can see it, and its join code still works,
      // so learners keep walking into a room no instructor is in.
      for (const { id } of owned) await manager.delete(CohortEntity, { id });

      // The projects that are left are resolved by no enrolment, and they are archived
      // rather than deleted: the blobs are shared by sha, so deleting the rows
      // would save nothing and lose a fork's lineage. `ownerUserId` goes
      // because the person does; `platformOwned` stays false, so an ownerless
      // project never reads as platform content.
      for (const project of await manager.find(ProjectEntity, { where: { ownerUserId: userId } })) {
        await manager.update(
          ProjectVersionEntity,
          { projectId: project.id },
          { status: "archived" },
        );
        await manager.update(ProjectEntity, { id: project.id }, { ownerUserId: null });
      }

      // Written before the rows go, so the tombstone pass below nulls this one
      // too and the trail keeps a dated, nameless record that the account was
      // deleted at its owner's request.
      await recordAudit(manager, {
        event: "account.delete",
        actorUserId: userId,
        subjectUserId: userId,
        action: "account deleted",
        detail: { cohortsClosed: owned.map(({ name }) => name) },
      });

      // Deepest child first, which is the export order read backwards.
      for (const { entity } of USER_SCOPED_ENTITIES.slice().reverse()) {
        await manager.delete(entity, { userId });
      }
      // Tombstones, not deletions. The person goes; the record that somebody
      // acted, and why, stays: see SUBJECT_SCOPED_ENTITIES above for why the
      // rows are worth more than the id they carried.
      for (const { entity } of SUBJECT_SCOPED_ENTITIES) {
        await manager.update(
          entity,
          { subjectUserId: userId },
          { subjectUserId: null },
        );
      }
      await manager.delete(UserEntity, { id: userId });
      // CLEANUP_SCOPED_ENTITIES remain for the reaper's terminal-cleanup proof.
      // With no user authority their URLs and status endpoints fail closed.
    });
    this.auth?.forgetSession(userId);

    // The id, never the email: the log is the one place the address should not
    // survive a deletion request.
    this.logger.log(`account ${userId} deleted at the owner's request`);
    return { deleted: true };
  }

  /**
   * Every class this account owns, with the two counts the refusal needs.
   *
   * `occupied` is anybody else sitting in the class, whatever their role,
   * because that is what makes the join code load-bearing; `learners` is the
   * number the instructor's own card shows them, so the message and the screen
   * agree. Membership is `users.cohort`, not a foreign key, so nothing here
   * cascades and nothing here can be inferred from the cohort row alone.
   */
  /**
   * Every published version this account's projects hold that an enrolment
   * resolves, with the two counts the refusal needs.
   *
   * `learners` is the enrolments that resolve that version and `classes` is the
   * classes those learners sit in (`users.cohort`, not a foreign key), so the
   * sentence and the console agree about the size of what is still being
   * taught. A version nothing resolves is not named: it is the class working
   * the content that makes a withdrawal impossible, not the publication.
   *
   * **The question is "does an enrolment resolve it", not "does a pin name
   * it".** Asking only about `enrollments.projectVersionId` made this guard
   * empty in practice: nothing on the ordinary path writes that column.
   * `writeEnrollment` sets `userId`, `projectSlug`, `currentPhaseOrder` and
   * `packVersion`, and the only writer of the pin anywhere is the cohort
   * importer, so every enrolment through the front door has a null pin, the
   * refusal never fired, and the archive pass below ran unconditionally over
   * every version of the departing owner's projects. An enrolment with a null
   * pin resolves the project by slug and takes the newest published version, so
   * that is the version it is counted under, and a pin into one of this
   * project's versions is counted under that one.
   */
  private async pinnedOwnedVersions(
    manager: EntityManager,
    userId: string,
  ): Promise<{ project: string; version: string; learners: number; classes: number }[]> {
    const projects = await manager.find(ProjectEntity, {
      where: { ownerUserId: userId },
      order: { createdAt: "ASC" },
    });
    const out: { project: string; version: string; learners: number; classes: number }[] = [];
    for (const project of projects) {
      const versions = await manager.find(ProjectVersionEntity, {
        where: { projectId: project.id, status: "published" },
        // Three columns, not the row: `compiled` is the whole compiled pack as
        // `simple-json` (a megabyte of text per version on the shipped pack)
        // and this loop reads an id and a version string. `portability.service`
        // already asks the same question this way.
        select: ["id", "projectId", "version"],
      });
      if (!versions.length) continue;
      // What an enrolment with no pin resolves, which is the same comparison
      // the registry's head resolution makes: field by field as numbers.
      const head = versions
        .slice()
        .sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      const held = await manager.find(EnrollmentEntity, {
        where: [
          { projectSlug: project.slug },
          { projectVersionId: In(versions.map((version) => version.id)) },
        ],
      });
      const byVersion = new Map<string, EnrollmentEntity[]>();
      for (const enrolment of held) {
        const at = versions.some((version) => version.id === enrolment.projectVersionId)
          ? (enrolment.projectVersionId as string)
          : head.id;
        byVersion.set(at, [...(byVersion.get(at) ?? []), enrolment]);
      }
      for (const version of versions) {
        const enrolments = byVersion.get(version.id) ?? [];
        if (!enrolments.length) continue;
        const learners = await manager.find(UserEntity, {
          where: { id: In(enrolments.map((enrolment) => enrolment.userId)) },
        });
        out.push({
          project: project.title,
          version: version.version,
          learners: enrolments.length,
          classes: new Set(learners.map((learner) => learner.cohort)).size,
        });
      }
    }
    return out;
  }

  private async ownedCohorts(
    manager: EntityManager,
    userId: string,
  ): Promise<
    { id: string; name: string; learners: number; occupied: boolean }[]
  > {
    const cohorts = await manager.find(CohortEntity, {
      where: { ownerUserId: userId },
      order: { createdAt: "ASC" },
    });
    const out = [];
    for (const cohort of cohorts) {
      out.push({
        id: cohort.id,
        name: cohort.name,
        learners: await manager.count(UserEntity, {
          where: { cohort: cohort.id, role: "LEARNER" },
        }),
        occupied:
          (await manager.count(UserEntity, {
            where: { cohort: cohort.id, id: Not(userId) },
          })) > 0,
      });
    }
    return out;
  }
}

/**
 * Why the deletion was refused, naming the classes.
 *
 * Reassigning them to an admin was the alternative, and it is the wrong
 * default: it hands a stranger a class the instructor never said they could
 * have, and it happens silently at the moment the person is least likely to be
 * watching. Refusing is honest, it leaves an account the owner asked to close,
 * and it points at the one action that clears the way: an admin moving the
 * class, `PATCH /admin/cohorts/:id/owner`.
 */
export function classesStillOwned(
  classes: { name: string; learners: number }[],
): string {
  const list = classes
    .map((c) =>
      c.learners > 0
        ? `${c.name}, which has ${c.learners} learner${c.learners === 1 ? "" : "s"} in it`
        : `${c.name}, which still has people in it`,
    )
    .join("; ");
  return (
    `this account still owns ${list}. Deleting it would leave the class with no instructor and its ` +
    `join code still working, so ask an admin to move the class to somebody else first.`
  );
}

/**
 * Why the deletion was refused, naming the project, the version and how much of
 * a term is pinned to it.
 *
 * The same shape as the class refusal above, because it is the same kind of
 * fact: what is still held, what deleting it would do, and the one action that
 * clears the way. A version an enrolment resolves cannot be withdrawn: a
 * learner mid-attempt resolves their content from it, by a pin or by being the
 * newest published version of the project they are on, so transferring the
 * project is the honest move rather than silently unpinning a class.
 */
export function projectsStillPinned(
  versions: { project: string; version: string; learners: number; classes: number }[],
): string {
  const plural = (n: number, one: string, many: string): string =>
    `${n} ${n === 1 ? one : many}`;
  const list = versions
    .map(
      (held) =>
        `${held.project} ${held.version}, which ${plural(held.learners, "learner", "learners")} ` +
        `in ${plural(held.classes, "class", "classes")} are enrolled on`,
    )
    .join("; ");
  return (
    `this account still owns ${list}. A version an enrolment is pinned to cannot be withdrawn, ` +
    `so ask an admin to transfer the project to somebody else first.`
  );
}

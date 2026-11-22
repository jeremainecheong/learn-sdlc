import { PasswordWorkService } from '../auth/password-work.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'crypto';
import * as os from 'os';
import { DataSource, EntityManager, FindOptionsWhere, In } from 'typeorm';
import {
  CLASS_NAME_MAX,
  CLASS_NAME_MIN,
  COHORT_EXPORT_FORMAT,
  COHORT_EXPORT_VERSION,
  type CohortExportAuditEvent,
  type CohortExportCounts,
  type CohortExportDocument,
  type CohortExportEnrollment,
  type CohortExportInclude,
  type CohortExportLearner,
  type CohortExportMessage,
  type CohortExportPhase,
  type CohortExportRelease,
  type CohortExportSubmission,
  type CohortExportTask,
  type CohortImportLearnerOutcome,
  type CohortImportResult,
  type CohortView,
  type PhaseStatus,
} from '@learnsdlc/shared';
import type { AuthUser } from '../auth/auth.decorators';
import { AuthService } from '../auth/auth.service';
import { ContentService } from '../content/content.service';
// The cohort import is the fourth writer
// of a phase's status, so it writes through the same roll-up the grader, the
// regrade, the instructor override and `advance` write through. The module is
// pure and structural (no entity, no repository) so reading it here adds no
// dependency this service did not already have through the content catalogue.
import { phaseRollup, type HeldTaskState } from '../feedback/checkers';
import {
  AssistantMessageEntity,
  AuditEventEntity,
  CohortEntity,
  CohortImportEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { recordAudit } from '../audit/audit';
import { UNATTACHED_COHORT } from './cohort-scope';
import { CohortsService } from './cohorts.service';
import { DISPLAY_LOCALE } from '../config/locale';
import { normalisedIso } from '../db/timestamps';
import { isUniqueViolation } from '../db/unique-violation';
import { normaliseEmail } from '../auth/email';
import {
  checkLearners,
  IMPORT_MAX_LEARNERS,
  NOT_YOURS_TO_IMPORT,
  present,
} from './portability-validation';
import { insertChunked } from './portability-chunks';
import {
  enrolmentRefusal,
  installedHead,
  NO_VERSION_HERE,
  pinnedTasks,
  registryHolds,
  versionContent,
  versionWanted,
} from './portability-pinning';

/** Who is importing: the id for ownership, the role for the admin's wider reach. */
type ImportCaller = Pick<AuthUser, 'id' | 'role'>;

const isoOrNow = (value: Date | string | null | undefined): string =>
  normalisedIso(value) ?? new Date().toISOString();

const EMPTY_COUNTS = (): CohortExportCounts => ({
  learners: 0,
  enrollments: 0,
  phaseStates: 0,
  submissions: 0,
  messages: 0,
  releases: 0,
  auditEvents: 0,
});

/**
 * What an import would write, counted before it writes it.
 *
 * `taskStates` is the per-task collection. A receipt is sha-stamped and has to be
 * a true statement about the file it was taken from, so a file carrying
 * `tasks[]` needs a count for them beside the other seven.
 *
 * `CohortExportCounts.taskStates` is optional (a version-2 document carries no
 * task rows and its receipt has to keep reading) and this intersection makes
 * it **required** on the import's own side, because the import always writes
 * the number, including the zero that says this class has never seen an
 * authored task. A blank and a nought are different facts about a receipt.
 */
type ImportCounts = CohortExportCounts & { taskStates: number };

const EMPTY_IMPORT_COUNTS = (): ImportCounts => ({
  ...EMPTY_COUNTS(),
  taskStates: 0,
});

/**
 * One imported phase, with the status **the roll-up** gives it rather than the
 * status the file claimed (teacher-authored projects).
 *
 * Decided in `plan`, for the reason everything else in this service is decided
 * there: a dry run reports what the real call would do, and both of the
 * roll-up's inputs (the destination's pinned task list and the rows the file
 * carries) are known before a row exists. Deciding it here also means the
 * phase state is never written with a status that would have to be corrected,
 * rather than written wrong and repaired inside the same transaction.
 */
interface PlannedPhase {
  source: CohortExportPhase;
  status: PhaseStatus;
  passedAt: string | null;
  /** True when the roll-up did not take the file's word for the status. */
  flattened: boolean;
}

/** One enrolment the import will write, with the version this machine pinned it to. */
interface PlannedEnrollment {
  source: CohortExportEnrollment;
  /**
   * `enrollments.projectVersionId`, resolved here so the write phase has
   * nothing left to decide, and never null. The version the file
   * names when this machine holds it; otherwise this project's installed head,
   * the version a null would have resolved to on the day of the import, by id.
   * A null pin follows every later head, so a teacher's subset head or a new
   * platform version would move the learner between phase sets; the import
   * pins instead, and an enrolment with no version here to pin to stays in the
   * file (`refusedEnrolments`).
   */
  projectVersionId: string;
  /** Its phases, each already judged against the pinned version's task list. */
  phases: PlannedPhase[];
}

/** What the import decided about one learner in the file, before anything is written. */
interface PlannedLearner {
  source: CohortExportLearner;
  email: string;
  outcome: CohortImportLearnerOutcome['outcome'];
  note: string | null;
  /** The account already on this machine, when there is one. */
  existingId: string | null;
  /** Minted here so the write phase has nothing left to decide. */
  newId: string | null;
  /** Set only for an account this import will create, and hashed outside the transaction. */
  passwordHash: string | null;
  /** Projects the learner already has an enrolment on here; their work in the file is not merged. */
  skippedProjects: string[];
  /** Projects this machine does not have; an enrolment on one has nowhere to go. */
  unknownProjects: string[];
  /**
   * Another teacher's projects, which this caller cannot put a class on; an
   * enrolment on one would reach learners of no class it is assigned to.
   */
  unreachableProjects: string[];
  /**
   * Enrolments whose **pinned** version this machine does not have, slug and
   * version, for a sentence that names both. Refused rather than repinned to
   * the head: the version is what graded the work, and a silent move to a
   * version the learner has never seen is the whole reason the pin exists.
   */
  unknownVersions: { slug: string; version: string }[];
  /**
   * Enrolments pinned to this project's installed head because the version
   * their `packVersion` names is not published here: slug, the version the
   * file recorded, and the head's version they were pinned to, for a sentence
   * that names all three.
   *
   * Written rather than refused, and the difference from `unknownVersions` is
   * the difference between a file that *asks* for a version and a file that
   * *records* one, see `versionWanted`. The work is here and reads the
   * version it was pinned to; the note is so nobody has to infer that from an
   * id.
   */
  unpinnedVersions: { slug: string; version: string; pinnedTo: string }[];
  /**
   * Enrolments left in the file, whole, because they could not be held to the
   * version they would be pinned to: a phase key that
   * version lacks, an order that disagrees with it, or no published version of
   * the project here at all. Slug and the sentence that says which.
   *
   * Refused rather than repaired: the import writes the file's orders and
   * attaches its releases by order, and the board matches states by order, so
   * an enrolment whose orders are another version's would be read against the
   * wrong phases.
   */
  refusedEnrolments: { slug: string; sentence: string }[];
  /**
   * Phases the one roll-up **shut**, in the file's own addressing.
   *
   * The same shape `unknownVersions` and `unpinnedVersions` above have, and for
   * the same reason: a file that says `passed` over work the destination's
   * pinned version has no passing record of imports shut, and an instructor who
   * is not told that would see a phase go backwards for no stated cause. It is
   * also what the sha-stamped receipt's own row records.
   */
  flattenedPhases: MovedPhase[];
  /**
   * Phases the one roll-up **opened**, the other direction of the same call.
   *
   * Kept apart from `flattenedPhases` because the two are not one fact told
   * twice: the roll-up opens a phase the file recorded shut whenever every
   * required key of the destination's pinned version has a passing row; the
   * state the roll-up race can leave on the source deployment, and the reason
   * `advance` carries a heal for it. Filed together, every one of those would
   * be reported to the teacher, and stamped on the receipt, with the sentence
   * for the opposite direction.
   */
  openedPhases: MovedPhase[];
  enrollments: PlannedEnrollment[];
}

/** One phase the roll-up moved, in the file's own addressing, either way. */
interface MovedPhase {
  ref: string;
  slug: string;
  phaseKey: string;
  from: PhaseStatus;
  to: PhaseStatus;
}

interface ImportPlan {
  learners: PlannedLearner[];
  counts: ImportCounts;
  createdAccounts: string[];
  alreadyImportedAt: string | null;
}

export interface ImportOptions {
  dryRun?: boolean;
  /** Import a file this machine has already imported, making a second copy of the class. */
  force?: boolean;
  /** The bytes as they arrived, when the caller has them; the sha is taken of these. */
  raw?: Buffer;
}

/**
 * A class as one file, in both directions.
 *
 * The export removes every id: a learner is `l1`, their first enrolment
 * `l1/e1`, its third phase `l1/e1/p3`. Nothing in the file can collide with a
 * row on the machine that reads it, there is no remap table to keep straight,
 * and the file stays readable by a person, which matters, because it is also
 * the only copy the target machine will ever have of the source machine's
 * audit trail.
 *
 * The import always makes a *new* class. It never merges into an existing
 * cohort, which removes the whole family of "which side wins" questions, and a
 * learner who already has an enrolment on a project keeps theirs rather than
 * having two phase-state sets reconciled behind their back.
 */
@Injectable()
export class PortabilityService {
  private readonly logger = new Logger(PortabilityService.name);

  /**
   * Content and auth are optional so a spec can drive the data path on a bare
   * DataSource; in the running app Nest supplies both. Without content the
   * export simply carries no pack versions, and without auth a learner moved
   * into an imported class picks up their new cohort when the guard's session
   * cache expires rather than on the next request.
   */
  constructor(
    private readonly passwords: PasswordWorkService,
    private readonly dataSource: DataSource,
    private readonly cohorts: CohortsService,
    @Optional() private readonly content?: ContentService,
    @Optional() private readonly auth?: AuthService,
  ) {}

  /* ------------------------------- export -------------------------------- */

  /**
   * One class and its submitted learning evidence as one document.
   *
   * Every object here is built field by field. A spread of a loaded entity
   * would carry whatever column is next added to `users` into the file the
   * moment it is added, and a leak in an export is silent: nobody sees the
   * field they did not mean to send. `portability.service.spec.ts` asserts on
   * the serialised text for the same reason.
   */
  async exportCohort(
    caller: Pick<AuthUser, 'id' | 'role'>,
    cohortId: string,
    includes: CohortExportInclude[] = [],
  ): Promise<CohortExportDocument> {
    const manager = this.dataSource.manager;
    const cohort = await manager.findOne(CohortEntity, {
      where: { id: cohortId },
    });
    // A 404 rather than a 403: guessing ids tells a second instructor nothing
    // about which classes exist on this machine.
    if (
      !cohort ||
      (caller.role !== 'ADMIN' && cohort.ownerUserId !== caller.id)
    ) {
      throw new NotFoundException('no class with that id in your classes');
    }
    const actor = await manager.findOne(UserEntity, {
      where: { id: caller.id },
    });
    if (!actor) throw new NotFoundException('account not found');

    includes = includes.filter((value) => value !== 'messages');
    const wantsSnapshots = includes.includes('snapshots');
    // Private conversations are never part of a teacher's class export.
    const wantsMessages = false;

    const learnerRows = await manager.find(UserEntity, {
      where: { cohort: cohortId, role: 'LEARNER' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const learnerIds = learnerRows.map((row) => row.id);

    // Five reads for the whole class rather than five per learner: a console
    // page that fans out over thirty people is the one place this product has
    // repeatedly paid for N+1.
    const enrollments = learnerIds.length
      ? await manager.find(EnrollmentEntity, {
          where: { userId: In(learnerIds) },
          order: { startedAt: 'ASC', id: 'ASC' },
        })
      : [];
    const enrollmentIds = enrollments.map((row) => row.id);
    const phaseStates = enrollmentIds.length
      ? await manager.find(PhaseStateEntity, {
          where: { enrollmentId: In(enrollmentIds) },
          order: { phaseOrder: 'ASC' },
        })
      : [];
    const phaseStateIds = phaseStates.map((row) => row.id);
    const submissions = phaseStateIds.length
      ? await manager.find(SubmissionEntity, {
          where: { phaseStateId: In(phaseStateIds) },
          order: { createdAt: 'ASC', id: 'ASC' },
        })
      : [];
    // One more read for the whole class,
    // beside the five above it. A class that has never seen an authored task
    // holds no rows at all (a sole task has none, ever), so this costs the
    // shipped project one empty query and every exported phase an empty array.
    const taskStates = phaseStateIds.length
      ? await manager.find(TaskStateEntity, {
          where: { phaseStateId: In(phaseStateIds) },
          order: { taskKey: 'ASC' },
        })
      : [];
    const messages: AssistantMessageEntity[] = [];
    const releases = enrollmentIds.length
      ? await manager.find(ReleaseRecordEntity, {
          where: { enrollmentId: In(enrollmentIds) },
          order: { phaseOrder: 'ASC' },
        })
      : [];

    // The pin, as a string. An export carries no ids, so the version an
    // enrolment is pinned to travels as the version *string* and the
    // destination resolves it against its own published versions of the same
    // slug. One read for the class, like the five above it.
    const pinnedVersionIds = [
      ...new Set(
        enrollments
          .map((row) => row.projectVersionId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const versionById = new Map<string, string>(
      pinnedVersionIds.length
        ? (
            await manager.find(ProjectVersionEntity, {
              where: { id: In(pinnedVersionIds) },
              select: ['id', 'version'],
            })
          ).map((row) => [row.id, row.version] as [string, string])
        : [],
    );

    const byUser = group(enrollments, (row) => row.userId);
    const byEnrollment = group(phaseStates, (row) => row.enrollmentId);
    const releasesByEnrollment = group(releases, (row) => row.enrollmentId);
    const submissionsByPhase = group(submissions, (row) => row.phaseStateId);
    const tasksByPhase = group(taskStates, (row) => row.phaseStateId);
    const messagesByPhase = group(messages, (row) => row.phaseStateId);

    const counts = EMPTY_COUNTS();
    const refByUserId = new Map<string, string>();
    const projectSlugs = new Set<string>();

    const learners: CohortExportLearner[] = learnerRows.map(
      (learner, learnerIndex) => {
        const learnerRef = `l${learnerIndex + 1}`;
        refByUserId.set(learner.id, learnerRef);
        counts.learners += 1;

        const learnerEnrollments = (byUser.get(learner.id) ?? []).map(
          (enrollment, enrollmentIndex) => {
            const enrollmentRef = `${learnerRef}/e${enrollmentIndex + 1}`;
            counts.enrollments += 1;
            projectSlugs.add(enrollment.projectSlug);

            const phases: CohortExportPhase[] = (
              byEnrollment.get(enrollment.id) ?? []
            ).map((phase) => {
              const phaseRef = `${enrollmentRef}/p${phase.phaseOrder}`;
              counts.phaseStates += 1;

              const submitted = submissionsByPhase.get(phase.id) ?? [];
              const latest = submitted[submitted.length - 1];
              const release = (
                releasesByEnrollment.get(enrollment.id) ?? []
              ).find((row) => row.phaseStateId === phase.id);
              const phaseSubmissions: CohortExportSubmission[] = submitted.map(
                (submission, submissionIndex) => {
                  counts.submissions += 1;
                  return {
                    ref: `${phaseRef}/s${submissionIndex + 1}`,
                    // `''` for every revision of a sole-task phase, which is
                    // every revision the shipped project has ever taken.
                    taskKey: submission.taskKey,
                    status: submission.status,
                    score: submission.score,
                    passed: submission.passed,
                    report: submission.report,
                    packVersion: submission.packVersion,
                    error: submission.error,
                    createdAt: isoOrNow(submission.createdAt),
                    // 247 MB per fifty-learner class, and a verdict is readable
                    // without them; asked for by name or not carried at all.
                    snapshot: wantsSnapshots
                      ? submission.workspaceSnapshot
                      : null,
                    // The run this revision belongs to.
                    resetEpoch: submission.resetEpoch ?? null,
                  };
                },
              );

              // Field by field, and deliberately **no `signedOffBy`**: an
              // export carries no ids, and a teacher's id is not the learner's
              // to carry. `countersigned` is the fact without the person, and
              // the destination writes its own operator against it.
              const phaseTasks: CohortExportTask[] = (
                tasksByPhase.get(phase.id) ?? []
              ).map((task) => ({
                taskKey: task.taskKey,
                status: task.status,
                bestScore: task.bestScore,
                attempts: task.attempts,
                ranBeforeSubmit: task.ranBeforeSubmit,
                passedAt: task.passedAt,
                solutionReadAt: task.solutionReadAt,
                awaitingSignOff: task.awaitingSignOff,
                signedOffAt: task.signedOffAt,
                resetAt: task.resetAt,
                resetCount: task.resetCount,
                countersigned: Boolean(task.signedOffBy),
              }));

              const phaseMessages: CohortExportMessage[] = (
                messagesByPhase.get(phase.id) ?? []
              ).map((message) => {
                counts.messages += 1;
                const view: CohortExportMessage = {
                  role: message.role,
                  phaseKey: message.phaseKey,
                  createdAt: isoOrNow(message.createdAt),
                  provider: message.provider,
                  cached: message.cached,
                  redacted: message.redacted,
                  scopeRedirected: message.scopeRedirected,
                  tokensIn: message.tokensIn,
                  tokensOut: message.tokensOut,
                };
                // The count is what the reliance index is built from and has to
                // travel; the text is the most personal thing in the file, so
                // moving it is a deliberate act recorded in the audit row.
                if (wantsMessages) view.content = message.content;
                return view;
              });

              return {
                ref: phaseRef,
                phaseKey: phase.phaseKey,
                phaseOrder: phase.phaseOrder,
                status: phase.status,
                bestScore: phase.bestScore,
                attempts: phase.attempts,
                // A class export never transfers work the learner has not submitted.
                reflection: release?.notes ?? null,
                workspace: latest?.workspaceSnapshot ?? null,
                links: latest?.contextSnapshot?.links ?? [],
                drill: latest?.contextSnapshot?.drill ?? null,
                ranBeforeSubmit:
                  latest?.contextSnapshot?.ranBeforeSubmit ?? false,
                unlockedAt: phase.unlockedAt,
                passedAt: phase.passedAt,
                tasks: phaseTasks,
                submissions: phaseSubmissions,
                messages: phaseMessages,
              };
            });

            const enrollmentReleases: CohortExportRelease[] = (
              releasesByEnrollment.get(enrollment.id) ?? []
            ).map((release) => {
              counts.releases += 1;
              return {
                phaseKey: release.phaseKey,
                phaseOrder: release.phaseOrder,
                version: release.version,
                score: release.score,
                notes: release.notes,
                createdAt: isoOrNow(release.createdAt),
              };
            });

            return {
              ref: enrollmentRef,
              projectSlug: enrollment.projectSlug,
              packVersion: enrollment.packVersion,
              // Null rather than the head when nothing is pinned: a file that
              // named the reader's own head would put every legacy enrolment on
              // it for ever, which is the defect the field exists to close.
              projectVersion: enrollment.projectVersionId
                ? (versionById.get(enrollment.projectVersionId) ?? null)
                : null,
              currentPhaseOrder: enrollment.currentPhaseOrder,
              completed: enrollment.completed,
              startedAt: isoOrNow(enrollment.startedAt),
              completedAt: enrollment.completedAt,
              phases,
              releases: enrollmentReleases,
            };
          },
        );

        return {
          ref: learnerRef,
          email: learner.email,
          displayName: learner.displayName,
          dailyTokenBudget: learner.dailyTokenBudget,
          createdAt: isoOrNow(learner.createdAt),
          enrollments: learnerEnrollments,
        };
      },
    );

    const auditEvents = await this.exportAudit(
      manager,
      cohortId,
      learnerIds,
      refByUserId,
    );
    counts.auditEvents = auditEvents.length;

    const document: CohortExportDocument = {
      format: COHORT_EXPORT_FORMAT,
      formatVersion: COHORT_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: { email: actor.email, displayName: actor.displayName },
      source: {
        host: os.hostname() || null,
        schemaHead: await this.schemaHead(manager),
        packVersions: this.packVersions(projectSlugs),
      },
      includes: [...includes],
      cohort: { name: cohort.name, createdAt: isoOrNow(cohort.createdAt) },
      learners,
      auditEvents,
      counts,
    };

    // The action is the includes, because "who took the transcripts off this
    // machine" is the question this row exists to answer.
    await recordAudit(manager, {
      event: 'cohort.export',
      actorUserId: caller.id,
      subjectUserId: caller.id,
      targetId: cohortId,
      action: includes.length ? includes.join(', ') : 'verdicts only',
      detail: {
        learners: counts.learners,
        submissions: counts.submissions,
        includes,
        bytes: Buffer.byteLength(JSON.stringify(document), 'utf8'),
      },
    });
    this.logger.log(
      `cohort ${cohortId} exported by ${caller.id}: ${counts.learners} learners, includes=${
        includes.join('+') || 'none'
      }`,
    );
    return document;
  }

  /**
   * The source machine's trail, for reading rather than replay. Rows about a
   * learner in the class, and rows about the class itself; a subject who is not
   * in the class keeps their row but loses their name to a null ref.
   */
  private async exportAudit(
    manager: EntityManager,
    cohortId: string,
    learnerIds: string[],
    refByUserId: Map<string, string>,
  ): Promise<CohortExportAuditEvent[]> {
    const where: FindOptionsWhere<AuditEventEntity>[] = [
      { targetId: cohortId },
    ];
    if (learnerIds.length) where.push({ subjectUserId: In(learnerIds) });
    const rows = await manager.find(AuditEventEntity, {
      where,
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const actorIds = [...new Set(rows.map((row) => row.actorUserId))].filter(
      Boolean,
    );
    const actors = actorIds.length
      ? await manager.find(UserEntity, {
          where: { id: In(actorIds) },
          select: ['id', 'displayName'],
        })
      : [];
    const names = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    return rows.map((row) => ({
      event: row.event,
      // A name, never an id: an id from another machine names nobody here.
      actorName: names.get(row.actorUserId) ?? null,
      subjectRef:
        (row.subjectUserId && refByUserId.get(row.subjectUserId)) || null,
      action: row.action,
      reason: row.reason,
      detail: row.detail,
      createdAt: isoOrNow(row.createdAt),
    }));
  }

  /**
   * The migration this database is on, by name. Compared on the timestamp it
   * carries rather than on the class name, and null on a database whose schema
   * was synced rather than migrated, which is every unit spec.
   */
  private async schemaHead(manager: EntityManager): Promise<string | null> {
    try {
      const rows = await manager.query(
        `SELECT name FROM learnsdlc_migrations ORDER BY timestamp DESC LIMIT 1`,
      );
      return rows?.[0]?.name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The pack version each project is on here. The database carries the version
   * a verdict was graded against but not the pack itself, so this is what lets
   * the other machine notice it is about to grade against different content.
   */
  private packVersions(slugs: Set<string>): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const project of this.content?.listProjects() ?? []) {
      if (slugs.has(project.slug)) versions[project.slug] = project.version;
    }
    return versions;
  }

  /* ------------------------------- import -------------------------------- */

  /**
   * Bring a class in, or say what bringing it in would do.
   *
   * A dry run is the feature: an import cannot be undone, so the instructor
   * gets the whole outcome (every learner, every skipped project, every count)
   * before anything is written. It takes exactly the same path as the real
   * thing up to the point of writing, so what it reports is what would happen
   * rather than a second implementation's guess at it.
   */
  async importCohort(
    caller: ImportCaller,
    body: unknown,
    options: ImportOptions = {},
  ): Promise<CohortImportResult> {
    // Before the file is read, and before a dry run rehearses anything: every
    // question the roll-up asks about an imported phase goes through the
    // catalogue, so an import that cannot ask it cannot judge a phase that
    // arrives `passed`.
    const content = this.requireContent();
    const document = this.readDocument(body);
    const raw = options.raw ?? Buffer.from(JSON.stringify(document), 'utf8');
    const sha = createHash('sha256').update(raw).digest('hex');
    const manager = this.dataSource.manager;

    const seenBefore = await manager.findOne(CohortImportEntity, {
      where: { documentSha256: sha },
      order: { createdAt: 'DESC' },
    });
    const alreadyImportedAt = seenBefore
      ? isoOrNow(seenBefore.createdAt)
      : null;
    if (seenBefore && !options.dryRun && !options.force) {
      const held = seenBefore.counts?.learners ?? 0;
      throw new ConflictException(
        `This file was imported on ${readableDate(alreadyImportedAt)} as ${document.cohort.name}, ` +
          `with ${held} learner${held === 1 ? '' : 's'}. Import it again to make a second copy.`,
      );
    }

    const plan = await this.plan(
      manager,
      caller,
      document,
      alreadyImportedAt,
      !options.dryRun,
      content,
    );
    const source = {
      host: document.source?.host ?? null,
      exportedAt: document.exportedAt ?? null,
      name: document.cohort.name,
    };

    if (options.dryRun) {
      // A dry run reads, per address, whether an account is here, and that
      // is a question worth a row in the trail even though nothing is
      // written: the same event as the import, marked as the rehearsal.
      await recordAudit(manager, {
        event: 'cohort.import',
        actorUserId: caller.id,
        subjectUserId: caller.id,
        action: document.cohort.name,
        reason: 'A dry run: nothing was written.',
        detail: {
          dryRun: true,
          sha256: sha,
          addresses: document.learners.length,
          host: source.host,
        },
      });
      return {
        applied: false,
        cohort: null,
        source,
        includes: document.includes ?? [],
        learners: plan.learners.map(outcomeOf),
        written: plan.counts,
        createdAccounts: plan.createdAccounts,
        alreadyImportedAt,
      };
    }

    const cohort = await this.write(document, plan, caller.id, sha, raw.length);
    // The guard hands controllers the cohort off a cached row, so a learner
    // moved into the new class would otherwise be read under their old one.
    for (const learner of plan.learners) {
      if (learner.outcome === 'matched' && learner.existingId) {
        this.auth?.forgetSession(learner.existingId);
      }
    }
    this.logger.log(
      `cohort ${cohort.id} imported by ${caller.id} from ${source.host ?? 'an unnamed machine'}: ` +
        `${plan.counts.learners} learners, ${plan.createdAccounts.length} new accounts`,
    );
    return {
      applied: true,
      cohort,
      source,
      includes: document.includes ?? [],
      learners: plan.learners.map(outcomeOf),
      written: plan.counts,
      createdAccounts: plan.createdAccounts,
      alreadyImportedAt,
    };
  }

  /**
   * The catalogue, or the refusal that says why this machine cannot import.
   *
   * `content` is optional on this service so a spec can drive the **export**
   * path on a bare DataSource, and the deployed module always resolves it, so
   * this is a guard rather than a live defect. It is a guard worth having all
   * the same: without it, an import on a service holding no catalogue would
   * simply not reconcile, and a file claiming `passed` would land open over
   * zero task rows; the same failure the roll-up exists to prevent, reached
   * by a third route. An import is a deliberate operator act that can be
   * retried on a machine with its content loaded, and a doubt reads shut.
   */
  private requireContent(): ContentService {
    if (!this.content) {
      throw new BadRequestException(
        'That file was not imported. This machine has no project content loaded, so an imported phase cannot be judged ' +
          'against the tasks its project asks for. Start the API with its content and import the file again.',
      );
    }
    return this.content;
  }

  /**
   * What the one roll-up says an imported phase is, whatever the file said
   * (teacher-authored projects).
   *
   * **There is no predicate on the file's shape.** It runs for every imported
   * phase, because the failure is not a file that carries no `tasks[]`; it is
   * a file that carries a non-empty array naming keys the destination's pinned
   * version does not declare, which is the *common* case: a version id is
   * minted per deployment, so a moved cohort's pin resolves to null and falls
   * to the destination's head, and every phase of every teacher-authored head
   * declares an authored task. Taking the file's word there would write
   * `passed` over zero required rows, stickiness would cement it, and `advance`
   * would refuse for ever with the phase green on the map.
   *
   * Two properties of the call are load-bearing:
   *
   * - **The file's claim is the verdict, never a held fact.** `phaseRollup`
   *   keeps a phase that is already `passed` passed (that is the stickiness
   *   every other writer needs) so handing it the file's own word as `held`
   *   would make the claim its own evidence and the quantifier would never run.
   *   The claim goes in as the verdict; `held` is what the phase is before it.
   * - **The roll-up decides whether the phase opens, not what it is called
   *   otherwise.** `nextPhaseStatus` has three answers and none of them is
   *   `in_progress`: it was written for a verdict, and a verdict means
   *   something was handed in. So a phase the file did not claim keeps the word
   *   the file gave it, and only a claim of `passed` is re-judged.
   */
  private reconciledPhase(
    content: ContentService,
    pin: { projectSlug: string; projectVersionId: string | null },
    phase: CohortExportPhase,
    importedAt: string,
  ): { status: PhaseStatus; passedAt: string | null } {
    const claimed = phase.status === 'passed';
    const tasks = pinnedTasks(content, pin, phase.phaseKey);
    // A phase the pinned version does not declare, or a version this build
    // cannot grade: there is nothing to evidence the claim against, and a
    // doubt reads shut.
    if (!tasks) {
      return { status: claimed ? 'submitted' : phase.status, passedAt: null };
    }
    const rows: HeldTaskState[] = (phase.tasks ?? []).map((task) => ({
      taskKey: task.taskKey,
      status: task.status,
      passedAt: task.passedAt ?? null,
      bestScore: task.bestScore ?? null,
    }));
    const roll = phaseRollup(
      {
        status: claimed ? 'in_progress' : phase.status,
        passedAt: null,
        bestScore: phase.bestScore ?? null,
      },
      tasks,
      rows,
      { passed: claimed, overall: phase.bestScore ?? 0 },
      // The moment the work passed on the machine that exported it, where the
      // file carries one. An import is not a pass, so it does not stamp itself
      // as the day a learner earned the phase.
      phase.passedAt ?? importedAt,
    );
    const status =
      roll.status === 'passed' || claimed ? roll.status : phase.status;
    return { status, passedAt: status === 'passed' ? roll.passedAt : null };
  }

  /** Is this a class export at all, and one this build can read? */
  private readDocument(body: unknown): CohortExportDocument {
    const document = body as CohortExportDocument | null;
    if (
      !document ||
      typeof document !== 'object' ||
      document.format !== COHORT_EXPORT_FORMAT
    ) {
      throw new BadRequestException(
        `That file is not a class export. A class export starts with "format": "${COHORT_EXPORT_FORMAT}".`,
      );
    }
    if (Number(document.formatVersion) > COHORT_EXPORT_VERSION) {
      throw new BadRequestException(
        'This file was written by a newer version of LearnSDLC. Upgrade this machine and import it again.',
      );
    }
    if (
      !document.cohort ||
      typeof document.cohort.name !== 'string' ||
      !document.cohort.name.trim()
    ) {
      throw new BadRequestException(
        'That file has no class name in it, so there is nothing to make here.',
      );
    }
    if (!Array.isArray(document.learners)) {
      throw new BadRequestException('That file has no learners in it.');
    }
    const name = document.cohort.name.trim();
    if (name.length < CLASS_NAME_MIN || name.length > CLASS_NAME_MAX) {
      throw new BadRequestException(
        `That file's class name is ${name.length} characters; a class name is between ${CLASS_NAME_MIN} and ${CLASS_NAME_MAX}.`,
      );
    }
    if (document.learners.length > IMPORT_MAX_LEARNERS) {
      throw new BadRequestException(
        `That file names ${document.learners.length} learners. An import takes up to ${IMPORT_MAX_LEARNERS}; ` +
          'split the class and import each part.',
      );
    }
    checkLearners(document.learners);
    return document;
  }

  /**
   * What the import would do, decided before a single row is written. The
   * expensive part (the one bcrypt an import with new accounts costs)
   * happens here, outside the transaction, so it never holds the sqlite
   * write lock.
   *
   * Who an import may move: an account is matched by address, and a match
   * is moved into the new class only when the caller could already see them
   * (a learner in no class, or in a class the caller owns) or when the
   * caller is an admin. Any other account is reported skipped. Without that
   * rule a hand-written file naming a learner's address would be a way for
   * one instructor to pull a learner out of another's class and read their
   * transcript through every scoped route.
   */
  private async plan(
    manager: EntityManager,
    caller: ImportCaller,
    document: CohortExportDocument,
    alreadyImportedAt: string | null,
    willWrite: boolean,
    content: ContentService,
  ): Promise<ImportPlan> {
    const counts = EMPTY_IMPORT_COUNTS();
    const learners: PlannedLearner[] = [];
    const createdAccounts: string[] = [];
    // One moment for the whole file, so two phases of one enrolment that the
    // roll-up opens are not stamped a millisecond apart.
    const importedAt = new Date().toISOString();

    const owned =
      caller.role === 'ADMIN'
        ? null
        : new Set(
            (
              await manager.find(CohortEntity, {
                where: { ownerUserId: caller.id },
                select: ['id'],
              })
            ).map((cohort) => cohort.id),
          );
    const mayClaim = (user: UserEntity): boolean =>
      user.role === 'LEARNER' &&
      (owned === null ||
        user.cohort === UNATTACHED_COHORT ||
        owned.has(user.cohort));
    // Always a catalogue: `importCohort` refuses by name before it gets here
    // on a machine that holds none, so there is no arm where every project is
    // taken as known.
    const known = new Set(content.listProjects().map((p) => p.slug));
    // A teacher's project reaches only learners of a class it is assigned to,
    // and this caller can assign exactly what `CohortProjectService.inReach`
    // lets them: the platform's projects and their own, or anything for an
    // admin. An enrolment on any other teacher's project stays in the file;
    // written here, it would pin a learner (an unattached one pulled in by
    // address included) to a project none of their classes is on.
    const outOfReach =
      caller.role === 'ADMIN' || known.size === 0
        ? new Set<string>()
        : new Set(
            (
              await manager.find(ProjectEntity, {
                where: { slug: In([...known]), platformOwned: false },
                select: ['id', 'slug', 'ownerUserId'],
              })
            )
              .filter((project) => project.ownerUserId !== caller.id)
              .map((project) => project.slug),
          );
    // This machine's own published versions of the projects the file names, so
    // the pin each enrolment carries resolves to a row here rather than to an
    // id from a machine the reader has never heard of.
    const versions = await this.publishedVersions(
      manager,
      new Set(
        document.learners.flatMap((learner) =>
          (Array.isArray(learner.enrollments) ? learner.enrollments : []).map(
            (enrollment) => enrollment.projectSlug,
          ),
        ),
      ),
    );

    // One hash for every account this import mints. The plaintext is 32 random
    // bytes that are discarded, so no password anybody can type produces the
    // hash and sharing it between the new rows gives nobody a way in; what it
    // saves is a cost-12 bcrypt per address in the file, which would be a
    // quarter of a second of CPU per line with no ceiling on the lines.
    let placeholderHash: string | null = null;

    const emails = document.learners.map((learner) =>
      normaliseEmail(learner.email),
    );
    const existing = emails.length
      ? await manager.find(UserEntity, {
          where: { email: In([...new Set(emails)].filter(Boolean)) },
        })
      : [];
    const byEmail = new Map(
      existing.map((user) => [normaliseEmail(user.email), user]),
    );

    const matchedIds = existing.map((user) => user.id);
    const heldEnrollments = matchedIds.length
      ? await manager.find(EnrollmentEntity, {
          where: { userId: In(matchedIds) },
          select: ['userId', 'projectSlug'],
        })
      : [];
    const held = new Set(
      heldEnrollments.map((row) => `${row.userId}:${row.projectSlug}`),
    );

    const seenEmails = new Set<string>();
    for (const source of document.learners) {
      const email = normaliseEmail(source.email);
      const enrollments = Array.isArray(source.enrollments)
        ? source.enrollments
        : [];
      const base: PlannedLearner = {
        source,
        email,
        outcome: 'skipped',
        note: null,
        existingId: null,
        newId: null,
        passwordHash: null,
        skippedProjects: [],
        unknownProjects: [],
        unreachableProjects: [],
        unknownVersions: [],
        unpinnedVersions: [],
        refusedEnrolments: [],
        flattenedPhases: [],
        openedPhases: [],
        enrollments: [],
      };

      if (!email) {
        learners.push({
          ...base,
          note: 'This entry has no email address, so there is nobody to import.',
        });
        continue;
      }
      if (seenEmails.has(email)) {
        learners.push({
          ...base,
          note: 'This address appears twice in the file; only the first was read.',
        });
        continue;
      }
      seenEmails.add(email);

      const match = byEmail.get(email);
      if (match && !mayClaim(match)) {
        learners.push({ ...base, note: NOT_YOURS_TO_IMPORT });
        continue;
      }

      const planned: PlannedLearner = {
        ...base,
        skippedProjects: [],
        unknownProjects: [],
        unreachableProjects: [],
        unknownVersions: [],
        unpinnedVersions: [],
        refusedEnrolments: [],
        flattenedPhases: [],
        openedPhases: [],
        enrollments: [],
      };
      if (match) {
        planned.outcome = 'matched';
        planned.existingId = match.id;
      } else {
        planned.outcome = 'created';
        planned.newId = randomUUID();
        createdAccounts.push(email);
        // Enabled rather than disabled: the guard refuses a disabled account,
        // and the only way into an imported account is the recovery link,
        // which the person has to be able to use.
        if (willWrite) {
          placeholderHash ??= await this.passwords.hash(randomBytes(32).toString('hex'));
          planned.passwordHash = placeholderHash;
        }
      }
      for (const enrollment of enrollments) {
        const heldVersions = versions.get(enrollment.projectSlug);
        const wanted = versionWanted(enrollment);
        // Null when this machine does not hold the version: not published
        // here, or published with no compiled snapshot, which the registry
        // skips (a pin to that row would read whatever the head is at the
        // time, the null pin's harm under another id). The pin is then this
        // project's installed head, decided below once the enrolment is one
        // this import may write.
        const row =
          (wanted.version && heldVersions?.get(wanted.version)) || null;
        const named =
          row && registryHolds(content, enrollment.projectSlug, row)
            ? row
            : null;
        // A machine holding no published version of the project is in no
        // position to say anything about a version of it, either way.
        const canSpeak = Boolean(heldVersions && wanted.version && !named);
        if (!known.has(enrollment.projectSlug)) {
          // Skipped and said, rather than written: an enrolment on a project
          // this machine does not have would make every console page for the
          // learner a 404.
          planned.unknownProjects.push(enrollment.projectSlug);
        } else if (outOfReach.has(enrollment.projectSlug)) {
          planned.unreachableProjects.push(enrollment.projectSlug);
        } else if (match && held.has(`${match.id}:${enrollment.projectSlug}`)) {
          planned.skippedProjects.push(enrollment.projectSlug);
        } else if (canSpeak && wanted.explicit) {
          // The same treatment an unknown slug gets, one level down: this
          // machine has the project and not the version of it the file asks
          // to be pinned to, so there is nothing honest to pin the work to.
          // Only an **ask** reaches here; a `packVersion` that resolves to
          // nothing is provenance the reader cannot match, not a request it
          // must refuse, and refusing on it would discard the work.
          planned.unknownVersions.push({
            slug: enrollment.projectSlug,
            version: wanted.version as string,
          });
        } else {
          // The version it is pinned to: the one it names, else the head this
          // machine's registry installed (a published row with a compiled
          // snapshot, never the newest of `heldVersions`, which counts rows
          // the registry skips), never null.
          const resolved =
            named ?? installedHead(content, enrollment.projectSlug);
          const version = resolved
            ? versionContent(content, enrollment.projectSlug, resolved)
            : null;
          const refusal =
            resolved && version
              ? enrolmentRefusal(enrollment, version)
              : NO_VERSION_HERE;
          if (!resolved || !version || refusal) {
            planned.refusedEnrolments.push({
              slug: enrollment.projectSlug,
              sentence: refusal ?? NO_VERSION_HERE,
            });
            continue;
          }
          // An ask this machine could not honour, with the head it got.
          if (wanted.version && !named) {
            planned.unpinnedVersions.push({
              slug: enrollment.projectSlug,
              version: wanted.version as string,
              pinnedTo: version.version,
            });
          }
          planned.enrollments.push({
            source: enrollment,
            projectVersionId: resolved,
            // Every phase, with no predicate on what the file carried for it.
            phases: (enrollment.phases ?? []).map((phase) => {
              const decided = this.reconciledPhase(
                content,
                {
                  projectSlug: enrollment.projectSlug,
                  projectVersionId: resolved,
                },
                phase,
                importedAt,
              );
              const flattened = decided.status !== phase.status;
              if (flattened) {
                const moved: MovedPhase = {
                  ref: phase.ref,
                  slug: enrollment.projectSlug,
                  phaseKey: phase.phaseKey,
                  from: phase.status,
                  to: decided.status,
                };
                // The roll-up moves a phase in exactly two directions (it
                // shuts a claim of `passed` it cannot evidence, and it opens a
                // phase the file recorded shut whose every required key has a
                // passing row) and the teacher is told which one happened.
                // One list for both put an opened phase under the sentence for
                // a shut one, which is the opposite of what the import did.
                if (decided.status === 'passed') {
                  planned.openedPhases.push(moved);
                } else {
                  planned.flattenedPhases.push(moved);
                }
              }
              return { source: phase, ...decided, flattened };
            }),
          });
        }
      }

      counts.learners += 1;
      for (const { source: enrollment, phases } of planned.enrollments) {
        counts.enrollments += 1;
        for (const { source: phase } of phases) {
          counts.phaseStates += 1;
          counts.taskStates += (phase.tasks ?? []).length;
          counts.submissions += (phase.submissions ?? []).length;
          counts.messages += (phase.messages ?? []).length;
        }
        counts.releases += (enrollment.releases ?? []).length;
      }
      learners.push(planned);
    }

    // Zero on purpose, and reported so nobody has to guess: the source's trail
    // is kept on the import row, verbatim, and never becomes rows here.
    counts.auditEvents = 0;
    return { learners, counts, createdAccounts, alreadyImportedAt };
  }

  /**
   * This machine's published versions of the projects a file names:
   * slug → version string → `project_versions.id`.
   *
   * A project with no published version here is **absent** from the map rather
   * than present and empty, and the two are different. A machine that holds
   * no published version of a project is in no position to say it lacks the
   * one the file names, and has no version to pin the work to either, so the
   * caller leaves such an enrolment in the file with the sentence that says so
   * (`NO_VERSION_HERE`). A machine that *does* hold published versions of a
   * project is in a position to say that it does not hold the one the file
   * names, and the caller says so.
   *
   * These rows answer only "does this machine hold the version the file
   * names". The pin for a file that names none here is the registry's
   * installed head (`installedHead`), never the newest of these rows: a
   * published row with no compiled snapshot is one the registry skips.
   *
   * Two reads for the whole file, not one per enrolment.
   */
  private async publishedVersions(
    manager: EntityManager,
    slugs: Set<string>,
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    if (!slugs.size) return out;
    const projects = await manager.find(ProjectEntity, {
      where: { slug: In([...slugs]) },
      select: ['id', 'slug'],
    });
    if (!projects.length) return out;
    const slugById = new Map(projects.map((row) => [row.id, row.slug]));
    const rows = await manager.find(ProjectVersionEntity, {
      where: {
        projectId: In(projects.map((row) => row.id)),
        status: 'published',
      },
      select: ['id', 'projectId', 'version'],
    });
    for (const row of rows) {
      const slug = slugById.get(row.projectId);
      if (!slug) continue;
      const bucket = out.get(slug) ?? new Map<string, string>();
      bucket.set(row.version, row.id);
      out.set(slug, bucket);
    }
    return out;
  }

  /**
   * The write, as one transaction. A throw anywhere in it (a hand-edited file
   * with two enrolments on one project, a disk that fills, an address someone
   * registers while the import is running) leaves the database exactly as it
   * was, which is the only acceptable behaviour for an operation nobody can
   * undo.
   */
  private async write(
    document: CohortExportDocument,
    plan: ImportPlan,
    actorUserId: string,
    sha: string,
    bytes: number,
  ): Promise<CohortView> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const cohort = await this.cohorts.insertWithFreshCode(
          manager,
          actorUserId,
          document.cohort.name.trim(),
        );
        await recordAudit(manager, {
          event: 'cohort.create',
          actorUserId,
          subjectUserId: actorUserId,
          targetId: cohort.id,
          action: cohort.name,
          reason: 'Imported from a class export.',
        });

        const users: Partial<UserEntity>[] = [];
        const enrollmentRows: Partial<EnrollmentEntity>[] = [];
        const phaseRows: Partial<PhaseStateEntity>[] = [];
        const taskRows: Partial<TaskStateEntity>[] = [];
        const submissionRows: Partial<SubmissionEntity>[] = [];
        const releaseRows: Partial<ReleaseRecordEntity>[] = [];
        const messageRows: Partial<AssistantMessageEntity>[] = [];
        /** Countersignatures this import restored, per learner, for the trail. */
        const restored = new Map<string, { ref: string; taskKey: string }[]>();

        for (const learner of plan.learners) {
          if (learner.outcome === 'skipped') continue;
          const userId = learner.existingId ?? learner.newId!;

          if (learner.outcome === 'created') {
            users.push({
              id: userId,
              email: learner.email,
              passwordHash: learner.passwordHash!,
              displayName:
                String(learner.source.displayName ?? '').trim() ||
                learner.email,
              role: 'LEARNER',
              cohort: cohort.id,
              dailyTokenBudget: learner.source.dailyTokenBudget ?? null,
              tokenVersion: 0,
              disabledAt: null,
              emailVerifiedAt: null,
            });
          } else {
            // An existing account moves into the new class. `cohort.join` is
            // exactly this event (an account entering an instructor's view)
            // so the audit page renders it with no new case.
            await manager.update(
              UserEntity,
              { id: userId },
              { cohort: cohort.id },
            );
          }

          for (const {
            source: enrollment,
            projectVersionId,
            phases,
          } of learner.enrollments) {
            const enrollmentId = randomUUID();
            enrollmentRows.push({
              id: enrollmentId,
              userId,
              projectSlug: enrollment.projectSlug,
              currentPhaseOrder: enrollment.currentPhaseOrder ?? 1,
              completed: Boolean(enrollment.completed),
              packVersion: enrollment.packVersion ?? null,
              // Resolved in `plan`, against this machine's own published
              // versions, and never null: the version that graded the work
              // when this machine holds it, else the head installed here at
              // import time, by id, so no later head moves the learner.
              projectVersionId,
              startedAt: new Date(enrollment.startedAt ?? Date.now()),
              completedAt: enrollment.completedAt ?? null,
            });

            for (const { source: phase, status, passedAt } of phases) {
              const phaseStateId = randomUUID();
              phaseRows.push({
                id: phaseStateId,
                enrollmentId,
                userId,
                phaseKey: phase.phaseKey,
                phaseOrder: phase.phaseOrder,
                // The one roll-up's answer, decided in `plan` against the
                // destination's pinned task list, never the file's word.
                status,
                bestScore: phase.bestScore ?? null,
                attempts: phase.attempts ?? 0,
                reflection: phase.reflection ?? null,
                workspace: phase.workspace ?? null,
                links: phase.links ?? null,
                drill: phase.drill ?? null,
                ranBeforeSubmit: Boolean(phase.ranBeforeSubmit),
                unlockedAt: phase.unlockedAt ?? null,
                passedAt,
              });

              // After the phase state and before the submissions, which is the
              // order `USER_SCOPED_ENTITIES` reads and the erasure walks back.
              for (const task of phase.tasks ?? []) {
                taskRows.push({
                  id: randomUUID(),
                  phaseStateId,
                  userId,
                  taskKey: task.taskKey,
                  status: task.status,
                  bestScore: task.bestScore ?? null,
                  attempts: task.attempts ?? 0,
                  ranBeforeSubmit: Boolean(task.ranBeforeSubmit),
                  passedAt: task.passedAt ?? null,
                  solutionReadAt: task.solutionReadAt ?? null,
                  awaitingSignOff: Boolean(task.awaitingSignOff),
                  // The file carried the fact and no id. The person is this
                  // machine's own operator, exactly as the password hash an
                  // imported account gets is this machine's own placeholder,
                  // and the audit row below says where it came from.
                  signedOffBy: task.countersigned ? actorUserId : null,
                  signedOffAt: task.signedOffAt ?? null,
                  resetAt: task.resetAt ?? null,
                  // `resetCount` is also a quiz's **attempt
                  // epoch** (`attemptEpochOf`). The file carries no
                  // `quiz_attempts` rows and `COHORT_EXPORT_VERSION` stays 3,
                  // so an imported learner lands on the epoch their count
                  // names with no papers under it; every allowed attempt
                  // available, and no paper of somebody else's run counted
                  // against them. That is self-consistent and wanted; it is
                  // written down because the alternative reading, that a
                  // missing epoch loses a learner their attempts, is the one a
                  // reader of this line reaches for first.
                  resetCount: task.resetCount ?? 0,
                });
                if (task.countersigned) {
                  const held = restored.get(userId) ?? [];
                  held.push({ ref: phase.ref, taskKey: task.taskKey });
                  restored.set(userId, held);
                }
              }

              for (const submission of phase.submissions ?? []) {
                submissionRows.push({
                  id: randomUUID(),
                  phaseStateId,
                  userId,
                  taskKey: submission.taskKey ?? '',
                  status: submission.status,
                  score: submission.score ?? null,
                  passed: submission.passed ?? null,
                  // The object, not a string: `simple-json` stringifies what it
                  // is given, and a string that is already JSON is stored twice
                  // encoded and read back as a string.
                  report: submission.report ?? null,
                  workspaceSnapshot: submission.snapshot ?? null,
                  packVersion: submission.packVersion ?? null,
                  error: submission.error ?? null,
                  createdAt: new Date(submission.createdAt ?? Date.now()),
                  // Absent in an older file, and absent reads as the current
                  // run, as a row written before the column existed is read.
                  // Any other value that is not a whole count an `integer`
                  // column holds was refused by name above.
                  resetEpoch: present(submission.resetEpoch)
                    ? (submission.resetEpoch as number)
                    : null,
                });
              }

              for (const message of phase.messages ?? []) {
                messageRows.push({
                  id: randomUUID(),
                  userId,
                  enrollmentId,
                  phaseStateId,
                  phaseKey: message.phaseKey ?? phase.phaseKey,
                  role: message.role,
                  // Empty when the export did not carry the transcripts. The
                  // row still has to exist: the count is what the reliance
                  // index is built from.
                  content: message.content ?? '',
                  provider: message.provider ?? '',
                  cached: Boolean(message.cached),
                  redacted: Boolean(message.redacted),
                  scopeRedirected: Boolean(message.scopeRedirected),
                  tokensIn: message.tokensIn ?? 0,
                  tokensOut: message.tokensOut ?? 0,
                  createdAt: new Date(message.createdAt ?? Date.now()),
                });
              }
            }

            const phaseIdByOrder = new Map(
              phaseRows
                .filter((row) => row.enrollmentId === enrollmentId)
                .map((row) => [row.phaseOrder, row.id!]),
            );
            for (const release of enrollment.releases ?? []) {
              const phaseStateId = phaseIdByOrder.get(release.phaseOrder);
              // A release names a phase state. `plan` refused an enrolment
              // with a release whose order is no carried phase's, so this
              // finds one; the guard stays so a release never points at
              // nothing.
              if (!phaseStateId) continue;
              releaseRows.push({
                id: randomUUID(),
                enrollmentId,
                userId,
                phaseStateId,
                phaseKey: release.phaseKey,
                phaseOrder: release.phaseOrder,
                version: release.version,
                score: release.score ?? null,
                notes: release.notes ?? null,
                createdAt: new Date(release.createdAt ?? Date.now()),
              });
            }
          }
        }

        // Parents first, so no child is ever written pointing at a row that
        // does not exist yet.
        await insertChunked(manager, UserEntity, users, 12);
        await insertChunked(manager, EnrollmentEntity, enrollmentRows, 10);
        await insertChunked(manager, PhaseStateEntity, phaseRows, 14);
        // Seventeen: the fifteen the import sets, plus the two dates TypeORM
        // binds for `@CreateDateColumn` and `@UpdateDateColumn`.
        await insertChunked(manager, TaskStateEntity, taskRows, 17);
        await insertChunked(manager, SubmissionEntity, submissionRows, 11);
        await insertChunked(manager, ReleaseRecordEntity, releaseRows, 9);
        await insertChunked(manager, AssistantMessageEntity, messageRows, 13);

        for (const learner of plan.learners) {
          if (learner.outcome === 'created') {
            await recordAudit(manager, {
              event: 'account.import',
              actorUserId,
              subjectUserId: learner.newId!,
              targetId: cohort.id,
              action: learner.email,
              reason:
                'The account appeared with a class import and has no password yet.',
            });
          } else if (learner.outcome === 'matched') {
            await recordAudit(manager, {
              event: 'cohort.join',
              actorUserId,
              subjectUserId: learner.existingId!,
              targetId: cohort.id,
              action: cohort.name,
              detail: { to: cohort.id, via: 'import' },
            });
          }
        }

        // A countersignature that exists here because a file said so, with this
        // machine's own operator's id on it. One row per learner rather than
        // per task: the subject is who the record is about, and the detail
        // names every task it covers.
        for (const [subjectUserId, tasks] of restored) {
          await recordAudit(manager, {
            event: 'task.signoff',
            actorUserId,
            subjectUserId,
            targetId: cohort.id,
            // `!== 1` rather than `=== 1`: this is a plural, not the sole-task
            // predicate, and the gate that keeps that predicate in one file
            // greps for the expression rather than for the meaning.
            action: `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`,
            reason:
              'The countersignature was restored from a class export: the file carried the fact without the person, and this machine records who brought it in.',
            detail: { tasks },
          });
        }

        await recordAudit(manager, {
          event: 'cohort.import',
          actorUserId,
          subjectUserId: actorUserId,
          targetId: cohort.id,
          action: document.cohort.name,
          detail: {
            sha256: sha,
            bytes,
            host: document.source?.host ?? null,
            exportedAt: document.exportedAt ?? null,
            counts: plan.counts,
            createdAccounts: plan.createdAccounts.length,
            // Every phase the one roll-up moved, in the file's own addressing,
            // each direction under its own key. A receipt that recorded the
            // counts but not this would say the class arrived as the file
            // described it, which is the one thing that is not true about a
            // file the roll-up moved, and a receipt that recorded both
            // directions under one key would say which way for half of them.
            flattenedPhases: plan.learners.flatMap(
              (learner) => learner.flattenedPhases,
            ),
            openedPhases: plan.learners.flatMap(
              (learner) => learner.openedPhases,
            ),
          },
        });

        const receipt: Partial<CohortImportEntity> = {
          id: randomUUID(),
          cohortId: cohort.id,
          actorUserId,
          format: COHORT_EXPORT_FORMAT,
          formatVersion:
            Number(document.formatVersion) || COHORT_EXPORT_VERSION,
          documentSha256: sha,
          bytes,
          sourceHost: document.source?.host ?? null,
          sourceExportedAt: document.exportedAt ?? null,
          includes: document.includes ?? [],
          counts: plan.counts,
          // Verbatim, and never replayed as rows: an audit row is a claim about
          // who did something on *this* machine.
          sourceAudit: Array.isArray(document.auditEvents)
            ? document.auditEvents
            : [],
        };
        // The cast is the same one insertChunked makes: TypeORM's insert type
        // walks into a simple-json array's members as if they were relations,
        // and these columns are each one opaque JSON value.
        await manager.insert(CohortImportEntity, receipt as never);

        return {
          id: cohort.id,
          name: cohort.name,
          joinCode: cohort.joinCode,
          createdAt: isoOrNow(cohort.createdAt),
          memberCount: await manager.count(UserEntity, {
            where: { cohort: cohort.id, role: 'LEARNER' },
          }),
        };
      });
    } catch (error) {
      const why = isUniqueViolation(error)
        ? 'Somebody registered one of these addresses while the import was running. Try it again.'
        : (error as Error).message;
      this.logger.warn(
        `import failed and was rolled back: ${(error as Error).message}`,
      );
      throw new BadRequestException(
        `The import failed and nothing was changed. ${why}`,
      );
    }
  }
}

/* -------------------------------- helpers -------------------------------- */

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const bucket = out.get(id);
    if (bucket) bucket.push(row);
    else out.set(id, [row]);
  }
  return out;
}

function outcomeOf(planned: PlannedLearner): CohortImportLearnerOutcome {
  const notes: string[] = [];
  if (planned.note) notes.push(planned.note);
  if (planned.skippedProjects.length) {
    notes.push(
      `Already here, and would move into the new class. Their ${planned.skippedProjects.join(
        ', ',
      )} work is not merged: they already have an enrolment on this machine.`,
    );
  }
  if (planned.unknownProjects.length) {
    notes.push(
      `Their ${planned.unknownProjects.join(', ')} work is left in the file: this machine does not have that project.`,
    );
  }
  if (planned.unreachableProjects.length) {
    notes.push(
      `Their ${planned.unreachableProjects.join(', ')} work is left in the file: that project is another teacher's, and none of your classes can be put on it.`,
    );
  }
  if (planned.unknownVersions.length) {
    notes.push(
      `Their ${planned.unknownVersions
        .map((pin) => `${pin.slug} ${pin.version}`)
        .join(
          ', ',
        )} work is left in the file: this machine does not have that version of the project.`,
    );
  }
  if (planned.unpinnedVersions.length) {
    // Each version beside the head it got, so two pins never read as two
    // lists the reader has to zip.
    notes.push(
      `Their ${planned.unpinnedVersions
        .map((pin) => `${pin.slug} ${pin.version} work came in pinned to ${pin.pinnedTo}`)
        .join(
          ', ',
        )}: this machine does not have that version of the project, so the work reads the published one.`,
    );
  }
  // One sentence per enrolment, each its own reason, beside the others.
  for (const refused of planned.refusedEnrolments) {
    notes.push(
      `Their ${refused.slug} work is left in the file: ${refused.sentence}`,
    );
  }
  if (planned.flattenedPhases.length) {
    notes.push(
      `Their ${planned.flattenedPhases
        .map((one) => `${one.slug} ${one.phaseKey}`)
        .join(
          ', ',
        )} work came in shut: this machine's version of the project asks for tasks the file records no pass for, so those phases read as the work stands rather than as the file said.`,
    );
  }
  if (planned.openedPhases.length) {
    notes.push(
      `Their ${planned.openedPhases
        .map((one) => `${one.slug} ${one.phaseKey}`)
        .join(
          ', ',
        )} work came in open: this machine's version of the project records a pass for every task those phases ask for, so they read as the work stands rather than as the file said.`,
    );
  }
  return {
    email: planned.email || String(planned.source.email ?? ''),
    displayName:
      String(planned.source.displayName ?? '').trim() || planned.email,
    outcome: planned.outcome,
    note: notes.length ? notes.join(' ') : null,
    // Every list: work that did not come in, whichever the reason.
    skippedProjects: [
      ...planned.skippedProjects,
      ...planned.unknownProjects,
      ...planned.unreachableProjects,
      ...planned.unknownVersions.map((pin) => pin.slug),
      ...planned.refusedEnrolments.map((refused) => refused.slug),
    ],
  };
}

/** "12 September", for a sentence rather than a log line. */
function readableDate(iso: string | null): string {
  if (!iso) return 'an earlier day';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an earlier day';
  return date.toLocaleDateString(DISPLAY_LOCALE, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

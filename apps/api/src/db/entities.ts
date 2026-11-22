import {
  UpdateDateColumn,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  AcceptedScreenCopy,
  AuditEventView,
  DrillState,
  FeedbackReport,
  InterviewRecord,
  MentorMemoryView,
  JobStatus,
  PhaseKey,
  PhaseLink,
  PhaseStatus,
  RegradeBatchStatus,
  RegradeScope,
  RegradeSkip,
  Role,
  RunResult,
  StuckFlag,
  PhaseEstimate,
  PhaseRetro,
  CohortExportAuditEvent,
  CohortExportCounts,
  CohortExportInclude,
  WarmupStatus,
  NotificationAudience,
  NotificationKind,
} from '@learnsdlc/shared';
// The instructor notes table lives beside the service that owns it and is
// listed here so DatabaseModule builds its repository.
import { InstructorNoteEntity } from '../instructor/notes.entity';
export { InstructorNoteEntity };
import { PreviewSessionEntity } from '../preview/preview-session.entity';
export { PreviewSessionEntity };
import { SubmissionTeacherFeedbackEntity } from '../instructor/submission-feedback.entity';
export { SubmissionTeacherFeedbackEntity };
import { AgentProposalEntity } from '../assistant/agent-proposal.entity';
export { AgentProposalEntity };
import { AgentTurnEntity } from '../assistant/agent-turn.entity';
export { AgentTurnEntity };
// Teacher-authored projects: a project is rows, not a directory. They live
// beside the loader that reads them and are listed here
// so DatabaseModule builds their repositories.
import {
  CohortProjectAssignmentEntity,
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
export {
  CohortProjectAssignmentEntity,
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
};

@Entity('users')
/**
 * Every instructor request starts by asking who is in the caller's class, and
 * `learnerScope` (`cohort-scope.ts:15`) asks it as `role = 'LEARNER' AND
 * cohort = ...`. With `email` the only index on the table that was a full
 * `SCAN users` on every console page load, every export and every audit page,
 * so a deployment with a second class or a term of graduated accounts paid
 * for all of them on each request. The pair is in scope order: role first
 * because it is the equality every call makes, cohort second because it is
 * the one that varies.
 */
@Index('IDX_users_role_cohort', ['role', 'cohort'])
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  email: string;

  @Column()
  passwordHash: string;

  /** Trusted Cognito subject; existing coursework remains keyed by the local id. */
  @Index('IDX_users_cognitoSub', { unique: true })
  @Column({ type: 'varchar', nullable: true })
  cognitoSub: string | null;

  @Column()
  displayName: string;

  @Column({ type: 'int', default: 0 })
  avatar: number;

  @Column({ type: 'text', default: '' })
  bio: string;

  @Column({ type: 'text', default: '' })
  goals: string;

  @Column({ default: false })
  onboardingCompleted: boolean;

  @Column({ type: 'int', default: 0 })
  profileVersion: number;

  @Column({ default: 'LEARNER' })
  role: Role;

  @Column({ default: 'default' })
  cohort: string;

  /** Retained for historical exports/imports only. Never limits AI access. */
  @Column({ type: 'int', nullable: true })
  dailyTokenBudget: number | null;

  /**
   * Bumped on password change, admin reset and suspension. The JWT carries the
   * value it was issued with; the guard rejects a token whose version is stale.
   * This is what turns a stateless 7-day token into something that can be
   * revoked.
   */
  @Column({ type: 'int', default: 0 })
  tokenVersion: number;

  /** Set by an admin. A suspended account is refused at the guard. */
  @Column({ type: 'varchar', nullable: true })
  disabledAt: string | null;

  /** Null until the address has been confirmed. Nothing is gated on it yet. */
  @Column({ type: 'varchar', nullable: true })
  emailVerifiedAt: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

/**
 * A class. Learners join with the code; the owner is the instructor who sees
 * them. Keyed by ownerUserId rather than userId on purpose: it is not learner
 * coursework, so it is neither exported nor erased with a learner account.
 */
@Entity('cohorts')
export class CohortEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Index({ unique: true })
  @Column()
  joinCode: string;

  @Index()
  @Column()
  ownerUserId: string;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('enrollments')
/**
 * One enrolment per learner and project, enforced by the database. `enroll` is
 * a read-then-write (a `findOne` guard, then an insert) so a double-tapped
 * Start, a retried request or two tabs all pass the guard and all insert. A
 * duplicate is not cosmetic: `myEnrollment` does `findOne({ userId, projectSlug })`
 * with no order, so the learner can be handed either copy on successive loads,
 * and `analytics.service.ts` already carries a "the oldest wins if a retry ever
 * left a second one behind" workaround for exactly this row.
 */
@Index('UQ_enrollments_user_project', ['userId', 'projectSlug'], { unique: true })
export class EnrollmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  projectSlug: string;

  @Column({ type: 'int', default: 1 })
  currentPhaseOrder: number;

  @Column({ default: false })
  completed: boolean;

  /**
   * The content pack version this enrolment was created against, null for an
   * enrolment made before packs carried one. Phases, rubrics and pass marks
   * all move when a pack is edited mid-term, and without this column there is
   * no way to say which set of rules a learner started under, so a regrade
   * after a rubric fix is guesswork. Stamped at enrolment from the
   * version the pack declares.
   */
  @Column({ type: 'varchar', nullable: true })
  packVersion: string | null;

  // The pin.
  /**
   * The `project_versions` row this enrolment resolves content from, null for
   * an enrolment made before projects had versions as rows.
   *
   * `packVersion` above is the stamped *string*, kept because the regrade
   * tooling reads it; this is the pin itself, and it is what makes "a change
   * never alters an in-flight attempt" true rather than hoped for. A published
   * version is immutable, so a learner pinned to one cannot have a rubric, a
   * hidden suite or a phase title move under an attempt; a content fix reaches
   * new enrolments immediately and existing ones at the next audited migrate.
   *
   * Nullable, and a null resolves the published head: legacy rows keep working
   * and the read never rewrites them.
   */
  @Column({ type: 'varchar', nullable: true })
  projectVersionId: string | null;

  // What the mentor carries out of the phases
  // this learner has already finished. Rebuilt from their own artefacts, never
  // appended to, and capped, so it cannot grow across six phases.
  @Column({ type: 'simple-json', nullable: true })
  mentorMemory: MentorMemoryView | null;

  @CreateDateColumn()
  startedAt: Date;

  @Column({ type: 'varchar', nullable: true })
  completedAt: string | null;
}

@Entity('phase_states')
/**
 * One phase state per enrolment and phase order. Enrolment writes these six
 * rows one at a time, so a retry that got as far as the third row and a repair
 * that fills the rest must not be able to leave two rows claiming the same
 * order: a learner would then have two phase 4s, one of which holds the work
 * and the other of which the gate reads.
 */
@Index('UQ_phase_states_enrollment_order', ['enrollmentId', 'phaseOrder'], { unique: true })
export class PhaseStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  enrollmentId: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  phaseKey: PhaseKey;

  @Column({ type: 'int' })
  phaseOrder: number;

  @Column({ default: 'locked' })
  status: PhaseStatus;

  @Column({ type: 'float', nullable: true })
  bestScore: number | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  reflection: string | null;

  /** Learner-edited file contents, keyed by workspace path. */
  @Column({ type: 'simple-json', nullable: true })
  workspace: Record<string, string> | null;

  /** Server-owned Design handoff; never accepted from a workspace save. */
  @Column({ type: 'simple-json', nullable: true })
  acceptedScreenCopy: AcceptedScreenCopy | null;

  /** Learner-made links (test or node -> the criterion it proves). */
  @Column({ type: 'simple-json', nullable: true })
  links: PhaseLink[] | null;

  /** Deployment only: INCIDENT-1 drill progress, null until the learner is paged. */
  @Column({ type: 'simple-json', nullable: true })
  drill: DrillState | null;

  @Column({ default: false })
  ranBeforeSubmit: boolean;

  @Column({ type: 'varchar', nullable: true })
  unlockedAt: string | null;

  @Column({ type: 'varchar', nullable: true })
  passedAt: string | null;

  // The customer interview the learner held
  // in this phase, and the one help flag they may have open on it. Both ride
  // the phase state rather than a table of their own so that a learner's export
  // and erasure already carry them, and neither needs a new USER_SCOPED_ENTITIES
  // entry (account.service.ts:47).
  /** Requirements only: the transcript of the customer interview, null until asked. */
  @Column({ type: 'simple-json', nullable: true })
  interview: InterviewRecord | null;

  /** The learner's open request for help on this phase, and its answer. */
  @Column({ type: 'simple-json', nullable: true })
  stuck: StuckFlag | null;

  // The day this phase's sandbox runs see.
  /**
   * What the sandbox calls today when this phase runs: an ISO date the learner
   * pinned, or null for the machine's clock. Testing only, and a parameter of
   * the next run rather than an event - changing it spends no attempt and
   * invalidates no verdict.
   */
  @Column({ type: 'varchar', nullable: true })
  runClock: string | null;

  // A learner's estimate of the phase and their retrospective on it. No route
  // writes either column; they are kept for the values already stored, which
  // the learner's export and account erasure still carry because the row is
  // the learner's (USER_SCOPED_ENTITIES in account.service.ts needs no entry).
  /** The stored estimate of the phase, or null. */
  @Column({ type: 'simple-json', nullable: true })
  estimate: PhaseEstimate | null;

  /** The stored retrospective. Not `reflection`, which is the merge message. */
  @Column({ type: 'simple-json', nullable: true })
  retro: PhaseRetro | null;

  // What "last saved" actually means.
  /**
   * When this row's files were last written, as an ISO string, null until
   * they have been: a save, a task reset, an Agentic apply, a drill resolve
   * into the runbook, or an instructor's workspace or phase reset.
   *
   * `updatedAt` below is not the last workspace write: TypeORM moves an
   * `@UpdateDateColumn` on every write to the row: `markRan`, the three drill
   * writes, `saveLinks`, the run clock and the grading job all bump it, so a
   * save time read from it would jump to now when a learner pressed "Run
   * health check" without saving anything. It is also stored to the second, which is
   * coarser than a 700 ms autosave.
   *
   * A varchar holding an ISO string, like `unlockedAt` and `passedAt` beside
   * it: it keeps milliseconds, it compares as text on both dialects, and it
   * needs no dialect-specific timestamp handling in the migration.
   */
  @Column({ type: 'varchar', nullable: true })
  workspaceUpdatedAt: string | null;

  // When this learner first opened the pack's
  // reference answer for this phase. Null until they do, and it never moves
  // again: a second reading is the same reading. It rides the phase state for
  // the reason the columns above do: the row is already the
  // learner's, so export and erasure carry it and USER_SCOPED_ENTITIES
  // (account.service.ts) needs no entry.
  /**
   * An ISO string in a varchar, matching `unlockedAt`, `passedAt` and
   * `workspaceUpdatedAt` beside it: milliseconds kept, text comparison on both
   * dialects, no dialect-specific timestamp handling in the migration.
   */
  @Column({ type: 'varchar', nullable: true })
  solutionReadAt: string | null;

  /** Last write of any kind to this row. Lets a second tab notice its baseline is stale. */
  @UpdateDateColumn()
  updatedAt: Date;
}

/* ----------------- several tasks in one written phase ----------------- */

@Entity('task_states')
/**
 * One learner's state on **one authored task** of one phase.
 *
 * The rule that decides whether a row exists at all: a phase whose compiled
 * list is exactly one task keyed `SOLE_TASK_KEY` gets **no** row, ever
 * (`soleTaskList`, `content/task-units.ts`). That is the imported default
 * project, and it is what makes this table cost it nothing: no row, no query,
 * no behaviour. Every phase of every *teacher-authored* project declares one
 * task keyed `main` instead, so those do get a row, on every phase of every
 * kind, from the day the teacher publishes.
 *
 * `status` is a `PhaseStatus` rather than a vocabulary of its own, because the
 * roll-up is `nextPhaseStatus` per task and three readers (the door, the
 * roll-up and `advance`) must all mean the same thing by `'passed'`.
 * `awaitingSignOff` is what a `signOff` task carries between the verdict and
 * the teacher's countersignature, which is why a verdict never writes one
 * `passed`.
 *
 * `ranBeforeSubmit` is declared ahead of a per-task Run path (no Run writes
 * it true; a reset sets it false and a class import copies it): a column
 * added later would be a second migration
 * against a table a term of coursework already lives in.
 */
@Index('UQ_task_states_key', ['phaseStateId', 'taskKey'], { unique: true })
export class TaskStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  phaseStateId: string;

  /**
   * The learner, carried on the row rather than joined for, exactly as
   * `phase_states` and `submissions` carry theirs: the export and the erasure
   * walk a `userId` column (`account.service.ts`), and nothing in this schema
   * cascades.
   */
  @Index('IDX_task_states_user')
  @Column()
  userId: string;

  /** The compiled task's key, as the **pinned** version declares it. */
  @Column()
  taskKey: string;

  @Column({ default: 'in_progress' })
  status: PhaseStatus;

  @Column({ type: 'float', nullable: true })
  bestScore: number | null;

  /** Spent and refunded in SQL beside the phase's, never derived from a count. */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  /** For a per-task Run path, declared now so that path adds no column (see the class comment). */
  @Column({ default: false })
  ranBeforeSubmit: boolean;

  /**
   * ISO strings in varchars, matching `phase_states.passedAt` and
   * `solutionReadAt` beside them: milliseconds kept, text comparison on both
   * dialects, no dialect-specific timestamp handling in the migration.
   */
  @Column({ type: 'varchar', nullable: true })
  passedAt: string | null;

  /** When this learner first opened **this task's** answer. A second reading is the same reading. */
  @Column({ type: 'varchar', nullable: true })
  solutionReadAt: string | null;

  /** The evidence is in and a teacher's countersignature is the remaining half. */
  @Column({ default: false })
  awaitingSignOff: boolean;

  /**
   * The teacher who countersigned, and when.
   *
   * An actor column on somebody else's record, which is why it is named in
   * `ACTOR_SCOPED_ENTITIES` with the policy `kept`: the gate reads whether a
   * sign-off is set, so nulling it on that teacher's own erasure would reclose
   * a phase they had opened, for every learner they had ever signed off.
   */
  @Column({ type: 'varchar', nullable: true })
  signedOffBy: string | null;

  @Column({ type: 'varchar', nullable: true })
  signedOffAt: string | null;

  /** The last teacher or learner reset of this task, and how many there have been. */
  @Column({ type: 'varchar', nullable: true })
  resetAt: string | null;

  @Column({ type: 'int', default: 0 })
  resetCount: number;

  @CreateDateColumn()
  createdAt: Date;

  /**
   * Last write of any kind to this row: **an `@UpdateDateColumn`, and that one
   * word is load-bearing.**
   *
   * The H3-TaskStates migration spells the column `${t.created}`, which is `DEFAULT now()` /
   * `DEFAULT (datetime('now'))` and fires on insert alone. TypeORM is what
   * moves it on every write, exactly as it does for `phase_states.updatedAt`
   * above (the C6-WorkspaceUpdatedAt migration's header records that behaviour, as the reason
   * the save got a column of its own). Declared as a plain `@Column` this would
   * be a property with a reader and no writer: `PhaseSummary.tasksUpdatedAt` is
   * a grouped `MAX(task_states.updatedAt)`, so it would answer the insert time
   * for ever, the client's phase-moved comparison would never fire, and the
   * rooms would draw from a cache that cannot see a task move.
   */
  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('task_resets')
/**
 * What a reset of one task took away, so it can be handed back.
 *
 * The learner's own reset (`WorkflowService.resetTask`) writes it, and
 * `RetentionService.pruneResetCopies` bounds it by **bytes**, not rows. `files`
 * is NOT NULL, so the prune writes `{}` rather than null on every row outside
 * the newest three per `taskStateId` (ordered `createdAt DESC, id DESC`; the
 * writer mints `id` as a UUIDv7 so the order is total on sqlite's one-second
 * clock). Rows are never deleted; the export and the erasure already walk them.
 */
export class TaskResetEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  taskStateId: string;

  @Index('IDX_task_resets_user')
  @Column()
  userId: string;

  /** The editable files exactly as they were when the reset took them. */
  @Column({ type: 'simple-json' })
  files: Record<string, string>;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('submissions')
/**
 * At most one submission in flight per phase **and task**, enforced by the
 * database. The double-submit guard in `feedback.service.ts` is a
 * read-then-write, so a double-click or a retried request can enqueue the same
 * workspace twice and have two gradings write the same task row. Terminal rows
 * are outside the index (a task keeps its whole back catalogue of attempts)
 * which is what the `where` clause buys and a plain unique index could not.
 *
 * The key is `(phaseStateId, taskKey)`, not `(phaseStateId)` alone:
 * two tasks of one written phase are two pieces of work and a learner may hand
 * both in. On a phase with one task the guard is per phase, because every
 * revision of that phase carries the one key. This index is the **exactness**
 * guarantee and the only bound the database makes; the per-learner cap beside
 * it in `feedback.service.ts` is a bare count with no lock, and is advisory.
 *
 * Both dialects accept a partial unique index: sqlite and Postgres each take
 * `WHERE` on `CREATE UNIQUE INDEX`, so TypeORM's schema sync writes the same
 * shape into the sqlite the unit tests run on as the A3 migration writes
 * for Postgres. Postgres stores the predicate normalised: `((status)::text =
 * ANY (...))`, and still compares it equal, so a migrated database reports no
 * pending schema change.
 */
@Index('UQ_submissions_in_flight', ['phaseStateId', 'taskKey'], {
  unique: true,
  where: "status IN ('queued','running')",
})
/**
 * Newest attempt per phase, in index order. Both the class map and the CSV
 * export want one row per phase state (the last thing the learner submitted)
 * and without this index both would read the phase's whole back catalogue
 * and pick the first per phase state in JavaScript. `phaseStateId` alone cannot serve that: the
 * ordering columns are not in it, so sqlite sorted every row it had read. With
 * `createdAt` and `id` alongside, `MAX(createdAt)` per phase state is a
 * covering-index seek and the rows that cross the driver are the six a learner
 * has, not the six hundred they made getting there.
 */
@Index('IDX_submissions_phase_state_created', ['phaseStateId', 'createdAt', 'id'])
/**
 * The same seek, one task at a time. `newestSubmissionsPerTask` groups by
 * `(phaseStateId, taskKey)` and takes `MAX(createdAt)` per group, and the three
 * columns above cannot serve it: `taskKey` is not in them, so the driver would
 * read the phase's whole back catalogue and group in JavaScript.
 *
 * It is a **new** index beside the three-column one rather than a widening of
 * it: putting `taskKey` in position two would destroy the prefix
 * `newestSubmissionsPerPhaseState` seeks on, and that function keeps its name,
 * its query and its three callers.
 */
@Index('IDX_submissions_task_created', ['phaseStateId', 'taskKey', 'createdAt', 'id'])
export class SubmissionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  phaseStateId: string;

  @Index()
  @Column()
  userId: string;

  /**
   * Which task of the phase this revision is about.
   *
   * `''` is the compiled sole task's own key, so a revision of the imported
   * default project needs no key of its own: the value is
   * a real key rather than a stand-in for "no task". It is also the H3
   * migration's backfill default, which is a different fact about the same
   * string: an older revision carries no key of its own, and which task it belongs
   * to is a question the row writers answer against the board rather than one a
   * migration may.
   */
  @Column({ default: '' })
  taskKey: string;

  @Column({ default: 'queued' })
  status: JobStatus;

  @Column({ type: 'float', nullable: true })
  score: number | null;

  @Column({ type: 'boolean', nullable: true })
  passed: boolean | null;

  @Column({ type: 'simple-json', nullable: true })
  report: FeedbackReport | null;

  /** The editable files exactly as they were when this revision was submitted. */
  @Column({ type: 'simple-json', nullable: true })
  workspaceSnapshot: Record<string, string> | null;

  /** Supporting evidence captured with the submitted bytes, never read from a newer draft. */
  @Column({ type: 'simple-json', nullable: true })
  contextSnapshot: { links: PhaseLink[]; ranBeforeSubmit: boolean; drill: DrillState | null; acceptedScreenCopy?: AcceptedScreenCopy | null } | null;

  @Column({ type: 'varchar', nullable: true })
  processingToken: string | null;

  @Column({ type: 'varchar', nullable: true })
  processingLeaseUntil: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  /**
   * The content pack version that graded this attempt, null for a submission
   * graded before packs carried one. The report is only readable next to the
   * rubric that produced it: a pack edited mid-term changes what 70 means, and
   * an appeal six weeks later has to be able to say which rules applied.
   * Stamped at grading time from the version the pack declares.
   */
  @Column({ type: 'varchar', nullable: true })
  packVersion: string | null;

  // Where a regraded revision came from.
  /**
   * The submission this one re-graded, or null for an ordinary attempt. A
   * regrade never edits the row it re-runs: the old verdict is the record an
   * appeal reads, so the new verdict is a new revision that points back.
   */
  @Column({ type: 'varchar', nullable: true })
  regradeOf: string | null;

  /** Which batch produced this revision. Null for an ordinary attempt. */
  @Column({ type: 'varchar', nullable: true })
  regradeBatchId: string | null;

  // The learner's own words on this
  // revision, and the clock it was graded at.
  /**
   * What the learner said this revision changes, at most 140 characters. Null
   * means the field was empty, or the revision predates the field - to every
   * reader those are the same fact, so there is one column and no flag.
   *
   * Never pruned. Retention nulls `workspaceSnapshot` on old revisions and
   * keeps the row; this is a hundred and forty bytes and it is the part an
   * appeal reads.
   */
  @Column({ type: 'varchar', nullable: true })
  commitMessage: string | null;

  /**
   * The clock this revision was graded at, copied from the phase state at
   * submit time, or null for the machine's clock. Stamped here for the same
   * reason `packVersion` is: a regrade six weeks later has to answer the
   * question this revision asked, not the one the learner is asking now.
   */
  @Column({ type: 'varchar', nullable: true })
  runClock: string | null;

  // Which run of its task this revision is.
  /**
   * The task row's `resetCount` when this revision was inserted, read under the
   * enrolment lock in the same transaction as the insert. **NULL means the
   * current run**: every row older than the H5 migration, every row an older
   * API build writes in a rollback window, and every sole-task (TaskTrackr) revision, which has no
   * task row to read an epoch from. A reset of a non-quiz, non-sole task first
   * stamps that task's NULL rows with the ending run's number, so after a
   * reset NULL is the current run exactly. A regrade row copies its parent's.
   */
  @Column({ type: 'int', nullable: true })
  resetEpoch: number | null;

  @CreateDateColumn()
  createdAt: Date;
}

/* ---------------------- quizzes · the paper, per attempt ------------------ */

/**
 * One question as this paper drew it: the question's id, and the option ids in
 * the order this learner is shown them.
 *
 * No stem and no option text: those are read from the pinned version's sealed
 * `QuizChecks`, which `projectVersionId` names. A paper is a **draw and a
 * permutation**, never a second copy of the bank, so a pool's undrawn
 * questions are not in this table at all, and the key is not in it on any row.
 */
export interface QuizAttemptPaperQuestion {
  questionId: string;
  optionIds: string[];
}

@Entity('quiz_attempts')
/**
 * One learner's paper on one quiz task: drawn when they start, scored when they
 * hand it in.
 *
 * **A table rather than a column on `submissions`, because the paper exists
 * before a verdict does.** A reload has to redraw the same questions in the
 * same order and a cooldown has to have something to measure from;
 * `submissions.workspaceSnapshot` is editable *files* and an answer sheet is
 * not one. The row is written at start with `submittedAt` null, and closed at
 * hand-in with `answers`, `score`, `passed`, `submittedAt` and the
 * `submissionId` of the revision the grader scored.
 *
 * **What is not here.** `QuizQuestion.correct` is never copied onto a row:
 * scoring reads the pinned version's sealed slice, so a table a learner's
 * export walks holds no key. Neither is the explanation, for the same reason.
 *
 * **The pin.** `projectVersionId` is the version this paper was drawn against.
 * A published version is immutable, so a paper can only go stale across a
 * re-pin; when it does, the hand-in refuses by name rather than scoring
 * against a guess. `packVersion` sits beside it for the reason
 * `submissions.packVersion` does: a report is only readable next to the
 * rubric that produced it.
 *
 * **Three devices, three jobs, and this entity declares one of them.**
 * `UQ_quiz_attempts_open` is the **idempotent-start** device and nothing else:
 * while a row has `submittedAt IS NULL` a second start cannot insert a second
 * paper, so the route hands back the open one. It constrains **nothing** once
 * that row is closed, so it is neither the replay guard (that is the explicit
 * `submittedAt IS NOT NULL` refusal on the hand-in route) nor the attempt
 * limit, which is `COUNT(*) … WHERE submittedAt IS NOT NULL` over
 * `IDX_quiz_attempts_task`'s leading columns.
 *
 * `startedAt` and `submittedAt` are ISO instants in varchars, matching
 * `passedAt`, `solutionReadAt` and `readAt` beside them: milliseconds kept,
 * text comparison on both dialects, no dialect-specific date handling in the
 * migration.
 *
 * **NEVER** use `queryRunner.addColumn` or `dropColumn` on this table in a
 * later sqlite migration. The driver rebuilds the table from the definition it
 * just read and recreates its indexes without their `WHERE` clause, which
 * would silently drop the predicate below and let one learner hold two open
 * papers. Use raw `ALTER TABLE "quiz_attempts" ADD COLUMN "x" varchar`: the
 * rule `notifications` and `submissions` each paid for.
 */
@Index('UQ_quiz_attempts_open', ['phaseStateId', 'taskKey'], {
  unique: true,
  where: '"submittedAt" IS NULL',
})
/**
 * The attempt count and the back catalogue, one task at a time.
 * `(phaseStateId, taskKey)` is what both the limit's `COUNT(*)` and the
 * learner's *attempts used and left* seek on, and `createdAt` is what orders
 * the papers within a task: the newest first, which is the one a reload
 * wants. `epoch` and `voidedAt` narrow that count and are deliberately not in
 * the index: behind this seek are one learner's papers on one quiz, which is
 * tens of rows and not a scan worth widening a key for.
 */
@Index('IDX_quiz_attempts_task', ['phaseStateId', 'taskKey', 'createdAt'])
export class QuizAttemptEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  phaseStateId: string;

  /**
   * The learner, carried on the row rather than joined for, exactly as
   * `phase_states`, `task_states` and `submissions` carry theirs: the export
   * and the erasure walk a `userId` column (`account.service.ts`), and nothing
   * in this schema cascades.
   */
  @Index('IDX_quiz_attempts_user')
  @Column()
  userId: string;

  /** The compiled task's key, as the **pinned** version declares it. */
  @Column()
  taskKey: string;

  /**
   * Which run of this quiz the paper belongs to: the **attempt epoch**.
   *
   * A required quiz failed on every allowed attempt would otherwise lock its
   * phase and every phase after it with nothing in the product able to open them again.
   * The teacher's existing per-task `task-reset` is the recovery, and this
   * column is what makes it one: a reset starts a new epoch, and the spent
   * count, the *open paper* lookup, the attempt numbering and `attemptsLeft`
   * all quantify over the **current** epoch alone. Not one row is deleted:
   * every paper a learner ever sat stays here for the teacher's view and for
   * the export.
   *
   * **An integer and not a timestamp comparison.** *"Papers since the last
   * reset"* invites a clock tie: a reset and a hand-in landing in the same
   * millisecond would leave it undecidable which side of the line a paper
   * falls. The epoch is stamped at start from `task_states.resetCount`, which
   * is the count the reset already increments, so the two are one fact rather
   * than two that can drift. `0` is *nobody has reset this task*, which is
   * every paper drawn before the recovery existed.
   */
  @Column({ type: 'int', default: 0 })
  epoch: number;

  /**
   * When a reset closed this paper without it ever being handed in, or null.
   *
   * A paper open at the moment of a reset belongs to an epoch that has ended.
   * It cannot stay open: `UQ_quiz_attempts_open` is **not** epoch-scoped, and
   * must not be, because *at most one open paper per learner and task* is the
   * whole of what it guarantees, so the reset closes it: `submittedAt` is
   * stamped so the row leaves the index, and this column is stamped so that
   * nothing ever mistakes it for a sheet. A void paper is never scored, never
   * counted against the limit, never linked to a submission and never handed
   * back by `latestHandedIn`, so a stale hand-in of it meets the same single
   * refusal sentence every other wrong attempt id meets.
   *
   * It is a column rather than `answers IS NULL` read as a marker: the count
   * that decides whether a learner has attempts left is not a place to infer
   * from the absence of a value.
   */
  @Column({ type: 'varchar', nullable: true })
  voidedAt: string | null;

  /** The pin this paper was drawn against. See the note above this class. */
  @Column()
  projectVersionId: string;

  /** Beside `submissions.packVersion`, and null where nothing stamped one. */
  @Column({ type: 'varchar', nullable: true })
  packVersion: string | null;

  /** The revision this sheet was handed in as. Null while the paper is open. */
  @Column({ type: 'varchar', nullable: true })
  submissionId: string | null;

  /** The drawn questions, in display order. Written once, at start. */
  @Column({ type: 'simple-json' })
  paper: QuizAttemptPaperQuestion[];

  /** What the learner picked, by option id. Null while the paper is open. */
  @Column({ type: 'simple-json', nullable: true })
  answers: Record<string, string[]> | null;

  /** 0..100, the paper's own score. Null while the paper is open. */
  @Column({ type: 'float', nullable: true })
  score: number | null;

  /** Against the task's `passMark`. Null while the paper is open. */
  @Column({ type: 'boolean', nullable: true })
  passed: boolean | null;

  @Column()
  startedAt: string;

  /**
   * When this paper was closed, and the one column three rules read:
   * `UQ_quiz_attempts_open`'s predicate, the replay refusal, and the attempt
   * count. Null is *open*, and there is at most one open row per task.
   *
   * *Closed* is **handed in** on every path but one: a reset closes an open
   * paper without a sheet, and `voidedAt` above is what says which of the two
   * this row is. The attempt count reads both columns for that reason.
   */
  @Column({ type: 'varchar', nullable: true })
  submittedAt: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

export interface ExecutionRunInputSnapshot {
  version: 1;
  workspace: Record<string, string>;
  runClock: string | null;
  acceptedScreenCopy: AcceptedScreenCopy | null;
}

@Entity('execution_runs')
@Index('UQ_execution_runs_in_flight', ['phaseStateId'], {
  unique: true,
  where: "kind = 'run' AND status IN ('queued','running')",
})
export class ExecutionRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  phaseStateId: string;

  @Index()
  @Column()
  userId: string;

  @Column({ default: 'run' })
  kind: 'run' | 'submit';

  @Column({ default: 'queued' })
  status: JobStatus;

  @Column({ type: 'simple-json', nullable: true })
  result: RunResult | null;

  /** Exact learner input at Run click time; never filled from a later draft. */
  @Column({ type: 'simple-json', nullable: true })
  inputSnapshot: ExecutionRunInputSnapshot | null;

  @Column({ type: 'varchar', nullable: true })
  inputHash: string | null;

  /** Kept as a scalar so polling need not read the full input snapshot. */
  @Column({ type: 'varchar', nullable: true })
  runClock: string | null;

  @Column({ type: 'varchar', nullable: true })
  processingToken: string | null;

  @Column({ type: 'varchar', nullable: true })
  processingLeaseUntil: string | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('assistant_messages')
/**
 * `tokensToday` sums a learner's messages since midnight, twice per mentor
 * question: once to admit the question against the budget and once to bill
 * it, and the instructor console asks it for the whole class on every load.
 * `userId` alone left the date to a scan of that learner's whole term.
 */
@Index('IDX_assistant_messages_user_created', ['userId', 'createdAt'])
export class AssistantMessageEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  enrollmentId: string;

  @Index()
  @Column()
  phaseStateId: string;

  @Column()
  phaseKey: PhaseKey;

  @Column({ default: 'project' })
  conversationScope: 'project' | 'lesson';

  @Column()
  role: 'user' | 'assistant';

  @Column({ type: 'text' })
  content: string;

  @Column({ default: '' })
  provider: string;

  @Column({ default: false })
  cached: boolean;

  @Column({ default: false })
  redacted: boolean;

  @Column({ default: false })
  scopeRedirected: boolean;

  @Column({ type: 'int', default: 0 })
  tokensIn: number;

  @Column({ type: 'int', default: 0 })
  tokensOut: number;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('ai_cache')
export class AiCacheEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column()
  cacheKey: string;

  @Column({ type: 'text' })
  content: string;

  @Column({ default: '' })
  provider: string;

  /** Guardrail metadata must survive cache replay along with the content. */
  @Column({ default: false })
  redacted: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('releases')
/**
 * One release per enrolment and phase, enforced by the database. `advance` is
 * a read-then-write and so is the lookup that guards it, so two concurrent
 * merges (two tabs, or a retried request) both see no release and both
 * insert. A duplicate here is a phase that shipped twice in the learner's
 * history and two `release-v3` nodes in the same list; the unique index is the
 * only place that can be settled atomically.
 */
@Index('UQ_releases_enrollment_phase', ['enrollmentId', 'phaseOrder'], { unique: true })
export class ReleaseRecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column()
  enrollmentId: string;

  @Index()
  @Column()
  userId: string;

  @Column()
  phaseStateId: string;

  @Column()
  phaseKey: PhaseKey;

  @Column({ type: 'int' })
  phaseOrder: number;

  /** v1 .. v6, one per merged phase. */
  @Column()
  version: string;

  @Column({ type: 'float', nullable: true })
  score: number | null;

  /** The merge message. */
  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('audit_events')
/**
 * The audit trail is only ever read newest first, in one of three shapes: the
 * whole trail for an admin, one learner's, or a caller's class plus their own
 * actions. Without an index on `createdAt` all three would be
 * `SCAN audit_events` and then a sort of every row the table held.
 *
 * `id` is the third column of each index rather than a nicety: the order is
 * `createdAt DESC, id DESC`, so an index that stops at `createdAt` still
 * leaves sqlite a temporary b-tree for the tie-break, and same-second rows are
 * the normal case here: an override and its budget change land together.
 */
@Index('IDX_audit_events_created', ['createdAt', 'id'])
@Index('IDX_audit_events_subject_created', ['subjectUserId', 'createdAt', 'id'])
@Index('IDX_audit_events_actor_created', ['actorUserId', 'createdAt', 'id'])
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Explicit type: an indexed-access annotation emits no usable design:type. */
  @Column({ type: 'varchar' })
  event: AuditEventView['event'];

  @Index()
  @Column()
  actorUserId: string;

  /**
   * Null is a tombstone. The account that was the subject asked for deletion:
   * the event and the actor's record of it survive, the person does not. The
   * column is written null only by that deletion: `recordAudit` always names
   * a subject, so a null here means erasure, never a missing value.
   */
  @Index()
  @Column({ type: 'varchar', nullable: true })
  subjectUserId: string | null;

  @Column({ type: 'varchar', nullable: true })
  targetId: string | null;

  @Column({ type: 'varchar', nullable: true })
  action: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'simple-json', nullable: true })
  detail: Record<string, unknown> | null;

  @CreateDateColumn()
  createdAt: Date;
}

/* ------------------------- instructor tooling ------------------------- */

@Entity('regrade_batches')
/**
 * One regrade at a time per class, settled in the database rather than by a
 * read-then-write. Two instructors pressing Regrade on the same class a second
 * apart would otherwise both see no batch and both enqueue a job per learner,
 * and the second batch's verdicts would land on top of the first's while its
 * counters kept counting a total that was never true.
 *
 * A partial unique index, the same trick `UQ_submissions_in_flight` uses:
 * finished and stopped batches fall outside it, so a class keeps its whole
 * history of regrades and only the running one is exclusive. Both dialects
 * take the predicate.
 */
@Index('UQ_regrade_batch_running', ['cohort', 'status'], {
  unique: true,
  where: "status = 'running'",
})
export class RegradeBatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The instructor who asked for it. */
  @Index()
  @Column()
  actorUserId: string;

  /**
   * The class the batch was scoped to (a `users.cohort` value), or '*' for an
   * admin's whole-deployment batch. It is part of the unique index, so the
   * sentinel is what stops two admin batches running at once.
   */
  @Column()
  cohort: string;

  @Column()
  projectSlug: string;

  @Column()
  phaseKey: PhaseKey;

  /** The pack on disk when the batch started; null when it could not be read. */
  @Column({ type: 'varchar', nullable: true })
  packVersionTo: string | null;

  @Column({ default: 'stale-pack' })
  scope: RegradeScope;

  /** At least ten characters, the same rule an override's reason follows. */
  @Column({ type: 'text' })
  reason: string;

  @Column({ default: 'running' })
  status: RegradeBatchStatus;

  @Column({ type: 'int', default: 0 })
  requested: number;

  @Column({ type: 'int', default: 0 })
  done: number;

  @Column({ type: 'int', default: 0 })
  failed: number;

  /**
   * How many learners the batch moved from "not passed" to "passed". The one
   * number the finished notice can say something true with: a regrade never
   * withdraws a pass, so the only movement there can be is upward, and an
   * instructor who has just changed a class's verdicts is owed the size of it.
   */
  @Column({ type: 'int', default: 0 })
  newPasses: number;

  /** Learners the batch could not include, and the sentence saying why. */
  @Column({ type: 'simple-json', nullable: true })
  skipped: RegradeSkip[] | null;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'varchar', nullable: true })
  finishedAt: string | null;
}

@Entity('cohort_phase_schedule')
/**
 * When a class opens a phase, and when its work is due. One row per class,
 * project and phase; the unique index is what makes a save an upsert rather
 * than a growing pile of rows saying different things about the same phase.
 *
 * Both instants are ISO strings in `varchar`, matching `passedAt`,
 * `unlockedAt` and `completedAt` throughout this schema, so no dialect date
 * conversion is involved in reading them and a comparison is string order,
 * which for UTC ISO instants is time order.
 */
@Index('UQ_cohort_phase_schedule', ['cohortId', 'projectSlug', 'phaseKey'], { unique: true })
export class CohortPhaseScheduleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  cohortId: string;

  @Column()
  projectSlug: string;

  @Column()
  phaseKey: PhaseKey;

  /** Before this instant the phase is shut, whatever the learner has passed. */
  @Column({ type: 'varchar', nullable: true })
  opensAt: string | null;

  /** Work after this instant is late. A due date never blocks anything. */
  @Column({ type: 'varchar', nullable: true })
  dueAt: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

@Entity('settings')
export class SettingEntity {
  @PrimaryColumn()
  key: string;

  @Column({ type: 'text' })
  value: string;
}

/* ------------------------- class portability ------------------------- */

@Entity('cohort_imports')
/**
 * One row per class that has been carried onto this laptop as a file.
 *
 * The import itself writes ordinary rows through the ordinary entities, so
 * nothing about the running app has to know an import happened; this table is
 * the record. It answers the two questions an instructor asks afterwards
 * (where did this class come from, and have I already imported this file), and
 * it is the only copy of the other machine's audit trail, which is kept
 * verbatim in `sourceAudit` rather than replayed as rows here. Replaying it
 * would put claims about who did what on *that* machine into this machine's
 * trail, naming actor ids that do not exist here.
 *
 * The sha index is deliberately not unique: importing the same file twice to
 * make a second copy of a class is a supported answer, so the duplicate check
 * is a read and its 409 is overridable.
 *
 * Never swept. `retention.service.ts` prunes execution runs and the AI cache;
 * this table is one row per class ever moved, and losing it would lose the
 * provenance of a class that is still being taught. docs/production-runbook.md §7b says so.
 */
@Index('IDX_cohort_imports_sha', ['documentSha256'])
export class CohortImportEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** The class this import created here. */
  @Index()
  @Column()
  cohortId: string;

  @Column()
  actorUserId: string;

  /** Always 'learnsdlc.cohort'; stored so a later format can be told apart. */
  @Column()
  format: string;

  @Column({ type: 'int' })
  formatVersion: number;

  /** Of the exact bytes received, which is what makes "already imported" a fact. */
  @Column()
  documentSha256: string;

  @Column({ type: 'int' })
  bytes: number;

  /** Free text from the file. Shown to the instructor, never trusted. */
  @Column({ type: 'varchar', nullable: true })
  sourceHost: string | null;

  @Column({ type: 'varchar', nullable: true })
  sourceExportedAt: string | null;

  @Column({ type: 'simple-json', nullable: true })
  includes: CohortExportInclude[] | null;

  @Column({ type: 'simple-json', nullable: true })
  counts: CohortExportCounts | null;

  /** The exported trail, kept verbatim and never turned into rows. */
  @Column({ type: 'simple-json', nullable: true })
  sourceAudit: CohortExportAuditEvent[] | null;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity('warmup_states')
/**
 * One row per learner and project for the warm-up exercise. No route writes
 * or reads this table; it is kept for the rows already stored, which the
 * learner's export and account erasure still carry. It is not a phase: it had
 * no rubric, score or attempt cap and gated nothing. The unique index allows
 * one row per learner and project.
 */
@Index('UQ_warmup_states_user_project', ['userId', 'projectSlug'], { unique: true })
@Index('IDX_warmup_states_user', ['userId'])
export class WarmupStateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  projectSlug: string;

  /** 'not_started' | 'in_progress' | 'done'. */
  @Column({ default: 'not_started' })
  status: WarmupStatus;

  /** Learner-edited file contents, keyed by workspace path. */
  @Column({ type: 'simple-json', nullable: true })
  workspace: Record<string, string> | null;

  /** How many times Submit was pressed. A run that never reached the sandbox is not one. */
  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ type: 'varchar', nullable: true })
  passedAt: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

/* ------------------------------- the bell ------------------------------- */

@Entity('notifications')
/**
 * One row per thing the product has to tell somebody: a gate passed, a review
 * posted, a deadline near, a drill still open, a note from an instructor, or,
 * on the staff side, which learner needs a look.
 *
 * A notification is a pointer, never a record. Every fact it names is also
 * stored somewhere that is kept for the term (the submission, the report, the
 * audit row, the schedule), so the retention rules in
 * `notifications.service.ts` may delete these freely: the bell is about now.
 *
 * `IDX_notifications_user_created` carries `id` as its third column for the
 * reason the audit indexes do: the list sorts
 * `createdAt DESC, id DESC`, and an index that stops at `createdAt` still
 * leaves sqlite a temporary b-tree for the tie-break, which same-second rows
 * make the normal case here: a verdict writes `gate.passed` and
 * `review.posted` together.
 *
 * `UQ_notifications_unread_subject` is what stops the bell repeating itself: a
 * drill that has been open for three days is one unread row, not three,
 * because the sweep's insert loses to the index rather than to a read. Once
 * the row is read the predicate no longer covers it, so a later sweep may
 * write a new one, which is correct, since the learner read it, did nothing,
 * and the drill is still open.
 *
 * NEVER use `queryRunner.addColumn` or `dropColumn` on this table in a later
 * sqlite migration: the driver rebuilds the table from the definition it just
 * read and recreates its indexes without their `WHERE` clause, which would
 * silently drop the predicate above and let the bell repeat itself. Use raw
 * `ALTER TABLE "notifications" ADD COLUMN "x" varchar`.
 */
@Index('IDX_notifications_user_created', ['userId', 'createdAt', 'id'])
@Index('UQ_notifications_unread_subject', ['userId', 'kind', 'subjectKey'], {
  unique: true,
  where: '"readAt" IS NULL',
})
export class NotificationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Who sees it. Always the account the row is for, never the one who caused it. */
  @Column()
  userId: string;

  /** Which bell: a learner's own plan, or an instructor's class. */
  @Column({ default: 'learner' })
  audience: NotificationAudience;

  @Column()
  kind: NotificationKind;

  /** The sentence, written once, at creation, in the product's voice. */
  @Column()
  title: string;

  @Column({ type: 'text', nullable: true })
  detail: string | null;

  /** Always an in-app path, never an absolute URL. */
  @Column()
  href: string;

  @Column({ type: 'varchar', nullable: true })
  phaseKey: string | null;

  /**
   * The natural key of the thing this row is about, deliberately coarse: a
   * phase state for a gate or a drill, a submission for a review, a flag for a
   * stuck answer. Two rows about the same thing collapse into one while the
   * first is unread.
   */
  @Column()
  subjectKey: string;

  /** Who caused it, when that is a person. Null for anything the API noticed itself. */
  @Column({ type: 'varchar', nullable: true })
  actorUserId: string | null;

  /**
   * Null while unread. An ISO instant in a `varchar`, matching `passedAt`,
   * `unlockedAt` and `doneAt` throughout this schema rather than a dialect
   * date: no driver conversion is involved in reading it, and a comparison is
   * string order, which for UTC ISO instants is time order. `createdAt` stays
   * a real date column because the list orders by it.
   */
  @Column({ type: 'varchar', nullable: true })
  readAt: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

export const ALL_ENTITIES = [
  PreviewSessionEntity,
  AgentTurnEntity,
  AgentProposalEntity,
  SubmissionTeacherFeedbackEntity,
  UserEntity,
  CohortEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  // One row per authored task of a phase, and what a reset of one
  // took away. Between the phase state they hang off and the submissions that
  // name a task, which is the order the data model reads in.
  TaskStateEntity,
  TaskResetEntity,
  SubmissionEntity,
  // quizzes: a paper hangs off a phase state and names the submission it was
  // handed in as, so it reads after both, the same parents-first order the
  // rest of this list keeps.
  QuizAttemptEntity,
  ExecutionRunEntity,
  AssistantMessageEntity,
  AiCacheEntity,
  ReleaseRecordEntity,
  AuditEventEntity,
  SettingEntity,
  RegradeBatchEntity,
  CohortPhaseScheduleEntity,
  InstructorNoteEntity,
  CohortImportEntity,
  WarmupStateEntity,
  NotificationEntity,
  // Content as rows. Listed in dependency order (the bytes, the
  // project, its versions, their phases, tasks and files) and last, because
  // nothing hangs off it, the class assignment.
  ContentBlobEntity,
  ProjectEntity,
  ProjectVersionEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectFileEntity,
  CohortProjectAssignmentEntity,
];

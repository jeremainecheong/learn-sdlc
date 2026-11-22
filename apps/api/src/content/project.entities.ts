import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type {
  ArtefactType,
  ArtifactKind,
  PhaseKey,
  PhaseRubric,
  ProjectFileOwnerKind,
  ProjectFileRole,
  ProjectOrigin,
  ProjectVersionStatus,
} from '@learnsdlc/shared';
import type { DeepValidationReceipt } from '@learnsdlc/shared';
import type {
  AssistantContent,
  BuildSpec,
  InterviewBrief,
  PhaseChecks,
  PreviewSpec,
  RuntimeSpec,
  WarmupContent,
} from './content.types';
import type { CompiledSnapshot } from './pack-compiler';

/**
 * A project as rows.
 *
 * A project is not a directory the API walks at boot. These seven tables are
 * where it lives: the bytes once, keyed by their sha, and the
 * metadata that says what each byte *is to the version that holds it*.
 *
 * Two properties are worth reading before the columns.
 *
 * **The compiled snapshot is what the runtime reads.** Rows are the editable
 * truth for the authoring surface; `project_versions.compiled` holds the whole
 * `ProjectContent` the loader builds from a pack, so a phase load, a run and a
 * grading are one JSON column rather than a disk walk. The seed import
 * therefore writes the rows a pack's own shape makes unambiguous and carries
 * everything else in `compiled`: a phase's synthesised sole task is never a
 * row, and a phase's rubric, checks, brief and objectives are the compiled
 * snapshot's.
 *
 * **A role is a property of a `(version, phase, path)`, never of bytes.** Blobs
 * are shared by sha so that a fork copies metadata rather than a megabyte, and
 * in the imported default project five shas are simultaneously a **locked
 * `workspace` row** in one phase and a sealed `solution` file in another. That
 * is why `project_files.role` is the only place a role exists, why it is set at
 * insert and never updated, and why the two byte rules below are asked of *this
 * version's* rows rather than of the platform's whole blob store.
 *
 * `cohort_project_assignments` is here rather than beside the cohort entities
 * because its subject is a project version: it is written by the class panel
 * when a teacher presses Assign.
 */

/* --------------------------------- the bytes ------------------------------ */

@Entity('content_blobs')
/**
 * A pack's bytes, once, keyed by their sha256.
 *
 * `content/tasktrackr` is 992 KB across 161 files, of which `canonical/` is
 * 484 KB, both measured, and the same bytes are reached from many phases: the
 * imported default project's 164 file rows hold 88 distinct blobs. A fork that
 * copied bytes would multiply that per teacher per version; keyed by sha a fork
 * copies metadata only, and a republish that changed one task reuses every
 * other blob.
 *
 * Text, because a project is source: a binary asset arrives base64-encoded
 * rather than as a second column, so that one column is one thing and the
 * digest over it means one thing.
 *
 * Never swept. A blob is reachable from every version that ever referenced it,
 * including archived ones an audit still reads, and 484 KB is not worth the
 * risk of a sweep that misjudges reachability.
 */
export class ContentBlobEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  sha: string;

  @Column({ type: 'text' })
  bytes: string;

  /** Bytes as `Buffer.byteLength(bytes, 'utf-8')`, so a storage report needs no scan. */
  @Column({ type: 'int' })
  size: number;

  @CreateDateColumn()
  createdAt: Date;
}

/* -------------------------------- the project ----------------------------- */

@Entity('projects')
/**
 * One project, whatever it came from. `slug` is what every existing row already
 * keys on (`enrollments.projectSlug`, `warmup_states.projectSlug`,
 * `regrade_batches.projectSlug`), so the swap adds a table beside those rows
 * rather than migrating them.
 *
 * `platformOwned` is explicit and is never inferred from a NULL owner. The two
 * facts are different: the platform's own imported pack has no owner because
 * nobody authored it here, and a teacher's project has no owner once they
 * delete their account. Inferring the first from the second would quietly
 * promote a departed teacher's project to platform content.
 */
@Index('UQ_projects_slug', ['slug'], { unique: true })
@Index('IDX_projects_owner', ['ownerUserId'])
export class ProjectEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  slug: string;

  @Column()
  title: string;

  @Column({ default: false })
  platformOwned: boolean;

  /**
   * The teacher who authored it. NULL on a platform project, and NULL on one
   * whose author deleted their account: in which case the project is
   * **archived** rather than deleted, because the blobs are shared and
   * deleting rows would save nothing and lose a fork's lineage.
   */
  @Column({ type: 'varchar', nullable: true })
  ownerUserId: string | null;

  /**
   * The project a learner who names none is put in, set by the importer.
   * Exactly one row is true.
   *
   * It is on the project rather than on the version so that "the default
   * project's newest published version" resolves a bumped pack's new head with
   * no further write, which is what makes a content fix a version bump rather
   * than a migration.
   */
  @Column({ default: false })
  isDefault: boolean;

  @Column()
  origin: ProjectOrigin;

  @CreateDateColumn()
  createdAt: Date;
}

/** `project_versions.manifest`: everything the pack declares outside its phases. */
export interface ProjectVersionManifest {
  tagline: string;
  description: string;
  language: string;
  languages: string[];
  build?: BuildSpec;
  runtime?: RuntimeSpec;
  preview?: PreviewSpec;
  warmup?: WarmupContent;
}

/** `project_versions.validation`: the last report the validator wrote. */
export interface ProjectVersionValidation {
  findings: { severity: string; message: string }[];
  tier: string;
  when: string;
  /** The last deep validation's receipt, in the same simple-json text; no column of its own. */
  deep?: DeepValidationReceipt;
}

@Entity('project_versions')
/**
 * A version of a project, and the unit the pin points at.
 *
 * **A published version is immutable**, and that is the whole reason the pin
 * works: a learner resolved to a published version cannot have the ground move
 * under an attempt, so a content fix is a new version rather than an edit. The
 * importer reads that rule from the other side: a pack whose `project.json`
 * declares a version that is already published *from different bytes* refuses
 * the boot by name instead of silently doing nothing, which is what stops the
 * redeploy that ships content from becoming a no-op.
 *
 * `UQ_project_versions_draft` is a partial unique index in the shape the
 * codebase already vouches for: Postgres stores a status comparison as
 * `((status)::text = ...)` and still compares it equal, so a migrated database
 * reports no pending schema change (`entities.ts`'s `UQ_submissions_in_flight`
 * note). Archived and published versions fall outside it, so a project keeps
 * every version it ever shipped and only the draft is exclusive.
 */
@Index('UQ_project_versions_version', ['projectId', 'version'], { unique: true })
@Index('IDX_project_versions_status', ['projectId', 'status'])
@Index('UQ_project_versions_draft', ['projectId'], {
  unique: true,
  where: "status = 'draft'",
})
export class ProjectVersionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectId: string;

  /** `MAJOR.MINOR.PATCH`, compared field by field as numbers (`compareProjectVersions`). */
  @Column()
  version: string;

  @Column({ default: 'draft' })
  status: ProjectVersionStatus;

  @Column({ type: 'simple-json' })
  manifest: ProjectVersionManifest;

  /** The `ProjectContent` and compiled tasks the runtime reads; null until compiled. */
  @Column({ type: 'simple-json', nullable: true })
  compiled: CompiledSnapshot | null;

  @Column({ type: 'simple-json', nullable: true })
  validation: ProjectVersionValidation | null;

  /**
   * sha256 over the canonical JSON of the compiled snapshot.
   *
   * The importer's idempotence key, and the reason "already published" can be
   * told apart from "already published from different bytes": the first is a
   * no-op and one log line, the second is a refusal naming the version to bump.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  contentDigest: string | null;

  /** microVMs one full pass of this version costs, set at publish. */
  @Column({ type: 'int', nullable: true })
  sandboxBudget: number | null;

  @Column({ type: 'varchar', nullable: true })
  forkedFromVersionId: string | null;

  /** An ISO string in a varchar, like `passedAt` and `unlockedAt` throughout this schema. */
  @Column({ type: 'varchar', nullable: true })
  publishedAt: string | null;

  /**
   * Who published it. An **actor** column: it is somebody else's record, so a
   * deletion of that account never nulls it (`ACTOR_SCOPED_ENTITIES`,
   * `account.service.ts`): the id stops resolving and the view renders a
   * publisher with no name, exactly as the audit trail already does for a
   * tombstoned subject. NULL on the platform's own imported pack, which nobody
   * published here.
   */
  @Column({ type: 'varchar', nullable: true })
  publishedByUserId: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn()
  createdAt: Date;
}

/* -------------------------------- the phases ------------------------------ */

@Entity('project_phases')
/**
 * One phase of one version: the six, unchanged, in their order.
 *
 * `title` and `intro` are `text` rather than `varchar` because they are prose a
 * teacher writes, and the two unique indexes are what keep a phase list a list:
 * one row per key and one row per position, so a version cannot hold two phase
 * 4s, one of which a learner works and the other of which the map reads.
 */
@Index('UQ_project_phases_key', ['projectVersionId', 'key'], { unique: true })
@Index('UQ_project_phases_order', ['projectVersionId', 'order'], { unique: true })
export class ProjectPhaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectVersionId: string;

  @Column()
  key: PhaseKey;

  /** 1..6. Quoted in every statement: `order` is a reserved word in both dialects. */
  @Column({ type: 'int' })
  order: number;

  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  intro: string;

  /** The default artefact kind for a new task in this phase. */
  @Column()
  artifactKind: ArtifactKind;

  @Column({ default: false })
  canRun: boolean;

  @Column({ default: false })
  canPreview: boolean;

  @Column({ default: '' })
  runLabel: string;

  @Column({ type: 'simple-json' })
  assistant: AssistantContent;

  /**
   * The customer interview, requirements phases only, and sealed: the API
   * answers the fact topics and never the answers until the customer says one
   * out loud. It rides the phase row because it is a document rather than a
   * file the workspace could mount, and every reader reads it from here.
   *
   * The importer also writes its canonical JSON as one `interview` file row per
   * phase that has one, and that row is not a second reader: it exists so the
   * version's own rows carry the sha, because the first byte rule
   * names the `interview` role and a rule with no row to see cannot fire. A
   * version mounting the customer interview's bytes as a workspace file would
   * otherwise have published cleanly.
   */
  @Column({ type: 'simple-json', nullable: true })
  interview: InterviewBrief | null;
}

/* -------------------------------- the tasks ------------------------------- */

@Entity('project_tasks')
/**
 * The grain a score, a reset and a room hang off: one row per authored task.
 *
 * A phase declaring no tasks compiles to exactly one, keyed `''`, and that
 * synthesised sole task is **never a row**: following the platform's own
 * convention for a phase with one run means a single-task phase needs no row,
 * no data migration and no empty key in a URL. Authored tasks (a copy's
 * `main` task, a teacher's added tasks) are rows here.
 *
 * `taskKey` is stable across versions so that a learner's state follows the
 * task rather than its position, which is why it is the key and `order` is not.
 */
@Index('UQ_project_tasks_key', ['projectPhaseId', 'taskKey'], { unique: true })
@Index('UQ_project_tasks_order', ['projectPhaseId', 'order'], { unique: true })
export class ProjectTaskEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectPhaseId: string;

  /** `^[a-z][a-z0-9-]{0,31}$` for an authored task (`isAuthoredTaskKey`). */
  @Column()
  taskKey: string;

  /** Contiguous 1..N within the phase. */
  @Column({ type: 'int' })
  order: number;

  @Column({ default: true })
  required: boolean;

  @Column({ default: false })
  signOff: boolean;

  @Column()
  artefactType: ArtefactType;

  /** What the room reads; unique within the phase, null where the room uses `primaryPath`. */
  @Column({ type: 'varchar', nullable: true })
  artefactPath: string | null;

  @Column()
  title: string;

  @Column({ type: 'text' })
  brief: string;

  @Column({ type: 'simple-json' })
  objectives: string[];

  @Column({ type: 'varchar', nullable: true })
  primaryPath: string | null;

  /** `{ path, symbol }`: where in the codebase the task's work lands. */
  @Column({ type: 'simple-json', nullable: true })
  anchor: { path: string; symbol: string } | null;

  @Column({ type: 'simple-json' })
  rubric: PhaseRubric;

  /** The `PhaseChecks` shape, scoped to the task. */
  @Column({ type: 'simple-json' })
  checks: PhaseChecks;
}

/* -------------------------------- the files ------------------------------- */

@Entity('project_files')
/**
 * What one path is to one version, and the column every seal will rest on.
 *
 * `ProjectContent.files` becomes the rows `WHERE role = 'workspace'`, so a
 * sealed file cannot reach a learner by somebody forgetting a filter: the filter
 * is the row's own column. The role is set when the row is created and is never
 * changed: there is no re-role operation to refuse, and changing a role is a
 * delete and a create, which means the bytes are supplied again and the
 * create's own rules apply to them.
 *
 * `IDX_project_files_blob` is scoped `(projectVersionId, blobSha)` because
 * the two byte rules ask a question about *this version's* rows,
 * does this version hold these bytes under a sealed role, and not about the
 * platform's whole blob store, where the answer is routinely yes and means
 * nothing.
 *
 * `UNIQUE (projectVersionId, ownerId, path)` is the natural key, and it is why a
 * sealed row's `path` is the material's own path inside its owner rather than
 * the workspace path it lands on: the implementation phase mounts
 * `api/repository/tasks.py` as an editable stub and holds the answer to it at
 * `solution/api/repository/tasks.py`, and eight mutants of one workspace file
 * are eight rows under `mutants/<name>/…` rather than one row that kept the
 * last of them.
 */
@Index('UQ_project_files_path', ['projectVersionId', 'ownerId', 'path'], { unique: true })
@Index('IDX_project_files_role', ['projectVersionId', 'role'])
@Index('IDX_project_files_blob', ['projectVersionId', 'blobSha'])
export class ProjectFileEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  projectVersionId: string;

  @Column()
  ownerKind: ProjectFileOwnerKind;

  /** The `projects`, `project_phases` or `project_tasks` row this file hangs off. */
  @Column()
  ownerId: string;

  @Column()
  path: string;

  /** SET AT INSERT, NEVER UPDATED. */
  @Column()
  role: ProjectFileRole;

  @Column({ default: false })
  editable: boolean;

  @Column({ type: 'varchar', nullable: true })
  language: string | null;

  @Column({ type: 'varchar', length: 64 })
  blobSha: string;
}

/* ---------------------------- the class assignment ------------------------ */

@Entity('cohort_project_assignments')
/**
 * Which project a class is working, as a row with a reason and an actor.
 *
 * The class panel writes it and step 2 of the default resolution reads it. The
 * risky part is a partial unique index that has to satisfy the schema
 * builder's zero-pending-queries assertion on both dialects.
 *
 * **`state varchar` rather than `active boolean`, by design.** `UNIQUE (cohortId) WHERE active` cannot be declared: TypeORM's
 * `@Index` carries one `where` string for both dialects, so `active = true` /
 * `active = 1` is not expressible, and a bare boolean predicate on a column
 * sqlite stores as an integer is not the shape Postgres normalises a status
 * comparison to. `WHERE state = 'active'` is that shape by construction, which
 * is what the existing status-comparison indexes vouch for.
 */
@Index('UQ_cohort_project_assignment_active', ['cohortId'], {
  unique: true,
  where: "state = 'active'",
})
@Index('IDX_cohort_project_assignments_cohort', ['cohortId', 'createdAt'])
export class CohortProjectAssignmentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  cohortId: string;

  @Column()
  projectVersionId: string;

  /**
   * The teacher who assigned it. An actor column, so a deletion of that account
   * never nulls it: the assignment is the class's record, not the teacher's.
   */
  @Column()
  assignedByUserId: string;

  /** `'active'` or anything else; only `'active'` is inside the unique index. */
  @Column({ default: 'active' })
  state: string;

  /** Why the class was moved. Read by the audit trail, never by a learner. */
  @Column({ type: 'text' })
  reason: string;

  @CreateDateColumn()
  createdAt: Date;
}

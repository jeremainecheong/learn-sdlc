import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  DRAFT_FIRST_VERSION,
  REQUIREMENTS_OLDER_FORMAT_REFUSAL,
  DESIGN_OLDER_FORMAT_REFUSAL,
  RUNBOOK_OLDER_FORMAT_REFUSAL,
  CHANGE_OLDER_FORMAT_REFUSAL,
  retiredWrittenPhaseUploadRefusal,
  API_CONTRACT_JSON,
  DESIGN_JSON,
  SCREEN_CONTRACT_JSON,
  designContractOffRefusal,
  designDocumentError,
  designDocumentPaths,
  mountedSwitchedOffContract,
  readDesignRecord,
  serialiseDesign,
  validateDesignRecord,
  STORY_JSON,
  INHERITED_TASK_KEY,
  INTERVIEW_PHASE,
  PHASE_INTRO_MAX,
  REPLACE_FILE_CONTENT_MAX,
  applicationFileRefusal,
  fileNotMountedRefusal,
  roomRecordRefusal,
  withheldFileReplaceRefusal,
  PHASE_ARTEFACT_TYPE_SUGGESTION,
  PROJECT_TITLE_MAX,
  PROJECT_VERSION_PATTERN,
  TASK_BRIEF_MAX,
  TASK_KEY_INVALID,
  TASK_TITLE_MAX,
  authorableArtefactTypeRefusal,
  compareProjectVersions,
  draftAlreadyOpenRefusal,
  draftFromStaleHeadRefusal,
  draftOnlyRefusal,
  inheritedTaskRefusal,
  isAuthorableExecutableTask,
  isAuthorableTask,
  isAuthoredTaskKey,
  isAuthoringReadableRole,
  isProjectSlug,
  nextDraftVersion,
  nothingPublishedRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  QUIZ_ONLY_ADD_REFUSAL,
  EMPTY_STORY,
  serialiseStory,
  // Deployment's runbook and Maintenance's change request: the records and the doors' sentences
  CHANGE_REQUEST_JSON,
  DEPLOYMENT_UPLOAD_ONLY,
  ONLY_DEPLOYMENT_RUNBOOK,
  ONLY_MAINTENANCE_CHANGE,
  RUNBOOK_JSON,
  TICKET_WITH_CHANGE,
  noSourceRecordRefusal,
  serialiseChangeRequest,
  serialiseRunbook,
  ticketCoveredRefusal,
  STARTING_CHANGE_UNREADABLE,
  validateChangeRequestRecord,
  validateRunbookRecord,
  // The Phases card and publish's subset rules
  NO_PHASE_TO_PUBLISH,
  PHASE_ORDER,
  PHASE_TITLES,
  PUBLISHED_PHASES_FIXED,
  addByUploadRefusal,
  alreadyHeldRefusal,
  cannotPutBackRefusal,
  keepOnePhaseRefusal,
  phaseSetRefusal,
  unknownPhaseRefusal,
  // Implementation's and Testing's fixed criteria
  FIXED_SCORER_KEYS,
  fixedCriteriaRefusal,
  lockedCriterionRefusal,
  // every text a teacher writes is stored plain
  plainTextOf,
  // a draft that still holds markdown is converted whole once
  htmlCommentWarning,
  markdownKeptWarning,
  markupOnlyWarning,
  plainTextNotesOn,
  type PlainTextMember,
} from '@learnsdlc/shared';
import type {
  AddTaskBody,
  ArtefactType,
  AuthoringAuditEvent,
  AuthoredProjectSummary,
  AuthoredQuiz,
  AuthoringFileView,
  AuthoringLibraryView,
  CreateDraftVersionBody,
  CreateProjectBody,
  CreateProjectResult,
  DraftPhaseView,
  PhaseProvenanceView,
  DraftTaskView,
  DraftVersionView,
  InterviewBody,
  PhaseKey,
  PhaseMutationResult,
  PublishVersionBody,
  PublishVersionResult,
  ReorderTasksBody,
  ReplaceFileBody,
  ReplaceFileResult,
  RubricCriterion,
  SetTaskRequiredBody,
  SupportedStacks,
  TaskMutationResult,
  UpdatePhaseBody,
  UpdateProjectMetaBody,
  UpdateTaskBody,
  UpdateExecutableTaskBody,
  ValidationReport,
} from '@learnsdlc/shared';
import { canonicalJson, sha256Hex } from '../content/blob.store';
import {
  seededDesignDocument,
  validateDesignChecks,
  validateInterviewBrief,
  validateStoryChecks,
} from '../content/content.service';
import { recordPathOf, startingChangeProblem, startingRunbookProblem } from '../content/checks-validation';
import type {
  CodeChecks,
  ConfigChecks,
  DesignChecks,
  PhaseChecks,
  PhaseContent,
  ProjectContent,
  TestsChecks,
} from '../content/content.types';
import {
  isReferenceApplication,
  isReferenceScenario,
  referenceNameOf,
  referencePacks,
} from '../content/reference-content';
import { executableDigestKey, phaseProvenance, referenceExecutableKeys, rememberReferenceExecutable } from './provenance';
import { attachRecordViews, changeChecksFromBody, configViewOf, packCriteriaIn, refuseLockedRubric, runbookChecksFromBody, ticketFromBody } from './record-helpers';
import { ProjectImporterService } from '../content/importer.service';
import type { NewFileRow } from '../content/importer.service';
import {
  STORY_RECORD_PATH,
  contentDigestOf,
  isQuizTask,
  sandboxBudgetFor,
} from '../content/pack-compiler';
import type { CompiledSnapshot } from '../content/pack-compiler';
import { SCREEN_COPY_PATH } from '../content/screen-copy';
import { ProjectRegistryService } from '../content/project-registry.service';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import type { ProjectVersionValidation } from '../content/project.entities';
import { CohortProjectAssignmentEntity } from '../content/project.entities';
import { EnrollmentEntity, SettingEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { UUID_PATTERN } from '../db/uuid';
import {
  authoringFileView,
  blobsToRead,
  contentForDraft,
  draftInterviewViewOf,
  isApplicationPhase,
  draftPhaseView,
  draftTaskView,
  editedExecutableSlice,
  executableTaskViewOf,
  isInheritedTask,
  ownsFor,
  phaseFilesFrom,
  phaseFromTasks,
  sealedRowsToOverlay,
  soleExecutableSliceOf,
  // the editor's words overlay and draft compile, shared with the importer
  compileDraft,
  plainOrRefuse,
  requirePlainText,
  requireText,
  taskWordsPatch,
} from './draft';
import { convertLegacyRequirementsRows } from './legacy-requirements';
import { OLDER_FORMAT_PHASES, isOlderFormat, isStructured, type OlderFormatKey } from '../content/phase-grading';
import { convertLegacyDesignRows, designConversionKey, designConversionOf, olderDesignView, type DesignConversionNote } from './legacy-design';
import { convertLegacyRunbookRows, olderRunbookView } from './legacy-runbook';
import { convertLegacyChangeRows, olderChangeView } from './legacy-change';
import type { LegacyRowsOutcome, RecordReference } from './legacy-rows';
import { insertDocumentRow } from './legacy-rows';
import { ADDED_PHASE_TASK_TITLE, DEFAULT_DESIGN_CRITERION, DEFAULT_STORY_CRITERION, addFromSourceRefusal, addedPhaseContent, isAddedPhaseKey } from './phase-defaults';
import { isOlderWritten } from '../content/older-written';
import type { DraftTaskWithExecutable, SealedRowBytes } from './draft';
// The learner preview's pure builder.
import { learnerPreviewOf } from './learner-preview';
import { COMPILE_CHECK_ID as PREVIEW_COMPILE_CHECK_ID } from './validation';
import type { LearnerPreviewView } from '@learnsdlc/shared';
import { readSupportedStacks } from './runtime-stacks';
import { deepReceiptIsCurrent, fastValidation, rawPackManifestOf } from './validation';
// The quiz door's check and row, shared with the upload door's quiz files.
import { checkedQuiz, quizNeedsQuestionsRefusal, quizRubricFor } from './quiz-rows';
import type { ExecutableValidationInput, ScenarioValidationInput, ValidationPhaseInput } from './validation';
import { checkPackRuns, checkRunLimits } from './upload-limits';
import { runtimeProfileRefusals } from './runtime-stacks';
// The version row's lock, shared with the sealed door
import { lockVersionRow } from './sealed-roles';
import { isReferenceTaskAnchor, rememberReferencePlainAnchors } from '../assistant/project-scope';
import { PROJECT_DESCRIPTION_MAX, PROJECT_TAGLINE_MAX, VERSION_NOTES_MAX } from './authoring.dto';
// The staff starter downloads and their audit event.
import { starterArchive } from './starter-archive';
import type { StarterArchive } from './starter-archive';
import { SEALED_READ_AUDIT_EVENT as STARTER_READ_AUDIT_EVENT } from './sealed-roles';
// A project's first publish pins the null-pinned enrolments waiting on it.
import { hasStoredHead, pinNullRowsAtFirstPublish } from '../content/version-pins';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
// The doors' body readers, the plain-text notes and the views' small conversions, all pure.
import {
  OBJECTIVE_BLANK,
  PLACED_ORDER_BASE,
  ROUTE_KEY_ECHO_MAX,
  checkedInterview,
  clone,
  designChecksFromBody,
  isHtmlCommentNote,
  isoOf,
  markupOnlyMembers,
  phaseSetOf,
  plainTextPatches,
  quizTitleOf,
  reworded,
  rubricFromBody,
  sameStoredCompiled,
  storyChecksFromBody,
  structuredTaskTail,
  withBasePhase,
  writtenText,
  type AddedTaskWords,
} from './authoring-bodies';

/** One version of a project, as the project page lists them. */
export interface AuthoredVersionSummary {
  id: string;
  version: string;
  status: ProjectVersionEntity['status'];
  publishedAt: string | null;
  publishedByUserId: string | null;
  notes: string | null;
  sandboxBudget: number | null;
  createdAt: string;
}

/** What `projects.get` answers: the row of the library, and its versions. */
export interface AuthoredProjectDetail {
  project: AuthoredProjectSummary;
  versions: AuthoredVersionSummary[];
}

/**
 * The stored report: `project_versions.validation` as the editor writes it
 * (deep validation reads the same column as its own `StoredValidation`).
 *
 * `project_versions.validation` is declared as findings, a tier and
 * a stamp, which is what the content checker writes; the editor needs the whole
 * `ValidationReport`, so it rides in a field of its own beside the three rather
 * than replacing them. The existing shape stays true (`findings` is the
 * blocking sentences) so nothing else that reads the column has to learn
 * anything new, and no migration is needed to store a report.
 */
interface ReportedValidation extends ProjectVersionValidation {
  report: ValidationReport;
}

/** The whole of a draft, read once so every derivation sees one snapshot of it. */
interface DraftContext {
  project: ProjectEntity;
  /** What converting this draft's Design from markdown removed, when it was converted (`designConversionOf`). */
  designConversion?: DesignConversionNote | null;
  /** The notes of this draft's plain-text conversion, when its texts were converted (`plainTextNotesOf`). */
  plainTextNotes?: string[] | null;
  version: ProjectVersionEntity;
  phases: ProjectPhaseEntity[];
  /** Task rows by phase row id, in order. */
  tasks: Map<string, ProjectTaskEntity[]>;
  files: ProjectFileEntity[];
  /** The base pack plus everything the rows say, which is what compiles. */
  content: ProjectContent;
  /** The reference project's name as a person reads it, for the provenance views. */
  referenceName: string;
  /**
   * Per executable phase key, the sealed rows whose
   * bytes are not the sole work task's slice (a sealed write), with their bytes.
   * Empty for every untouched phase.
   */
  sealed: Map<string, SealedRowBytes[]>;
  /**
   * The pack's criteria for the inherited Design task while it is still in
   * the older format (`packCriteriaOf`), so the editor's converted view keeps
   * the teacher's own wording as the first design save will; null otherwise.
   */
  designPack: RubricCriterion[] | null;
  /** The same for the inherited Deployment task while it is a config task without a runbook; null otherwise. */
  runbookPack: RubricCriterion[] | null;
  /** The same for the inherited Maintenance task while it is a code task without a change request; null otherwise. */
  changePack: RubricCriterion[] | null;
}

/*
 * The authoring events go into an audit row as they are.
 * `AuditEventView['event']` in `packages/shared/src/contract/feedback.ts` carries every
 * `AuthoringAuditEvent`, so no narrowing cast is needed.
 * `AUTHORING_AUDIT_EVENTS` is the one contract list of the authoring audit
 * names (`audit-events.spec.ts`), not the list of what this file writes:
 * this file writes the editor's own names, and others on
 * the list are written elsewhere: `cohort.project` by the classroom's
 * cohort-project service, `project.uploaded` by UploadService,
 * `project.sealed-read` by SealedRoleService, `project.deep-validation` by
 * DeepValidationService, `project.exported` by the export service, and
 * `class.bulk-signoff` by `instructor/signoff.ts`.
 */

/**
 * The row `readQuizKey` leaves.
 *
 * It is a **read** that leaves a row, which `solution.read` is the precedent
 * for: nothing is written, and who has seen the answer is still a question a
 * class has to be able to answer. Both contract lists carry the name, so
 * this is a typed member of `AuditEventView['event']` and needs no cast, as
 * every authoring name is.
 */
const QUIZ_KEY_AUDIT_EVENT = 'project.quiz-key' as const;

/** The row `readInterview` leaves, for `readQuizKey`'s reason. */
const INTERVIEW_READ_AUDIT_EVENT = 'project.interview-read' as const;

/** The audit and log names the editor's writes carry, each an `AuthoringAuditEvent`. */
const EDIT_EVENT = {
  create: 'project.create',
  update: 'project.update',
  archive: 'project.archive',
  draft: 'project.draft',
  phase: 'project.phase',
  interview: 'project.interview',
  files: 'project.files',
  validate: 'project.validate',
  publish: 'project.publish',
  tasks: 'project.tasks',
} as const satisfies Record<string, AuthoringAuditEvent>;

/** What the scenario rows know about the reference project. */
interface ReferenceFacts {
  /** Its name as a person reads it. */
  name: string;
  /** The stakeholders its published interviews name. */
  personas: string[];
  /**
   * `<phaseKey>|<sha256 of the canonical checks>` of every
   * executable phase of every published version of the reference project:
   * the sealed side of "these bytes are the reference project's", which
   * `isReferenceApplication` (workspace files only) cannot see.
   */
  executable?: ReadonlySet<string>;
}

/** The keys of `project_versions.validation` the fast tier writes; every other key is carried. */
const FAST_TIER_KEYS: ReadonlySet<string> = new Set(['findings', 'tier', 'when', 'report']);

/** persist()'s compare-and-swap on `validation`: tries before it answers a conflict. Exported for `persist-cas.spec.ts`. */
export const PERSIST_SWAP_ATTEMPTS = 4;

/** What persist() answers when every swap missed. */
export const PERSIST_CONFLICT_REFUSAL = 'This draft changed while it was being validated. Validate it again.';

/** A published version never changes, so its executable digests are computed once per process. */
const REFERENCE_EXECUTABLE_MEMO = new Map<string, string[]>();

/**
 * The provided backlog's path, as the reference project lays it out; a copy
 * keeps its paths, and the backlog rows only speak about this one document.
 */
const PROVIDED_BACKLOG_PATH = 'requirements/provided-stories.md';

/** A backlog story heading: `## US-n`, then a separator (a middle dot, colon, dash or em dash), then the title. */
const BACKLOG_STORY_HEADING = /^##\s+(US-\d+)\s*[·:—-]\s*(.+?)\s*$/gm;

/** Whether a brief names a person: the full name, or the first name as a whole word. */
function namesPerson(brief: string, name: string): boolean {
  if (brief.includes(name)) return true;
  const first = name.split(/\s+/)[0].replace(/[^A-Za-z'-]/g, '');
  return first.length > 1 && new RegExp(`\\b${first}\\b`).test(brief);
}

/** A structured phase a draft can still hold in an older form, named as the log says it. */
type LegacyPhase = 'Requirements' | 'Design' | 'Deployment' | 'Maintenance';
/** The structured phases every door that writes a draft converts from their older form, in this order. */
const LEGACY_PHASES: readonly LegacyPhase[] = ['Requirements', 'Design', 'Deployment', 'Maintenance'];
/** What a log calls a phase's older form: the markdown kind for Requirements and Design, the older format for the two record phases. */
const olderFormWord = (phase: LegacyPhase): string => (phase === 'Requirements' || phase === 'Design' ? 'markdown' : 'older-format');
/** The phases publish refuses while any of their tasks is in its older form (`isOlderFormat`), each with its fixed sentence, in `OLDER_FORMAT_PHASES` order (Requirements first). */
const OLDER_FORMAT_REFUSAL: Record<OlderFormatKey, string> = {
  requirements: REQUIREMENTS_OLDER_FORMAT_REFUSAL,
  design: DESIGN_OLDER_FORMAT_REFUSAL,
  deployment: RUNBOOK_OLDER_FORMAT_REFUSAL,
  maintenance: CHANGE_OLDER_FORMAT_REFUSAL,
};
const OLDER_FORMAT_PUBLISH_REFUSALS: readonly (readonly [OlderFormatKey, string])[] = OLDER_FORMAT_PHASES.map((key) => [key, OLDER_FORMAT_REFUSAL[key]] as const);

/** What one pass over the stored drafts converted, refused (and why), and the notes of what moved. */
type LegacyDraftsOutcome = { converted: string[]; refused: { versionId: string; reason: string }[]; notes: string[] };

/**
 * Where a draft's plain-text notes are kept for the editor to draw, as
 * `design-conversion.<versionId>` keeps Design's: `{ notes: string[] }`, each a `markdownKeptWarning` or
 * `htmlCommentWarning` sentence, a phase title and member names, never a teacher's word.
 */
export const plainTextConversionKey = (versionId: string) => `plain-text-conversion.${versionId}`;
/** The receipts of the four record passes, whose refused drafts the plain-text pass leaves as they are. */
const RECORD_PASS_RECEIPT_KEYS = [STORY_MIGRATION_RECEIPT_KEY, DESIGN_MIGRATION_RECEIPT_KEY, RUNBOOK_MIGRATION_RECEIPT_KEY, CHANGE_MIGRATION_RECEIPT_KEY] as const;
/** The plain-text pass's reason for a draft it left because an earlier pass refused it. */
export const EARLIER_PASS_REFUSED = 'an earlier pass refused this draft';
/** The plain-text pass's reason for a draft whose conversion stopped; the receipt holds no word of the draft, so the log says what stopped it. */
export const PLAIN_TEXT_CONVERSION_STOPPED = 'the conversion did not finish, so the draft keeps its texts until its first save';

/** What the boot's plain-text pass did (`convertMarkdownTextDrafts`): ids and counts, and the notes it logs. */
export interface PlainTextDraftsOutcome {
  converted: { versionId: string; phases: number }[];
  refused: { versionId: string; reason: string }[];
  skipped: { versionId: string; reason: string }[];
  /** Each converted draft's notes, one draft to an entry, for the boot's log. */
  notes: string[];
  counts: { drafts: number; phases: number; texts: number; skipped: number; tasktrackrCopies: number };
}

/** What converting one draft's texts did: the phases and texts it changed, its own notes, and every note the draft keeps now. */
interface DraftTextsConversion {
  phases: number;
  texts: number;
  notes: string[];
  held: string[];
}

/**
 * The teacher's side of teacher-authored projects.
 *
 * A teacher lists their projects and the library, copies the platform's project
 * into a draft of their own, edits its phases' tasks and adds concept quizzes, validates,
 * and publishes an immutable version. Five rules run through every door here and
 * are worth reading before the methods.
 *
 * **A teacher edits only what is theirs.** A project the caller cannot see at
 * all answers 404, by the written policy at `instructor/cohort-scope.ts`, so
 * guessing ids tells a second teacher nothing about which projects exist. One
 * they *can* see and do not own answers `projectNotYoursRefusal`, and the
 * platform's own project answers `platformProjectCopyOnlyRefusal`: it is
 * assignable and copyable and never editable in place. `ADMIN` is the role that
 * may read everything; it is not an escape hatch for editing somebody else's
 * project.
 *
 * **A published version never changes.** Every write predicates
 * `status = 'draft'` in its own `WHERE` clause and treats a zero `affected` as a
 * conflict rather than a silent no-op (the compare-and-swap discipline
 * `saveWorkspace` uses) because the pin is only worth anything if the ground
 * cannot move under an attempt.
 *
 * **Rows are written through the importer's doors.** `insertFiles`,
 * `updateFile`, `copyFilesToVersion` and `publishVersion` already carry the
 * importer's two byte rules and the reserved-prefix refusals, so nothing here writes a
 * `project_files` row, a blob or a publish around them.
 *
 * **The compiler is the only compiler.** `compilePack` already refuses a
 * duplicate task key, non-contiguous orders, a phase with no required task, a
 * task with no graded unit, two tasks owning one graded unit, an editable path
 * no task owns and a task graded on a path it does not own. None of that is
 * re-implemented here; it is called, and its throw is carried into the report
 * rather than thrown at a teacher mid-edit.
 *
 * **Sealed bytes never leave.** `files.list` is the only door that carries
 * bytes at all, and only for the roles `isAuthoringReadableRole` admits, which
 * is `workspace` and `warmup`. Every sealed row and the canonical application
 * travel as a path, a role and a size.
 */
@Injectable()
export class AuthoringService {
  private readonly logger = new Logger(AuthoringService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly importer: ProjectImporterService,
    private readonly registry: ProjectRegistryService,
  ) {}

  /* ------------------------------- the library ----------------------------- */

  /** The caller's own projects, and the library they may copy or assign. */
  async listProjects(caller: InstructorCaller): Promise<AuthoringLibraryView> {
    const manager = this.dataSource.manager;
    const projects = await this.visibleProjects(manager, caller);
    const summaries = await this.summariesFor(manager, caller, projects);
    return {
      mine: summaries.filter((one) => one.mine),
      library: summaries.filter((one) => !one.mine && one.platformOwned),
    };
  }

  /** One project, its versions, and which of them is the open draft. */
  async getProject(caller: InstructorCaller, projectId: string): Promise<AuthoredProjectDetail> {
    const manager = this.dataSource.manager;
    const project = await this.requireVisibleProject(manager, caller, projectId);
    const [summary] = await this.summariesFor(manager, caller, [project]);
    const versions = await manager.find(ProjectVersionEntity, { where: { projectId } });
    return {
      project: summary,
      versions: versions
        .sort((a, b) => compareProjectVersions(b.version, a.version))
        .map((row) => ({
          id: row.id,
          version: row.version,
          status: row.status,
          publishedAt: row.publishedAt,
          publishedByUserId: row.publishedByUserId,
          notes: row.notes,
          sandboxBudget: row.sandboxBudget,
          createdAt: isoOf(row.createdAt),
        })),
    };
  }

  /* ----------------------------- create by copy ---------------------------- */

  /**
   * Make a project by copying a published one.
   *
   * The rows are copied and the **blobs are referenced**, which is what makes a
   * hundred forks of TaskTrackr one copy of TaskTrackr and what makes sealed
   * stay sealed through any number of forks: the role travels with the row
   * rather than being re-derived from the bytes, so a copy can never re-role
   * somebody else's hidden suite.
   *
   * A phase of the source compiles to exactly one task keyed `SOLE_TASK_KEY`,
   * which is the empty string and can never be a URL segment, so the copy
   * materialises it as a real `project_tasks` row keyed `main`. That is safe
   * only because it happens on a copy: the new project has no learners, so no
   * state has to follow a key that changed.
   *
   * **Every task of the phase, and not the first one.** A source phase
   * compiles to one task only while nobody has authored a second, and a
   * teacher's published project may hold an artefact task and a quiz beside
   * it. Reading `[0]` would drop the second row without a word, and, where
   * the quiz was ordered first, make *it* the copy's `main` and drop the
   * artefact task, so the copy could not publish and would say so in the
   * compiler's words about graded units rather than in words about quizzes.
   * For a source of sole-task phases the loop runs once per phase and writes
   * one row, which is what the copy specs assert.
   */
  async createProject(
    caller: InstructorCaller,
    body: CreateProjectBody,
  ): Promise<CreateProjectResult> {
    const title = requireText(body.title, 'title', PROJECT_TITLE_MAX);
    const slug = String(body.slug ?? '').trim();
    if (!isProjectSlug(slug)) {
      throw new BadRequestException(
        'A project address is lower case, opens on a letter and is two to forty-eight characters — ' +
          'letters, numbers and hyphens — because it is what every link to this project is built from.',
      );
    }

    const created = await this.dataSource.transaction(async (manager) => {
      if (await manager.findOne(ProjectEntity, { where: { slug } })) {
        throw new ConflictException(
          `"${slug}" is already a project's address on this deployment. Choose another one.`,
        );
      }
      const source = await this.requireVersion(manager, body.fromVersionId);
      const from = await this.requireVisibleProject(manager, caller, source.projectId);
      if (source.status !== 'published') {
        throw new BadRequestException(
          `${from.title} ${source.version} is a ${source.status}, and only a published version can be copied. ` +
            'A draft is still moving, so a copy of one would be a copy of a moment.',
        );
      }
      if (!source.compiled) {
        throw new BadRequestException(
          `${from.title} ${source.version} holds no compiled snapshot, so there is nothing to copy from it.`,
        );
      }

      const project = await manager.save(
        manager.create(ProjectEntity, {
          slug,
          title,
          platformOwned: false,
          ownerUserId: caller.id,
          isDefault: false,
          origin: 'fork',
        }),
      );
      const version = await manager.save(
        manager.create(ProjectVersionEntity, {
          projectId: project.id,
          version: DRAFT_FIRST_VERSION,
          status: 'draft',
          manifest: clone(source.manifest),
          // the copy opens holding the source's compiled pack: it is the base
          // every derivation overlays the rows onto, and it is replaced by this
          // project's own compile before the transaction closes
          compiled: clone(source.compiled),
          validation: null,
          contentDigest: null,
          sandboxBudget: null,
          forkedFromVersionId: source.id,
          publishedAt: null,
          publishedByUserId: null,
          notes: null,
        }),
      );

      // the phases, and the sole task of each one, materialised as a row
      const base = source.compiled.content;
      const ownerMoves = new Map<string, string>();
      for (const phase of base.phases) {
        const moved = await this.copyPhaseRows(manager, source, version, phase, phase.order);
        if (moved) ownerMoves.set(moved.from, moved.to);
      }

      // The importer's own door writes each
      // row under this version's phase and this project as it copies it, so a
      // fork's rows never hang off the *source* version's phases, not even
      // inside this transaction. The file tree's phase and the editable paths
      // a phase mounts are what decide what a task owns. Metadata only: no
      // byte, no role and no path moves.
      await this.importer.copyFilesToVersion(
        manager,
        source.id,
        version.id,
        new Map([...ownerMoves, [from.id, project.id]]),
      );
      // A copy of a version whose Requirements is still the 2.x markdown kind
      // is written as a story draft, one whose Design is still markdown as a
      // design draft, and one whose Deployment or Maintenance is in the older
      // format with its record, before the compile below reads the rows.
      for (const phase of LEGACY_PHASES) {
        await this.convertLegacyAtCopy(manager, version.id, `${from.slug} ${source.version}`, phase);
      }

      const context = await this.load(manager, project.id, version.id);
      const compiled = this.compile(context, version.version);
      await this.persist(manager, context, compiled);

      this.logger.log({
        event: EDIT_EVENT.create,
        actorId: caller.id,
        projectId: project.id,
        slug,
        fromVersionId: source.id,
        fromSlug: from.slug,
      });
      await recordAudit(manager, {
        event: EDIT_EVENT.create,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: project.id,
        action: slug,
        detail: {
          slug,
          title,
          copiedFrom: { projectSlug: from.slug, version: source.version, versionId: source.id },
          draftVersion: version.version,
        },
      });
      return { project, version };
    });

    const [summary] = await this.summariesFor(this.dataSource.manager, caller, [created.project]);
    return {
      project: summary,
      draftVersionId: created.version.id,
      draftVersion: created.version.version,
    };
  }

  /* -------------------------------- the meta ------------------------------- */

  /** The title on the project row; the tagline and description on the draft. */
  async updateMeta(
    caller: InstructorCaller,
    projectId: string,
    body: UpdateProjectMetaBody,
  ): Promise<AuthoredProjectSummary> {
    const project = await this.dataSource.transaction(async (manager) => {
      const owned = await this.requireOwnedProject(manager, caller, projectId);
      const moved: Record<string, unknown> = {};
      // A tagline or a description is written on the draft's own row, so that
      // row is locked before the project's title is written (every draft
      // writer locks the version row first).
      const words = body.tagline !== undefined || body.description !== undefined;
      const open = words
        ? await manager.findOne(ProjectVersionEntity, { where: { projectId: owned.id, status: 'draft' }, select: { id: true } })
        : null;
      if (open) await this.lockDraftRow(manager, open.id);

      if (body.title !== undefined) {
        const title = requireText(body.title, 'title', PROJECT_TITLE_MAX);
        await manager.update(ProjectEntity, { id: owned.id }, { title });
        moved.title = title;
      }

      if (body.tagline !== undefined || body.description !== undefined) {
        const draft = await manager.findOne(ProjectVersionEntity, {
          where: { projectId: owned.id, status: 'draft' },
        });
        if (!draft) {
          throw new ConflictException(
            `${owned.title} has no open draft, and a published version keeps the words it shipped with. ` +
              'Publish a new version to change what a class reads.',
          );
        }
        const manifest = { ...draft.manifest };
        if (body.tagline !== undefined) {
          manifest.tagline = requireText(body.tagline, 'tagline', PROJECT_TAGLINE_MAX);
          moved.tagline = manifest.tagline;
        }
        if (body.description !== undefined) {
          manifest.description = requireText(body.description, 'description', PROJECT_DESCRIPTION_MAX);
          moved.description = manifest.description;
        }
        await this.guarded(manager, draft, { manifest });
      }

      if (Object.keys(moved).length === 0) {
        throw new BadRequestException('Nothing was sent to change.');
      }

      this.logger.log({ event: EDIT_EVENT.update, actorId: caller.id, projectId: owned.id, moved: Object.keys(moved) });
      await recordAudit(manager, {
        event: EDIT_EVENT.update,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: owned.id,
        action: owned.slug,
        detail: moved,
      });
      return manager.findOneByOrFail(ProjectEntity, { id: owned.id });
    });

    const [summary] = await this.summariesFor(this.dataSource.manager, caller, [project]);
    return summary;
  }

  /**
   * Withdraw a project from the library.
   *
   * Refused by name while any enrolment pins one of its versions: a learner
   * inside an attempt is the one thing a withdrawal must never be able to break,
   * and the honest answer is that the class has to be moved first.
   */
  async archiveProject(caller: InstructorCaller, projectId: string): Promise<AuthoredProjectSummary> {
    const project = await this.dataSource.transaction(async (manager) => {
      const owned = await this.requireOwnedProject(manager, caller, projectId);
      const versions = await manager.find(ProjectVersionEntity, { where: { projectId: owned.id } });
      const ids = versions.map((one) => one.id);

      // The question is "does an enrolment resolve this project", not "does a
      // pin name one of its versions". `enrollments.projectVersionId` is
      // nullable and a null resolves the published head, and nothing on the
      // ordinary enrolment path writes the pin at all, so counting pins alone
      // made this refusal empty in practice and archived every version under a
      // class mid-attempt. `account.service.ts` asks it the same way and says
      // so at length; the slug half is what catches the head-resolving rows,
      // and a row matching both halves is counted once.
      const pinned = await manager.count(EnrollmentEntity, {
        where: ids.length
          ? [{ projectSlug: owned.slug }, { projectVersionId: In(ids) }]
          : [{ projectSlug: owned.slug }],
      });
      if (pinned > 0) {
        throw new ConflictException(
          `${owned.title} cannot be withdrawn while ${pinned === 1 ? '1 learner is' : `${pinned} learners are`} ` +
            'working a version of it. Move those classes to another project first; withdrawing it now would ' +
            'take the ground out from under an attempt.',
        );
      }
      const assigned = ids.length
        ? await manager.count(CohortProjectAssignmentEntity, {
            where: { projectVersionId: In(ids), state: 'active' },
          })
        : 0;
      if (assigned > 0) {
        throw new ConflictException(
          `${owned.title} is the project ${assigned === 1 ? '1 class is' : `${assigned} classes are`} assigned to. ` +
            'Assign those classes another project first.',
        );
      }

      for (const version of versions) {
        if (version.status === 'archived') continue;
        await manager.update(ProjectVersionEntity, { id: version.id }, { status: 'archived' });
      }

      this.logger.log({ event: EDIT_EVENT.archive, actorId: caller.id, projectId: owned.id, versions: ids.length });
      await recordAudit(manager, {
        event: EDIT_EVENT.archive,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: owned.id,
        action: owned.slug,
        detail: { slug: owned.slug, title: owned.title, versions: versions.map((one) => one.version) },
      });
      return owned;
    });

    await this.registry.load();
    const [summary] = await this.summariesFor(this.dataSource.manager, caller, [project]);
    return summary;
  }

  /* --------------------------- the next draft ------------------------------ */

  /**
   * Open the next draft from the published head, so a published project can be
   * edited again.
   *
   * Publishing flips a project's one draft row to `published`, and without
   * this the teacher's own project would then be as fixed as the platform's.
   * This is the door back, and everything about it is decided
   * by one fact: **the version a class is pinned to must not move**. So nothing
   * here touches the head. The head's phase rows, task rows and file rows are
   * *copied* into a new version, blobs by reference exactly as `projects.create`
   * copies a published one, and the head keeps its snapshot, its digest and its
   * publish stamp byte for byte.
   *
   * **`fromVersionId` is a guard, not a choice of parent.** The draft always
   * opens from the head. A `fromVersionId` that is not the head any more means a
   * second teacher published while this page was open, and honouring it would
   * copy older rows and quietly undo what they published, so it is refused with
   * `draftFromStaleHeadRefusal` and the head's real version is in the sentence.
   *
   * **At most one draft per project**, which is the rule every other route is
   * written against: `projects.get` answers one `draftVersionId`, not a list.
   * The common case is read and refused by name; the race is closed by
   * `UQ_project_versions_draft`, an existing partial unique index, so
   * there is no new migration and no new constraint. The insert asks the
   * database to ignore a conflict rather than to raise one, and then re-reads:
   * the row that came back being somebody else's is the conflict, never a silent
   * success, which is the compare-and-swap discipline `guarded` uses one table
   * over.
   *
   * The draft opens at `nextDraftVersion(head)`: a patch bump, which publish
   * will always accept because it refuses anything that is not newer than the
   * head. A teacher who wants 1.1.0 types it at publish; one who changes nothing
   * can still publish.
   */
  async createDraftVersion(
    caller: InstructorCaller,
    projectId: string,
    body: CreateDraftVersionBody,
  ): Promise<DraftVersionView> {
    const fromVersionId = String(body?.fromVersionId ?? '').trim();

    const opened = await this.dataSource.transaction(async (manager) => {
      const project = await this.requireOwnedProject(manager, caller, projectId);
      const versions = await manager.find(ProjectVersionEntity, {
        where: { projectId: project.id },
      });

      // The order the contract fixes, so a teacher never reads two wordings for
      // one refusal: a draft already open answers before "nothing published",
      // because a project whose draft is open and whose first publish has not
      // happened is the first of those and not the second.
      const held = versions.find((one) => one.status === 'draft');
      if (held) throw new ConflictException(draftAlreadyOpenRefusal(held.version));

      const head = versions
        .filter((one) => one.status === 'published')
        .sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      if (!head) {
        // A withdrawn project reaches here too, and it is not the same state:
        // `archiveProject` flips *every* row, the draft included, so it holds
        // versions and has neither a draft to publish nor a published head.
        // `nothingPublishedRefusal` would tell that teacher two false things,
        // so the two states answer in their own words. Anything else with no
        // draft and no published row (a project whose only version was deleted)
        // is the sentence it always was.
        const withdrawn =
          versions.length > 0 && versions.every((one) => one.status === 'archived');
        throw new ConflictException(
          withdrawn ? withdrawnProjectRefusal(project.title) : nothingPublishedRefusal(project.title),
        );
      }
      if (head.id !== fromVersionId) {
        throw new ConflictException(draftFromStaleHeadRefusal(head.version));
      }
      if (!head.compiled) {
        // Unreachable through the publish door, which refuses a version with no
        // snapshot; a refusal is still better than a draft with nothing to
        // author against.
        throw new ConflictException(
          `${project.title} ${head.version} holds no compiled snapshot, so there is nothing to open a draft from.`,
        );
      }

      const versionId = randomUUID();
      const version = nextDraftVersion(head.version);
      await manager
        .createQueryBuilder()
        .insert()
        .into(ProjectVersionEntity)
        .values({
          id: versionId,
          projectId: project.id,
          version,
          status: 'draft',
          // the draft opens holding the head's compiled pack: it is the base
          // every derivation overlays the rows onto, and it is replaced by this
          // version's own compile before the transaction closes
          manifest: clone(head.manifest),
          compiled: clone(head.compiled),
          validation: null,
          contentDigest: null,
          sandboxBudget: null,
          forkedFromVersionId: head.id,
          publishedAt: null,
          publishedByUserId: null,
          notes: null,
        })
        .orIgnore()
        .execute();

      const mine = await manager.findOne(ProjectVersionEntity, {
        where: { projectId: project.id, status: 'draft' },
      });
      if (!mine || mine.id !== versionId) {
        // Somebody else's insert won the index. Theirs opened from the same head
        // and carries the same number, which is what the sentence names.
        throw new ConflictException(draftAlreadyOpenRefusal(mine?.version ?? version));
      }

      // The rows, not the snapshot: the head's phases and tasks are what the
      // teacher published, keys included, and a learner's state follows the key.
      const sourcePhases = (
        await manager.find(ProjectPhaseEntity, { where: { projectVersionId: head.id } })
      ).sort((a, b) => a.order - b.order);
      const sourcePhaseIds = sourcePhases.map((one) => one.id);
      const sourceTasks = sourcePhaseIds.length
        ? await manager.find(ProjectTaskEntity, { where: { projectPhaseId: In(sourcePhaseIds) } })
        : [];
      const ownerMoves = new Map<string, string>();

      for (const phase of sourcePhases) {
        const row = await manager.save(
          manager.create(ProjectPhaseEntity, {
            projectVersionId: versionId,
            key: phase.key,
            order: phase.order,
            title: phase.title,
            intro: phase.intro,
            artifactKind: phase.artifactKind,
            canRun: phase.canRun,
            canPreview: phase.canPreview,
            runLabel: phase.runLabel,
            assistant: clone(phase.assistant),
            interview: phase.interview ? clone(phase.interview) : null,
          }),
        );
        ownerMoves.set(phase.id, row.id);
        const tasks = sourceTasks
          .filter((one) => one.projectPhaseId === phase.id)
          .sort((a, b) => a.order - b.order);
        for (const task of tasks) {
          await manager.save(
            manager.create(ProjectTaskEntity, {
              projectPhaseId: row.id,
              taskKey: task.taskKey,
              order: task.order,
              required: task.required,
              signOff: task.signOff,
              artefactType: task.artefactType,
              artefactPath: task.artefactPath,
              title: task.title,
              brief: task.brief,
              objectives: clone(task.objectives ?? []),
              primaryPath: task.primaryPath,
              anchor: task.anchor ? clone(task.anchor) : null,
              rubric: clone(task.rubric),
              checks: clone(task.checks),
            }),
          );
        }
      }

      // The copies are written hanging off
      // this draft's own phase rows, for the reason `createProject` gives. The
      // project-owned rows already name this project, so the map does not name
      // it and they keep it. Metadata only: no byte, no role and no path moves.
      await this.importer.copyFilesToVersion(manager, head.id, versionId, ownerMoves);
      // The next draft of a version published before a structured form opens
      // with that phase converted, Requirements first.
      for (const phase of LEGACY_PHASES) {
        await this.convertLegacyAtCopy(manager, versionId, `${project.slug} ${head.version}`, phase);
      }

      const context = await this.load(manager, project.id, versionId);
      const compiled = this.compile(context, version);
      await this.persist(manager, context, compiled);

      this.logger.log({
        event: EDIT_EVENT.draft,
        actorId: caller.id,
        projectId: project.id,
        versionId,
        version,
        fromVersionId: head.id,
      });
      await recordAudit(manager, {
        event: EDIT_EVENT.draft,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: project.id,
        action: version,
        detail: {
          versionId,
          version,
          slug: project.slug,
          fromVersionId: head.id,
          fromVersion: head.version,
        },
      });

      return versionId;
    });

    // Re-read rather than answer from the transaction's own context: `persist`
    // wrote the report the editor opens on, and this is the same shape
    // `version.draft` answers, so the editor routes straight into the draft it
    // just opened without a second request.
    return this.readDraft(caller, projectId, opened);
  }

  /* ------------------ drafts of the older structured phases ------------------ */

  /**
   * One draft's rows of one structured phase converted from its older form:
   * Requirements to a story (`convertLegacyRequirementsRows`), Design to a
   * design (`convertLegacyDesignRows`), Deployment to a runbook
   * (`convertLegacyRunbookRows`) and Maintenance to a change request
   * (`convertLegacyChangeRows`). The last three read the pack's criteria for
   * the inherited task so the teacher's own wording is told apart, as the
   * builder's first save does, and the two record phases ask whether the copy
   * is the reference's own older phase (`referenceFor`), which converts to the
   * reference's current phase exactly. Null when the draft holds nothing of
   * that phase to convert. The walker the copy, the next draft and the
   * stored-draft pass share; the builder's first save calls each converter
   * itself, with a criteria callback for its task.
   */
  private convertLegacyRows(manager: EntityManager, versionId: string, phase: LegacyPhase): Promise<LegacyRowsOutcome | null> {
    if (phase === 'Requirements') return convertLegacyRequirementsRows(manager, versionId);
    // only ever asked for the inherited task (the converters read the pack's wording for it alone)
    const criteria = (key: PhaseKey) => async () =>
      this.packCriteriaOf(manager, await manager.findOneByOrFail(ProjectVersionEntity, { id: versionId }), key, INHERITED_TASK_KEY);
    if (phase === 'Design') return convertLegacyDesignRows(manager, versionId, criteria('design'));
    if (phase === 'Deployment') return convertLegacyRunbookRows(manager, versionId, criteria('deployment'), undefined, () => this.referenceFor(manager, versionId, 'deployment'));
    return convertLegacyChangeRows(manager, versionId, criteria('maintenance'), undefined, () => this.referenceFor(manager, versionId, 'maintenance'));
  }

  /**
   * What the exact conversion of a copied reference phase reads:
   * the phase the draft compiles to now, before the conversion (null when it
   * does not compile), and the reference project's current phase of that key
   * (`referencePhase`). The draft's phase is read even when the reference's is
   * missing, so a copy of the reference's older phase that cannot convert to
   * it exactly says so in its note rather than falling back in silence.
   */
  private async referenceFor(manager: EntityManager, versionId: string, key: 'deployment' | 'maintenance'): Promise<RecordReference> {
    const draftRow = await manager.findOneByOrFail(ProjectVersionEntity, { id: versionId });
    const context = await this.load(manager, draftRow.projectId, versionId);
    const compiled = this.compile(context, draftRow.version);
    return {
      draft: compiled.snapshot?.content.phases.find((one) => one.key === key) ?? null,
      current: await this.referencePhase(manager, key),
    };
  }

  /**
   * The reference project's current phase of `key` with its one work task and
   * the name a note gives it, read from its newest published version (the
   * snapshot the boot imported and the registry serves). Null when the
   * reference project, its published snapshot or a structured phase of that
   * key with one work task is missing.
   */
  private async referencePhase(manager: EntityManager, key: 'deployment' | 'maintenance'): Promise<RecordReference['current']> {
    const [slug] = referencePacks();
    const project = slug ? await manager.findOne(ProjectEntity, { where: { slug, platformOwned: true } }) : null;
    if (!project) return null;
    const published = await manager.find(ProjectVersionEntity, { where: { projectId: project.id, status: 'published' }, select: { id: true, version: true } });
    const head = published.sort((a, b) => compareProjectVersions(b.version, a.version))[0];
    const headRow = head ? await manager.findOne(ProjectVersionEntity, { where: { id: head.id }, select: { id: true, version: true, compiled: true } }) : null;
    const phase = headRow?.compiled?.content.phases.find((one) => one.key === key) ?? null;
    if (!phase || !isStructured(key, phase.checks)) return null;
    const work = (headRow!.compiled!.phases.find((one) => one.key === key)?.tasks ?? []).filter((one) => !isQuizTask(one));
    if (work.length !== 1) return null;
    return { phase, task: work[0], name: `${referenceNameOf(project.title)} ${headRow!.version}` };
  }

  /**
   * A copy's rows of one structured phase converted from the older markdown
   * kind (`convertLegacyRows`). A copy the adapter cannot convert is still
   * made, as it was, and the log says why: refusing it would block the only
   * door to a draft of that version, and the builder's first structured save
   * converts it later.
   */
  private async convertLegacyAtCopy(manager: EntityManager, versionId: string, from: string, phase: LegacyPhase): Promise<void> {
    const outcome = await this.convertLegacyRows(manager, versionId, phase);
    if (!outcome) return;
    if (outcome.converted) this.logger.log(`a draft copied from ${from}: ${outcome.note}`);
    else this.logger.warn(`a draft copied from ${from} keeps its ${olderFormWord(phase)} ${phase}: ${outcome.reason}`);
  }

  /**
   * Every draft still holding a Requirements task of the 2.x markdown kind,
   * converted and recompiled (`convertLegacyDrafts`). Run once at boot by
   * `DraftConversionService`, which keeps the receipt.
   */
  convertLegacyRequirementsDrafts(): Promise<LegacyDraftsOutcome> {
    return this.convertLegacyDrafts('Requirements');
  }

  /**
   * Every draft still holding a Design task of the markdown kind, converted
   * and recompiled (`convertLegacyDrafts`). Every door that writes a draft
   * converts a markdown Design, so this finds only drafts stored before the
   * design kind and those a door could not convert; the builder's first design
   * save converts any one of them on its own. Run once at boot by
   * `DraftConversionService`, which keeps the receipt.
   */
  convertLegacyDesignDrafts(): Promise<LegacyDraftsOutcome> {
    return this.convertLegacyDrafts('Design');
  }

  /**
   * Every draft still holding a Deployment task in the older format (a config
   * task with no runbook), converted and recompiled (`convertLegacyDrafts`).
   * Every door that writes a draft converts one, so this finds drafts stored
   * before the runbook record and those a door could not convert. Run once at
   * boot by `DraftConversionService`, which keeps the receipt.
   */
  convertLegacyRunbookDrafts(): Promise<LegacyDraftsOutcome> {
    return this.convertLegacyDrafts('Deployment');
  }

  /**
   * Every draft still holding a Maintenance task in the older format (a code
   * task with no change request), converted and recompiled, as
   * `convertLegacyRunbookDrafts` converts Deployment.
   */
  convertLegacyChangeDrafts(): Promise<LegacyDraftsOutcome> {
    return this.convertLegacyDrafts('Maintenance');
  }

  /**
   * Every draft still holding a task in the older form of `phase`,
   * converted and recompiled, each in a transaction of its own; one that does
   * not convert, does not compile once converted, or fails for any other
   * reason is rolled back and listed with the reason, and the next is tried.
   * Every other older phase of the same draft converts in the same
   * transaction before the compile, so a draft holding several is converted
   * whole by the first pass that finds it: that pass's receipt carries every
   * conversion in one note, and the later passes find nothing of it. Drafts
   * stored before each structured form are the only ones left, with those a
   * door could not convert, because every door that writes a draft converts
   * every older phase.
   */
  private async convertLegacyDrafts(phase: LegacyPhase): Promise<LegacyDraftsOutcome> {
    const drafts = await this.dataSource
      .getRepository(ProjectVersionEntity)
      .find({ where: { status: 'draft' }, select: { id: true, projectId: true, version: true } });
    const out: LegacyDraftsOutcome = { converted: [], refused: [], notes: [] };
    for (const draft of drafts.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const refusal = new Error('refused');
      let reason = '';
      try {
        await this.dataSource.transaction(async (manager) => {
          await this.lockDraftRow(manager, draft.id);
          const outcome = await this.convertLegacyRows(manager, draft.id, phase);
          if (!outcome) return;
          if (!outcome.converted) {
            reason = outcome.reason;
            throw refusal;
          }
          // A sibling still in an older format would keep the draft from
          // compiling, so it converts here too, as the copy and next-draft
          // doors convert every one; one that refuses is skipped (it writes
          // nothing) and the compile decides, its reason named first.
          const notes = [outcome.note];
          const kept: string[] = [];
          for (const other of LEGACY_PHASES) {
            if (other === phase) continue;
            const sibling = await this.convertLegacyRows(manager, draft.id, other);
            if (sibling?.converted) notes.push(sibling.note);
            else if (sibling) kept.push(`its ${other} keeps the older format (${sibling.reason})`);
          }
          const context = await this.load(manager, draft.projectId, draft.id);
          const compiled = this.compile(context, draft.version);
          if (!compiled.snapshot) {
            reason = [...kept, `the converted draft does not compile: ${compiled.error}`].join('; ');
            throw refusal;
          }
          await this.persist(manager, context, compiled);
          out.converted.push(draft.id);
          // each conversion's note a sentence of its own, so the log line never runs one into the next
          out.notes.push(notes.map((note) => (note.endsWith('.') ? note : `${note}.`)).join(' '));
        });
      } catch (error) {
        // Anything else that stops one draft (a draft written by something
        // that did not finish, say) is that draft's refusal, never the boot's.
        out.refused.push({ versionId: draft.id, reason: error === refusal ? reason : (error as Error).message });
      }
    }
    return out;
  }

  /**
   * Every teacher's draft that still holds a text with markdown in it,
   * stored plain once, each in a transaction of its own
   * (`convertDraftTexts`), then compiled and persisted as `mutateDraft` does:
   * a draft that did not compile before the conversion is stored with its
   * newest texts as any save stores it. A draft any of the four record passes
   * refused (their receipts' `drafts.refused`, read first) is skipped and
   * named, so this pass never writes over a draft those passes left for its
   * teacher; its first save converts it. A draft whose conversion stops
   * is rolled back and named with a fixed reason, and the next is tried. Run
   * once at boot by `DraftConversionService`, after the four, which keeps the
   * receipt.
   */
  async convertMarkdownTextDrafts(): Promise<PlainTextDraftsOutcome> {
    const refusedEarlier = await this.recordPassRefusals();
    const drafts = await this.dataSource
      .getRepository(ProjectVersionEntity)
      .find({ where: { status: 'draft' }, select: { id: true, projectId: true, version: true } });
    const platform = new Set(
      (await this.dataSource.getRepository(ProjectEntity).find({ where: { platformOwned: true }, select: { id: true } })).map((one) => one.id),
    );
    const out: PlainTextDraftsOutcome = { converted: [], refused: [], skipped: [], notes: [], counts: { drafts: 0, phases: 0, texts: 0, skipped: 0, tasktrackrCopies: 0 } };
    for (const draft of drafts.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (platform.has(draft.projectId)) continue;
      if (refusedEarlier.has(draft.id)) {
        out.skipped.push({ versionId: draft.id, reason: EARLIER_PASS_REFUSED });
        continue;
      }
      try {
        await this.dataSource.transaction(async (manager) => {
          await this.lockDraftRow(manager, draft.id);
          const done = await this.convertDraftTexts(manager, draft.id);
          if (!done) return;
          const context = await this.load(manager, draft.projectId, draft.id);
          await this.persist(manager, context, this.compile(context, draft.version));
          out.converted.push({ versionId: draft.id, phases: done.phases });
          out.counts.phases += done.phases;
          out.counts.texts += done.texts;
          if (await this.isReferenceCopy(manager, context.version)) out.counts.tasktrackrCopies += 1;
          out.notes.push(done.notes.join(' '));
        });
      } catch (error) {
        // A draft written by something that did not finish, say: that draft's refusal, never the boot's.
        this.logger.warn(`plain-text drafts: a stored draft keeps its markdown: ${(error as Error).message}`);
        out.refused.push({ versionId: draft.id, reason: PLAIN_TEXT_CONVERSION_STOPPED });
      }
    }
    out.counts.drafts = out.converted.length;
    out.counts.skipped = out.skipped.length;
    return out;
  }

  /** The version ids the four record passes refused, from their receipts' `drafts.refused`; an unreadable receipt names none. */
  private async recordPassRefusals(): Promise<Set<string>> {
    const rows = await this.dataSource.getRepository(SettingEntity).find({ where: { key: In([...RECORD_PASS_RECEIPT_KEYS]) } });
    const ids = new Set<string>();
    for (const row of rows) {
      try {
        const refused = (JSON.parse(row.value) as { drafts?: { refused?: unknown } }).drafts?.refused;
        if (!Array.isArray(refused)) continue;
        for (const one of refused) if (typeof (one as { versionId?: unknown })?.versionId === 'string') ids.add((one as { versionId: string }).versionId);
      } catch {
        // a receipt that does not parse names no draft
      }
    }
    return ids;
  }

  /** Whether a draft began as a copy of the reference project (TaskTrackr): the first platform version up its fork chain is the reference's. */
  private async isReferenceCopy(manager: EntityManager, version: ProjectVersionEntity): Promise<boolean> {
    const [slug] = referencePacks();
    const platform = slug ? await this.platformVersionOf(manager, version) : null;
    if (!platform) return false;
    return (await manager.findOne(ProjectEntity, { where: { id: platform.projectId }, select: { id: true, slug: true } }))?.slug === slug;
  }

  /**
   * Every text of one draft stored as `plainTextOf` of it where it is not
   * plain: each phase's intro, and each task's title, brief,
   * objectives and rubric sentences, a quiz's stems, options, explanations
   * and concept labels, a ticket's lines, a provided story's text with the
   * learner story's hints, and a Design story's title and line
   * (`plainTextPatches`). Only a changed column is
   * written. Null when nothing was converted, so a plain draft is never
   * touched, its notes neither.
   *
   * Every markdown text in the draft is converted and counted, a text copied
   * from the platform's pack included: an untouched copy of
   * TaskTrackr 5.0.0 or earlier, whose briefs are markdown, is converted too
   * (TaskTrackr 6.0.0's are plain, so a copy of it converts nothing), and it
   * still reads `reference` to the reviewer, the mentor, deep validation and
   * provenance through the reference anchors' plain-text twin
   * (`rememberReferencePlainAnchors`, `referenceExecutableKeys`), read from
   * every published reference version at boot (`rememberReferenceTwins`).
   *
   * The notes: one per phase that changed, naming its members
   * (`markdownKeptWarning`); after it, one per phase whose texts held only
   * markup and are now empty, naming each member emptied
   * (`markupOnlyWarning`: this pass is not a door, so it stores the empty
   * text and tells the teacher rather than refuse); and one per phase whose
   * stored texts hold an HTML comment, naming every member that holds one
   * (`htmlCommentWarning`, computed on the plain text stored). They join the draft's
   * `plain-text-conversion.<versionId>` row: a note already there is kept, a
   * phase the draft no longer holds keeps none, and the notes stand in the
   * draft's phase order. The caller compiles and persists, in its own
   * transaction.
   */
  private async convertDraftTexts(manager: EntityManager, versionId: string): Promise<DraftTextsConversion | null> {
    const phases = (await manager.find(ProjectPhaseEntity, { where: { projectVersionId: versionId } })).sort((a, b) => a.order - b.order);
    const tasks = phases.length ? await manager.find(ProjectTaskEntity, { where: { projectPhaseId: In(phases.map((one) => one.id)) } }) : [];
    const pass = plainTextPatches(phases, tasks);
    if (pass.texts === 0) return null;
    for (const [id, intro] of pass.intros) await manager.update(ProjectPhaseEntity, { id }, { intro });
    for (const [id, patch] of pass.tasks) await manager.update(ProjectTaskEntity, { id }, patch as never);

    const notes: string[] = [];
    for (const phase of phases) {
      const title = PHASE_TITLES[phase.key];
      const changed = pass.changed.get(phase.id);
      if (changed?.size) notes.push(markdownKeptWarning(title, [...changed]));
      const emptied = pass.emptied.get(phase.id);
      if (emptied?.size) notes.push(markupOnlyWarning(title, [...emptied]));
      const commented = pass.commented.get(phase.id);
      if (commented?.size) notes.push(htmlCommentWarning(title, [...commented]));
    }
    const held = await this.plainTextNotesOf(manager, versionId);
    const kept = phases.flatMap((phase) => {
      const mine = plainTextNotesOn([...(held ?? []), ...notes], PHASE_TITLES[phase.key]);
      return [...new Set(mine)];
    });
    await manager.save(SettingEntity, { key: plainTextConversionKey(versionId), value: JSON.stringify({ notes: kept }) });
    return { phases: pass.changed.size, texts: pass.texts, notes, held: kept };
  }

  /**
   * The notes a draft's plain-text conversion kept (`plainTextConversionKey`),
   * or null when it has none: a row that holds no note reads as none, so the
   * draft view carries `plainTextConversion` only when there is a note to
   * draw.
   */
  private async plainTextNotesOf(manager: EntityManager, versionId: string): Promise<string[] | null> {
    const row = await manager.findOneBy(SettingEntity, { key: plainTextConversionKey(versionId) });
    if (!row) return null;
    try {
      const notes = (JSON.parse(row.value) as { notes?: unknown }).notes;
      const held = Array.isArray(notes) ? notes.filter((one): one is string => typeof one === 'string') : [];
      return held.length ? held : null;
    } catch {
      return null;
    }
  }

  /** The draft's notes stored as `kept`; the row goes when no note is left. */
  private async keepPlainTextNotes(manager: EntityManager, versionId: string, kept: readonly string[]): Promise<void> {
    if (kept.length) await manager.save(SettingEntity, { key: plainTextConversionKey(versionId), value: JSON.stringify({ notes: kept }) });
    else await manager.delete(SettingEntity, { key: plainTextConversionKey(versionId) });
  }

  /** A phase's plain-text notes go with it when a Remove takes it out of the draft. */
  private async dropPlainTextNotes(manager: EntityManager, versionId: string, key: PhaseKey): Promise<void> {
    const held = await this.plainTextNotesOf(manager, versionId);
    if (!held) return;
    const gone = new Set(plainTextNotesOn(held, PHASE_TITLES[key]));
    await this.keepPlainTextNotes(manager, versionId, held.filter((note) => !gone.has(note)));
  }

  /**
   * After a door's write to one phase, the notes its texts no longer bear out
   * go, so the editor stops pointing at what the teacher already put right:
   * its `htmlCommentWarning` note when none of the phase's stored texts holds
   * an HTML comment any more, and its `markupOnlyWarning` note when none of
   * the members that note names holds an empty text any more. A markup-only
   * note naming a member still empty is kept as
   * written. Notes otherwise only accumulate, and a plain draft is never
   * converted again. The notes kept when one went, else null.
   */
  private async dropSpentNotes(manager: EntityManager, versionId: string, key: PhaseKey): Promise<string[] | null> {
    const held = await this.plainTextNotesOf(manager, versionId);
    if (!held) return null;
    const title = PHASE_TITLES[key];
    const mine = plainTextNotesOn(held, title);
    const commentNotes = mine.filter(isHtmlCommentNote);
    const markupNotes = mine.flatMap((note) => {
      const members = markupOnlyMembers(note, title);
      return members ? [{ note, members }] : [];
    });
    if (!commentNotes.length && !markupNotes.length) return null;
    const phase = await manager.findOneBy(ProjectPhaseEntity, { projectVersionId: versionId, key });
    if (!phase) return null;
    const tasks = await manager.find(ProjectTaskEntity, { where: { projectPhaseId: phase.id } });
    const now = plainTextPatches([phase], tasks);
    const commented = now.commented.get(phase.id)?.size ?? 0;
    const blank = now.blank.get(phase.id) ?? new Set<PlainTextMember>();
    const spent = new Set<string>([
      ...(commented ? [] : commentNotes),
      ...markupNotes.filter(({ members }) => !members.some((one) => blank.has(one))).map(({ note }) => note),
    ]);
    if (!spent.size) return null;
    const kept = held.filter((note) => !spent.has(note));
    await this.keepPlainTextNotes(manager, versionId, kept);
    return kept;
  }

  /* ------------------------------- the draft ------------------------------- */

  /** The draft tree: phases, tasks and the last validation report. */
  async readDraft(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<DraftVersionView> {
    const manager = this.dataSource.manager;
    const project = await this.requireVisibleProject(manager, caller, projectId);
    const context = await this.load(manager, projectId, versionId);
    return this.draftView(project, context, caller, await this.sourcePhaseKeys(manager, context.version));
  }

  /**
   * The version as a learner of it would first
   * read it, for the project's owner alone (`requireOwnedProject`: another
   * teacher reads a 404, an ADMIN who does not own it a 403). It reads the
   * stored compiled snapshot and hands it to the pure builder: no phase
   * state, enrolment, submission, run or audit row is written, no gate is
   * evaluated, and no provider, sandbox, grader or RunGate is reached.
   */
  async learnerPreview(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<LearnerPreviewView> {
    const manager = this.dataSource.manager;
    const project = await this.requireOwnedProject(manager, caller, projectId);
    const version = await this.requireVersion(manager, versionId);
    if (version.projectId !== projectId) throw new NotFoundException('no version with that id in that project');
    if (!version.compiled) {
      throw new ConflictException(
        `${project.title} ${version.version} holds no compiled snapshot, so there is nothing a learner would see yet.`,
      );
    }
    // A draft whose last compile failed stores its newest words beside the
    // last task list that compiled (`persist`), so its snapshot is not what a
    // learner would read: refused by name rather than shown half new.
    const stored = version.validation as { report?: { checks?: { id?: unknown; status?: unknown }[] } } | null;
    if (
      version.status === 'draft' &&
      (stored?.report?.checks ?? []).some((check) => check?.id === PREVIEW_COMPILE_CHECK_ID && check?.status === 'failed')
    ) {
      throw new ConflictException(
        `${project.title} ${version.version} does not compile as it stands, so a learner could not open it yet. ` +
          'Fix what Validate reports, then open the preview again.',
      );
    }
    return learnerPreviewOf(version.compiled);
  }

  /** One phase's tasks in order, inherited ones included and marked read-only. */
  async listTasks(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
  ): Promise<DraftPhaseView> {
    const manager = this.dataSource.manager;
    await this.requireVisibleProject(manager, caller, projectId);
    const context = await this.load(manager, projectId, versionId);
    return this.phaseView(context, this.requirePhase(context, phaseKey));
  }

  /**
   * Every file row: path, role and size, with bytes only for the two roles a
   * learner already reads.
   *
   * There is no role control anywhere near this list, and that is deliberate
   * rather than an omission: a role is set when a row is created and is never
   * updated, so a disabled control would be a lie about an operation that does
   * not exist.
   *
   * **Two queries, and the sealed bytes are in neither.** The size comes from
   * `content_blobs.size`, which is its own column precisely so a storage report
   * needs no scan; the bytes are read only for the shas of rows
   * `isAuthoringReadableRole` admits, which is `workspace` and `warmup`. The
   * seal on this route then holds because the hidden suites, the solutions, the
   * mutants and the 484 KB canonical application were never read out of the
   * database, rather than because `authoringFileView` dropped them on the way
   * out: one ternary is not what should stand between the store and the wire.
   */
  async listFiles(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<AuthoringFileView[]> {
    const manager = this.dataSource.manager;
    await this.requireVisibleProject(manager, caller, projectId);
    const context = await this.load(manager, projectId, versionId);
    const phaseKeyById = new Map(context.phases.map((phase) => [phase.id, phase.key]));

    const shas = [...new Set(context.files.map((file) => file.blobSha))];
    const sized = shas.length
      ? await manager.find(ContentBlobEntity, {
          where: { sha: In(shas) },
          select: ['sha', 'size'],
        })
      : [];
    const sizeBySha = new Map(sized.map((blob) => [blob.sha, blob.size]));

    const readableShas = [
      ...new Set(
        context.files.filter((file) => isAuthoringReadableRole(file.role)).map((file) => file.blobSha),
      ),
    ];
    const readable = readableShas.length
      ? await manager.find(ContentBlobEntity, {
          where: { sha: In(readableShas) },
          select: ['sha', 'bytes'],
        })
      : [];
    const bytesBySha = new Map(readable.map((blob) => [blob.sha, blob.bytes]));

    return context.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((row) => {
        return authoringFileView(
          row,
          sizeBySha.get(row.blobSha) ?? 0,
          bytesBySha.get(row.blobSha) ?? null,
          row.ownerKind === 'phase' ? phaseKeyById.get(row.ownerId) ?? null : null,
        );
      });
  }

  /* -------------------------------- the tasks ------------------------------ */

  /**
   * Add a task. Outside the Requirements and Design builders a phase takes only
   * a concept quiz beside the work it came with (`QUIZ_ONLY_ADD_REFUSAL`): the
   * quiz mints no path and writes no workspace file, so a task-scoped reset has
   * nothing to delete that the quiz never wrote. A Requirements or Design phase
   * holding no task of its own (the teacher removed it) takes its story or
   * design task back.
   */
  async addTask(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    body: AddTaskBody,
  ): Promise<TaskMutationResult> {
    return this.mutateTasks(caller, projectId, versionId, phaseKey, async (manager, context, phase) => {
      const taskKey = String(body.taskKey ?? '').trim();
      if (!isAuthoredTaskKey(taskKey)) throw new BadRequestException(TASK_KEY_INVALID);
      if (isInheritedTask(taskKey)) {
        throw new ConflictException(
          `"${INHERITED_TASK_KEY}" is the key the task you inherited already holds, so a new task cannot take it. ` +
            'Give this one a key of its own.',
        );
      }
      const held = context.tasks.get(phase.id) ?? [];
      if (held.some((one) => one.taskKey === taskKey)) {
        throw new ConflictException(
          `"${taskKey}" is already a task in ${phase.title}. A task key is unique within a phase, because it is ` +
            "what a learner's work follows.",
        );
      }

      // A Design phase is one design: its one work task is a design task, the
      // first one added to a phase holding none, and a second is refused (the
      // compiler's `design-phase-holds-one-task`). A quiz may sit beside it.
      // A Design still in the older format takes no design task here: a body
      // that is not a quiz meets the quiz-only refusal below, and the phase's
      // first design save converts it (a conversion that refuses a phase
      // holding a second written task, by name, and changes nothing).
      if (phaseKey === 'design' && !body.quiz && !held.some((one) => isOlderWritten(one.checks))) {
        if (held.some((one) => one.checks.kind !== 'quiz')) {
          throw new BadRequestException('A Design phase holds one task. Edit its design in the builder.');
        }
        // the type is design-doc whatever was asked; only a written type may
        // ask, so a quiz with no paper or a code task never becomes the design
        if (body.artefactType !== undefined && body.artefactType !== 'design-doc' && body.artefactType !== 'document') {
          throw new BadRequestException(
            body.artefactType === 'quiz'
              ? quizNeedsQuestionsRefusal()
              : `A Design phase holds a design task, so its type is design-doc; a ${body.artefactType} task cannot be added there.`,
          );
        }
        // stored as plain text, the caps asked of what was sent
        const title = requirePlainText(body.title, 'title', TASK_TITLE_MAX);
        const brief = requirePlainText(body.brief, 'brief', TASK_BRIEF_MAX);
        await this.writeDesignTask(manager, context.version.id, phase.id, {
          taskKey, order: held.length + 1, required: body.required !== false, title, brief, objectives: (body.objectives ?? []).map((one) => plainOrRefuse(one, OBJECTIVE_BLANK)),
        });
        return { action: `${phaseKey}:${taskKey}`, detail: { phaseKey, taskKey, title, artefactType: 'design-doc', added: true, design: true } };
      }

      // Requirements holding no task of its own (the teacher removed it): the story task comes back here, as the
      // design arm brings Design's back. The body's words are kept; its type is user-story, and any other type asked
      // (a document, a quiz without a paper, a code task) is refused.
      if (phaseKey === 'requirements' && !body.quiz && !held.some((one) => one.checks.kind !== 'quiz')) {
        // the type is user-story, and only user-story may be asked: no other written type is offered,
        // so a document, a quiz with no paper or a code task never becomes the story
        if (body.artefactType !== undefined && body.artefactType !== 'user-story') {
          throw new BadRequestException(
            body.artefactType === 'quiz'
              ? quizNeedsQuestionsRefusal()
              : `A Requirements phase holds a story task, so its type is user-story; a ${body.artefactType} task cannot be added there.`,
          );
        }
        // stored as plain text, the caps asked of what was sent
        const title = requirePlainText(body.title, 'title', TASK_TITLE_MAX);
        const brief = requirePlainText(body.brief, 'brief', TASK_BRIEF_MAX);
        const mounted = context.files.some((one) => one.ownerKind === 'phase' && one.ownerId === phase.id && one.path === STORY_JSON);
        await this.writeStoryTask(manager, context.version.id, phase.id, mounted, {
          taskKey, order: held.length + 1, required: body.required !== false, title, brief, objectives: (body.objectives ?? []).map((one) => plainOrRefuse(one, OBJECTIVE_BLANK)),
        });
        return { action: `${phaseKey}:${taskKey}`, detail: { phaseKey, taskKey, title, artefactType: 'user-story', added: true, story: true } };
      }

      // Every other task beside a phase's own work is a concept quiz: a body that is not one is refused
      // before anything is minted.
      const artefactType: ArtefactType = body.artefactType ?? PHASE_ARTEFACT_TYPE_SUGGESTION[phaseKey];
      if (!body.quiz) {
        throw new BadRequestException(artefactType === 'quiz' ? quizNeedsQuestionsRefusal() : QUIZ_ONLY_ADD_REFUSAL);
      }
      if (!isAuthorableTask('quiz', artefactType)) throw new BadRequestException(quizIsItsOwnTypeRefusal(artefactType));
      const required = body.required !== false;
      const checks = checkedQuiz(body.quiz, required, quizTitleOf(body.title));
      const quizTitle = requirePlainText(body.title, 'title', TASK_TITLE_MAX);
      await manager.save(
        manager.create(ProjectTaskEntity, {
          projectPhaseId: phase.id,
          taskKey,
          order: held.length + 1,
          required,
          signOff: false,
          artefactType,
          // `quiz-owns-no-file`: no path, and `ownsFor` then answers the
          // empty list, so the inherited task keeps every editable file the
          // phase mounts and nothing minted a second owner of a learner's
          // code.
          artefactPath: null,
          title: quizTitle,
          brief: requirePlainText(body.brief, 'brief', TASK_BRIEF_MAX),
          objectives: (body.objectives ?? []).map((one) => plainOrRefuse(one, OBJECTIVE_BLANK)),
          primaryPath: null,
          anchor: null,
          rubric: quizRubricFor(checks),
          checks,
        }),
      );
      return {
        action: `${phaseKey}:${taskKey}`,
        detail: {
          phaseKey,
          taskKey,
          title: quizTitle,
          artefactType,
          questions: checks.questions.length,
          added: true,
        },
      };
    });
  }

  /**
   * Change a task's title, brief, rules, objectives, or, on a quiz, its whole
   * paper. Refused on an inherited one.
   *
   * A quiz replaces `checks` outright rather than patching
   * it, because a question's stem, its options and its key are one edit and a
   * partial one would leave a key pointing at an option that is no longer
   * there. The quiz is refused on everything else, so a body says one thing
   * about how a task is scored rather than two.
   */
  async updateTask(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    body: UpdateTaskBody & UpdateExecutableTaskBody,
  ): Promise<TaskMutationResult> {
    return this.mutateTasks(caller, projectId, versionId, phaseKey, async (manager, context, phase) => {
      const held = context.tasks.get(phase.id) ?? [];
      // A code or tests task has its own arm.
      const executable = held.find((one) => one.taskKey === taskKey);
      // The sign-off mark. Every work task the
      // class queue countersigns takes it (a written, code, tests or config
      // task: `taskRollup` holds its pass for the countersignature); a quiz is
      // refused by name. A task neither arm edits (a copy's inherited task, an
      // uploaded config phase's) takes a body carrying the mark alone, and
      // only the mark is written: marked, never counted (no anchor reads it).
      if (executable && body.signOff !== undefined) {
        if (typeof body.signOff !== 'boolean') throw new BadRequestException('A sign-off mark is true or false.');
        if (executable.checks.kind === 'quiz' || executable.artefactType === 'quiz') {
          throw new BadRequestException(signOffQuizRefusal(executable.title));
        }
        const markOnly = Object.entries(body).every(([member, value]) => member === 'signOff' || value === undefined);
        if (
          markOnly &&
          !isAuthorableTask(executable.checks.kind, executable.artefactType) &&
          !isAuthorableExecutableTask(executable.checks.kind, executable.artefactType)
        ) {
          await manager.update(ProjectTaskEntity, { id: executable.id }, { signOff: body.signOff });
          return { action: `${phaseKey}:${taskKey}`, detail: { phaseKey, taskKey, signOff: body.signOff } };
        }
      }
      // Deployment's one config task with a runbook: its words, its rubric, its runbook floor and its sign-off mark.
      // A config task without one is still in the older format: it keeps the mark alone (above),
      // and the first save that carries a runbook or a rubric takes this arm too, which converts it first.
      if (
        executable &&
        executable.checks.kind === 'config' &&
        phaseKey === 'deployment' &&
        (executable.checks.runbook || body.runbook !== undefined || body.rubric !== undefined)
      ) {
        return this.updateRunbookTask(manager, context, phase, executable, body);
      }
      if (body.runbook !== undefined && !(phaseKey === 'deployment' && executable?.checks.kind === 'config')) {
        throw new BadRequestException(ONLY_DEPLOYMENT_RUNBOOK);
      }
      // a ticket and a change request are Maintenance's executable task's; that arm refuses them on a task without a record
      const executableArm = !!executable && isAuthorableExecutableTask(executable.checks.kind, executable.artefactType);
      if ((body.ticket !== undefined || body.change !== undefined) && !(phaseKey === 'maintenance' && executableArm)) {
        throw new BadRequestException(ONLY_MAINTENANCE_CHANGE);
      }
      if (executable && executableArm) {
        return this.updateExecutableTask(manager, context, phase, held, executable, body);
      }
      const task = this.requireAuthorableTask(held, phase.title, taskKey);
      if (
        body.owns !== undefined ||
        body.runs !== undefined ||
        body.minTests !== undefined ||
        body.coverageKeywords !== undefined
      ) {
        throw new BadRequestException(
          `"${task.title}" is not graded by running tests, so it has no runs, minimum suite or coverage keywords to edit.`,
        );
      }

      const artefactType = body.artefactType ?? task.artefactType;
      // The task's **real** kind decides: it refuses an edit that would leave
      // the type behind: a quiz cannot become a record and a record cannot
      // become a quiz, because the kind that scores a task is not a field an
      // edit carries.
      if (!isAuthorableTask(task.checks.kind, artefactType)) {
        throw new BadRequestException(
          task.checks.kind === 'quiz' || artefactType === 'quiz'
            ? quizIsItsOwnTypeRefusal(artefactType)
            : authorableArtefactTypeRefusal(artefactType),
        );
      }
      const isQuiz = task.checks.kind === 'quiz';
      if (body.quiz && !isQuiz) {
        throw new BadRequestException(
          `"${task.title}" is not a quiz, so there is no paper to replace. A quiz is a task of its own — add one ` +
            'beside this task rather than turning this one into one.',
        );
      }
      // A design task: its switches, stories and floor, and its weighted
      // rubric, each replaced whole. It is scored by the floor. A `design` body is also what converts a Design
      // task still in the older format (its first save converts it), and only
      // a task of the Design phase takes one.
      if (task.checks.kind === 'design' || body.design) {
        if (isQuiz) throw new BadRequestException(`"${task.title}" is a quiz, and a quiz cannot become a design task.`);
        if (phaseKey !== 'design') throw new BadRequestException('A design task belongs to the Design phase.');
        if (body.story) throw new BadRequestException('A story task belongs to the Requirements phase.');
        // the body is checked whole before anything converts or moves
        const checks = body.design ? designChecksFromBody(body.design) : null;
        const rubric = body.rubric ? rubricFromBody(body.rubric) : null;
        if (task.checks.kind !== 'design') {
          const outcome = await convertLegacyDesignRows(manager, context.version.id, () =>
            this.packCriteriaOf(manager, context.version, 'design', task.taskKey),
          );
          if (outcome && !outcome.converted) {
            throw new BadRequestException(`This Design task cannot be converted: ${outcome.reason}.`);
          }
        }
        const fresh = await manager.findOneByOrFail(ProjectTaskEntity, { id: task.id });
        const designPatch: Partial<ProjectTaskEntity> = { artefactType: 'design-doc' };
        const designMoved: Record<string, unknown> = { phaseKey, taskKey };
        if (task.checks.kind !== 'design') designMoved.converted = true;
        if (checks) {
          designPatch.checks = checks;
          designMoved.design = true;
        }
        structuredTaskTail(body, fresh, rubric, designPatch, designMoved);
        // the row first: the documents follow the switches it now holds
        await manager.update(ProjectTaskEntity, { id: fresh.id }, designPatch);
        await this.syncDesignDocuments(manager, context.version.id, phase.id, (checks ?? fresh.checks) as DesignChecks, fresh.id);
        return { action: `${phaseKey}:${taskKey}`, detail: designMoved };
      }
      // A story task: its floor, its stories and its weighted rubric, each
      // replaced whole. It is scored by the floor, so rules and a word floor
      // are refused here. A `story` body is also what converts a Requirements
      // task still in the older format.
      if (task.checks.kind === 'story' || body.story) {
        if (isQuiz) {
          throw new BadRequestException(`"${task.title}" is a quiz, and a quiz cannot become a story task.`);
        }
        if (task.checks.kind !== 'story' && phaseKey !== 'requirements') {
          throw new BadRequestException('A story task belongs to the Requirements phase.');
        }
        const storyPatch: Partial<ProjectTaskEntity> = { artefactType };
        const storyMoved: Record<string, unknown> = { phaseKey, taskKey };
        if (body.story) {
          storyPatch.checks = storyChecksFromBody(
            body.story,
            task.checks.kind === 'story' ? task.checks.record : STORY_JSON,
            phaseKey,
          );
          storyMoved.story = true;
        }
        structuredTaskTail(
          body,
          task,
          body.rubric ? rubricFromBody(body.rubric) : null,
          storyPatch,
          storyMoved,
          body.artefactType !== undefined ? { artefactType } : undefined,
        );
        await manager.update(ProjectTaskEntity, { id: task.id }, storyPatch);
        return { action: `${phaseKey}:${taskKey}`, detail: storyMoved };
      }
      if (body.rubric !== undefined) {
        throw new BadRequestException(
          `"${task.title}" is not a story task, so its rubric follows its rules rather than being edited whole.`,
        );
      }

      const patch: Partial<ProjectTaskEntity> = { artefactType };
      const moved: Record<string, unknown> = { phaseKey, taskKey };

      if (body.quiz) {
        // The whole quiz, replaced: a question's key and its options are one
        // edit, and `criterion` moves the rubric with it, because
        // `quiz-rubric-key-is-the-quiz's` refuses a snapshot whose quiz rubric
        // claims any other key: `assembleCriteria` reads `scores.get(key) ?? 0`,
        // so a mismatch is a flat zero with no evidence, which on a required
        // quiz is a bar nobody can clear.
        const checks = checkedQuiz(body.quiz, task.required, quizTitleOf(body.title ?? task.title));
        patch.checks = checks;
        patch.rubric = quizRubricFor(checks);
        moved.questions = checks.questions.length;
        moved.criterion = checks.criterion;
      }

      // The task's words through the one overlay the
      // importer's phase.json task block also uses (draft.ts `taskWordsPatch`).
      const words = taskWordsPatch(body);
      Object.assign(patch, words.patch);
      Object.assign(moved, words.moved);
      if (body.artefactType !== undefined) moved.artefactType = artefactType;
      // A criterion's wording: a criterion it does not name keeps its wording.
      // Keys must be the rubric's own; a weight and the pass threshold are
      // never read. The anchor hashes the rubric, so a reworded criterion makes
      // the task the teacher's.
      if (body.criteria !== undefined) {
        patch.rubric = reworded(patch.rubric ?? task.rubric, body.criteria, task.title);
        moved.criteria = body.criteria.length;
      }
      // The sign-off mark: absent means unchanged.
      if (body.signOff !== undefined) {
        patch.signOff = body.signOff;
        moved.signOff = body.signOff;
      }

      await manager.update(ProjectTaskEntity, { id: task.id }, patch);
      return { action: `${phaseKey}:${taskKey}`, detail: moved };
    });
  }

  /**
   * `tasks.update` on Deployment's config task with a runbook: the title,
   * brief and objectives, the rubric (its locked keys kept), the runbook
   * floor and the sign-off mark. Every other member is refused: the files,
   * rules, smoke run and drill change only by re-upload. The task stays
   * required (`setTaskRequired` still refuses a config task). A task still in
   * the older format (no runbook) is converted first, by the save that
   * carries a runbook or a rubric (`convertLegacyRunbookRows`), and read again.
   */
  private async updateRunbookTask(
    manager: EntityManager,
    context: DraftContext,
    phase: ProjectPhaseEntity,
    task: ProjectTaskEntity,
    body: UpdateTaskBody & UpdateExecutableTaskBody,
  ): Promise<{ action: string; detail: Record<string, unknown> }> {
    if (!(task.checks as ConfigChecks).runbook && (body.runbook !== undefined || body.rubric !== undefined)) {
      const outcome = await convertLegacyRunbookRows(manager, context.version.id, () => this.packCriteriaOf(manager, context.version, 'deployment', task.taskKey), task.id);
      // the reason is a sentence with its own stop; the refusal adds one
      if (outcome && !outcome.converted) throw new BadRequestException(`This Deployment task cannot be converted: ${outcome.reason.replace(/[.]+$/, '')}.`);
      task = await manager.findOneByOrFail(ProjectTaskEntity, { id: task.id });
    }
    const allowed = new Set(['title', 'brief', 'objectives', 'rubric', 'runbook', 'signOff']);
    if (Object.entries(body).some(([member, value]) => value !== undefined && !allowed.has(member))) {
      throw new BadRequestException(DEPLOYMENT_UPLOAD_ONLY);
    }
    const checks = task.checks as ConfigChecks;
    const patch: Partial<ProjectTaskEntity> = {};
    const moved: Record<string, unknown> = { phaseKey: phase.key, taskKey: task.taskKey };
    const next: ConfigChecks = body.runbook ? { ...checks, runbook: runbookChecksFromBody(body.runbook, !!checks.drill) } : checks;
    if (body.runbook) {
      patch.checks = next;
      moved.runbook = true;
    }
    const rubric = body.rubric ? rubricFromBody(body.rubric) : null;
    if (rubric) refuseLockedRubric(next, rubric, task.rubric);
    structuredTaskTail(body, task, rubric, patch, moved);
    if (Object.keys(patch).length) await manager.update(ProjectTaskEntity, { id: task.id }, patch);
    return { action: `${phase.key}:${task.taskKey}`, detail: moved };
  }

  /**
   * `tasks.update` on a phase's **sole** code or tests task.
   *
   * Its words (title, brief, objectives) are saved as a written task's are.
   * Its executable members (`UpdateExecutableTaskBody`) go through
   * `editedExecutableSlice`, which saves only what is not a byte and only
   * inside what the upload declared (the run labels, what each run collects,
   * a code run's visible tests and a tests task's minimum) onto the row's own
   * slice; the sealed files stay the sealed-role door's. Rules, a quiz and a word floor
   * are a written task's and are refused. A rubric is taken by Implementation's code task
   * and Testing's tests task (their fixed criteria's sentences and weights) and
   * by Maintenance's change-request task, and refused on any other. The save moves the executable
   * content digest, so a deep receipt made before it is no longer current and
   * publish asks for a new one; the task stays required and cannot be
   * removed (`requireAuthorableTask` still answers those doors).
   */
  private async updateExecutableTask(
    manager: EntityManager,
    context: DraftContext,
    phase: ProjectPhaseEntity,
    held: ProjectTaskEntity[],
    task: ProjectTaskEntity,
    body: UpdateTaskBody & UpdateExecutableTaskBody,
  ): Promise<{ action: string; detail: Record<string, unknown> }> {
    // Maintenance still in the older format: the first ticket, change or rubric save converts it, then the draft is
    // read again (the task, its siblings, the compiled phase and the file rows), so everything below sees the
    // converted checks and the mounted record.
    if (phase.key === 'maintenance' && task.checks.kind === 'code' && !(task.checks as CodeChecks).change
      && (body.ticket !== undefined || body.change !== undefined || body.rubric !== undefined)) {
      const outcome = await convertLegacyChangeRows(manager, context.version.id, () => this.packCriteriaOf(manager, context.version, 'maintenance', task.taskKey), task.id);
      if (outcome && !outcome.converted) throw new BadRequestException(`This Maintenance task cannot be converted: ${outcome.reason.replace(/[.]+$/, '')}.`);
      if (outcome) {
        context = await this.load(manager, context.project.id, context.version.id);
        held = context.tasks.get(phase.id) ?? [];
        // the row as the reloaded siblings hold it: the work-task check below compares by identity
        const id = task.id;
        task = held.find((one) => one.id === id) ?? task;
      }
    }
    // Maintenance's code task with a change request also takes its ticket, change request and rubric.
    const maintenanceRecord = phase.key === 'maintenance' && task.checks.kind === 'code' && !!task.checks.change;
    // Implementation's code task and Testing's tests task take their fixed criteria's sentences and weights.
    const fixedRubric =
      (phase.key === 'implementation' && task.checks.kind === 'code' && !(task.checks as CodeChecks).change) ||
      (phase.key === 'testing' && task.checks.kind === 'tests');
    if (
      body.quiz !== undefined ||
      body.criteria !== undefined ||
      body.story !== undefined ||
      (body.rubric !== undefined && !maintenanceRecord && !fixedRubric)
    ) {
      throw new BadRequestException(
        `"${task.title}" is graded by running tests, not by rules, a word floor, a quiz key or a story floor. Edit its runs here, and write its hidden tests and reference files through the sealed files.`,
      );
    }
    if ((body.ticket !== undefined || body.change !== undefined) && !maintenanceRecord) {
      throw new BadRequestException(ONLY_MAINTENANCE_CHANGE);
    }
    if (body.artefactType !== undefined && body.artefactType !== task.artefactType) {
      throw new BadRequestException(
        `"${task.title}" stays a ${task.artefactType} task: what grades a task is set when the project is uploaded.`,
      );
    }
    const content = context.content.phases.find((one) => one.key === phase.key);
    const slice = content ? soleExecutableSliceOf(content, held) : null;
    const work = held.filter((one) => one.checks.kind !== 'quiz');
    if (work.length > 1) {
      throw new ConflictException(
        `${phase.title} holds more than one task graded by running tests, so none of them can be edited here. Upload the project again with one.`,
      );
    }
    // The other `!slice` shapes get a sentence that is true of
    // them (a sole work task graded another way than its phase, or a
    // phase this draft no longer compiles from) rather than "upload again".
    if (!content || !slice || work[0] !== task) {
      throw new ConflictException(
        `"${task.title}" is not graded the way ${phase.title} is, so its runs cannot be edited here. Validate the draft to see what the phase needs.`,
      );
    }
    let current: PhaseContent;
    try {
      current = phaseFromTasks(content, held, context.sealed.get(phase.key) ?? []);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }

    const patch: Partial<ProjectTaskEntity> = {};
    const moved: Record<string, unknown> = { phaseKey: phase.key, taskKey: task.taskKey };
    if (
      body.owns !== undefined ||
      body.runs !== undefined ||
      body.minTests !== undefined ||
      body.coverageKeywords !== undefined
    ) {
      // the change request is a record, never a path a task owns or an editable target (Global Constraints)
      if (maintenanceRecord && body.owns?.includes(CHANGE_REQUEST_JSON)) {
        throw new BadRequestException(`${CHANGE_REQUEST_JSON} is the change request record, never an editable target.`);
      }
      const editable = content.files.filter((file) => file.editable).map((file) => file.path);
      const edit = editedExecutableSlice({
        slice,
        current: current.checks as CodeChecks | TestsChecks,
        phase: content,
        owns: ownsFor(task, held, editable),
        body,
      });
      if ('refusal' in edit) throw new BadRequestException(edit.refusal);
      patch.checks = edit.checks;
      Object.assign(moved, edit.detail);
    }
    // The same words overlay as the written arm and the importer's task block.
    const words = taskWordsPatch(body);
    Object.assign(patch, words.patch);
    Object.assign(moved, words.moved);
    // The fixed criteria: every key the grader scores present, and no key it does not.
    if (fixedRubric && body.rubric !== undefined) {
      const rubric = rubricFromBody(body.rubric);
      const fixed = FIXED_SCORER_KEYS[task.checks.kind as 'code' | 'tests'];
      // Named by the saved rubric's title for that key, never the key alone.
      for (const key of fixed) if (!rubric.criteria.some((c) => c.key === key)) throw new BadRequestException(lockedCriterionRefusal(key, task.rubric?.criteria?.find((c) => c.key === key)?.title));
      if (rubric.criteria.some((c) => !fixed.includes(c.key))) {
        throw new BadRequestException(fixedCriteriaRefusal(phase.key === 'implementation' ? 'Implementation' : 'Testing'));
      }
      patch.rubric = rubric;
      moved.rubric = rubric.criteria.length;
    }
    // Maintenance's ticket, change request and rubric: a change request reads its ticket.
    if (maintenanceRecord && (body.ticket !== undefined || body.change !== undefined || body.rubric !== undefined)) {
      const code = (patch.checks ?? task.checks) as CodeChecks;
      const ticket = body.ticket !== undefined ? ticketFromBody(body.ticket) : code.ticket;
      const change = body.change !== undefined ? changeChecksFromBody(body.change) : code.change;
      if ((body.ticket !== undefined || body.change !== undefined) && (!ticket || !change)) {
        throw new BadRequestException(TICKET_WITH_CHANGE);
      }
      const starting = await this.startingRecord(manager, context, phase, CHANGE_REQUEST_JSON);
      const read = starting ? validateChangeRequestRecord(starting.text, null).change : null;
      // An unreadable starting record never skips the covered-id guard or the contract-off rewrite.
      if (starting && !read && (body.ticket !== undefined || body.change !== undefined)) throw new BadRequestException(STARTING_CHANGE_UNREADABLE);
      if (ticket && read) {
        const ids = new Set(ticket.acceptance.map((one) => one.id));
        const covered = [...read.tests.flatMap((t) => t.covers), ...read.release.changes.flatMap((l) => l.covers)];
        const dropped = covered.find((id) => !ids.has(id));
        if (dropped !== undefined) throw new BadRequestException(ticketCoveredRefusal(dropped));
      }
      const rubric = body.rubric ? rubricFromBody(body.rubric) : null;
      if (rubric) refuseLockedRubric({ ...code, ...(ticket && change ? { ticket, change } : {}) }, rubric, task.rubric);
      // switching the contract off deletes the starting record's amendments (the builder asked first); only the
      // body that switches it off does, so a rubric-only or ticket-only save never rewrites the starting record
      if (starting && read && body.change !== undefined && !body.change.contract && read.contract.length) {
        await this.importer.replaceFileBytes(manager, [starting.rowId], serialiseChangeRequest({ ...read, contract: [] }), { startingRecord: true });
        moved.contractCleared = read.contract.length;
      }
      if (ticket && change && (body.ticket !== undefined || body.change !== undefined)) {
        patch.checks = { ...code, ticket, change };
        Object.assign(moved, { ticket: ticket.id, change: true });
      }
      if (rubric) {
        patch.rubric = rubric;
        moved.rubric = rubric.criteria.length;
      }
    }
    // The sign-off mark: absent means unchanged.
    if (body.signOff !== undefined) {
      patch.signOff = body.signOff;
      moved.signOff = body.signOff;
    }
    if (Object.keys(patch).length > 0) await manager.update(ProjectTaskEntity, { id: task.id }, patch);
    return { action: `${phase.key}:${task.taskKey}`, detail: moved };
  }

  /** A phase's starting record row and its bytes, or null when the draft mounts none. */
  private async startingRecord(
    manager: EntityManager,
    context: DraftContext,
    phase: ProjectPhaseEntity,
    at: string,
  ): Promise<{ rowId: string; text: string } | null> {
    const row = context.files.find((one) => one.ownerKind === 'phase' && one.ownerId === phase.id && one.path === at);
    if (!row) return null;
    const blob = await manager.findOneBy(ContentBlobEntity, { sha: row.blobSha });
    return { rowId: row.id, text: blob?.bytes ?? '' };
  }

  /** Mark a task required or optional. Only required tasks gate the phase. */
  async setTaskRequired(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    body: SetTaskRequiredBody,
  ): Promise<TaskMutationResult> {
    return this.mutateTasks(caller, projectId, versionId, phaseKey, async (manager, context, phase) => {
      const held = context.tasks.get(phase.id) ?? [];
      const task = this.requireAuthorableTask(held, phase.title, taskKey);
      const required = body.required === true;
      await manager.update(ProjectTaskEntity, { id: task.id }, { required });
      return { action: `${phaseKey}:${taskKey}`, detail: { phaseKey, taskKey, required } };
    });
  }

  /**
   * The whole ordering at once.
   *
   * An ordering is one fact, and a pairwise swap leaves an intermediate state in
   * which two tasks claim position 3, which `UQ_project_tasks_order` refuses
   * and which a second teacher could read. The list carries the inherited tasks
   * too: where a task sits is the phase's business, not the task's, so a
   * read-only task can still be moved and cannot be added or dropped here.
   */
  async reorderTasks(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    body: ReorderTasksBody,
  ): Promise<TaskMutationResult> {
    return this.mutateTasks(caller, projectId, versionId, phaseKey, async (manager, context, phase) => {
      const held = context.tasks.get(phase.id) ?? [];
      const wanted = body.taskKeys ?? [];
      const same =
        wanted.length === held.length &&
        new Set(wanted).size === wanted.length &&
        held.every((one) => wanted.includes(one.taskKey));
      if (!same) {
        throw new BadRequestException(
          `An ordering names every task in ${phase.title}, once each. ${phase.title} holds ` +
            `${held.map((one) => `"${one.taskKey}"`).join(', ')}, and this ordering is not those keys. ` +
            'Adding or removing a task is its own door.',
        );
      }

      const byKey = new Map(held.map((one) => [one.taskKey, one]));
      // two passes, because the order column is unique within the phase and a
      // one-pass rewrite passes through a state in which two tasks claim one
      for (const [at, key] of wanted.entries()) {
        await manager.update(ProjectTaskEntity, { id: byKey.get(key)!.id }, { order: -(at + 1) });
      }
      for (const [at, key] of wanted.entries()) {
        await manager.update(ProjectTaskEntity, { id: byKey.get(key)!.id }, { order: at + 1 });
      }
      return { action: phaseKey, detail: { phaseKey, order: wanted } };
    });
  }

  /** Remove a task the caller wrote, and the file it wrote to. */
  async removeTask(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
  ): Promise<TaskMutationResult> {
    return this.mutateTasks(caller, projectId, versionId, phaseKey, async (manager, context, phase) => {
      const held = context.tasks.get(phase.id) ?? [];
      const task = this.requireAuthorableTask(held, phase.title, taskKey);
      if (held.length === 1) {
        throw new ConflictException(
          `"${task.title}" is the only task in ${phase.title}, and a phase with no task is a phase a learner ` +
            'opens on nothing. Add the task that replaces it first.',
        );
      }

      const remaining = held.filter((one) => one.id !== task.id);
      const editable = context.content.phases
        .find((one) => one.key === phase.key)
        ?.files.filter((file) => file.editable)
        .map((file) => file.path) ?? [];
      // what the siblings own is asked of the phase as it stands, `held` and not
      // `remaining`: asked of the survivors alone, the inherited task would
      // inherit the path this task is taking with it (it owns every editable
      // path no other task minted) and the file would be kept for a task that
      // no longer exists.
      const mine = new Set(ownsFor(task, held, editable));
      for (const sibling of remaining) {
        for (const at of ownsFor(sibling, held, editable)) mine.delete(at);
      }

      // The file the task wrote to goes with it: an editable path no task owns
      // is a file a learner would edit and nothing would grade, which the
      // compiler refuses by name. The delete goes through the importer's own
      // door, which refuses any role but `workspace`, any row of an
      // application phase and any row another task still owns: a raw delete
      // would check none of that. The files go **before**
      // the task row, so the door asks ownership of the phase as it stands and
      // sets aside only this task's claim.
      if (mine.size > 0) {
        const rows = context.files.filter(
          (row) =>
            row.ownerKind === 'phase' && row.ownerId === phase.id && row.role === 'workspace' && mine.has(row.path),
        );
        await this.importer.deleteFileRows(
          manager,
          context.version.id,
          rows.map((row) => row.id),
          { removingTaskId: task.id },
        );
      }
      await manager.delete(ProjectTaskEntity, { id: task.id });
      for (const [at, sibling] of remaining.entries()) {
        await manager.update(ProjectTaskEntity, { id: sibling.id }, { order: -(at + 1) });
      }
      for (const [at, sibling] of remaining.entries()) {
        await manager.update(ProjectTaskEntity, { id: sibling.id }, { order: at + 1 });
      }

      return {
        action: `${phaseKey}:${taskKey}`,
        detail: { phaseKey, taskKey, title: task.title, removed: true, files: [...mine] },
      };
    });
  }

  /* ------------------------------- the key --------------------------------- */

  /**
   * A quiz's answer key and its explanations, for the project's **owner**.
   *
   * This is the one door in the whole surface that carries
   * `QuizQuestion.correct`, and it exists because the obvious place to put a
   * key (the draft payload the editor already reads) is the wrong one.
   * `readDraft` and `listTasks` are guarded by `requireVisibleProject`, which
   * admits a project when `caller.role === 'ADMIN' || project.platformOwned ||
   * project.ownerUserId === caller.id`: so the draft is readable by **every
   * instructor on the deployment for any platform-owned project**, and by any
   * `ADMIN` for anybody's. `DraftTaskView.quiz` is therefore
   * `AuthoredQuizView` (stems, options and a count) and the key comes
   * through here, behind `requireOwnedProject`.
   *
   * The reason is not authorship. `authorable` is
   * `isAuthorableTask(kind, type)`, a question about kind and type, so widening
   * it for quiz sets it true for an inherited quiz row as well; a `user-story`
   * task inherited from a copy is authorable and its grading regexes do
   * reach the copying teacher. What is different about an MCQ key is that it
   * **is** the passing answer, so the platform's own rule for serving an answer
   * applies: a gate, and a row saying who walked through it.
   *
   * So it audits, in `solution.read`'s shape and for `solution.read`'s reason.
   * Nothing is written and no score moves; *who has seen this key* is still a
   * question a class has to be able to answer, and the row says a key was read
   * rather than what the key is.
   *
   * **A copy carries the key, and that is the decision rather than a gap.**
   * `createProject` materialises every compiled task of every phase, and a
   * task's `checks` *are* its sealed slice: `authoredTaskFor` writes
   * `checks: authored.checks` into the snapshot, so a quiz's `correct` and its
   * `explanation` travel in it the way `hiddenTestFiles` and `solutionFiles`
   * travel in a code phase's. The source of a copy is `requireVisibleProject`,
   * so the two callers this door refuses in place (an instructor reading a
   * platform-owned project, an `ADMIN` reading a published project of
   * somebody's) can copy first and then read the key on the copy they own.
   *
   * That is what copying is on this surface rather than a way around this
   * gate. A copy is the copying teacher's project to edit, re-key and grade:
   * `updateTask` lets them replace the whole paper, and a key withheld from
   * the person who may replace it would leave them able to overwrite a
   * question bank and unable to revise one. The sealed **files** are the
   * different case and stay different: `authoringFileView` withholds every
   * role `isAuthoringReadableRole` refuses from the owner too, because those
   * bytes are not authorable here at all.
   *
   * What the copy does write is its own `project.create` row, whose
   * `copiedFrom` names the source project, the version and that version's id:
   * *this account made a copy of that version*, which is the sentence a reader
   * chasing a key follows. It is filed against the **copy**, so the source
   * project's own trail gains nothing: a reader asking where a key went looks
   * for copies of it rather than at its own rows. Narrowing that, by demanding
   * ownership of a source that holds a quiz or by writing a second row back
   * against it, would be a separate decision and not this door's; the
   * behaviour is pinned by the spec that copies a published quiz and reads its key.
   *
   * A published version is readable here as well as a draft: a teacher asking
   * what they shipped is asking about the version their class is pinned to.
   */
  async readQuizKey(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
  ): Promise<AuthoredQuiz> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireOwnedProject(manager, caller, projectId);
      const context = await this.load(manager, projectId, versionId);
      const phase = this.requirePhase(context, phaseKey);
      const held = context.tasks.get(phase.id) ?? [];
      const task = held.find((one) => one.taskKey === taskKey);
      if (!task) throw new NotFoundException(`${phase.title} has no task keyed "${taskKey}"`);
      if (task.checks.kind !== 'quiz') {
        throw new NotFoundException(
          `"${task.title}" is not a quiz, so it has no answer key. A quiz is scored by its key; every other task ` +
            'is scored by rules you can read in the editor.',
        );
      }
      const checks = task.checks;

      this.logger.log({
        event: QUIZ_KEY_AUDIT_EVENT,
        actorId: caller.id,
        projectId,
        versionId,
        phaseKey,
        taskKey,
        questions: checks.questions.length,
      });
      await recordAudit(manager, {
        event: QUIZ_KEY_AUDIT_EVENT,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        // The phase key, as `solution.read` writes it: the `action` is where a
        // reader looks for *which room*, and the task is one field further in.
        action: phaseKey,
        reason: null,
        detail: {
          versionId,
          phaseKey,
          taskKey,
          // `taskTitle` and not `title`, because that is the field the
          // console's own `taskNameOf` reads (`AuditList.tsx`): the three
          // task levers write it under that name and a fourth spelling would
          // draw this row by its key while the others draw theirs by name.
          taskTitle: task.title,
          questions: checks.questions.length,
        },
      });

      // `clone`, so the caller holds no reference into the row the transaction
      // read, and the whole of `QuizQuestion`, because this is the one payload
      // `correct` and `explanation` belong in.
      const answer: AuthoredQuiz = {
        questions: clone(checks.questions),
        shuffleOptions: checks.shuffleOptions,
        passMark: checks.passMark,
        attempts: { ...checks.attempts },
        criterion: checks.criterion,
      };
      if (checks.drawn !== undefined) answer.drawn = checks.drawn;
      // The reveal, echoed as it was written.
      if (checks.revealExplanation !== undefined) answer.revealExplanation = checks.revealExplanation;
      return answer;
    });
  }

  /**
   * One staff download of the starter or the
   * shelf example. The archives carry example hidden tests and solutions, so
   * the read is on the record as `readQuizKey`'s and the sealed read's are:
   * one `project.sealed-read` row (no event of its own), filed
   * against no project (`targetId` null, `action` the archive's name), whose
   * detail names the archive and never holds a byte of it. The row is written
   * in its own short transaction before the bytes are handed over, so a failed
   * write serves nothing; an unknown name is `starterArchive`'s 404 and writes
   * nothing. No other row, no gate, no model, no sandbox.
   */
  async starterDownload(caller: InstructorCaller, name: string): Promise<StarterArchive> {
    return starterArchive(name, (download) =>
      this.dataSource.transaction(async (manager) => {
        this.logger.log({ event: STARTER_READ_AUDIT_EVENT, actorId: caller.id, starter: download.name, sha256: download.sha256 });
        await recordAudit(manager, {
          event: STARTER_READ_AUDIT_EVENT,
          actorUserId: caller.id,
          subjectUserId: caller.id,
          targetId: null,
          action: download.name,
          reason: null,
          detail: { name: download.name, filename: download.filename, size: download.size, sha256: download.sha256 },
        });
      }),
    );
  }

  /* ------------------ the copy becomes the teacher's own ------------------ */

  /**
   * A phase's intro, on every phase. Written, ungraded and
   * never model input, so it takes no rule but its length, and it is stored
   * untrimmed once it is not blank, as `plainTextOf` of what was sent,
   * because the intro joins the scenario digest: a teacher who writes
   * the reference's own intro back must be the reference's again, which a trim
   * would break. A plain intro (every reference intro is) is stored as sent.
   */
  async updatePhase(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    body: UpdatePhaseBody,
  ): Promise<PhaseMutationResult> {
    return this.mutateDraft(
      caller,
      projectId,
      versionId,
      phaseKey,
      async (manager, _context, phase) => {
        const intro = plainTextOf(writtenText(body?.intro, `The intro of ${phase.title}`, PHASE_INTRO_MAX));
        // an intro the conversion leaves blank (only `#`, `---` or `***`) is refused as an empty one is
        if (intro.trim().length === 0) throw new BadRequestException(`The intro of ${phase.title} cannot be empty.`);
        await manager.update(ProjectPhaseEntity, { id: phase.id }, { intro });
        return { action: phaseKey, detail: { phaseKey, length: intro.length } };
      },
      EDIT_EVENT.phase,
    );
  }

  /* ----------------------------- the Phases card ---------------------------- */

  /**
   * Remove a phase from a draft: its file rows (every role), its
   * task rows and its phase row are deleted, the rest renumber 1 to n in
   * LearnSDLC's order, and the phase leaves the draft's base snapshot. The
   * blobs stay in `content_blobs`, as every blob does. The draft keeps one
   * phase at least.
   */
  async removePhase(caller: InstructorCaller, projectId: string, versionId: string, phaseKey: string): Promise<DraftVersionView> {
    return this.changePhaseSet(caller, projectId, versionId, phaseKey, 'removed', async (manager, context, key) => {
      const phase = this.requirePhase(context, key);
      if (context.phases.length === 1) throw new ConflictException(keepOnePhaseRefusal(key));
      await manager.delete(ProjectFileEntity, { projectVersionId: context.version.id, ownerKind: 'phase', ownerId: phase.id });
      await manager.delete(ProjectTaskEntity, { projectPhaseId: phase.id });
      await manager.delete(ProjectPhaseEntity, { id: phase.id });
      // the note of an older-format Design's conversion goes with the phase, so a Design added later says nothing of it
      if (key === 'design') await manager.delete(SettingEntity, { key: designConversionKey(context.version.id) });
      // and the phase's plain-text notes, so a phase put back or added later says only what its own conversion did
      await this.dropPlainTextNotes(manager, context.version.id, key);
      return withBasePhase(context.version.compiled as CompiledSnapshot, key, null);
    });
  }

  /**
   * Put a removed phase back from the version the draft was opened from, as a
   * copy writes it: the source's compiled `PhaseContent` and its compiled tasks
   * into the draft's base snapshot, and its phase, task and file rows
   * (`copyPhaseRows`, `copyFilesToVersion` with that phase's rows only).
   */
  async restorePhase(caller: InstructorCaller, projectId: string, versionId: string, phaseKey: string): Promise<DraftVersionView> {
    return this.changePhaseSet(caller, projectId, versionId, phaseKey, 'restored', async (manager, context, key) => {
      if (context.phases.some((one) => one.key === key)) throw new ConflictException(alreadyHeldRefusal(key));
      const sourceId = context.version.forkedFromVersionId ?? null;
      const source = sourceId ? await manager.findOne(ProjectVersionEntity, { where: { id: sourceId } }) : null;
      const sourcePhase = source?.compiled?.content.phases.find((one) => one.key === key) ?? null;
      const sourceRow = source ? await manager.findOne(ProjectPhaseEntity, { where: { projectVersionId: source.id, key } }) : null;
      if (!source || !sourcePhase || !sourceRow) throw new ConflictException(cannotPutBackRefusal(key, { hasSource: sourceId !== null }));

      const moved = await this.copyPhaseRows(manager, source, context.version, sourcePhase, PLACED_ORDER_BASE + PHASE_ORDER.indexOf(key));
      if (moved) {
        await this.importer.copyFilesToVersion(manager, source.id, context.version.id, new Map([[moved.from, moved.to]]), new Set([moved.from]));
      }
      // The base snapshot takes the source's phase before any conversion reads
      // the draft: the compile `referenceFor` runs then holds the restored
      // phase (a row with no base phase is dropped), so a copied reference's
      // older Deployment or Maintenance converts to the reference's current
      // phase exactly, as the copy converts it, and the edit that conversion
      // makes to the stored snapshot is the snapshot this door answers.
      const tasks = (source.compiled as CompiledSnapshot).phases.find((one) => one.key === key)?.tasks ?? [];
      await this.guarded(manager, context.version, {
        compiled: withBasePhase(context.version.compiled as CompiledSnapshot, key, { phase: clone(sourcePhase), tasks: clone(tasks) }),
      });
      const legacy = LEGACY_PHASES.find((one) => one === PHASE_TITLES[key]);
      if (legacy) {
        const from = await manager.findOne(ProjectEntity, { where: { id: source.projectId } });
        await this.convertLegacyAtCopy(manager, context.version.id, `${from?.slug ?? 'its source'} ${source.version}`, legacy);
      }
      return (await manager.findOneByOrFail(ProjectVersionEntity, { id: context.version.id })).compiled as CompiledSnapshot;
    });
  }

  /**
   * Add an empty Requirements or Design phase: the base
   * `PhaseContent` `addedPhaseContent` builds into the draft's snapshot, a
   * phase row, its one task (the story or design arm of `addTask`, titled "The
   * story" or "The design", with an empty brief) and its seeded record. The
   * other four phases come with their files, tests and solution, so they come
   * only by upload or by Put back.
   */
  async addPhase(caller: InstructorCaller, projectId: string, versionId: string, phaseKey: string): Promise<DraftVersionView> {
    return this.changePhaseSet(caller, projectId, versionId, phaseKey, 'added', async (manager, context, key) => {
      if (context.phases.some((one) => one.key === key)) throw new ConflictException(alreadyHeldRefusal(key));
      if (!isAddedPhaseKey(key)) throw new ConflictException(addByUploadRefusal(key));
      if ((await this.sourcePhaseKeys(manager, context.version))?.includes(key)) throw new ConflictException(addFromSourceRefusal(key));

      const content = addedPhaseContent(key, context.version.compiled?.content.language ?? context.version.manifest.language);
      const row = await manager.save(
        manager.create(ProjectPhaseEntity, {
          projectVersionId: context.version.id,
          key,
          order: PLACED_ORDER_BASE + PHASE_ORDER.indexOf(key),
          title: content.title,
          intro: content.intro,
          artifactKind: content.artifactKind,
          canRun: content.canRun,
          canPreview: content.canPreview,
          runLabel: content.runLabel,
          assistant: clone(content.assistant),
          interview: null,
        }),
      );
      const words = { taskKey: INHERITED_TASK_KEY, order: 1, required: true, title: ADDED_PHASE_TASK_TITLE[key], brief: '', objectives: [] };
      if (key === 'requirements') await this.writeStoryTask(manager, context.version.id, row.id, false, words);
      else await this.writeDesignTask(manager, context.version.id, row.id, words);
      return withBasePhase(context.version.compiled as CompiledSnapshot, key, { phase: content, tasks: [] });
    });
  }

  /**
   * The three doors' one shape, `mutateDraft`'s four rules for a change to
   * the draft's set of phases: the owned project; the version row locked
   * (`lockVersionRow`) before the draft is read; the key, a known phase
   * (`unknownPhaseRefusal`, the raw route key clipped); a draft
   * (`PUBLISHED_PHASES_FIXED` for a published version); the write, which
   * answers the base snapshot to store; the renumbering; the deep receipt
   * dropped, because the phase set is part of what it validated; one compile
   * and persist under the compare-and-swap; one `project.phase` audit row. The
   * answer is the draft view, read after the commit as `version.draft` reads it.
   */
  private async changePhaseSet(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: string,
    change: 'removed' | 'restored' | 'added',
    write: (manager: EntityManager, context: DraftContext, key: PhaseKey) => Promise<CompiledSnapshot>,
  ): Promise<DraftVersionView> {
    await this.dataSource.transaction(async (manager) => {
      await this.requireOwnedProject(manager, caller, projectId);
      // The version row locked before anything is read (PostgreSQL; a no-op on
      // sqlite, whose writers are serialised): the base snapshot and the
      // stored validation below are written outside `persist`'s
      // compare-and-swap, from what this door reads, so a second door or a
      // deep run's swap on this draft waits here until this one commits, then
      // reads the draft as it left it. A route id that is not a UUID locks
      // nothing and `load` refuses it.
      if (UUID_PATTERN.test(versionId)) await lockVersionRow(manager, versionId, 'pessimistic_write');
      const before = await this.load(manager, projectId, versionId);
      const raw = String(phaseKey ?? '');
      if (!(PHASE_ORDER as readonly string[]).includes(raw)) throw new NotFoundException(unknownPhaseRefusal(raw.slice(0, ROUTE_KEY_ECHO_MAX)));
      const key = raw as PhaseKey;
      if (before.version.status === 'published') throw new ConflictException(PUBLISHED_PHASES_FIXED);
      this.requireDraft(before.version);

      const base = await write(manager, before, key);
      // A door is a save too: a draft never saved, and the
      // source's markdown a Put back copied in, are stored plain before the
      // compile, and the draft view the door answers carries the notes.
      await this.convertDraftTexts(manager, before.version.id);
      await this.renumberPhases(manager, before.version.id);
      // the stored validation without its deep receipt, and the base snapshot the next compile overlays the rows onto
      const { deep: _stale, ...validation } = (before.version.validation ?? {}) as ProjectVersionValidation & Record<string, unknown>;
      await this.guarded(manager, before.version, {
        compiled: base,
        ...(before.version.validation ? { validation: validation as ProjectVersionValidation } : {}),
      });

      const loaded = await this.load(manager, projectId, versionId);
      const compiled = this.compile(loaded, loaded.version.version);
      await this.persist(manager, loaded, compiled);

      this.logger.log({ event: EDIT_EVENT.phase, actorId: caller.id, projectId, versionId, phaseKey: key, change });
      await recordAudit(manager, {
        event: EDIT_EVENT.phase,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        action: key,
        detail: { versionId, phaseKey: key, change },
      });
    });
    return this.readDraft(caller, projectId, versionId);
  }

  /** The draft's phase rows numbered 1 to n in LearnSDLC's order. */
  private async renumberPhases(manager: EntityManager, versionId: string): Promise<void> {
    const rows = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: versionId } });
    rows.sort((a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key));
    // two passes, so `UQ_project_phases_order` never sees two rows at one order mid-update
    for (const [at, row] of rows.entries()) await manager.update(ProjectPhaseEntity, { id: row.id }, { order: 1000 + at });
    for (const [at, row] of rows.entries()) await manager.update(ProjectPhaseEntity, { id: row.id }, { order: at + 1 });
  }

  /** The phase keys of the version a draft was opened from; null when it was opened from none. */
  private async sourcePhaseKeys(manager: EntityManager, version: ProjectVersionEntity): Promise<PhaseKey[] | null> {
    const sourceId = version.forkedFromVersionId ?? null;
    if (!sourceId) return null;
    const rows = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: sourceId }, select: { id: true, key: true } });
    return rows.map((one) => one.key);
  }

  /**
   * A Requirements phase's story task, as `addTask`'s story arm and the Phases
   * card's Add write it: type user-story, the default story criterion, the
   * builder's empty checks, the phase marked a story phase, and the empty
   * story record mounted when the phase has none.
   */
  private async writeStoryTask(manager: EntityManager, versionId: string, phaseId: string, mounted: boolean, words: AddedTaskWords): Promise<void> {
    const checks = validateStoryChecks({ kind: 'story' }, 'requirements');
    await manager.save(
      manager.create(ProjectTaskEntity, {
        projectPhaseId: phaseId,
        taskKey: words.taskKey,
        order: words.order,
        required: words.required,
        signOff: false,
        artefactType: 'user-story',
        // a story task writes its record through the room, and reads no prose file
        artefactPath: null,
        title: words.title,
        brief: words.brief,
        objectives: words.objectives,
        primaryPath: null,
        anchor: null,
        rubric: { passThreshold: 70, criteria: [{ ...DEFAULT_STORY_CRITERION }] },
        checks,
      }),
    );
    await manager.update(ProjectPhaseEntity, { id: phaseId }, { artifactKind: 'story' });
    if (!mounted) await insertDocumentRow(manager, versionId, phaseId, STORY_JSON, serialiseStory(EMPTY_STORY));
  }

  /**
   * A Design phase's design task, as `addTask`'s design arm and the Phases
   * card's Add write it: type design-doc, the default design criterion, the
   * builder's empty checks, the phase marked a design phase, and the record
   * and the contracts on by default seeded where the phase has none.
   */
  private async writeDesignTask(manager: EntityManager, versionId: string, phaseId: string, words: AddedTaskWords): Promise<void> {
    const checks = validateDesignChecks({ kind: 'design' }, 'design');
    await manager.save(
      manager.create(ProjectTaskEntity, {
        projectPhaseId: phaseId,
        taskKey: words.taskKey,
        order: words.order,
        required: words.required,
        signOff: false,
        artefactType: 'design-doc',
        // a design task writes JSON documents through the room, and reads no prose file
        artefactPath: null,
        title: words.title,
        brief: words.brief,
        objectives: words.objectives,
        primaryPath: null,
        anchor: null,
        rubric: { passThreshold: 70, criteria: [{ ...DEFAULT_DESIGN_CRITERION }] },
        checks,
      }),
    );
    // the phase is a design phase, as a conversion leaves one
    // (`convertLegacyDesignRows`), so the compiled kind and the export say so
    await manager.update(ProjectPhaseEntity, { id: phaseId }, { artifactKind: 'design' });
    // the record and the API contract (on by default), seeded, when the phase has none
    await this.syncDesignDocuments(manager, versionId, phaseId, checks, null);
  }

  /**
   * One phase of a published source written into a draft as rows: the phase
   * row from the source's compiled `PhaseContent`, at `order`, and its
   * compiled tasks as task rows, as a copy writes them. Answers the
   * `ownerMoves` pair (the source's phase row id to the new one) that carries
   * the phase's file rows across, or null when the source holds no phase row
   * of that key. The copy (`createProject`) and the Phases card's Put back
   * (`restorePhase`) share it.
   */
  private async copyPhaseRows(
    manager: EntityManager,
    source: ProjectVersionEntity,
    version: ProjectVersionEntity,
    phase: PhaseContent,
    order: number,
  ): Promise<{ from: string; to: string } | null> {
    const row = await manager.save(
      manager.create(ProjectPhaseEntity, {
        projectVersionId: version.id,
        key: phase.key,
        order,
        title: phase.title,
        intro: phase.intro,
        artifactKind: phase.artifactKind,
        canRun: phase.canRun,
        canPreview: phase.canPreview,
        runLabel: phase.runLabel,
        assistant: phase.assistant,
        interview: phase.interview ?? null,
      }),
    );
    const carried = [...(source.compiled?.phases.find((one) => one.key === phase.key)?.tasks ?? [])].sort(
      (a, b) => a.order - b.order,
    );
    for (const [at, task] of carried.entries()) {
      await manager.save(
        manager.create(ProjectTaskEntity, {
          projectPhaseId: row.id,
          // The synthesised sole task is keyed `''`, which no URL can
          // carry, so the copy writes it out under the key the editor
          // addresses it by; a task that already holds an authored key
          // keeps it, because that key is what its brief, its rules and
          // (once a learner is on this project) its state follow. Keying
          // by **position** instead would rename a source's first task
          // whatever it was: a quiz ordered first would arrive as the
          // copy's `main` a second time, and a source holding a quiz
          // before its `main` would write two rows under one key into
          // `UQ_project_tasks_key` and fail the copy with a driver's
          // sentence instead of the teacher's.
          taskKey: isAuthoredTaskKey(task.taskKey) ? task.taskKey : INHERITED_TASK_KEY,
          order: at + 1,
          required: task.required,
          signOff: task.signOff,
          artefactType: task.artefactType,
          artefactPath: task.artefactPath,
          title: task.title,
          brief: task.brief,
          objectives: task.objectives,
          primaryPath: null,
          anchor: null,
          rubric: task.rubric,
          // a task whose slice *is* the phase's carries none of its own
          // (the sole task of an untouched phase, and the sole non-quiz
          // task of a phase holding a quiz) and the row
          // has to carry one, so the phase's is what it takes. That is
          // what keeps the snapshot carrying them once
          // (`authoredTasksFor` omits them again on the way back).
          checks: task.checks ?? phase.checks,
        }),
      );
    }
    const was = await manager.findOne(ProjectPhaseEntity, { where: { projectVersionId: source.id, key: phase.key } });
    return was ? { from: was.id, to: row.id } : null;
  }

  /**
   * The stakeholder interview, written whole.
   *
   * The brief is checked by the content loader's own rules
   * (`validateInterviewBrief`), so a brief the loader would refuse is refused
   * here in the loader's words, and what is stored is exactly what the loader
   * would produce (every string as sent) so the reference's interview written
   * back unchanged is the reference's still. The door's own caps are
   * the ones the loader has none of (persona, lines, keywords).
   *
   * The phase row and its sealed `interview` row change in one transaction:
   * the row exists so the importer's first byte rule can see the brief's bytes,
   * and it is the importer's door that keeps it in step.
   */
  async putInterview(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    body: InterviewBody,
  ): Promise<PhaseMutationResult> {
    return this.mutateDraft(
      caller,
      projectId,
      versionId,
      INTERVIEW_PHASE,
      async (manager, context, phase) => {
        const brief = checkedInterview(body);
        await manager.update(ProjectPhaseEntity, { id: phase.id }, { interview: brief as never });
        await this.importer.replaceInterviewRow(manager, context.version.id, phase.id, brief);
        // the fact count and the byte length, never a word of the brief
        return {
          action: INTERVIEW_PHASE,
          detail: {
            phaseKey: INTERVIEW_PHASE,
            written: true,
            facts: brief.facts.length,
            bytes: Buffer.byteLength(canonicalJson(brief), 'utf-8'),
          },
        };
      },
      EDIT_EVENT.interview,
    );
  }

  /** Remove the interview and its sealed row. The Requirements room then holds no interview. */
  async removeInterview(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<PhaseMutationResult> {
    return this.mutateDraft(
      caller,
      projectId,
      versionId,
      INTERVIEW_PHASE,
      async (manager, context, phase) => {
        if (!phase.interview) {
          throw new ConflictException(`${phase.title} has no interview to remove.`);
        }
        await manager.update(ProjectPhaseEntity, { id: phase.id }, { interview: null });
        await this.importer.replaceInterviewRow(manager, context.version.id, phase.id, null);
        return { action: INTERVIEW_PHASE, detail: { phaseKey: INTERVIEW_PHASE, removed: true } };
      },
      EDIT_EVENT.interview,
    );
  }

  /**
   * The interview with its answers, for the project's owner alone, in
   * `readQuizKey`'s shape and for its reason: the draft payload is readable by
   * every instructor who can see the project, so it carries the interview
   * without answers, and the answers come through this door, behind
   * `requireOwnedProject`, leaving a `project.interview-read` row every time.
   * An ADMIN who can see the fork but does not own it is refused; a
   * teacher who cannot see it reads a 404. A published version is readable
   * too: a teacher asking what they shipped.
   */
  async readInterview(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<InterviewBody> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireOwnedProject(manager, caller, projectId);
      const context = await this.load(manager, projectId, versionId);
      const phase = this.requirePhase(context, INTERVIEW_PHASE);
      if (!phase.interview) {
        throw new NotFoundException(`${phase.title} has no interview in ${context.version.version}.`);
      }
      const brief = phase.interview;
      this.logger.log({
        event: INTERVIEW_READ_AUDIT_EVENT,
        actorId: caller.id,
        projectId,
        versionId,
        facts: brief.facts.length,
      });
      await recordAudit(manager, {
        event: INTERVIEW_READ_AUDIT_EVENT,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        action: INTERVIEW_PHASE,
        reason: null,
        detail: { versionId, phaseKey: INTERVIEW_PHASE, facts: brief.facts.length },
      });
      return clone(brief) as InterviewBody;
    });
  }

  /**
   * One file's bytes, replaced in a written phase of a draft.
   *
   * Refused, each in one sentence and in this order: any phase whose files are
   * an application's; a path the phase does not mount (a replace never adds a
   * file); a sealed or canonical row; and a structured record the room builds
   * from a learner's work. Then the bytes go through the importer's
   * door, which keeps the path and the role and re-asks both byte rules.
   *
   * A read-only document several written phases mount (the provided backlog)
   * is one document, so it is replaced in every written phase's row at
   * that path in the same transaction, and the answer names the others.
   */
  async replaceFile(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    body: ReplaceFileBody,
  ): Promise<ReplaceFileResult> {
    return this.mutateDraft<{ alsoReplacedIn: PhaseKey[] }>(
      caller,
      projectId,
      versionId,
      phaseKey,
      async (manager, context, phase) => {
        const at = String(body?.path ?? '');
        const content = (key: PhaseKey) => context.content.phases.find((one) => one.key === key);
        // A Deployment's starting runbook and a Maintenance's starting change request are the builder's,
        // checked before the application phase's refusal, validated as the room validates them and stored in their validated form.
        const recordTask = (context.tasks.get(phase.id) ?? []).find(
          (one) =>
            (at === RUNBOOK_JSON && one.checks.kind === 'config' && !!one.checks.runbook) ||
            (at === CHANGE_REQUEST_JSON && one.checks.kind === 'code' && !!one.checks.change && !!one.checks.ticket),
        );
        if (recordTask) {
          const row = context.files.find((one) => one.ownerKind === 'phase' && one.ownerId === phase.id && one.path === at);
          if (!row) throw new BadRequestException(fileNotMountedRefusal(at, phase.title));
          // "Start empty" sends the empty record as content; "Reset to the pack's" reads the source version's
          const sent =
            body?.reset === 'source'
              ? await this.sourceRecordDocument(manager, context.version, phase.key, at)
              : writtenText(body?.content, `"${at}"`, REPLACE_FILE_CONTENT_MAX);
          const config = recordTask.checks as ConfigChecks;
          const code = recordTask.checks as CodeChecks;
          const problem = at === RUNBOOK_JSON ? startingRunbookProblem(sent, !!config.drill) : startingChangeProblem(sent, code.ticket!);
          if (problem) throw new BadRequestException(problem);
          let stored: string;
          if (at === RUNBOOK_JSON) stored = serialiseRunbook(validateRunbookRecord(sent).runbook!);
          else {
            // a starting change request sent or reset while the contract is off is stored with no amendments
            const read = validateChangeRequestRecord(sent, null).change!;
            stored = serialiseChangeRequest(code.change!.contract ? read : { ...read, contract: [] });
          }
          await this.importer.replaceFileBytes(manager, [row.id], stored, { startingRecord: true });
          return {
            action: `${phaseKey}:${at}`,
            detail: { phaseKey, path: at, bytes: Buffer.byteLength(stored, 'utf-8'), alsoReplacedIn: [] },
            extra: { alsoReplacedIn: [] },
          };
        }
        if (isApplicationPhase(content(phase.key))) {
          throw new BadRequestException(applicationFileRefusal(await this.referenceName(manager)));
        }
        const row = context.files.find(
          (one) => one.ownerKind === 'phase' && one.ownerId === phase.id && one.path === at,
        );
        if (!row) throw new BadRequestException(fileNotMountedRefusal(at, phase.title));
        if (row.role !== 'workspace' || !isAuthoringReadableRole(row.role)) {
          throw new BadRequestException(withheldFileReplaceRefusal(at));
        }
        // A design task's documents are its Starting point: replaced here,
        // each validated as the room validates it (the record stored in its
        // validated form, a contract as sent), a malformed one refused.
        const designTask = (context.tasks.get(phase.id) ?? []).find((one) => one.checks.kind === 'design');
        // a contract still mounted with its switch off is named as off, not as the room's record
        if (designTask && mountedSwitchedOffContract([at], (designTask.checks as DesignChecks).contracts)) {
          throw new BadRequestException(designContractOffRefusal(at === API_CONTRACT_JSON ? 'API' : 'screen'));
        }
        if (designTask && designDocumentPaths((designTask.checks as DesignChecks).contracts).includes(at)) {
          // "Reset to the pack's": the bytes of the version this draft was
          // opened from, validated and stored exactly as sent bytes are.
          const sent =
            body?.reset === 'source'
              ? await this.sourceDesignDocument(manager, context.version, at)
              : writtenText(body?.content, `"${at}"`, REPLACE_FILE_CONTENT_MAX);
          const error = designDocumentError(at, sent, 'starting');
          if (error) throw new BadRequestException(error);
          const stored = at === DESIGN_JSON ? serialiseDesign(validateDesignRecord(sent).design!) : sent;
          await this.importer.replaceFileBytes(manager, [row.id], stored);
          return {
            action: `${phaseKey}:${at}`,
            detail: { phaseKey, path: at, bytes: Buffer.byteLength(stored, 'utf-8'), alsoReplacedIn: [] },
            extra: { alsoReplacedIn: [] },
          };
        }
        if (row.editable && at.endsWith('.json')) {
          const held = context.tasks.get(phase.id) ?? [];
          const editable = content(phase.key)?.files.filter((file) => file.editable).map((file) => file.path) ?? [];
          const owner = held.find((task) => ownsFor(task, held, editable).includes(at));
          throw new BadRequestException(roomRecordRefusal(at, owner?.title ?? phase.title));
        }
        const bytes = writtenText(body?.content, `"${at}"`, REPLACE_FILE_CONTENT_MAX);

        const targets = [row];
        const alsoReplacedIn: PhaseKey[] = [];
        if (!row.editable) {
          for (const other of context.phases) {
            if (other.id === phase.id || isApplicationPhase(content(other.key))) continue;
            const twin = context.files.find(
              (one) =>
                one.ownerKind === 'phase' &&
                one.ownerId === other.id &&
                one.path === at &&
                one.role === 'workspace' &&
                !one.editable,
            );
            if (twin) {
              targets.push(twin);
              alsoReplacedIn.push(other.key);
            }
          }
        }
        await this.importer.replaceFileBytes(
          manager,
          targets.map((one) => one.id),
          bytes,
        );
        return {
          action: `${phaseKey}:${at}`,
          // the path and the byte length, never the bytes
          detail: { phaseKey, path: at, bytes: Buffer.byteLength(bytes, 'utf-8'), alsoReplacedIn },
          extra: { alsoReplacedIn },
        };
      },
      EDIT_EVENT.files,
    );
  }

  /**
   * The bytes the version this draft was opened from mounts at `at` in the
   * phase `phaseKey` (`forkedFromVersionId`: the version a copy was made
   * from, or the head a new draft opened from), read from that version's
   * compiled snapshot; undefined when it mounts none. Refused, in one
   * sentence, where the draft was opened from nothing. "Reset to the pack's"
   * for a design document and for a starting record both read through here,
   * each with its own refusal for a missing document.
   */
  private async sourceSnapshotText(
    manager: EntityManager,
    version: ProjectVersionEntity,
    phaseKey: PhaseKey,
    at: string,
  ): Promise<string | undefined> {
    if (!version.forkedFromVersionId) {
      throw new BadRequestException('This draft was not opened from another version, so there is nothing to reset to.');
    }
    const source = await manager.findOne(ProjectVersionEntity, { where: { id: version.forkedFromVersionId } });
    return source?.compiled?.content.phases
      .find((one) => one.key === phaseKey)
      ?.files.find((one) => one.path === at)?.content;
  }

  /**
   * A design document as the source version holds it (`sourceSnapshotText`).
   * A record in the board's older shape is folded into the schema, as the
   * loader folds it; a contract is returned as it is. Refused, in one
   * sentence, where that version holds no such document.
   */
  private async sourceDesignDocument(
    manager: EntityManager,
    version: ProjectVersionEntity,
    at: string,
  ): Promise<string> {
    const text = await this.sourceSnapshotText(manager, version, 'design', at);
    if (text === undefined) {
      const noun = at === DESIGN_JSON ? 'design record' : at === API_CONTRACT_JSON ? 'API contract' : 'screen contract';
      throw new BadRequestException(`The version this draft came from has no starting ${noun}.`);
    }
    if (at !== DESIGN_JSON) return text;
    const read = readDesignRecord(text);
    return read.design ? serialiseDesign(read.design) : text;
  }

  /**
   * "Reset to the pack's" for a starting runbook or change request: the bytes
   * the source version mounts at that path (`sourceSnapshotText`), or a
   * sentence when it mounts none.
   */
  private async sourceRecordDocument(
    manager: EntityManager,
    version: ProjectVersionEntity,
    phaseKey: PhaseKey,
    at: string,
  ): Promise<string> {
    const text = await this.sourceSnapshotText(manager, version, phaseKey, at);
    if (text === undefined) throw new BadRequestException(noSourceRecordRefusal(at));
    return text;
  }

  /**
   * The reference project's name as a person reads it: its registry title
   * before the em dash, never a slug. Read from the project row the
   * scenario table records, so no literal names it.
   */
  private async referenceName(manager: EntityManager): Promise<string> {
    const [slug] = referencePacks();
    const row = slug ? await manager.findOne(ProjectEntity, { where: { slug } }) : null;
    return referenceNameOf(row?.title);
  }

  /* ------------------------------ validate ------------------------------- */

  /** Run the fast tier, which touches no microVM, and store the report. */
  async validate(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
  ): Promise<ValidationReport> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireOwnedProject(manager, caller, projectId);
      await this.lockDraftRow(manager, versionId);
      const context = await this.load(manager, projectId, versionId);
      this.requireDraft(context.version);
      const compiled = this.compile(context, context.version.version);
      const report = await this.persist(manager, context, compiled);

      this.logger.log({
        event: EDIT_EVENT.validate,
        actorId: caller.id,
        projectId,
        versionId,
        publishable: report.publishable,
        failed: report.failed,
      });
      await recordAudit(manager, {
        event: EDIT_EVENT.validate,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        action: context.version.version,
        detail: {
          versionId,
          tier: report.tier,
          publishable: report.publishable,
          failed: report.failed,
          blocking: report.blocking,
        },
      });
      return report;
    });
  }

  /* -------------------------------- publish -------------------------------- */

  /**
   * Freeze the draft at a version. Immutable from that moment.
   *
   * One transaction: re-run the fast tier and refuse on any failed check naming
   * it, compile through the one compiler, write the snapshot and its digest, and
   * flip the status through the importer's own door, which re-asks the
   * importer's two byte rules of the rows as they stand.
   *
   * **The safety gate.** The learner-side runtime serves one graded task per
   * phase, beside any concept quizzes, so this refuses a version in which any
   * phase holds more than `publishableTasksPerPhase()` non-quiz tasks, by name,
   * per phase. The draft keeps every task; only the publish is refused.
   * `publishableTasksPerPhase` (`packages/shared/src/authoring.ts`) holds that
   * limit: one, for every kind.
   */
  async publish(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    body: PublishVersionBody,
  ): Promise<PublishVersionResult> {
    const wanted = String(body.version ?? '').trim();
    if (!PROJECT_VERSION_PATTERN.test(wanted)) {
      throw new BadRequestException(
        `"${wanted}" is not a version this can publish. A version is MAJOR.MINOR.PATCH — 1.0.0, 1.2.3 — because ` +
          'the head a class resolves is decided by comparing those three numbers.',
      );
    }
    const notes = body.notes === undefined ? null : requireText(body.notes, 'notes', VERSION_NOTES_MAX);

    const published = await this.dataSource.transaction(async (manager) => {
      const project = await this.requireOwnedProject(manager, caller, projectId);
      await this.lockDraftRow(manager, versionId);
      const context = await this.load(manager, projectId, versionId);
      this.requireDraft(context.version);
      // No new version publishes a structured phase in its older form,
      // Requirements first:
      // a markdown task in Requirements or Design, a config task without a
      // runbook in Deployment, a code task without a change request in
      // Maintenance. A markdown task under any other key has nothing left to
      // grade it, and is refused with the upload's sentence for its phase.
      for (const [key, refusal] of OLDER_FORMAT_PUBLISH_REFUSALS) {
        const phase = context.phases.find((one) => one.key === key);
        if (phase && (context.tasks.get(phase.id) ?? []).some((task) => isOlderFormat(key, task.checks))) {
          throw new BadRequestException(refusal);
        }
      }
      for (const phase of context.phases) {
        if (phase.key === 'requirements' || phase.key === 'design') continue;
        if ((context.tasks.get(phase.id) ?? []).some((task) => isOlderWritten(task.checks))) {
          throw new BadRequestException(retiredWrittenPhaseUploadRefusal(phase.title));
        }
      }

      const others = await manager.find(ProjectVersionEntity, {
        where: { projectId: project.id, status: 'published' },
      });
      const newest = others.sort((a, b) => compareProjectVersions(b.version, a.version))[0];
      if (newest && compareProjectVersions(wanted, newest.version) <= 0) {
        throw new ConflictException(
          `${project.title} already has ${newest.version} published, and a version never goes backwards — a class ` +
            `resolving the head would otherwise move to older content. Publish something after ${newest.version}.`,
        );
      }
      const compiled = this.compile(context, wanted);
      // The subset rules, fail-closed: the doors keep one phase and
      // write the order, so neither refusal can arise from the editor.
      if (!compiled.content.phases.length) throw new BadRequestException(NO_PHASE_TO_PUBLISH);
      const fault = phaseSetRefusal(compiled.content.phases);
      if (fault) throw new ConflictException(fault.sentence);
      const report = await this.persist(manager, context, compiled, { version: wanted });
      if (!report.publishable) {
        throw new BadRequestException({
          message: report.blocking.join(' '),
          error: 'Bad Request',
          statusCode: 400,
          validation: report,
        });
      }
      if (!compiled.snapshot) {
        // unreachable while the compile row is part of the report, and a
        // refusal is still better than a published version with no snapshot
        throw new BadRequestException(compiled.error ?? 'This version does not compile.');
      }

      await this.guarded(manager, context.version, {
        version: wanted,
        compiled: compiled.snapshot,
        contentDigest: contentDigestOf(compiled.snapshot),
        sandboxBudget: compiled.snapshot.sandboxBudget,
        notes,
      });
      // Asked before the flip, of the stored rows (never `newest` above, which
      // reads any published row, where a head needs a compiled snapshot).
      const hadHead = await hasStoredHead(manager, project.id);
      await this.importer.publishVersion(manager, context.version.id, caller.id);
      // A project's first publish pins its null rows to this version, the one
      // they resolve from now on, counted on the audit row.
      const pins = hadHead ? null : await pinNullRowsAtFirstPublish(manager, project.slug, context.version.id);
      const row = await manager.findOneByOrFail(ProjectVersionEntity, { id: context.version.id });

      this.logger.log({
        event: EDIT_EVENT.publish,
        actorId: caller.id,
        projectId,
        versionId,
        slug: project.slug,
        version: wanted,
        sandboxBudget: row.sandboxBudget,
      });
      await recordAudit(manager, {
        event: EDIT_EVENT.publish,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        action: wanted,
        detail: {
          versionId,
          slug: project.slug,
          version: wanted,
          sandboxBudget: row.sandboxBudget,
          notes,
          phases: compiled.snapshot.phases.map((one) => ({ key: one.key, tasks: one.tasks.length })),
          ...(pins?.pinned ? { pinnedFromNull: pins.pinned } : {}),
          ...(pins?.pinnedPhaseMismatch ? { pinnedPhaseMismatch: pins.pinnedPhaseMismatch } : {}),
        },
      });

      return {
        versionId: row.id,
        version: row.version,
        publishedAt: row.publishedAt ?? new Date().toISOString(),
        sandboxBudget: row.sandboxBudget ?? 0,
        validation: report,
      } satisfies PublishVersionResult;
    });

    // what the runtime serves is the published rows, so the new one is installed
    // before the call returns and the teacher's next click can find it
    await this.registry.load();
    return published;
  }

  /* -------------------------------- the guards ----------------------------- */

  /**
   * A version of a project the caller owns, or the
   * refusal every owned door gives: for the routes whose service lives
   * elsewhere (deep validation), so a version of somebody else's project is never
   * handed to it under this project's path.
   */
  async requireOwnedVersion(caller: InstructorCaller, projectId: string, versionId: string): Promise<void> {
    const manager = this.dataSource.manager;
    await this.requireOwnedProject(manager, caller, projectId);
    const version = await this.requireVersion(manager, versionId);
    if (version.projectId !== projectId) throw new NotFoundException('no version with that id in that project');
  }

  /**
   * A project the caller may see.
   *
   * A 404 rather than a 403 for one they may not, by the written policy every
   * instructor route follows: guessing ids must tell a second teacher nothing
   * about which projects exist in other people's libraries.
   */
  private async requireVisibleProject(
    manager: EntityManager,
    caller: InstructorCaller,
    projectId: string,
  ): Promise<ProjectEntity> {
    const project = UUID_PATTERN.test(projectId)
      ? await manager.findOne(ProjectEntity, { where: { id: projectId } })
      : null;
    const visible =
      project &&
      (caller.role === 'ADMIN' || project.platformOwned || project.ownerUserId === caller.id);
    if (!visible) throw new NotFoundException('no project with that id in your library');
    return project;
  }

  /**
   * A project the caller may write to, which is only ever one they made.
   *
   * The platform's own project is assignable and copyable and never editable in
   * place, and `ADMIN` is the role that may read everything rather than the role
   * that may edit everybody's.
   */
  private async requireOwnedProject(
    manager: EntityManager,
    caller: InstructorCaller,
    projectId: string,
  ): Promise<ProjectEntity> {
    const project = await this.requireVisibleProject(manager, caller, projectId);
    if (project.platformOwned) {
      throw new ForbiddenException(platformProjectCopyOnlyRefusal(project.title));
    }
    if (project.ownerUserId !== caller.id) {
      throw new ForbiddenException(projectNotYoursRefusal());
    }
    return project;
  }

  private requireDraft(version: ProjectVersionEntity): void {
    if (version.status !== 'draft') {
      throw new ConflictException(draftOnlyRefusal(version.version, version.status));
    }
  }

  private async requireVersion(
    manager: EntityManager,
    versionId: string,
  ): Promise<ProjectVersionEntity> {
    const version = UUID_PATTERN.test(versionId)
      ? await manager.findOne(ProjectVersionEntity, { where: { id: versionId } })
      : null;
    if (!version) throw new NotFoundException('no version with that id');
    return version;
  }

  private requirePhase(context: DraftContext, phaseKey: PhaseKey): ProjectPhaseEntity {
    const phase = context.phases.find((one) => one.key === phaseKey);
    if (!phase) throw new NotFoundException(`this project has no ${phaseKey} phase`);
    return phase;
  }

  /** A task the caller may edit: it exists, and it is not one the copy brought. */
  private requireAuthorableTask(
    held: ProjectTaskEntity[],
    phaseTitle: string,
    taskKey: string,
  ): ProjectTaskEntity {
    const task = held.find((one) => one.taskKey === taskKey);
    if (!task) throw new NotFoundException(`${phaseTitle} has no task keyed "${taskKey}"`);
    if (!isAuthorableTask(task.checks.kind, task.artefactType)) {
      throw new ForbiddenException(inheritedTaskRefusal(task.title));
    }
    return task;
  }

  /**
   * An inherited task's criteria as the pack shipped them, read
   * from the platform version the copy began from (the first platform-owned
   * version up its fork chain), or null when that cannot be read.
   */
  private async packCriteriaOf(
    manager: EntityManager,
    version: ProjectVersionEntity,
    phaseKey: PhaseKey,
    taskKey: string,
  ): Promise<RubricCriterion[] | null> {
    return packCriteriaIn(await this.platformVersionOf(manager, version), phaseKey, taskKey);
  }

  /** The first platform-owned version up `version`'s fork chain, or null when that cannot be read. */
  private async platformVersionOf(manager: EntityManager, version: ProjectVersionEntity): Promise<ProjectVersionEntity | null> {
    let id = version.forkedFromVersionId;
    for (let hop = 0; id && hop < 64; hop++) {
      const at = await manager.findOne(ProjectVersionEntity, { where: { id } });
      if (!at) return null;
      const project = await manager.findOne(ProjectEntity, { where: { id: at.projectId } });
      if (project?.platformOwned) return at;
      id = at.forkedFromVersionId;
    }
    return null;
  }

  /**
   * A design phase's documents, kept in step with its task's switches: the
   * record and each contract switched on are mounted, seeded as the loader
   * seeds them, when no row holds them, and a contract switched off loses its
   * row. The sequence switch touches no row: the diagram lives in the record.
   * Both writes go through the importer's doors, so the byte rules are asked;
   * the delete sets aside the design task's own claim (`ownerTaskId`), which
   * is exactly the claim the switch gives up.
   */
  private async syncDesignDocuments(
    manager: EntityManager,
    versionId: string,
    phaseId: string,
    checks: DesignChecks,
    ownerTaskId: string | null,
  ): Promise<void> {
    const rows = await manager.find(ProjectFileEntity, {
      where: { projectVersionId: versionId, ownerKind: 'phase', ownerId: phaseId, role: 'workspace' },
    });
    const wanted = designDocumentPaths(checks.contracts);
    const missing = wanted.filter((at) => !rows.some((row) => row.path === at));
    if (missing.length) {
      await this.importer.insertFiles(
        manager,
        versionId,
        missing.map((at): NewFileRow => ({
          ownerKind: 'phase',
          ownerId: phaseId,
          path: at,
          role: 'workspace',
          editable: true,
          language: 'json',
          bytes: seededDesignDocument(at),
        })),
      );
    }
    const off = rows.filter((row) => (row.path === API_CONTRACT_JSON || row.path === SCREEN_CONTRACT_JSON) && !wanted.includes(row.path));
    if (off.length) {
      await this.importer.deleteFileRows(
        manager,
        versionId,
        off.map((row) => row.id),
        ownerTaskId ? { removingTaskId: ownerTaskId } : {},
      );
    }
  }

  /* ------------------------------- the machinery --------------------------- */

  /** Every project the caller may see: their own, and the platform's. */
  private async visibleProjects(
    manager: EntityManager,
    caller: InstructorCaller,
  ): Promise<ProjectEntity[]> {
    if (caller.role === 'ADMIN') return manager.find(ProjectEntity);
    const mine = await manager.find(ProjectEntity, { where: { ownerUserId: caller.id } });
    const library = await manager.find(ProjectEntity, { where: { platformOwned: true } });
    const byId = new Map([...mine, ...library].map((one) => [one.id, one]));
    return [...byId.values()];
  }

  private async summariesFor(
    manager: EntityManager,
    caller: InstructorCaller,
    projects: ProjectEntity[],
  ): Promise<AuthoredProjectSummary[]> {
    if (projects.length === 0) return [];
    const ids = projects.map((one) => one.id);
    const versions = await manager.find(ProjectVersionEntity, { where: { projectId: In(ids) } });
    const versionIds = versions.map((one) => one.id);
    const assignments = versionIds.length
      ? await manager.find(CohortProjectAssignmentEntity, {
          where: { projectVersionId: In(versionIds), state: 'active' },
        })
      : [];
    const projectOf = new Map(versions.map((one) => [one.id, one.projectId]));
    const cohorts = new Map<string, Set<string>>();
    for (const row of assignments) {
      const projectId = projectOf.get(row.projectVersionId);
      if (!projectId) continue;
      if (!cohorts.has(projectId)) cohorts.set(projectId, new Set());
      cohorts.get(projectId)!.add(row.cohortId);
    }

    return projects
      .map((project) => {
        const held = versions.filter((one) => one.projectId === project.id);
        const published = held
          .filter((one) => one.status === 'published')
          .sort((a, b) => compareProjectVersions(b.version, a.version))[0];
        const draft = held.find((one) => one.status === 'draft');
        const stored = draft?.validation as ReportedValidation | null | undefined;
        return {
          id: project.id,
          slug: project.slug,
          title: project.title,
          platformOwned: project.platformOwned,
          mine: project.ownerUserId === caller.id,
          isDefault: project.isDefault,
          origin: project.origin,
          publishedVersion: published?.version ?? null,
          publishedVersionId: published?.id ?? null,
          draftVersion: draft?.version ?? null,
          draftVersionId: draft?.id ?? null,
          cohortsUsing: cohorts.get(project.id)?.size ?? 0,
          lastValidatedAt: stored?.report?.ranAt ?? stored?.when ?? null,
          createdAt: isoOf(project.createdAt),
        } satisfies AuthoredProjectSummary;
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Every row of one version, and the pack they say it is. */
  private async load(
    manager: EntityManager,
    projectId: string,
    versionId: string,
  ): Promise<DraftContext> {
    const version = await this.requireVersion(manager, versionId);
    if (version.projectId !== projectId) {
      throw new NotFoundException('no version with that id in that project');
    }
    const project = await manager.findOneByOrFail(ProjectEntity, { id: projectId });
    if (!version.compiled) {
      throw new ConflictException(
        `${project.title} ${version.version} holds no compiled snapshot, so there is nothing to author against. ` +
          'It was written by something that did not finish.',
      );
    }

    const phases = (
      await manager.find(ProjectPhaseEntity, { where: { projectVersionId: version.id } })
    ).sort((a, b) => a.order - b.order);
    const phaseIds = phases.map((one) => one.id);
    const taskRows = phaseIds.length
      ? await manager.find(ProjectTaskEntity, { where: { projectPhaseId: In(phaseIds) } })
      : [];
    const tasks = new Map<string, ProjectTaskEntity[]>();
    for (const phase of phases) {
      tasks.set(
        phase.id,
        taskRows.filter((one) => one.projectPhaseId === phase.id).sort((a, b) => a.order - b.order),
      );
    }
    const files = await manager.find(ProjectFileEntity, {
      where: { projectVersionId: version.id },
    });

    const base = version.compiled.content;
    const baseFiles = new Map(base.phases.map((phase) => [phase.key, phase.files]));
    // A blob is read for every row the base
    // does not hold **and every row whose bytes are no longer the base's**:
    // a file a teacher replaced at a path the copy brought. An application
    // phase's rows are trusted, because no door writes them, but for its
    // starting record (a runbook or a change request), which `replaceFile` writes.
    const trustOf = new Map(base.phases.map((phase) => [phase.key, { trustBase: isApplicationPhase(phase), record: recordPathOf(phase.checks) }]));
    const workspace = files.filter((row) => row.ownerKind === 'phase' && row.role === 'workspace');
    const missing = new Set<string>();
    for (const phase of phases) {
      const rows = workspace.filter((one) => one.ownerId === phase.id);
      for (const sha of blobsToRead(rows, baseFiles.get(phase.key) ?? [], trustOf.get(phase.key))) missing.add(sha);
    }
    // The sealed rows a teacher wrote to an
    // executable phase's sole work task, only the ones whose bytes differ
    // from that task's slice, so an untouched phase reads no extra blob.
    const sealedRows = new Map<string, ProjectFileEntity[]>();
    for (const phase of phases) {
      // a phase the base lacks has no executable slice to ask about
      const basePhase = base.phases.find((one) => one.key === phase.key) ?? null;
      const slice = basePhase ? soleExecutableSliceOf(basePhase, tasks.get(phase.id) ?? []) : null;
      if (!slice) continue;
      const own = files.filter((row) => row.ownerKind === 'phase' && row.ownerId === phase.id);
      const changed = sealedRowsToOverlay(own, slice) as ProjectFileEntity[];
      if (changed.length === 0) continue;
      sealedRows.set(phase.key, changed);
      for (const row of changed) missing.add(row.blobSha);
    }
    const blobs = missing.size
      ? await manager.find(ContentBlobEntity, { where: { sha: In([...missing]) } })
      : [];
    const bytesBySha = new Map(blobs.map((blob) => [blob.sha, blob.bytes]));
    const bytesOf = (sha: string): string => bytesBySha.get(sha) ?? '';
    const sealed = new Map<string, SealedRowBytes[]>(
      [...sealedRows].map(([key, rows]) => [
        key,
        [...rows]
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
          .map((row) => ({ role: row.role, path: row.path, bytes: bytesOf(row.blobSha) })),
      ]),
    );

    const content = contentForDraft({
      base,
      slug: project.slug,
      version: version.version,
      title: project.title,
      manifest: version.manifest,
      phases: phases.map((row) => ({
        row,
        files: phaseFilesFrom(
          workspace.filter((one) => one.ownerId === row.id),
          baseFiles.get(row.key) ?? [],
          bytesOf,
          trustOf.get(row.key),
        ),
      })),
    });

    const design = phases.find((phase) => phase.key === 'design');
    const olderDesign = (design ? tasks.get(design.id) ?? [] : []).some(
      (task) => isOlderWritten(task.checks) && isInheritedTask(task.taskKey),
    );
    // the platform version the copy began from, read once for every phase still in the older shape
    let platform: Promise<ProjectVersionEntity | null> | undefined;
    const inheritedCriteria = async (key: PhaseKey) => packCriteriaIn(await (platform ??= this.platformVersionOf(manager, version)), key, INHERITED_TASK_KEY);
    const designPack = olderDesign ? await inheritedCriteria('design') : null;
    // the inherited Deployment or Maintenance task still in the older shape, read as the conversions read it; only a
    // draft shows the converted view (a published version is graded as it was published)
    const olderInherited = (key: PhaseKey, older: (checks: PhaseChecks) => boolean) => {
      const at = phases.find((phase) => phase.key === key);
      return version.status === 'draft' && (at ? tasks.get(at.id) ?? [] : []).some((task) => isInheritedTask(task.taskKey) && older(task.checks));
    };
    const runbookPack = olderInherited('deployment', (checks) => checks.kind === 'config' && !checks.runbook) ? await inheritedCriteria('deployment') : null;
    const changePack = olderInherited('maintenance', (checks) => checks.kind === 'code' && !checks.change) ? await inheritedCriteria('maintenance') : null;

    const designConversion = version.status === 'draft' ? await designConversionOf(manager, version.id) : null;
    const plainTextNotes = version.status === 'draft' ? await this.plainTextNotesOf(manager, version.id) : null;
    return {
      project, version, phases, tasks, files, content, referenceName: await this.referenceName(manager), sealed, designPack, runbookPack, changePack, designConversion,
      plainTextNotes,
    };
  }

  /**
   * The compiled snapshot, or the compiler's own sentence. The body is
   * `compileDraft` (draft.ts), shared so the importer's task block compiles a
   * draft exactly as this does.
   */
  private compile(
    context: DraftContext,
    version: string,
  ): { snapshot: CompiledSnapshot | null; error: string | null; content: ProjectContent } {
    return compileDraft(context, version);
  }

  /**
   * Write the draft's snapshot and its report, under the compare-and-swap every
   * authoring write uses.
   *
   * The content is refreshed whether or not the compile succeeded, because it is
   * a function of the rows and the rows have already moved; the compiled phases
   * are refreshed only when there are some, so a draft that does not compile
   * keeps the last ones it had and publish recompiles regardless.
   *
   * **`compiled` is written only when it moved.** The snapshot is the whole
   * pack by value (`pack-compiler` measures the shipped project at 1194 KB)
   * and `project_versions.compiled` is one `simple-json` column, so every write
   * is a megabyte rewritten. Most calls do move it and pay for it; the one that
   * routinely does not is the Validate button, because every task mutation has
   * already compiled and stored the same snapshot on its way out, so pressing
   * Validate after an edit would rewrite a megabyte to store bytes identical to
   * the ones already there. The report is always written: it carries `ranAt`,
   * which the editor reads back as when the tier last ran.
   *
   * Two known costs live outside this file.
   * `ProjectRegistryService.publishedVersions()` reads every published row with
   * no column selection, so `registry.load()` after a publish or an archive
   * materialises every published snapshot at once; and a fork stores a
   * second copy of the pack by value, because `compiled.content.phases[].files[]`
   * holds `content` rather than a `blobSha` the `ContentService` could hydrate
   * through the blob store. Both belong with the content module.
   */
  private async persist(
    manager: EntityManager,
    ctx: DraftContext,
    built: { snapshot: CompiledSnapshot | null; error: string | null; content: ProjectContent },
    over?: { version?: string },
    // Set to the context the stored compile was made of,
    // which is a re-read one when another writer committed after `ctx` loaded.
    seen?: { context?: DraftContext },
  ): Promise<ValidationReport> {
    // The context and its compile are re-read when
    // another draft write committed a compile after this one loaded (below).
    // `compiled` IS the caller's `built`: a recompile below is written into it,
    // so a caller that reads its compile after this returns (publish stores
    // `compiled.snapshot`) holds the one this report was made of.
    let context = ctx;
    const compiled = built;
    const references = await this.referenceFacts(manager);
    // `over.version` is set by publish alone, which is the report the
    // deep receipt refuses in (a warning on every other).
    const prepare = () => {
      const report = this.report(context, compiled, references, over?.version !== undefined);
      this.primeProvenance(context, compiled);
      // A fast validation owns its four keys and nothing else:
      // the deep receipt, the deep run's token and any key another service keeps
      // in this column are carried, read fresh at the write rather than from the
      // context loaded before the compile, so a receipt that landed meanwhile is
      // not overwritten with the older value.
      const snapshot: CompiledSnapshot = compiled.snapshot ?? {
        ...(context.version.compiled as CompiledSnapshot),
        slug: context.project.slug,
        version: over?.version ?? context.version.version,
        content: compiled.content,
      };
      const moved =
        !context.version.compiled || canonicalJson(snapshot) !== canonicalJson(context.version.compiled);
      return { report, snapshot, moved };
    };
    let { report, snapshot, moved } = prepare();
    // One extra swap is allowed for a re-read the file
    // rows asked for, so a sealed write that lands on the last attempt still
    // reaches the compile rather than a conflict.
    let attempts = PERSIST_SWAP_ATTEMPTS;
    let rowsReread = false;
    // The read and the write are one compare-and-swap on the column's stored
    // text (deep validation's `swap` rule), retried on a miss, so a receipt
    // deep validation commits between them is carried rather than overwritten.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const raw = (await manager
        .createQueryBuilder(ProjectVersionEntity, 'v')
        .select('v.status', 'status')
        .addSelect('v.version', 'version')
        .addSelect('v.validation', 'validation')
        .addSelect('v.compiled', 'compiled')
        .where('v.id = :id', { id: context.version.id })
        .getRawOne()) as
        | { status: ProjectVersionEntity['status']; version: string; validation: string | null; compiled: string | null }
        | undefined;
      if (!raw || raw.status !== 'draft') {
        // published meanwhile: the draft-only guard's conflict, in its words
        throw new ConflictException(draftOnlyRefusal(raw?.version ?? context.version.version, raw?.status ?? 'published'));
      }
      // The swap below pins `validation`, which
      // every draft write rewrites; this pins `compiled` too. A stored compile
      // that is not the one this context loaded is another draft write's,
      // committed after this load: its edit is in the rows and not in this
      // compile, so the context is read again (inside this transaction: this
      // write's own rows and the other's) and compiled again before the swap.
      if (!sameStoredCompiled(raw.compiled, context.version.compiled)) {
        context = await this.load(manager, context.project.id, context.version.id);
        Object.assign(compiled, this.compile(context, over?.version ?? context.version.version));
        ({ report, snapshot, moved } = prepare());
        continue;
      }
      const prev = raw.validation ?? null;
      const held = prev === null ? {} : (JSON.parse(prev) as Record<string, unknown>);
      const carried = Object.fromEntries(Object.entries(held ?? {}).filter(([key]) => !FAST_TIER_KEYS.has(key)));
      const stored: ReportedValidation & Record<string, unknown> = {
        ...carried,
        findings: report.blocking.map((message) => ({ severity: 'error', message })),
        tier: report.tier,
        when: report.ranAt,
        report,
      };
      const write = manager
        .createQueryBuilder()
        .update(ProjectVersionEntity)
        .set({ ...(moved ? { compiled: snapshot } : {}), validation: () => ':next' } as never)
        .where('id = :id', { id: context.version.id })
        .andWhere('status = :draft', { draft: 'draft' })
        .setParameter('next', JSON.stringify(stored));
      if (prev === null) write.andWhere('validation IS NULL');
      else write.andWhere('validation = :prev', { prev });
      if (((await write.execute()).affected ?? 0) !== 1) continue;
      // A sealed write changes file rows and neither
      // column the swap pins. Every writer that reaches here took the version
      // row's `pessimistic_write` first (`lockDraftRow`, `changePhaseSet`), as
      // the sealed door takes it before it writes, so this UPDATE is never the
      // first lock a writer takes on the row; the swap's UPDATE holds it here
      // (re-asserted below, PostgreSQL only: `for_no_key_update`, the mode the
      // UPDATE itself takes, which this transaction's earlier lock already
      // covers), so the file rows asked now are the ones this transaction
      // commits beside. Rows that are not the ones this context loaded are a
      // write committed after the load: the context is read again (this
      // transaction's own swap included) and compiled again, and swapped once
      // more against the text just written.
      if (await lockVersionRow(manager, context.version.id, 'for_no_key_update')) {
        if (!(await this.sameFileRows(manager, context))) {
          context = await this.load(manager, context.project.id, context.version.id);
          Object.assign(compiled, this.compile(context, over?.version ?? context.version.version));
          ({ report, snapshot, moved } = prepare());
          if (!rowsReread) attempts += 1;
          rowsReread = true;
          continue;
        }
      }
      if (seen) seen.context = context;
      return report;
    }
    throw new ConflictException(PERSIST_CONFLICT_REFUSAL);
  }

  /**
   * Whether the version's file rows are still the ones the
   * context loaded: ids, paths, roles and blobs; never a byte read.
   */
  private async sameFileRows(manager: EntityManager, context: DraftContext): Promise<boolean> {
    const now = await manager.find(ProjectFileEntity, {
      where: { projectVersionId: context.version.id },
      select: { id: true, path: true, role: true, blobSha: true },
    });
    const keyOf = (row: Pick<ProjectFileEntity, 'id' | 'path' | 'role' | 'blobSha'>) => `${row.id}\u0000${row.path}\u0000${row.role}\u0000${row.blobSha}`;
    const held = context.files.map(keyOf).sort();
    const fresh = now.map(keyOf).sort();
    return held.length === fresh.length && held.every((one, at) => one === fresh[at]);
  }

  /**
   * The boot's read of the reference anchors' plain-text twins and
   * provenance's executable keys: every published version
   * of the reference project, read as a draft write reads them
   * (`referenceFacts`), once after the registry loads
   * (`DraftConversionService`). Without it a process knows only the twins of
   * the reference pack on its disk until some teacher saves a draft, so a
   * copy converted from an older version (TaskTrackr 5.0.0's markdown briefs)
   * would read `authored` to the reviewer, the mentor, the Agentic calls,
   * deep validation and provenance in every process after the one that
   * converted it. It reads rows and writes none, and a second run adds
   * nothing. Answers how many published reference versions there are, the
   * one thing the boot says of it.
   */
  async rememberReferenceTwins(): Promise<number> {
    const manager = this.dataSource.manager;
    await this.referenceFacts(manager);
    const [slug] = referencePacks();
    const project = slug ? await manager.findOne(ProjectEntity, { where: { slug }, select: { id: true } }) : null;
    return project ? manager.count(ProjectVersionEntity, { where: { projectId: project.id, status: 'published' } }) : 0;
  }

  /**
   * What the scenario rows need to know about the reference project: its
   * name as a person reads it, and the stakeholders its published
   * versions' interviews name. Read from the rows the scenario table records,
   * so no literal names either: three small reads, the interview column only.
   */
  private async referenceFacts(manager: EntityManager): Promise<ReferenceFacts> {
    const [slug] = referencePacks();
    const project = slug ? await manager.findOne(ProjectEntity, { where: { slug } }) : null;
    const name = referenceNameOf(project?.title);
    if (!project) return { name, personas: [] };
    const versions = await manager.find(ProjectVersionEntity, {
      where: { projectId: project.id, status: 'published' },
      select: { id: true },
    });
    const phases = versions.length
      ? await manager.find(ProjectPhaseEntity, {
          where: { projectVersionId: In(versions.map((one) => one.id)), key: INTERVIEW_PHASE },
          select: { id: true, interview: true },
        })
      : [];
    const personas = [...new Set(phases.map((one) => one.interview?.persona?.name).filter((one): one is string => Boolean(one)))];
    const unknown = versions.map((one) => one.id).filter((id) => !REFERENCE_EXECUTABLE_MEMO.has(id));
    if (unknown.length) {
      const rows = await manager.find(ProjectVersionEntity, { where: { id: In(unknown) }, select: { id: true, compiled: true } });
      for (const row of rows) {
        REFERENCE_EXECUTABLE_MEMO.set(
          row.id,
          // the stored words and their plain text both: a copy whose brief became plain is still the reference's
          (row.compiled?.content.phases ?? []).filter((phase) => isApplicationPhase(phase)).flatMap(referenceExecutableKeys),
        );
        // and the AI scope's anchors answer the same twin for this version's phases (one predicate, every reader)
        rememberReferencePlainAnchors(row.compiled?.content.phases ?? []);
      }
    }
    const executable = new Set(versions.flatMap((one) => REFERENCE_EXECUTABLE_MEMO.get(one.id) ?? []));
    // the provenance resolver reads the same answer (one predicate, two readers)
    rememberReferenceExecutable(executable);
    return { name, personas, executable };
  }

  /**
   * The scenario rows' input: what is the
   * teacher's and what is still the reference's, per written phase, read off
   * the rows and the compiled content this context holds. The anchor-dependent
   * parts need compiled tasks, so a draft that does not compile draws only the
   * interview and document rows until it does.
   */
  private scenarioInput(
    context: DraftContext,
    compiled: { snapshot: CompiledSnapshot | null; content: ProjectContent },
    reference: ReferenceFacts,
  ): ScenarioValidationInput {
    const contentOf = new Map(compiled.content.phases.map((one) => [one.key, one]));
    const written = context.phases.filter((row) => !isApplicationPhase(contentOf.get(row.key)));
    const phaseFiles = (row: ProjectPhaseEntity) =>
      context.files.filter((file) => file.ownerKind === 'phase' && file.ownerId === row.id);

    const interviews: ScenarioValidationInput['interviews'] = [];
    for (const row of context.phases) {
      const sealed = phaseFiles(row).filter((file) => file.role === 'interview');
      if (!row.interview && sealed.length === 0) continue;
      let refusal: string | null = null;
      if (row.interview) {
        try {
          validateInterviewBrief(row.interview);
        } catch (error) {
          refusal = (error as Error).message;
        }
      }
      interviews.push({
        key: row.key,
        title: row.title,
        present: Boolean(row.interview),
        facts: row.interview?.facts?.length ?? 0,
        refusal,
        sealedRows: sealed.length,
        sealedMatches:
          Boolean(row.interview) && sealed.length === 1 && sealed[0].blobSha === sha256Hex(canonicalJson(row.interview)),
      });
    }

    const byPath = new Map<string, { row: ProjectPhaseEntity; sha: string }[]>();
    for (const row of written) {
      for (const file of phaseFiles(row)) {
        if (file.role !== 'workspace' || file.editable) continue;
        byPath.set(file.path, [...(byPath.get(file.path) ?? []), { row, sha: file.blobSha }]);
      }
    }
    const documents = [...byPath.entries()]
      .filter(([, held]) => held.length > 1)
      .map(([path, held]) => ({
        path,
        phases: held.map((one) => ({ key: one.row.key, title: one.row.title })),
        sameBytes: new Set(held.map((one) => one.sha)).size === 1,
      }));

    const requirementsRow = context.phases.find((row) => row.key === INTERVIEW_PHASE);
    const requirements = contentOf.get(INTERVIEW_PHASE);
    let backlog: ScenarioValidationInput['backlog'] = null;
    if (requirementsRow && requirements) {
      const held = context.tasks.get(requirementsRow.id) ?? [];
      const editable = requirements.files.filter((file) => file.editable).map((file) => file.path);
      const keepsRecord = held.some((task) => ownsFor(task, held, editable).includes(STORY_RECORD_PATH));
      const document = requirements.files.find((file) => file.path === PROVIDED_BACKLOG_PATH && !file.editable);
      if (keepsRecord && document) {
        const headings = [...document.content.matchAll(BACKLOG_STORY_HEADING)];
        backlog = {
          key: requirementsRow.key,
          title: requirementsRow.title,
          path: PROVIDED_BACKLOG_PATH,
          stories: headings.length,
          missing: headings.find((one) => /missing/i.test(one[2]))?.[1] ?? null,
        };
      }
    }

    const unnamedStakeholder: ScenarioValidationInput['unnamedStakeholder'] = [];
    const removedStakeholder: ScenarioValidationInput['removedStakeholder'] = [];
    const writtenPhases: ScenarioValidationInput['writtenPhases'] = [];
    const snapshot = compiled.snapshot;
    if (snapshot) {
      const snapshotPhase = new Map(snapshot.content.phases.map((one) => [one.key, one]));
      const persona = requirementsRow?.interview?.persona?.name ?? null;
      const gone = reference.personas.filter((one) => one !== persona);
      for (const row of written) {
        const phase = snapshotPhase.get(row.key);
        if (!phase) continue;
        const tasks = (snapshot.phases.find((one) => one.key === row.key)?.tasks ?? [])
          .filter((task) => !isQuizTask(task))
          .sort((a, b) => a.order - b.order);
        const anchored = new Map(tasks.map((task) => [task.taskKey, isReferenceTaskAnchor(phase, task)]));
        const scenarioOwn = !isReferenceScenario(phase);
        const inherited = tasks.find((task) => task.taskKey === INHERITED_TASK_KEY);
        writtenPhases.push({
          key: row.key,
          title: row.title,
          scenarioOwn,
          teachers: scenarioOwn || tasks.some((task) => !anchored.get(task.taskKey)),
          inheritedReference:
            inherited && anchored.get(inherited.taskKey) ? { taskKey: inherited.taskKey, title: inherited.title } : null,
        });
        for (const task of tasks) {
          const referenceTask = Boolean(anchored.get(task.taskKey)) && !scenarioOwn;
          // The reviewer's own test for handing over the facts (openai.provider.ts composeAuthoredReviewMessages: trimmed, any case).
          if (row.key === INTERVIEW_PHASE && persona && !referenceTask && !task.brief.toLowerCase().includes(persona.trim().toLowerCase())) {
            unnamedStakeholder.push({ key: row.key, taskKey: task.taskKey, title: task.title, persona });
          }
          for (const name of gone) {
            if (namesPerson(task.brief, name)) {
              removedStakeholder.push({ key: row.key, taskKey: task.taskKey, title: task.title, name });
            }
          }
        }
      }
    }

    return {
      referenceName: reference.name,
      interviews,
      documents,
      backlog,
      unnamedStakeholder,
      removedStakeholder,
      writtenPhases,
      application: compiled.content.phases.some((phase) => isApplicationPhase(phase) && isReferenceApplication(phase)),
    };
  }

  /** The fast tier, read off the rows this context holds. */
  private report(
    context: DraftContext,
    compiled: { snapshot: CompiledSnapshot | null; error: string | null; content: ProjectContent },
    reference?: ReferenceFacts,
    publishing?: boolean,
  ): ValidationReport {
    const stacks: SupportedStacks = readSupportedStacks();
    const byKey = new Map(compiled.content.phases.map((one) => [one.key, one]));
    // Which tasks are the reference's own by their anchor
    // alone, read off the compiled snapshot. A draft that does not compile
    // carries no answer, which the tier reads as yes (the usual refusals).
    const anchorOf = (phaseKey: PhaseKey, taskKey: string): { anchorReference?: boolean } => {
      const snapshot = compiled.snapshot;
      const phase = snapshot?.content.phases.find((one) => one.key === phaseKey);
      const task = snapshot?.phases.find((one) => one.key === phaseKey)?.tasks.find((one) => one.taskKey === taskKey);
      return phase && task ? { anchorReference: isReferenceTaskAnchor(phase, task) } : {};
    };
    const phases: ValidationPhaseInput[] = context.phases.map((row) => {
      const phase = byKey.get(row.key);
      const tasks = context.tasks.get(row.id) ?? [];
      // Which phases read the accepted screen copy, and what each task
      // owns: the same `ownsFor` the compile derives `owns` with.
      const editable = (phase?.files ?? []).filter((file) => file.editable).map((file) => file.path);
      return {
        key: row.key,
        title: row.title,
        checkKind: phase?.checks.kind ?? row.artifactKind,
        hasDrill: phase?.checks.kind === 'config' && Boolean(phase.checks.drill),
        readsScreenCopy: (phase?.files ?? []).some((file) => file.path === SCREEN_COPY_PATH),
        tasks: tasks.map((task) => ({
          taskKey: task.taskKey,
          title: task.title,
          required: task.required,
          artefactPath: task.artefactPath,
          // Two fields, and both of them are about the tier
          // below asking the rows the same questions the editor's own banner
          // asks. `checkKind` is what `phase-holds-one-task` counts by (the
          // **non-quiz** tasks, which is what the compiler's wall counts)
          // and without it this projection would count every task against a
          // kind-only budget, so a quiz beside a `code`, `tests` or `config`
          // task would read *cannot ship* here while `draftPhaseView` read
          // *ships* and the compiler published it. For a task with no quiz beside it
          // this is the identity: a phase's tasks carry the phase's own kind,
          // which is the fallback the field replaces.
          checkKind: task.checks.kind,
          // And the quiz itself, which is the only thing that can answer the
          // four rows about its own fields: how many questions, how many
          // options, whether the draw fits the pool, whether the mark is a
          // score a paper can land on, whether a required quiz can be re-sat
          // for ever. The compiler cannot ask any of them, so without this
          // they were four rows nothing produced.
          ...(task.checks.kind === 'quiz' ? { quiz: task.checks } : {}),
          owns: ownsFor(task, tasks, editable),
          ...anchorOf(row.key, task.taskKey),
        })),
      };
    });

    return fastValidation(
      {
        phases,
        runtime: compiled.content.runtime ?? null,
        hasBuild: Boolean(compiled.content.build),
        hasPreview: Boolean(compiled.content.preview),
        compileError: compiled.error,
        // The publish arm, on every draft this service compiles.
        executable: this.executableInput(context, compiled, reference, publishing),
        // The scenario rows, on every draft this service compiles.
        ...(reference ? { scenario: this.scenarioInput(context, compiled, reference) } : {}),
      },
      stacks,
    );
  }

  /**
   * What the publish arm asks of a draft. The
   * price is the compiler's own `sandboxBudgetFor` over the compiled tasks
   * (read only); the profile is the runtime profile's; the run shapes are the
   * upload's rule re-run over the compiled version; and an executable phase is the
   * reference project's only when its workspace is the reference application
   * **and** its checks are one of the reference project's published phases'.
   */
  private executableInput(
    context: DraftContext,
    compiled: { snapshot: CompiledSnapshot | null; content: ProjectContent },
    reference?: ReferenceFacts,
    publishing?: boolean,
  ): ExecutableValidationInput {
    const snapshot = compiled.snapshot;
    const budget = snapshot
      ? snapshot.content.phases.map((phase) => ({
          key: phase.key,
          title: phase.title,
          microVMs: sandboxBudgetFor(phase, snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? []),
        }))
      : [];
    // The runtime profile's reader throws when the deployment's own profile cannot
    // be read (a missing runtime lock, packs that disagree). That is a refusal
    // by sentence in this report (at validate and at publish) never a 500;
    // its message names host files, so it goes to the log and not the teacher.
    let runtime: ExecutableValidationInput['runtime'] = [];
    let runtimeUnreadable = false;
    try {
      runtime = runtimeProfileRefusals(compiled.content.runtime ?? null).map((one) => ({
        package: one.package,
        ecosystem: one.ecosystem,
        reason: one.reason,
      }));
    } catch (error) {
      runtimeUnreadable = true;
      this.logger.error({ event: 'authoring.runtime-profile-unreadable', versionId: context.version.id, reason: (error as Error)?.message });
    }
    const raw = rawPackManifestOf(compiled.content);
    const runShapes = [...checkPackRuns(raw), ...checkRunLimits(raw)];
    const known = reference?.executable ?? new Set<string>();
    // Against the bytes this compile produced (the ones publish ships) never
    // the stored snapshot, which a sealed write leaves behind.
    const deepCurrent = snapshot !== null && deepReceiptIsCurrent({ compiled: snapshot, validation: context.version.validation });
    const phases = compiled.content.phases
      .filter((phase) => isApplicationPhase(phase))
      .map((phase) => ({
        key: phase.key,
        title: phase.title,
        reference: isReferenceApplication(phase) && known.has(executableDigestKey(phase)),
        deepCurrent,
      }));
    return {
      budget,
      runtime,
      ...(runtimeUnreadable ? { runtimeUnreadable } : {}),
      runShapes,
      phases,
      publishing: Boolean(publishing),
      // words only: an upload's deep-receipt sentence does not name the reference
      // application, and neither does a copy of an upload (a copy whose phases
      // hold no reference application at all)
      ...(context.project.origin === 'upload' ||
      !compiled.content.phases.some((one) => isApplicationPhase(one) && isReferenceApplication(one))
        ? { uploaded: true }
        : {}),
    };
  }

  /**
   * One write to the version row, predicated on it still being a draft.
   *
   * A zero `affected` is a conflict and never a silent no-op: it means the
   * version was published between the read and the write, and the only honest
   * answer is that the edit did not happen.
   */
  private async guarded(
    manager: EntityManager,
    version: ProjectVersionEntity,
    patch: Partial<ProjectVersionEntity>,
  ): Promise<void> {
    const result = await manager.update(
      ProjectVersionEntity,
      { id: version.id, status: 'draft' },
      patch,
    );
    if (!result.affected) {
      const now = await manager.findOne(ProjectVersionEntity, { where: { id: version.id } });
      throw new ConflictException(
        draftOnlyRefusal(now?.version ?? version.version, now?.status ?? 'published'),
      );
    }
  }

  /**
   * The draft's version row locked for this transaction (PostgreSQL's
   * `pessimistic_write`; a no-op on sqlite, whose writers are serialised), as
   * the first write of every writer of a draft's rows: the editor's doors
   * (`mutateDraft`), the Phases card's (`changePhaseSet`), validate, publish,
   * the tagline and description, the sealed door (`sealed-roles.ts`) and the
   * boot's record and plain-text passes. Each then reads the draft as it
   * stands and writes its rows, and `persist`'s UPDATE of the same row last,
   * so two writers of one draft wait on each other in one order and never
   * deadlock. An id that is not a UUID locks nothing:
   * the draft's own read refuses it in its words.
   */
  private async lockDraftRow(manager: EntityManager, versionId: string): Promise<void> {
    if (UUID_PATTERN.test(versionId)) await lockVersionRow(manager, versionId, 'pessimistic_write');
  }

  /** Every task mutation: the same guards, the same refresh, the same answer. */
  private async mutateTasks(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    write: (
      manager: EntityManager,
      context: DraftContext,
      phase: ProjectPhaseEntity,
    ) => Promise<{ action: string; detail: Record<string, unknown> }>,
  ): Promise<TaskMutationResult> {
    const { phase, validation, plainTextConversion } = await this.mutateDraft(caller, projectId, versionId, phaseKey, write, EDIT_EVENT.tasks);
    return { phase, validation, ...(plainTextConversion ? { plainTextConversion } : {}) };
  }

  /**
   * Every write to a draft: `mutateTasks` generalised. The owned project,
   * the draft-only guard, the write, a reload,
   * the one compile, the persist under the compare-and-swap, and exactly one
   * audit row naming `event`, so a phase's intro, its interview and a file's
   * bytes are held to the same four rules a task edit is.
   *
   * `extra` rides the answer beside the phase and the report, for the one door
   * that says more (`files.replace`'s `alsoReplacedIn`).
   *
   * Before the write, a draft that still holds markdown is converted whole
   * (`convertDraftTexts`, the draft's first save), and that save's answer
   * carries the draft's notes (`plainTextConversion`). After the write, a
   * phase whose texts no longer hold an HTML comment loses that note, and one
   * whose members a markup-only note names are no longer empty loses that one
   * (`dropSpentNotes`), and the answer carries the notes then too.
   */
  private async mutateDraft<X extends Record<string, unknown> = Record<string, never>>(
    caller: InstructorCaller,
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    write: (
      manager: EntityManager,
      context: DraftContext,
      phase: ProjectPhaseEntity,
    ) => Promise<{ action: string; detail: Record<string, unknown>; extra?: X }>,
    event: AuthoringAuditEvent,
  ): Promise<TaskMutationResult & X> {
    return this.dataSource.transaction(async (manager) => {
      await this.requireOwnedProject(manager, caller, projectId);
      await this.lockDraftRow(manager, versionId);
      let before = await this.load(manager, projectId, versionId);
      this.requireDraft(before.version);
      this.requirePhase(before, phaseKey);
      // The builder's first save: a draft that still holds a text
      // with markdown is stored plain whole before the door's own write, in
      // this transaction, so a refused write converts nothing and the door
      // reads the rows as converted.
      const converted = await this.convertDraftTexts(manager, before.version.id);
      if (converted) before = await this.load(manager, projectId, versionId);
      const phase = this.requirePhase(before, phaseKey);

      const { action, detail, extra } = await write(manager, before, phase);
      const spent = await this.dropSpentNotes(manager, before.version.id, phaseKey);

      const loaded = await this.load(manager, projectId, versionId);
      const compiled = this.compile(loaded, loaded.version.version);
      // The answer is built from the context the stored
      // compile was made of: a re-read one when persist read the draft again.
      const seen: { context?: DraftContext } = {};
      const report = await this.persist(manager, loaded, compiled, undefined, seen);
      const after = seen.context ?? loaded;

      this.logger.log({ event, actorId: caller.id, projectId, versionId, phaseKey, action });
      await recordAudit(manager, {
        event,
        actorUserId: caller.id,
        subjectUserId: caller.id,
        targetId: projectId,
        action,
        detail: { versionId, ...detail },
      });

      return {
        ...(extra ?? ({} as X)),
        phase: this.phaseView(after, this.requirePhase(after, phaseKey)),
        validation: report,
        // only on a save that changed the draft's notes: the one that converted the draft, so the
        // editor reads the other phases again, or one that left a phase no HTML comment or no emptied member
        ...(spent ? { plainTextConversion: { notes: spent } } : converted ? { plainTextConversion: { notes: converted.held } } : {}),
      };
    });
  }

  /* --------------------------------- views --------------------------------- */

  /**
   * Each phase's provenance, from the draft's own
   * compiled snapshot: one compile per loaded context, primed by `persist`
   * with the compile it already ran. A draft that does not compile carries no
   * provenance until it does (absent reads as an older build's payload).
   */
  private readonly provenanceMemo = new WeakMap<DraftContext, Map<string, PhaseProvenanceView> | null>();

  private primeProvenance(context: DraftContext, built: { snapshot: CompiledSnapshot | null }): Map<string, PhaseProvenanceView> | null {
    const snapshot = built.snapshot;
    const views = snapshot
      ? new Map(
          snapshot.content.phases.map((phase) => [
            phase.key,
            phaseProvenance(phase, snapshot.phases.find((one) => one.key === phase.key)?.tasks ?? [], context.referenceName),
          ]),
        )
      : null;
    this.provenanceMemo.set(context, views);
    return views;
  }

  private draftProvenance(context: DraftContext): Map<string, PhaseProvenanceView> | null {
    if (this.provenanceMemo.has(context)) return this.provenanceMemo.get(context) ?? null;
    try {
      return this.primeProvenance(context, this.compile(context, context.version.version));
    } catch {
      return this.primeProvenance(context, { snapshot: null });
    }
  }

  private phaseView(context: DraftContext, phase: ProjectPhaseEntity): DraftPhaseView {
    const content = context.content.phases.find((one) => one.key === phase.key);
    const editable = content?.files.filter((file) => file.editable).map((file) => file.path) ?? [];
    const held = context.tasks.get(phase.id) ?? [];
    const tasks: DraftTaskView[] = held.map((row) =>
      draftTaskView(
        row,
        ownsFor(row, held, editable),
        content ? olderDesignView(phase.key, row, held, content.files, context.designPack) : null,
      ),
    );
    if (content) this.attachExecutableView(context, content, held, tasks);
    attachRecordViews(held, tasks);
    // A Deployment or Maintenance task still in the older format, on a draft: what its first save would convert it
    // to, or why that save would refuse, read from the phase's files and written nowhere.
    if (content && context.version.status === 'draft') {
      held.forEach((row, at) => {
        const runbook = olderRunbookView(phase.key, row, held, content.files, phase, context.runbookPack);
        const change = olderChangeView(phase.key, row, held, content.files, phase, context.changePack);
        const older = runbook ?? change;
        if (!older) return;
        if ('refused' in older) {
          tasks[at].recordConversionRefused = older.refused;
          return;
        }
        if (runbook && 'view' in runbook) {
          tasks[at].runbook = runbook.view;
          tasks[at].config = configViewOf(runbook.checks);
        }
        if (change && 'view' in change) tasks[at].change = change.view;
        tasks[at].rubric = older.rubric;
        tasks[at].recordOlderFormat = true;
      });
    }
    // The same expression `report()` builds `ValidationPhaseInput.checkKind`
    // from, so the gate the editor draws beside the phase and the gate in the
    // report beneath it are one answer rather than two.
    const view = draftPhaseView(phase, tasks, content?.checks.kind ?? phase.artifactKind);
    // The interview without its answers.
    if (phase.interview) view.interview = draftInterviewViewOf(phase.interview);
    const provenance = this.draftProvenance(context)?.get(phase.key);
    if (provenance) view.provenance = provenance;
    return view;
  }

  /**
   * The executable editor's view on the sole
   * work task of a code or tests phase, derived as the next compile derives
   * it (the teacher's sealed rows overlaid) and priced by the compiler's own
   * `sandboxBudgetFor`. Every sealed member is a digest (`executableTaskViewOf`).
   * A phase the derivation refuses carries no view: its report says why.
   */
  private attachExecutableView(
    context: DraftContext,
    content: PhaseContent,
    held: ProjectTaskEntity[],
    tasks: DraftTaskView[],
  ): void {
    if (!soleExecutableSliceOf(content, held)) return;
    const at = held.findIndex((row) => row.checks.kind !== 'quiz');
    if (at < 0 || !isAuthorableExecutableTask(held[at].checks.kind, held[at].artefactType)) return;
    let derived: PhaseContent;
    try {
      derived = phaseFromTasks(content, held, context.sealed.get(content.key) ?? []);
    } catch {
      return;
    }
    const priced = (context.version.compiled as CompiledSnapshot).phases.find((one) => one.key === content.key)?.tasks ?? [];
    const view = executableTaskViewOf(held[at], derived, tasks[at].owns, sandboxBudgetFor(derived, priced));
    if (view) (tasks[at] as DraftTaskWithExecutable).executable = view;
  }

  private draftView(
    project: ProjectEntity,
    context: DraftContext,
    caller: InstructorCaller,
    sourceKeys: PhaseKey[] | null,
  ): DraftVersionView {
    const stored = context.version.validation as ReportedValidation | null;
    const editable = !project.platformOwned && project.ownerUserId === caller.id && context.version.status === 'draft';
    return {
      projectId: project.id,
      versionId: context.version.id,
      version: context.version.version,
      status: context.version.status,
      slug: project.slug,
      title: project.title,
      tagline: context.version.manifest.tagline,
      description: context.version.manifest.description,
      platformOwned: project.platformOwned,
      editable,
      phases: context.phases.map((phase) => this.phaseView(context, phase)),
      validation: stored?.report ?? null,
      supportedStacks: readSupportedStacks(),
      createdAt: isoOf(context.version.createdAt),
      forkedFromVersionId: context.version.forkedFromVersionId ?? null,
      ...(context.designConversion ? { designConversion: context.designConversion } : {}),
      // only where the row exists, so a draft never converted carries no member at all
      ...(context.plainTextNotes ? { plainTextConversion: { notes: context.plainTextNotes } } : {}),
      phaseSet: phaseSetOf(context.phases.map((one) => one.key), sourceKeys, editable),
    };
  }
}

/* ------------------------------- small things ----------------------------- */

/** A quiz sent as some other artefact type, or a type sent away from its kind. */
export function quizIsItsOwnTypeRefusal(artefactType: ArtefactType): string {
  return (
    `A quiz is its own kind of task and its artefact type is "quiz", not "${artefactType}". A quiz is scored ` +
    'server-side by its key and writes no file, so it cannot be one of the written types and none of them can ' +
    'be it.'
  );
}

/**
 * The sign-off mark refused on a quiz. A quiz is scored
 * by its key, on the learner's own attempts, so it is never a task the class
 * sign-off queue countersigns.
 */
export function signOffQuizRefusal(title: string): string {
  return `"${title}" is a quiz, and a quiz is scored by its key, so it never waits for your sign-off. Mark the task the learner writes or builds instead.`;
}

/**
 * `versions.createDraft`, refused because the project was withdrawn: it holds
 * versions and every one of them is archived.
 *
 * This is a different state from the one `nothingPublishedRefusal` describes,
 * and answering that sentence here would say two false things at once, that the
 * project had published nothing, when it published and was withdrawn, and that
 * the teacher had a draft open to publish, when `archiveProject` archives every
 * row including the draft (`archiveProject`'s loop). So the state answers in its
 * own words.
 *
 * Every clause is checked against a door that exists: there is no un-withdraw
 * route, `createProject` refuses a source version that is not
 * `published`, and the library page a teacher copies from lists the platform's
 * project and their own published ones.
 *
 * It lives here rather than beside the other three in `packages/shared/src/authoring.ts`
 * because only the API speaks it: the same reason the "holds no compiled
 * snapshot" sentence a few lines above `createDraftVersion` is written here.
 * Lifting it into the contract would let `ProjectEditor` print this wording
 * instead of `nothingPublishedRefusal`.
 */
export function withdrawnProjectRefusal(projectTitle: string): string {
  return (
    `${projectTitle} was withdrawn, so every version of it is archived: there is nothing to open a new ` +
    'draft from, and an archived version cannot be copied either. Copy a published project from the ' +
    'library and edit that copy.'
  );
}

/**
 * Class portability: the class export document and the import result.
 */

import type { PhaseKey, PhaseStatus } from '../phases';
import type { AuditEventView, DrillState, FeedbackReport, PhaseLink } from './feedback';
import type { CohortView } from './instructor';
import type { JobStatus } from './runs';

/* ========================================================================== */
/* Class portability: one const pair, the export document and the import     */
/* result. Their three audit names are in AuditEventView['event'] (feedback). */
/* ========================================================================== */

/** The literal that identifies a class export; anything else is not one. */
export const COHORT_EXPORT_FORMAT = 'learnsdlc.cohort';
/**
 * Bumped only when a reader written for the old shape would get it wrong.
 *
 * **2** added `projectVersion` to an enrolment: its pin. `readDocument`
 * (`portability.service.ts`) refuses only a *newer* `formatVersion`,
 * so a field added without the bump would let a machine on an older build
 * accept the file, drop the pin without a word, send every imported enrolment
 * to its own published head for ever, and then record the old
 * `formatVersion` in a sha-stamped receipt: a receipt that says the file was
 * something it was not. With the bump that machine refuses by name and the
 * operator is told to upgrade, which is what the gate is for. A bump belongs
 * with the release that first writes the field it covers.
 *
 * **3** added `CohortExportPhase.tasks` and `CohortExportSubmission.taskKey`.
 * A v2 file still reads here, the guard refuses only a *newer* number, and
 * it imports shut wherever its phases cannot be evidenced against the
 * destination's pinned task list, which is the import's own reconciliation
 * rather than this constant's job.
 */
export const COHORT_EXPORT_VERSION = 3;

/**
 * The default ceiling on an import, in bytes, and what the panel assumes
 * before an export has told it what this deployment actually allows.
 * IMPORT_MAX_BYTES moves it; see config.ts and docs/production-runbook.md.
 */
export const COHORT_IMPORT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The response header the export route carries its deployment's real ceiling
 * in, so the panel can warn about a file that is too large to bring back in
 * without a route of its own. Listed in the API's CORS exposedHeaders.
 */
export const COHORT_IMPORT_MAX_BYTES_HEADER = 'x-cohort-import-max-bytes';

/** What an export was asked to carry beyond the default. */
export type CohortExportInclude = 'snapshots' | 'messages';

export interface CohortExportMessage {
  role: 'user' | 'assistant';
  phaseKey: PhaseKey;
  createdAt: string;
  provider: string;
  cached: boolean;
  redacted: boolean;
  scopeRedirected: boolean;
  tokensIn: number;
  tokensOut: number;
  /** Present only when the export included 'messages'. */
  content?: string;
}

/**
 * One task's state on one phase, as a class export carries it.
 *
 * All twelve fields, and deliberately **no `signedOffBy`**: an export carries
 * no ids, and a teacher's id is not the learner's to carry. `countersigned` is
 * the fact without the person, which is what makes the round trip advanceable:
 * the destination writes its own importing operator's id and says in the audit
 * row that it was restored from a file. A two-field shape would round-trip a
 * key and a status while losing `attempts`, `bestScore`, `solutionReadAt`,
 * `resetCount` and `awaitingSignOff` on a cohort transfer.
 */
export interface CohortExportTask {
  taskKey: string;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  ranBeforeSubmit: boolean;
  passedAt: string | null;
  solutionReadAt: string | null;
  awaitingSignOff: boolean;
  signedOffAt: string | null;
  resetAt: string | null;
  resetCount: number;
  /** Whether a teacher countersigned it. The fact, never the person. */
  countersigned: boolean;
}

export interface CohortExportSubmission {
  ref: string;
  /**
   * Which task of the phase this revision is about, `''` for a sole-task
   * phase. Optional in the type so that a reader of a v2 file, which is still
   * accepted, is not made to invent one.
   */
  taskKey?: string;
  status: JobStatus;
  score: number | null;
  passed: boolean | null;
  report: FeedbackReport | null;
  packVersion: string | null;
  error: string | null;
  createdAt: string;
  /** The editable files, only when the export included 'snapshots'. Null otherwise. */
  snapshot: Record<string, string> | null;
  // The run a revision belongs to.
  /**
   * `submissions.resetEpoch`: the task's reset count when this revision was
   * made, or null for the current run. Optional, so a file written without it
   * still reads, an absent value imports as null, and
   * `COHORT_EXPORT_VERSION` does not need to move for it.
   */
  resetEpoch?: number | null;
}

export interface CohortExportRelease {
  phaseKey: PhaseKey;
  phaseOrder: number;
  version: string;
  score: number | null;
  notes: string | null;
  createdAt: string;
}

export interface CohortExportPhase {
  ref: string;
  phaseKey: PhaseKey;
  phaseOrder: number;
  status: PhaseStatus;
  bestScore: number | null;
  attempts: number;
  reflection: string | null;
  workspace: Record<string, string> | null;
  links: PhaseLink[] | null;
  drill: DrillState | null;
  ranBeforeSubmit: boolean;
  unlockedAt: string | null;
  passedAt: string | null;
  /**
   * This phase's task rows, empty on a
   * phase whose task is the synthesised sole one. Optional in the type because
   * a v2 file carries none, and `status`/`passedAt` above are reconciled
   * against the destination's pinned task list on import whatever this array
   * holds: a file that says `passed` over a required key it carries no row for
   * imports shut.
   */
  tasks?: CohortExportTask[];
  submissions: CohortExportSubmission[];
  messages: CohortExportMessage[];
}

export interface CohortExportEnrollment {
  ref: string;
  projectSlug: string;
  packVersion: string | null;
  /**
   * The version this enrolment is pinned
   * to, as a string, because an export carries no ids. The destination
   * resolves it against its own published versions of the same slug and
   * refuses the enrolment by name when it holds none: the treatment an
   * unknown slug already gets. Absent on a version-1 file, which is what
   * `packVersion` is then resolved for instead.
   */
  projectVersion?: string | null;
  currentPhaseOrder: number;
  completed: boolean;
  startedAt: string;
  completedAt: string | null;
  phases: CohortExportPhase[];
  releases: CohortExportRelease[];
}

export interface CohortExportLearner {
  ref: string;
  email: string;
  displayName: string;
  /** Historical import/export field only; never enforces an AI quota. */
  dailyTokenBudget: number | null;
  createdAt: string;
  enrollments: CohortExportEnrollment[];
}

/** One row of the source machine's trail, kept for reading rather than replay. */
export interface CohortExportAuditEvent {
  event: AuditEventView['event'];
  actorName: string | null;
  /** The learner ref this row is about, or null when the subject was not in the class. */
  subjectRef: string | null;
  action: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface CohortExportCounts {
  learners: number;
  enrollments: number;
  phaseStates: number;
  submissions: number;
  messages: number;
  releases: number;
  auditEvents: number;
  // Optional because a version-2 document carries no task rows and its receipt must
  // keep reading; the import's own receipt always writes it, including the
  // zero that says this class has never seen an authored task.
  /** How many `task_states` rows the document carries, or the import wrote. */
  taskStates?: number;
}

/** A whole class as one file. Ids are removed; refs carry the structure. */
export interface CohortExportDocument {
  format: typeof COHORT_EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: string;
  exportedBy: { email: string; displayName: string };
  source: { host: string | null; schemaHead: string | null; packVersions: Record<string, string> };
  includes: CohortExportInclude[];
  cohort: { name: string; createdAt: string };
  learners: CohortExportLearner[];
  auditEvents: CohortExportAuditEvent[];
  counts: CohortExportCounts;
}

/** What happened, or would happen, to one learner in the file. */
export interface CohortImportLearnerOutcome {
  email: string;
  displayName: string;
  /** `matched` moved an existing account in; `created` minted one; `skipped` did nothing. */
  outcome: 'matched' | 'created' | 'skipped';
  /** Sentence case, shown as written, e.g. "Staff accounts are not imported into a class." */
  note: string | null;
  /**
   * Projects whose work did not come in, whatever the reason: the account
   * already had an enrolment on the project, the project or the version the
   * file names is not here or not in reach, or the enrolment was refused
   * (`note` says which).
   */
  skippedProjects: string[];
}

export interface CohortImportResult {
  /** False for a dry run: nothing was written. */
  applied: boolean;
  cohort: CohortView | null;
  source: { host: string | null; exportedAt: string | null; name: string };
  includes: CohortExportInclude[];
  learners: CohortImportLearnerOutcome[];
  written: CohortExportCounts;
  /** Accounts minted by this import; each needs a password before it can sign in. */
  createdAccounts: string[];
  /** Set when this exact document was imported here before. */
  alreadyImportedAt: string | null;
}

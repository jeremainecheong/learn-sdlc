'use client';

/**
 * The teacher-authoring client: every door of `AUTHORING_ROUTES` (the upload,
 * the profile, the seal, export and deep validation among them), and
 * nothing of its own: plus the sign-off table's two, which are not authoring
 * routes and are built from `SIGNOFF_ROUTES` the same way.
 *
 * **Paths are built from the table, not retyped beside it.** The contract
 * already declares every method and every path, placeholders and all, in
 * `AUTHORING_ROUTES` (`packages/shared/src/authoring.ts`). A client that
 * retypes those strings is a second copy of a closed set, and the
 * first one that drifts is a 404 a teacher meets rather than a red build. So
 * `authoringPath` substitutes into the table's own path and every call below
 * takes its method from the table's own entry.
 *
 * **The web namespace is not the API's.** These are API paths under
 * `/instructor`; the pages that call them live under
 * `/teacher/projects`. The two differ on purpose and neither is derived from
 * the other.
 *
 * **Roles are enforced at the API.** `@Roles('INSTRUCTOR','ADMIN')` and
 * `RolesGuard` are what make these doors staff-only. The pages check the
 * session too, so a learner who lands on one is sent somewhere useful instead
 * of watching a page of 403s, but that check is a courtesy, not the gate.
 */
import type {
  AddTaskBody,
  AssignProjectBody,
  AssignableVersionView,
  AuthoredProjectSummary,
  AuthoredQuiz,
  AuthoringFileView,
  AuthoringLibraryView,
  AuthoringRouteKey,
  CohortProjectView,
  CreateDraftVersionBody,
  CreateProjectBody,
  CreateProjectResult,
  DraftPhaseView,
  DraftVersionView,
  InterviewBody,
  PhaseKey,
  PhaseMutationResult,
  ProjectVersionStatus,
  PublishVersionBody,
  PublishVersionResult,
  ReplaceFileBody,
  ReplaceFileResult,
  TaskMutationResult,
  UpdatePhaseBody,
  UpdateProjectMetaBody,
  UpdateTaskBody,
  ValidationReport,
} from '@learnsdlc/shared';
import { AUTHORING_ROUTES, EXPORT_WITHHELD_HEADER } from '@learnsdlc/shared';
// The export answers an archive, fetched as a blob, and keeps lib/api's
// deadline and 401 handling.
import { API_BASE, ApiError, REQUEST_TIMEOUT_MS, getToken, request } from './api';
import { authHeader, isTimeout, timeoutSignal } from './api-fetch';
// The upload door, the one runtime profile, the seal and
// deep validation. Types only; the doors are the table's as every other.
import type {
  DeepValidationStartBody,
  DeepValidationView,
  ProjectUploadRequest,
  ProjectUploadResult,
  RuntimeProfileView,
  SealedFileOwnerRead,
  SealedFileReadQuery,
  SealedFileView,
  SealedFileWriteBody,
} from '@learnsdlc/shared';
// The sign-off table.
import type { BulkSignoffBody, BulkSignoffResult, SignoffQueueView, SignoffRouteKey } from '@learnsdlc/shared';
import { SIGNOFF_ROUTES } from '@learnsdlc/shared';
// The learner preview. Types only.
import type { LearnerPreviewView } from '@learnsdlc/shared';

/**
 * One route's path with its ids in it.
 *
 * Throws rather than sending `:versionId` down the wire: a path with a
 * placeholder still in it is a request that can only be refused, and a refusal
 * that names the missing id is worth more than a 404 whose body says nothing.
 * Every id is percent-encoded, so an id carrying a slash cannot open a path of
 * its own.
 */
export function authoringPath(
  key: AuthoringRouteKey,
  params: Record<string, string> = {},
): string {
  return AUTHORING_ROUTES[key].path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new Error(`The ${key} route needs a ${name}.`);
    }
    return encodeURIComponent(value);
  });
}

/** Call one route: its own method, its own path, the caller's body. */
function call<T>(key: AuthoringRouteKey, params: Record<string, string>, body?: unknown): Promise<T> {
  return request<T>(AUTHORING_ROUTES[key].method, authoringPath(key, params), body);
}

/**
 * What `projects.get` answers.
 *
 * It is declared here because the contract does not carry it: the shape is
 * `AuthoredProjectDetail` in `apps/api/src/authoring/authoring.service.ts`.
 * If `packages/shared` ever exports the name, this declaration goes and the
 * import takes its place: a duplicate identifier is what would say so,
 * rather than a silent second copy.
 *
 * `versions` carries one field rather than all nine. A second copy of nine
 * fields nobody reads is the drift this file exists to avoid, but `status` has
 * a reader: `ProjectEditor` tells a withdrawn project (one whose every version
 * is archived) from a project that has published nothing, and the two states
 * are identical in the summary above, which reports a null `publishedVersion`
 * for both. The row's whole shape is `AuthoredVersionSummary`, beside the
 * envelope it rides in.
 */
export interface AuthoredProjectDetail {
  /** The same row `projects.list` draws, for this one project. */
  project: AuthoredProjectSummary;
  /** Every version of it, newest first. */
  versions: AuthoredVersionRow[];
}

/** One row of that envelope, narrowed to the field the web reads. */
export interface AuthoredVersionRow {
  status: ProjectVersionStatus;
}

/* ----------------------------- the doors' helpers ----------------------------- */

/**
 * How long an upload may hold its button. A 32 MB archive is a ~43 MB JSON
 * body, read, compiled and validated before the API answers, so the default
 * 20 seconds would give up on a good upload.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The query `sealed.read` names its file in. A GET carries no body, so the
 * contract's `SealedFileReadQuery` rides here, each value percent-encoded.
 */
export function sealedReadQuery(query: SealedFileReadQuery): string {
  const params = new URLSearchParams({ role: query.role, path: query.path });
  if (query.runId) params.set('runId', query.runId);
  return params.toString();
}

/* ----------------------------- the sign-off table ----------------------------- */

/**
 * The sign-off doors are a table of their own (`SIGNOFF_ROUTES`), mounted on
 * the instructor controller and never `AuthoringRouteKey`s. The path is built
 * from that table exactly as `authoringPath` builds from its own.
 */
export function signoffPath(key: SignoffRouteKey, params: Record<string, string> = {}): string {
  return SIGNOFF_ROUTES[key].path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new Error(`The ${key} route needs a ${name}.`);
    }
    return encodeURIComponent(value);
  });
}

export const signoffApi = {
  /** The class's tasks awaiting a countersignature, by learner and task. */
  queue: (cohortId: string) =>
    request<SignoffQueueView>(SIGNOFF_ROUTES['signoff.queue'].method, signoffPath('signoff.queue', { cohortId })),

  /** One task, one reason, many learners. One audited row per learner. */
  bulk: (cohortId: string, body: BulkSignoffBody) =>
    request<BulkSignoffResult>(SIGNOFF_ROUTES['signoff.bulk'].method, signoffPath('signoff.bulk', { cohortId }), body),
};

/* -------------------- the starter archives, staff only ------------------------ */
import type { StarterArchiveName } from '@learnsdlc/shared';

/** `GET /instructor/starter/:name`: the instructor controller, behind the staff guard. */
export function starterPath(name: StarterArchiveName): string {
  return `/instructor/starter/${encodeURIComponent(name)}`;
}

export const projectsApi = {
  /** The caller's own projects, and the library they may copy or assign. */
  list: () => call<AuthoringLibraryView>('projects.list', {}),

  /** Make a project by copying a published version into a new draft. */
  create: (body: CreateProjectBody) => call<CreateProjectResult>('projects.create', {}, body),

  /**
   * One project: the row the library would draw, and every version it holds.
   *
   * The answer is the **envelope**, not the summary. `getProject` returns
   * `{ project, versions }` and nothing unwraps it on the way here (`request`
   * hands back the parsed body and the API registers no response interceptor)
   * so a caller typed to the summary reads `platformOwned`, `mine` and
   * `publishedVersion` one level too high, finds `undefined` in all three, and
   * takes whichever branch a missing field satisfies. `projects.updateMeta` and
   * `projects.archive` really do answer the flat summary; this one does not.
   */
  get: (projectId: string) => call<AuthoredProjectDetail>('projects.get', { projectId }),

  /**
   * Title lands on the projects row; tagline and description land on the draft
   * version's manifest, so a published version keeps the words it shipped
   * with. The editor re-reads the draft afterwards rather than trusting what
   * comes back, so the response shape is not load-bearing here.
   */
  updateMeta: (projectId: string, body: UpdateProjectMetaBody) =>
    call<AuthoredProjectSummary>('projects.updateMeta', { projectId }, body),

  archive: (projectId: string) => call<AuthoredProjectSummary>('projects.archive', { projectId }),

  /** The draft tree: phases, tasks and the last validation report. */
  draft: (projectId: string, versionId: string) =>
    call<DraftVersionView>('version.draft', { projectId, versionId }),

  /**
   * Open the next draft from the project's published head, so a project that
   * has been published can be edited again.
   *
   * `fromVersionId` is the head as the caller last read it, and it is an
   * optimistic guard rather than a choice of parent: the draft always opens
   * from the head, and a version that is no longer the head is refused with
   * `draftFromStaleHeadRefusal` rather than honoured: copying older rows
   * would quietly undo whatever the other teacher published in between.
   *
   * The answer is a `DraftVersionView`, the same shape `version.draft` gives,
   * so the caller routes straight into the draft it just opened.
   */
  createDraft: (projectId: string, body: CreateDraftVersionBody) =>
    call<DraftVersionView>('versions.createDraft', { projectId }, body),

  /** The fast tier. Touches no microVM, so it is cheap to ask for twice. */
  validate: (projectId: string, versionId: string) =>
    call<ValidationReport>('version.validate', { projectId, versionId }),

  /** Freeze the draft at a version. Immutable from that moment. */
  publish: (projectId: string, versionId: string, body: PublishVersionBody) =>
    call<PublishVersionResult>('version.publish', { projectId, versionId }, body),

  tasks: (projectId: string, versionId: string, phaseKey: PhaseKey) =>
    call<DraftPhaseView>('tasks.list', { projectId, versionId, phaseKey }),

  /** The artefact path is minted by the API and is never in the body. */
  addTask: (projectId: string, versionId: string, phaseKey: PhaseKey, body: AddTaskBody) =>
    call<TaskMutationResult>('tasks.add', { projectId, versionId, phaseKey }, body),

  updateTask: (
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    body: UpdateTaskBody,
  ) => call<TaskMutationResult>('tasks.update', { projectId, versionId, phaseKey, taskKey }, body),

  setTaskRequired: (
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    required: boolean,
  ) =>
    call<TaskMutationResult>(
      'tasks.setRequired',
      { projectId, versionId, phaseKey, taskKey },
      { required },
    ),

  /**
   * The whole ordering at once. An ordering is one fact, and a pairwise swap
   * leaves an intermediate state in which two tasks claim position 3.
   */
  reorderTasks: (projectId: string, versionId: string, phaseKey: PhaseKey, taskKeys: string[]) =>
    call<TaskMutationResult>('tasks.reorder', { projectId, versionId, phaseKey }, { taskKeys }),

  removeTask: (projectId: string, versionId: string, phaseKey: PhaseKey, taskKey: string) =>
    call<TaskMutationResult>('tasks.remove', { projectId, versionId, phaseKey, taskKey }),

  /**
   * A quiz's correct option ids and its explanations: the one payload in this
   * whole client that carries a key.
   *
   * It is **not** a field of the draft the editor already holds, and that is
   * the point: `readDraft` is guarded by `requireVisibleProject`, which admits
   * every instructor to every platform-owned project, so `DraftTaskView.quiz`
   * is the view without the key. This door is guarded by `requireOwnedProject`
   * and leaves an audit row on every read.
   *
   * So the editor calls it behind an explicit action and never on a render:
   * the route is rate limited to twenty a minute, and a component that
   * re-fetched on every paint would spend that budget and flood the class's
   * audit table with rows saying a key was read.
   */
  readQuizKey: (projectId: string, versionId: string, phaseKey: PhaseKey, taskKey: string) =>
    call<AuthoredQuiz>('tasks.quizKey', { projectId, versionId, phaseKey, taskKey }),

  /**
   * Every file row: path, role and size, with bytes only for the two
   * learner-facing roles. The tree that draws these decides what to show from
   * the row's role rather than from whether `content` arrived.
   */
  files: (projectId: string, versionId: string) =>
    call<AuthoringFileView[]>('files.list', { projectId, versionId }),

  /* -------------------- the copy becomes the teacher's own ----------------- */

  /**
   * A phase's intro. The title stays as the project has it; the intro is the
   * teacher's on every phase, the last four included.
   */
  updatePhase: (projectId: string, versionId: string, phaseKey: PhaseKey, body: UpdatePhaseBody) =>
    call<PhaseMutationResult>('phases.update', { projectId, versionId, phaseKey }, body),

  /**
   * The Phases card's three doors, each answering the draft view: remove a
   * phase from the draft, put a removed one back from the version the draft
   * was opened from, or add an empty Requirements or Design.
   */
  removePhase: (projectId: string, versionId: string, phaseKey: PhaseKey) =>
    call<DraftVersionView>('phases.remove', { projectId, versionId, phaseKey }),
  restorePhase: (projectId: string, versionId: string, phaseKey: PhaseKey) =>
    call<DraftVersionView>('phases.restore', { projectId, versionId, phaseKey }),
  addPhase: (projectId: string, versionId: string, phaseKey: PhaseKey) =>
    call<DraftVersionView>('phases.add', { projectId, versionId, phaseKey }),

  /**
   * The stakeholder interview, written whole: persona, opening, replies,
   * limits and facts. Its path names Requirements, the one phase an interview
   * can sit on, so it takes no phase key.
   */
  putInterview: (projectId: string, versionId: string, body: InterviewBody) =>
    call<PhaseMutationResult>('interview.replace', { projectId, versionId }, body),

  /** Remove the stakeholder interview: the Requirements room then holds none. */
  removeInterview: (projectId: string, versionId: string) =>
    call<PhaseMutationResult>('interview.remove', { projectId, versionId }),

  /**
   * The interview **with** its facts' answers, for the project's owner alone.
   *
   * `readQuizKey`'s rule, for its reason: the draft every instructor can read
   * carries the interview without its answers (`DraftInterviewView`), and this
   * door leaves an audit row on every read. So the editor calls it behind an
   * explicit action (opening the interview editor) and never on a render.
   */
  readInterview: (projectId: string, versionId: string) =>
    call<InterviewBody>('interview.read', { projectId, versionId }),

  /**
   * Replace one file's bytes in a written phase of a draft. Its path and its
   * role never change, and a document several written phases mount (the
   * provided backlog) is replaced in every one of them (`alsoReplacedIn`).
   */
  replaceFile: (projectId: string, versionId: string, phaseKey: PhaseKey, body: ReplaceFileBody) =>
    call<ReplaceFileResult>('files.replace', { projectId, versionId, phaseKey }, body),

  /* ------------------------- the class assignment ------------------------ */

  /** The published versions this class could be put on. */
  assignable: (cohortId: string) =>
    call<AssignableVersionView[]>('assignment.assignable', { cohortId }),

  /** The assignment in force, and everything the class has held before it. */
  assignment: (cohortId: string) => call<CohortProjectView>('assignment.read', { cohortId }),

  /**
   * Put a class on a published version, with a reason the audit trail keeps.
   * New enrolments take it; learners already enrolled stay pinned.
   */
  assign: (cohortId: string, body: AssignProjectBody) =>
    call<CohortProjectView>('assignment.assign', { cohortId }, body),

  /* --------------------- upload, profile, seal, deep ------------------------- */

  /**
   * Upload an archive as a new draft the caller owns. The body is the
   * contract's `ProjectUploadRequest`; a refusal is a 4xx whose body is a
   * `ProjectUploadRefusal`, read by the page from `ApiError.body`.
   */
  upload: (body: ProjectUploadRequest) =>
    request<ProjectUploadResult>(
      AUTHORING_ROUTES['projects.upload'].method,
      authoringPath('projects.upload'),
      body,
      { timeoutMs: UPLOAD_TIMEOUT_MS },
    ),

  /** The one runtime profile this deployment bakes, with its manifest digest. */
  runtimeProfile: () => call<RuntimeProfileView>('runtime.profile', {}),

  /**
   * One starter archive, as bytes, for staff only. The
   * export's own fetch (`archiveBlob`): its deadline, its 401 handling and the
   * API's refusal in its words; a 200 that is not a zip saves nothing. A
   * refusal with no words of its own names the download, never an export.
   */
  starterArchive: (name: StarterArchiveName): Promise<ExportedArchive> =>
    archiveBlob('GET', starterPath(name), starterWords(name)),

  /**
   * Write one sealed file of a task: a hidden test, the reference solution or
   * a mutant. Write-only: the answer is its path, digest and size.
   */
  writeSealed: (
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    body: SealedFileWriteBody,
  ) => call<SealedFileView>('sealed.write', { projectId, versionId, phaseKey, taskKey }, body),

  /**
   * One sealed file **with** its bytes, for the project's owner alone, and an
   * audit row on every read. `readQuizKey`'s rule: behind an explicit action,
   * never on a render.
   */
  readSealed: (
    projectId: string,
    versionId: string,
    phaseKey: PhaseKey,
    taskKey: string,
    query: SealedFileReadQuery,
  ) =>
    request<SealedFileOwnerRead>(
      AUTHORING_ROUTES['sealed.read'].method,
      `${authoringPath('sealed.read', { projectId, versionId, phaseKey, taskKey })}?${sealedReadQuery(query)}`,
    ),

  /** A draft's deep validation: its state, its four checks and the microVMs a run boots. */
  deepValidation: (projectId: string, versionId: string) =>
    call<DeepValidationView>('deepValidation.read', { projectId, versionId }),

  /**
   * Start deep validation, sending the microVM count the teacher was shown. The
   * API refuses, and boots nothing, if the draft's count is not that number.
   */
  startDeepValidation: (projectId: string, versionId: string, body: DeepValidationStartBody) =>
    call<DeepValidationView>('deepValidation.start', { projectId, versionId }, body),

  /* ---------------------------------- export --------------------------------- */

  /**
   * A version as an archive in the on-disk layout, for the owner alone. It
   * answers bytes, not JSON, so it is fetched as a blob with the same bearer
   * token and the same refusals `request` reads, and with the count of sealed
   * files the API left out (`x-export-withheld`: inherited from a project the
   * teacher copied).
   */
  exportVersion: (projectId: string, versionId: string): Promise<ExportedArchive> =>
    archiveBlob(AUTHORING_ROUTES['version.export'].method, authoringPath('version.export', { projectId, versionId })),

  /* ------------------- the learner preview of a version ----------------------- */

  /**
   * The version as a learner of it would first read it, for its owner alone.
   * A read: nothing is saved, graded or seen by learners. Its path is written
   * here rather than in `AUTHORING_ROUTES` (the table has no key for it), on the
   * instructor controller as every authoring door is.
   */
  learnerPreview: (projectId: string, versionId: string) =>
    request<LearnerPreviewView>(
      'GET',
      `/instructor/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}/learner-preview`,
    ),
};

/* ------------------------------------ export ---------------------------------- */

/** What an export answers: the archive, and how many sealed files the API kept out of it. */
export interface ExportedArchive {
  blob: Blob;
  /**
   * `x-export-withheld`: sealed files inherited from a copied project, left out
   * (0 when none). Null when the header was missing or not a whole count: an
   * unread count is never read as 0, so the page
   * never claims the archive is complete on a header it could not read.
   */
  withheld: number | null;
}

/** A count the API sent: digits only (no sign, no point, no exponent), or null. */
function withheldCount(header: string | null): number | null {
  if (header === null || !/^\d{1,9}$/.test(header)) return null;
  const count = Number(header);
  return Number.isSafeInteger(count) ? count : null;
}

/** The refusal for a 200 that is not an archive: nothing is saved. */
const NOT_AN_ARCHIVE = 'The export came back as something other than an archive, so nothing was saved. Try again in a moment.';

/**
 * The refusal for a body read that failed after the 200: the server answered,
 * so the page never says it did not; and whatever failed (a deadline, an
 * abort, a network error, anything else) is this sentence, never a raw
 * message. Nothing is saved.
 */
const DOWNLOAD_STOPPED = 'The archive stopped downloading before it finished, so nothing was saved. Try again on a steadier connection.';

/**
 * What a fetch of an archive says when the API answers with no words of its
 * own: a refusal by status, and a 200 that is not an archive. The export's are
 * the default; a starter download names itself.
 */
interface ArchiveWords {
  failed: (status: number) => string;
  notAnArchive: string;
}

const EXPORT_WORDS: ArchiveWords = {
  failed: (status) => `The export could not be made (${status}).`,
  notAnArchive: NOT_AN_ARCHIVE,
};

/** What each starter archive is called when its download fails. */
const STARTER_SUBJECT: Record<StarterArchiveName, string> = {
  starter: 'The starter archive',
  shelf: 'The shelf example',
};

function starterWords(name: StarterArchiveName): ArchiveWords {
  return {
    failed: (status) => `${STARTER_SUBJECT[name]} could not be downloaded (${status}).`,
    notAnArchive: 'The download came back as something other than an archive, so nothing was saved. Try again in a moment.',
  };
}

/**
 * One archive fetch: the table's method and path, the bearer token, and
 * `request`'s rules. The same deadline
 * (`REQUEST_TIMEOUT_MS`), so a stalled export is given up on rather than
 * spinning; a 401 is handed to lib/api's own handling by asking it to verify
 * the session (`GET /auth/me` through `request`, which on a 401 writes out
 * what is pending, clears the session and goes to sign-in, exactly as every
 * other call does); the API's refusal (a 409's sentence) verbatim; and a 200
 * that is not `application/zip` is a refusal, never a saved .zip.
 */
async function archiveBlob(method: string, path: string, words: ArchiveWords = EXPORT_WORDS): Promise<ExportedArchive> {
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: authHeader(token),
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (isTimeout(err)) {
      throw new ApiError(0, 'The server did not answer. Try again in a moment.');
    }
    throw err;
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: unknown };
    if (res.status === 401 && token && token === getToken()) {
      // lib/api's 401 branch, reached the way it is designed to be: a session
      // check that answers 401 ends the session and navigates to sign-in.
      await request('GET', '/auth/me').catch(() => undefined);
    }
    const message = Array.isArray(data.message)
      ? data.message.join('; ')
      : typeof data.message === 'string' && data.message
        ? data.message
        : words.failed(res.status);
    throw new ApiError(res.status, message, undefined, data);
  }
  // Only a 200 that is application/zip is an
  // archive; any other success is a refusal and nothing is saved.
  const type = res.headers?.get?.('content-type') ?? '';
  if (res.status !== 200 || !/^application\/zip\b/i.test(type)) throw new ApiError(res.status, words.notAnArchive);
  const withheld = withheldCount(res.headers.get(EXPORT_WITHHELD_HEADER));
  let blob: Blob;
  try {
    // The body is read under the same deadline: a stall mid-download is a
    // refusal by sentence, never a raw DOMException.
    blob = await res.blob();
  } catch {
    throw new ApiError(0, DOWNLOAD_STOPPED);
  }
  // An empty body is no archive: nothing is saved.
  if (!blob || blob.size === 0) throw new ApiError(res.status, words.notAnArchive);
  return { blob, withheld };
}

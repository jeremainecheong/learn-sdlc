'use client';

import type {
  AssignableVersionView,
  AssignProjectBody,
  AuditEventView,
  AuthoringRouteKey,
  ClassMapView,
  CohortProjectView,
  LearnerDossier,
  CohortPhaseSchedule,
  CohortScheduleView,
  InstructorLearnerDetail,
  InstructorOverview,
  InstructorPhaseView,
  PhaseKey,
  PhaseOverrideAction,
  RegradeBatchView,
  RegradeScope,
  ViewAsSession,
} from '@learnsdlc/shared';
import { AUTHORING_ROUTES } from '@learnsdlc/shared';
import { API_BASE, ApiError, getToken, request } from './api';
import { apiErrorMessage, authHeader, seg } from './api-fetch';
import { authoringPath } from './api-projects';
import { learningGainCsvPath, learningGainPath } from './api-concept';

const projectQuery = (project?: string) => (project ? `?project=${seg(project)}` : '');
/** `?project=&cohort=` for the two class exports; either part only when named. */
const exportQuery = (project?: string, cohort?: string) => {
  const parts = [project ? `project=${seg(project)}` : '', cohort ? `cohort=${seg(cohort)}` : ''].filter(Boolean);
  return parts.length ? `?${parts.join('&')}` : '';
};

/**
 * One call against the authoring route table (teacher projects).
 *
 * The method and the path are read from `AUTHORING_ROUTES` rather than written
 * out again here, so the page and the controller are reading one declaration:
 * a client that asks the right question at the wrong path is a 404 nobody sees
 * until a teacher meets it.
 *
 * The substitution itself is `authoringPath` from `api-projects.ts` rather than
 * a second copy of the same three lines here. Two path-builders over
 * one closed route table is how one of them silently rots, and that one is the
 * one `teacher-projects-client.test.tsx` walks against every key of
 * `AUTHORING_ROUTE_KEYS`, so
 * a route renamed in the contract fails a test rather than a class assignment.
 */
function authoringRequest<T>(
  key: AuthoringRouteKey,
  params: Record<string, string>,
  body?: unknown,
): Promise<T> {
  return request<T>(AUTHORING_ROUTES[key].method, authoringPath(key, params), body);
}

// The two export files' names live beside `saveBlob` (lib/download.ts), so a
// page can name its download without importing this module's routes; they are
// re-exported here for every caller that already reads them from here.
export { exportFilename, gradebookFilename } from './download';

/** What starting a regrade needs. The reason is recorded on every row it writes. */
export interface RegradeRequest {
  projectSlug: string;
  phaseKey: PhaseKey;
  scope: RegradeScope;
  reason: string;
  /** The single-learner entry point on the learner page; absent for a class. */
  userId?: string;
}

/**
 * The most learners the class read (`GET /instructor/learners`) answers in one
 * page (`CLASS_LEARNERS_PAGE` in instructor.service.ts, `@Max(50)` on the query).
 */
export const CLASS_LEARNERS_PAGE = 50;

/**
 * The most pages one `learnersIn` walks (2,000 learners). It keeps a server that
 * failed to move past `after` from being asked the same page until the route's
 * 60 a minute refuses the teacher, and stays under that limit on its own.
 */
export const CLASS_LEARNERS_MAX_PAGES = 40;

/** One page of the class read: the caller's scope, or one class of it, after an id. */
function classLearnersPage(query: { cohort?: string; after?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (query.cohort) params.set('cohort', query.cohort);
  if (query.after) params.set('after', query.after);
  params.set('limit', String(query.limit ?? CLASS_LEARNERS_PAGE));
  return request<InstructorLearnerDetail[]>('GET', `/instructor/learners?${params}`);
}

export const instructorApi = {
  overview: (project?: string) =>
    request<InstructorOverview>('GET', `/instructor/overview${projectQuery(project)}`),
  learner: (userId: string) =>
    request<InstructorLearnerDetail>('GET', `/instructor/learners/${seg(userId)}`),
  /** One page of `GET /instructor/learners`. */
  classLearners: classLearnersPage,
  /**
   * The details of these learners, read a class page at a time rather than
   * one `learner(id)` each. The per-learner route allows 60 a minute per
   * account, so spending one per learner on every view of the teacher home
   * would get a class of 30 refused on the third view in a minute.
   *
   * `cohort` narrows the read to one class (the class's own page); without it
   * the read is the caller's whole scope (the home). Pages are walked by the
   * last id until a short page or until every id asked for is read. The result
   * holds only the learners asked for, in the order asked; one the scope does
   * not hold is absent.
   *
   * The walk also stops when a full page does not move the cursor on (a server
   * ignoring `after`), after `CLASS_LEARNERS_MAX_PAGES` pages, and between
   * pages once `stillWanted` says the caller has moved on (the portal's load
   * version), so a superseded load spends no further request.
   */
  learnersIn: async (
    ids: readonly string[],
    cohort?: string,
    stillWanted: () => boolean = () => true,
  ): Promise<InstructorLearnerDetail[]> => {
    if (!ids.length) return [];
    const wanted = new Set(ids);
    const found = new Map<string, InstructorLearnerDetail>();
    const cursors = new Set<string>();
    let after: string | undefined;
    for (let pages = 1; ; pages += 1) {
      const page = await classLearnersPage({ cohort, after, limit: CLASS_LEARNERS_PAGE });
      for (const one of page) if (wanted.has(one.userId)) found.set(one.userId, one);
      if (page.length < CLASS_LEARNERS_PAGE || found.size === wanted.size) break;
      if (pages >= CLASS_LEARNERS_MAX_PAGES || !stillWanted()) break;
      const next = page[page.length - 1].userId;
      if (next === after || cursors.has(next)) break;
      cursors.add(next);
      after = next;
    }
    return ids.flatMap((id) => {
      const one = found.get(id);
      return one ? [one] : [];
    });
  },
  /**
   * One of the seven levers, with the reason the audit trail keeps.
   *
   * `taskKey` is which task of the phase the lever is about, and only the three
   * per-task ones (`task-signoff`, `task-reset`, `task-reopen`) name it. The
   * four phase levers name none and their body is unchanged: no field is added
   * to it, not even an undefined one.
   *
   * It is a parameter rather than a constant here because the service resolves
   * a missing key to the empty one and answers the loader's own 404, *unknown
   * task: *, so a client that could not say `story` would have the three
   * levers existing in the DTO, in the service and in the audit register, and
   * working nowhere.
   *
   * Its caller is `components/staff/LearnerTasks.tsx`, mounted in the teacher
   * portal's evidence panel: the page `/instructor/learners/[userId]`
   * redirects to. That panel is silent on exactly one shape: a phase whose
   * compiled list is the **synthesised sole task**, where all three per-task
   * levers are refused by name and a control the server refuses is a dead
   * control. It is silent on that shape and no wider one: a phase holding a
   * single *authored* task is accepted by the route and draws all three, which
   * is every phase of every teacher-authored project nobody has split.
   */
  override: (
    userId: string,
    phaseStateId: string,
    action: PhaseOverrideAction,
    reason: string,
    taskKey?: string,
  ) =>
    // The phase as the lever left it, plus the one sentence a lever may have to
    // say about what it could not do on its own (`PhaseOverrideResult.note` in
    // instructor.service.ts): a sign-off that leaves the phase reading passed
    // while the strict-evidence gate still waits on a reviewed pass.
    request<InstructorPhaseView & { note?: string }>(
      'POST',
      `/instructor/learners/${seg(userId)}/phases/${seg(phaseStateId)}/override`,
      { action, reason, ...(taskKey === undefined ? {} : { taskKey }) },
    ),

  /** The phases of the cohort's project, with the artefacts counted across every learner. */
  classMap: (project: string) => request<ClassMapView>('GET', `/instructor/class-map?project=${seg(project)}`),
  /**
   * Overrides and admin changes, newest first. Without a learner it is the whole
   * cohort's trail; with one it is that learner's own, which is what the
   * teacher portal's evidence panel reads beside their submissions: every
   * lever on that page, the three per-task ones included, leaves a row on it.
   */
  audit: (learnerId?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (learnerId) params.set('learnerId', learnerId);
    if (limit != null) params.set('limit', String(limit));
    const query = params.toString();
    return request<AuditEventView[]>('GET', `/instructor/audit${query ? `?${query}` : ''}`);
  },

  /* ---------------------------- the levers ------------------------------- */

  /**
   * What a regrade would do. Writes nothing at all, not even an audit row, so
   * it is cheap to ask twice and can never be mistaken for the act.
   */
  regradePreview: (req: RegradeRequest) =>
    request<RegradeBatchView>('POST', '/instructor/regrades/preview', req),
  /** Start one. 409 while another batch is running for this class. */
  regradeStart: (req: RegradeRequest) => request<RegradeBatchView>('POST', '/instructor/regrades', req),
  /**
   * One batch, for the panel's poll. A batch keeps running when the tab is
   * closed, so this is also how a panel picks up a batch it did not start.
   */
  regradeStatus: (id: string) => request<RegradeBatchView>('GET', `/instructor/regrades/${seg(id)}`),

  /**
   * Begin viewing a learner's work: one audit row, and the name for the
   * banner. There is no token here: see lib/view-as.ts.
   */
  viewAs: (userId: string) =>
    request<ViewAsSession>('POST', `/instructor/learners/${seg(userId)}/view`),

  /**
   * One learner's whole project as a document, for the console's
   * dossier page. Heavier than their detail because it carries the files, so
   * it is asked for once when that page opens and never polled, and every
   * call of it leaves a `dossier.read` row on the trail.
   */
  learnerDossier: (userId: string, project?: string) =>
    request<LearnerDossier>(
      'GET',
      `/instructor/learners/${seg(userId)}/dossier${projectQuery(project)}`,
    ),

  /** This class's dates for one project, every phase it holds, dated or not. */
  schedule: (cohortId: string, project?: string) =>
    request<CohortScheduleView>(
      'GET',
      `/instructor/cohorts/${seg(cohortId)}/schedule${projectQuery(project)}`,
    ),
  /**
   * Replace them. A save is the whole table for that project: a blank cell is
   * a null, and a phase with two nulls loses its row.
   */
  saveSchedule: (cohortId: string, projectSlug: string, phases: CohortPhaseSchedule[]) =>
    request<CohortScheduleView>('PUT', `/instructor/cohorts/${seg(cohortId)}/schedule`, {
      projectSlug,
      phases,
    }),

  /* --------------------- teacher projects · the class --------------------- */

  /**
   * The published versions this class could be put on, the one it is on now
   * marked `current`. A draft is never in here: a class cannot work on
   * something that is still being written.
   */
  assignableProjects: (cohortId: string) =>
    authoringRequest<AssignableVersionView[]>('assignment.assignable', { cohortId }),

  /**
   * The assignment in force and every one before it, newest first. A class
   * that has never been given a project answers with `active: null`, which is
   * not an error: its learners are on the deployment's default project.
   */
  classProject: (cohortId: string) =>
    authoringRequest<CohortProjectView>('assignment.read', { cohortId }),

  /**
   * Put the class on a published version, with a reason the audit trail keeps.
   * This changes what a learner who joins from now on is given; a learner
   * already enrolled stays pinned to the version they started on, and moving
   * one is a separate, explicitly audited act that is not this route.
   */
  assignClassProject: (cohortId: string, body: AssignProjectBody) =>
    authoringRequest<CohortProjectView>('assignment.assign', { cohortId }, body),

  /**
   * Not through request(): that helper parses JSON, and this is a CSV body.
   * The bearer token still has to travel in a header, which is why the file
   * cannot simply be an <a href> to the API.
   */
  exportCsv: (project?: string, cohort?: string): Promise<Blob> =>
    csvBlob(`/instructor/export.csv${exportQuery(project, cohort)}`),

  /**
   * The grade book (one row per learner, one column per phase) is the shape a
   * spreadsheet and an LMS want. The long export above stays the one to read
   * for how a verdict was reached. With `cohort`, one class of the caller's
   * (the route's optional `?cohort=`); without, every class of theirs.
   */
  exportGradebook: (project?: string, cohort?: string): Promise<Blob> =>
    csvBlob(`/instructor/gradebook.csv${exportQuery(project, cohort)}`),

  /**
   * One of the four read-only quiz-results files
   * (`QUIZ_RESULTS_EXPORT_KINDS`) for the caller's classes. The same bearer
   * token and the same refusals as the two exports above.
   */
  exportQuizResults: (kind: import('@learnsdlc/shared').QuizResultsExportKind, project?: string): Promise<Blob> =>
    csvBlob(`/instructor/quiz-results/${seg(kind)}.csv${projectQuery(project)}`),

  /**
   * One class's quiz results as numbers, for the charts
   * on /teacher/class/quiz-results. The class is always sent (the route
   * requires it); the project only when one is named. Read-only, counted by
   * the same code as the four files above, so a chart and a file agree.
   */
  quizResultsSummary: (cohortId: string, project?: string) =>
    request<import('@learnsdlc/shared').QuizResultsSummary>(
      'GET',
      `/instructor/quiz-results/summary?cohort=${seg(cohortId)}${project ? `&project=${seg(project)}` : ''}`,
    ),

  /**
   * One of the four quiz-results files for one class alone, through the same
   * route's `?cohort=`. `exportQuizResults` above downloads every class.
   */
  exportClassQuizResults: (kind: import('@learnsdlc/shared').QuizResultsExportKind, cohortId: string): Promise<Blob> =>
    csvBlob(`/instructor/quiz-results/${seg(kind)}.csv?cohort=${seg(cohortId)}`),

  /**
   * Before vs after the quick concept checks, per phase,
   * for the caller's classes (one class when named). Read-only.
   */
  learningGain: (cohortId?: string) =>
    request<import('./api-concept').LearningGain>('GET', learningGainPath(cohortId)),

  /** The same numbers as a CSV file, with the same bearer token. */
  exportLearningGain: (cohortId?: string): Promise<Blob> => csvBlob(learningGainCsvPath(cohortId)),
};

/** One CSV fetch for both exports: the same bearer token, the same refusals. */
async function csvBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: authHeader(token),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, apiErrorMessage(data, `export failed (${res.status})`));
  }
  return res.blob();
}

// The object-URL handling lives once, in `lib/download.ts`, with one revoke
// rule; this re-export lets callers keep importing `saveBlob` from
// api-instructor.
export { saveBlob } from './download';

/**
 * Which project the console is looking at. Its own key, not the learner's
 * lib/project.ts one: 'all' is a real choice here and would be a broken slug
 * on the dashboard.
 *
 * Empty until the console has been pointed at one, and there is no literal to
 * fall back to. Every instructor read above takes the project as optional and
 * answers over the caller's own learners without it (the overview returns a
 * row per enrolment, the dossier takes the learner's oldest) so a slug this
 * function invents is a guess at an answer the server already has, and the
 * wrong guess for a teacher whose classes are on another project.
 */
const CONSOLE_PROJECT_KEY = 'lsdlc_instructor_project';
export const ALL_PROJECTS = 'all';

export function getConsoleProject(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem(CONSOLE_PROJECT_KEY) || '';
  } catch {
    return '';
  }
}

export function setConsoleProject(slug: string): void {
  try {
    localStorage.setItem(CONSOLE_PROJECT_KEY, slug);
  } catch {
    // Losing the preference is survivable; failing the click is not.
  }
}

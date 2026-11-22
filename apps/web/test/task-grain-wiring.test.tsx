// @vitest-environment jsdom
/**
 * That the per-task features are reachable from the routes, and not only from
 * their own tests.
 *
 * Each piece has a component suite: the next-draft door renders and calls the
 * client (`teacher-projects-editor.test.tsx`), the per-task panel draws and
 * its levers answer (`teacher-portal-tasks.test.tsx`,
 * `teacher-task-levers.test.tsx`), the phase tiles say how far a split phase
 * has got (`phase-progress-tasks.test.tsx`). All of them render a *component*.
 * A component is not a screen until a route draws it: a component can be
 * written, tested and shipped behind redirects no learner passes, and a list
 * can carry sentences that no page mounts.
 *
 * So each case below starts at the page a `app/(app)/…/page.tsx` exports (the
 * thing Next actually serves) and ends at the per-task markup. Cut any link
 * between the two and the case goes red:
 *
 *   /teacher/projects/:id/versions/:id  -> ProjectEditor -> NextDraft -> projectsApi.createDraft
 *   /teacher, /teacher/class            -> TeacherPortal -> LearnerTasks, AuditList
 *   /progress, /dashboard               -> PhasePath     -> phaseTaskLines
 *   /artefacts                          -> phaseTaskLines
 *
 * What this file does NOT prove: that the API answers where the client knocks.
 * That is `apps/api/test/teacher-projects.e2e-spec.ts`, whose route-table case
 * drives every key of `AUTHORING_ROUTES` (twenty-five) against the mounted app; the
 * one assertion made here about the API is that the key the door uses is a key
 * of that table, so the two suites are talking about the same route.
 */
import { act, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORING_ROUTES,
  AUTHORING_ROUTE_KEYS,
  SUPPORTED_STACKS_SENTENCE,
  DEFAULT_PASS_THRESHOLD,
} from '@learnsdlc/shared';
import type {
  AuditEventView,
  AuthoredProjectSummary,
  DraftPhaseView,
  DraftTaskView,
  DraftVersionView,
  InstructorLearnerDetail,
  InstructorPhaseView,
  InstructorTaskView,
  PhaseSummary,
  PhaseTaskCounts,
} from '@learnsdlc/shared';

/* ------------------------------- the stand-ins ---------------------------- */

const rig = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  search: '',
  user: { id: 'teacher', role: 'INSTRUCTOR' } as Record<string, unknown>,
  phases: [] as PhaseSummary[],
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  projects: { get: vi.fn(), draft: vi.fn(), files: vi.fn(), createDraft: vi.fn() },
  instructor: { overview: vi.fn(), learner: vi.fn(), audit: vi.fn(), override: vi.fn() },
  cohorts: { mine: vi.fn() },
  experience: { teacherFeedback: vi.fn(), teacherSubmissions: vi.fn() },
}));

vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useRouter: () => rig.router,
    useParams: () => rig.params,
    usePathname: () => window.location.pathname,
    useSearchParams: () =>
      new URLSearchParams(
        useSyncExternalStore(subscribe, () => window.location.search, () => rig.search),
      ),
    redirect: vi.fn(),
  };
});
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => rig.user,
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    enrollment: { id: 'enrolment-one', phases: rig.phases },
    currentPhase: rig.phases[0],
    loading: false,
  }),
}));
// Partial, deliberately: `PhasePath`, `phaseTaskLines` and the artefacts
// page's panel are the things under test and must be the real ones. Only the
// reviews read, which would reach the network, is stood in for.
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({
    reviews: [],
    hasLoaded: true,
    loading: false,
    refreshing: false,
    refreshError: '',
    error: '',
    refresh: vi.fn(),
  }),
}));
vi.mock('@/lib/api-projects', () => ({ projectsApi: rig.projects }));
// The portal's class read, answered through the per-learner stand-in so every
// case reads the same learner details either way.
vi.mock('@/lib/api-instructor', () => ({
  instructorApi: {
    ...rig.instructor,
    learnersIn: (ids: readonly string[]) => Promise.all(ids.map((id) => rig.instructor.learner(id))),
  },
}));
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: rig.cohorts,
  formatJoinCode: (value: string) => value,
}));
vi.mock('@/lib/api-experience', () => ({ experienceApi: rig.experience }));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: { notes: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: ({ submissionId }: { submissionId: string }) => (
    <section data-testid="selected-evidence">{submissionId}</section>
  ),
}));

// The pages, imported after the mocks so each one is served the stand-ins.
import TeacherPage from '@/app/(app)/teacher/page';
import TeacherClassPage from '@/app/(app)/teacher/class/page';
import TeacherProjectVersionPage from '@/app/(app)/teacher/projects/[projectId]/versions/[versionId]/page';
import ProgressPage from '@/app/(app)/progress/page';
import DashboardPage from '@/app/(app)/dashboard/page';
import LearnerDetailPage from '@/app/(app)/instructor/learners/[userId]/page';
import { redirect } from 'next/navigation';
import PortfolioPage from '@/app/(app)/artefacts/page';
import { phaseSetFor } from './support/phase-set';

/* -------------------------------- fixtures -------------------------------- */

const SPLIT: PhaseTaskCounts = { total: 3, required: 2, passed: 1, passedRequired: 1 };

const summary = (over: Partial<AuthoredProjectSummary> = {}): AuthoredProjectSummary => ({
  id: 'p-mine',
  slug: 'my-course',
  title: 'My course',
  platformOwned: false,
  mine: true,
  isDefault: false,
  origin: 'fork',
  publishedVersion: '1.0.0',
  publishedVersionId: 'v-head',
  draftVersion: null,
  draftVersionId: null,
  cohortsUsing: 1,
  lastValidatedAt: '2026-09-19T00:00:00.000Z',
  createdAt: '2026-09-18T00:00:00.000Z',
  ...over,
});

const soleTask: DraftTaskView = {
  taskKey: 'main',
  order: 1,
  required: true,
  title: 'The backlog',
  brief: 'Write the stories.',
  artefactType: 'user-story',
  artefactPath: null,
  checkKind: 'story',
  rubric: { passThreshold: DEFAULT_PASS_THRESHOLD, criteria: [] },
  objectives: [],
  owns: ['requirements/story.json'],
  authorable: true,
  notice: null,
};

const requirements: DraftPhaseView = {
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  intro: 'Say what the product must do.',
  artifactKind: 'story',
  checkKind: 'story',
  tasks: [soleTask],
  blocksPublish: false,
};

/**
 * What `projects.get` answers on the wire.
 *
 * It is the envelope `{ project, versions }` (`AuthoredProjectDetail` in
 * `apps/api/src/authoring/authoring.service.ts`, declared again in
 * `lib/api-projects.ts` until the contract carries it) and not the row on its
 * own. A stand-in that hands the page a body the route never sends proves the
 * wiring against a shape nobody ships: the door would read `platformOwned`,
 * `mine` and `publishedVersion` one level too high, find `undefined` in all
 * three, and take whichever branch a missing field satisfies.
 */
const detail = (over: Partial<AuthoredProjectSummary> = {}) => ({
  project: summary(over),
  versions: [{ id: 'v-head', version: '1.0.0', status: 'published' as const }],
});

const head = (): DraftVersionView => ({
  projectId: 'p-mine',
  versionId: 'v-head',
  version: '1.0.0',
  status: 'published',
  slug: 'my-course',
  title: 'My course',
  tagline: 'A course of my own',
  description: 'Copied from TaskTrackr.',
  platformOwned: false,
  editable: false,
  phases: [requirements],
  validation: null,
  supportedStacks: {
    python: ['flask'],
    node: ['react'],
    tools: ['esbuild'],
    sentence: SUPPORTED_STACKS_SENTENCE,
  },
  createdAt: '2026-09-18T00:00:00.000Z',
  phaseSet: phaseSetFor([requirements.key], false),
});

const revision = {
  id: 'review-one',
  taskKey: 'story',
  status: 'completed' as const,
  score: 82,
  passed: true,
  report: null,
  createdAt: '2026-09-12T00:00:00.000Z',
  attempt: 2,
};

const taskRow = (over: Partial<InstructorTaskView>): InstructorTaskView => ({
  key: 'story',
  order: 1,
  required: true,
  title: 'Write the user story',
  status: 'passed',
  bestScore: 82,
  attempts: 2,
  passedAt: '2026-09-12T00:00:00.000Z',
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: revision,
  ...over,
});

const SPLIT_TASKS: InstructorTaskView[] = [
  taskRow({}),
  taskRow({
    key: 'criteria',
    order: 2,
    title: 'Write the acceptance criteria',
    status: 'in_progress',
    bestScore: 40,
    attempts: 1,
    passedAt: null,
    lastSubmission: null,
  }),
];

const learnerDetail = (): InstructorLearnerDetail =>
  ({
    userId: 'learner-one',
    displayName: 'Ada Example',
    email: 'ada@example.test',
    cohort: 'class-one',
    cohortName: 'Example class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'enrolment-one',
        projectSlug: 'payroll',
        projectTitle: 'Payroll',
        currentPhaseOrder: 1,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: [
          {
            id: 'phase-one',
            key: 'requirements',
            title: 'Requirements',
            order: 1,
            status: 'in_progress',
            bestScore: 82,
            attempts: 3,
            reflection: null,
            passedAt: null,
            opensAt: null,
            dueAt: null,
            hints: 1,
            relianceIndex: 0.2,
            passThreshold: 70,
            unlockedAt: '2026-09-10T00:00:00.000Z',
            lastSubmission: revision,
            tasks: SPLIT_TASKS,
          } as InstructorPhaseView,
        ],
      },
    ],
  }) as InstructorLearnerDetail;

const TRAIL: AuditEventView[] = [
  {
    id: 'audit-one',
    event: 'task.signoff',
    actorUserId: 'teacher',
    actorName: 'Teacher A',
    subjectUserId: 'learner-one',
    subjectName: 'Ada Example',
    targetId: 'phase-one',
    action: 'task-signoff',
    reason: 'Countersigned after reading it with them.',
    detail: { phaseKey: 'requirements', taskKey: 'story', taskTitle: 'Write the user story' },
    createdAt: '2026-09-18T09:00:00.000Z',
  },
];

const phase = (over: Partial<PhaseSummary> = {}): PhaseSummary => ({
  id: 'phase-one',
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  ...over,
});

/* -------------------------------- harness --------------------------------- */

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const render = (element: ReactElement) => act(async () => root.render(element));

beforeEach(() => {
  vi.clearAllMocks();
  const replace = window.history.replaceState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    replace(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  rig.params = {};
  rig.user = { id: 'teacher', role: 'INSTRUCTOR' };
  rig.phases = [];
  rig.projects.get.mockResolvedValue(detail());
  rig.projects.draft.mockResolvedValue(head());
  rig.projects.files.mockResolvedValue([]);
  rig.cohorts.mine.mockResolvedValue([
    { id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 },
  ]);
  rig.instructor.overview.mockResolvedValue({
    learners: [{ userId: 'learner-one', cohort: 'class-one' }],
  });
  rig.instructor.learner.mockResolvedValue(learnerDetail());
  rig.instructor.audit.mockResolvedValue(TRAIL);
  rig.experience.teacherFeedback.mockResolvedValue([]);
  rig.experience.teacherSubmissions.mockResolvedValue([
    {
      id: 'review-one',
      status: 'completed',
      passed: true,
      createdAt: '2026-09-12T00:00:00.000Z',
      attempt: 2,
    },
  ]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------- 1. the next-draft door -------------------------- */

describe('the next draft is a door on the route a teacher opens', () => {
  const openVersionRoute = async () => {
    rig.params = { projectId: 'p-mine', versionId: 'v-head' };
    window.history.replaceState(null, '', '/teacher/projects/p-mine/versions/v-head');
    await render(<TeacherProjectVersionPage />);
  };

  it('draws the door from the route, not only from the editor', async () => {
    await openVersionRoute();

    // The whole chain in one assertion: the page mounted `ProjectEditor`, the
    // editor read the project summary because the version on screen is not a
    // draft, and `NextDraft` decided the head is openable.
    expect(q('project-editor')).not.toBeNull();
    expect(rig.projects.draft).toHaveBeenCalledWith('p-mine', 'v-head');
    expect(rig.projects.get).toHaveBeenCalledWith('p-mine');
    expect(q('project-new-draft')).not.toBeNull();
  });

  it('calls the route the client builds, and goes into the draft it is given', async () => {
    await openVersionRoute();
    rig.projects.createDraft.mockResolvedValue({ ...head(), versionId: 'v-next', version: '1.0.1' });

    await act(async () => (q('project-new-draft') as HTMLButtonElement).click());

    expect(rig.projects.createDraft).toHaveBeenCalledWith('p-mine', { fromVersionId: 'v-head' });
    expect(rig.router.push).toHaveBeenCalledWith('/teacher/projects/p-mine/versions/v-next');
  });

  it('knocks at a route the API mounts, by the table both halves read', () => {
    // `projectsApi.createDraft` builds its path from this key, and the API's
    // own e2e drives every key of this table against the running app, so a
    // key that left the table, or a door that stopped using it, is caught on
    // one side or the other rather than in the product.
    expect(AUTHORING_ROUTE_KEYS).toContain('versions.createDraft');
    expect(AUTHORING_ROUTES['versions.createDraft']).toMatchObject({
      method: 'POST',
      path: '/instructor/projects/:projectId/versions',
    });
  });
});

/* --------------------- 2. the teacher's per-task view ---------------------- */

describe("the per-task view is on the route a teacher opens a learner on", () => {
  const openLearner = async (Page: ComponentType) => {
    window.history.replaceState(
      null,
      '',
      '/teacher?class=class-one&evidence=learner-one&phase=phase-one&submission=review-one',
    );
    await render(<Page />);
  };

  it('draws the tasks and the record of changes from /teacher', async () => {
    await openLearner(TeacherPage);

    // Page -> TeacherPortal -> LearnerTasks, and the same page -> AuditList.
    // Delete either mount and this is the case that says so.
    expect(q('learner-tasks')).not.toBeNull();
    expect(q('learner-task-story')).not.toBeNull();
    expect(q('learner-task-criteria')).not.toBeNull();
    expect(q('audit-list')).not.toBeNull();
    expect(host.textContent).toContain('Signed off Write the user story in Requirements');
  });

  it('draws them from /teacher/class as well, which is the same portal', async () => {
    await openLearner(TeacherClassPage);

    expect(q('learner-tasks')).not.toBeNull();
    expect(q('audit-list')).not.toBeNull();
  });

  it('names a learner who has run out of quiz papers, on the class page too', async () => {
    // A required quiz with every paper handed in and no pass shuts the phase
    // and the project, and this panel's Reset is the only way
    // back. A teacher who cannot see the state cannot pull the lever, so the
    // flag has to arrive on the page and not only in the component's own suite.
    const detail = learnerDetail();
    detail.enrollments[0].phases[0].tasks = [
      ...SPLIT_TASKS,
      taskRow({
        key: 'concepts',
        order: 3,
        title: 'Concept check',
        status: 'in_progress',
        bestScore: 40,
        attempts: 3,
        passedAt: null,
        lastSubmission: null,
        quizAttemptsSpent: true,
      }),
    ];
    rig.instructor.learner.mockResolvedValue(detail);

    await openLearner(TeacherClassPage);

    expect(q('task-quiz-spent-concepts')).not.toBeNull();
    expect(host.textContent).toContain(
      'Ada Example has handed in every paper on Concept check and has not passed it.',
    );
    // And the lever that answers it is on the same row.
    expect(q('task-reset-concepts')).not.toBeNull();
  });

  it('offers the three levers there, each one a control the route can reach', async () => {
    await openLearner(TeacherPage);

    // A lever with no caller is the failure this guards against:
    // `instructorApi.override` must be called from a mounted page.
    expect(q('task-signoff-criteria')).not.toBeNull();
    expect(q('task-reopen-story')).not.toBeNull();
    expect(q('task-reset-story')).not.toBeNull();
  });

  it('sends the old learner link to that same route', async () => {
    // `/instructor/learners/[userId]` is the address the console still hands
    // out; if it stopped landing on `/teacher?learner=…` the panel above would
    // be correct and unreachable.
    await LearnerDetailPage({ params: Promise.resolve({ userId: 'learner one' }) });
    expect(redirect).toHaveBeenCalledWith('/teacher?learner=learner%20one');
  });
});

/* ----------------------- 3. the learner's phase tile ----------------------- */

describe('the split-phase tile is drawn by the component the learner routes mount', () => {
  beforeEach(() => {
    rig.user = {
      id: 'learner-one',
      role: 'LEARNER',
      displayName: 'Ada Example',
      email: 'ada@example.test',
      avatar: 0,
      cohort: 'default',
      profileVersion: 0,
    };
    rig.phases = [phase({ attempts: 4, taskCounts: SPLIT })];
  });

  it.each([
    ['/progress', ProgressPage],
    ['/dashboard', DashboardPage],
  ])('draws PhasePath’s own task lines on %s', async (_route, Page) => {
    await render(<Page />);

    // The test ids belong to `PhasePath` in components/experience/shared.tsx.
    // A page that stopped mounting it could still print the same words from a
    // second author; it could not print these.
    expect(q('phase-path-tasks-requirements')?.textContent).toBe('1 of 2 required done. Optional: 0 of 1 done');
    expect(q('phase-path-attempts-requirements')?.textContent).toBe('4 submissions across 3 tasks');
  });

  it('draws the counts on the portfolio panel /artefacts mounts', async () => {
    await render(<PortfolioPage />);

    expect(q('portfolio-tasks-requirements')?.textContent).toBe('1 of 2 required done. Optional: 0 of 1 done');
  });

  it('says nothing on a single-task phase, on either surface', async () => {
    rig.phases = [phase({ attempts: 4, taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 } })];

    await render(<ProgressPage />);
    expect(q('phase-path-tasks-requirements')).toBeNull();
    expect(q('phase-path-attempts-requirements')).toBeNull();
  });
});

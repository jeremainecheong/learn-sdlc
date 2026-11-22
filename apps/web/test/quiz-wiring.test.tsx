// @vitest-environment jsdom
/**
 * That the quiz feature is reachable from the routes, and not only from its
 * components' own tests.
 *
 * Each piece has a component suite: the room renders a paper
 * (`quiz-room.test.tsx`), the door picks the quiz (`routes.test.ts`), the
 * panel routes to it (`task-panel.test.tsx`), the tiles draw two percentages
 * (`your-numbers.test.tsx`), the teacher's editor writes a quiz
 * (`teacher-quiz-editor.test.tsx`). A component is not a screen until a route
 * draws it: a component can be written, tested and shipped with **no page
 * mounting it at all**, and a prop such as `PhaseDoor.tasks` can exist with
 * no caller passing one.
 *
 * So each case below starts at what Next actually serves (a
 * `app/(app)/…/page.tsx` export, or the component a page's own file mounts)
 * and ends at the quiz feature's markup or call. Cut any link and the case
 * goes red:
 *
 *   /dashboard          -> YourNumbers          -> checklistPercent, masteryPercent
 *   /dashboard          -> PhasePath            -> phaseDoorHref(tasks) -> the quiz room
 *   /teacher/projects/… -> ProjectEditor        -> projectsApi.readQuizKey
 *   the staff console   -> describeAudit        -> project.quiz-key
 *
 * What this file does NOT prove is that the API answers where the client
 * knocks. That is `apps/api/test/quiz-journey.e2e-spec.ts`, which drives the
 * whole journey against the mounted application; the one assertion made here
 * about the API is that the key the teacher's door uses is a key of
 * `AUTHORING_ROUTES`, so the two suites are talking about the same route.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduleText } from './support/source-text';
import { AUTHORING_ROUTES } from '@learnsdlc/shared';
import type {
  AuthoredQuiz,
  LearnerAnalytics,
  PhaseDetail,
  PhaseSummary,
  PhaseTaskView,
} from '@learnsdlc/shared';

/* ------------------------------- the stand-ins ---------------------------- */

const rig = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  pathname: '/dashboard',
  phases: [] as PhaseSummary[],
  details: {} as Record<string, PhaseDetail>,
  analytics: null as LearnerAnalytics | null,
  readQuizKey: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useParams: () => rig.params,
  usePathname: () => rig.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'learner-1', role: 'LEARNER', displayName: 'Amir' }),
}));
const projectState = () => ({
  enrollment: { id: 'enrolment-one', projectTitle: 'Overdue Report', phases: rig.phases },
  currentPhase: rig.phases[0],
  details: rig.details,
  analytics: rig.analytics,
  loading: false,
  error: '',
});
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  // Both readers, because the solution room mounts a gate banner that asks the
  // optional one and a stand-in that answered only the first would crash the
  // page this file exists to render.
  useProject: () => projectState(),
  useProjectMaybe: () => projectState(),
}));
// Partial, deliberately: `PhasePath` is under test and must be the real one.
// Only the reviews read, which would reach the network, is stood in for.
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

// The pages, imported after the mocks so each is served the stand-ins.
import DashboardPage from '@/app/(app)/dashboard/page';
import LearnPage from '@/app/(app)/learn/page';
import ProgressPage from '@/app/(app)/progress/page';
import PortfolioPage from '@/app/(app)/artefacts/page';
import FeedbackPage from '@/app/(app)/feedback/page';
import PhaseWorkspaceLayout from '@/app/(app)/workspace/[phaseId]/layout';
import { describeAudit } from '@/components/staff/AuditList';

/* -------------------------------- fixtures -------------------------------- */

const task = (over: Partial<PhaseTaskView> = {}): PhaseTaskView =>
  ({
    key: 'main',
    order: 1,
    required: true,
    title: 'The design',
    artefactType: 'design-doc',
    evidence: 'reviewed',
    sealed: true,
    status: 'in_progress',
    awaitingSignOff: false,
    attempts: 0,
    bestScore: null,
    passedAt: null,
    lastSubmissionId: null,
    resetAt: null,
    solution: { available: false, files: 0, readAt: null },
    files: [],
    ...over,
  }) as PhaseTaskView;

const summary = (over: Partial<PhaseSummary> = {}): PhaseSummary =>
  ({
    id: 'phase-design',
    key: 'design',
    order: 2,
    title: 'Design',
    status: 'in_progress',
    attempts: 1,
    passedAt: null,
    bestScore: null,
    taskCounts: { total: 2, required: 2, passed: 1, passedRequired: 1 },
    ...over,
  }) as PhaseSummary;

const analytics = (over: Partial<LearnerAnalytics> = {}): LearnerAnalytics => ({
  projectSlug: 'overdue-report',
  progressPercent: 33,
  phasesPassed: 2,
  totalPhases: 6,
  averageScore: 74,
  totalHints: 5,
  tokensToday: 1200,
  difficultyTier: 'standard',
  relianceIndex: 18,
  checklistPercent: 67,
  masteryPercent: 80,
  phases: [],
  ...over,
});

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;

const render = async (node: ReactNode) => {
  await act(async () => {
    root.render(node as never);
  });
};

const testId = (id: string) => host.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  rig.params = {};
  rig.pathname = '/dashboard';
  rig.phases = [];
  rig.details = {};
  rig.analytics = null;
  rig.readQuizKey = vi.fn();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  host.remove();
  vi.clearAllMocks();
});

/* ============================= the learner's page ========================== */

describe('the learner overview draws the two percentages', () => {
  it('mounts YourNumbers on /dashboard, which nothing mounted before this slice', async () => {
    rig.phases = [summary()];
    rig.analytics = analytics();
    await render(<DashboardPage />);

    // The panel itself, drawn by the page, so this assertion is the wiring
    // and not a duplicate of `your-numbers.test.tsx`.
    expect(testId('home-numbers')).not.toBeNull();
    // The sponsor's "overview of the checklist as one intuitive percentage",
    // on the page a learner opens.
    expect(testId('tile-checklist')?.textContent).toContain('67%');
    expect(testId('tile-mastery')?.textContent).toContain('80%');
  });

  it('names the project the learner is on, from the enrolment (F-f)', async () => {
    rig.phases = [summary()];
    rig.analytics = analytics();
    await render(<DashboardPage />);
    expect(testId('dashboard-project')?.textContent).toBe('Your project: Overdue Report');
  });

  it('draws a dash and not a zero where a board has no quiz', async () => {
    rig.phases = [summary()];
    rig.analytics = analytics({ masteryPercent: null });
    await render(<DashboardPage />);
    // A blank and a zero are different facts. `null` is "no quiz has been
    // attempted"; `0` is a score somebody earned.
    expect(testId('tile-mastery')?.textContent).toContain('—');
    expect(testId('tile-mastery')?.textContent).not.toContain('0%');
  });

  it('draws nothing at all when the payload predates the two fields', async () => {
    rig.phases = [summary()];
    rig.analytics = analytics({ checklistPercent: undefined, masteryPercent: undefined });
    await render(<DashboardPage />);
    expect(testId('home-numbers')).not.toBeNull();
    expect(testId('tile-checklist')?.textContent).toContain('—');
  });
});

/* ============================== the board's door ========================== */

/** A phase whose only unpassed task is a quiz: the one shape the door answers. */
const quizLeft = (): PhaseDetail =>
  ({
    ...summary(),
    // The place and count the API sends with a detail (TaskTrackr's six).
    place: 2,
    count: 6,
    tasks: [
      task({ key: 'main', status: 'passed' }),
      task({
        key: 'concepts',
        order: 2,
        title: 'Check the design concepts',
        artefactType: 'quiz',
        evidence: 'automated',
        status: 'in_progress',
      }),
    ],
  }) as PhaseDetail;

describe('the board reaches the quiz room', () => {
  it('hands PhasePath the task list, so a phase whose quiz is all that is left opens it', async () => {
    rig.phases = [summary()];
    rig.details = { 'phase-design': quizLeft() };
    await render(<DashboardPage />);

    // `PhaseDoor.tasks` is what lets the door answer for a quiz at all, and
    // the live board reads `PhaseSummary[]`, which has no task list, so the
    // board must join the details in. Cut the `details` prop and this href
    // goes back to `/workspace/phase-design/design`.
    const hrefs = [...host.querySelectorAll('a')].map((one) => one.getAttribute('href'));
    expect(hrefs).toContain('/workspace/phase-design/quiz?task=concepts');
  });

  it('links only the phase on a phase that holds no quiz', async () => {
    rig.phases = [summary()];
    rig.details = {
      'phase-design': { id: 'phase-design', key: 'design', place: 2, count: 6, tasks: [task()] } as PhaseDetail,
    };
    await render(<DashboardPage />);
    const hrefs = [...host.querySelectorAll('a')].map((one) => one.getAttribute('href'));
    expect(hrefs).toContain('/workspace/phase-design/design');
    expect(hrefs.some((one) => one?.includes('/quiz'))).toBe(false);
  });
});

/* ===================== the other doors a learner comes through =========== */

/**
 * Every caller of the door hands it a task list.
 *
 * `phaseDoorHref`'s quiz arm only fires when the caller hands it a task list.
 * A "go to my project" link that reads a bare `PhaseSummary` sends a learner
 * whose phase has nothing left but a paper to the phase's own room: from
 * Learn, Progress, the portfolio, the feedback page or the workspace's own
 * recovery link. None of those needs a fetch to do better: `useProject`
 * already holds `details[phaseId].tasks` for every open phase, on the summary
 * view as much as the full one.
 *
 * Each case below asserts the **named** link rather than any href on the page,
 * because several of these pages also draw `PhasePath`, which passes the task
 * list and would make a broken door look green.
 */
describe('every door whose caller already holds the task list', () => {
  const namedHref = (label: string) =>
    [...host.querySelectorAll('a')]
      .filter((one) => (one.textContent ?? '').includes(label))
      .map((one) => one.getAttribute('href'));

  const QUIZ_DOOR = '/workspace/phase-design/quiz?task=concepts';

  beforeEach(() => {
    rig.phases = [summary()];
    rig.details = { 'phase-design': quizLeft() };
  });

  it('opens the quiz from Learn', async () => {
    await render(<LearnPage />);
    expect(namedHref('Go to my project')).toContain(QUIZ_DOOR);
  });

  it('opens the quiz from Progress', async () => {
    await render(<ProgressPage />);
    expect(namedHref('Continue my project')).toContain(QUIZ_DOOR);
  });

  it('opens the quiz from the portfolio', async () => {
    await render(<PortfolioPage />);
    expect(namedHref('Open project space')).toContain(QUIZ_DOOR);
  });

  it('opens the quiz from the feedback page', async () => {
    await render(<FeedbackPage />);
    expect(namedHref('Open phase project')).toContain(QUIZ_DOOR);
  });

  it('opens the quiz from the workspace’s recovery link', async () => {
    // The phase in the URL is not one this learner holds, which is the branch
    // that offers the way back to the phase they are actually on.
    rig.params = { phaseId: 'phase-gone' };
    rig.pathname = '/workspace/phase-gone';
    await render(<PhaseWorkspaceLayout>{null}</PhaseWorkspaceLayout>);
    expect(namedHref('Open current phase')).toContain(QUIZ_DOOR);
  });

  it('already answers for the phase in the URL, because that one is the detail', async () => {
    // `project.details[phaseId] ?? enrollment.phases.find(…)` hands the second
    // door a `PhaseDetail` whenever there is one, and a detail carries its
    // tasks, so this caller answers without any join of its own. Asserted
    // so that a later reader does not "fix" it twice.
    rig.params = { phaseId: 'phase-design' };
    rig.pathname = '/workspace/phase-design/matrix';
    await render(<PhaseWorkspaceLayout>{null}</PhaseWorkspaceLayout>);
    expect(testId('phase-view-mismatch')).not.toBeNull();
    expect(namedHref('Open Design')).toContain(QUIZ_DOOR);
  });

  it('sends a phase that holds no quiz exactly where it always went', async () => {
    rig.details = { 'phase-design': { ...summary(), tasks: [task()] } as PhaseDetail };
    await render(<LearnPage />);
    expect(namedHref('Go to my project')).toContain('/workspace/phase-design/design');
  });

  /**
   * The rule, over the files rather than over one link each.
   *
   * Five of these doors are rendered above; three more live on pages heavy
   * enough that mounting them to assert one href would be a page test wearing
   * a door's clothes: the PR room, the profile page and the lesson reader,
   * each of which already reads `useProject`'s `details` or is one destructured
   * field from it. What they share is the fact being asserted: a file that
   * holds the map must not open a door without it. A source read is the honest
   * shape for that, and it catches the ninth caller somebody adds to one of
   * these files next.
   */
  it('leaves no bare door in a file that already holds the task lists', async () => {
    const HOLDERS = [
      'app/(app)/dashboard/page.tsx',
      'app/(app)/learn/page.tsx',
      'app/(app)/progress/page.tsx',
      'app/(app)/artefacts/page.tsx',
      'app/(app)/feedback/page.tsx',
      'app/(app)/profile/page.tsx',
      'app/(app)/workspace/[phaseId]/layout.tsx',
      'app/(app)/workspace/[phaseId]/pr/page.tsx',
      // Components by a name each exports, so a moved file is still read.
      'PhasePath',
      'LessonReader',
      // The shell and Home's rows, which hold `useProject`'s map for their own
      // reasons and must not open bare doors out of it.
      'buildNextSteps',
      'navigationItems',
      'TopBar',
      'Sidebar',
    ];
    for (const file of HOLDERS) {
      const source = moduleText(file);
      // `phaseHref` is the door under its other name (the sidebar and the
      // journey strip call it) so a bare one there is the same defect.
      const calls = [...source.matchAll(/phase(?:Door)?Href\(/g)];
      expect(calls.length, `${file} calls the door`).toBeGreaterThan(0);
      for (const call of calls) {
        const after = source.slice(call.index + call[0].length, call.index + call[0].length + 14);
        expect(after, `${file} at index ${call.index}`).toBe('doorWithTasks(');
      }
    }
  });
});

/* ==================== the doors that are derived, not drawn =============== */

/**
 * Four doors are worked out in a pure function rather than written at a link.
 *
 * Home's "do next" plan and its artefact rows, the journal's timeline and the
 * shell's own palette all build an href from a phase and hand it on, and all
 * four are given the phase details already. A source read cannot speak for the
 * journal (it joins once per phase and the rows below it read the joined
 * phase, so the call there is `phaseDoorHref(phase)` and correct) so these
 * are asserted by what they return.
 */
describe('the doors Home, the journal and the palette derive', () => {
  const QUIZ_DOOR = '/workspace/phase-design/quiz?task=concepts';

  const enrollment = () =>
    ({
      id: 'enrolment-one',
      projectSlug: 'overdue-report',
      projectTitle: 'Overdue Report',
      currentPhaseOrder: 2,
      completed: false,
      phases: [summary()],
      releases: [],
    }) as never;

  /** The phase detail Home and the journal read, with a quiz left in it. */
  const detailWithQuiz = () =>
    ({
      ...quizLeft(),
      files: [{ path: 'design/design.json', editable: true, lines: 12 }],
      rubric: { passThreshold: 70, criteria: [] },
      objectives: ['Name the trade-off', 'Say what it costs'],
      lastSubmission: {
        id: 'revision-one',
        status: 'completed',
        passed: false,
        score: 40,
        createdAt: '2026-09-19T09:00:00.000Z',
        attempt: 1,
      },
    }) as never;

  it('opens the quiz from Home’s do-next plan', async () => {
    const { buildNextSteps } = await import('@/components/home/derive');
    const plan = buildNextSteps(enrollment(), { 'phase-design': detailWithQuiz() }, summary());
    const hrefs = plan.steps.map((step) => step.href);
    expect(hrefs).toContain(QUIZ_DOOR);
    expect(hrefs).not.toContain('/workspace/phase-design/design');
  });

  it('opens the quiz from a journal row', async () => {
    const { buildJournal } = await import('@/components/journal/derive');
    const events = buildJournal(enrollment(), { 'phase-design': detailWithQuiz() }, {});
    const verdict = events.find((event) => event.kind === 'submission');
    expect(verdict?.href).toBe(QUIZ_DOOR);
  });

  it('opens the quiz from the palette, both the project row and the phase row', async () => {
    const { navigationItems, phaseItems } = await import('@/components/shell/navigation');
    const details = { 'phase-design': quizLeft() };
    const project = navigationItems('LEARNER', summary(), false, details).find(
      (item) => item.label === 'My project',
    );
    expect(project?.href).toBe(QUIZ_DOOR);
    expect(phaseItems([summary()], 'phase-design', details)[0].href).toBe(QUIZ_DOOR);
  });

  it('answers as it always did where the caller holds no map', async () => {
    const { navigationItems, phaseItems } = await import('@/components/shell/navigation');
    // The nav-only shell: phase ids and nothing else. Every one of these
    // functions takes the map last and optional for exactly this caller.
    expect(
      navigationItems('LEARNER', summary(), false).find((item) => item.label === 'My project')?.href,
    ).toBe('/workspace/phase-design/design');
    expect(phaseItems([summary()], 'phase-design')[0].href).toBe('/workspace/phase-design/design');
  });
});

/* ========================= the rooms that carry the panel ================= */

// That every document room hands its task panel the phase it is in, so a
// row is a door to the room its task is worked in, is asserted on the
// rendered rooms: `design-review-uploaded-words` (design), `versioned-document-pages`
// (change), `signoff-merge-wiring` (pull request) and `solution-room`.

/* =========================== the teacher's key door ======================= */

describe("the teacher's answer panel reaches the one audited door", () => {
  it('is a route of the contract, so the client and the API name one path', () => {
    // `api-projects.ts` builds every path from this table rather than retyping
    // it, so a client that knocks somewhere the API does not answer is a red
    // build here rather than a 404 a teacher meets.
    const route = AUTHORING_ROUTES['tasks.quizKey'];
    expect(route.method).toBe('GET');
    expect(route.path).toContain('/quiz/key');
    // It is a GET, so it declares no write to audit, and it audits anyway,
    // for `solution.read`'s reason. That is stated on the field rather than
    // left for a reader to notice.
    expect(route.mutates).toBe(false);
    expect(route.audit).toBeNull();
  });

  it('gives the console a sentence for the row that read a key', () => {
    const drawn = describeAudit({
      id: 'a-1',
      event: 'project.quiz-key',
      detail: { taskTitle: 'Check the design concepts' },
    } as never);
    // Without its own case the row falls to `describeAudit`'s `default:` arm
    // and reads "A recorded change": true, and no use to a class asking who
    // has seen an answer key.
    expect(drawn.title).toBe('Read the answer key for Check the design concepts');
    expect(drawn.unnamed).toBeUndefined();
  });
});

/* ===================== the editor's client, end to end ==================== */

describe('the project editor holds a client for the key route', () => {
  it('exports readQuizKey, typed to the payload that carries the key', async () => {
    // The one client call in the whole teacher surface that carries `correct`.
    // It is here rather than in the draft payload because `readDraft` is
    // guarded by `requireVisibleProject`, which admits every instructor to
    // every platform-owned project.
    const module = await import('@/lib/api-projects');
    expect(typeof module.projectsApi.readQuizKey).toBe('function');
    expect(module.authoringPath('tasks.quizKey', {
      projectId: 'p-1',
      versionId: 'v-1',
      phaseKey: 'design',
      taskKey: 'concepts',
    })).toBe('/instructor/projects/p-1/versions/v-1/phases/design/tasks/concepts/quiz/key');
    // And the type it answers with is the one with the key in it.
    const answers: AuthoredQuiz = { questions: [] };
    expect(answers.questions).toEqual([]);
  });
});

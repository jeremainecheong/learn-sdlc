// @vitest-environment jsdom
/**
 * Locked out of a required quiz, and let back in: over the pages Next serves.
 *
 * A required quiz failed on every allowed paper shuts the phase and the
 * project, so something in the product must open it. A teacher's per-task
 * **reset** starts a new attempt
 * epoch: the API decides it, `QuizRoomView.needsInstructorReset` says it to the
 * learner and `InstructorTaskView.quizAttemptsSpent` says it to the teacher.
 * Each half has its own component suite (`quiz-room.test.tsx` and
 * `teacher-task-levers.test.tsx`) and each of those renders a component with a
 * payload handed to it.
 *
 * A component holding the right payload is not a recovery. What is asserted
 * here is the path: the page a learner opens asks the **route** and draws what
 * comes back; the page a teacher opens draws the flag and its Reset goes out on
 * the **route** that frees them; and the room the learner opens next offers a
 * fresh paper. So the three cases share one small stand-in for the server, and
 * the only thing that moves it from the locked state to the open one is the
 * teacher's own click inside the mounted console.
 *
 *   /workspace/:id/quiz  -> QuizPage -> QuizRoom -> GET  …/quiz            (1)
 *   /teacher/class       -> TeacherPortal -> LearnerTasks
 *                                         -> POST …/override task-reset    (2)
 *   /workspace/:id/quiz  -> QuizPage -> QuizRoom -> GET  …/quiz again      (3)
 *
 * `instructorApi` is **not** stood in for here, which is the difference
 * between this file and `task-grain-wiring.test.tsx`: the client builds the
 * override path itself and the case asserts the path that leaves it, so a
 * console that knocks where the API does not answer is red here rather than in
 * a classroom. What this file does not prove is that the API answers there:
 * that is `apps/api/test/quiz-journey.e2e-spec.ts`, whose lock-and-recover leg
 * drives the same two routes against the mounted application.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstructorLearnerDetail,
  InstructorPhaseView,
  InstructorTaskView,
  LearnerAnalytics,
  PhaseDetail,
  PhaseSummary,
  PhaseTaskView,
  QuizRoomView,
  SubmissionView,
} from '@learnsdlc/shared';

/* ------------------------------- the fixtures ----------------------------- */

const PHASE_ID = 'phase-testing';
const QUIZ_KEY = 'concepts';
const LEARNER = 'learner-one';
const MAX = 3;

/**
 * The one state the whole file is about, and the one thing that moves it.
 *
 * `handedIn` is papers handed in **this epoch**, which is what the API counts;
 * `reset` is what the override route does to it, written here exactly as the
 * API describes the state it leaves behind: attempts back,
 * best score gone, the task open again, and every paper still in the record
 * (which is why `papers` only ever grows).
 */
const server = {
  handedIn: MAX,
  epoch: 0,
  passed: false,
  bestScore: 40 as number | null,
  lastSubmissionId: 'revision-three' as string | null,
  papers: MAX,
  /** The stamp `task-reset` writes on the task's row, beside `resetCount`. */
  resetAt: null as string | null,
  /** Every request that reached the client layer, method and path. */
  calls: [] as { method: string; path: string; body?: unknown }[],
  reset() {
    this.epoch += 1;
    this.handedIn = 0;
    this.passed = false;
    this.bestScore = null;
    this.lastSubmissionId = null;
    this.resetAt = '2026-09-19T11:00:00.000Z';
  },
};

/**
 * The room payload, built from the state above by the rule the API applies.
 *
 * The rule itself lives in `apps/api/src/quiz/quiz.service.ts` and is pinned by
 * `quiz.service.spec.ts` and by the journey e2e. It has **four** conjuncts:
 * every allowed paper of this run handed in, the task's row not passed, no
 * paper being offered back, and the newest sheet not still being marked. The
 * expression below carries the first two and holds the other two true by
 * construction (every paper this file's server hands in is marked, and it
 * never offers one back) because the states this file walks are the locked
 * one and the freed one, and the two it leaves out are `quiz-room.test.tsx`'s.
 * It is reproduced here only so that the payloads this file serves are the
 * ones the API really sends; what the cases assert is which page draws which,
 * never the rule.
 */
const roomView = (): QuizRoomView => {
  const attemptsLeft = Math.max(0, MAX - server.handedIn);
  return {
    taskKey: QUIZ_KEY,
    title: 'Concept check',
    brief: 'Four questions on what the tests are for.',
    required: true,
    status: server.passed ? 'passed' : 'in_progress',
    drawn: 4,
    passMark: 60,
    attemptsUsed: server.handedIn,
    attemptsLeft,
    needsInstructorReset: attemptsLeft === 0 && !server.passed,
    cooldownSecondsLeft: null,
    bestScore: server.bestScore,
    lastSubmissionId: server.lastSubmissionId,
    paper: null,
  };
};

const lastRevision = (): SubmissionView =>
  ({
    id: 'revision-three',
    taskKey: QUIZ_KEY,
    status: 'completed',
    passed: false,
    score: 40,
    createdAt: '2026-09-19T10:00:00.000Z',
    attempt: 3,
    report: null,
  }) as SubmissionView;

const quizTask = (): PhaseTaskView =>
  ({
    key: QUIZ_KEY,
    order: 2,
    required: true,
    title: 'Concept check',
    artefactType: 'quiz',
    evidence: 'automated',
    sealed: true,
    status: 'in_progress',
    awaitingSignOff: false,
    attempts: server.papers,
    bestScore: server.bestScore,
    passedAt: null,
    lastSubmissionId: server.lastSubmissionId,
    // The task's own row is the only thing either page reads that is not
    // scoped to the attempt epoch: `attempts` counts every paper this learner
    // handed in on this task, and `resetAt` is when the epoch last moved.
    resetAt: server.resetAt,
    solution: { available: false, files: 0, readAt: null },
    files: [],
  }) as PhaseTaskView;

const phaseSummary = (): PhaseSummary =>
  ({
    id: PHASE_ID,
    key: 'testing',
    order: 4,
    title: 'Testing',
    status: 'in_progress',
    bestScore: null,
    attempts: 4,
    reflection: null,
    passedAt: null,
    taskCounts: { total: 2, required: 2, passed: 1, passedRequired: 1 },
  }) as PhaseSummary;

const phaseDetail = (): PhaseDetail =>
  ({
    ...phaseSummary(),
    tasks: [
      {
        ...quizTask(),
        key: 'suite',
        order: 1,
        title: 'The test suite',
        artefactType: 'test-suite',
        status: 'passed',
      },
      quizTask(),
    ],
  }) as PhaseDetail;

const analytics = (): LearnerAnalytics => ({
  projectSlug: 'overdue-report',
  progressPercent: 50,
  phasesPassed: 3,
  totalPhases: 6,
  averageScore: 71,
  totalHints: 2,
  tokensToday: 0,
  difficultyTier: 'standard',
  relianceIndex: 10,
  checklistPercent: 50,
  masteryPercent: 40,
  phases: [],
});

/** The quiz row as the console reads it, from the same state. */
const consoleQuizTask = (): InstructorTaskView => ({
  key: QUIZ_KEY,
  order: 2,
  required: true,
  title: 'Concept check',
  status: server.passed ? 'passed' : 'in_progress',
  bestScore: server.bestScore,
  attempts: server.papers,
  passedAt: null,
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: null,
  // Present because this task is a quiz whose teacher set a limit; the value
  // is the same two facts the learner's room reads.
  quizAttemptsSpent: server.handedIn >= MAX && !server.passed,
});

const consolePhase = (): InstructorPhaseView =>
  ({
    id: PHASE_ID,
    key: 'testing',
    title: 'Testing',
    order: 4,
    status: 'in_progress',
    bestScore: null,
    attempts: 4,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    hints: 0,
    relianceIndex: 0.1,
    passThreshold: 70,
    unlockedAt: '2026-09-18T00:00:00.000Z',
    lastSubmission: null,
    tasks: [
      {
        key: 'suite',
        order: 1,
        required: true,
        title: 'The test suite',
        status: 'passed',
        bestScore: 88,
        attempts: 2,
        passedAt: '2026-09-18T09:00:00.000Z',
        awaitingSignOff: false,
        signedOffAt: null,
        lastSubmission: null,
      },
      consoleQuizTask(),
    ],
  }) as InstructorPhaseView;

const learnerDetail = (): InstructorLearnerDetail =>
  ({
    userId: LEARNER,
    displayName: 'Ada Example',
    email: 'ada@example.test',
    cohort: 'class-one',
    cohortName: 'Example class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'enrolment-one',
        projectSlug: 'overdue-report',
        projectTitle: 'Overdue Report',
        currentPhaseOrder: 4,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: [consolePhase()],
      },
    ],
  }) as InstructorLearnerDetail;

/* ------------------------------- the stand-ins ---------------------------- */

const rig = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  search: '',
  user: {} as Record<string, unknown>,
  // One object for the whole file. A stand-in that answered a fresh router on
  // every render would re-run every effect that depends on one (the teacher
  // portal's loader does) and the page would fetch itself in a circle.
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  request: vi.fn(),
  getSubmission: vi.fn(),
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
  };
});
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    prefetch: _prefetch,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    prefetch?: boolean;
    scroll?: boolean;
  }) => (
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
  useSession: () => rig.user,
}));
// Partial, deliberately. `request` is the seam every client in this file goes
// through, so `instructorApi` and `quizApi` are the REAL ones and the paths
// they build are what the cases read. `api.getSubmission` is the room's one
// other call, for the paper it draws back beside the counters.
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request, api: { ...actual.api, getSubmission: rig.getSubmission } };
});
const projectState = () => ({
  enrollment: {
    id: 'enrolment-one',
    projectTitle: 'Overdue Report',
    projectSlug: 'overdue-report',
    currentPhaseOrder: 4,
    completed: false,
    phases: [phaseSummary()],
  },
  currentPhase: phaseSummary(),
  details: { [PHASE_ID]: phaseDetail() },
  analytics: analytics(),
  loading: false,
  error: '',
});
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => projectState(),
  useProjectMaybe: () => projectState(),
}));
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
vi.mock('@/lib/api-projects', () => ({
  projectsApi: { get: vi.fn(), draft: vi.fn(), files: vi.fn() },
  authoringPath: () => '/instructor/projects',
}));
vi.mock('@/lib/api-cohorts', () => ({
  cohortsApi: {
    mine: vi.fn().mockResolvedValue([
      { id: 'class-one', name: 'Example class', joinCode: 'EXAMPLE1', memberCount: 1 },
    ]),
  },
  formatJoinCode: (value: string) => value,
}));
vi.mock('@/lib/api-experience', () => ({
  experienceApi: {
    teacherFeedback: vi.fn().mockResolvedValue([]),
    teacherSubmissions: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@/lib/api-mentor', () => ({ mentorApi: { notes: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: () => null,
}));

// The pages, imported after the mocks so each is served the stand-ins.
import QuizPage from '@/app/(app)/workspace/[phaseId]/quiz/page';
import TeacherClassPage from '@/app/(app)/teacher/class/page';

/* -------------------------------- the server ------------------------------ */

const QUIZ_PATH = `/phases/${PHASE_ID}/tasks/${QUIZ_KEY}/quiz`;
const OVERRIDE_PATH = `/instructor/learners/${LEARNER}/phases/${PHASE_ID}/override`;

/**
 * One fake for every route these two pages knock at, routed by path.
 *
 * It answers the override by **moving the state** rather than by returning a
 * fixture, which is what lets the third case read a room the second case
 * opened. Anything it does not recognise throws with the path in the message:
 * a page that started asking somewhere new should fail loudly here rather than
 * render half a screen.
 */
const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  server.calls.push({ method, path, body });
  if (method === 'GET' && path === QUIZ_PATH) return roomView();
  if (method === 'GET' && path.startsWith('/instructor/overview')) {
    return { learners: [{ userId: LEARNER, cohort: 'class-one' }] };
  }
  if (method === 'GET' && path === `/instructor/learners/${LEARNER}`) return learnerDetail();
  // The class page reads its class in one request.
  if (method === 'GET' && path.startsWith('/instructor/learners?')) return [learnerDetail()];
  if (method === 'GET' && path.startsWith('/instructor/audit')) return [];
  if (method === 'POST' && path === OVERRIDE_PATH) {
    const sent = body as { action?: string; taskKey?: string };
    if (sent?.action === 'task-reset' && sent.taskKey === QUIZ_KEY) server.reset();
    return consolePhase();
  }
  throw new Error(`nothing in this file answers ${method} ${path}`);
};

/* ------------------------------- the harness ------------------------------ */

let host: HTMLDivElement;
let root: Root;

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const render = (node: ReactNode) => act(async () => root.render(node as never));
const click = (node: Element | null) => act(async () => (node as HTMLButtonElement).click());

/** The learner's quiz room, on the route that serves it. */
const openTheRoom = async () => {
  rig.user = { id: LEARNER, role: 'LEARNER', displayName: 'Ada Example' };
  rig.params = { phaseId: PHASE_ID };
  window.history.replaceState(null, '', `/workspace/${PHASE_ID}/quiz?task=${QUIZ_KEY}`);
  rig.search = `?task=${QUIZ_KEY}`;
  await render(<QuizPage />);
};

/** The teacher's class page, opened on this learner's evidence. */
const openTheConsole = async () => {
  rig.user = { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher A' };
  rig.params = {};
  window.history.replaceState(
    null,
    '',
    `/teacher/class?class=class-one&evidence=${LEARNER}&phase=${PHASE_ID}`,
  );
  rig.search = `?class=class-one&evidence=${LEARNER}&phase=${PHASE_ID}`;
  await render(<TeacherClassPage />);
};

const REASON = 'Ada ran out of papers before the concepts landed.';

/** Pull the lever the way a teacher does: ask, give a reason, confirm. */
const resetTheQuiz = async () => {
  await click(q(`task-reset-${QUIZ_KEY}`));
  const reason = q(`task-lever-reason-${QUIZ_KEY}`) as HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    setter?.call(reason, REASON);
    reason.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(q(`task-lever-do-${QUIZ_KEY}`));
};

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
  server.handedIn = MAX;
  server.epoch = 0;
  server.passed = false;
  server.bestScore = 40;
  server.lastSubmissionId = 'revision-three';
  server.papers = MAX;
  server.resetAt = null;
  server.calls = [];
  rig.request.mockImplementation(serve);
  rig.getSubmission.mockImplementation(async () => lastRevision());
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

/* ============================ 1. the learner's room ======================= */

describe('the room a locked-out learner opens', () => {
  it('asks the quiz route and draws the state it answers with', async () => {
    await openTheRoom();

    // The route, as the client built it. `quizPath` fills the controller's own
    // template, so a segment renamed on either side is red here.
    expect(server.calls.filter((call) => call.path === QUIZ_PATH)).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ method: 'GET', path: QUIZ_PATH });

    // What the page draws, on the route Next serves it from, not a component
    // handed a payload. Cut `needsInstructorReset` out of the room and this
    // goes red; cut the room out of the page and so does the whole case.
    expect(q('quiz-page')).not.toBeNull();
    expect(q('quiz-needs-reset')).not.toBeNull();
    expect(host.textContent).toContain('You have handed in every paper on this quiz');
    expect(host.textContent).toContain('Your instructor can reset this quiz');
    // The phase's Pass is waiting on it, and the room says so because the
    // payload says the quiz is required (the phase itself is open).
    expect(host.textContent).toContain('the phase cannot pass until this quiz passes');

    // And no control that the route would refuse by name.
    expect(q('quiz-start')).toBeNull();
    expect(q('quiz-spent')).toBeNull();
  });

  it('draws the paper they last handed in beside it, rather than losing it', async () => {
    await openTheRoom();

    // `lastSubmissionId` is read back through the ordinary submission call, so
    // a learner in this state still sees what happened last time. The counters
    // above it are the API's, and they say three of three.
    expect(rig.getSubmission).toHaveBeenCalledWith('revision-three');
    expect(q('quiz-attempts-available')?.textContent).toBe(
      '3 papers handed in. You have no attempts left.',
    );
  });
});

/* =========================== 2. the teacher's page ======================== */

describe("the console a teacher opens, and the lever that frees the learner", () => {
  it('names the learner who has run out, on the page the route serves', async () => {
    await openTheConsole();

    expect(q('learner-tasks')).not.toBeNull();
    expect(q(`task-quiz-spent-${QUIZ_KEY}`)).not.toBeNull();
    expect(host.textContent).toContain(
      'Ada Example has handed in every paper on Concept check and has not passed it.',
    );
    // The lever that answers it is on the same row as the sentence.
    expect(q(`task-reset-${QUIZ_KEY}`)).not.toBeNull();
  });

  it('sends the reset to the override route, with the task it is about', async () => {
    await openTheConsole();
    await resetTheQuiz();

    // The real client built this path: `instructorApi` is not stood in for in
    // this file. A console that knocked anywhere else would throw out of the
    // stand-in above rather than quietly pass.
    const sent = server.calls.filter((call) => call.method === 'POST');
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(OVERRIDE_PATH);
    expect(sent[0].body).toEqual({ action: 'task-reset', reason: REASON, taskKey: QUIZ_KEY });

    // And the row redraws from what the route answered: the lever is wired to
    // the panel's own state, not only to the network.
    expect(q(`task-quiz-spent-${QUIZ_KEY}`)).toBeNull();
    expect(host.textContent).not.toContain('has handed in every paper on Concept check');
  });

  it('leaves every paper the learner sat in the record', async () => {
    await openTheConsole();
    await resetTheQuiz();

    // The recovery returns attempts; it never deletes history. The row still
    // counts the three papers, and the epoch is what moved.
    expect(server.papers).toBe(MAX);
    expect(server.epoch).toBe(1);
    expect(server.handedIn).toBe(0);
  });
});

/* ======================= 3. the room, after the reset ===================== */

describe('the room the learner opens next', () => {
  it('offers a fresh paper, because the teacher’s click is what moved the state', async () => {
    // The lock, from the learner's side.
    await openTheRoom();
    expect(q('quiz-needs-reset')).not.toBeNull();

    // The teacher's own page, and the teacher's own click. Nothing else in
    // this case touches the state the room reads.
    await openTheConsole();
    await resetTheQuiz();

    // The same room, asked again.
    await openTheRoom();
    expect(q('quiz-needs-reset')).toBeNull();
    const start = q('quiz-start');
    expect(start).not.toBeNull();
    // "Start the quiz" rather than "Take it again": no paper of this run has
    // been handed in, which is exactly what a new epoch means.
    expect(start?.textContent).toContain('Start the quiz');
    expect(q('quiz-attempts-available')?.textContent).toBe(
      '0 papers handed in. 3 attempts left.',
    );
    // Nothing is carried over from the run that ended: the best score is
    // cleared with the pass it belonged to.
    expect(host.textContent).toContain('Not scored yet');
  });

  /**
   * The same screen, read as a learner reads it.
   *
   * Every counter above is now identical to the one a learner gets on a quiz
   * they have never opened (no papers, the whole limit back, no best score,
   * no earlier result) and the locked room they saw before the reset told
   * them their three papers stay in their record. The page is what closes that
   * gap, because the fact is on the task's row rather than on the quiz route:
   * cut the row out of the page and this case goes red while every assertion
   * above it stays green.
   */
  it('says the reset happened, rather than drawing a quiz nobody ever opened', async () => {
    await openTheRoom();
    await openTheConsole();
    await resetTheQuiz();
    await openTheRoom();

    expect(q('quiz-was-reset')).not.toBeNull();
    expect(host.textContent).toContain('Your instructor reset this quiz.');
    expect(host.textContent).toContain('every paper you handed in before it stays in your record');
    // The promise the locked-out room made is the one being kept here.
    expect(server.papers).toBe(MAX);
  });

  it('said nothing of the kind before the teacher touched it', async () => {
    await openTheRoom();

    // The row carries no reset, so there is no sentence, and the state the
    // room is in is the locked one, which says its own thing.
    expect(q('quiz-was-reset')).toBeNull();
    expect(q('quiz-needs-reset')).not.toBeNull();
  });
});

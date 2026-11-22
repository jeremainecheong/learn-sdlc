// @vitest-environment jsdom
/**
 * The teacher's console, mounted on the route a teacher opens: `/teacher`,
 * whose page is `TeacherPortal`. `/instructor` and `/instructor/learners/[id]`
 * redirect there, so the CSV exports and View as must have their controls on
 * this page or nothing in the product calls them.
 *
 * The one seam is `request` in `@/lib/api`, answered by a stateful stand-in of
 * the routes the console reads and writes; the CSV exports leave through
 * `fetch`, which is stood in for the same way. Every client between the page
 * and those seams (`instructorApi`, `cohortsApi`, `experienceApi`,
 * `lib/view-as`) is the product's own.
 *
 *  - A phase cell says the phase, not the newest revision's verdict. On a
 *    split phase that revision can be an optional task's (Requirements, passed
 *    and left, would read "Needs revision") or one task's pass on a phase
 *    still shut (Design would read "Pass").
 *  - A Sign off credits a task on the board; the strict-evidence gate still
 *    wants a reviewed pass of it. The question says so before, the answer's
 *    `note` says so after, and the roster and the evidence panel say who is
 *    waiting on what (`evidenceNeeded`).
 *  - Both CSV exports and View as have a door on this page.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InstructorLearnerDetail,
  InstructorPhaseView,
  InstructorTaskView,
  PhaseKey,
  SubmissionView,
} from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  request: vi.fn(),
  router: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));
vi.mock('@/lib/api', async (original) => {
  const actual = await original<typeof import('@/lib/api')>();
  return { ...actual, request: rig.request, getToken: () => 'teacher-token' };
});
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => rig.router,
    usePathname: () => window.location.pathname,
  };
});
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher A' }),
}));
// Their own panels, with their own reads and their own suites.
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/staff/ClassProjectCard', () => ({ ClassProjectCard: () => null }));
vi.mock('@/components/staff/NotesCard', () => ({ NotesCard: () => null }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({
  SubmissionEvidence: ({ submissionId }: { submissionId: string }) => <section data-testid="selected-evidence">{submissionId}</section>,
}));

import TeacherPage from '@/app/(app)/teacher/page';
import TeacherClassPage from '@/app/(app)/teacher/class/page';
import { phaseCellRevision } from '@/components/staff/console/teacher-portal-model';
import { stopViewAs, viewingAs } from '@/lib/view-as';

/* --------------------------------- the server ----------------------------- */

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

/** A strictly reviewed revision, marked as the API marks one. */
const revision = (id: string, taskKey: string, passed: boolean, createdAt: string): SubmissionView =>
  ({
    id,
    taskKey,
    status: 'completed',
    passed,
    score: passed ? 90 : 100,
    createdAt,
    attempt: 1,
    workspaceSnapshot: { files: {} },
    report: {
      assessmentMode: 'strict_binary',
      passed,
      checks: [{ id: 'c1', status: 'passed' }],
      aiReview: {
        verdict: passed ? 'pass' : 'revise',
        criteriaEvidence: [{ met: passed, evidence: passed ? 'Named.' : '', issue: passed ? '' : 'Missing.' }],
      },
    },
  }) as unknown as SubmissionView;

/** Requirements' optional inherited control, marked last and not passed. */
const CONTROL = revision('rev-control', 'main', false, '2026-09-28T14:35:00.000Z');
/** Design's authored decision, passed; the inherited design task has none. */
const DECISION = revision('rev-decision', 'clash-decision', true, '2026-09-28T14:41:00.000Z');
/** A sole-task phase's own revision, marked and not passed. */
const SOLE = revision('rev-sole', '', false, '2026-09-28T14:50:00.000Z');

const task = (over: Partial<InstructorTaskView> & { key: string; order: number }): InstructorTaskView => ({
  required: true,
  title: over.key,
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  passedAt: null,
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: null,
  ...over,
});

const state = {
  /** Design's inherited task, before and after the teacher signs it off. */
  designMainSignedOff: false,
  /** The learner on a project whose phases are each one task (TaskTrackr). */
  soleTask: false,
  overrides: [] as unknown[],
  views: [] as string[],
  /** A split Design whose Needs-revision task is hidden by a newer queued one. */
  hiddenRevision: false,
  /** Design's signed-off quiz has no paper left. */
  spentQuiz: false,
  /** The requests the phase-wide levers and the class levers made. */
  regrades: [] as unknown[],
  learnerReads: 0,
  calls: [] as { method: string; path: string; body?: unknown }[],
};

const designTasks = (): InstructorTaskView[] => [
  task({
    key: 'main',
    order: 1,
    title: 'The design',
    ...(state.designMainSignedOff
      ? { status: 'passed', bestScore: 70, passedAt: '2026-09-28T14:51:00.000Z', signedOffAt: '2026-09-28T14:51:00.000Z' }
      : {}),
  }),
  task({ key: 'clash-decision', order: 2, title: 'The clash decision', status: 'passed', bestScore: 90, attempts: 2, passedAt: DECISION.createdAt, lastSubmission: DECISION }),
];

const phase = (i: number): InstructorPhaseView => {
  const key = KEYS[i];
  const base = {
    id: `phase-${key}`,
    key,
    order: i + 1,
    title: TITLES[i],
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    hints: 0,
    relianceIndex: 0,
    passThreshold: 70,
    unlockedAt: null,
    status: 'locked',
    lastSubmission: null,
  } as unknown as InstructorPhaseView;
  if (state.soleTask) {
    // A teacher's phase-wide Pass on Requirements: the board reads passed, the
    // phase's only revision was marked and not passed, and the gate waits.
    if (i === 0)
      return {
        ...base,
        status: 'passed',
        lastSubmission: SOLE,
        tasks: [],
        evidenceNeeded: [{ key: '', title: 'Requirements' }],
      };
    if (i === 1) return { ...base, status: 'locked' };
    return base;
  }
  if (i === 0)
    return {
      ...base,
      status: 'passed',
      lastSubmission: CONTROL,
      tasks: [
        task({ key: 'main', order: 1, title: 'The overdue story', required: false, status: 'submitted', attempts: 1, bestScore: 0, lastSubmission: CONTROL }),
        task({ key: 'booking-story', order: 2, title: 'The booking story', status: 'passed', bestScore: 88, attempts: 2, passedAt: '2026-09-28T14:30:00.000Z' }),
      ],
    };
  if (i === 1 && state.hiddenRevision) {
    // booking-story came back Needs revision at 10:00; booking-glossary was
    // handed in at 10:05 and is still queued. The newest revision on the phase
    // is the queued one, and it must not hide the one waiting on a revision.
    const needs = revision('rev-story', 'booking-story', false, '2026-09-28T10:00:00.000Z');
    const queued = { ...revision('rev-glossary', 'booking-glossary', false, '2026-09-28T10:05:00.000Z'), status: 'queued', passed: null, report: null } as unknown as SubmissionView;
    return {
      ...base,
      status: 'in_progress',
      lastSubmission: queued,
      tasks: [
        task({ key: 'booking-story', order: 1, title: 'The booking story', status: 'submitted', attempts: 1, lastSubmission: needs }),
        task({ key: 'booking-glossary', order: 2, title: 'The glossary', status: 'submitted', attempts: 1, lastSubmission: queued }),
      ],
    };
  }
  if (i === 1)
    return {
      ...base,
      status: state.designMainSignedOff ? 'passed' : 'in_progress',
      lastSubmission: DECISION,
      tasks: designTasks(),
      ...(state.designMainSignedOff ? { evidenceNeeded: [{ key: 'main', title: 'The design' }] } : {}),
      ...(state.spentQuiz
        ? {
            status: 'passed',
            evidenceNeeded: [
              { key: 'main', title: 'The design' },
              { key: 'design-quiz', title: 'Design concepts', noPapersLeft: true },
            ],
          }
        : {}),
    };
  return base;
};

const learner = (): InstructorLearnerDetail =>
  ({
    userId: 'learner-one',
    displayName: 'Ada Example',
    email: 'ada@example.invalid',
    cohort: 'class-one',
    cohortName: 'RoomDesk class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'enrolment-one',
        projectSlug: state.soleTask ? 'tasktrackr' : 'room-desk',
        projectTitle: state.soleTask ? 'TaskTrackr' : 'RoomDesk',
        currentPhaseOrder: state.soleTask ? 1 : 2,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: KEYS.map((_, i) => phase(i)),
      },
    ],
  }) as InstructorLearnerDetail;

const NOTE =
  'Design reads passed, but the learner cannot move on until The design has a reviewed pass of its own. ' +
  'A sign-off or a Pass credits the work here; it does not stand in for the review, so they still submit it for one.';

const serve = async (method: string, path: string, body?: unknown): Promise<unknown> => {
  state.calls.push({ method, path, body });
  if (method === 'GET' && path === '/instructor/cohorts')
    return [{ id: 'class-one', name: 'RoomDesk class', joinCode: 'ROOMDESK', memberCount: 1 }];
  if (method === 'GET' && path.startsWith('/instructor/overview'))
    return {
      learners: [{ userId: 'learner-one', displayName: 'Ada Example', email: 'ada@example.invalid', cohort: 'class-one', cohortName: 'RoomDesk class', projectSlug: 'room-desk' }],
      cohortSize: 1,
      averageProgress: 0,
      averageReliance: 0,
      aiProvider: 'openai',
    };
  if (method === 'GET' && path === '/instructor/learners/learner-one') {
    state.learnerReads += 1;
    return learner();
  }
  // The portal reads its class in one request, which reads this learner as
  // the per-learner route does.
  if (method === 'GET' && path.startsWith('/instructor/learners?')) {
    state.learnerReads += 1;
    return [learner()];
  }
  // The phase-wide levers on a phase with one task.
  if (method === 'POST' && path === '/instructor/learners/learner-one/phases/phase-requirements/override') {
    state.overrides.push(body);
    const action = (body as { action: string }).action;
    const current = phase(0);
    if (action === 'reopen') return { ...current, status: 'in_progress', passedAt: null, evidenceNeeded: undefined };
    if (action === 'reset-phase') return { ...current, status: 'in_progress', passedAt: null, bestScore: null, evidenceNeeded: undefined };
    return current;
  }
  if (method === 'POST' && path === '/instructor/regrades') {
    state.regrades.push(body);
    return {
      id: 'batch-one',
      status: 'finished',
      projectSlug: 'tasktrackr',
      phaseKey: 'requirements',
      scope: 'everyone',
      reason: (body as { reason: string }).reason,
      packVersionTo: '2.0.1',
      requested: 1,
      done: 1,
      failed: 0,
      newPasses: 0,
      skipped: [],
      createdAt: '2026-09-29T00:00:00.000Z',
      finishedAt: '2026-09-29T00:00:01.000Z',
    };
  }
  // The class's two panels: its dates, and the project it was given.
  if (method === 'GET' && /^\/instructor\/cohorts\/class-one\/schedule/.test(path))
    return { cohortId: 'class-one', projectSlug: 'room-desk', phases: [] };
  if (method === 'GET' && path === '/instructor/cohorts/class-one/project')
    return {
      cohortId: 'class-one',
      active: {
        id: 'assignment-one',
        cohortId: 'class-one',
        projectVersionId: 'room-desk-1',
        projectSlug: 'room-desk',
        projectTitle: 'RoomDesk',
        version: '1.0.0',
        assignedByUserId: 'teacher',
        assignedByName: 'Teacher A',
        reason: 'The class works on RoomDesk.',
        active: true,
        createdAt: '2026-09-28T00:00:00.000Z',
      },
      history: [],
    };
  if (method === 'GET' && path.startsWith('/instructor/audit')) return [];
  if (method === 'GET' && path.startsWith('/submissions/learner-history/'))
    return { items: [], nextCursor: null, total: 0 };
  if (method === 'GET' && /\/submissions\/[^/]+\/teacher-feedback$/.test(path)) return [];
  if (method === 'POST' && path === '/instructor/learners/learner-one/phases/phase-design/override') {
    state.overrides.push(body);
    state.designMainSignedOff = true;
    return { ...phase(1), note: NOTE };
  }
  if (method === 'POST' && path === '/instructor/learners/learner-one/view') {
    state.views.push(path);
    return { userId: 'learner-one', displayName: 'Ada Example' };
  }
  throw Object.assign(new Error(`no route for ${method} ${path}`), { status: 404 });
};

/** The two CSV routes, which leave through `fetch` because the body is not JSON. */
const csvFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
  state.calls.push({ method: 'GET', path: url.replace(/^.*\/api\/v1/, '') });
  if (/\/instructor\/(export|gradebook)\.csv/.test(url))
    return new Response('learner,phase\n', { status: 200, headers: { 'content-type': 'text/csv' } });
  return new Response('{}', { status: 404 });
});

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const must = <T extends HTMLElement>(id: string) => {
  const found = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1)
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
};
const open = async (search = '') => {
  window.history.replaceState(null, '', `/teacher${search}`);
  await act(async () => root.render(<TeacherPage />));
  await settle();
};
/**
 * The class page of Ada's class. The learner phase map is a class's and is
 * not in the view across classes, so every roster cell and roster lever below is
 * read here; `search` adds to `?class=`.
 */
const openClass = async (search = '') => {
  window.history.replaceState(null, '', `/teacher/class?class=class-one${search}`);
  await act(async () => root.render(<TeacherClassPage />));
  await settle(12);
};
/** The map's cell for one phase, by the label a screen reader hears. */
const cell = (phaseTitle: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Inspect Ada Example, ${phaseTitle}"]`);
const downloads: { name: string }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  state.designMainSignedOff = false;
  state.soleTask = false;
  state.hiddenRevision = false;
  state.spentQuiz = false;
  state.regrades = [];
  state.learnerReads = 0;
  state.overrides = [];
  state.views = [];
  state.calls = [];
  downloads.length = 0;
  stopViewAs();
  rig.request.mockImplementation(serve);
  vi.stubGlobal('fetch', csvFetch);
  const replace = window.history.replaceState.bind(window.history);
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    replace(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    push(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:csv') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download) downloads.push({ name: this.download });
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  stopViewAs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/* ------------------------------ the phase cells --------------------------- */

describe('a roster cell says the phase, not the newest revision', () => {
  it('reads a passed split phase as passed, whatever its optional task last got', async () => {
    await openClass();
    const requirements = cell('Requirements');
    expect(requirements).not.toBeNull();
    // A reviewed pass is named "Review passed".
    expect(requirements!.textContent).toContain('Review passed');
    expect(requirements!.textContent).not.toContain('Needs revision');
  });

  it('reads a split phase still shut as not passed, whatever one task last got', async () => {
    await openClass();
    const design = cell('Design');
    expect(design!.textContent).not.toContain('Pass');
    expect(design!.textContent).toContain('In progress');
  });

  it('keeps a phase with one task reading its verdict while it is open, and reads it passed once it is', async () => {
    state.soleTask = true;
    await openClass();
    // A teacher's phase-wide Pass: the board says passed, the revision did not.
    // A teacher's credit is named as credit, never as a reviewed pass.
    expect(cell('Requirements')!.textContent).toContain('Credit awarded, review still needed');
    expect(cell('Requirements')!.textContent).not.toContain('Review passed');
    expect(cell('Requirements')!.textContent).not.toContain('Needs revision');
  });
});

/* ------------------------ the teacher's half of the gate ------------------ */

describe('a sign-off credits the board and says the gate still waits', () => {
  // The roster and the evidence panel are read together, on the class page.
  const openDesign = async () => {
    await openClass('&evidence=learner-one&phase=phase-design');
    expect(q('learner-tasks')).not.toBeNull();
  };

  it('asks a question that does not promise the phase opens', async () => {
    await openDesign();
    await act(async () => must<HTMLButtonElement>('task-signoff-main').click());
    const question = must('task-lever-confirm-main').textContent ?? '';
    expect(question).not.toContain('opens once every required task has passed');
    expect(question).toContain('does not stand in for the review');
    expect(question).toContain('Ada');
  });

  it('shows the answer’s note, and the roster and the evidence panel say who is waiting on what', async () => {
    await openDesign();
    await act(async () => must<HTMLButtonElement>('task-signoff-main').click());
    await act(async () => {
      fireEvent.change(must<HTMLTextAreaElement>('task-lever-reason-main'), {
        target: { value: 'Read it with them in class; countersigned.' },
      });
    });
    await act(async () => must<HTMLButtonElement>('task-lever-do-main').click());
    await settle();

    expect(state.overrides).toEqual([{ action: 'task-signoff', reason: 'Read it with them in class; countersigned.', taskKey: 'main' }]);
    // Drawn, not only announced.
    expect(must('learner-tasks-note').textContent).toBe(NOTE);
    expect(must('learner-tasks-live').textContent).toContain(NOTE);
    // The evidence panel names the task the gate is waiting on.
    expect(must('evidence-needed-line').textContent).toContain('Waiting on a reviewed pass of The design');
    // And the roster's Design cell reads passed on the board, with the wait under it.
    expect(cell('Design')!.textContent).toContain('Credit awarded, review still needed');
    expect(cell('Design')!.textContent).toContain('Waiting on a reviewed pass');
  });

  it('says it for a phase-wide Pass on a phase with one task, where the task panel draws nothing', async () => {
    state.soleTask = true;
    await openClass('&evidence=learner-one&phase=phase-requirements');
    expect(q('learner-tasks')).toBeNull();
    expect(must('evidence-needed-line').textContent).toContain('Waiting on a reviewed pass of Requirements');
    expect(cell('Requirements')!.textContent).toContain('Waiting on a reviewed pass');
  });
});

/* ------------------------- the exports and View as ------------------------ */

describe('the console has a door to both CSV exports and to View as', () => {
  it('downloads the grades export from /teacher', async () => {
    await open();
    await act(async () => must<HTMLButtonElement>('export-csv').click());
    await settle();
    expect(state.calls.some((call) => call.path === '/instructor/export.csv')).toBe(true);
    expect(downloads).toEqual([{ name: 'learnsdlc-grades.csv' }]);
  });

  it('downloads the grade book from /teacher', async () => {
    await open();
    await act(async () => must<HTMLButtonElement>('export-gradebook').click());
    await settle();
    expect(state.calls.some((call) => call.path === '/instructor/gradebook.csv')).toBe(true);
    expect(downloads).toEqual([{ name: 'learnsdlc-gradebook.csv' }]);
  });

  it('says so when an export is refused, and downloads nothing', async () => {
    csvFetch.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ message: 'Too many exports. Try again in a minute.' }), { status: 429 }),
    );
    await open();
    await act(async () => must<HTMLButtonElement>('export-csv').click());
    await settle();
    expect(downloads).toEqual([]);
    expect(host.textContent).toContain('Too many exports. Try again in a minute.');
  });

  it('starts View as from the learner’s evidence, records it, and opens their dashboard', async () => {
    await open('?evidence=learner-one&phase=phase-design');
    const start = must<HTMLButtonElement>('view-as-start');
    expect(start.textContent).toContain('View as Ada');
    await act(async () => start.click());
    await settle();
    expect(state.views).toEqual(['/instructor/learners/learner-one/view']);
    expect(viewingAs()).toEqual({ userId: 'learner-one', displayName: 'Ada Example' });
    expect(rig.router.push).toHaveBeenCalledWith('/dashboard');
  });

  it('starts View as from a roster row, for a learner the teacher has not opened', async () => {
    await openClass();
    await act(async () => must<HTMLButtonElement>('view-as-learner-one').click());
    await settle();
    expect(state.views).toEqual(['/instructor/learners/learner-one/view']);
    expect(rig.router.push).toHaveBeenCalledWith('/dashboard');
  });
});

/* ============ no "Best 100" beside "Needs revision", for teachers ========== */

describe('a written task marked and not passed, in the teacher’s task list', () => {
  it('says there is no pass yet rather than a best score of the rules', async () => {
    await open('?evidence=learner-one&phase=phase-requirements');
    const control = must('learner-task-main').textContent ?? '';
    expect(control).toContain('Needs revision');
    expect(control).not.toMatch(/Best \d/);
    expect(control).toContain('No pass yet');
    // A passed task keeps its best.
    expect(must('learner-task-booking-story').textContent).toContain('Best 88');
  });
});

/* ========= phase-wide levers, hidden revisions, and the class panels ======= */

describe('a split phase waiting on a revision is not hidden by a newer one', () => {
  it('shows the task marked Needs revision, whatever another task handed in since', async () => {
    state.hiddenRevision = true;
    await openClass();
    expect(cell('Design')!.textContent).toContain('Needs revision');
  });

  it('answers the same rule directly: the newest Needs revision among the open required tasks', () => {
    state.hiddenRevision = true;
    expect(phaseCellRevision(phase(1))?.id).toBe('rev-story');
  });
});

describe('a signed-off quiz with no paper left: the wait says Reset, not submit', () => {
  it('names the quiz apart from the task the learner can still submit', async () => {
    state.spentQuiz = true;
    await open('?evidence=learner-one&phase=phase-design');
    const line = must('evidence-needed-line').textContent ?? '';
    expect(line).toContain('Waiting on a reviewed pass of The design and Design concepts');
    expect(line).toContain('so Ada still submits The design for one before they can move on');
    expect(line).toContain('Design concepts has no papers left, so Reset it to give Ada a fresh set of attempts.');
  });
});

describe('the phase-wide levers are on the console again', () => {
  const reasonText = 'Their sandbox was down all Tuesday afternoon.';
  const pull = async (lever: string) => {
    await act(async () => must<HTMLButtonElement>(`phase-lever-${lever}`).click());
    await act(async () => {
      fireEvent.change(must<HTMLTextAreaElement>('phase-lever-reason'), { target: { value: reasonText } });
    });
    await act(async () => must<HTMLButtonElement>('phase-lever-do').click());
    await settle();
  };

  it('draws Pass, Reopen, both resets and a regrade on a phase with one task, where the task panel draws nothing', async () => {
    state.soleTask = true;
    await open('?evidence=learner-one&phase=phase-requirements');
    expect(q('learner-tasks')).toBeNull();
    const levers = must('phase-levers');
    for (const word of ['Mark as passed', 'Reopen', 'Reset the workspace', 'Reset this phase', 'Regrade this phase'])
      expect(levers.textContent).toContain(word);
    // The route refuses a Pass on a passed phase, so the button says why it is off.
    expect(must<HTMLButtonElement>('phase-lever-pass').disabled).toBe(true);
    expect(levers.textContent).toContain('Requirements is already passed.');
  });

  it('reopens the phase with the reason, and no task key, and the roster reads it open', async () => {
    state.soleTask = true;
    await openClass('&evidence=learner-one&phase=phase-requirements');
    await act(async () => must<HTMLButtonElement>('phase-lever-reopen').click());
    expect(must('phase-lever-confirm').textContent).toContain(
      'Reopen Requirements for Ada? Its pass is withdrawn and they can edit and resubmit it.',
    );
    await act(async () => must<HTMLButtonElement>('phase-lever-cancel').click());
    await pull('reopen');
    expect(state.overrides).toEqual([{ action: 'reopen', reason: reasonText }]);
    expect(must('phase-levers-said').textContent).toBe('Requirements reopened. Ada can edit and resubmit it.');
    expect(cell('Requirements')!.textContent).not.toContain('Pass');
    // The wait line goes with the pass it was about.
    expect(q('evidence-needed-line')).toBeNull();
  });

  it('asks before a phase reset with everything it clears, then sends it', async () => {
    state.soleTask = true;
    await open('?evidence=learner-one&phase=phase-requirements');
    await act(async () => must<HTMLButtonElement>('phase-lever-reset-phase').click());
    const question = must('phase-lever-confirm').textContent ?? '';
    expect(question).toContain('It clears their files, links, incident write-up, merge message and verdict for this phase');
    expect(question).toContain('This cannot be undone.');
    await act(async () => must<HTMLButtonElement>('phase-lever-cancel').click());
    await pull('reset-phase');
    expect(state.overrides).toEqual([{ action: 'reset-phase', reason: reasonText }]);
  });

  it('says a Pass credits the board and does not stand in for the review', async () => {
    await open('?evidence=learner-one&phase=phase-design');
    await act(async () => must<HTMLButtonElement>('phase-lever-pass').click());
    const question = must('phase-lever-confirm').textContent ?? '';
    expect(question).toContain('Mark Design as passed for Ada?');
    expect(question).toContain('it does not stand in for the review');
  });

  it("regrades this learner's phase and reads the learner again", async () => {
    state.soleTask = true;
    await open('?evidence=learner-one&phase=phase-requirements');
    const before = state.learnerReads;
    await pull('regrade');
    expect(state.regrades).toEqual([
      { projectSlug: 'tasktrackr', phaseKey: 'requirements', scope: 'everyone', reason: reasonText, userId: 'learner-one' },
    ]);
    expect(must('phase-levers-said').textContent).toContain('Requirements was regraded on version 2.0.1');
    expect(state.learnerReads).toBeGreaterThan(before);
  });
});

describe("a class's dates and the class-wide regrade are on the console again", () => {
  it("draws both for the class's own project on the class page", async () => {
    window.history.replaceState(null, '', '/teacher/class?class=class-one');
    await act(async () => root.render(<TeacherClassPage />));
    await settle(12);
    expect(must('class-levers')).not.toBeNull();
    expect(must('schedule-panel')).not.toBeNull();
    expect(must('regrade-panel')).not.toBeNull();
    expect(state.calls.some((call) => call.path === '/instructor/cohorts/class-one/schedule?project=room-desk')).toBe(true);
  });

  // They are a class's, so the view across classes does not draw them;
  // the class page above holds the same panel with the same controls.
  it('are left off the view across classes, which keeps its own files', async () => {
    await open();
    // Vacuity: the home did draw, with its class list.
    expect(must('teacher-class-cards')).not.toBeNull();
    expect(q('class-levers')).toBeNull();
    expect(q('schedule-panel')).toBeNull();
    expect(q('regrade-panel')).toBeNull();
  });
});

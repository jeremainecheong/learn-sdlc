// @vitest-environment jsdom
/**
 * The teacher's class page.
 *
 * The real `TeacherPortal` with the real `lib/api-*` clients; only `fetch`
 * answers, from the table below, so every read and its query are what the API
 * would be asked. The router mock is one module-level object (a new object per
 * render would rerun the page's load effect on every render).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import type { CohortView, InstructorLearnerDetail, InstructorPhaseView, SignoffQueueView, SubmissionView } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import { CLASS_REFRESH_THROTTLE_MS, classFileLabel } from '@/components/staff/console/teacher-portal-model';
import { PRESENTATION_VIEW_KEY } from '@/components/experience/presentation-view';
import { STATE_LABEL, phaseCellState, teacherVerdict } from '@/components/staff/console/teacher-states';
import { taskStatusWord } from '@/components/staff/LearnerTasks';
import { SIGNOFF_QUEUE_EMPTY_BODY, SIGNOFF_QUEUE_EMPTY_IN_USE_BODY } from '@/components/staff/SignoffQueue';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() },
}));
vi.mock('next/navigation', async () => {
  const { useSyncExternalStore } = await import('react');
  const subscribe = (notify: () => void) => {
    window.addEventListener('popstate', notify);
    return () => window.removeEventListener('popstate', notify);
  };
  return {
    useSearchParams: () =>
      new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => '')),
    useRouter: () => mocks.router,
    usePathname: () => window.location.pathname,
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

const CLASSES: CohortView[] = [
  { id: 'class-one', name: 'Morning class', joinCode: 'AAAA1111', createdAt: '2026-09-01T00:00:00.000Z', memberCount: 2 },
  { id: 'class-two', name: 'Evening class', joinCode: 'BBBB2222', createdAt: '2026-09-02T00:00:00.000Z', memberCount: 1 },
];

const reviewed = (id: string, passed: boolean): SubmissionView =>
  ({
    id,
    status: 'completed',
    passed,
    verifiedPass: passed,
    createdAt: '2026-11-08T10:00:00.000Z',
    report: { overall: passed ? 90 : 40, passed },
  }) as unknown as SubmissionView;

const phase = (over: Partial<InstructorPhaseView>): InstructorPhaseView =>
  ({
    id: 'p',
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    status: 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    hints: 0,
    relianceIndex: 0,
    passThreshold: 70,
    unlockedAt: null,
    lastSubmission: null,
    tasks: [],
    ...over,
  }) as InstructorPhaseView;

/** Mutable answers, so a test can move the class between two reads. */
const state = {
  adaChecklist: 83,
  adaCredited: false,
  failOverview: false,
  queueRows: 1,
  overviewReads: 0,
  signed: 0,
  dropAda: false,
  /** Ada's Requirements pass waits on the teacher's sign-off (until a sign-off is posted). */
  adaAwaiting: false,
  /** Whether the class's version in force marks a task for sign-off; null: the class has none in force. */
  marked: null as boolean | null,
};

/** Ada's Requirements, a reviewed pass of its one task waiting on sign-off; passed and signed off once signed. */
function adaAwaitingRequirements(): Partial<InstructorPhaseView> {
  const signed = state.signed > 0;
  const submission = { ...reviewed('ada-1', true), taskKey: 'main' } as SubmissionView;
  return {
    id: 'ada-req',
    status: signed ? 'passed' : 'submitted',
    lastSubmission: submission,
    tasks: [
      {
        key: 'main',
        order: 1,
        required: true,
        title: 'Requirements brief',
        status: signed ? 'passed' : 'submitted',
        bestScore: 90,
        attempts: 1,
        passedAt: signed ? '2026-11-08T12:00:00.000Z' : null,
        awaitingSignOff: !signed,
        signedOffAt: signed ? '2026-11-08T12:00:00.000Z' : null,
        lastSubmission: submission,
      },
    ],
  };
}

function ada(): InstructorLearnerDetail {
  return {
    userId: 'ada',
    email: 'ada@school.test',
    displayName: 'Ada Lovelace',
    cohort: 'class-one',
    cohortName: 'Morning class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'e-ada',
        projectSlug: 'tasktrackr',
        projectTitle: 'TaskTrackr',
        currentPhaseOrder: 2,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: [
          phase(
            state.adaAwaiting
              ? adaAwaitingRequirements()
              : {
                  id: 'ada-req',
                  status: 'passed',
                  lastSubmission: reviewed('ada-1', !state.adaCredited),
                  evidenceNeeded: state.adaCredited ? [{ key: 'main', title: 'Requirements' } as never] : undefined,
                },
          ),
          phase({ id: 'ada-design', key: 'design', order: 2, title: 'Design' }),
        ],
      },
    ],
  } as unknown as InstructorLearnerDetail;
}
function bo(): InstructorLearnerDetail {
  return {
    userId: 'bo',
    email: 'bo@school.test',
    displayName: 'Bo Brummell',
    cohort: 'class-one',
    cohortName: 'Morning class',
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'e-bo',
        projectSlug: 'tasktrackr',
        projectTitle: 'TaskTrackr',
        currentPhaseOrder: 1,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases: [
          phase({ id: 'bo-req', lastSubmission: reviewed('bo-1', false) }),
          phase({ id: 'bo-design', key: 'design', order: 2, title: 'Design', status: 'locked' }),
        ],
      },
    ],
  } as unknown as InstructorLearnerDetail;
}

const queue = (cohortId: string): SignoffQueueView => ({
  cohortId,
  rows: state.queueRows
    ? [
        {
          userId: 'ada',
          learnerName: 'Ada Lovelace',
          phaseKey: 'requirements',
          taskKey: 'main',
          taskTitle: 'Requirements brief',
          awaitingSince: '2026-11-08T00:00:00.000Z',
        },
      ]
    : [],
});

let asked: string[] = [];
/**
 * Holds the next class read (`GET /instructor/learners?…`) until `release()`,
 * so a test can start a second read while the first is still in flight.
 */
const gate: { armed: boolean; release: (() => void) | null } = { armed: false, release: null };
function answer(method: string, path: string): { status: number; body: unknown; csv?: boolean } {
  if (path === '/instructor/cohorts') return { status: 200, body: CLASSES };
  if (path.startsWith('/instructor/overview')) {
    state.overviewReads++;
    if (state.failOverview) return { status: 503, body: { message: 'Unavailable.' } };
    return {
      status: 200,
      body: {
        learners: [
          { userId: 'ada', cohort: 'class-one', projectSlug: 'tasktrackr', checklistPercent: state.adaChecklist, masteryPercent: null },
          { userId: 'bo', cohort: 'class-one', projectSlug: 'tasktrackr', checklistPercent: 0, masteryPercent: null },
          { userId: 'cy', cohort: 'class-two', projectSlug: 'tasktrackr', checklistPercent: 0, masteryPercent: null },
        ],
      },
    };
  }
  if (path === '/instructor/learners/bo') return { status: 200, body: bo() };
  if (path === '/instructor/learners/ada') return { status: 200, body: ada() };
  if (path.startsWith('/instructor/learners')) return { status: 200, body: state.dropAda ? [bo()] : [ada(), bo()] };
  if (path.startsWith('/submissions/learner-history/'))
    return { status: 200, body: { items: [{ ...reviewed(`${path.split('/')[3]}-1`, false), attempt: 1 }], nextCursor: null } };
  if (path.startsWith('/instructor/audit')) return { status: 200, body: [] };
  if (method === 'POST' && /^\/instructor\/learners\/bo\/phases\/bo-req\/override$/.test(path))
    return { status: 200, body: { ...bo().enrollments[0].phases[0], status: 'passed', passedAt: '2026-11-09T00:00:00.000Z' } };
  if (method === 'POST' && path === '/instructor/regrades')
    return { status: 200, body: { id: 'batch-1', status: 'done', requested: 1, failed: 0, skipped: [], packVersionTo: '1.0.0' } };
  if (path === '/instructor/cohorts/class-one/signoff-queue') return { status: 200, body: queue('class-one') };
  if (method === 'POST' && path === '/instructor/cohorts/class-one/signoff') {
    state.signed++;
    state.queueRows = 0;
    state.adaChecklist = 100;
    return { status: 200, body: { signedOff: ['ada'], refused: [] } };
  }
  if (state.marked !== null && path === '/instructor/cohorts/class-one/project/assignable')
    return { status: 200, body: [{ projectId: 'p-1', versionId: 'v-1', version: '1.0.0', current: true }] };
  if (state.marked !== null && path === '/instructor/projects/p-1/versions/v-1')
    return {
      status: 200,
      body: { projectId: 'p-1', versionId: 'v-1', phases: [{ key: 'requirements', tasks: [{ taskKey: 'main', ...(state.marked ? { signOff: true } : {}) }] }] },
    };
  if (path.startsWith('/instructor/stuck')) return { status: 200, body: [] };
  if (/^\/submissions\/[^/]+\/teacher-feedback$/.test(path)) return { status: 200, body: [] };
  if (path.startsWith('/instructor/gradebook.csv') || path.startsWith('/instructor/export.csv'))
    return { status: 200, body: 'email\r\n', csv: true };
  return { status: 404, body: { message: 'Not found.' } };
}

let host: HTMLDivElement;
let root: Root;
const saved: string[] = [];
const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === text) ?? null;

async function open(url: string, classView = true) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView={classView} />));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    adaChecklist: 83,
    adaCredited: false,
    failOverview: false,
    queueRows: 1,
    overviewReads: 0,
    signed: 0,
    dropAda: false,
    adaAwaiting: false,
    marked: null,
  });
  asked = [];
  Object.assign(gate, { armed: false, release: null });
  saved.length = 0;
  try {
    window.localStorage.removeItem(PRESENTATION_VIEW_KEY);
  } catch {
    /* storage refused */
  }
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, '');
      asked.push(`${path}${url.search}`);
      if (gate.armed && path === '/instructor/learners') {
        gate.armed = false;
        await new Promise<void>((resolve) => (gate.release = resolve));
      }
      const { status, body, csv } = answer(init?.method ?? 'GET', path);
      return csv
        ? new Response(String(body), { status, headers: { 'content-type': 'text/csv' } })
        : new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (this.download) saved.push(this.download);
  });
  setAuthSession('s11-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  clearSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the class page stays current without a reload', () => {
  it('says when the records were read, beside a class-level Refresh', async () => {
    await open('/teacher/class?class=class-one');
    expect(byTestId('class-updated')?.textContent).toMatch(/^Updated \d{2}:\d{2}$/);
    expect(byTestId('class-refresh')?.textContent).toBe('Refresh');
  });

  it('a countersign from the queue moves the table and the counters with it', async () => {
    await open('/teacher/class?class=class-one&view=table');
    expect(byTestId('checklist-ada')?.textContent).toBe('83%');
    expect(byTestId('metric-signoff')?.querySelector('strong')?.textContent).toBe('1');
    // The one learner waiting starts chosen; there is no second "every learner" box.
    expect((byTestId('signoff-pick-requirements-main-ada') as HTMLInputElement).checked).toBe(true);
    await act(async () =>
      fireEvent.change(byTestId('signoff-reason-requirements-main')!, { target: { value: 'Read it with them in class.' } }),
    );
    await act(async () => fireEvent.click(byTestId('signoff-bulk-requirements-main')!));
    await act(async () => fireEvent.click(byTestId('signoff-confirm-yes')!));
    await settle();
    expect(state.signed).toBe(1);
    // No reload: the table and the counter read the class again after the countersign.
    expect(byTestId('checklist-ada')?.textContent).toBe('100%');
    expect(byTestId('metric-signoff')?.querySelector('strong')?.textContent).toBe('0');
  });

  it('returning to the tab reads the class again, at most once every 15 seconds', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await open('/teacher/class?class=class-one');
    const first = state.overviewReads;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(state.overviewReads).toBe(first);
    now += CLASS_REFRESH_THROTTLE_MS + 1000;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(state.overviewReads).toBe(first + 1);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(state.overviewReads).toBe(first + 1);
  });

  it('a failed refresh keeps the earlier read on screen and says so', async () => {
    await open('/teacher/class?class=class-one&view=table');
    state.failOverview = true;
    await act(async () => fireEvent.click(byTestId('class-refresh')!));
    await settle();
    expect(byTestId('class-stale')?.textContent).toMatch(/^Could not refresh at \d{2}:\d{2}\. Showing the earlier read\.$/);
    expect(byTestId('class-stale')?.getAttribute('role')).toBe('status');
    expect(byTestId('class-updated')?.textContent).toBe('');
    expect(byTestId('checklist-ada')?.textContent).toBe('83%');
    state.failOverview = false;
    await act(async () => fireEvent.click(byTestId('class-refresh')!));
    await settle();
    expect(byTestId('class-stale')).toBeNull();
  });
});

/** A learner's badge in the class table's "Latest submission" cell. */
const tableLatest = (name: string) =>
  [...host.querySelectorAll<HTMLTableRowElement>('table tbody tr')]
    .find((row) => row.querySelector('strong')?.textContent === name)
    ?.querySelector('.exp-cell-button .exp-status')?.textContent ?? null;
/** A learner's badge in the Latest submissions list. */
const listLatest = (name: string) => {
  const list = [...host.querySelectorAll('h2')].find((one) => one.textContent === 'Latest submissions')?.closest('section');
  return (
    [...(list?.querySelectorAll<HTMLButtonElement>('li button') ?? [])]
      .find((row) => row.querySelector('strong')?.textContent === name)
      ?.querySelector('.exp-status')?.textContent ?? null
  );
};

describe("the class page's words before and after a sign-off, mounted", () => {
  it('Latest submission reads "Awaiting your sign-off" while Ada waits, and "Review passed" once she is signed off', async () => {
    state.adaAwaiting = true;
    await open('/teacher/class?class=class-one&view=table');
    expect(tableLatest('Ada Lovelace')).toBe('Awaiting your sign-off');
    expect(listLatest('Ada Lovelace')).toBe('Awaiting your sign-off');
    await act(async () =>
      fireEvent.change(byTestId('signoff-reason-requirements-main')!, { target: { value: 'Read it with them in class.' } }),
    );
    await act(async () => fireEvent.click(byTestId('signoff-bulk-requirements-main')!));
    await act(async () => fireEvent.click(byTestId('signoff-confirm-yes')!));
    await settle();
    expect(state.signed).toBe(1);
    expect(tableLatest('Ada Lovelace')).toBe('Review passed');
    expect(listLatest('Ada Lovelace')).toBe('Review passed');
    // The queue that has just signed Ada off says nothing waits, not how to set sign-off up.
    expect(byTestId('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(byTestId('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  it('a fresh mount of a class whose records show a task signed off: the empty queue says nothing waits', async () => {
    Object.assign(state, { adaAwaiting: true, signed: 1, queueRows: 0 });
    await open('/teacher/class?class=class-one&tab=signoff');
    expect(byTestId('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(byTestId('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  // C-teacher-1: no learner has reached the marked task, so only the version can tell.
  it('nobody has reached a task the version in force marks: the empty queue says nothing waits', async () => {
    Object.assign(state, { queueRows: 0, marked: true });
    await open('/teacher/class?class=class-one&tab=signoff');
    expect(reads('/instructor/cohorts/class-one/project/assignable')).toBeGreaterThan(0);
    expect(reads('/instructor/projects/p-1/versions/v-1')).toBe(1);
    expect(byTestId('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
    expect(byTestId('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_BODY);
  });

  it('the version in force marks no task: the empty queue keeps the set-up hint', async () => {
    Object.assign(state, { queueRows: 0, marked: false });
    await open('/teacher/class?class=class-one&tab=signoff');
    expect(reads('/instructor/projects/p-1/versions/v-1')).toBe(1);
    expect(byTestId('signoff-empty')?.textContent).toContain(SIGNOFF_QUEUE_EMPTY_BODY);
    expect(byTestId('signoff-empty')?.textContent).not.toContain(SIGNOFF_QUEUE_EMPTY_IN_USE_BODY);
  });

  it('a learner waiting on the marked task: the batch is drawn and the version is not read', async () => {
    Object.assign(state, { marked: true });
    await open('/teacher/class?class=class-one&tab=signoff');
    expect(byTestId('signoff-task-requirements-main')).not.toBeNull();
    expect(byTestId('signoff-empty')).toBeNull();
    expect(reads('/instructor/projects/p-1/versions/v-1')).toBe(0);
  });
});

/** How many times the page asked for a path starting with this one. */
const reads = (prefix: string) => asked.filter((one) => one.startsWith(prefix)).length;
const classReads = () => reads('/instructor/learners?');
const evidenceHeading = () =>
  [...host.querySelectorAll('h2')].find((h) => h.textContent?.includes(' / '))?.textContent ?? null;

describe('a quiet read never strands the page or the evidence', () => {
  it('a tab return that overtakes the first full read leaves Refresh and the evidence usable (blocker 1)', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    gate.armed = true;
    window.history.replaceState(null, '', '/teacher/class?class=class-one');
    await act(async () => root.render(<TeacherPortal classView />));
    await settle();
    // The mount's full read is held at its class read; the page is loading.
    expect(gate.release).not.toBeNull();
    expect(byTestId('class-refresh')?.hasAttribute('disabled')).toBe(true);
    // A quiet refresh starts while it is in flight, and answers first.
    now += CLASS_REFRESH_THROTTLE_MS + 1000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    await act(async () => gate.release!());
    await settle();
    expect(byTestId('class-refresh')?.hasAttribute('disabled')).toBe(false);
    expect(button('Refresh records')?.hasAttribute('disabled')).toBe(false);
    // A cell opens its evidence.
    await act(async () => fireEvent.click(host.querySelector('[aria-label="Inspect Bo Brummell, Requirements"]')!));
    // The page writes the address with pushState; the harness's search params follow popstate.
    expect(window.location.search).toContain('evidence=bo');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    await settle();
    expect(evidenceHeading()).toBe('Bo Brummell / Requirements');
    // And Refresh reads the class again.
    const before = classReads();
    await act(async () => fireEvent.click(byTestId('class-refresh')!));
    await settle();
    expect(classReads()).toBe(before + 1);
  });

  it('a countersign during Refresh records leaves the page usable, and the evidence the address asks for opens (blocker 1)', async () => {
    await open('/teacher/class?class=class-one&view=table');
    gate.armed = true;
    await act(async () => fireEvent.click(button('Refresh records')!));
    await settle();
    expect(gate.release).not.toBeNull();
    expect(byTestId('class-refresh')?.hasAttribute('disabled')).toBe(true);
    // The countersign's quiet refresh overtakes the full read.
    // The one learner waiting starts chosen; there is no second "every learner" box.
    expect((byTestId('signoff-pick-requirements-main-ada') as HTMLInputElement).checked).toBe(true);
    await act(async () =>
      fireEvent.change(byTestId('signoff-reason-requirements-main')!, { target: { value: 'Read it with them in class.' } }),
    );
    await act(async () => fireEvent.click(byTestId('signoff-bulk-requirements-main')!));
    await act(async () => fireEvent.click(byTestId('signoff-confirm-yes')!));
    await settle();
    await act(async () => gate.release!());
    await settle();
    expect(state.signed).toBe(1);
    expect(byTestId('checklist-ada')?.textContent).toBe('100%');
    expect(byTestId('class-refresh')?.hasAttribute('disabled')).toBe(false);
    expect(button('Refresh records')?.hasAttribute('disabled')).toBe(false);
    // The evidence the address names opens on the read that answered.
    await act(async () => {
      window.history.pushState(null, '', '/teacher/class?class=class-one&view=table&evidence=bo&phase=bo-req');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await settle();
    expect(evidenceHeading()).toBe('Bo Brummell / Requirements');
  });

  it('the evidence asked for at mount opens even when a quiet read overtakes the mount read', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    gate.armed = true;
    window.history.replaceState(null, '', '/teacher/class?class=class-one&evidence=bo&phase=bo-req');
    await act(async () => root.render(<TeacherPortal classView />));
    await settle();
    now += CLASS_REFRESH_THROTTLE_MS + 1000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    await act(async () => gate.release!());
    await settle();
    expect(evidenceHeading()).toBe('Bo Brummell / Requirements');
    expect(reads('/submissions/learner-history/bo')).toBe(1);
  });

  it('an open evidence panel keeps its place, history and focus across a quiet read, with the learner as they now stand (blocker 2a)', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await open('/teacher/class?class=class-one&evidence=ada&phase=ada-req');
    expect(evidenceHeading()).toBe('Ada Lovelace / Requirements');
    expect(byTestId('evidence-needed-line')).toBeNull();
    const history = [...host.querySelectorAll<HTMLSelectElement>('select')].find((one) =>
      one.closest('label')?.textContent?.startsWith('Submission history'),
    )!;
    expect(history).toBeDefined();
    history.focus();
    const historyReads = reads('/submissions/learner-history/');
    const firstClassReads = classReads();
    // The teacher credited the phase elsewhere; the tab return reads the class quietly.
    state.adaCredited = true;
    now += CLASS_REFRESH_THROTTLE_MS + 1000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(classReads()).toBe(firstClassReads + 1);
    // Same panel, same history element and focus, no second history read...
    expect(evidenceHeading()).toBe('Ada Lovelace / Requirements');
    expect(document.activeElement).toBe(history);
    expect(history.isConnected).toBe(true);
    expect(reads('/submissions/learner-history/')).toBe(historyReads);
    // ...and the panel shows the learner as the quiet read found them.
    expect(byTestId('evidence-needed-line')).not.toBeNull();
  });

  it('a quiet read that no longer holds the open learner says so instead of closing silently', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await open('/teacher/class?class=class-one&evidence=ada&phase=ada-req');
    expect(evidenceHeading()).toBe('Ada Lovelace / Requirements');
    state.dropAda = true;
    now += CLASS_REFRESH_THROTTLE_MS + 1000;
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(evidenceHeading()).toBeNull();
    expect(host.textContent).toContain('This learner or phase is not in this class view.');
  });

  it('a lever re-reads the overview rows, the sign-off queue and the help requests, not the class (blocker 2b)', async () => {
    await open('/teacher/class?class=class-one&view=table&evidence=bo&phase=bo-req');
    expect(evidenceHeading()).toBe('Bo Brummell / Requirements');
    const overview = reads('/instructor/overview');
    const queue = reads('/instructor/cohorts/class-one/signoff-queue');
    const help = reads('/instructor/stuck');
    const learners = classReads();
    state.adaChecklist = 50;
    await act(async () => fireEvent.click(byTestId('phase-lever-pass')!));
    await act(async () => fireEvent.change(byTestId('phase-lever-reason')!, { target: { value: 'Seen in class, it meets the brief.' } }));
    await act(async () => fireEvent.click(byTestId('phase-lever-do')!));
    await settle();
    expect(asked).toContain('/instructor/learners/bo/phases/bo-req/override');
    expect(reads('/instructor/overview')).toBe(overview + 1);
    expect(reads('/instructor/cohorts/class-one/signoff-queue')).toBe(queue + 1);
    expect(reads('/instructor/stuck')).toBe(help + 1);
    expect(classReads()).toBe(learners);
    // The overview's new row is on the table.
    expect(byTestId('checklist-ada')?.textContent).toBe('50%');
  });

  it('a regrade re-reads the learner, then the overview rows, the sign-off queue and the help requests (blocker 2b)', async () => {
    await open('/teacher/class?class=class-one&view=table&evidence=ada&phase=ada-req');
    expect(evidenceHeading()).toBe('Ada Lovelace / Requirements');
    const overview = reads('/instructor/overview');
    const queue = reads('/instructor/cohorts/class-one/signoff-queue');
    const help = reads('/instructor/stuck');
    const learners = classReads();
    await act(async () => fireEvent.click(byTestId('phase-lever-regrade')!));
    await act(async () => fireEvent.change(byTestId('phase-lever-reason')!, { target: { value: 'The runner was down for this one.' } }));
    await act(async () => fireEvent.click(byTestId('phase-lever-do')!));
    await settle();
    expect(asked).toContain('/instructor/regrades');
    expect(reads('/instructor/learners/ada')).toBe(1);
    expect(reads('/instructor/overview')).toBe(overview + 1);
    expect(reads('/instructor/cohorts/class-one/signoff-queue')).toBe(queue + 1);
    expect(reads('/instructor/stuck')).toBe(help + 1);
    expect(classReads()).toBe(learners);
  });
});

describe('the class page leads with this class', () => {
  it("puts this class's numbers and the phase map ahead of the submissions, help and queue", async () => {
    await open('/teacher/class?class=class-one');
    const order = [
      byTestId('teacher-metrics'),
      [...host.querySelectorAll('h2')].find((h) => h.textContent === 'Learner phase map'),
      [...host.querySelectorAll('h2')].find((h) => h.textContent === 'Latest submissions'),
      byTestId('stuck-list'),
      byTestId('signoff-queue'),
    ];
    for (const node of order) expect(node).not.toBeNull();
    for (let i = 1; i < order.length; i++)
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('labels every number with its scope and drops the account-wide count', async () => {
    await open('/teacher/class?class=class-one');
    const cards = [...byTestId('teacher-metrics')!.querySelectorAll('section')];
    expect(cards.map((card) => card.querySelector('span')?.textContent)).toEqual([
      'Enrolled learners',
      'Awaiting your sign-off',
      'Needs revision',
      'Latest submissions',
    ]);
    expect(cards.every((card) => card.getAttribute('data-scope') === 'class')).toBe(true);
    expect(byTestId('metric-revision')?.querySelector('strong')?.textContent).toBe('1');
    expect(byTestId('metric-acknowledge')?.querySelector('small')?.textContent).toBe('To acknowledge, this class');
    expect(host.textContent).not.toContain('Awaiting review');
    expect(host.textContent).not.toContain('Across your classes');
  });

  it('the home says its numbers are every class of yours', async () => {
    await open('/teacher', false);
    const cards = [...byTestId('teacher-metrics')!.querySelectorAll('section')];
    expect(cards[0].querySelector('span')?.textContent).toBe('Classes');
    expect(cards.every((card) => card.getAttribute('data-scope') === 'all')).toBe(true);
    expect(button('Create class')).not.toBeNull();
  });

  it('moves Create class off the class page into the menu', async () => {
    await open('/teacher/class?class=class-one');
    expect(button('Create class')).toBeNull();
    await act(async () => fireEvent.click(byTestId('create-class-menu')!));
    expect(host.querySelector('form.exp-form')).not.toBeNull();
  });

  it('collapses the help requests to one row when none are open', async () => {
    await open('/teacher/class?class=class-one');
    const help = byTestId('stuck-list')!;
    expect(help.classList.contains('teacher-help-empty')).toBe(true);
    expect(byTestId('stuck-empty')?.textContent).toBe('No open help requests');
    expect(help.textContent).not.toContain('A learner is asking you');
  });
});

describe('the console names each state in one vocabulary', () => {
  it('the table and the latest submissions say Review passed; the queue says Awaiting your sign-off', async () => {
    await open('/teacher/class?class=class-one&view=table');
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('Ada Lovelace'))!;
    expect(row.textContent).toContain(STATE_LABEL.reviewPassed);
    expect(byTestId('signoff-queue')?.querySelector('h2')?.textContent).toBe('Awaiting your sign-off');
  });

  it('a credited phase on the map reads as credit, never as a pass', async () => {
    state.adaCredited = true;
    await open('/teacher/class?class=class-one');
    const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('Ada Lovelace'))!;
    expect(row.textContent).toContain(STATE_LABEL.credited);
    expect(row.textContent).not.toContain(STATE_LABEL.reviewPassed);
  });

  it('maps each state to its label', () => {
    expect(phaseCellState(phase({ status: 'passed' }), undefined)).toEqual({ label: 'Review passed', tone: 'pass' });
    expect(phaseCellState(phase({ status: 'passed', evidenceNeeded: [{ key: 'main', title: 'R' } as never] }), undefined).label).toBe(
      'Credit awarded, review still needed',
    );
    expect(
      phaseCellState(phase({ tasks: [{ key: 'a', awaitingSignOff: true } as never] }), undefined).label,
    ).toBe('Awaiting your sign-off');
    expect(phaseCellState(phase({}), reviewed('x', false))).toEqual({ label: 'Needs revision', tone: 'revision' });
    expect(phaseCellState(phase({}), undefined)).toEqual({ label: 'In progress', tone: 'open' });
    expect(teacherVerdict(reviewed('y', true)).label).toBe('Review passed');
    const task = {
      key: 'story', order: 1, required: true, title: 'Story', status: 'passed', bestScore: 70, attempts: 0,
      passedAt: null, awaitingSignOff: false, signedOffAt: '2026-11-08T00:00:00.000Z', lastSubmission: null,
    } as never;
    expect(taskStatusWord(task)).toBe('Credit awarded, review still needed');
    expect(taskStatusWord({ ...(task as object), signedOffAt: null, lastSubmission: reviewed('z', true) } as never)).toBe('Review passed');
    expect(taskStatusWord({ ...(task as object), status: 'submitted', awaitingSignOff: true } as never)).toBe('Awaiting your sign-off');
  });
});

describe('export scope and presentation view', () => {
  it("the class page offers this class's grade book and every class's, each saying what it holds", async () => {
    await open('/teacher/class?class=class-one');
    expect(byTestId('export-class-gradebook')?.textContent).toBe('Download this class’s grade book');
    expect(byTestId('export-class-scope')?.textContent).toBe('2 learners in this class');
    expect(byTestId('export-gradebook')?.textContent).toBe('Download the grade book (all your classes)');
    expect(byTestId('export-all-scope')?.textContent).toBe('3 learners across 2 classes');
    expect(byTestId('export-csv')?.textContent).toBe('Download the grades (all your classes)');
  });

  it("this class's grade book asks the API for this class only, and names the file for it", async () => {
    await open('/teacher/class?class=class-one');
    await act(async () => fireEvent.click(byTestId('export-class-gradebook')!));
    await settle();
    expect(asked).toContain('/instructor/gradebook.csv?cohort=class-one');
    expect(saved).toEqual(['learnsdlc-gradebook-class-morning-class.csv']);
    await act(async () => fireEvent.click(byTestId('export-gradebook')!));
    await settle();
    expect(asked).toContain('/instructor/gradebook.csv');
    expect(saved.at(-1)).toBe('learnsdlc-gradebook.csv');
    expect(classFileLabel('¡¡', 'abc12345-xyz')).toBe('-class-abc12345');
  });

  it('the home offers only the all-classes files', async () => {
    await open('/teacher', false);
    expect(byTestId('export-class-gradebook')).toBeNull();
    expect(byTestId('export-gradebook')?.textContent).toBe('Download the grade book (all your classes)');
  });

  it('presentation view hides email addresses, keeps names, says it is on, and is remembered', async () => {
    await open('/teacher/class?class=class-one&view=table');
    expect(host.textContent).toContain('ada@school.test');
    const toggle = byTestId('presentation-view-toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await act(async () => fireEvent.click(toggle));
    expect(host.textContent).not.toContain('ada@school.test');
    expect(host.textContent).not.toContain('bo@school.test');
    expect(host.textContent).toContain('Ada Lovelace');
    expect(byTestId('presentation-view-on')).not.toBeNull();
    expect(byTestId('presentation-view-toggle')?.textContent).toBe('Presentation view on');
    expect(window.localStorage.getItem(PRESENTATION_VIEW_KEY)).toBe('on');
    // The join code stays masked.
    expect(host.textContent).not.toContain('AAAA1111');
    // Remembered in this browser: a new visit opens with it on.
    act(() => root.unmount());
    root = createRoot(host);
    await open('/teacher/class?class=class-one&view=table');
    expect(host.textContent).not.toContain('ada@school.test');
    await act(async () => fireEvent.click(byTestId('presentation-view-toggle')!));
    expect(host.textContent).toContain('ada@school.test');
  });

  // Part of an address typed into the search must not confirm
  // it on a shared screen, so with the view on the search reads names only.
  const listed = () => [...host.querySelectorAll('table tbody tr strong')].map((one) => one.textContent);

  it('with presentation view off the class search matches a name or an address', async () => {
    await open('/teacher/class?class=class-one&view=table&search=bo%40school');
    expect(listed()).toEqual(['Bo Brummell']);
    await open('/teacher/class?class=class-one&view=table&search=school.test');
    expect(listed()).toEqual(expect.arrayContaining(['Ada Lovelace', 'Bo Brummell']));
    await open('/teacher/class?class=class-one&view=table&search=lovelace');
    expect(listed()).toEqual(['Ada Lovelace']);
  });

  it('with presentation view on the class search matches names only', async () => {
    window.localStorage.setItem(PRESENTATION_VIEW_KEY, 'on');
    await open('/teacher/class?class=class-one&view=table&search=bo%40school');
    expect(listed()).toEqual([]);
    await open('/teacher/class?class=class-one&view=table&search=school.test');
    expect(listed()).toEqual([]);
    await open('/teacher/class?class=class-one&view=table&search=lovelace');
    expect(listed()).toEqual(['Ada Lovelace']);
    expect(host.textContent).not.toContain('ada@school.test');
    // Turned off, the same address matches again.
    await open('/teacher/class?class=class-one&view=table&search=bo%40school');
    await act(async () => fireEvent.click(byTestId('presentation-view-toggle')!));
    expect(listed()).toEqual(['Bo Brummell']);
  });
});

describe('the record of changes names a Pass as credit', () => {
  it('says a phase-wide Pass awarded credit', async () => {
    const { describeAudit } = await import('@/components/staff/AuditList');
    expect(
      describeAudit({ event: 'phase.override', action: 'pass', detail: { phaseKey: 'requirements' } } as never).title,
    ).toBe('Marked Requirements as passed: credit awarded');
  });
});

describe('the class page\'s structure the stylesheet and the board reader rely on', () => {
  it('the table names each learner in the strong of a line of its own, inside the identity cell', async () => {
    await open('/teacher/class?class=class-one&view=table');
    const names = [...host.querySelectorAll('table tbody tr .exp-learner-identity > div > strong')].map((one) => one.textContent);
    expect(names).toContain('Ada Lovelace');
  });

  it('the export buttons sit in the row the stylesheet lines up by their tops', async () => {
    await open('/teacher/class?class=class-one');
    expect([...byTestId('teacher-exports')!.classList]).toEqual(expect.arrayContaining(['exp-actions', 'exp-exports']));
  });
});

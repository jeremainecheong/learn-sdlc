// @vitest-environment jsdom
/**
 * The teacher's class page as one row of tabs, and My classes as a short
 * page.
 *
 * The real `TeacherPortal` with the real `lib/api-*` clients and the real
 * staff panels; only `fetch` answers, from the table below. The router mock is
 * one module-level object (a new object per render would rerun the page's
 * load effect on every render). `history.replaceState` and `pushState` are
 * wrapped the way Next's app router behaves: the address changes and the
 * page's `useSearchParams` follows it.
 *
 * The last block is a guard: every `data-testid` the two pages drew before
 * the class page became one row of tabs is still drawn by one of them. Its
 * list was recorded by rendering the earlier pages with this file's fixture,
 * not written by hand.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';
import { closureText } from './support/source-text';
import type { CohortView, InstructorLearnerDetail, InstructorPhaseView, SubmissionView } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';

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
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

/* --------------------------------- fixture -------------------------------- */

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

const task = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  order: 1,
  required: true,
  title: key,
  status: 'in_progress',
  bestScore: null,
  attempts: 1,
  passedAt: null,
  awaitingSignOff: false,
  signedOffAt: null,
  lastSubmission: null,
  ...over,
});

const learner = (
  userId: string,
  displayName: string,
  cohort: string | null,
  phases: InstructorPhaseView[],
): InstructorLearnerDetail =>
  ({
    userId,
    email: `${userId}@school.test`,
    displayName,
    cohort,
    cohortName: CLASSES.find((one) => one.id === cohort)?.name ?? null,
    createdAt: '2026-09-01T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: `e-${userId}`,
        projectSlug: 'tasktrackr',
        projectTitle: 'TaskTrackr',
        currentPhaseOrder: 1,
        completed: false,
        startedAt: '2026-09-01T00:00:00.000Z',
        completedAt: null,
        phases,
      },
    ],
  }) as unknown as InstructorLearnerDetail;

/** Ada waits on one sign-off (her Requirements task); Bo and Cy wait on none. */
const ada = () =>
  learner('ada', 'Ada Lovelace', 'class-one', [
    phase({
      id: 'ada-req',
      status: 'in_progress',
      lastSubmission: reviewed('ada-1', true),
      tasks: [
        task('main', { awaitingSignOff: true, lastSubmission: reviewed('ada-1', true) }),
        // Passed: never counted, even with the flag left on.
        task('extra', { order: 2, status: 'passed', awaitingSignOff: true }),
      ] as never,
    }),
    phase({ id: 'ada-design', key: 'design', order: 2, title: 'Design', status: 'locked' }),
  ]);
const bo = () =>
  learner('bo', 'Bo Brummell', 'class-one', [
    phase({ id: 'bo-req', lastSubmission: reviewed('bo-1', false) }),
    phase({ id: 'bo-design', key: 'design', order: 2, title: 'Design', status: 'locked' }),
  ]);
const cy = () =>
  learner('cy', 'Cy Twombly', 'class-two', [
    phase({ id: 'cy-req' }),
    phase({ id: 'cy-design', key: 'design', order: 2, title: 'Design', status: 'locked' }),
  ]);
/** In no class of this teacher's: an admin's wider view. */
const zed = () => learner('zed', 'Zed Outside', null, [phase({ id: 'zed-req' })]);

const state = { queueRows: 1, withZed: false };

let asked: string[] = [];
function answer(method: string, path: string, search: URLSearchParams): { status: number; body: unknown } {
  if (path === '/instructor/cohorts') return { status: 200, body: CLASSES };
  if (path.startsWith('/instructor/overview')) {
    const row = (one: InstructorLearnerDetail) => ({
      userId: one.userId,
      cohort: one.cohort,
      projectSlug: 'tasktrackr',
      checklistPercent: 50,
      masteryPercent: null,
    });
    return { status: 200, body: { learners: [ada(), bo(), cy(), ...(state.withZed ? [zed()] : [])].map(row) } };
  }
  if (path === '/instructor/learners') {
    const every = [ada(), bo(), cy(), ...(state.withZed ? [zed()] : [])];
    const cohort = search.get('cohort');
    return { status: 200, body: cohort ? every.filter((one) => one.cohort === cohort) : every };
  }
  if (path === '/instructor/learners/ada') return { status: 200, body: ada() };
  if (path.startsWith('/submissions/learner-history/'))
    return { status: 200, body: { items: [{ ...reviewed('ada-1', true), attempt: 1 }], nextCursor: null } };
  if (path.startsWith('/instructor/audit')) return { status: 200, body: [] };
  if (/^\/instructor\/cohorts\/[^/]+\/signoff-queue$/.test(path))
    return {
      status: 200,
      body: {
        cohortId: path.split('/')[3],
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
      },
    };
  if (/^\/instructor\/cohorts\/[^/]+\/project$/.test(path))
    return { status: 200, body: { cohortId: path.split('/')[3], active: null, history: [] } };
  if (/^\/instructor\/cohorts\/[^/]+\/project\/assignable$/.test(path)) return { status: 200, body: [] };
  if (/^\/instructor\/cohorts\/[^/]+\/schedule$/.test(path))
    return { status: 200, body: { cohortId: path.split('/')[3], projectSlug: 'tasktrackr', timezone: 'UTC', phases: [] } };
  if (path.startsWith('/instructor/notes')) return { status: 200, body: [] };
  if (path.startsWith('/instructor/stuck')) return { status: 200, body: [] };
  if (/^\/submissions\/[^/]+\/teacher-feedback$/.test(path)) return { status: 200, body: [] };
  void method;
  return { status: 404, body: { message: 'Not found.' } };
}

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
let replaced: string[] = [];
let pushed: string[] = [];
const settle = async (rounds = 14) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const must = (id: string) => {
  const found = byTestId(id);
  if (!found) throw new Error(`no element with test id ${id}`);
  return found;
};
const section = (key: string) => host.querySelector<HTMLElement>(`[data-class-section="${key}"]`);
const sectionOf = (element: Element | null) => element?.closest<HTMLElement>('[data-class-section]')?.dataset.classSection;
const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Class sections"] [role="tab"]')];
const shownSections = () =>
  [...host.querySelectorAll<HTMLElement>('[data-class-section]')].filter((one) => !one.hidden).map((one) => one.dataset.classSection);
const board = () => host.querySelector('[aria-label="Learner phase map and roster"]');
const params = () => new URLSearchParams(window.location.search);
const testIds = () => new Set([...host.querySelectorAll('[data-testid]')].map((one) => one.getAttribute('data-testid')!));

async function open(url: string, classView = url.startsWith('/teacher/class')) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView={classView} />));
  await settle();
  replaced = [];
  pushed = [];
}
async function press(element: HTMLElement) {
  element.focus();
  await act(async () => element.click());
  await settle(4);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { queueRows: 1, withZed: false });
  asked = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const replace = window.history.replaceState.bind(window.history);
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    replace(...args);
    replaced.push(String(args[2]));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    push(...args);
    pushed.push(String(args[2]));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/v1/, '');
      asked.push(`${path}${url.search}`);
      const { status, body } = answer(init?.method ?? 'GET', path, url.searchParams);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  setAuthSession('s20-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
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

/* ----------------------------- the tab row -------------------------------- */

describe('the class page is one row of tabs, one section in view', () => {
  it('names five tabs in order, with the test ids scripts use, and opens on Overview', async () => {
    await open('/teacher/class?class=class-one');
    expect(tabs().map((tab) => tab.dataset.testid)).toEqual([
      'class-tab-overview',
      'class-tab-signoff',
      'class-tab-project',
      'class-tab-dates',
      'class-tab-invite',
    ]);
    expect(tabs().map((tab) => tab.textContent)).toEqual([
      'Overview',
      'Sign-off, 1 waiting',
      'Project',
      'Dates and regrades',
      'Invite and notes',
    ]);
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    // One tab stop for the row.
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect([...host.querySelectorAll('[data-class-section]')].map((one) => (one as HTMLElement).dataset.classSection)).toEqual([
      'overview',
      'signoff',
      'project',
      'dates',
      'invite',
    ]);
    expect(shownSections()).toEqual(['overview']);
    // The panel names the open tab, and every tab points at it.
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    expect(tabs().every((tab) => tab.getAttribute('aria-controls') === panel.id)).toBe(true);
    // The default is never written into the address.
    expect(params().has('tab')).toBe(false);
  });

  it('the Sign-off tab carries the waiting count in its name, and none when nobody waits', async () => {
    await open('/teacher/class?class=class-one');
    expect(must('class-tab-signoff').textContent).toBe('Sign-off, 1 waiting');
    // The comma is for the ear; the eye reads a count beside the word.
    expect(must('class-tab-signoff-count').textContent).toBe('1 waiting');
    act(() => root.unmount());
    root = createRoot(host);
    state.queueRows = 0;
    await open('/teacher/class?class=class-one');
    expect(must('class-tab-signoff').textContent).toBe('Sign-off');
    expect(byTestId('class-tab-signoff-count')).toBeNull();
  });

  it('a press shows its section, keeps focus on the tab, and replaces the address', async () => {
    await open('/teacher/class?class=class-one');
    const dates = must('class-tab-dates');
    await press(dates);
    expect(shownSections()).toEqual(['dates']);
    expect(dates.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(dates);
    expect(params().get('tab')).toBe('dates');
    expect(params().get('class')).toBe('class-one');
    // Replaced, not pushed: Back leaves the page rather than walking the tabs.
    expect(replaced.at(-1)).toBe('/teacher/class?class=class-one&tab=dates');
    expect(pushed).toEqual([]);
    await press(must('class-tab-overview'));
    expect(shownSections()).toEqual(['overview']);
    expect(params().has('tab')).toBe(false);
    expect(pushed).toEqual([]);
  });

  it('keeps ?view=table beside ?tab= when a tab is pressed', async () => {
    await open('/teacher/class?class=class-one&view=table');
    await press(must('class-tab-invite'));
    expect(window.location.search).toBe('?class=class-one&view=table&tab=invite');
  });

  it('the arrow keys move along the row and take focus with them', async () => {
    await open('/teacher/class?class=class-one');
    const overview = must('class-tab-overview');
    overview.focus();
    await act(async () => fireEvent.keyDown(overview, { key: 'ArrowRight' }));
    await settle(2);
    expect(shownSections()).toEqual(['signoff']);
    expect(document.activeElement).toBe(must('class-tab-signoff'));
    await act(async () => fireEvent.keyDown(document.activeElement!, { key: 'End' }));
    await settle(2);
    expect(shownSections()).toEqual(['invite']);
    expect(document.activeElement).toBe(must('class-tab-invite'));
  });

  it('a link or a reload lands on the tab its address names; an unknown one lands on Overview', async () => {
    await open('/teacher/class?class=class-one&tab=project');
    expect(shownSections()).toEqual(['project']);
    expect(must('class-tab-project').getAttribute('aria-selected')).toBe('true');
    act(() => root.unmount());
    root = createRoot(host);
    await open('/teacher/class?class=class-one&tab=nonsense');
    expect(shownSections()).toEqual(['overview']);
  });

  it('Back and Forward follow the address', async () => {
    await open('/teacher/class?class=class-one&tab=dates');
    // As the browser does on Back to an entry that named another tab.
    await act(async () => {
      window.history.replaceState(null, '', '/teacher/class?class=class-one&tab=invite');
    });
    await settle(2);
    expect(shownSections()).toEqual(['invite']);
    await act(async () => {
      window.history.replaceState(null, '', '/teacher/class?class=class-one');
    });
    await settle(2);
    expect(shownSections()).toEqual(['overview']);
  });

  it("the board's own addresses open on Overview with the map, or the table", async () => {
    await open('/teacher/class?class=class-one');
    expect(sectionOf(board())).toBe('overview');
    expect(shownSections()).toEqual(['overview']);
    expect([...board()!.querySelectorAll('thead th')].map((th) => th.textContent)).toContain('Requirements');
    act(() => root.unmount());
    root = createRoot(host);
    await open('/teacher/class?class=class-one&view=table');
    expect(shownSections()).toEqual(['overview']);
    expect([...board()!.querySelectorAll('thead th')].map((th) => th.textContent)).toContain('Phases passed');
  });
});

/* ------------------------- the ways to the queue -------------------------- */

describe('every way to the sign-off queue opens the Sign-off tab', () => {
  /** Focus moves only once the queue's section is shown (a hidden heading cannot take it). */
  const watchFocus = () => {
    const seen: Array<{ heading: boolean; hidden: boolean | undefined }> = [];
    const focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.closest('#signoff-queue') && this.tagName === 'H2')
        seen.push({ heading: true, hidden: this.closest<HTMLElement>('[data-class-section]')?.hidden });
      return focus.call(this, options);
    });
    return seen;
  };
  const heading = () => host.querySelector<HTMLElement>('#signoff-queue h2');

  it('arriving with #signoff-queue opens the tab, keeps it in the address and focuses the queue', async () => {
    const seen = watchFocus();
    await open('/teacher/class?class=class-one#signoff-queue');
    expect(shownSections()).toEqual(['signoff']);
    expect(document.activeElement).toBe(heading());
    expect(seen).toEqual([{ heading: true, hidden: false }]);
    expect(window.location.hash).toBe('');
    expect(params().get('tab')).toBe('signoff');
  });

  it("the header's Sign-off queue opens the tab and focuses the queue, leaving no hash", async () => {
    await open('/teacher/class?class=class-one');
    const seen = watchFocus();
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a[href="#signoff-queue"]')].find(
      (one) => one.textContent?.trim() === 'Sign-off queue',
    )!;
    expect(link.className).toContain('exp-button');
    await act(async () => link.click());
    await settle(2);
    expect(shownSections()).toEqual(['signoff']);
    expect(document.activeElement).toBe(heading());
    expect(seen).toEqual([{ heading: true, hidden: false }]);
    expect(window.location.hash).toBe('');
    expect(params().get('tab')).toBe('signoff');
    expect(pushed).toEqual([]);
  });

  it("the tile's Open the sign-off queue does the same", async () => {
    await open('/teacher/class?class=class-one&tab=project');
    const seen = watchFocus();
    const link = must('metric-signoff').querySelector<HTMLAnchorElement>('a[href="#signoff-queue"]')!;
    expect(link.textContent).toBe('Open the sign-off queue');
    await act(async () => link.click());
    await settle(2);
    expect(shownSections()).toEqual(['signoff']);
    expect(document.activeElement).toBe(heading());
    expect(seen).toEqual([{ heading: true, hidden: false }]);
    expect(window.location.hash).toBe('');
  });

  it('a #signoff-queue that arrives while the page is open opens the tab too', async () => {
    await open('/teacher/class?class=class-one');
    await act(async () => {
      window.history.replaceState(null, '', '/teacher/class?class=class-one#signoff-queue');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await settle(2);
    expect(shownSections()).toEqual(['signoff']);
    expect(document.activeElement).toBe(heading());
    expect(window.location.hash).toBe('');
  });

  it("the home's link beside each class is the address that lands there", async () => {
    await open('/teacher');
    expect(
      [...host.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Sign-off queue for"]')].map((one) => one.getAttribute('href')),
    ).toEqual(['/teacher/class?class=class-one#signoff-queue', '/teacher/class?class=class-two#signoff-queue']);
  });

  it('opening a learner’s evidence from Overview keeps Overview, and the evidence is under it', async () => {
    await open('/teacher/class?class=class-one');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Inspect Bo Brummell, Requirements"]')!.click(),
    );
    await settle();
    expect(params().get('evidence')).toBe('bo');
    expect(shownSections()).toEqual(['overview']);
    expect(sectionOf(byTestId('phase-levers'))).toBe('overview');
    // Opening evidence is a step of its own in history, as it was.
    expect(pushed.length).toBe(1);
  });
});

/* ---------------------- sections, mounted and placed ---------------------- */

describe('each section sits under its tab and stays mounted', () => {
  it('places each section under the tab named for it', async () => {
    await open('/teacher/class?class=class-one&evidence=ada&phase=ada-req');
    const where = (id: string) => sectionOf(must(id));
    // Overview: the phase map with its switch, files and filters; the evidence; the work; the help requests.
    expect(sectionOf(board())).toBe('overview');
    expect(sectionOf(host.querySelector('[aria-pressed][type="button"].exp-bar-row'))).toBe('overview');
    for (const id of ['teacher-exports', 'export-class-gradebook', 'export-class-csv', 'export-quiz-form', 'learner-audit', 'stuck-list'])
      expect(where(id), id).toBe('overview');
    expect(sectionOf([...host.querySelectorAll('h2')].find((h) => h.textContent === 'Latest submissions')!)).toBe('overview');
    expect(sectionOf([...host.querySelectorAll('h2')].find((h) => h.textContent === 'Where the work is happening.')!)).toBe('overview');
    // Sign-off: the queue.
    expect(where('signoff-queue')).toBe('signoff');
    // Project: the class's project.
    expect(where('class-project-card')).toBe('project');
    // Dates and regrades: both panels.
    for (const id of ['class-levers', 'schedule-panel', 'regrade-panel']) expect(where(id), id).toBe('dates');
    // Invite and notes: the join code first, then the notes.
    expect(where('join-code')).toBe('invite');
    expect(where('notes-card')).toBe('invite');
    const invite = section('invite')!;
    expect(
      must('join-code').compareDocumentPosition(must('notes-card')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(invite.textContent).toContain('Invite your learners');
    // The numbers stay above the tabs, in view whichever is open.
    expect(sectionOf(must('teacher-metrics'))).toBeUndefined();
  });

  it('keeps every section mounted while another is open, and reads nothing again on a switch', async () => {
    await open('/teacher/class?class=class-one');
    const held = ['signoff-queue', 'class-project-card', 'schedule-panel', 'regrade-panel', 'notes-card', 'join-code', 'stuck-list'].map(
      (id) => [id, must(id)] as const,
    );
    const reads = asked.length;
    for (const key of ['signoff', 'project', 'dates', 'invite', 'overview']) {
      await press(must(`class-tab-${key}`));
      expect(shownSections()).toEqual([key]);
      // Hidden, not removed: the very same nodes are still in the page.
      for (const [id, node] of held) expect(byTestId(id), id).toBe(node);
    }
    expect(asked.slice(reads)).toEqual([]);
  });

  it('a draft typed under one tab survives a visit to another', async () => {
    await open('/teacher/class?class=class-one&tab=dates');
    const reason = must('regrade-reason') as HTMLTextAreaElement;
    await act(async () => fireEvent.change(reason, { target: { value: 'The rubric was fixed on Tuesday.' } }));
    await press(must('class-tab-invite'));
    await act(async () => must('note-write').click());
    const note = must('note-text') as HTMLTextAreaElement;
    await act(async () => fireEvent.change(note, { target: { value: 'Bring your laptops on Friday.' } }));
    expect(section('dates')!.hidden).toBe(true);
    await press(must('class-tab-overview'));
    await press(must('class-tab-dates'));
    expect((must('regrade-reason') as HTMLTextAreaElement).value).toBe('The rubric was fixed on Tuesday.');
    expect(must('regrade-reason')).toBe(reason);
    await press(must('class-tab-invite'));
    expect((must('note-text') as HTMLTextAreaElement).value).toBe('Bring your laptops on Friday.');
  });

  it('a section whose panel would be empty still has its tab and draws its own empty state', async () => {
    state.queueRows = 0;
    await open('/teacher/class?class=class-one&tab=signoff');
    expect(shownSections()).toEqual(['signoff']);
    expect(section('signoff')!.textContent).toContain('0 waiting');
  });
});

/* ------------------------------ My classes -------------------------------- */

describe('My classes is a short page', () => {
  it('holds the numbers, the help requests, the work, the latest submissions, the class cards and the All classes files', async () => {
    await open('/teacher');
    expect(byTestId('teacher-metrics')).not.toBeNull();
    expect(byTestId('stuck-list')).not.toBeNull();
    const h2 = [...host.querySelectorAll('h2')].map((h) => h.textContent);
    expect(h2).toEqual(expect.arrayContaining(['Where the work is happening.', 'Latest submissions', 'Your classes', 'All classes']));
    // In this order: help, work, classes, then the files.
    const order = ['stuck-list', 'teacher-class-cards', 'teacher-all-classes'].map((id) => must(id));
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The files that cover every class are in the All classes block.
    const all = must('teacher-all-classes');
    for (const id of ['export-gradebook', 'export-csv', 'export-all-scope', 'export-quiz-form', 'export-quiz-results'])
      expect(all.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    expect(all.querySelector('[data-testid="export-quiz-scope"]')!.textContent).toBe('For every class of yours.');
    expect(byTestId('export-class-gradebook')).toBeNull();
    // No tabs here.
    expect(host.querySelector('[role="tablist"][aria-label="Class sections"]')).toBeNull();
  });

  it('leaves the phase map, the dates and the regrade, which are each on the class page under a named tab', async () => {
    await open('/teacher');
    const home = testIds();
    expect(board()).toBeNull();
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).not.toContain('Learner phase map');
    for (const id of ['class-levers', 'schedule-panel', 'regrade-panel', 'view-as-ada']) expect(home.has(id), id).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    await open('/teacher/class?class=class-one');
    expect(sectionOf(board())).toBe('overview');
    expect([...host.querySelectorAll('h2')].find((h) => h.textContent === 'Learner phase map')).toBeDefined();
    expect(sectionOf(must('view-as-ada'))).toBe('overview');
    for (const id of ['class-levers', 'schedule-panel', 'regrade-panel']) expect(sectionOf(must(id)), id).toBe('dates');
    // And the home's every-class files are offered on the class page too, beside the class's own.
    for (const id of ['export-gradebook', 'export-csv']) expect(sectionOf(must(id)), id).toBe('overview');
  });

  it('gives each class a card: learners, the masked code with Show and Copy, its queue link and how many wait', async () => {
    await open('/teacher');
    const card = must('class-card-class-one');
    expect(card.querySelector('a.exp-row')!.getAttribute('href')).toBe('/teacher/class?class=class-one');
    expect(card.textContent).toContain('2 learners');
    expect(card.querySelector('[data-testid="join-code"]')!.textContent).not.toContain('AAAA');
    expect(card.querySelector('[data-testid="join-code-show"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="join-code-copy"]')).not.toBeNull();
    expect(card.querySelector('a[aria-label="Sign-off queue for Morning class"]')!.textContent).toBe('Sign-off queue');
    // Ada's one waiting task; her passed task is not counted.
    expect(must('class-card-waiting-class-one').textContent).toBe('1 awaiting your sign-off');
    expect(must('class-card-waiting-class-two').textContent).toBe('0 awaiting your sign-off');
    expect(must('class-card-class-two').textContent).toContain('1 learner');
    // The count is from the learners already read: the home asks for no queue.
    expect(asked.some((path) => path.includes('signoff-queue'))).toBe(false);
    // No control inside the link that opens the class.
    expect(host.querySelectorAll('a button, a [data-testid="join-code"]').length).toBe(0);
  });

  it('the bars of where the work is read as rows; there is no roster here for them to filter', async () => {
    await open('/teacher');
    expect(host.querySelectorAll('button.exp-bar-row').length).toBe(0);
    expect(byTestId('work-bar-requirements')!.textContent).toContain('Requirements');
    const caption = must('work-bar-requirements').parentElement!.querySelector('.exp-caption')!.textContent!;
    expect(caption).toContain('have not started the project.');
    expect(caption).not.toContain('Select a phase to filter the roster.');
    act(() => root.unmount());
    root = createRoot(host);
    // On the class page they filter its roster.
    await open('/teacher/class?class=class-one');
    const bar = host.querySelector<HTMLButtonElement>('button.exp-bar-row')!;
    expect(bar.getAttribute('aria-pressed')).toBe('false');
    expect(bar.parentElement!.querySelector('.exp-caption')!.textContent).toContain('Select a phase to filter the roster.');
  });

  it("/teacher?learner=<id> goes on to that learner's class page, with the rest of its address", async () => {
    await open('/teacher?learner=ada&evidence=ada&phase=ada-req');
    expect(mocks.router.replace).toHaveBeenCalledWith('/teacher/class?class=class-one&learner=ada&evidence=ada&phase=ada-req');
    // It waits there rather than drawing the home it is leaving.
    expect(byTestId('teacher-class-cards')).toBeNull();
  });

  it('a learner in no class of this teacher’s keeps the roster on the home, filtered to them', async () => {
    state.withZed = true;
    await open('/teacher?learner=zed');
    expect(mocks.router.replace).not.toHaveBeenCalled();
    const names = [...board()!.querySelectorAll('tbody td:first-child strong')].map((one) => one.textContent);
    expect(names).toEqual(['Zed Outside']);
    // Its files stay in the All classes block, once.
    expect(host.querySelectorAll('[data-testid="export-gradebook"]').length).toBe(1);
    // Its bars filter the roster that is drawn.
    expect(host.querySelectorAll('button.exp-bar-row').length).toBeGreaterThan(0);
  });

  it('a new class opens on its Invite and notes tab, where the join code is', async () => {
    await open('/teacher/class?class=class-one&tab=invite');
    expect(shownSections()).toEqual(['invite']);
    expect(sectionOf(must('join-code'))).toBe('invite');
  });
});

/* ------------------------------- the guard -------------------------------- */

/**
 * The views the guard renders: the home and each class's page, plain and with
 * a learner's evidence open (the evidence panel draws its own controls).
 */
const VIEWS = [
  '/teacher',
  '/teacher?evidence=ada&phase=ada-req',
  '/teacher/class?class=class-one',
  '/teacher/class?class=class-one&evidence=ada&phase=ada-req',
  '/teacher/class?class=class-two',
];

async function renderedIds(): Promise<string[]> {
  const all = new Set<string>();
  for (const view of VIEWS) {
    act(() => root.unmount());
    root = createRoot(host);
    await open(view);
    for (const id of testIds()) all.add(id);
  }
  return [...all].sort();
}

/**
 * Every test id the two pages drew before the class page became one row of
 * tabs, for the VIEWS above with this file's fixture, as recorded.
 */
const RECORDED_RENDERED_IDS: string[] = [
  'audit-empty',
  'class-levers',
  'class-project-assign',
  'class-project-card',
  'class-project-library',
  'class-project-none',
  'class-project-pick',
  'class-project-pinned',
  'class-project-reason',
  'class-project-reason-count',
  'class-project-reason-rule',
  'class-project-refresh',
  'class-project-status',
  'class-refresh',
  'class-updated',
  'create-class-menu',
  'export-all-scope',
  'export-class-csv',
  'export-class-gradebook',
  'export-class-scope',
  'export-csv',
  'export-gradebook',
  'export-quiz-form',
  'export-quiz-kind',
  'export-quiz-results',
  'export-quiz-scope',
  'join-code',
  'join-code-copy',
  'join-code-show',
  'learner-audit',
  'learner-task-extra',
  'learner-task-main',
  'learner-tasks',
  'learner-tasks-counts',
  'learner-tasks-heading',
  'learner-tasks-live',
  'metric-acknowledge',
  'metric-revision',
  'metric-signoff',
  'note-write',
  'notes-card',
  'notes-empty',
  'notes-mentor-rule',
  'phase-lever-pass',
  'phase-lever-regrade',
  'phase-lever-reopen',
  'phase-lever-reset-phase',
  'phase-lever-reset-workspace',
  'phase-levers',
  'phase-levers-said',
  'presentation-view-toggle',
  'quiz-results-link',
  'regrade-panel',
  'regrade-phase',
  'regrade-preview',
  'regrade-reason',
  'regrade-scope',
  'regrade-start',
  'schedule-clear',
  'schedule-cleared',
  'schedule-cohort',
  'schedule-due-design',
  'schedule-due-requirements',
  'schedule-opens-design',
  'schedule-opens-requirements',
  'schedule-panel',
  'schedule-save',
  'schedule-table',
  // 'signoff-all-requirements-main': "Every learner waiting" is drawn only
  // when two or more wait; this fixture has one (Ada), who starts chosen.
  // signoff-queue.test.tsx draws it with two learners.
  'signoff-bulk-requirements-main',
  'signoff-bulk-requirements-main-reason',
  'signoff-pick-requirements-main-ada',
  'signoff-queue',
  'signoff-reason-requirements-main',
  'signoff-task-requirements-main',
  'stuck-empty',
  'stuck-list',
  'stuck-refresh',
  'task-reopen-extra',
  'task-reopen-main',
  'task-reset-extra',
  'task-reset-main',
  'task-signoff-extra',
  'task-signoff-main',
  'task-submission-main',
  'teacher-exports',
  'teacher-metrics',
  'view-as-ada',
  'view-as-bo',
  'view-as-cy',
  'view-as-start',
];

/**
 * The literal test ids the teacher portal's source held before the class page
 * became one row of tabs (`data-testid="…"`, `testId="…"`, and the fixed head
 * of a template such as `view-as-${…}`).
 */
const RECORDED_SOURCE_IDS: string[] = [
  'class-levers-failed',
  'class-refresh',
  'class-stale',
  'class-updated',
  'create-class-menu',
  'evidence-needed-line',
  'export-all-scope',
  'export-class-csv',
  'export-class-gradebook',
  'export-class-scope',
  'export-csv',
  'export-gradebook',
  'export-quiz-form',
  'export-quiz-kind',
  'export-quiz-results',
  'export-quiz-scope',
  'learner-audit',
  'metric-acknowledge',
  'metric-revision',
  'metric-signoff',
  'phase-levers-failed',
  'presentation-view-on',
  'quiz-results-link',
  'teacher-exports',
  'teacher-metrics',
  'view-as-start',
  'checklist-',
  'evidence-wait-',
  'mastery-',
  'set-aside-',
  'view-as-',
];

describe('every recorded test id of the two pages is still drawn by one of them', () => {
  it('draws every one of them, on the home or the class page', async () => {
    expect(RECORDED_RENDERED_IDS.length).toBeGreaterThan(60);
    const now = new Set(await renderedIds());
    expect(RECORDED_RENDERED_IDS.filter((id) => !now.has(id))).toEqual([]);
  });

  it("keeps every recorded literal id of the teacher portal in its source", () => {
    expect(RECORDED_SOURCE_IDS.length).toBeGreaterThan(20);
    // The portal and every module it draws from, so an id that moves into a child component still counts.
    const source = closureText('TeacherPortal');
    const missing = RECORDED_SOURCE_IDS.filter((id) =>
      id.endsWith('-') ? !source.includes(`data-testid={\`${id}\${`) : !source.includes(`"${id}"`),
    );
    expect(missing).toEqual([]);
  });
});

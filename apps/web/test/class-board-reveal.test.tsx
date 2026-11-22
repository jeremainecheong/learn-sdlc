// @vitest-environment jsdom
/**
 * The class page's board and its bars.
 *
 * 1. Pressing Table (or Phase map) brings the head of the board (its column
 *    headings and first row) into view by the least scroll of the page's
 *    scroll box (board-reveal.ts): only on the person's own press; a page opened at ?view=table, a refresh, data arriving
 *    and Back move nothing. The toggle's names, pressed state and address are
 *    unchanged by the reveal.
 * 2. "Where the work is happening." for a class of one learner (
 *    five phases passed, Maintenance awaiting sign-off, then signed off): each
 *    bar counts the learners whose current phase it is, so the first five read
 *    0 and Maintenance 1; the caption under the bars says what is counted.
 *
 * The real `TeacherPortal` with the real `lib/api-*` clients; only `fetch`
 * answers. The harness is teacher-class-tabs.test.tsx's. jsdom draws no
 * layout, so the board's places are given by a stub of getBoundingClientRect
 * that reads the scroll box's position, the way a browser would.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CohortView, InstructorLearnerDetail, InstructorPhaseView, SubmissionView } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import { TeacherPortal } from '@/components/staff/console/TeacherPortal';
import { REVEAL_GAP, revealScrollTop } from '@/components/staff/console/board-reveal';

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
// The shell's scroll box, as AppShell draws it: the one box that scrolls up and down.
vi.mock('@/components/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => (
    <div data-scroll-box="" style={{ overflowY: 'auto' }}>
      {children}
    </div>
  ),
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

/* --------------------------------- fixture -------------------------------- */

const CLASSES: CohortView[] = [
  { id: 'class-one', name: 'Deadline badge class', joinCode: 'AAAA1111', createdAt: '2026-11-18T00:00:00.000Z', memberCount: 1 },
];

const reviewed = (id: string): SubmissionView =>
  ({
    id,
    status: 'completed',
    passed: true,
    verifiedPass: true,
    createdAt: '2026-11-18T05:05:00.000Z',
    report: { overall: 90, passed: true },
  }) as unknown as SubmissionView;

const KEYS = [
  ['requirements', 'Requirements'],
  ['design', 'Design'],
  ['implementation', 'Implementation'],
  ['testing', 'Testing'],
  ['deployment', 'Deployment'],
  ['maintenance', 'Maintenance'],
] as const;

const state = { signedOff: false };

/** The class's one learner, Maintenance awaiting sign-off or signed off. */
const yuki = (): InstructorLearnerDetail => {
  const phases = KEYS.map(([key, title], index) => {
    const last = index === 5;
    const passed = !last || state.signedOff;
    return {
      id: `yuki-${key}`,
      key,
      order: index + 1,
      title,
      status: passed ? 'passed' : 'in_progress',
      bestScore: 90,
      attempts: 1,
      reflection: null,
      passedAt: passed ? '2026-11-18T05:00:00.000Z' : null,
      hints: 0,
      relianceIndex: 0,
      passThreshold: 70,
      unlockedAt: null,
      lastSubmission: reviewed(`yuki-${key}-1`),
      tasks: [
        {
          key: 'main',
          order: 1,
          required: true,
          title: `${title} task`,
          status: passed ? 'passed' : 'in_progress',
          bestScore: 90,
          attempts: 1,
          passedAt: passed ? '2026-11-18T05:00:00.000Z' : null,
          awaitingSignOff: last && !state.signedOff,
          signedOffAt: last && state.signedOff ? '2026-11-18T05:07:00.000Z' : null,
          lastSubmission: reviewed(`yuki-${key}-1`),
        },
      ],
    } as unknown as InstructorPhaseView;
  });
  return {
    userId: 'yuki',
    email: 'yuki@school.test',
    displayName: 'Yuki Morimoto',
    cohort: 'class-one',
    cohortName: 'Deadline badge class',
    createdAt: '2026-11-18T00:00:00.000Z',
    tokensToday: 0,
    enrollments: [
      {
        id: 'e-yuki',
        projectSlug: 'deadline-badge',
        projectTitle: 'Deadline badge demo',
        currentPhaseOrder: 6,
        completed: false,
        startedAt: '2026-11-18T04:41:00.000Z',
        completedAt: null,
        phases,
      },
    ],
  } as unknown as InstructorLearnerDetail;
};

function answer(path: string): { status: number; body: unknown } {
  if (path === '/instructor/cohorts') return { status: 200, body: CLASSES };
  if (path.startsWith('/instructor/overview'))
    return {
      status: 200,
      body: { learners: [{ userId: 'yuki', cohort: 'class-one', projectSlug: 'deadline-badge', checklistPercent: 83, masteryPercent: null }] },
    };
  if (path === '/instructor/learners') return { status: 200, body: [yuki()] };
  if (path === '/instructor/learners/yuki') return { status: 200, body: yuki() };
  if (path.startsWith('/instructor/audit')) return { status: 200, body: [] };
  if (/^\/instructor\/cohorts\/[^/]+\/signoff-queue$/.test(path))
    return { status: 200, body: { cohortId: 'class-one', rows: [] } };
  if (/^\/instructor\/cohorts\/[^/]+\/project$/.test(path))
    return { status: 200, body: { cohortId: 'class-one', active: null, history: [] } };
  if (/^\/instructor\/cohorts\/[^/]+\/project\/assignable$/.test(path)) return { status: 200, body: [] };
  if (/^\/instructor\/cohorts\/[^/]+\/schedule$/.test(path))
    return { status: 200, body: { cohortId: 'class-one', projectSlug: 'deadline-badge', timezone: 'UTC', phases: [] } };
  if (path.startsWith('/instructor/notes')) return { status: 200, body: [] };
  if (path.startsWith('/instructor/stuck')) return { status: 200, body: [] };
  if (/^\/submissions\/[^/]+\/teacher-feedback$/.test(path)) return { status: 200, body: [] };
  return { status: 404, body: { message: 'Not found.' } };
}

/* ------------------------------ the layout stub ---------------------------- */

/**
 * A 1440 by 900 window: the scroll box starts under the 64 px top bar. The
 * parts at their places inside the box's content (viewport y minus 64 at the
 * top of the page), as measured in a browser: the "Awaiting your
 * sign-off" card 360 to 483 with its link at 457, the tab row at 527, the
 * board's panel at 616, the first row's foot at 1059 (C1-b, scrolled 539,
 * shows it at 520), below the window's foot at 900.
 */
const layout = { boxTop: 64, boxHeight: 836, card: 296, cardFoot: 419, tabs: 448, tabsFoot: 488, panel: 552, region: 860, thead: 900, firstRow: 995 };
let scrollY = 0;
let scrolls: number[] = [];

function placeOf(node: Element): { top: number; bottom: number } | null {
  if (node.matches('[data-scroll-box]')) return { top: layout.boxTop, bottom: layout.boxTop + layout.boxHeight };
  const at = (offset: number) => layout.boxTop + offset - scrollY;
  if (node.matches('[data-testid="metric-signoff"]')) return { top: at(layout.card), bottom: at(layout.cardFoot) };
  if (node.matches('[role="tablist"][aria-label="Class sections"]')) return { top: at(layout.tabs), bottom: at(layout.tabsFoot) };
  if (node.matches('section.exp-panel') && node.querySelector('h2')?.textContent === 'Learner phase map')
    return { top: at(layout.panel), bottom: at(layout.firstRow + 40) };
  if (node.matches('.experience-scroll-region')) return { top: at(layout.region), bottom: at(layout.firstRow) };
  if (node.matches('thead')) return { top: at(layout.region), bottom: at(layout.thead) };
  if (node.matches('tbody tr')) return { top: at(layout.thead), bottom: at(layout.firstRow) };
  return null;
}

/* --------------------------------- harness -------------------------------- */

let host: HTMLDivElement;
let root: Root;
let pushed: string[] = [];
const settle = async (rounds = 14) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const toggle = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('.exp-tabs button')].find((one) => one.textContent === name)!;
const box = () => host.querySelector<HTMLElement>('[data-scroll-box]')!;
const learnerReads = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith('/instructor/learners')).length;

async function open(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView />));
  await settle();
  pushed = [];
  // The box scrolls as a browser's would: what is set is read back.
  Object.defineProperty(box(), 'scrollTop', {
    configurable: true,
    get: () => scrollY,
    set: (value: number) => {
      scrolls.push(value);
      scrollY = value;
    },
  });
}
async function press(element: HTMLElement) {
  element.focus();
  await act(async () => element.click());
  await settle(4);
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { signedOff: false });
  Object.assign(layout, { boxHeight: 836 });
  scrollY = 0;
  scrolls = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const place = placeOf(this);
    if (!place) return original.call(this);
    return { top: place.top, bottom: place.bottom, height: place.bottom - place.top, left: 0, right: 1440, width: 1440, x: 0, y: place.top, toJSON: () => ({}) } as DOMRect;
  });
  const replace = window.history.replaceState.bind(window.history);
  const push = window.history.pushState.bind(window.history);
  vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
    replace(...args);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.spyOn(window.history, 'pushState').mockImplementation((...args) => {
    push(...args);
    pushed.push(String(args[2]));
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const { status, body } = answer(url.pathname.replace(/^\/api\/v1/, ''));
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  setAuthSession('s25-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
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

/* ------------------------------ 1. the press ------------------------------ */

describe('pressing Table or Phase map brings the head of the board into view', () => {
  it('the place, from the numbers: the least movement that shows the head whole', () => {
    const at = { boxTop: 64, boxHeight: 836, scrollTop: 0, headTop: 924, headBottom: 1059 };
    // Below the window: up until its foot is 12 px above the box's foot (900 - 12).
    expect(revealScrollTop(at)).toBe(1059 - (900 - REVEAL_GAP));
    // Scrolled already: measured from where things are now.
    expect(revealScrollTop({ ...at, scrollTop: 100, headTop: 824, headBottom: 959 })).toBe(100 + 959 - 888);
    // Whole in view, to the pixel at either edge: nothing moves.
    expect(revealScrollTop({ ...at, headTop: 300, headBottom: 435 })).toBeNull();
    expect(revealScrollTop({ ...at, headTop: 64, headBottom: 900 })).toBeNull();
    // Above the window, wholly or partly: down until its top is 12 px under the box's top.
    expect(revealScrollTop({ ...at, scrollTop: 900, headTop: -200, headBottom: -65 })).toBe(900 - 200 - 76);
    expect(revealScrollTop({ ...at, scrollTop: 900, headTop: 40, headBottom: 175 })).toBe(900 + 40 - 76);
    // Taller than the box (a window 120 px high): its top under the box's top.
    expect(revealScrollTop({ ...at, boxHeight: 120 })).toBe(924 - 76);
    // Never above the top of the page.
    expect(revealScrollTop({ ...at, scrollTop: 0, headTop: 50, headBottom: 185 })).toBe(0);
  });

  it('a press on Table at the top of the page brings the row up by the least, the screen in one view; toggle and address unchanged', async () => {
    await open('/teacher/class?class=class-one');
    const table = toggle('Table');
    const map = toggle('Phase map');
    // The toggle as the browser specs read it, before and after.
    expect([map.getAttribute('aria-pressed'), table.getAttribute('aria-pressed')]).toEqual(['true', 'false']);
    expect([map.hasAttribute('data-testid'), table.hasAttribute('data-testid')]).toEqual([false, false]);
    await press(table);
    expect(scrolls).toEqual([layout.boxTop + layout.firstRow - (900 - REVEAL_GAP)]);
    // What C1 reads, all in the window below the top bar: the row, the card
    // "Awaiting your sign-off" (its link is C2's press) and the Sign-off tab.
    const inView = (node: Element) => {
      const place = placeOf(node)!;
      return place.top >= layout.boxTop && place.bottom <= 900;
    };
    expect(inView(host.querySelector('tbody tr')!)).toBe(true);
    expect(placeOf(host.querySelector('tbody tr')!)!.bottom).toBe(900 - REVEAL_GAP);
    expect(inView(host.querySelector('[data-testid="metric-signoff"]')!)).toBe(true);
    expect(inView(host.querySelector('[role="tablist"][aria-label="Class sections"]')!)).toBe(true);
    // The board's panel (its heading and the toggle) starts inside the window too.
    expect(placeOf(host.querySelector('.exp-filters')!.closest('section')!)!.top).toBeGreaterThanOrEqual(layout.boxTop);
    expect(pushed).toEqual(['/teacher/class?class=class-one&view=table']);
    expect([toggle('Phase map').getAttribute('aria-pressed'), toggle('Table').getAttribute('aria-pressed')]).toEqual(['false', 'true']);
    expect(host.querySelector('thead')!.textContent).toContain('Phases passed');
    expect(host.querySelector('tbody tr')!.textContent).toContain('5 / 6');
    // No focus moved: the button pressed keeps it.
    expect(document.activeElement).toBe(toggle('Table'));
  });

  it('a press on Phase map from the table does the same, and the address drops view', async () => {
    await open('/teacher/class?class=class-one&view=table');
    await press(toggle('Phase map'));
    expect(scrolls).toEqual([layout.boxTop + layout.firstRow - (900 - REVEAL_GAP)]);
    expect(pushed).toEqual(['/teacher/class?class=class-one']);
    expect(toggle('Phase map').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('thead')!.textContent).toContain('Maintenance');
  });

  it('a press on the view already shown (Table again after Overview) brings it into view too; a head already in view moves nothing', async () => {
    await open('/teacher/class?class=class-one&view=table');
    await press(toggle('Table'));
    expect(scrolls).toEqual([layout.boxTop + layout.firstRow - (900 - REVEAL_GAP)]);
    expect(pushed).toEqual([]);
    scrolls = [];
    await press(toggle('Phase map'));
    await press(toggle('Table'));
    expect(scrolls).toEqual([]);
  });

  it('a page scrolled past the board brings its head down to the top of the window', async () => {
    await open('/teacher/class?class=class-one');
    scrollY = 1400;
    await press(toggle('Table'));
    expect(scrolls).toEqual([layout.region - REVEAL_GAP]);
    expect(placeOf(host.querySelector('.experience-scroll-region')!)!.top).toBe(layout.boxTop + REVEAL_GAP);
  });

  it('a page opened at ?view=table, a refresh, data arriving and Back move nothing', async () => {
    await open('/teacher/class?class=class-one&view=table');
    expect(scrolls).toEqual([]);
    expect(toggle('Table').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('tbody tr')!.textContent).toContain('5 / 6');
    await press(host.querySelector<HTMLElement>('[data-testid="class-refresh"]')!);
    await settle();
    expect(scrolls).toEqual([]);
    // After a press, the person scrolls back up; the next read and Back leave them there.
    await press(toggle('Phase map'));
    expect(scrolls).toHaveLength(1);
    scrollY = 0;
    scrolls = [];
    state.signedOff = true;
    const reads = learnerReads();
    await press(host.querySelector<HTMLElement>('[data-testid="class-refresh"]')!);
    await settle();
    // The read answered with the signed-off learner, and was drawn.
    expect(learnerReads()).toBeGreaterThan(reads);
    expect(bars()[5].passed).toBe('1');
    act(() => {
      window.history.replaceState(null, '', '/teacher/class?class=class-one&view=table');
    });
    await settle(4);
    expect(toggle('Table').getAttribute('aria-pressed')).toBe('true');
    expect(scrolls).toEqual([]);
  });
});

/* ---------------------- 2. where the work is happening --------------------- */

const bars = () =>
  [...host.querySelectorAll<HTMLButtonElement>('button.exp-bar-row')].map((row) => ({
    phase: row.querySelector('span')!.textContent,
    count: row.querySelector('strong')!.textContent,
    inProgress: row.querySelector('.is-active')!.textContent,
    passed: row.querySelector('.is-pass')!.textContent,
  }));
const CAPTION =
  'Each learner is counted once, at the phase they are in now, not at the phases they passed before it. 0 have not started the project. Select a phase to filter the roster.';

describe('where the work is happening, for a class of one learner', () => {
  it('awaiting sign-off: the first five phases read 0 and Maintenance 1, in progress; the caption says what is counted', async () => {
    await open('/teacher/class?class=class-one');
    expect(bars()).toEqual([
      { phase: 'Requirements', count: '0', inProgress: '', passed: '' },
      { phase: 'Design', count: '0', inProgress: '', passed: '' },
      { phase: 'Implementation', count: '0', inProgress: '', passed: '' },
      { phase: 'Testing', count: '0', inProgress: '', passed: '' },
      { phase: 'Deployment', count: '0', inProgress: '', passed: '' },
      { phase: 'Maintenance', count: '1', inProgress: '1', passed: '' },
    ]);
    const caption = host.querySelector('button.exp-bar-row')!.parentElement!.querySelector('.exp-caption')!;
    expect(caption.textContent).toBe(CAPTION);
  });

  it('signed off: Maintenance reads 1, phase passed', async () => {
    state.signedOff = true;
    await open('/teacher/class?class=class-one');
    expect(bars().map((one) => one.count)).toEqual(['0', '0', '0', '0', '0', '1']);
    expect(bars()[5]).toEqual({ phase: 'Maintenance', count: '1', inProgress: '', passed: '1' });
  });
});

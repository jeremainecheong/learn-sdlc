// @vitest-environment jsdom
/**
 * How a teacher reaches the sign-off queue.
 *
 * The queue is mounted on the class page only (`TeacherPortal classView`). The
 * home lists the classes, so beside each one it offers a "Sign-off queue" link
 * that opens that class's page at `#signoff-queue`; the class page carries the
 * queue under that id with its heading, and its header links to it. Arriving
 * with the hash moves focus to the queue's heading once the queue is drawn, and
 * at no other time.
 *
 * - The home asks for no queue: the queue is read on the class page only (no
 *   extra API route, no read per class).
 * - A learner sees neither link.
 *
 * The page is the real `TeacherPortal` with the real `lib/api-*` clients; only
 * `fetch` answers from the table below. The router mock is ONE module-level
 * object: a new object per render would make TeacherPortal's load effect run
 * on every render.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CohortView, SignoffQueueView } from '@learnsdlc/shared';
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
    // Stable: the same object on every render.
    useRouter: () => mocks.router,
    usePathname: () => window.location.pathname,
  };
});
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

const CLASSES: CohortView[] = [
  { id: 'class-one', name: 'Morning class', joinCode: 'AAAA1111', createdAt: '2026-09-01T00:00:00.000Z', memberCount: 2 },
  { id: 'class two/x', name: 'Evening class', joinCode: 'BBBB2222', createdAt: '2026-09-02T00:00:00.000Z', memberCount: 1 },
];
const QUEUE = (cohortId: string): SignoffQueueView => ({
  cohortId,
  rows: [
    {
      userId: 'learner-1',
      learnerName: 'Ada',
      phaseKey: 'requirements',
      taskKey: 'main',
      taskTitle: 'Requirements brief',
      awaitingSince: '2026-10-01T00:00:00.000Z',
    },
  ],
});
const QUEUE_PATH = /^\/instructor\/cohorts\/([^/]+)\/signoff-queue$/;

let host: HTMLDivElement;
let root: Root;
let asked: string[] = [];
/** While set, the queue's answer waits for it (focus moves "once the queue is drawn"). */
let queueGate: Promise<void> | null = null;

function answer(path: string): { status: number; body: unknown } {
  if (path === '/instructor/cohorts') return { status: 200, body: CLASSES };
  if (path.startsWith('/instructor/overview')) return { status: 200, body: { learners: [] } };
  const queue = QUEUE_PATH.exec(path);
  if (queue) return { status: 200, body: QUEUE(decodeURIComponent(queue[1])) };
  return { status: 404, body: { message: 'Not found.' } };
}

const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const queueReads = () => asked.filter((path) => QUEUE_PATH.test(path));
const signoffLinks = () => [...host.querySelectorAll('a')].filter((a) => a.textContent?.trim() === 'Sign-off queue');

async function open(url: string, classView: boolean) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView={classView} />));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  asked = [];
  queueGate = null;
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, '');
      asked.push(path);
      if (queueGate && QUEUE_PATH.test(path)) await queueGate;
      const { status, body } = answer(path);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  setAuthSession('sign-reach-session', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  clearSession();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the home reaches each class queue', () => {
  it('lists one "Sign-off queue" link per class, named for the class, opening its page at the queue', async () => {
    await open('/teacher', false);
    const links = signoffLinks();
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Sign-off queue for Morning class',
      'Sign-off queue for Evening class',
    ]);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/teacher/class?class=class-one#signoff-queue',
      `/teacher/class?class=${encodeURIComponent('class two/x')}#signoff-queue`,
    ]);
  });

  it('the home asks for no sign-off queue', async () => {
    await open('/teacher', false);
    // Vacuity: the home did read the classes it lists.
    expect(asked).toContain('/instructor/cohorts');
    expect(queueReads()).toEqual([]);
  });
});

describe('the class page', () => {
  it('draws the queue at #signoff-queue with its heading, and the header links to it', async () => {
    await open(`/teacher/class?class=${encodeURIComponent('class two/x')}`, true);
    const section = host.querySelector('#signoff-queue');
    expect(section).not.toBeNull();
    expect(section?.querySelector('h2')?.textContent).toBe('Awaiting your sign-off');
    const inPage = host.querySelector<HTMLAnchorElement>('a[href="#signoff-queue"]');
    expect(inPage?.textContent?.trim()).toBe('Sign-off queue');
    // The queue is still read for the chosen class alone, once.
    expect(queueReads()).toEqual([`/instructor/cohorts/${encodeURIComponent('class two/x')}/signoff-queue`]);
  });

  it('arriving with #signoff-queue moves focus to the queue heading once the queue is drawn', async () => {
    await open(`/teacher/class?class=class-one#signoff-queue`, true);
    const heading = host.querySelector<HTMLElement>('#signoff-queue h2');
    expect(heading).not.toBeNull();
    expect(host.querySelector('[data-testid="signoff-task-requirements-main"]')).not.toBeNull();
    expect(heading?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(heading);
  });

  it('without the hash, the page leaves focus where it is', async () => {
    await open('/teacher/class?class=class-one', true);
    expect(host.querySelector('#signoff-queue h2')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

// The arrival is spent once; the in-page link focuses itself.
describe('focus moves for the arrival alone', () => {
  const heading = () => host.querySelector<HTMLElement>('#signoff-queue h2');
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((one) => one.textContent?.trim() === text) ?? null;

  it('the arrival is spent: the hash is dropped, and a reload that redraws the queue leaves focus alone', async () => {
    await open(`/teacher/class?class=class-one#signoff-queue`, true);
    expect(document.activeElement).toBe(heading());
    expect(window.location.hash).toBe('');
    // The arrival opened the Sign-off tab, and the address keeps it, so a reload lands there too.
    expect(window.location.pathname + window.location.search).toBe('/teacher/class?class=class-one&tab=signoff');
    const refresh = button('Refresh records');
    expect(refresh).not.toBeNull();
    refresh?.focus();
    const before = heading();
    await act(async () => refresh?.click());
    await settle();
    // Vacuity: the reload did unmount and redraw the queue (a class with no learners shows the loading state).
    expect(heading()).not.toBeNull();
    expect(heading()).not.toBe(before);
    expect(document.activeElement).toBe(refresh);
  });

  it('focus waits for the queue to be drawn, and a teacher who has moved on keeps their place', async () => {
    let release!: () => void;
    queueGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(`/teacher/class?class=class-one#signoff-queue`, true);
    expect(host.querySelector('[data-testid="signoff-loading"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    release();
    await settle();
    expect(document.activeElement).toBe(heading());

    // A second arrival in which the teacher has already moved focus before the queue answers.
    act(() => root.unmount());
    root = createRoot(host);
    queueGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(`/teacher/class?class=class-one#signoff-queue`, true);
    const refresh = button('Refresh records');
    refresh?.focus();
    release();
    await settle();
    expect(host.querySelector('[data-testid="signoff-task-requirements-main"]')).not.toBeNull();
    expect(document.activeElement).toBe(refresh);
  });

  it("the header's in-page link moves focus to the queue heading itself, without leaving the hash behind", async () => {
    await open('/teacher/class?class=class-one', true);
    const inPage = host.querySelector<HTMLAnchorElement>('a[href="#signoff-queue"]');
    expect(inPage).not.toBeNull();
    await act(async () => inPage?.click());
    await settle();
    expect(document.activeElement).toBe(heading());
    expect(window.location.hash).toBe('');
  });
});

describe('a learner', () => {
  it('sees neither link and asks for no queue', async () => {
    setAuthSession('sign-reach-learner', { id: 'learner', role: 'LEARNER', displayName: 'Learner', email: 'learner' } as never);
    await open('/teacher', false);
    expect(signoffLinks()).toEqual([]);
    expect(host.querySelector('a[href="#signoff-queue"]')).toBeNull();
    await open('/teacher/class?class=class-one#signoff-queue', true);
    expect(signoffLinks()).toEqual([]);
    expect(host.querySelector('a[href="#signoff-queue"]')).toBeNull();
    expect(queueReads()).toEqual([]);
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
    // Why a learner can never see a link: the page sends them away before it reads any class
    // (the links' own role checks are a second wall that this mounted path cannot reach).
    expect(asked).not.toContain('/instructor/cohorts');
  });
});

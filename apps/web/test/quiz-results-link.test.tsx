// @vitest-environment jsdom
/**
 * The class page's way to the quiz results.
 *
 * One link in the class view's header, right after "Sign-off queue", staff
 * only, to /teacher/class/quiz-results?class=<the class id>. The class page
 * itself reads no summary: the summary is read on its own page, so the
 * contract replays and the other tests that render TeacherPortal see no
 * extra request.
 *
 * The real TeacherPortal with the real lib/api-* clients; only `fetch` answers.
 * The router mock is one module-level object, as Next hands out: a new router
 * per render would re-run the portal's load effect.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_RESULTS_COPY, type CohortView } from '@learnsdlc/shared';
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
vi.mock('@/components/experience/ScrollRegion', () => ({
  ScrollRegion: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/staff/StuckList', () => ({ StuckList: () => null }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: () => null }));

const CLASSES: CohortView[] = [
  { id: 'class-one', name: 'Morning class', joinCode: 'AAAA1111', createdAt: '2026-09-01T00:00:00.000Z', memberCount: 2 },
  { id: 'class two/x', name: 'Evening class', joinCode: 'BBBB2222', createdAt: '2026-09-02T00:00:00.000Z', memberCount: 1 },
];

let host: HTMLDivElement;
let root: Root;
let asked: string[] = [];

function answer(path: string): { status: number; body: unknown } {
  if (path === '/instructor/cohorts') return { status: 200, body: CLASSES };
  if (path.startsWith('/instructor/overview')) return { status: 200, body: { learners: [] } };
  if (/^\/instructor\/cohorts\/[^/]+\/signoff-queue$/.test(path)) return { status: 200, body: { cohortId: 'x', rows: [] } };
  return { status: 404, body: { message: 'Not found.' } };
}
const settle = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
async function open(url: string, classView: boolean) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<TeacherPortal classView={classView} />));
  await settle();
}
const quizLink = () => host.querySelector<HTMLAnchorElement>('[data-testid="quiz-results-link"]');

beforeEach(() => {
  vi.clearAllMocks();
  asked = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/v1/, '');
      asked.push(path);
      const { status, body } = answer(path);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  setAuthSession('quiz-results-link', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher', email: 'teacher' } as never);
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

describe('the class page links to its quiz results', () => {
  it("one 'Quiz results' link right after 'Sign-off queue', to this class's page", async () => {
    await open(`/teacher/class?class=${encodeURIComponent('class two/x')}`, true);
    const link = quizLink();
    expect(link).not.toBeNull();
    expect(link?.textContent?.trim()).toBe(QUIZ_RESULTS_COPY.link);
    expect(link?.className).toBe('exp-button');
    expect(link?.getAttribute('href')).toBe(`/teacher/class/quiz-results?class=${encodeURIComponent('class two/x')}`);
    const signoff = link?.previousElementSibling;
    expect(signoff?.getAttribute('href')).toBe('#signoff-queue');
    expect(signoff?.textContent?.trim()).toBe('Sign-off queue');
    expect(host.querySelectorAll('[data-testid="quiz-results-link"]')).toHaveLength(1);
  });

  it('the class page reads no quiz results itself', async () => {
    await open('/teacher/class?class=class-one', true);
    // Vacuity: the page did read the class.
    expect(asked).toContain('/instructor/cohorts');
    expect(asked.filter((path) => path.includes('quiz-results'))).toEqual([]);
  });

  it('the home (all classes) carries no such link', async () => {
    await open('/teacher', false);
    expect(asked).toContain('/instructor/cohorts');
    expect(quizLink()).toBeNull();
  });

  it('a learner sees no link', async () => {
    setAuthSession('quiz-link-learner-token', { id: 'learner', role: 'LEARNER', displayName: 'Learner', email: 'learner' } as never);
    await open('/teacher/class?class=class-one', true);
    expect(quizLink()).toBeNull();
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
  });
});

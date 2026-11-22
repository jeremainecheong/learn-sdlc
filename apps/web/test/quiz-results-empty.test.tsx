// @vitest-environment jsdom
/**
 * The quiz-results page when there is nothing to draw.
 *
 * - A class with no learners: QUIZ_RESULTS_COPY.noLearners, and no chart.
 * - A class whose project has no quiz: QUIZ_RESULTS_COPY.noQuizzes, and no chart.
 * - No class in the address: no read at all, and the way back to the classes.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_RESULTS_COPY, type QuizResultsSummary } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import QuizResultsRoute from '@/app/(app)/teacher/class/quiz-results/page';
import { quizFixture } from './fixtures/quiz-results';

const mocks = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() } }));
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

let host: HTMLDivElement;
let root: Root;
let asked: string[] = [];
let body: QuizResultsSummary = quizFixture();

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
async function open(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<QuizResultsRoute />));
  await settle();
}
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const empty = () => host.querySelector('[data-testid="quiz-results-empty"]');

beforeEach(() => {
  asked = [];
  body = quizFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  setAuthSession('quiz-results-empty', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
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

describe('empty states', () => {
  it('a class with no learners says so and draws no chart', async () => {
    // The project's quiz is declared; nobody is in the class to sit it.
    body = { ...quizFixture(), learnersInClass: 0, learners: [], quizzes: [quizFixture().quizzes[1]] };
    await open('/teacher/class/quiz-results?class=class-one');
    expect(text(empty())).toBe(QUIZ_RESULTS_COPY.noLearners);
    expect(host.querySelector('svg')).toBeNull();
    expect(host.querySelector('[data-testid="quiz-pass-rate-chart"]')).toBeNull();
    expect(text(host.querySelector('h1'))).toBe('Monday 10am');
  });

  it('a class whose project has no quiz says so and draws no chart', async () => {
    body = { ...quizFixture(), quizzes: [], learners: [] };
    await open('/teacher/class/quiz-results?class=class-one');
    expect(text(empty())).toBe(QUIZ_RESULTS_COPY.noQuizzes);
    expect(host.querySelector('svg')).toBeNull();
  });

  it('a nameless class is still titled', async () => {
    body = { ...quizFixture(), className: null };
    await open('/teacher/class/quiz-results?class=class-one');
    expect(text(host.querySelector('h1'))).toBe('Your class');
  });

  it('no class in the address reads nothing and leads back to the classes', async () => {
    await open('/teacher/class/quiz-results');
    expect(asked).toEqual([]);
    expect(empty()).not.toBeNull();
    const back = host.querySelector<HTMLAnchorElement>('a[href="/teacher"]');
    expect(back).not.toBeNull();
    expect(host.querySelector('[data-testid="quiz-results-downloads"]')).toBeNull();
  });
});

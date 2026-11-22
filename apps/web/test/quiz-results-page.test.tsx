// @vitest-environment jsdom
/**
 * /teacher/class/quiz-results?class=<id>, the page.
 *
 * The route's default export with the real client and only `fetch` answering:
 * one summary read per view for the class in the address, the class's name as
 * the title, the way back to the class, the per-quiz numbers of the
 * `fixtures/quiz-results` written as text, the four class-only downloads, and nothing a
 * question, an option, a key or an explanation would say. A learner is sent
 * home before anything is read.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_RESULTS_COPY, QUIZ_RESULTS_EXPORT_KINDS } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import QuizResultsRoute from '@/app/(app)/teacher/class/quiz-results/page';
import { FIXTURE_CLASS_ID, SEALED_TEXT, quizFixture, quizFixtureWithSealedText } from './fixtures/quiz-results';

const mocks = vi.hoisted(() => ({
  router: { replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() },
  saveBlob: vi.fn(),
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
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/download', async (original) => ({
  ...(await original<typeof import('@/lib/download')>()),
  saveBlob: mocks.saveBlob,
}));

let host: HTMLDivElement;
let root: Root;
let asked: string[] = [];
let summary: () => { status: number; body: unknown } = () => ({ status: 200, body: quizFixture() });

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
async function open(url: string) {
  window.history.replaceState(null, '', url);
  await act(async () => root.render(<QuizResultsRoute />));
  await settle();
}
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const summaryReads = () => asked.filter((url) => url.includes('/instructor/quiz-results/summary'));

beforeEach(() => {
  vi.clearAllMocks();
  asked = [];
  summary = () => ({ status: 200, body: quizFixture() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url.replace(/^https?:\/\/[^/]+\/api\/v1/, ''));
      if (url.includes('/instructor/quiz-results/summary')) {
        const { status, body } = summary();
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      }
      if (/\/instructor\/quiz-results\/[a-z]+\.csv/.test(url)) {
        return new Response('email,class\r\n', { status: 200, headers: { 'content-type': 'text/csv' } });
      }
      return new Response(JSON.stringify({ message: 'Not found.' }), { status: 404 });
    }),
  );
  setAuthSession('quiz-page-token', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
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

const CLASS_URL = `/teacher/class/quiz-results?class=${encodeURIComponent(FIXTURE_CLASS_ID)}`;

describe('the quiz-results page reads one class, once', () => {
  it('one summary read, for the class in the address, and nothing else', async () => {
    await open(CLASS_URL);
    expect(byTestId('quiz-results-page')).not.toBeNull();
    expect(summaryReads()).toEqual([
      `/instructor/quiz-results/summary?cohort=${encodeURIComponent(FIXTURE_CLASS_ID)}`,
    ]);
    expect(asked).toEqual(summaryReads());
  });

  it("titles the page with the class's name under the eyebrow, and leads back to the class", async () => {
    await open(CLASS_URL);
    expect(text(host.querySelector('h1'))).toBe('Monday 10am');
    expect(text(host.querySelector('.exp-eyebrow'))).toBe(QUIZ_RESULTS_COPY.eyebrow);
    const back = [...host.querySelectorAll('a')].find((a) => text(a) === QUIZ_RESULTS_COPY.back);
    expect(back?.getAttribute('href')).toBe(`/teacher/class?class=${encodeURIComponent(FIXTURE_CLASS_ID)}`);
    expect(text(host)).toContain(QUIZ_RESULTS_COPY.bestScoreNote);
  });

  it("design-check's numbers are written as text", async () => {
    await open(CLASS_URL);
    const card = byTestId('quiz-card-design-check');
    expect(card).not.toBeNull();
    const words = text(card);
    expect(words).toContain('Design check');
    expect(words).toContain('3 of 4 learners in the class attempted');
    const stat = (label: string) =>
      text(
        [...(card?.querySelectorAll('dt') ?? [])].find((dt) => text(dt) === label)?.nextElementSibling ?? null,
      );
    expect(stat('Attempts')).toBe('6');
    expect(stat('Attempted')).toBe('3');
    expect(stat('Passed')).toBe('2');
    expect(stat('Not yet passed')).toBe('1');
    expect(stat('Pass rate')).toBe('67%');
    expect(stat('Mean best score')).toBe('66.7');
    expect(stat('Median best score')).toBe('66.7');
  });

  it('a declared quiz nobody has sat says so and draws no bars', async () => {
    await open(CLASS_URL);
    const card = byTestId('quiz-card-deployment-check');
    expect(card).not.toBeNull();
    expect(text(card)).toContain('Deployment check');
    expect(text(card)).toContain(QUIZ_RESULTS_COPY.noAttempts);
    expect(card?.querySelector('svg')).toBeNull();
    expect(byTestId('quiz-bands-deployment-check')).toBeNull();
    expect(byTestId('quiz-questions-deployment-check')).toBeNull();
    // The sat quiz does draw both.
    expect(byTestId('quiz-bands-design-check')).not.toBeNull();
    expect(byTestId('quiz-pass-rate-chart')).not.toBeNull();
  });

  it('scores are shown to one decimal at most (display only)', async () => {
    summary = () => {
      const body = quizFixture();
      body.quizzes[0].meanBestScore = 66.66666;
      body.quizzes[0].medianBestScore = 100;
      return { status: 200, body };
    };
    await open(CLASS_URL);
    const card = byTestId('quiz-card-design-check');
    const stat = (label: string) =>
      text([...(card?.querySelectorAll('dt') ?? [])].find((dt) => text(dt) === label)?.nextElementSibling ?? null);
    expect(stat('Mean best score')).toBe('66.7');
    expect(stat('Median best score')).toBe('100');
  });

  it('draws no question, option, key or explanation, and no email, whatever rides on the answer', async () => {
    summary = () => ({ status: 200, body: quizFixtureWithSealedText() });
    await open(CLASS_URL);
    // Vacuity: the page did draw the class.
    expect(byTestId('quiz-card-design-check')).not.toBeNull();
    const html = host.innerHTML;
    for (const sealed of SEALED_TEXT) expect(html).not.toContain(sealed);
    expect(html).not.toContain('@example.test');
  });

  it('a refused read says so in words and draws no chart', async () => {
    summary = () => ({ status: 404, body: { message: 'That class is not one of yours.' } });
    await open(CLASS_URL);
    const alert = host.querySelector('[role="alert"]');
    expect(text(alert)).toBe('That class is not one of yours.');
    expect(byTestId('quiz-pass-rate-chart')).toBeNull();
  });
});

describe('the four class-only downloads', () => {
  it('four buttons, each saving its file for this class alone', async () => {
    await open(CLASS_URL);
    const panel = byTestId('quiz-results-downloads');
    expect(panel).not.toBeNull();
    expect(text(panel)).toContain(QUIZ_RESULTS_COPY.downloads);
    const buttons = [...(panel?.querySelectorAll('button') ?? [])];
    expect(buttons).toHaveLength(4);
    for (const [index, kind] of QUIZ_RESULTS_EXPORT_KINDS.entries()) {
      await act(async () => buttons[index].click());
      await settle(4);
      expect(asked.at(-1)).toBe(`/instructor/quiz-results/${kind}.csv?cohort=${encodeURIComponent(FIXTURE_CLASS_ID)}`);
      expect(mocks.saveBlob).toHaveBeenLastCalledWith(expect.any(Blob), `quiz-${kind}.csv`);
    }
    // Never the every-class file.
    expect(asked.filter((url) => /\.csv$/.test(url))).toEqual([]);
    expect(mocks.saveBlob).toHaveBeenCalledTimes(4);
  });
});

describe('a learner is sent home', () => {
  it('replaces the route with the dashboard and reads nothing', async () => {
    setAuthSession('quiz-learner-token', { id: 'learner', role: 'LEARNER', displayName: 'Learner' } as never);
    await open(CLASS_URL);
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
    expect(asked).toEqual([]);
    expect(byTestId('quiz-card-design-check')).toBeNull();
  });
});

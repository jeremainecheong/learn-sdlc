// @vitest-environment jsdom
/**
 * The teacher's "Learning gain" view of the quiz results
 * page, /teacher/class/quiz-results?class=<id>&view=gain.
 *
 * One card per phase from `GET /instructor/quiz-results/learning-gain`: the
 * before average, the after average, the change, how many learners took both
 * checks, a small paired bar and a per-learner table, plus one download of the
 * learning-gain CSV for the class. The default view of the page does not
 * read the learning gain; it only offers the way to this view.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setAuthSession } from '@/lib/session';
import type { LearningGain } from '@/lib/api-concept';
import { quizFixture } from './fixtures/quiz-results';

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

import QuizResultsRoute from '@/app/(app)/teacher/class/quiz-results/page';
import { instructorApi } from '@/lib/api-instructor';
import { learningGainCsvPath, learningGainPath, signedPoints } from '@/lib/api-concept';

const CLASS = 'class monday/10';
const GAIN_URL = `/teacher/class/quiz-results?class=${encodeURIComponent(CLASS)}&view=gain`;

const gainFixture = (): LearningGain => ({
  phases: [
    {
      phaseKey: 'requirements',
      title: 'Requirements',
      n: 2,
      beforeAvgPct: 41.7,
      afterAvgPct: 75,
      deltaPct: 33.3,
      learners: [
        { learner: 'Ada Lovelace', beforePct: 50, afterPct: 83.3, deltaPct: 33.3 },
        { learner: 'Ben Okafor', beforePct: 33.3, afterPct: 66.7, deltaPct: 33.3 },
        { learner: 'Cy Tan', beforePct: 66.7, afterPct: null, deltaPct: null },
      ],
    },
    {
      phaseKey: 'design',
      title: 'Design',
      n: 0,
      beforeAvgPct: null,
      afterAvgPct: null,
      deltaPct: null,
      learners: [],
    },
  ],
});

let host: HTMLDivElement;
let root: Root;
let asked: string[] = [];
let gain: () => { status: number; body: unknown } = () => ({ status: 200, body: gainFixture() });

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

beforeEach(() => {
  vi.clearAllMocks();
  asked = [];
  gain = () => ({ status: 200, body: gainFixture() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url.replace(/^https?:\/\/[^/]+\/api\/v1/, ''));
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (url.includes('/instructor/quiz-results/learning-gain.csv')) {
        // The API's header, in the other quiz files' register.
        return new Response('phaseKey,learner,before %,after %,change (points)\r\n', {
          status: 200,
          headers: { 'content-type': 'text/csv' },
        });
      }
      if (url.includes('/instructor/quiz-results/learning-gain')) {
        const { status, body } = gain();
        return json(status, body);
      }
      if (url.includes('/instructor/quiz-results/summary')) return json(200, quizFixture());
      return json(404, { message: 'Not found.' });
    }),
  );
  setAuthSession('rf-concept-gain', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
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

describe('the learning-gain client', () => {
  it('builds the class-scoped read and CSV paths', () => {
    expect(learningGainPath(CLASS)).toBe(`/instructor/quiz-results/learning-gain?cohort=${encodeURIComponent(CLASS)}`);
    expect(learningGainCsvPath(CLASS)).toBe(
      `/instructor/quiz-results/learning-gain.csv?cohort=${encodeURIComponent(CLASS)}`,
    );
    expect(learningGainPath()).toBe('/instructor/quiz-results/learning-gain');
    expect(learningGainCsvPath()).toBe('/instructor/quiz-results/learning-gain.csv');
  });

  it('says a change with its sign, in points', () => {
    expect(signedPoints(33.3)).toBe('+33 points');
    expect(signedPoints(-12.6)).toBe('-13 points');
    expect(signedPoints(0)).toBe('0 points');
    expect(signedPoints(null)).toBe('No change yet');
  });

  it('the instructor client reads and downloads through those paths', async () => {
    await instructorApi.learningGain(CLASS);
    await instructorApi.exportLearningGain(CLASS);
    expect(asked).toEqual([learningGainPath(CLASS), learningGainCsvPath(CLASS)]);
  });
});

describe('the default quiz results view only offers the way in', () => {
  it('links to the learning-gain view and reads nothing new', async () => {
    await open(`/teacher/class/quiz-results?class=${encodeURIComponent(CLASS)}`);
    const tab = byTestId('quiz-view-gain');
    expect(text(tab)).toBe('Learning gain');
    expect(tab?.getAttribute('href')).toBe(GAIN_URL);
    expect(asked.some((url) => url.includes('learning-gain'))).toBe(false);
  });
});

describe('the learning-gain view', () => {
  it('reads learning gain for the class once and draws one card per phase', async () => {
    await open(GAIN_URL);
    expect(asked.filter((url) => url.includes('learning-gain'))).toEqual([learningGainPath(CLASS)]);
    // The class name for the title still comes from the summary read.
    expect(text(host.querySelector('h1'))).toBe('Monday 10am');
    expect(byTestId('quiz-view-gain')?.getAttribute('aria-current')).toBe('page');
    const card = byTestId('learning-gain-requirements');
    expect(card).not.toBeNull();
    expect(text(card?.querySelector('h3') ?? null)).toBe('Requirements');
    expect(text(byTestId('learning-gain-before-requirements'))).toBe('Before 42%');
    expect(text(byTestId('learning-gain-after-requirements'))).toBe('After 75%');
    expect(text(byTestId('learning-gain-delta-requirements'))).toBe('Change +33 points');
    expect(text(byTestId('learning-gain-n-requirements'))).toBe('Learners with both checks 2');
  });

  it('draws a paired bar whose widths are the two averages', async () => {
    await open(GAIN_URL);
    const before = byTestId('learning-gain-bar-before-requirements');
    const after = byTestId('learning-gain-bar-after-requirements');
    expect(before?.style.width).toBe('41.7%');
    expect(after?.style.width).toBe('75%');
    const figure = byTestId('learning-gain-bars-requirements');
    expect(figure?.getAttribute('aria-label')).toBe('Before 42%, after 75%');
  });

  it('lists every learner, with blanks where a check is not taken yet', async () => {
    await open(GAIN_URL);
    const rows = [...(byTestId('learning-gain-table-requirements')?.querySelectorAll('tbody tr') ?? [])].map((row) =>
      [...row.querySelectorAll('th,td')].map((cell) => text(cell)),
    );
    expect(rows).toEqual([
      ['Ada Lovelace', '50%', '83%', '+33 points'],
      ['Ben Okafor', '33%', '67%', '+33 points'],
      ['Cy Tan', '67%', '—', '—'],
    ]);
  });

  it('a phase nobody has taken both checks on says so', async () => {
    await open(GAIN_URL);
    const card = byTestId('learning-gain-design');
    expect(text(card)).toContain('No learner has taken both checks yet.');
    expect(byTestId('learning-gain-table-design')).toBeNull();
    expect(byTestId('learning-gain-bars-design')).toBeNull();
  });

  it('no phases at all says the same', async () => {
    gain = () => ({ status: 200, body: { phases: [] } });
    await open(GAIN_URL);
    expect(text(byTestId('learning-gain-empty'))).toBe('No learner has taken both checks yet.');
  });

  it('downloads the learning-gain CSV for this class', async () => {
    await open(GAIN_URL);
    const button = byTestId('learning-gain-download');
    expect(text(button)).toBe('Download learning-gain CSV');
    await act(async () => button?.click());
    await settle(4);
    expect(asked.at(-1)).toBe(learningGainCsvPath(CLASS));
    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), 'learning-gain.csv');
    // The file is the API's, byte for byte: the web names no column itself.
    const saved = mocks.saveBlob.mock.calls.at(-1)![0] as Blob;
    const body = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(saved);
    });
    expect(body.split('\r\n')[0]).toBe('phaseKey,learner,before %,after %,change (points)');
  });

  it('a failed read says so and offers nothing else', async () => {
    gain = () => ({ status: 500, body: { message: 'Down.' } });
    await open(GAIN_URL);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(byTestId('learning-gain-requirements')).toBeNull();
  });

  it('a learner is sent home and nothing is read', async () => {
    setAuthSession('rf-concept-gain-learner', { id: 'learner', role: 'LEARNER', displayName: 'Learner' } as never);
    await open(GAIN_URL);
    expect(mocks.router.replace).toHaveBeenCalledWith('/dashboard');
    expect(asked).toEqual([]);
  });
});

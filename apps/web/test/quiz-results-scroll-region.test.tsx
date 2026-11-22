// @vitest-environment jsdom
/**
 * Every quiz-results table that can scroll sideways is a named, focusable
 * region.
 *
 * At phone width `.quiz-table-scroll` scrolls (`overflow-x: auto`), and axe's
 * scrollable-region-focusable rule asks that a keyboard can reach it. jsdom
 * has no layout, so the house pattern is static (as in LearnerResultsTable):
 * role="region", tabIndex 0 and a name. A chart's region is named by its own
 * table caption, so each of the several charts on the page has its own name.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, setAuthSession } from '@/lib/session';
import QuizResultsRoute from '@/app/(app)/teacher/class/quiz-results/page';
import { FIXTURE_CLASS_ID, quizFixture } from './fixtures/quiz-results';

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

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/instructor/quiz-results/summary')) {
        return new Response(JSON.stringify(quizFixture()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ message: 'Not found.' }), { status: 404 });
    }),
  );
  setAuthSession('quiz-scroll-token', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  clearSession();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function openPopulatedPage() {
  window.history.replaceState(null, '', `/teacher/class/quiz-results?class=${encodeURIComponent(FIXTURE_CLASS_ID)}`);
  await act(async () => root.render(<QuizResultsRoute />));
  await settle();
  expect(host.querySelector('[data-testid="quiz-results-page"]')).not.toBeNull();
}

/** The region's accessible name: aria-labelledby resolved, else aria-label. */
function regionName(region: Element): string {
  const ids = (region.getAttribute('aria-labelledby') ?? '').trim();
  if (ids) {
    return ids
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(' ')
      .trim();
  }
  return (region.getAttribute('aria-label') ?? '').trim();
}

describe('every sideways-scrolling table on the quiz-results page is a named, focusable region', () => {
  it('one region per table, each role=region, tabindex 0 and a non-empty name', async () => {
    await openPopulatedPage();
    const regions = [...host.querySelectorAll('.quiz-table-scroll')];
    const tables = [...host.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    expect(regions).toHaveLength(tables.length);
    for (const region of regions) {
      expect(region.getAttribute('role')).toBe('region');
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(regionName(region).length).toBeGreaterThan(0);
      // Every table sits inside its own region.
      expect(region.querySelectorAll('table')).toHaveLength(1);
    }
  });

  it('a chart region is named by that chart table caption; names and ids are unique', async () => {
    await openPopulatedPage();
    const charts = [
      ...host.querySelectorAll('[data-testid="quiz-pass-rate-chart"], [data-testid^="quiz-bands-"], [data-testid^="quiz-questions-"]'),
    ];
    const ids = charts.map((chart) => chart.getAttribute('data-testid') ?? '');
    expect(ids).toContain('quiz-pass-rate-chart');
    expect(ids.some((id) => id.startsWith('quiz-bands-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('quiz-questions-'))).toBe(true);

    const names: string[] = [];
    const labelIds: string[] = [];
    for (const chart of charts) {
      const region = chart.querySelector(':scope > details > .quiz-table-scroll');
      expect(region, chart.getAttribute('data-testid') ?? '').not.toBeNull();
      expect(region!.getAttribute('role')).toBe('region');
      expect(region!.getAttribute('tabindex')).toBe('0');
      const caption = region!.querySelector('table > caption');
      expect(text(caption).length).toBeGreaterThan(0);
      expect(regionName(region!)).toBe(text(caption));
      const labelledBy = region!.getAttribute('aria-labelledby');
      if (labelledBy) {
        expect(caption!.id).toBe(labelledBy);
        labelIds.push(labelledBy);
      }
      names.push(regionName(region!));
    }
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(labelIds).size).toBe(labelIds.length);
    // An id is unique in the whole document, not only among the charts.
    const allIds = [...document.querySelectorAll('[id]')].map((el) => el.id);
    for (const id of labelIds) expect(allIds.filter((other) => other === id)).toHaveLength(1);
  });

  it('the learner table keeps its region, named by its section heading', async () => {
    await openPopulatedPage();
    const region = host.querySelector('[data-testid="quiz-learner-table"] .quiz-table-scroll');
    expect(region).not.toBeNull();
    expect(region!.getAttribute('role')).toBe('region');
    expect(region!.getAttribute('tabindex')).toBe('0');
    expect(regionName(region!)).toBe(text(host.querySelector('#quiz-learners-title')));
  });

  it('the drawing keeps its labelled image, its <details> and the summary→div→table order', async () => {
    await openPopulatedPage();
    const chart = host.querySelector('[data-testid="quiz-pass-rate-chart"]')!;
    const svg = chart.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect((svg.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
    const details = chart.querySelector(':scope > details.quiz-numbers')!;
    expect([...details.children].map((el) => el.tagName)).toEqual(['SUMMARY', 'DIV']);
    expect(details.children[1].firstElementChild?.tagName).toBe('TABLE');
  });
});

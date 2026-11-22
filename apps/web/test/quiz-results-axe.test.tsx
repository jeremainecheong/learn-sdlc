// @vitest-environment jsdom
/**
 * Axe over the quiz-results page at the default width.
 *
 * Through the axe bridge (`./support/axe-bridge`), never an `import ... from
 * 'axe-core'`: the web image does not hold axe-core, and a static import fails
 * its Docker-context gate. Every "Show the numbers" is opened so axe reads the
 * tables too. Contrast is the browser's to measure (the journey runs axe at
 * 1280 and 390); jsdom draws no colour.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizResultsSummary } from '@learnsdlc/shared';
import { clearSession, setAuthSession } from '@/lib/session';
import QuizResultsRoute from '@/app/(app)/teacher/class/quiz-results/page';
import { loadAxe } from './support/axe-bridge';
import { quizFixture } from './fixtures/quiz-results';

const mocks = vi.hoisted(() => ({ router: { replace: vi.fn(), push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  useRouter: () => mocks.router,
  usePathname: () => window.location.pathname,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));

let host: HTMLDivElement;
let root: Root;
let body: QuizResultsSummary = quizFixture();

const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
};

beforeEach(() => {
  body = quizFixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })),
  );
  setAuthSession('quiz-results-axe', { id: 'teacher', role: 'INSTRUCTOR', displayName: 'Teacher' } as never);
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

async function findings(): Promise<string[]> {
  host.querySelectorAll('details').forEach((one) => one.setAttribute('open', ''));
  const axe = await loadAxe();
  const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return result.violations.map((one) => `${one.id}: ${one.nodes.map((node) => node.target.join(' ')).join(', ')}`);
}

async function open() {
  window.history.replaceState(null, '', '/teacher/class/quiz-results?class=class-one');
  await act(async () => root.render(<QuizResultsRoute />));
  await settle();
}

describe('axe on /teacher/class/quiz-results', () => {
  it('the full page (every chart, every table opened): 0 violations', async () => {
    await open();
    // Vacuity: the charts, the learner table and the downloads are drawn.
    const images = [...host.querySelectorAll('svg')];
    expect(images.length).toBeGreaterThanOrEqual(3);
    expect(images.every((svg) => svg.getAttribute('role') === 'img')).toBe(true);
    expect(host.querySelector('[data-testid="quiz-learner-table"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="quiz-results-downloads"]')).not.toBeNull();
    expect(host.querySelectorAll('details table').length).toBeGreaterThanOrEqual(3);
    expect(await findings()).toEqual([]);
  });

  it('an empty class: 0 violations', async () => {
    body = { ...quizFixture(), learnersInClass: 0, learners: [], quizzes: [] };
    await open();
    expect(host.querySelector('[data-testid="quiz-results-empty"]')).not.toBeNull();
    expect(await findings()).toEqual([]);
  });

  it('the helper is armed: a nameless image is reported', async () => {
    await open();
    const first = host.querySelector('svg');
    expect(first).not.toBeNull();
    first?.removeAttribute('aria-label');
    expect((await findings()).some((line) => line.startsWith('svg-img-alt'))).toBe(true);
  });
});

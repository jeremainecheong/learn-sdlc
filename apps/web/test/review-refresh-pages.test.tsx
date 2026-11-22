// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from '@/app/(app)/dashboard/page';
import ProgressPage from '@/app/(app)/progress/page';
import PortfolioPage from '@/app/(app)/artefacts/page';
import CompletionPage from '@/app/(app)/completion/page';
import ProfilePage from '@/app/(app)/profile/page';

const mocks = vi.hoisted(() => ({ refreshError: '', refreshing: false, refresh: vi.fn() }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
// Home's project map opens a block's phase door through the app router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/useProject', () => {
  const phase = { id: 'phase', key: 'requirements', order: 1, title: 'Requirements', status: 'in_progress', attempts: 0 };
  return { useProject: () => ({ enrollment: { id: 'enrollment', phases: [phase] }, currentPhase: phase, loading: false }) };
});
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ id: 'owner', role: 'LEARNER', displayName: 'Learner', email: 'learner@example.test', avatar: 0, cohort: 'default', profileVersion: 0 }) }));
vi.mock('@/components/experience/shared', async original => ({ ...await original<typeof import('@/components/experience/shared')>(), useReviews: () => ({ reviews: [], hasLoaded: true, loading: false, refreshing: mocks.refreshing, refreshError: mocks.refreshError, error: '', refresh: mocks.refresh }) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); mocks.refreshError = ''; mocks.refreshing = false; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('known empty review history survives refresh failures', () => {
  it.each([
    ['dashboard', DashboardPage, '.exp-dashboard-top'],
    ['progress', ProgressPage, '.exp-journey'],
    ['portfolio', PortfolioPage, '.exp-grid-even'],
    ['completion', CompletionPage, '.exp-completion-locked'],
    ['profile', ProfilePage, '.exp-profile-summary'],
  ] as const)('keeps %s content mounted with a retry notice instead of a blocking load error', async (_name, Page, selector) => {
    await act(async () => root.render(<Page/>));
    const content = host.querySelector(selector); expect(content).not.toBeNull();
    mocks.refreshError = 'The latest review history is unavailable.';
    await act(async () => root.render(<Page/>));
    expect(host.querySelector(selector)).toBe(content); expect(host.textContent).toContain('Your last loaded review history is still shown.');
    const retry = [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry reviews')!;
    await act(async () => retry.click()); expect(mocks.refresh).toHaveBeenCalledTimes(1);
    mocks.refreshing = true; await act(async () => root.render(<Page/>));
    expect(host.querySelector(selector)).toBe(content); expect(host.textContent).toContain('Checking for newer reviews.');
    expect([...host.querySelectorAll('button')].find(button => button.textContent === 'Refreshing reviews…')?.disabled).toBe(true);
    mocks.refreshError = ''; mocks.refreshing = false; await act(async () => root.render(<Page/>));
    expect(host.querySelector(selector)).toBe(content); expect(host.querySelector('[aria-label="Review history refresh"]')).toBeNull();
  });
});

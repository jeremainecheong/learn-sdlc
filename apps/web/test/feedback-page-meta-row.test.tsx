// @vitest-environment jsdom
/**
 * The feedback page: its meta row does not print a fixed "Pass / Needs
 * revision", which could contradict the shown review; the verdict is the
 * badge above it. The page also hands the evidence the phase's floors, so a
 * rule set to 0 reads as not required.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({ details: {} as Record<string, unknown>, reviews: [] as unknown[], evidence: [] as Record<string, unknown>[] }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(''), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/feedback' }));
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    loading: false,
    details: rig.details,
    enrollment: { id: 'e', projectSlug: 'deadline', phases: [{ id: 'dep', key: 'deployment', title: 'Deployment', order: 5, status: 'passed', attempts: 1 }] },
  }),
}));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: rig.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: () => {} }),
}));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: (props: Record<string, unknown>) => { rig.evidence.push(props); return null; } }));

const { default: FeedbackPage } = await import('@/app/(app)/feedback/page');

const FLOOR = { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true };
const review = (passed: boolean) => ({
  phase: { id: 'dep', key: 'deployment', title: 'Deployment', order: 5, status: 'passed', attempts: 1 },
  submission: { id: 'rev-1', phaseStateId: 'dep', status: 'completed', passed, verifiedPass: passed, createdAt: '2026-11-17T03:13:00.000Z', reviewUnavailable: false, attempt: 1 },
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  rig.evidence.length = 0;
  rig.details = { dep: { id: 'dep', key: 'deployment', title: 'Deployment', order: 5, status: 'passed', tasks: [], runbook: FLOOR } };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the feedback page', () => {
  for (const passed of [true, false]) {
    it(`a ${passed ? 'passing' : 'refused'} review: the meta row names the phase and the review, not "Pass / Needs revision"`, async () => {
      rig.reviews = [review(passed)];
      await act(async () => root.render(<FeedbackPage />));
      const meta = host.querySelector('.exp-result-meta')!;
      expect(meta.textContent).toContain('Deployment');
      expect(meta.textContent).toContain('Review 1');
      expect(meta.textContent).not.toContain('Pass / Needs revision');
      expect(meta.querySelectorAll(':scope > span')).toHaveLength(2);
    });
  }
  it('hands the evidence the phase\'s floors', async () => {
    rig.reviews = [review(true)];
    await act(async () => root.render(<FeedbackPage />));
    expect((rig.evidence.at(-1)?.floors as { runbook?: unknown })?.runbook).toEqual(FLOOR);
  });
});

// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PhaseSummary } from '@learnsdlc/shared';
import type { Review } from '@/components/experience/shared';
import LearnPage from '@/app/(app)/learn/page';
import FeedbackPage from '@/app/(app)/feedback/page';
const mocks = vi.hoisted(() => ({ role: 'LEARNER', reviews: [] as Review[], phases: [] as PhaseSummary[] }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ id: 'viewer', role: mocks.role }) }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ enrollment: { phases: mocks.phases }, loading: false }) }));
vi.mock('@/components/experience/shared', async original => ({ ...await original<typeof import('@/components/experience/shared')>(), useReviews: () => ({ reviews: mocks.reviews, loading: false, error: null }) }));
vi.mock('@/components/experience/SubmissionEvidence', () => ({ SubmissionEvidence: ({ submissionId }: { submissionId: string }) => <p data-testid="evidence">{submissionId}</p> }));
let host: HTMLDivElement, root: Root;
const design: PhaseSummary = { id: 'design-phase', key: 'design', order: 2, title: 'Design', status: 'in_progress', attempts: 1, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null };
const maintenance: PhaseSummary = { id: 'maintenance-phase', key: 'maintenance', order: 6, title: 'Maintenance', status: 'in_progress', attempts: 1, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null };
beforeEach(() => { mocks.role = 'LEARNER'; mocks.phases = [design]; mocks.reviews = []; window.history.replaceState(null, '', '/learn'); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('returns learners to the actual Design working room and staff to teaching from the catalogue', async () => {
  await act(async () => root.render(<LearnPage />));
  const project = [...host.querySelectorAll('a')].find(link => link.textContent?.includes('Go to my project'))!;
  expect(project.getAttribute('href')).toBe('/workspace/design-phase/design');
  mocks.role = 'INSTRUCTOR'; mocks.phases = [];
  await act(async () => root.render(<LearnPage />));
  const teaching = [...host.querySelectorAll('a')].find(link => link.textContent?.includes('Back to teaching'))!;
  expect(teaching.getAttribute('href')).toBe('/teacher');
});
it('resolves a submission-only feedback deep link to its historical phase and correct project room', async () => {
  mocks.phases = [design, maintenance];
  mocks.reviews = [
    { phase: design, submission: { id: 'old-design', phaseStateId: design.id, verifiedPass: false, attempt: 1, passed: false, status: 'completed', reviewUnavailable: false, createdAt: '2026-09-11T00:00:00Z' } },
    { phase: maintenance, submission: { id: 'latest-maintenance', phaseStateId: maintenance.id, verifiedPass: false, attempt: 1, passed: false, status: 'completed', reviewUnavailable: false, createdAt: '2026-09-12T00:00:00Z' } },
  ];
  window.history.replaceState(null, '', '/feedback?submission=old-design');
  await act(async () => root.render(<FeedbackPage />));
  expect(host.querySelector('[data-testid="evidence"]')?.textContent).toBe('old-design');
  expect([...host.querySelectorAll('a')].find(link => link.textContent?.includes('Revise your work'))?.getAttribute('href')).toBe('/workspace/design-phase/design');
});

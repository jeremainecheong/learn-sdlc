// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Review } from '@/components/experience/shared';
import type { PhaseSummary } from '@learnsdlc/shared';
import CompletionPage from '@/app/(app)/completion/page';

const state = vi.hoisted(() => ({ phases: [] as PhaseSummary[], reviews: [] as Review[] }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ loading: false, enrollment: { id: 'enrollment', projectSlug: 'tasktrackr', completed: true, completedAt: '2026-09-15T01:00:00Z', phases: state.phases } }) }));
const exported = vi.hoisted(() => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/download', async original => ({ ...await original<typeof import('@/lib/download')>(), saveBlob: exported.saveBlob }));
vi.mock('@/lib/api', async original => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, api: { ...real.api,
    myEnrollment: async () => ({ id: 'enrollment', projectSlug: 'tasktrackr', completed: true, completedAt: '2026-09-15T01:00:00Z', phases: state.phases }),
    getSubmissionWithFiles: async (id: string) => ({ id, files: {} }),
  } };
});
vi.mock('@/lib/api-experience', async original => {
  const real = await original<typeof import('@/lib/api-experience')>();
  return { ...real, experienceApi: { ...real.experienceApi,
    history: async () => state.reviews.map(review => review.submission),
    teacherFeedback: async () => null,
  } };
});
vi.mock('@/lib/session', async original => ({ ...await original<typeof import('@/lib/session')>(), useSession: () => ({ displayName: 'Recorded learner' }) }));
vi.mock('@/components/experience/shared', async original => ({
  ...await original<typeof import('@/components/experience/shared')>(),
  ExperiencePage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useReviews: () => ({ reviews: state.reviews, loading: false, error: '', refresh: vi.fn() }),
}));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  const keys = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
  state.phases = keys.map((key, index) => ({ id: key, key, title: key, order: index + 1, status: 'passed', attempts: 2, bestScore: 90, reflection: null, opensAt: null, dueAt: null, passedAt: '2026-09-14T01:00:00Z' }));
  state.reviews = state.phases.flatMap(phase => [false, true].map((passed, index) => ({ phase, submission: {
    id: `${phase.id}-${index}`, phaseStateId: phase.id, status: 'completed', passed, verifiedPass: passed,
    reviewUnavailable: false, attempt: index + 1, createdAt: `2026-09-14T0${index}:00:00Z`,
  } })));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('counts every saved phase submission, including refunded infrastructure failures', async () => {
  for (const [key, failures] of [['implementation', 3], ['testing', 1], ['maintenance', 1]] as const) {
    const phase = state.phases.find(item => item.key === key)!;
    for (let index = 0; index < failures; index++) state.reviews.push({ phase, submission: {
      id: `${key}-unavailable-${index}`, phaseStateId: phase.id, status: 'failed', passed: null,
      verifiedPass: false, reviewUnavailable: true, attempt: 2, createdAt: '2026-09-14T00:30:00Z',
    } });
  }
  await act(async () => root.render(<CompletionPage />));
  const cards = [...host.querySelectorAll('.exp-completion-portfolio-item')];
  expect(cards.map(card => card.querySelector('p')?.textContent)).toEqual([
    '2 recorded submissions', '2 recorded submissions', '5 recorded submissions',
    '3 recorded submissions', '2 recorded submissions', '3 recorded submissions',
  ]);
  expect(cards.map(card => card.getAttribute('href'))).toEqual(state.phases.map(phase => `/feedback?phase=${phase.id}&submission=${phase.id}-1`));
  expect(state.reviews).toHaveLength(17);
});

it('does not turn saved unavailable attempts or a stale phase status into completion', async () => {
  const last = state.reviews.at(-1)!;
  last.submission = { ...last.submission, status: 'failed', passed: null, verifiedPass: false, reviewUnavailable: true };
  await act(async () => root.render(<CompletionPage />));
  expect(host.textContent).toContain('1 phase to bring it all together.');
  expect(host.querySelector('.exp-completion-portfolio')).toBeNull();
  expect(host.textContent).not.toContain('Export project record');
});

it('keeps the record and its export of a finished project while a phase is being retried', async () => {
  // A learner's retry puts a passed phase back in progress and keeps its pass
  // date; the server's record stays complete, and so does this page.
  state.phases[0] = { ...state.phases[0], status: 'in_progress' };
  await act(async () => root.render(<CompletionPage />));
  expect(host.textContent).toContain('PROJECT COMPLETION RECORD');
  expect(host.textContent).not.toContain('to bring it all together');
  const button = [...host.querySelectorAll('button')].find(one => one.textContent?.includes('Export project record'))!;
  await act(async () => button.click());
  await act(async () => {});
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(exported.saveBlob).toHaveBeenCalledTimes(1);
});

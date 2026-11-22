// @vitest-environment jsdom
/**
 * The third learner-side "In review" twin: the portfolio's phase header.
 *
 * A phase reads `submitted` once a verdict has landed on it without opening
 * its gate: `nextPhaseStatus` writes it for a one-task phase whose revision
 * needed revision, and `phaseRollup` writes it over a split phase after ANY
 * verdict that leaves the gate shut. Handing a revision in moves no status at
 * all. So a status-only badge would say "In review" about work that has been
 * reviewed, on TaskTrackr's own phases as much as a teacher's.
 *
 * The page holds the phase's revisions, so it says what the six-tile
 * path says for the same phase (`PhasePath` in `experience/shared.tsx`): a
 * one-task phase shows its newest revision's verdict, a split phase says "In
 * review" only while its newest revision is queued or running and "In
 * progress" otherwise, and a `submitted` phase whose revisions have not been
 * read yet is "In progress", which is true of it whatever they hold.
 */
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseSummary, PhaseTaskCounts } from '@learnsdlc/shared';
import PortfolioPage from '@/app/(app)/artefacts/page';
import ProgressPage from '@/app/(app)/progress/page';
import type { SubmissionHistoryItem } from '@/lib/api-experience';

type ReviewRow = { phase: PhaseSummary; submission: SubmissionHistoryItem };

const mocks = vi.hoisted(() => ({ phases: [] as PhaseSummary[], reviews: [] as ReviewRow[] }));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ enrollment: { id: 'enrollment', phases: mocks.phases }, currentPhase: mocks.phases[0], loading: false }),
}));
vi.mock('@/lib/session', async original => ({
  ...await original<typeof import('@/lib/session')>(),
  useSession: () => ({ id: 'owner', role: 'LEARNER', displayName: 'Learner', email: 'learner@example.test', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));
vi.mock('@/components/experience/shared', async original => ({
  ...await original<typeof import('@/components/experience/shared')>(),
  useReviews: () => ({ reviews: mocks.reviews, hasLoaded: true, loading: false, refreshing: false, refreshError: '', error: '', refresh: vi.fn() }),
}));

const SPLIT: PhaseTaskCounts = { total: 3, required: 2, passed: 1, passedRequired: 1 };

const phase = (over: Partial<PhaseSummary> = {}): PhaseSummary => ({
  id: 'phase-one',
  key: 'requirements',
  order: 1,
  title: 'Requirements',
  status: 'in_progress',
  bestScore: null,
  attempts: 0,
  reflection: null,
  passedAt: null,
  opensAt: null,
  dueAt: null,
  ...over,
});

const review = (over: Partial<SubmissionHistoryItem> = {}): ReviewRow => ({
  phase: phase(),
  submission: {
    id: 'submission-one',
    phaseStateId: 'phase-one',
    status: 'completed',
    passed: true,
    verifiedPass: true,
    createdAt: '2026-09-18T09:00:00.000Z',
    commitMessage: null,
    attempt: 1,
    ...over,
  },
});

/** The Requirements panel's header badge on the portfolio, and the Requirements tile on the progress path. */
const standing = async (phases: PhaseSummary[], reviews: ReviewRow[] = []): Promise<{ header: string; tile: string }> => {
  mocks.phases = phases;
  mocks.reviews = reviews;
  const read = async (Page: () => ReactNode, selector: string): Promise<string> => {
    const box = document.createElement('div');
    document.body.append(box);
    const tree = createRoot(box);
    await act(async () => tree.render(<Page /> as never));
    const text = box.querySelector(selector)?.textContent ?? '';
    await act(async () => tree.unmount());
    box.remove();
    return text;
  };
  return {
    header: await read(PortfolioPage, '.exp-panel .exp-section-heading .exp-status'),
    tile: await read(ProgressPage, '.exp-phase-step'),
  };
};

beforeEach(() => { mocks.phases = []; mocks.reviews = []; });
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('the portfolio header says where a phase stands, not "In review" off its status', () => {
  it('shows a one-task phase marked without a pass as Needs revision, as its tile does', async () => {
    const { header, tile } = await standing(
      [phase({ status: 'submitted', attempts: 1 })],
      [review({ passed: false, verifiedPass: false })],
    );
    expect(header).toBe('Needs revision');
    expect(tile).toContain('Needs revision');
  });

  it('shows a one-task phase whose newest revision is being marked as its tile does', async () => {
    for (const status of ['queued', 'running'] as const) {
      const { header, tile } = await standing(
        [phase({ status: 'submitted', attempts: 2 })],
        [review({ passed: false, verifiedPass: false }), review({ id: 'submission-two', status, passed: null, verifiedPass: false, attempt: 2 })],
      );
      expect(header).toBe('Review in progress');
      expect(tile).toContain('Review in progress');
    }
  });

  it('says In review on a split phase only while its newest revision is being marked', async () => {
    for (const status of ['queued', 'running'] as const) {
      const { header } = await standing(
        [phase({ status: 'submitted', attempts: 3, taskCounts: SPLIT })],
        [review(), review({ id: 'submission-two', status, passed: null, verifiedPass: false, attempt: 2 })],
      );
      expect(header).toBe('In review');
    }
    // A pass on one task, the gate still shut: the phase is being worked.
    const { header, tile } = await standing([phase({ status: 'submitted', attempts: 2, taskCounts: SPLIT })], [review()]);
    expect(header).toBe('In progress');
    expect(tile).toContain('In progress');
  });

  /*
   * The parity must hold beyond a `submitted` phase too. A phase's FIRST
   * revision is marked while the phase is still `in_progress` (handing it in
   * moves no status) and there the header must not say "In progress" beside
   * a tile saying the review is running.
   */
  it('says what its tile says while the first revision of an in-progress phase is marked', async () => {
    for (const status of ['queued', 'running'] as const) {
      const one = await standing(
        [phase({ status: 'in_progress', attempts: 1 })],
        [review({ status, passed: null, verifiedPass: false })],
      );
      expect(one.header).toBe('Review in progress');
      expect(one.tile).toContain('Review in progress');

      const split = await standing(
        [phase({ status: 'in_progress', attempts: 1, taskCounts: SPLIT })],
        [review({ status, passed: null, verifiedPass: false })],
      );
      expect(split.header).toBe('In review');
      expect(split.tile).toContain('In review');
    }
  });

  it('says In progress, not In review, while a submitted phase’s revisions are not yet read', async () => {
    const { header } = await standing([phase({ status: 'submitted', attempts: 1 })], []);
    expect(header).toBe('In progress');
  });

  it('gives every other state its own word: Pass, Locked, In progress', async () => {
    expect((await standing([phase({ status: 'passed', attempts: 1 })], [review()])).header).toBe('Pass');
    expect((await standing([phase({ status: 'locked' })])).header).toBe('Locked');
    expect((await standing([phase({ status: 'in_progress' })])).header).toBe('In progress');
    expect((await standing([phase({ status: 'in_progress', attempts: 1 })], [review({ passed: false, verifiedPass: false })])).header).toBe('In progress');
  });
});

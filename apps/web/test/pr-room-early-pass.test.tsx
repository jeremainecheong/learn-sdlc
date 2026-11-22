// @vitest-environment jsdom
/**
 * The pull request room, mounted as its route exports it, on two states.
 *
 *  - A phase the learner passed ahead of time (a teacher's Unlock early, then
 *    the learner's own submit and a passing review): the review passed, and
 *    Merge waits only for the learner to reach the phase. The room must not
 *    say "Needs revision", draw a fail square or say "Available after a Pass".
 *  - The answer-key door: it follows `solution.awaitingReview`, not the board
 *    alone.
 *
 * Only the pull-request data hook, the shell's held project and the network
 * are stood in for; the page, the real `MergeCard` and the real door check run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  phase: {} as Record<string, unknown>,
  head: {} as Record<string, unknown>,
}));
const base = () => ({
  id: 'phase-pr-ahead',
  key: 'implementation',
  title: 'Implementation',
  order: 3,
  place: 3,
  count: 6,
  status: 'passed',
  projectSlug: 'room-desk',
  rubric: {},
  attempts: 1,
  reflection: null,
  solution: { available: true, files: 4, readAt: null },
});
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-pr-ahead' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn(), reflect: vi.fn(), advance: vi.fn() } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: { 'phase-pr-ahead': mocks.phase },
    enrollment: { projectTitle: 'RoomDesk', phases: [], releases: [], currentPhaseOrder: 2, completed: false },
    analytics: null,
    currentPhase: null,
    reload: vi.fn(async () => undefined),
  }),
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) => (
    <div>
      <div data-testid="frame-right">{right}</div>
      {children}
    </div>
  ),
}));
vi.mock('@/components/shell', () => ({
  DocPage: () => null,
  briefHref: () => '/brief',
  doorWithTasks: (phase: unknown) => phase,
  phaseDoorHref: () => '/workspace/next',
  solutionHref: () => '/solution',
  usePersona: () => null,
  PERSONA_NAME: { implementation: 'Riley' },
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/pr', async () => {
  const { MergeCard } = await import('@/components/pr/MergeCard');
  return {
    MergeCard,
    Conversation: () => null,
    DiffView: () => null,
    ChecksCard: () => null,
    SubmissionsCard: () => null,
    ChecksTab: () => null,
    HistoryCard: () => null,
    gateReason: () => 'Resolve every failed criterion and missing piece of evidence, then submit a new revision.',
    prHeadline: () => 'The change is reviewed',
    usePullRequest: () => ({
      detail: mocks.phase,
      head: mocks.head,
      threads: [],
      diffs: [],
      revisions: [mocks.head],
      gate: 0,
      fileRevision: mocks.head,
      fileBase: null,
      threadsFor: () => [],
      selectRevision: vi.fn(),
      submit: vi.fn(),
      filesKept: () => true,
      reload: vi.fn(async () => undefined),
      setError: vi.fn(),
      setNotice: vi.fn(),
    }),
  };
});
const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');

let host: HTMLDivElement, root: Root;
const merge = () => host.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!;
const door = () => host.querySelector('[data-testid="solution-open"]');
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PullRequestPage />));
};
const passing = { id: 'rev-1', attempt: 1, score: 100, state: 'done', report: { passed: true, aiReview: { assessmentError: false } } };

beforeEach(() => {
  mocks.phase = base();
  mocks.head = passing;
});
afterEach(() => {
  // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
  expect(host.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
  act(() => root.unmount());
  host.remove();
});

describe('the pull request of a phase passed ahead of the learner', () => {
  it('reads the review that passed as a pass, and holds Merge only until the learner reaches it', async () => {
    mocks.phase = { ...base(), notReachedYet: true };
    await mount();
    const text = host.textContent ?? '';
    expect(text).not.toContain('Needs revision');
    expect(text).toContain('Pass. Every required criterion has acceptable evidence.');
    expect(merge().disabled).toBe(true);
    expect(text).toContain('Available once you reach this phase');
    expect(text).not.toContain('Available after a Pass');
  });

  it('does not read a board-only Pass ahead of the learner as a review', async () => {
    const failing = { ...passing, report: { passed: false, aiReview: { assessmentError: false } } };
    mocks.head = failing;
    mocks.phase = { ...base(), notReachedYet: true, evidenceNeeded: [{ key: '', title: 'Implementation' }] };
    await mount();
    const text = host.textContent ?? '';
    expect(text).toContain('Needs revision');
    expect(merge().disabled).toBe(true);
  });

  it('is the ordinary merge on the phase the learner stands on', async () => {
    await mount();
    expect(merge().disabled).toBe(false);
    expect(host.textContent).toContain('Ready to merge');
  });
});

describe('the answer-key door on the pull request', () => {
  it('is drawn on a pass the review accepted', async () => {
    await mount();
    expect(door()).not.toBeNull();
  });

  it('is not drawn where the board reads passed but no reviewed pass stands behind it', async () => {
    mocks.phase = { ...base(), solution: { available: true, files: 4, readAt: null, awaitingReview: true } };
    await mount();
    expect(door()).toBeNull();
  });
});

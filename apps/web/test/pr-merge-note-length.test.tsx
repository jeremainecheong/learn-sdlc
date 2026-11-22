// @vitest-environment jsdom
/**
 * The pull-request page's own advance door, with the real `MergeCard`.
 *
 * The PR page's `MergeCard` must count a reflection the way the API's
 * `ReflectDto` does (class-validator's `isLength`: a surrogate pair is one
 * character), not with `String.length`. Ten emoji are 20 UTF-16 units but ten
 * characters to the API, so a `String.length` count lights Merge, `/reflect`
 * answers 400 and the merge does not happen. The page is mounted as its route
 * exports it; only the pull-request data hook, the shell's held project and
 * the network are stood in for.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reflect: vi.fn(),
  advance: vi.fn(),
  calls: [] as string[],
  phase: {
    id: 'phase-pr-merge',
    key: 'maintenance',
    title: 'Maintenance',
    order: 6,
    place: 6,
    count: 6,
    status: 'passed',
    projectSlug: 'room-desk',
    rubric: {},
    attempts: 1,
    reflection: null,
  },
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: mocks.phase.id }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn(), reflect: mocks.reflect, advance: mocks.advance } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: { [mocks.phase.id]: mocks.phase },
    enrollment: { projectTitle: 'RoomDesk', phases: [], releases: [], currentPhaseOrder: 6, completed: false },
    analytics: null,
    currentPhase: null,
    reload: vi.fn(async () => undefined),
  }),
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/shell', () => ({
  DocPage: () => null,
  briefHref: () => '/brief',
  doorWithTasks: (phase: unknown) => phase,
  phaseDoorHref: () => '/workspace/next',
  solutionHref: () => '/solution',
  usePersona: () => null,
  PERSONA_NAME: { maintenance: 'Sage' },
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/pr', async () => {
  // The real merge card; everything else the page draws is stood in for.
  const { MergeCard } = await import('@/components/pr/MergeCard');
  const head = { id: 'rev-1', attempt: 1, score: 100, report: { passed: true, aiReview: { assessmentError: false } } };
  return {
    MergeCard,
    Conversation: () => null,
    DiffView: () => null,
    ChecksCard: () => null,
    SubmissionsCard: () => null,
    ChecksTab: () => null,
    HistoryCard: () => null,
    gateReason: () => '',
    prHeadline: () => 'The change is reviewed',
    usePullRequest: () => ({
      detail: mocks.phase,
      head,
      threads: [],
      diffs: [],
      revisions: [head],
      gate: 0,
      fileRevision: head,
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
const note = () => host.querySelector<HTMLTextAreaElement>('[data-testid="reflection-input"]')!;
const merge = () => host.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!;
const write = (value: string) => act(() => { fireEvent.change(note(), { target: { value } }); });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.reflect.mockImplementation(async () => { mocks.calls.push('reflect'); return { saved: true }; });
  mocks.advance.mockImplementation(async () => { mocks.calls.push('advance'); return { completed: false, phases: [], currentPhaseOrder: 6 }; });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PullRequestPage />));
});
afterEach(() => {
  // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
  expect(host.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
  act(() => root.unmount());
  host.remove();
});

describe("the pull request page names the pull request by the phase's place (spec 4.2)", () => {
  it("draws PR-<place>, never LearnSDLC's order", async () => {
    expect(host.textContent).toContain('PR-6');
    mocks.phase.place = 2;
    mocks.phase.count = 3;
    try {
      await act(async () => root.render(<PullRequestPage key="placed-second" />));
      expect(host.textContent).toContain('PR-2');
      expect(host.textContent).not.toContain('PR-6');
    } finally {
      mocks.phase.place = 6;
      mocks.phase.count = 6;
    }
  });
});

describe('the pull request page counts a merge note the way the API does', () => {
  it('holds Merge on ten emoji, which the API counts as ten characters', async () => {
    await write('🙂'.repeat(10));
    expect(merge().disabled).toBe(true);
    expect(host.textContent).toContain('At least 20 characters');
    await act(async () => merge().click());
    expect(mocks.calls).toEqual([]);
  });

  it('merges with the note left blank, posting no note at all', async () => {
    expect(merge().disabled).toBe(false);
    await act(async () => merge().click());
    expect(mocks.calls).toEqual(['advance']);
  });

  it('posts a note the API keeps, trimmed, before the merge', async () => {
    await write('  Naming the boundary first made the rule easy to test.  ');
    expect(merge().disabled).toBe(false);
    await act(async () => merge().click());
    expect(mocks.calls).toEqual(['reflect', 'advance']);
    expect(mocks.reflect).toHaveBeenCalledWith(mocks.phase.id, 'Naming the boundary first made the rule easy to test.');
  });
});

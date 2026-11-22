// @vitest-environment jsdom
/**
 * The Merge card's `submitReason` prop.
 *
 * A prop that disables a control may be removed only if an equal or stronger
 * gate already disables it. This prop is the only thing that turns the card's
 * "Submit again" off while the task a submit would send waits: without it the
 * button is live (proved below on the REAL MergeCard), and the page's
 * `pr.submit` has no wait check of its own. So it stays (a comment at the
 * call says why), and Merge stays off in every waiting case (guard rows on
 * the REAL page).
 *
 * Only the pull-request data hook, the shell's held project and the network
 * are stood in for; the page, the REAL MergeCard and the REAL prHeadline run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  phase: {} as Record<string, unknown>,
  head: {} as Record<string, unknown> | null,
  revisions: null as Record<string, unknown>[] | null,
  enrollment: {} as Record<string, unknown>,
  submit: (() => undefined) as (...args: unknown[]) => unknown,
  advance: (() => undefined) as (...args: unknown[]) => unknown,
}));
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main',
  order: 1,
  required: true,
  title: 'Implementation',
  artefactType: 'code',
  evidence: 'signed-off',
  sealed: true,
  status: 'submitted',
  awaitingSignOff: true,
  attempts: 1,
  bestScore: 88,
  passedAt: null,
  lastSubmissionId: 'rev-1',
  resetAt: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const base = (over: Record<string, unknown> = {}) => ({
  id: 'phase-pr-re',
  key: 'implementation',
  title: 'Implementation',
  order: 3,
  status: 'submitted',
  projectSlug: 'room-desk',
  files: [],
  rubric: {},
  attempts: 1,
  reflection: null,
  solution: { available: false, files: 0, readAt: null },
  tasks: [task()],
  taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
  ...over,
});
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-pr-re' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  api: { chat: vi.fn(), reflect: vi.fn(), advance: (...args: unknown[]) => mocks.advance(...args) },
}));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: { 'phase-pr-re': mocks.phase },
    enrollment: mocks.enrollment,
    analytics: null,
    currentPhase: null,
    reload: vi.fn(async () => undefined),
  }),
  useProjectMaybe: () => null,
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, right, title }: { children: React.ReactNode; right?: React.ReactNode; title?: React.ReactNode }) => (
    <div>
      <h1 data-testid="frame-title">{title}</h1>
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
  const { prHeadline } = await import('@/components/pr/headline');
  return {
    MergeCard,
    prHeadline,
    Conversation: () => null,
    DiffView: () => null,
    ChecksCard: () => null,
    SubmissionsCard: () => null,
    ChecksTab: () => null,
    HistoryCard: () => null,
    gateReason: () => 'Resolve every failed criterion and missing piece of evidence, then submit a new revision.',
    usePullRequest: () => ({
      detail: mocks.phase,
      head: mocks.head,
      threads: [],
      diffs: [],
      revisions: mocks.revisions ?? (mocks.head ? [mocks.head] : []),
      gate: 0,
      fileRevision: mocks.head,
      fileBase: null,
      threadsFor: () => [],
      selectRevision: vi.fn(),
      submit: (...args: unknown[]) => mocks.submit(...args),
      filesKept: () => true,
      reload: vi.fn(async () => undefined),
      setError: vi.fn(),
      setNotice: vi.fn(),
    }),
  };
});
const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { MergeCard } = await import('@/components/pr/MergeCard');
const { prHeadline } = await import('@/components/pr/headline');
const { SIGN_OFF_PASS_LINE, SIGN_OFF_SUBMIT_REASON } = await import('@/components/workspace/signoff-status');

let host: HTMLDivElement, root: Root;
const q = <T extends Element = HTMLButtonElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const merge = () => q('reflection-submit')!;
const card = () => q<HTMLElement>('pr-merge')!;
const mount = async (node: React.ReactNode = <PullRequestPage />) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(node));
};
const passing = {
  id: 'rev-1',
  attempt: 1,
  score: 88,
  state: 'done',
  createdAt: '2026-10-02T05:00:00.000Z',
  report: { passed: true, aiReview: { assessmentError: false } },
};
const quiz = (over: Record<string, unknown> = {}) =>
  task({
    key: 'quiz',
    order: 2,
    title: 'Check your understanding',
    artefactType: 'quiz',
    evidence: 'automated',
    status: 'passed',
    awaitingSignOff: false,
    bestScore: 100,
    passedAt: '2026-10-02T04:00:00.000Z',
    lastSubmissionId: 'q-1',
    ...over,
  });
const openQuiz = () => quiz({ status: 'in_progress', attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null });
const split = (tasks: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  base({
    tasks,
    taskCounts: {
      total: tasks.length,
      required: tasks.filter((t) => t.required).length,
      passed: tasks.filter((t) => t.status === 'passed').length,
      passedRequired: tasks.filter((t) => t.required && t.status === 'passed').length,
    },
    ...over,
  });

beforeEach(() => {
  mocks.phase = base();
  mocks.head = passing;
  mocks.revisions = null;
  mocks.enrollment = { projectTitle: 'RoomDesk', phases: [], releases: [], currentPhaseOrder: 3, completed: false };
  mocks.submit = vi.fn();
  mocks.advance = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Every shape in which the room's work waits on the countersignature. */
const WAITING: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
  ['one-task phase, the task flagged', () => base()],
  ['one-task phase, the verdict just landed', () => base({ tasks: [task({ awaitingSignOff: false, lastSubmissionId: 'rev-0' })] })],
  ['split phase, the quiz passed', () => split([task(), quiz()])],
];

describe('Merge stays off, and Submit again stays off with its reason, in every waiting case', () => {
  for (const [shape, phase] of WAITING) {
    it(`${shape}: Merge disabled, a click never reaches advance(); Submit again off with the reason`, async () => {
      mocks.phase = phase();
      await mount();
      expect(merge().disabled).toBe(true);
      expect(card().textContent).not.toContain('Ready to merge');
      await act(async () => merge().click());
      expect(mocks.advance).not.toHaveBeenCalled();
      expect(q('pr-submit-again')!.disabled).toBe(true);
      expect(q('pr-submit-again')!.getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
    });
  }
});

// A split phase whose required quiz is still open: with nothing selected the
// room may land on the quiz (chooseTask) or on the waiting task;
// either way Merge is off, because the required set's counts are not met.
it('split phase, the quiz still open, nothing selected: Merge is off and never reaches advance()', async () => {
  mocks.phase = split([task(), openQuiz()]);
  await mount();
  expect(merge().disabled).toBe(true);
  await act(async () => merge().click());
  expect(mocks.advance).not.toHaveBeenCalled();
});

describe('no other gate turns the card\'s Submit again off, so the prop is kept', () => {
  const props = {
    pr: 'PR-3',
    merged: false,
    gateMet: false,
    reviewPassed: true,
    waitLabel: SIGN_OFF_PASS_LINE,
    score: 88,
    gate: 70,
    attempt: 1,
    reason: '',
    reflection: null,
    next: null,
    nextHref: '/next',
    busy: false,
    submitLabel: 'Submit again',
    onMerge: async () => undefined,
    onSubmitAgain: () => undefined,
    commitMessage: '',
    setCommitMessage: () => undefined,
  };

  it('every waiting prop but submitReason: Submit again is live, so nothing else gates it', async () => {
    const onSubmitAgain = vi.fn();
    await mount(<MergeCard {...props} onSubmitAgain={onSubmitAgain} />);
    expect(q('pr-submit-again')!.disabled).toBe(false);
    await act(async () => q('pr-submit-again')!.click());
    expect(onSubmitAgain).toHaveBeenCalledTimes(1);
  });

  it('with submitReason: off, with the reason, and a click hands nothing in', async () => {
    const onSubmitAgain = vi.fn();
    await mount(<MergeCard {...props} submitReason={SIGN_OFF_SUBMIT_REASON} onSubmitAgain={onSubmitAgain} />);
    expect(q('pr-submit-again')!.disabled).toBe(true);
    expect(q('pr-submit-again')!.getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
    await act(async () => q('pr-submit-again')!.click());
    expect(onSubmitAgain).not.toHaveBeenCalled();
  });
});

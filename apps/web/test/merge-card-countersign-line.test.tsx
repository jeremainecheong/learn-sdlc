// @vitest-environment jsdom
/**
 * The Merge card while the work waits on the teacher's countersignature, on
 * the REAL pull request page.
 *
 * Beside the disabled Merge the card must not say "A Pass lets you complete
 * this phase." or offer "Leave blank to continue, ...": the work has passed
 * and nothing can be completed or continued until the teacher countersigns.
 * While waiting the card says the work passed and what opens the next phase
 * (SIGN_OFF_PASS_LINE's words); every other state is unaffected.
 *
 * Only the pull-request data hook, the shell's held project and the network
 * are stood in for; the page, the REAL MergeCard and the REAL prHeadline run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAxe } from './support/axe-bridge';

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
  place: 3,
  count: 6,
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

const TODAY_PURPOSE = 'A Pass lets you complete this phase. You may leave an optional note about what changed and why.';
const TODAY_PLACEHOLDER = 'Leave blank to continue, or record what you changed and learned.';

let host: HTMLDivElement, root: Root;
const q = <T extends Element = HTMLButtonElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const card = () => q<HTMLElement>('pr-merge')!;
const placeholder = () => q<HTMLTextAreaElement>('reflection-input')!.getAttribute('placeholder');
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
const failing = { ...passing, score: 41, report: { passed: false, aiReview: { assessmentError: false } } };
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
  // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
  expect(host.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
  act(() => root.unmount());
  host.remove();
});

/** Every shape in which the room's work waits on the countersignature. */
const WAITING: ReadonlyArray<readonly [string, () => Record<string, unknown>]> = [
  ['one-task phase, the task flagged', () => base()],
  ['one-task phase, the verdict just landed', () => base({ tasks: [task({ awaitingSignOff: false, lastSubmissionId: 'rev-0' })] })],
  ['split phase, the quiz passed', () => split([task(), quiz()])],
];

describe('the card while the work waits on the countersignature', () => {
  for (const [shape, phase] of WAITING) {
    it(`${shape}: no "A Pass lets you complete this phase", no "Leave blank to continue"`, async () => {
      mocks.phase = phase();
      await mount();
      expect(card().textContent).not.toContain('A Pass lets you complete this phase');
      expect(placeholder()).not.toContain('Leave blank to continue');
      expect(card().textContent).toContain(
        "Your work passed review. Your teacher's countersignature opens the next phase. You may leave an optional note about what changed and why.",
      );
      expect(placeholder()).toBe('Record what you changed and learned, or leave it blank.');
    });
  }

  it('axe finds nothing on the waiting card', async () => {
    await mount();
    const axe = await loadAxe();
    const result = await axe.run(card(), { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it('a waiting OPTIONAL task does not hold Merge (the gate is the required set), so the card keeps today\'s words', async () => {
    mocks.phase = split([quiz({ key: 'aaa', order: 0, title: 'Warm-up' }), task({ required: false, key: 'main', order: 1 })]);
    await mount();
    expect(card().textContent).toContain(TODAY_PURPOSE);
  });
});

/**
 * A split phase whose work waits while a required
 * sibling is still open has not reached the countersignature. The card names
 * what is still open and never says the countersignature opens the next phase,
 * as the feedback hero does there. Merge stays off.
 */
describe('a split phase with a required task still open', () => {
  // The third field: whether the room lands on the waiting task (it does not
  // when that task is optional: the open required quiz is the room's work,
  // which has no Pass yet, so 'Available after a Pass' is right).
  const OPEN_STATES: ReadonlyArray<readonly [string, () => Record<string, unknown>, boolean]> = [
    ['the main task waits, the required quiz is open', () => split([task(), openQuiz()]), true],
    ['an optional task waits, the required quiz is open', () => split([task({ required: false }), openQuiz()]), false],
  ];
  for (const [shape, phase, landsOnWaiting] of OPEN_STATES) {
    it(`${shape}: no countersignature line, the label names the open task, Merge off`, async () => {
      mocks.phase = phase();
      await mount();
      const text = card().textContent ?? '';
      expect(text).not.toContain("countersignature opens the next phase");
      expect(placeholder()).not.toBe('Record what you changed and learned, or leave it blank.');
      if (landsOnWaiting) {
        expect(text).not.toContain('Available after a Pass');
        expect(text).toContain('Available once Check your understanding passes');
      }
      const merge = q<HTMLButtonElement>('reflection-submit')!;
      expect(merge.disabled).toBe(true);
      act(() => merge.click());
      expect(mocks.advance).not.toHaveBeenCalled();
    });
  }
});

describe('every other state of the card reads its own words, with no countersignature line', () => {
  it('after the countersignature: today\'s purpose and placeholder, Ready to merge', async () => {
    mocks.phase = base({
      status: 'passed',
      tasks: [task({ status: 'passed', awaitingSignOff: false, passedAt: '2026-10-02T05:10:00.000Z' })],
      taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
    });
    await mount();
    expect(card().textContent).toContain(TODAY_PURPOSE);
    expect(placeholder()).toBe(TODAY_PLACEHOLDER);
    expect(card().textContent).toContain('Ready to merge');
  });

  it('a refused review: today\'s purpose and placeholder', async () => {
    mocks.head = failing;
    mocks.phase = base({ tasks: [task({ awaitingSignOff: false })] });
    await mount();
    expect(card().textContent).toContain(TODAY_PURPOSE);
    expect(placeholder()).toBe(TODAY_PLACEHOLDER);
  });

  it('a task nobody marked: today\'s purpose and placeholder', async () => {
    mocks.phase = base({ tasks: [task({ evidence: 'reviewed', awaitingSignOff: false })] });
    await mount();
    expect(card().textContent).toContain(TODAY_PURPOSE);
    expect(placeholder()).toBe(TODAY_PLACEHOLDER);
  });

  it('a phase ahead of the learner: today\'s purpose and its own wait label', async () => {
    mocks.phase = base({ notReachedYet: true });
    await mount();
    expect(card().textContent).toContain(TODAY_PURPOSE);
    expect(card().textContent).toContain('Available once you reach this phase');
  });

  it('the card left without the new prop (every other caller): today\'s words', async () => {
    await mount(
      <MergeCard
        pr="PR-3"
        merged={false}
        gateMet={false}
        reviewPassed
        waitLabel={SIGN_OFF_PASS_LINE}
        score={88}
        gate={70}
        attempt={1}
        reason=""
        reflection={null}
        next={null}
        nextHref="/next"
        busy={false}
        submitLabel="Submit again"
        onMerge={async () => undefined}
        onSubmitAgain={() => undefined}
        commitMessage=""
        setCommitMessage={() => undefined}
      />,
    );
    expect(card().textContent).toContain(TODAY_PURPOSE);
    expect(placeholder()).toBe(TODAY_PLACEHOLDER);
  });
});

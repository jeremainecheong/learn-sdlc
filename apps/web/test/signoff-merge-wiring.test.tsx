// @vitest-environment jsdom
/**
 * The pull request room, mounted as its
 * route exports it, on a one-task phase whose task passed its review and waits
 * on the teacher's countersignature (`submitted` + `awaitingSignOff`).
 *
 * `mergeGateMet` must not read the verdict alone on a one-task phase, or the
 * room lights "Merge PR-n" ("Ready to merge") while the next phase is still
 * shut, which `advance()` refuses. While the countersignature is pending the
 * gate reads NOT met, the card says what opens the next phase
 * (SIGN_OFF_PASS_LINE), nothing on the page proceeds or resubmits, and after
 * the countersignature the room is its usual self again.
 *
 * Only the pull-request data hook, the shell's held project and the network
 * are stood in for; the page and the REAL `MergeCard` run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseTaskCounts } from '@learnsdlc/shared';

const mocks = vi.hoisted(() => ({
  phase: {} as Record<string, unknown>,
  head: {} as Record<string, unknown> | null,
  revisions: null as Record<string, unknown>[] | null,
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
  id: 'phase-pr-signoff',
  key: 'implementation',
  title: 'Implementation',
  order: 3,
  place: 3,
  count: 6,
  status: 'submitted',
  projectSlug: 'room-desk',
  rubric: {},
  attempts: 1,
  reflection: null,
  solution: { available: false, files: 0, readAt: null },
  tasks: [task()],
  taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
  ...over,
});
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-pr-signoff' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({
  api: { chat: vi.fn(), reflect: vi.fn(), advance: (...args: unknown[]) => mocks.advance(...args) },
}));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({
    details: { 'phase-pr-signoff': mocks.phase },
    enrollment: { projectTitle: 'RoomDesk', phases: [], releases: [], currentPhaseOrder: 3, completed: false },
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
const { SIGN_OFF_PASS_LINE, SIGN_OFF_SUBMIT_REASON } = await import('@/components/workspace/signoff-status');
const { submitArgs, taskCountLine } = await import('@/components/workspace/TaskPanel');

let host: HTMLDivElement, root: Root;
const q = <T extends Element = HTMLButtonElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
const merge = () => q('reflection-submit')!;
const mount = async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<PullRequestPage />));
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
const pressEnter = () =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  });

beforeEach(() => {
  mocks.phase = base();
  mocks.head = passing;
  mocks.revisions = null;
  mocks.submit = vi.fn();
  mocks.advance = vi.fn();
});
afterEach(() => {
  // a detail built here carries its place and count, so no "PR-" or "phase of" is drawn without its number
  expect(host.textContent ?? '').not.toMatch(/PR-(?!\d)|\bphase\s+(?:undefined\s+)?of\s+(?!\d)/);
  act(() => root.unmount());
  host.remove();
});

describe('the pull request of a one-task phase awaiting the countersignature', () => {
  it('reads the gate as not met: Merge is off, and the card says what opens the next phase', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(merge().disabled).toBe(true);
    expect(text).not.toContain('Ready to merge');
    expect(q('pr-merge')!.textContent).toContain(SIGN_OFF_PASS_LINE);
    // The review did pass: the status line and the chip still say so.
    expect(text).toContain('Pass. Every required criterion has acceptable evidence.');
    expect(text).not.toContain('Needs revision');
  });

  it('keeps the review state open so the sentence is in view', async () => {
    await mount();
    expect(host.querySelector<HTMLDetailsElement>('details.phase-pr-review-state')!.open).toBe(true);
  });

  it('lets nothing proceed: a click on Merge never reaches advance()', async () => {
    await mount();
    await act(async () => merge().click());
    expect(mocks.advance).not.toHaveBeenCalled();
  });

  it('offers no resubmit: Submit again is off in the header and the card, with the reason, and ⌘↵ sends nothing', async () => {
    await mount();
    for (const id of ['header-submit', 'pr-submit-again']) {
      const button = q(id)!;
      expect(button.disabled, id).toBe(true);
      expect(button.getAttribute('title'), id).toBe(SIGN_OFF_SUBMIT_REASON);
      const described = button.getAttribute('aria-describedby');
      expect(described, id).toBeTruthy();
      expect(document.getElementById(described!)?.textContent, id).toBe(SIGN_OFF_SUBMIT_REASON);
    }
    await pressEnter();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('holds Merge in the moment the verdict lands, before the task row knows it', async () => {
    // The row still names the previous revision and is not yet flagged; the
    // newest graded revision passed on a task the teacher marked.
    mocks.phase = base({ tasks: [task({ awaitingSignOff: false, lastSubmissionId: 'rev-0' })] });
    await mount();
    expect(merge().disabled).toBe(true);
    expect(q('pr-merge')!.textContent).toContain(SIGN_OFF_PASS_LINE);
  });
});

describe('every other state of the same room reads its own words, with no countersignature line', () => {
  it('after the countersignature: the ordinary merge, Ready to merge, Submit again on', async () => {
    mocks.phase = base({
      status: 'passed',
      tasks: [task({ status: 'passed', awaitingSignOff: false, passedAt: '2026-10-02T05:10:00.000Z' })],
      taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
    });
    await mount();
    expect(merge().disabled).toBe(false);
    expect(host.textContent).toContain('Ready to merge');
    expect(host.textContent).not.toContain(SIGN_OFF_PASS_LINE);
    expect(q('header-submit')!.disabled).toBe(false);
    expect(q('pr-submit-again')!.disabled).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>('details.phase-pr-review-state')!.open).toBe(true);
    await pressEnter();
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it('a task the teacher did not mark: a passing review lights Merge as today', async () => {
    mocks.phase = base({ tasks: [task({ evidence: 'reviewed', awaitingSignOff: false, lastSubmissionId: 'rev-1' })] });
    await mount();
    expect(merge().disabled).toBe(false);
    expect(host.textContent).toContain('Ready to merge');
    expect(q('header-submit')!.disabled).toBe(false);
  });

  it('a refused review: Needs revision, Available after a Pass, Submit again on', async () => {
    mocks.head = failing;
    mocks.phase = base({ tasks: [task({ awaitingSignOff: false })] });
    await mount();
    const text = host.textContent ?? '';
    expect(merge().disabled).toBe(true);
    expect(text).toContain('Needs revision');
    expect(text).toContain('Available after a Pass');
    expect(text).not.toContain(SIGN_OFF_PASS_LINE);
    expect(q('header-submit')!.disabled).toBe(false);
    expect(q('pr-submit-again')!.disabled).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>('details.phase-pr-review-state')!.open).toBe(false);
  });

  it('a payload without tasks: the verdict alone', async () => {
    mocks.phase = base({ tasks: undefined, taskCounts: undefined });
    await mount();
    expect(merge().disabled).toBe(false);
    expect(host.textContent).toContain('Ready to merge');
  });

  it('a phase ahead of the learner keeps its own wait label', async () => {
    mocks.phase = base({ notReachedYet: true, tasks: [task({ evidence: 'reviewed', awaitingSignOff: false })] });
    await mount();
    expect(merge().disabled).toBe(true);
    expect(host.textContent).toContain('Available once you reach this phase');
  });
});

/**
 * A phase a teacher split (Implementation's code task and
 * a quiz). The code task is marked, passed its review and waits. The room's
 * default is no task selected, and its submit then names `chooseTask`'s pick
 * through the REAL `submitArgs`: the waiting code task. So the wait is judged
 * on the key the submit would send, and on a phase whose countersignature is
 * the one thing missing the card says so rather than "Needs revision".
 */
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
const split = (tasks: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  base({
    id: 'phase-pr-signoff',
    tasks,
    taskCounts: {
      total: tasks.length,
      required: tasks.filter((t) => t.required).length,
      passed: tasks.filter((t) => t.status === 'passed').length,
      passedRequired: tasks.filter((t) => t.required && t.status === 'passed').length,
    },
    ...over,
  });
const openQuiz = () => quiz({ status: 'in_progress', attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null });

describe('a split phase, nothing selected, the code task awaiting the countersignature', () => {
  for (const [name, tasks] of [
    ['quiz passed', () => [task(), quiz()]],
    ['quiz still open', () => [task(), openQuiz()]],
  ] as const) {
    it(`${name}: the submit would hand in the waiting task, so it is off with the reason`, async () => {
      mocks.phase = split(tasks());
      await mount();
      // What a submit from here would send: the waiting code task.
      expect(submitArgs('phase-pr-signoff', undefined, mocks.phase.tasks as never, null)[2]).toBe('main');
      for (const id of ['header-submit', 'pr-submit-again']) {
        expect(q(id)!.disabled, id).toBe(true);
        expect(q(id)!.getAttribute('title'), id).toBe(SIGN_OFF_SUBMIT_REASON);
      }
      await pressEnter();
      expect(mocks.submit).not.toHaveBeenCalled();
      expect(merge().disabled).toBe(true);
    });
  }

  it('quiz passed: the phase waits on the countersignature alone, and the card says so', async () => {
    mocks.phase = split([task(), quiz()]);
    await mount();
    const card = q('pr-merge')!.textContent ?? '';
    expect(card).toContain(SIGN_OFF_PASS_LINE);
    expect(card).not.toContain('Available after a Pass');
    expect(host.textContent).not.toContain('Needs revision');
    expect(host.querySelector<HTMLDetailsElement>('details.phase-pr-review-state')!.open).toBe(true);
    await act(async () => merge().click());
    expect(mocks.advance).not.toHaveBeenCalled();
  });
});

describe('a passing graded revision that is not the newest revision', () => {
  // A teacher reopened the phase (the row is in_progress and not waiting) and
  // the learner resubmitted. The newest revision is still in review, or its
  // review failed to run: either way it is newer than the passing one, so the
  // passing one is no "verdict that just landed".
  for (const [name, newest] of [
    ['still in review', { id: 'rev-2', attempt: 2, score: null, state: 'now', createdAt: '2026-10-02T06:00:00.000Z', report: null }],
    ['review failed to run', { id: 'rev-2', attempt: 2, score: null, state: 'done', createdAt: '2026-10-02T06:00:00.000Z', report: null }],
  ] as const) {
    it(`${name}: the resubmit stays on and the card does not speak of the sign-off`, async () => {
      mocks.phase = base({ tasks: [task({ status: 'in_progress', awaitingSignOff: false, lastSubmissionId: 'rev-2' })] });
      mocks.revisions = [passing, newest];
      await mount();
      expect(q('header-submit')!.disabled).toBe(false);
      expect(q('header-submit')!.getAttribute('title')).not.toBe(SIGN_OFF_SUBMIT_REASON);
      expect(q('pr-submit-again')!.disabled).toBe(false);
      expect(q('pr-merge')!.textContent).not.toContain(SIGN_OFF_PASS_LINE);
      await pressEnter();
      expect(mocks.submit).toHaveBeenCalledTimes(1);
    });
  }
});

describe('split phases that are not waiting read their own words, with no countersignature line', () => {
  it('code task refused, quiz passed: Needs revision, Available after a Pass, Submit on', async () => {
    mocks.head = failing;
    mocks.phase = split([task({ awaitingSignOff: false }), quiz()]);
    await mount();
    const text = host.textContent ?? '';
    expect(text).toContain('Needs revision');
    expect(text).toContain('Available after a Pass');
    expect(text).not.toContain(SIGN_OFF_PASS_LINE);
    expect(q('header-submit')!.disabled).toBe(false);
    expect(q('pr-submit-again')!.disabled).toBe(false);
  });

  it('every required task passed after the countersignature: the ordinary merge', async () => {
    mocks.phase = split(
      [task({ status: 'passed', awaitingSignOff: false, passedAt: '2026-10-02T05:10:00.000Z' }), quiz()],
      { status: 'passed' },
    );
    await mount();
    expect(merge().disabled).toBe(false);
    expect(host.textContent).toContain('Ready to merge');
    expect(host.textContent).not.toContain(SIGN_OFF_PASS_LINE);
    expect(q('header-submit')!.disabled).toBe(false);
  });
});

describe('the task list and the task count on a split phase', () => {
  it('draws the list with the phase, so the quiz row is a door to its room, and counts the tasks in the header', async () => {
    mocks.phase = split([task({ status: 'in_progress', awaitingSignOff: false }), openQuiz()]);
    await mount();
    // A row is a link only when the room hands the panel the phase it is in.
    expect(q('task-open-quiz')?.tagName).toBe('A');
    expect(q('pr-task-counts')?.textContent).toBe(taskCountLine((mocks.phase as { taskCounts: PhaseTaskCounts }).taskCounts));
  });
});

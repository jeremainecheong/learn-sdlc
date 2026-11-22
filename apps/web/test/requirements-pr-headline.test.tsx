// @vitest-environment jsdom
/**
 * The Requirements pull request headline.
 *
 * `prHeadline` must not name the reference story ("US-4") on every
 * Requirements phase: the room is reachable on a teacher's project by typing
 * its address. A room that is not the reference project's
 * (`roomIsReference`) reads the neutral line, as the IDE strip's
 * `headlineFor` does; the reference arm names the story and is what a caller
 * that passes nothing gets.
 *
 * Only the pull-request data hook, the shell's held project and the network
 * are stood in for; the page, the REAL MergeCard and the REAL prHeadline run.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhaseDetail } from '@learnsdlc/shared';

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
  // The place and count the API sends with a detail (TaskTrackr's six).
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

let host: HTMLDivElement, root: Root;
const q = <T extends Element = HTMLButtonElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
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

beforeEach(() => {
  mocks.phase = base();
  mocks.head = passing;
  mocks.revisions = null;
  mocks.enrollment = { projectTitle: 'RoomDesk', phases: [], releases: [], currentPhaseOrder: 3, completed: false };
  mocks.submit = vi.fn();
  mocks.advance = vi.fn();
});
afterEach(() => {
  // The pure rows below mount nothing.
  if (!host) return;
  act(() => root.unmount());
  host.remove();
  host = undefined as unknown as HTMLDivElement;
});

const requirements = (over: Partial<PhaseDetail> = {}) =>
  ({ id: 'phase-pr-re', key: 'requirements', title: 'Requirements', order: 1, files: [], ...over }) as unknown as PhaseDetail;
const NEUTRAL = 'Write your story, with criteria a test can check';
const REFERENCE = 'Write US-4 with criteria a test can check';

describe('the Requirements pull request headline', () => {
  it('a room that is not the reference project\'s names no reference story', () => {
    expect(prHeadline(requirements(), false)).not.toContain('US-4');
    expect(prHeadline(requirements(), false)).toBe(NEUTRAL);
  });

  it('the reference arm is byte-identical, and is what a caller that passes nothing gets', () => {
    expect(prHeadline(requirements(), true)).toBe(REFERENCE);
    expect(prHeadline(requirements())).toBe(REFERENCE);
  });

  it('every other phase reads its own headline in the reference project\'s room', () => {
    expect(prHeadline(requirements({ key: 'design' } as Partial<PhaseDetail>), true)).toBe(
      'Decide the model, the contracts and one trade-off',
    );
    expect(
      prHeadline(
        requirements({ key: 'implementation', files: [{ path: 'src/app.py', editable: true }] } as unknown as Partial<PhaseDetail>),
        true,
      ),
    ).toBe('Make app.py true to the contracts');
  });

  // A room of its own is titled with what its pack asks, never
  // with the reference project's contracts.
  it('every other phase reads what its own pack asks in a room of its own', () => {
    expect(
      prHeadline(requirements({ key: 'design', intro: 'Design the overdue rule before anyone codes it: one entity and one operation.' } as Partial<PhaseDetail>), false),
      // A title carries no closing full stop.
    ).toBe('Design the overdue rule before anyone codes it: one entity and one operation');
    // Every phase by one rule, the intro's first sentence; a file path is never a pull request's title.
    expect(
      prHeadline(
        requirements({ key: 'implementation', intro: 'Fill one TODO in app.py. Then run it.', files: [{ path: 'src/app.py', editable: true }] } as unknown as Partial<PhaseDetail>),
        false,
      ),
    ).toBe('Fill one TODO in app.py');
  });

  const reqPhase = (provenance?: Record<string, unknown>) =>
    base({
      key: 'requirements',
      title: 'Requirements',
      order: 1,
      place: 1,
      tasks: [task({ evidence: 'reviewed', awaitingSignOff: false, status: 'in_progress' })],
      ...(provenance ? { provenance } : {}),
    });

  it('the page: a teacher\'s own room task reads the neutral headline', async () => {
    mocks.phase = reqPhase({ roomTask: 'own', application: null, tasks: [] });
    await mount();
    expect(q<HTMLElement>('frame-title')!.textContent).toBe(`PR-1: ${NEUTRAL}`);
  });

  it('the page: a project that is not the default, with no provenance, reads the neutral headline', async () => {
    mocks.phase = reqPhase();
    mocks.enrollment = { ...mocks.enrollment, projectIsDefault: false };
    await mount();
    expect(q<HTMLElement>('frame-title')!.textContent).toBe(`PR-1: ${NEUTRAL}`);
  });

  it('the page: the reference room keeps the reference headline', async () => {
    mocks.phase = reqPhase({ roomTask: 'reference', application: 'TaskTrackr', tasks: [] });
    await mount();
    expect(q<HTMLElement>('frame-title')!.textContent).toBe(`PR-1: ${REFERENCE}`);
  });

  it('the page: the default project with no provenance keeps the reference headline', async () => {
    mocks.phase = reqPhase();
    mocks.enrollment = { ...mocks.enrollment, projectIsDefault: true };
    await mount();
    expect(q<HTMLElement>('frame-title')!.textContent).toBe(`PR-1: ${REFERENCE}`);
  });
});

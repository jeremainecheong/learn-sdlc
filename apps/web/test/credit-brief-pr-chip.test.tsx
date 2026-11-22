// @vitest-environment jsdom
/**
 * The other readers in the learner's rooms that still drew a
 * pass over a teacher's credit. The Requirements brief card (the IDE's older
 * Requirements panel) and the pull request's standing chip now read the gate's
 * own `evidenceNeeded` through `isCredited`, as the band does. (The authored
 * task's objective ticks are pinned in task-rooms-wiring.) Words only; no gate.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STORY_FLOOR, type PhaseDetail } from '@learnsdlc/shared';
import type { PhasePanelProps } from '@/components/workspace/panels/types';
import { CREDIT_AWARDED } from '@/components/workspace/signoff-status';

const mocks = vi.hoisted(() => ({ phase: {} as Record<string, unknown>, enrollment: {} as Record<string, unknown> }));
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/scenario', async (original) => ({ ...(await original<typeof import('@/lib/scenario')>()), useReferenceScaffolding: () => false }));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-credit' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn(), reflect: vi.fn(), advance: vi.fn() } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: { 'phase-credit': mocks.phase }, enrollment: mocks.enrollment, analytics: null, currentPhase: null, reload: vi.fn(async () => undefined) }),
  useProjectMaybe: () => null,
  invalidateProject: vi.fn(),
}));
vi.mock('@/components/workspace/QueueLine', () => ({ QueueLine: () => null }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, right, title }: { children: React.ReactNode; right?: React.ReactNode; title?: React.ReactNode }) => (
    <div><h1 data-testid="frame-title">{title}</h1><div>{right}</div>{children}</div>
  ),
}));
vi.mock('@/components/shell', () => ({
  DocPage: () => null, briefHref: () => '/brief', doorWithTasks: (phase: unknown) => phase, phaseDoorHref: () => '/workspace/next',
  solutionHref: () => '/solution', usePersona: () => null, PERSONA_NAME: { implementation: 'Riley' },
}));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
const FAILING = { id: 'rev-1', attempt: 1, score: 40, state: 'done', createdAt: '2026-10-02T05:00:00.000Z', report: { passed: false, aiReview: { assessmentError: false } } };
vi.mock('@/components/pr', async () => {
  const { MergeCard } = await import('@/components/pr/MergeCard');
  const { prHeadline } = await import('@/components/pr/headline');
  return {
    MergeCard, prHeadline,
    Conversation: () => null, DiffView: () => null, ChecksCard: () => null, SubmissionsCard: () => null, ChecksTab: () => null, HistoryCard: () => null,
    gateReason: () => '',
    usePullRequest: () => ({
      detail: mocks.phase, head: FAILING, threads: [], diffs: [], revisions: [FAILING], gate: 0, fileRevision: FAILING, fileBase: null,
      threadsFor: () => [], selectRevision: vi.fn(), submit: vi.fn(), filesKept: () => true, reload: vi.fn(async () => undefined), setError: vi.fn(), setNotice: vi.fn(),
    }),
  };
});
const { default: RequirementsBrief } = await import('@/components/workspace/panels/requirements/BriefCard');
const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');

const gap = { key: '', title: 'The task' };
const chips = (page: ParentNode) => Array.from(page.querySelectorAll('.chip')).map((chip) => chip.textContent ?? '');

describe('the Requirements brief card', () => {
  const props = (over: Partial<PhaseDetail> = {}) => ({
    detail: { id: 'p1', key: 'requirements', status: 'passed', files: [], story: { id: 'SH-5', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] }, ...over } as unknown as PhaseDetail,
    helpers: { fileText: () => '' },
  }) as unknown as PhasePanelProps;

  it('credited: the credit words in the warn tone, not Passed', () => {
    const markup = renderToStaticMarkup(<RequirementsBrief {...props({ evidenceNeeded: [gap] } as Partial<PhaseDetail>)} />);
    expect(markup).toContain(CREDIT_AWARDED);
    expect(markup).toMatch(/chip chip-warn[^>]*>Credit awarded/);
    expect(markup).not.toMatch(/>Passed</);
  });

  it('a reviewed pass still reads Passed', () => {
    const markup = renderToStaticMarkup(<RequirementsBrief {...props()} />);
    expect(markup).toMatch(/>Passed</);
    expect(markup).not.toContain(CREDIT_AWARDED);
  });
});

describe('the pull request\'s standing chip', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    host = root = null;
  });
  const mount = async (phase: Record<string, unknown>) => {
    mocks.phase = {
      id: 'phase-credit', key: 'implementation', title: 'Implementation', order: 3, place: 3, count: 6, status: 'passed',
      projectSlug: 'p', files: [], rubric: { passThreshold: 70, criteria: [] }, attempts: 1, reflection: null,
      solution: { available: false, files: 0, readAt: null }, tasks: [], taskCounts: { total: 0, required: 0, passed: 0, passedRequired: 0 },
      ...phase,
    };
    mocks.enrollment = {
      projectTitle: 'P', releases: [], currentPhaseOrder: 3, completed: false,
      phases: [{ id: 'phase-credit', key: 'implementation', order: 3, title: 'Implementation', status: 'passed' }],
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<PullRequestPage />));
    return host;
  };

  it('credited over a Needs revision: the credit words, not "Needs revision"', async () => {
    const page = await mount({ evidenceNeeded: [gap] });
    expect(page.querySelector('[data-testid="pr-credit"]')?.textContent).toBe(CREDIT_AWARDED);
    expect(page.querySelector('[data-testid="pr-credit"]')?.className).toContain('chip-warn');
    // No standing chip says the review's words over the credit. (The merge
    // card below still says why Merge waits: a reviewed pass is still needed.)
    expect(chips(page)).not.toContain('Needs revision');
    expect(chips(page)).not.toContain('Reviewing');
  });

  it('no credit: no credit chip, and the state chip reads Needs revision', async () => {
    const page = await mount({ status: 'in_progress' });
    expect(page.querySelector('[data-testid="pr-credit"]')).toBeNull();
    expect(chips(page)).toContain('Needs revision');
  });
});

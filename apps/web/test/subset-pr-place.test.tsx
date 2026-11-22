// @vitest-environment jsdom
/**
 * A pull request is named by its phase's place in its own project (spec 4.2).
 *
 * `PR-${order}` became the phase's place, and the next phase is the one after
 * it by key, never `order + 1` (P29: a stored version numbered 3 and 5 is still
 * labelled 1 and 2). The version here holds Implementation at stored order 3
 * and Testing at stored order 5, so a site that reads the order says "PR-3"
 * and finds no next phase.
 *
 * The pull request page is drawn as merge-card-countersign-line.test.tsx draws it:
 * the page, the REAL MergeCard and the REAL prHeadline run, over a stood-in
 * data hook. The Maintenance brief and the Implementation panel are drawn
 * over the props the IDE hands them.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closureText, moduleText } from './support/source-text';
import type { PhaseDetail } from '@learnsdlc/shared';
import type { PhasePanelProps } from '@/components/workspace/panels/types';

const mocks = vi.hoisted(() => ({ phase: {} as Record<string, unknown>, enrollment: {} as Record<string, unknown> }));
const IMPLEMENTATION = {
  id: 'phase-pr-place', key: 'implementation', title: 'Implementation', order: 3, place: 1, count: 2, status: 'passed',
  projectSlug: 'late', files: [], rubric: { passThreshold: 70, criteria: [] }, attempts: 1, reflection: 'Kept the contract.',
  solution: { available: false, files: 0, readAt: null }, tasks: [], taskCounts: { total: 0, required: 0, passed: 0, passedRequired: 0 },
};
const PASSING = { id: 'rev-1', attempt: 1, score: 90, state: 'done', createdAt: '2026-10-02T05:00:00.000Z', report: { passed: true, aiReview: { assessmentError: false } } };

vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'phase-pr-place' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ api: { chat: vi.fn(), reflect: vi.fn(), advance: vi.fn() } }));
vi.mock('@/lib/rail', () => ({ railOf: () => ({}) }));
vi.mock('@/lib/commit', () => ({ useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: { 'phase-pr-place': mocks.phase }, enrollment: mocks.enrollment, analytics: null, currentPhase: null, reload: vi.fn(async () => undefined) }),
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
vi.mock('@/components/pr', async () => {
  const { MergeCard } = await import('@/components/pr/MergeCard');
  const { prHeadline } = await import('@/components/pr/headline');
  return {
    MergeCard, prHeadline,
    Conversation: () => null, DiffView: () => null, ChecksCard: () => null, SubmissionsCard: () => null, ChecksTab: () => null, HistoryCard: () => null,
    gateReason: () => '',
    usePullRequest: () => ({
      detail: mocks.phase, head: PASSING, threads: [], diffs: [], revisions: [PASSING], gate: 0, fileRevision: PASSING, fileBase: null,
      threadsFor: () => [], selectRevision: vi.fn(), submit: vi.fn(), filesKept: () => true, reload: vi.fn(async () => undefined), setError: vi.fn(), setNotice: vi.fn(),
    }),
  };
});
const { default: PullRequestPage } = await import('@/app/(app)/workspace/[phaseId]/pr/page');
const { default: MaintenanceBrief } = await import('@/components/workspace/panels/maintenance/Brief');
const { default: implementationPanel } = await import('@/components/workspace/panels/implementation');

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const mount = async (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
};
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

const PANEL_PROPS = (detail: Record<string, unknown>) => ({
  detail: detail as unknown as PhaseDetail, files: {}, submission: null, submissions: [], enrollment: null,
  helpers: { openFile: vi.fn(), setTab: vi.fn(), setPane: vi.fn(), fileText: () => '', submitNow: vi.fn(), busy: false },
}) as unknown as PhasePanelProps;

describe("the pull request is named by its phase's place", () => {
  it('the PR page names PR-1 and opens the next phase by key, numbered by its place', async () => {
    mocks.phase = IMPLEMENTATION;
    mocks.enrollment = {
      projectTitle: 'Late phases', releases: [{ phaseKey: 'implementation' }], currentPhaseOrder: 5, completed: false,
      phases: [
        { id: 'phase-pr-place', key: 'implementation', order: 3, title: 'Implementation', status: 'passed' },
        { id: 'phase-testing', key: 'testing', order: 5, title: 'Testing', status: 'in_progress' },
      ],
    };
    const page = await mount(<PullRequestPage />);
    expect(page.querySelector('[data-testid="frame-title"]')?.textContent).toMatch(/^PR-1: /);
    expect(page.textContent).not.toContain('PR-3');
    expect(page.textContent).toContain('Next: 2. Testing');
    expect(page.querySelector('[data-testid="pr-open-next"]')).not.toBeNull();
  });
  it("the Maintenance brief names the PR by the phase's place", async () => {
    const page = await mount(
      <MaintenanceBrief {...PANEL_PROPS({ id: 'p-m', key: 'maintenance', title: 'Maintenance', order: 6, place: 2, count: 2, attempts: 0, lastSubmission: null, files: [], projectSlug: 'late' })} />,
    );
    expect(page.textContent).toContain('PR-2 opens when you submit.');
    expect(page.textContent).not.toContain('PR-6');
  });
  it("the Implementation panel's brief names the PR by the phase's place", async () => {
    const Brief = implementationPanel.Brief!;
    const page = await mount(<Brief {...PANEL_PROPS({ ...IMPLEMENTATION, status: 'in_progress' })} />);
    expect(page.querySelector('h2')?.textContent).toBe('PR-1');
  });
  it('no site names a pull request by the stored order', () => {
    // Each site's own text must not name the order; it, or what it draws from, names the place.
    for (const site of [
      'app/(app)/workspace/[phaseId]/page.tsx',
      'app/(app)/workspace/[phaseId]/pr/page.tsx',
      'app/(app)/workspace/[phaseId]/change/page.tsx',
      'components/workspace/panels/implementation/index.tsx',
      'MaintenanceBrief',
      'MaintenanceTools',
    ]) {
      expect(moduleText(site), site).not.toMatch(/PR-\$\{detail\??\.order/);
      expect(closureText(site), site).toMatch(/PR-\$\{detail\??\.place/);
    }
  });
});

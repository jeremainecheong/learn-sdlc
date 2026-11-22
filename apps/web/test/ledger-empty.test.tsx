// @vitest-environment jsdom
/**
 * The words of the IDE's empty Ledger tab.
 *
 * The tab said "The conformance ledger arrives with the first verdict…"
 * whenever it held no row: after a verdict too, and in Deployment, where the
 * API never builds a ledger. The API builds `report.contract` only for an
 * Implementation or Maintenance review that is not a quiz's
 * (`FeedbackService.reportExtras`), so:
 *
 * - Implementation and Maintenance, no review yet: the sentence as it was;
 * - Implementation and Maintenance, a review with no claim in it: it says the
 *   review checked no design claim against the code;
 * - every other phase the room is opened in (Deployment, and Requirements or
 *   Design where a task opens the IDE), review or not: it says that phase has
 *   no conformance ledger and where the claims are checked.
 *
 * The tab stays where it is; only its empty-state words change.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractClaim, PhaseKey } from '@learnsdlc/shared';
import { report, submission } from './fixtures';
import { stubMatchMedia } from './support/dom';

const rig = vi.hoisted(() => ({
  phaseId: 'ledger-room',
  token: 'owner-a',
  load: vi.fn(),
  save: vi.fn(),
  exit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: rig.phaseId }),
  useRouter: () => rig.router,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string, public code?: string, public body?: unknown) {
      super(message);
    }
  }
  return {
    ApiError,
    API_URL: '/api',
    api: { saveWorkspace: rig.save, submit: vi.fn(), myEnrollment: vi.fn(async () => null) },
    getToken: () => rig.token,
    onSessionLeaving: () => () => {},
    signInHref: () => null,
  };
});
vi.mock('@/lib/session', () => ({
  getSession: () => ({ id: rig.token }),
  onSessionEnd: () => () => {},
  ownedByToken: (clear: () => void) => {
    let held = '';
    return () => {
      if (held !== rig.token) {
        clear();
        held = rig.token;
      }
    };
  },
}));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load },
  saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/useProject', () => ({
  useProject: () => ({ details: {}, enrollment: null, analytics: null }),
  fullDetail: () => null,
  invalidateProject: vi.fn(),
  learnerMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/usePreview', () => ({
  usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }),
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }),
  WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({
  preloadEditor: async () => {},
  loadedEditor: () => ({ value }: { value: string }) => <textarea aria-label="Code" value={value} readOnly />,
}));
vi.mock('@/components/shell', async () => ({
  ...(await import('@/components/shell/routes')),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => (
    <main>
      {strip}
      {children}
    </main>
  ),
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: () => null,
  ActivityBar: () => null,
  // Every bottom tab's content is drawn, so the Ledger tab can be read.
  BottomPanel: ({ tabs }: { tabs: { key: string; content: ReactNode }[] }) => (
    <div>
      {tabs.map((tab) => (
        <section key={tab.key} data-testid={`bottom-${tab.key}`}>
          {tab.content}
        </section>
      ))}
    </div>
  ),
  Explorer: () => null,
  PersonaComposer: () => null,
  PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }),
  PERSONA_NAME: {},
}));

const { emptyLedgerLine } = await import('@/components/workspace/panels/implementation/pr');
const { default: WorkspacePage } = await import('@/app/(app)/workspace/[phaseId]/page');

const BEFORE = 'The conformance ledger arrives with the first verdict: every claim your design made, against what the code did.';
const NONE_CHECKED = 'This review checked no design claim against the code, so there is nothing in the ledger.';
const DEPLOYMENT = "Deployment has no conformance ledger: the design's claims are checked against the code in Implementation and Maintenance.";
const elsewhere = (title: string) => `${title} has no conformance ledger: the design's claims are checked against the code in Implementation and Maintenance.`;

const CLAIM = {
  name: 'overdue', claim: 'returns', text: 'Returns: every task past its due date.', verdict: 'kept', story: 'US-1',
} as unknown as ContractClaim;

describe('the words, by phase and by whether a review exists', () => {
  it('Implementation and Maintenance: the first sentence before a review, the checked-nothing sentence after', () => {
    for (const key of ['implementation', 'maintenance'] as PhaseKey[]) {
      expect(emptyLedgerLine(key, false)).toBe(BEFORE);
      expect(emptyLedgerLine(key, true)).toBe(NONE_CHECKED);
    }
  });

  it('Deployment, review or not: it has no ledger, and says where claims are checked', () => {
    expect(emptyLedgerLine('deployment', true)).toBe(DEPLOYMENT);
    expect(emptyLedgerLine('deployment', false)).toBe(DEPLOYMENT);
  });

  it('Requirements and Design, where a task opens the IDE: the same, never a promise of a ledger', () => {
    expect(emptyLedgerLine('requirements', false)).toBe(elsewhere('Requirements'));
    expect(emptyLedgerLine('design', true)).toBe(elsewhere('Design'));
  });
});

describe('the IDE room, mounted', () => {
  let root: Root, host: HTMLDivElement, sequence = 0;
  beforeEach(() => {
    vi.clearAllMocks();
    rig.phaseId = `ledger-room-${++sequence}`;
    stubMatchMedia();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    rig.save.mockResolvedValue({ saved: true, version: '2026-10-02T05:00:00.000Z' });
    rig.exit.mockResolvedValue({ version: '2026-10-02T05:00:00.000Z' });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const reviewed = (contract?: ContractClaim[]) =>
    submission({
      id: 'rev-1', status: 'completed', passed: true, score: 90, attempt: 1, createdAt: '2026-10-02T05:00:00.000Z',
      report: report({
        overall: 90, passed: true, ...(contract ? { contract } : {}),
        aiReview: { summary: 'Fine.', strengths: [], improvements: [], processNote: '', criteriaEvidence: [] } as unknown as ReturnType<typeof report>['aiReview'],
      }),
    });
  const ledgerText = async (key: PhaseKey, title: string, lastSubmission: ReturnType<typeof submission> | null) => {
    const detail = {
      id: rig.phaseId, key, title, order: 3, place: 3, count: 6, status: lastSubmission ? 'passed' : 'in_progress', projectSlug: 'tasktrackr',
      workspaceUpdatedAt: '2026-10-02T05:00:00.000Z', files: [{ path: 'api/tasks.py', content: 'code', editable: true, language: 'python' }],
      attempts: lastSubmission ? 1 : 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [],
      canRun: false, canPreview: false, runLabel: 'Run tests', lastSubmission, solution: { available: false, files: 0, readAt: null },
    };
    rig.load.mockImplementation(async () => detail);
    window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
    await act(async () => {
      root.render(<WorkspacePage />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    return host.querySelector('[data-testid="phase-implementation-ledger"]')!.textContent;
  };

  it('Deployment with Review 1 Pass: no promise of a ledger', async () => {
    const text = await ledgerText('deployment', 'Deployment', reviewed());
    expect(text).toBe(DEPLOYMENT);
    expect(text).not.toContain('arrives with the first verdict');
  });

  it('Deployment before any review: no promise either', async () => {
    expect(await ledgerText('deployment', 'Deployment', null)).toBe(DEPLOYMENT);
  });

  it('Maintenance, a review with no claim in it: nothing was checked', async () => {
    expect(await ledgerText('maintenance', 'Maintenance', reviewed([]))).toBe(NONE_CHECKED);
  });

  it('Maintenance before any review reads its before-review sentence', async () => {
    expect(await ledgerText('maintenance', 'Maintenance', null)).toBe(BEFORE);
  });

  it('a ledger with a claim draws the claim, not a sentence', async () => {
    const text = await ledgerText('maintenance', 'Maintenance', reviewed([CLAIM]));
    expect(text).toContain('overdue');
    expect(text).not.toContain(NONE_CHECKED);
    expect(text).not.toContain(BEFORE);
  });
});

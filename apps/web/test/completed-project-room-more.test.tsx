// @vitest-environment jsdom
/**
 * The code room of a completed project, drawn by the REAL workspace page inside the
 * shell's project context. After Complete the project, More offers "Submit PR-<n> again", "Run the planted bugs" and
 * "Retry this phase" (Maintenance holds them in Details; the code rooms' More holds the same three). That is the
 * product's design, not a fault: retrying a phase after completion is a designed path (the API's `retryKeeps`, and
 * the retry's confirm says "Your project stays complete."), and a retry needs Submit after it. So a completed
 * project's room offers all three, exactly as a passed phase of a project not yet completed does.
 *
 * The rig is ide-room-in-flight-submit.test.tsx's (signoff-room-submit's harness).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  nav: null as null | { paletteGroups?: import('@/components/shell/types').PaletteGroup[] },
  poll: vi.fn(),
  PollTimeout: class extends Error { last?: unknown },
  phaseId: 'signoff-room', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(), submit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  setProject: vi.fn(),
  drafts: new Map<string, { ownerId: string; files: Record<string, string>; baseVersion: string }>(),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => rig.router, useSearchParams: () => new URLSearchParams(window.location.search) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public body?: unknown) { super(message); } }
  return { ApiError, API_URL: '/api', api: { saveWorkspace: rig.save, submit: rig.submit, myEnrollment: vi.fn(async () => null) },
    getToken: () => rig.token, onSessionLeaving: () => () => {}, signInHref: () => null };
});
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: rig.token }), onSessionEnd: () => () => {}, ownedByToken: (clear: () => void) => { let held = ''; return () => { if (held !== rig.token) { clear(); held = rig.token; } }; } }));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load }, saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/project-map', () => ({ ensureFullMap: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), useProjectMaybe: () => null, fullDetail: () => null, invalidateProject: vi.fn(), learnerMessage: (_err: unknown, fallback: string) => fallback }));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: rig.setProject }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: rig.PollTimeout, pollUntil: rig.poll, useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/usePreview', () => ({ usePreview: () => ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }), stopPreviewOnExit: vi.fn() }));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
// The Testing room reads the REAL hook; every other room keeps the stand-in.
vi.mock('@/components/workspace/panels/testing/useTesting', async (original) => {
  const real = await original<typeof import('@/components/workspace/panels/testing/useTesting')>();
  return {
    ...real,
    useTesting: (props: Parameters<typeof real.useTesting>[0]) =>
      props?.detail?.key === 'testing' ? real.useTesting(props) : ({ tests: [], linked: {}, view: { total: 0, killed: 0 }, criteria: [], mutants: [] }),
  };
});
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false, setBriefOpen: vi.fn(), setMentorOpen: vi.fn() }), WorkspacePanelControls: () => null, WorkspaceMentorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({ preloadEditor: async () => {}, loadedEditor: () =>
  ({ value }: { value: string }) => <textarea aria-label="Code" value={value} readOnly /> }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  WorkPage: ({ children, strip, nav }: { children: ReactNode; strip: ReactNode; nav: typeof rig.nav }) => { rig.nav = nav; return <main>{strip}{children}</main>; },
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: () => null,
  ActivityBar: () => null, BottomPanel: () => null, Explorer: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Ari' },
}));

import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { ProjectContext } from '@/lib/project-context';
import { settle, stubMatchMedia } from './support/dom';

const VERSION = '2026-10-04T01:00:00.000Z';
const CODE = 'tests/test_tasks.py';
/** A passed TaskTrackr Testing phase: one task with the empty key, its review passed. */
const passedTesting = () => ({
  id: rig.phaseId, key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'passed', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: VERSION, files: [{ path: CODE, content: 'def test_x():\n    assert True\n', editable: true, language: 'python' }],
  attempts: 1, bestScore: 100, passedAt: VERSION, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
  tasks: [{ key: '', order: 1, required: true, title: 'Testing', artefactType: 'code', evidence: 'automated', sealed: true, status: 'passed', awaitingSignOff: false,
    attempts: 1, bestScore: 100, passedAt: VERSION, lastSubmissionId: 'rev-1', resetAt: null, artefactPath: CODE, primaryPath: CODE, files: [CODE], solution: { available: false, files: 0, readAt: null } }],
  taskCounts: { total: 1, required: 1, passed: 1, passedRequired: 1 },
  lastSubmission: { id: 'rev-1', taskKey: '', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: VERSION, report: null },
  solution: { available: false, files: 0, readAt: null },
});
const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
/** The shell's project: this phase held in the enrolment, the project completed or the learner on Deployment. */
const held = (completed: boolean) => ({
  enrollment: {
    id: 'e', projectSlug: 'tasktrackr', projectTitle: 'TaskTrackr', currentPhaseOrder: completed ? 6 : 5, completed, releases: [],
    phases: KEYS.map((key, at) => ({ id: key === 'testing' ? rig.phaseId : `p-${key}`, key, order: at + 1, title: key, status: completed || at < 4 ? 'passed' : 'in_progress' })),
  },
  details: {}, analytics: null,
});

let root: Root, host: HTMLDivElement, sequence = 0;
const open = async (completed: boolean) => {
  const detail = passedTesting();
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
  await act(async () => { root.render(<ProjectContext.Provider value={held(completed) as never}><WorkspacePage /></ProjectContext.Provider>); });
  await settle(6);
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `look-complete-${++sequence}`; rig.token = `owner-${sequence}`; rig.nav = null;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  rig.poll.mockReset(); rig.poll.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('More in the code room of a completed project', () => {
  it('passed, the project not completed: More offers Submit PR-4 again, Run the planted bugs and Retry this phase', async () => {
    await open(false);
    expect(q('header-submit')?.textContent).toContain('Submit PR-4 again');
    expect(q('header-mutants')?.textContent).toContain('Run the planted bugs');
    expect(q('task-reset-open')?.textContent).toBe('Retry this phase');
  });

  it('completed: More still offers Submit PR-4 again, Run the planted bugs and Retry this phase, and the reading doors', async () => {
    await open(true);
    expect(q('header-submit')?.textContent).toContain('Submit PR-4 again');
    expect(q('header-mutants')?.textContent).toContain('Run the planted bugs');
    expect(q('task-reset-open')?.textContent).toBe('Retry this phase');
    expect(q('open-brief')).not.toBeNull();
    expect(q('open-document')).not.toBeNull();
  });
});

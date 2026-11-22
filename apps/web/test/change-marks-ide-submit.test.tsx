// @vitest-environment jsdom
/**
 * The IDE's Submit ends the change room's "changed by the assistant" marks on
 * a Maintenance, as the change room's own Submit does: Maintenance has two
 * submit doors, and a mark lasts until the field is edited or submitted
 * (spec 5.4).
 *
 * The harness is ide-room-in-flight-submit.test.tsx's.
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
import { readChangeTouched, recordChangeTouched } from '@/components/workspace/panels/maintenance/change-edit';
import { settle, stubMatchMedia } from './support/dom';

const VERSION = '2026-10-16T01:00:00.000Z';
const CODE = 'api/repository/comments.py';
const phase = (key: 'maintenance' | 'implementation') => ({
  id: rig.phaseId, key, title: key, order: key === 'maintenance' ? 6 : 3, status: 'in_progress', projectSlug: 'tasktrackr', artifactKind: 'code',
  // a Maintenance with its change request, as every Maintenance of the code kind now ships (an older one is refused)
  ...(key === 'maintenance' ? { change: { ticket: { id: 'CR-2', title: 'Comments on tasks', summary: 'Tasks carry comments.', acceptance: [{ id: 'AC-1', line: 'A task lists its comments.' }] }, contract: false, floor: { minImpact: 0, minContract: 0, minTests: 0, requireRelease: false, traceEveryAcceptance: false } }, } : {}),
  workspaceUpdatedAt: VERSION, files: [{ path: CODE, content: 'saved code', editable: true, language: 'python' }],
  attempts: 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
  tasks: [{
    key: '', order: 1, required: true, title: 'The change', artefactType: 'code', evidence: 'automated', sealed: true, status: 'in_progress',
    awaitingSignOff: false, attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null,
    artefactPath: CODE, primaryPath: CODE, files: [CODE], solution: { available: false, files: 0, readAt: null },
  }],
  taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
  lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
});

let root: Root, host: HTMLDivElement, sequence = 0;
const open = async (detail: ReturnType<typeof phase>) => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await settle(6);
};

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `ide-submit-${++sequence}`; rig.token = `owner-${sequence}`; rig.nav = null;
  sessionStorage.clear();
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  rig.submit.mockResolvedValue({ id: 'rev-1', taskKey: null, status: 'queued', passed: null, score: null, attempt: 1, createdAt: VERSION, report: null });
  rig.poll.mockReset(); rig.poll.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the IDE\'s Submit and the change room\'s marks', () => {
  it('a Maintenance submitted from the IDE ends the marks', async () => {
    recordChangeTouched(rig.phaseId, { 'release:version': '2.1.0' });
    await open(phase('maintenance'));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="header-submit"]')!.click(); });
    await settle(6);
    expect(rig.submit).toHaveBeenCalledTimes(1);
    expect(readChangeTouched(rig.phaseId)).toEqual({});
  });

  it('a refused submit keeps them', async () => {
    rig.submit.mockRejectedValue(new Error('refused in this test'));
    recordChangeTouched(rig.phaseId, { 'release:version': '2.1.0' });
    await open(phase('maintenance'));
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="header-submit"]')!.click(); });
    await settle(6);
    expect(rig.submit).toHaveBeenCalledTimes(1);
    expect(readChangeTouched(rig.phaseId)).toEqual({ 'release:version': '2.1.0' });
  });
});

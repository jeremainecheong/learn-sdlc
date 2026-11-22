// @vitest-environment jsdom
/**
 * The generic room (the IDE page, also where `?task=` opens a written task)
 * on a task that passed its review and waits on the teacher's
 * countersignature.
 *
 * The header's "Submit again" and ⌘↵ must be off. A resubmit is worse than
 * one review's cost: a failed one clears the task's `awaitingSignOff` (the
 * API's task roll-up), so the learner drops out of the teacher's sign-off
 * queue. While the countersignature is pending the control is off with
 * SIGN_OFF_SUBMIT_REASON (the same pattern as the Requirements room's
 * "Submit for review"), and the shortcut sends nothing. Every other state is
 * unaffected.
 *
 * The harness is ide-keystroke-renders.test.tsx's: the REAL page, with the
 * strip drawing its right-hand controls and the network stood in for.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
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
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: vi.fn(), learnerMessage: (_err: unknown, fallback: string) => fallback }));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: rig.setProject }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(), useRecoverWhenBack: vi.fn() }));
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
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
  PhaseStrip: ({ right }: { right: ReactNode }) => <header>{right}</header>,
  StatusBar: () => null,
  ActivityBar: () => null, BottomPanel: () => null, Explorer: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Ari' },
}));

import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';
import { stubMatchMedia } from './support/dom';

const VERSION = '2026-10-02T05:00:00.000Z';
const CODE = 'api/repository/tasks.py';
type Row = Record<string, unknown>;
const task = (over: Row = {}): Row => ({
  key: 'main', order: 1, required: true, title: 'The repository', artefactType: 'code', evidence: 'signed-off', sealed: true,
  status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
  artefactPath: CODE, primaryPath: CODE, files: [CODE],
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const phase = (tasks: Row[], over: Row = {}) => ({
  id: rig.phaseId, key: 'implementation', title: 'Implementation', order: 3, status: 'submitted', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: VERSION, files: [{ path: CODE, content: 'saved code', editable: true, language: 'python' }],
  attempts: 1, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: false, canPreview: false, runLabel: 'Run tests',
  tasks,
  taskCounts: {
    total: tasks.length,
    required: tasks.filter((row) => row.required).length,
    passed: tasks.filter((row) => row.status === 'passed').length,
    passedRequired: tasks.filter((row) => row.required && row.status === 'passed').length,
  },
  lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});

let root: Root, host: HTMLDivElement, sequence = 0;
const submitButton = () => host.querySelector<HTMLButtonElement>('[data-testid="header-submit"]')!;
const open = async (detail: Row, search = '') => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}${search}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await act(async () => { await Promise.resolve(); });
};
const pressEnter = () => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await Promise.resolve();
});
const describedBy = (button: HTMLButtonElement) => {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `signoff-room-${++sequence}`; rig.token = `owner-${sequence}`;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  rig.submit.mockRejectedValue(new Error('refused in this test'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('the room while the task waits on the countersignature', () => {
  it('one-task phase: Submit again is off, says why, and ⌘↵ hands nothing in', async () => {
    await open(phase([task()]));
    const button = submitButton();
    expect(button.textContent).toContain('Submit again');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
    expect(describedBy(button)).toBe(SIGN_OFF_SUBMIT_REASON);
    await pressEnter();
    expect(rig.submit).not.toHaveBeenCalled();
  });

  it('split phase, ?task= on the waiting task: off, with the reason, and ⌘↵ hands nothing in', async () => {
    await open(
      phase([task({ key: 'countersign', title: 'The countersigned piece' }), task({ key: 'other', order: 2, evidence: 'reviewed', status: 'in_progress', awaitingSignOff: false, attempts: 0, lastSubmissionId: null })]),
      '?task=countersign',
    );
    const button = submitButton();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
    await pressEnter();
    expect(rig.submit).not.toHaveBeenCalled();
  });

  // The Testing room's "planted bugs" control submits
  // too, so it is off with the same reason while the task waits.
  it('Testing phase: the planted-bugs control is off with the reason too', async () => {
    await open(phase([task()], { key: 'testing', title: 'Testing', order: 4 }));
    const mutants = host.querySelector<HTMLButtonElement>('[data-testid="header-mutants"]')!;
    expect(mutants).toBeTruthy();
    expect(mutants.disabled).toBe(true);
    expect(mutants.getAttribute('title')).toContain(SIGN_OFF_SUBMIT_REASON);
    expect(describedBy(mutants)).toBe(SIGN_OFF_SUBMIT_REASON);
    expect(submitButton().disabled).toBe(true);
  });
});

describe('every other state of the room reads its own words, with no countersignature line', () => {
  it('Testing phase after the countersignature: the planted-bugs control is on', async () => {
    await open(phase([task({ status: 'passed', awaitingSignOff: false, passedAt: VERSION })], { key: 'testing', title: 'Testing', order: 4, status: 'passed' }));
    const mutants = host.querySelector<HTMLButtonElement>('[data-testid="header-mutants"]')!;
    expect(mutants.disabled).toBe(false);
    expect(mutants.getAttribute('title')).toBe('Run the planted bugs (⌘⇧M)');
    expect(mutants.getAttribute('aria-describedby')).toBeNull();
  });

  it('split phase, ?task= on the sibling still open: Submit is on, and ⌘↵ hands it in', async () => {
    await open(
      phase([task({ key: 'countersign' }), task({ key: 'other', order: 2, evidence: 'reviewed', status: 'in_progress', awaitingSignOff: false, attempts: 0, lastSubmissionId: null })]),
      '?task=other',
    );
    const button = submitButton();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toBeNull();
    await pressEnter();
    expect(rig.submit).toHaveBeenCalledTimes(1);
  });

  it('after the countersignature: Submit again is on, and ⌘↵ hands it in', async () => {
    await open(phase([task({ status: 'passed', awaitingSignOff: false, passedAt: VERSION })], { status: 'passed' }));
    const button = submitButton();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('title')).toBeNull();
    await pressEnter();
    expect(rig.submit).toHaveBeenCalledTimes(1);
  });

  it('a refused review on a marked task (submitted, not waiting): Submit again is on', async () => {
    await open(phase([task({ awaitingSignOff: false })]));
    const button = submitButton();
    expect(button.disabled).toBe(false);
    await pressEnter();
    expect(rig.submit).toHaveBeenCalledTimes(1);
  });

  it('a payload without tasks: Submit is on', async () => {
    await open(phase([], { tasks: undefined, taskCounts: undefined, status: 'in_progress', attempts: 0 }));
    const button = submitButton();
    expect(button.disabled).toBe(false);
    await pressEnter();
    expect(rig.submit).toHaveBeenCalledTimes(1);
  });
});

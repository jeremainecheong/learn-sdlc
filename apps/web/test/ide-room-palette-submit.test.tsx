// @vitest-environment jsdom
/**
 * The generic room (the IDE page) and its ⌘K entry.
 *
 * The queued case: the header's Submit is off while the task waits on the
 * teacher's countersignature, and also while a newer revision of the task is
 * still queued or being reviewed, even when the room has stopped following
 * it (the watch gave up, or another tab handed it in), because the API
 * refuses a second revision in flight for a task. Submit and ⌘↵ are off with
 * REVISION_IN_FLIGHT_REASON and on again once the verdict is in.
 *
 * The palette's "Submit for review" must not stay listed and do nothing while
 * the task waits. It is a disabled row (aria-disabled) whose second line is
 * the reason, and choosing it does nothing; on otherwise.
 *
 * The harness is signoff-room-submit.test.tsx's, with the poll and the
 * shell's palette groups held where the test can reach them.
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
import { Palette } from '@/components/shell/Palette';
import * as signoff from '@/components/workspace/signoff-status';
import { settle, stubMatchMedia } from './support/dom';
/** Read through the namespace so a missing export fails an assertion, not the import. */
const IN_FLIGHT = () => (signoff as Record<string, unknown>).REVISION_IN_FLIGHT_REASON as string | undefined;
const { SIGN_OFF_SUBMIT_REASON } = signoff;

/** Revisions are made a minute or two ago: one in flight older than the API's
 * age-out window (IN_FLIGHT_MAX_AGE_MS) does not hold Submit off. */
const FRESH = new Date(Date.now() - 120_000).toISOString();
const VERSION = '2026-10-04T01:00:00.000Z';
const CODE = 'api/repository/tasks.py';
type Row = Record<string, unknown>;
const task = (over: Row = {}): Row => ({
  key: 'main', order: 1, required: true, title: 'The repository', artefactType: 'code', evidence: 'signed-off', sealed: true,
  status: 'submitted', awaitingSignOff: false, attempts: 1, bestScore: 40, passedAt: null, lastSubmissionId: 'rev-1', resetAt: null,
  artefactPath: CODE, primaryPath: CODE, files: [CODE],
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
const revision = (id: string, status: string, passed: boolean | null = null, taskKey = 'main') =>
  ({ id, taskKey, status, passed, score: passed === false ? 40 : null, attempt: 2, createdAt: FRESH, report: null });
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
let paletteRoot: Root | null = null, paletteHost: HTMLDivElement | null = null;
const open = async (detail: Row, search = '') => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}${search}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await settle(6);
};
/** The room's own ⌘K row, as the shell is handed it. */
const submitEntry = () => rig.nav?.paletteGroups?.flatMap((group) => group.items).find((item) => item.label === 'Submit for review');
/** The same row drawn by the REAL palette, opened. */
const drawPalette = async () => {
  paletteHost = document.createElement('div'); document.body.append(paletteHost); paletteRoot = createRoot(paletteHost);
  await act(async () => { paletteRoot!.render(<Palette groups={rig.nav!.paletteGroups!} trigger={<button type="button" data-opener>Open</button>} />); });
  await act(async () => { paletteHost!.querySelector<HTMLButtonElement>('[data-opener]')!.click(); });
  return Array.from(paletteHost.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((row) => row.textContent?.includes('Submit for review'))!;
};

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `re-rooms-${++sequence}`; rig.token = `owner-${sequence}`; rig.nav = null;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = false; }) });
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  rig.submit.mockRejectedValue(new Error('refused in this test'));
  rig.poll.mockReset(); rig.poll.mockImplementation(() => new Promise(() => undefined));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  if (paletteRoot) act(() => paletteRoot!.unmount());
  paletteHost?.remove(); paletteRoot = null; paletteHost = null;
  act(() => root.unmount()); host.remove();
});

describe('the palette\'s "Submit for review"', () => {
  it('while the task waits on the countersignature: a disabled row that says why, and choosing it hands nothing in', async () => {
    await open(phase([task({ awaitingSignOff: true, bestScore: 88 })], { lastSubmission: revision('rev-1', 'completed', true) }));
    const entry = submitEntry();
    expect(entry, 'the room offers the row').toBeTruthy();
    expect(entry!.disabled).toBe(true);
    expect(entry!.detail).toBe(SIGN_OFF_SUBMIT_REASON);
    const row = await drawPalette();
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.textContent).toContain(SIGN_OFF_SUBMIT_REASON);
    await act(async () => { row.click(); });
    entry!.onSelect?.();
    await settle(6);
    expect(rig.submit).not.toHaveBeenCalled();
  });

  it('while a newer revision is in flight: a disabled row with the in-flight reason', async () => {
    await open(phase([task()], { lastSubmission: revision('rev-2', 'queued') }));
    const entry = submitEntry();
    expect(entry!.disabled).toBe(true);
    expect(entry!.detail).toBe(IN_FLIGHT());
    const row = await drawPalette();
    expect(row.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { row.click(); });
    expect(rig.submit).not.toHaveBeenCalled();
  });

  it('otherwise the row is on, reads "Graded against the phase gate" and hands the revision in', async () => {
    await open(phase([task()], { lastSubmission: revision('rev-1', 'completed', false) }));
    const entry = submitEntry();
    expect(entry!.disabled).toBeFalsy();
    expect(entry!.detail).toBe('Graded against the phase gate');
    const row = await drawPalette();
    expect(row.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { row.click(); });
    await settle(6);
    expect(rig.submit).toHaveBeenCalledTimes(1);
  });
});

describe("the palette's Code group", () => {
  it('lists the code files and never the two records, which are forms in their rooms', async () => {
    const files = [
      { path: CODE, content: 'saved code', editable: true, language: 'python' },
      { path: 'deployment/runbook.json', content: '{}', editable: true, language: 'json' },
      { path: 'maintenance/change-request.json', content: '{}', editable: true, language: 'json' },
    ];
    await open(phase([task()], { files, lastSubmission: revision('rev-1', 'completed', false) }));
    const code = rig.nav?.paletteGroups?.find((group) => group.label === 'Code');
    expect(code?.items.map((item) => item.label)).toEqual([CODE]);
  });
});

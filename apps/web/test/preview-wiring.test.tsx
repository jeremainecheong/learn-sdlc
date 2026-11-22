// @vitest-environment jsdom
/**
 * The REAL work room hands the app preview panel its two props for the
 * current save.
 *
 * - `savedVersion`: the room's newest save, held in state, so a save shows
 *   "Preview is using an earlier version of your code." at once, with no
 *   status poll (the preview hook is stood in for and never polls here);
 * - `onOpenAppView`: the too-short line's "Open App preview" switches the
 *   Implementation room to its App preview view; where the panel is already
 *   drawn in that view (there, or in a runtime room's third working view),
 *   the line offers no switch to itself.
 *
 * The harness is work-room-header.test.tsx's, with a live preview and an editor
 * that types.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/dom';

const rig = vi.hoisted(() => ({
  phaseId: 'shell-room', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(), submit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  areaHeight: 0,
  observers: [] as { cb: () => void }[],
  preview: null as unknown as Record<string, any>,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => rig.router, useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => `/workspace/${rig.phaseId}` }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => {
  class ApiError extends Error { constructor(public status: number, message: string, public code?: string, public body?: unknown) { super(message); } }
  return { ApiError, API_URL: '/api', api: { saveWorkspace: rig.save, submit: rig.submit, myEnrollment: vi.fn(async () => null), getSubmission: vi.fn() },
    getToken: () => rig.token, onSessionLeaving: () => () => {}, signInHref: () => null };
});
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: rig.token }), useSession: () => ({ id: rig.token, role: 'LEARNER' }), onSessionEnd: () => () => {}, ownedByToken: (clear: () => void) => { let held = ''; return () => { if (held !== rig.token) { clear(); held = rig.token; } }; } }));
vi.mock('@/lib/api-workspace', () => ({
  workspaceApi: { phase: rig.load }, saveVersionedWorkspaceOnExit: rig.exit,
  readVersionedWorkspaceDraft: () => null,
  rememberVersionedWorkspaceDraft: () => {},
  acknowledgeVersionedWorkspaceSave: () => {},
  discardVersionedWorkspaceDraft: () => {},
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), useProjectMaybe: () => null, fullDetail: () => null, invalidateProject: vi.fn(), learnerMessage: (_err: unknown, fallback: string) => fallback }));
vi.mock('@/lib/project', () => ({ getActiveProject: () => 'tasktrackr', setActiveProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ cachedRecords: () => ({}), loadRecords: vi.fn(), refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn(), useCommitDraft: () => ['', vi.fn()] }));
vi.mock('@/lib/poll', () => ({ PollTimeoutError: class extends Error {}, pollUntil: vi.fn(() => new Promise(() => {})), useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/usePreview', async (original) => ({
  ...(await original<typeof import('@/components/workspace/usePreview')>()),
  usePreview: () => rig.preview,
  stopPreviewOnExit: vi.fn(),
}));
vi.mock('@/components/workspace/panels', () => ({ PHASE_PANELS: {} }));
vi.mock('@/components/workspace/FeedbackPanel', () => ({ FeedbackPanel: () => <div data-testid="feedback-verdict">The verdict</div> }));
vi.mock('@/components/workspace/panels/testing/useTesting', async (original) => {
  const real = await original<typeof import('@/components/workspace/panels/testing/useTesting')>();
  return { ...real, useTesting: () => ({ tests: [], linked: {}, view: { total: 0, killed: 0, rows: [] }, criteria: [], mutants: [], first: [] }) };
});
vi.mock('@/components/workspace/WorkspacePanels', () => ({
  useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: true, setBriefOpen: vi.fn(), setMentorOpen: vi.fn(), briefId: 'brief', mentorId: 'mentor' }),
  WorkspacePanelControls: ({ panels, placement }: any) => (
    <div data-testid="panel-controls" data-placement={placement ?? 'row'} data-brief={String(panels.briefOpen)} data-mentor={String(panels.mentorOpen)}>
      <button type="button" data-testid="toggle-brief" onClick={() => panels.setBriefOpen(!panels.briefOpen)}>brief</button>
    </div>
  ),
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/workspace/ImplementationTaskPanel', () => ({ ImplementationTaskPanel: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/Markdown', () => ({ Markdown: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/preload', () => ({ preloadEditor: async () => {}, loadedEditor: () =>
  ({ value, path, onChange }: { value: string; path: string; onChange: (v: string) => void }) => (
    <textarea aria-label="Code" data-path={path} value={value} onChange={(event) => onChange(event.target.value)} />
  ) }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>,
  StatusBar: () => null,
  ActivityBar: () => null, Explorer: () => null, PersonaComposer: () => null, PersonaFeed: () => null,
  BottomPanel: ({ tabs, value, onChange }: { tabs: { key: string; testId?: string; label: string }[]; value: string; onChange: (k: string) => void }) => (
    <div data-testid="bottom-panel" data-value={value}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" data-testid={t.testId ?? `tab-${t.key}`} aria-selected={t.key === value} onClick={() => onChange(t.key)}>{t.label}</button>
      ))}
    </div>
  ),
  usePersona: () => ({ messages: [], busy: false }), PERSONA_NAME: { implementation: 'Ari', testing: 'Quinn' },
}));

import WorkspacePage from '@/app/(app)/workspace/[phaseId]/page';
import { stubMatchMedia } from './support/dom';

const BUILT = '2026-11-09T01:00:00.000Z';
const LATER = '2026-11-09T01:05:00.000Z';
type Row = Record<string, unknown>;
const phase = (over: Row = {}): Row => ({
  id: rig.phaseId, key: 'implementation', title: 'Implementation', order: 3, place: 3, count: 6, status: 'in_progress', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: BUILT,
  files: [{ path: 'api/app.py', content: 'app = None', editable: true, language: 'python' }],
  attempts: 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: true, canPreview: true, runLabel: 'Run tests',
  tasks: undefined, taskCounts: undefined, lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});
/** A running app built from the save the room opened on; the poll's own stamp says the same. */
const livePreview = () => ({
  status: 'ready', url: 'http://127.0.0.1:4000/preview/x/', nonce: 0, errors: 0, starting: false, error: null, console: [],
  session: {
    id: 'live', phaseStateId: rig.phaseId, status: 'ready', url: 'http://127.0.0.1:4000/preview/x/', bundleOk: true, message: null, stopReason: null,
    startedAt: BUILT, readyAt: BUILT, expiresAt: '2099-01-01T00:00:00.000Z', idleExpiresAt: '2099-01-01T00:00:00.000Z',
    bytesServed: 0, console: [], cursor: 0, builtFromVersion: BUILT, workspaceVersion: BUILT,
  },
  stop: vi.fn(), refresh: vi.fn(), start: vi.fn(),
});

let root: Root, host: HTMLDivElement, sequence = 0;
const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T & HTMLElement>(selector);
const open = async (detail: Row) => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};
const press = async (node: HTMLElement | null) => {
  expect(node).not.toBeNull();
  await act(async () => { node!.click(); });
};
const section = () => $('[data-workspace-view]')!;

class FakeResizeObserver {
  constructor(private cb: () => void) { rig.observers.push({ cb }); }
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `preview-wiring-${++sequence}`; rig.token = `owner-${sequence}`; rig.observers = [];
  rig.preview = livePreview();
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  rig.save.mockResolvedValue({ saved: true, version: LATER }); rig.exit.mockResolvedValue({ version: BUILT });
  rig.submit.mockRejectedValue(new Error('refused in this test'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('savedVersion: a save is noticed without a poll', () => {
  it('no stale line on the build the room opened on; it appears once a save is acknowledged', async () => {
    await open(phase());
    expect($('[data-testid="preview-pane"]')).not.toBeNull();
    expect($('[data-testid="preview-stale"]')).toBeNull();
    await act(async () => {
      fireEvent.change($('textarea[aria-label="Code"]')!, { target: { value: 'app = "saved later"' } });
    });
    // The autosave's debounce, then its answer; nothing else moves the panel.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
    expect(rig.save).toHaveBeenCalledTimes(1);
    expect(rig.preview.refresh).not.toHaveBeenCalled();
    // The poll's own stamp still names the build: only the room's save moved.
    expect(rig.preview.session.workspaceVersion).toBe(BUILT);
    expect($('[data-testid="preview-stale"]')!.textContent).toContain('Preview is using an earlier version of your code.');
    expect($('[data-testid="preview-rebuild"]')).not.toBeNull();
  });
});

describe('onOpenAppView: the too-short line opens the App preview view', () => {
  it('Implementation: "Open App preview" switches the room to its App preview view, which then offers it no more', async () => {
    await open(phase());
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    // jsdom lays nothing out, so the pane reads as too short to show the app.
    expect($('[data-testid="preview-too-short"]')).not.toBeNull();
    const offer = $('[data-testid="preview-too-short-app-view"]')!;
    expect(offer.textContent).toBe('Open App preview');
    await press(offer);
    expect(section().getAttribute('data-workspace-view')).toBe('preview');
    expect($('nav[aria-label="Implementation working area"] button[aria-pressed="true"]')!.textContent).toContain('App preview');
    expect($('[data-testid="preview-too-short"]')).not.toBeNull();
    expect($('[data-testid="preview-too-short-app-view"]')).toBeNull();
  });

  it('a runtime room (Testing) draws its panel only in its App preview view, so the line there offers no switch to itself', async () => {
    await open(phase({ key: 'testing', title: 'Testing', order: 4, place: 4, files: [{ path: 'tests/test_app.py', content: 'def test_x(): pass', editable: true, language: 'python' }] }));
    expect($('[data-testid="preview-pane"]')).toBeNull();
    const appView = [...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase working area"] > button')].find((b) => b.textContent?.includes('App preview'))!;
    await press(appView);
    expect(section().getAttribute('data-workspace-view')).toBe('preview');
    expect($('[data-testid="preview-too-short"]')).not.toBeNull();
    expect($('[data-testid="preview-too-short-app-view"]')).toBeNull();
  });
});

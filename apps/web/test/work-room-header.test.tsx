// @vitest-environment jsdom
/**
 * The REAL work room, with the
 * network stood in for, read for its header, its band and its working area.
 *
 * - the header carries the phase, "Phase n of 6", one state chip and at most
 *   one primary action; every other door is in its "More" menu;
 * - "View review" opens the full-height results and the Review tab in one
 *   press, and changing the view never swaps the selected result tab for
 *   Tests; going back to the code is the same editor on the same file;
 * - under 520 px of pane area the room opens focused: the brief and the mentor
 *   collapsed, and a Code / Results switch;
 * - the Testing room's planted bugs are "Planted bugs" in the view.
 *
 * The harness is signoff-room-submit.test.tsx's, with a BottomPanel that
 * draws its tabs so the selected one can be read.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rig = vi.hoisted(() => ({
  phaseId: 'shell-room', token: 'owner-a', save: vi.fn(), load: vi.fn(), exit: vi.fn(), submit: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
  areaHeight: 0,
  observers: [] as { cb: () => void }[],
  /** The room's read-back after an Apply, as it hands it to the assistant's signals. */
  applied: null as null | ((workspace?: Record<string, string>) => Promise<unknown>),
  /** The room's "Start this task over" answer, as it hands it to the control. */
  reset: null as null | ((result: { version: string }, plan: { restores: string[]; reseeds: string[] }) => unknown),
  /** The preview hook's answer where a test runs the app; null is the idle preview. */
  preview: null as null | Record<string, unknown>,
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
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: (_phaseId: string, _flush: unknown, refresh: (workspace?: Record<string, string>) => Promise<unknown>) => { rig.applied = refresh; return false; } }));
vi.mock('@/components/workspace/preview/client/ClientPagePreview', () => ({ ClientPagePreview: () => <div data-testid="client-page-preview">Page preview: your code running in the browser<iframe data-testid="page-preview-frame" title="Page preview" /></div> }));
vi.mock('@/components/workspace/usePreview', () => ({ usePreview: () => rig.preview ?? ({ status: 'idle', console: [], errors: 0, stop: vi.fn() }), stopPreviewOnExit: vi.fn() }));
vi.mock('@/components/workspace/TaskResetControl', async (original) => ({
  ...await original<typeof import('@/components/workspace/TaskResetControl')>(),
  TaskResetControl: ({ onReset }: { onReset: typeof rig.reset }) => { rig.reset = onReset; return null; },
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
  ({ value, path }: { value: string; path: string }) => <textarea aria-label="Code" data-path={path} value={value} readOnly /> }));
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
import { PhaseAreaNav } from '@/components/workspace/AreaNav';
import { phaseTutorialMarks } from '@/components/shell/tours';
import { stubMatchMedia } from './support/dom';

const VERSION = '2026-11-09T01:00:00.000Z';
const TESTS = 'tests/test_acceptance.py';
const OTHER = 'tests/conftest.py';
type Row = Record<string, unknown>;
const verdict = (passed: boolean): Row => ({ id: `rev-${passed}`, status: 'completed', passed, attempt: 1, createdAt: VERSION, report: null });
const phase = (over: Row = {}): Row => ({
  id: rig.phaseId, key: 'testing', title: 'Testing', order: 4, place: 4, count: 6, status: 'in_progress', projectSlug: 'tasktrackr',
  workspaceUpdatedAt: VERSION,
  files: [
    { path: TESTS, content: 'def test_one(): pass', editable: true, language: 'python' },
    { path: OTHER, content: 'import pytest', editable: false, language: 'python' },
  ],
  attempts: 0, rubric: { passThreshold: 70, criteria: [] }, objectives: [], taskPanel: '', links: [], canRun: true, canPreview: false, runLabel: 'Run tests',
  tasks: undefined, taskCounts: undefined, lastSubmission: null,
  solution: { available: false, files: 0, readAt: null },
  ...over,
});

let root: Root, host: HTMLDivElement, sequence = 0;
const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T & HTMLElement>(selector);
const open = async (detail: Row, query = '') => {
  rig.load.mockImplementation(async () => detail);
  window.history.replaceState(null, '', `/workspace/${rig.phaseId}${query}`);
  await act(async () => { root.render(<WorkspacePage />); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};
const press = async (node: HTMLElement | null) => {
  expect(node).not.toBeNull();
  await act(async () => { node!.click(); });
};
const viewButton = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase working area"] > button, nav[aria-label="Phase working area"] > a')].find((b) => b.textContent?.trim() === label) ?? null;
const section = () => $('[data-workspace-view]')!;

class FakeResizeObserver {
  constructor(private cb: () => void) { rig.observers.push({ cb }); }
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.clearAllMocks(); rig.phaseId = `shell-room-${++sequence}`; rig.token = `owner-${sequence}`; rig.areaHeight = 0; rig.observers = []; rig.reset = null; rig.preview = null;
  stubMatchMedia();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('phase-lab-workspace')) return { height: rig.areaHeight, width: 1200, top: 0, left: 0, right: 1200, bottom: rig.areaHeight, x: 0, y: 0, toJSON() {} } as DOMRect;
    return real.call(this);
  });
  rig.save.mockResolvedValue({ saved: true, version: VERSION }); rig.exit.mockResolvedValue({ version: VERSION });
  rig.submit.mockRejectedValue(new Error('refused in this test'));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

describe('one header row with one primary action', () => {
  it('in progress: the phase, "Phase 4 of 6", "In progress", and Submit as the one primary; the rest is in More', async () => {
    await open(phase());
    expect($('[data-testid="phase-title"]')!.textContent).toBe('Testing');
    expect($('[data-testid="phase-place"]')!.textContent).toBe('Phase 4 of 6');
    expect($('[data-testid="phase-state"]')!.textContent).toBe('In progress');
    const primaries = host.querySelectorAll('[data-testid="phase-strip"] > .phase-strip-primary');
    expect(primaries).toHaveLength(1);
    expect(primaries[0].querySelector('[data-testid="header-submit"]')).not.toBeNull();
    // Run tests stays on the row as a secondary control, never the primary.
    expect($('[data-testid="header-run"]')!.className).toContain('btn-secondary');
    const menu = $('details[data-testid="phase-more"]')!;
    expect(menu.querySelector('summary')!.getAttribute('aria-label')).toBe('More phase actions');
    for (const id of ['open-brief', 'open-document', 'header-mutants']) {
      expect(menu.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(menu.querySelector('[data-testid="open-document"]')!.textContent).toBe('Planted bugs');
    expect(menu.querySelector('[data-testid="header-submit"]')).toBeNull();
    // No band while the gate has nothing to say.
    expect($('[data-testid="gate-banner"]')).toBeNull();
    expect($('[data-testid="review-band"]')).toBeNull();
  });

  it('passed: "Review passed", Continue in the band, Submit again only in the menu', async () => {
    await open(phase({ status: 'passed', attempts: 1, lastSubmission: verdict(true) }));
    expect($('[data-testid="phase-state"]')!.textContent).toBe('Review passed');
    expect(host.querySelector('[data-testid="phase-strip"] > .phase-strip-primary')).toBeNull();
    const submit = $('details[data-testid="phase-more"] [data-testid="header-submit"]')!;
    // Named by its pull request, "again" once one exists.
    expect(submit.textContent).toContain('Submit PR-4 again');
    expect(submit.className).toContain('btn-secondary');
    expect($('[data-testid="gate-banner"] [data-testid="open-reflection"]')!.textContent).toContain('Continue to next phase');
    expect($('[data-testid="gate-banner"] [data-testid="gate-label"]')!.textContent).toBe('Ready to continue.');
  });

  it('a passed phase whose reference solution is open offers it in More, as the phase\'s document pages do; before that, nowhere', async () => {
    await open(phase({ status: 'passed', attempts: 1, lastSubmission: verdict(true), solution: { available: true, files: 2, readAt: null } }));
    const door = $('details[data-testid="phase-more"] [data-testid="solution-open"]')!;
    expect(door.textContent).toBe('Read the reference solution');
    expect(door.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/solution`);
    expect(host.querySelectorAll('[data-testid="solution-open"]')).toHaveLength(1);
    act(() => root.unmount());
    root = createRoot(host);
    await open(phase({ status: 'in_progress', solution: { available: true, files: 2, readAt: null } }));
    expect($('[data-testid="solution-open"]')).toBeNull();
  });

  it('needs revision: the band says so with View review, and Submit leads the header', async () => {
    await open(phase({ attempts: 1, lastSubmission: verdict(false) }));
    expect($('[data-testid="phase-state"]')!.textContent).toBe('Needs revision');
    expect($('[data-testid="review-band"]')!.getAttribute('data-gate')).toBe('revise');
    expect($('[data-testid="review-band"] [data-testid="gate-view-review"]')).not.toBeNull();
    expect($('[data-testid="phase-strip"] > .phase-strip-primary [data-testid="header-submit"]')).not.toBeNull();
  });

  it('Run app sits on the row beside Run tests wherever the room can run the app, and not in More', async () => {
    await open(phase({ canPreview: true }));
    const row = $('[data-testid="phase-strip"] > .phase-header-secondary')!;
    expect(row.querySelector('[data-testid="header-run"]')!.textContent).toContain('Run tests');
    const runApp = row.querySelector<HTMLElement>('[data-testid="header-run-app"]')!;
    expect(runApp.textContent).toContain('Run app');
    expect(runApp.textContent).toContain('⌘⇧A');
    expect(runApp.className).toContain('btn-secondary');
    // The two read in that order: the fast loop, then the app.
    expect([...row.querySelectorAll('[data-testid]')].map((b) => b.getAttribute('data-testid'))).toEqual(['header-run', 'header-run-app']);
    expect($('details[data-testid="phase-more"] [data-testid="header-run-app"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="header-run-app"]')).toHaveLength(1);
  });

  it('without an app to run, neither the row nor the menu offers Run app', async () => {
    await open(phase({ canPreview: false }));
    expect($('[data-testid="phase-strip"] > .phase-header-secondary [data-testid="header-run"]')).not.toBeNull();
    expect($('[data-testid="header-run-app"]')).toBeNull();
    // Nor where the host cannot run it: the room says why in its preview, not with a dead button.
    act(() => root.unmount());
    root = createRoot(host);
    await open(phase({ canPreview: true, previewUnsupported: 'isolation' }));
    expect($('[data-testid="header-run-app"]')).toBeNull();
  });

  it('a split phase in progress, in the room of a task the teacher signed off: "In progress", no Continue', async () => {
    const splitTask = (key: string, order: number, status: string, attempts = 0) => ({
      key, order, required: true, title: key, artefactType: 'code', evidence: 'reviewed', sealed: true, status,
      awaitingSignOff: false, attempts, bestScore: status === 'passed' ? 70 : null, passedAt: null, lastSubmissionId: null, resetAt: null,
      solution: { available: false, files: 0, readAt: null },
    });
    // The learner's own revision of the task failed; the teacher then passed
    // the task with the per-task sign-off. Its sibling is still open.
    await open(
      phase({
        attempts: 1,
        tasks: [splitTask('suite', 1, 'passed', 1), splitTask('extra', 2, 'in_progress')],
        taskCounts: { total: 2, required: 2, passed: 1, passedRequired: 1 },
        lastSubmission: { ...verdict(false), taskKey: 'suite' },
      }),
      '?task=suite',
    );
    expect($('[data-testid="phase-state"]')!.textContent).toBe('In progress');
    expect(host.textContent).not.toContain('Review passed');
    expect($('[data-testid="open-reflection"]')).toBeNull();
    expect(host.textContent).not.toContain('Continue to next phase');
  });

  it('the menu closes on Escape and gives focus back to its summary', async () => {
    await open(phase());
    const menu = $<HTMLDetailsElement>('details[data-testid="phase-more"]')! as unknown as HTMLDetailsElement;
    menu.open = true;
    const inside = menu.querySelector<HTMLElement>('[data-testid="open-brief"]')!;
    await act(async () => {
      inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu.open).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('summary'));
  });
});

describe('the review in the working area', () => {
  it('View review selects the full-height results and the Review tab in one press', async () => {
    await open(phase({ status: 'passed', attempts: 1, lastSubmission: verdict(true) }));
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    await press($('[data-testid="gate-view-review"]'));
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    expect(section().getAttribute('data-focus-show')).toBe('results');
    expect($('[data-testid="bottom-panel"]')!.getAttribute('data-value')).toBe('feedback');
    expect($('[data-testid="tab-feedback"]')!.getAttribute('aria-selected')).toBe('true');
  });

  it('changing the view keeps the selected result tab, and the code view comes back on the same file and editor', async () => {
    await open(phase());
    await press($('[data-testid="tab-commit"]'));
    expect($('[data-testid="bottom-panel"]')!.getAttribute('data-value')).toBe('commit');
    const editor = $('textarea[aria-label="Code"]');
    const file = editor?.getAttribute('data-path');
    expect(file).toBe(TESTS);
    await press(viewButton('Execution evidence'));
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    // Not swapped for Tests.
    expect($('[data-testid="bottom-panel"]')!.getAttribute('data-value')).toBe('commit');
    await press(viewButton('Write tests'));
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    // The same editor element, never remounted, on the same file.
    expect($('textarea[aria-label="Code"]')).toBe(editor);
    expect($('textarea[aria-label="Code"]')!.getAttribute('data-path')).toBe(file);
  });
});

describe('one name for the planted bugs', () => {
  it('the Testing room names its view "Planted bugs", and never "Test coverage"', async () => {
    await open(phase());
    expect(viewButton('Planted bugs')).not.toBeNull();
    expect(host.textContent).not.toContain('Test coverage');
    expect($('[data-testid="tab-planted-bugs"]')!.textContent).toBe('Planted bugs');
  });
});

/**
 * Maintenance keeps one navigation order on every page. The change page
 * and the review page draw [Change request, Edit files, Pull request]; the
 * workspace leads with the same Change request, then Edit files, Execution
 * evidence, the preview where the room has one, and Pull request. The other
 * rooms' rows keep their words and order.
 */
describe('one Maintenance navigation order', () => {
  const row = () => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase working area"] > button, nav[aria-label="Phase working area"] > a')].map((b) => b.textContent?.trim());
  const maintenance = (over: Row = {}) => phase({ key: 'maintenance', title: 'Maintenance', order: 6, place: 6, ...over });
  it('the workspace row leads with Change request and says Edit files, then Execution evidence and Pull request', async () => {
    await open(maintenance());
    expect(row()).toEqual(['Change request', 'Edit files', 'Execution evidence', 'Pull request']);
    expect(host.querySelectorAll('nav[aria-label="Phase working area"]')).toHaveLength(1);
    const first = host.querySelector<HTMLAnchorElement>('nav[aria-label="Phase working area"] > :first-child')!;
    expect(first.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/change`);
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('true');
    expect(viewButton('Pull request')!.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/pr`);
    expect(host.textContent).not.toContain('Edit changes');
  });
  it('a room with a preview draws it between Execution evidence and Pull request', async () => {
    await open(maintenance({ canPreview: true }));
    expect(row()).toEqual(['Change request', 'Edit files', 'Execution evidence', 'App preview', 'Pull request']);
  });
  // Testing and Deployment end their row with the review page their document pages' rows lead to; it is
  // "Pull request" there as in Implementation and Maintenance.
  it('the Testing and Deployment rows keep their words and order, and end with Pull request', async () => {
    await open(phase());
    expect(row()).toEqual(['Write tests', 'Execution evidence', 'Planted bugs', 'Pull request']);
    expect(viewButton('Pull request')!.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/pr`);
    act(() => root.unmount()); root = createRoot(host);
    await open(phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }));
    expect(row()).toEqual(['Configuration', 'Pipeline', 'Incident drill', 'Pull request']);
    expect(viewButton('Pull request')!.getAttribute('href')).toBe(`/workspace/${rig.phaseId}/pr`);
  });

  /*
   * The change request and the pull request draw this row as links, so
   * every view of the workspace has an address
   * (`?panel=`), and the workspace opens on the view its address names.
   */
  it('?panel=evidence opens the room on Execution evidence', async () => {
    await open(maintenance(), '?panel=evidence');
    expect(viewButton('Execution evidence')!.getAttribute('aria-pressed')).toBe('true');
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('false');
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    // the name is taken out of the address once the room has opened there, so Back and a reload do not bring it back
    expect(rig.router.replace).toHaveBeenCalledTimes(1);
    expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}`, { scroll: false });
    // the learner's next press decides: the address is read once
    await press(viewButton('Edit files'));
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('true');
    expect(section().getAttribute('data-workspace-view')).toBe('code');
  });
  it('?panel=preview opens the preview where the room has one', async () => {
    await open(maintenance({ canPreview: true }), '?panel=preview');
    expect(viewButton('App preview')!.getAttribute('aria-pressed')).toBe('true');
    expect(section().getAttribute('data-workspace-view')).toBe('preview');
  });
  it('?panel=preview opens Edit files where the room has no preview', async () => {
    await open(maintenance(), '?panel=preview');
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('true');
    expect(section().getAttribute('data-workspace-view')).toBe('code');
  });
  it('the address keeps whatever else was in it when the view\'s name is taken out', async () => {
    await open(maintenance({ canPreview: true }), '?file=web%2Fa.ts&panel=preview');
    expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}?file=web%2Fa.ts`, { scroll: false });
  });
  it('?panel=files opens the left column on Files', async () => {
    await open(maintenance(), '?panel=files');
    const tabs = [...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase context"] > button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
    expect(tabs).toEqual([['Your task', 'false'], ['Files', 'true']]);
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('true');
  });
  it('an unknown address opens the room on Edit files and leaves the address alone', async () => {
    await open(maintenance(), '?panel=nonsense');
    // a name this room does not know is left in the address: it is not this room's to remove
    expect(rig.router.replace).not.toHaveBeenCalled();
    expect(viewButton('Edit files')!.getAttribute('aria-pressed')).toBe('true');
    expect([...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase context"] > button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });
  // The other code phases read the address too (their document pages' rows link to their views): see below.
});

/*
 * One row per code phase. The workspace's row and the row its document
 * pages draw (PhaseAreaNav) are the same entries, in the same order, with the
 * same words, icons, classes and label; the workspace's views are buttons and
 * the document pages' are links to them by address, and each view's address
 * opens the workspace on that view, as its button does.
 */
describe('the workspace\'s row and its document pages\' row are one row', () => {
  const nav = () => host.querySelector<HTMLElement>('nav[aria-label$=" working area"]')!;
  /** An entry as both rows draw it: its words, its icon, the view it is, and a page's address. */
  const entriesOf = (row: Element) => [...row.children].filter((c) => c.matches('a, button, span:not(.focus-switch)')).map((c) => ({
    tag: c.tagName === 'SPAN' ? 'SPAN' : 'ENTRY', label: c.textContent?.trim(), icon: c.querySelector('svg')?.getAttribute('class') ?? null,
    view: c.getAttribute('data-view'), page: c.hasAttribute('data-view') ? null : c.getAttribute('href'),
  }));
  const docRow = (detail: Row, current: 'pr' | 'matrix' | 'drill' | 'change') => {
    const other = document.createElement('div');
    document.body.append(other);
    const second = createRoot(other);
    act(() => second.render(<PhaseAreaNav phase={detail as never} current={current} />));
    const drawn = other.querySelector('nav')!.cloneNode(true) as HTMLElement;
    act(() => second.unmount()); other.remove();
    return drawn;
  };
  const cases: [string, () => Row, 'pr' | 'matrix' | 'drill' | 'change', string[]][] = [
    // Implementation's file tree is the left column's Files tab, as in the other rooms, not a row entry.
    // The pull request page's row is AreaNav's (`areaEntries`), which drops its Files entry with this (see the report).
    ['Implementation', () => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3 }), 'pr', ['Code', 'Split', 'Pull request', 'Saved workspace']],
    ['Implementation with its preview', () => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, canPreview: true }), 'pr', ['Code', 'Split', 'App preview', 'Pull request', 'Saved workspace']],
    // The review page's entry is "Pull request" in every code phase.
    ['Testing', () => phase(), 'matrix', ['Write tests', 'Execution evidence', 'Planted bugs', 'Pull request']],
    ['Testing with its preview', () => phase({ canPreview: true }), 'pr', ['Write tests', 'Execution evidence', 'App preview', 'Planted bugs', 'Pull request']],
    ['Deployment', () => phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }), 'drill', ['Configuration', 'Pipeline', 'Incident drill', 'Pull request']],
    ['Maintenance', () => phase({ key: 'maintenance', title: 'Maintenance', order: 6, place: 6, canPreview: true }), 'change', ['Change request', 'Edit files', 'Execution evidence', 'App preview', 'Pull request']],
  ];
  for (const [name, make, current, words] of cases) {
    it(`${name}: the same entries, words, order, icons, classes and label on the workspace and on its ${current} page`, async () => {
      const detail = make();
      await open(detail);
      const room = nav();
      const page = docRow(detail, current);
      expect(entriesOf(room).map((e) => e.label)).toEqual(words);
      expect(entriesOf(page)).toEqual(entriesOf(room));
      // every entry has its icon (the "Saved workspace" word has none)
      expect(entriesOf(room).filter((e) => e.tag === 'ENTRY').every((e) => e.icon)).toBe(true);
      expect(page.className).toBe(room.className);
      expect(page.getAttribute('aria-label')).toBe(room.getAttribute('aria-label'));
      // "Saved workspace" is a status word, not a control: it carries the class the row's stylesheet takes out of view
      // first where the row has no room for it whole.
      if (words.includes('Saved workspace')) expect(room.querySelector(':scope > .area-row-status')?.textContent).toBe('Saved workspace');
      // the workspace's views are buttons there and links here, to the view by address; its pages are links on both
      for (const [w, d] of [...room.children].filter((c) => c.matches('a, button')).map((c, i) => [c, [...page.children].filter((x) => x.matches('a, button'))[i]] as const)) {
        if (w.hasAttribute('data-view')) {
          expect(w.tagName).toBe('BUTTON');
          expect(d.tagName).toBe('A');
          const href = d.getAttribute('href')!;
          expect(href.startsWith(`/workspace/${rig.phaseId}`)).toBe(true);
        } else {
          expect([w.tagName, d.tagName]).toEqual(['A', 'A']);
          expect(d.getAttribute('aria-current')).toBe(d.getAttribute('href') === `/workspace/${rig.phaseId}/${current}` ? 'page' : null);
          expect(w.hasAttribute('aria-current')).toBe(false);
        }
      }
    });
  }

  /*
   * The tutorial's steps that aim into the row point at the same entry on the workspace and on the document page,
   * and at the entry their words name, whatever comes before it (the preview's entry, the review page's).
   */
  const tourCases: [string, () => Row, Record<string, string>][] = [
    ['implementation', () => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, canPreview: true }), { 'implementation-tutorial-code': 'Code', 'implementation-tutorial-preview': 'App preview' }],
    ['testing', () => phase({ canPreview: true }), { 'testing-tutorial-suite': 'Write tests', 'testing-tutorial-mutations': 'Planted bugs' }],
    ['deployment', () => phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }), { 'deployment-tutorial-config': 'Configuration', 'deployment-tutorial-evidence': 'Pipeline', 'deployment-tutorial-drill': 'Incident drill' }],
  ];
  for (const [key, make, expected] of tourCases) {
    it(`the ${key} tutorial's row steps land on the entries they name, on the workspace and on the document page`, async () => {
      const detail = make();
      await open(detail);
      const marks = phaseTutorialMarks(key as 'implementation' | 'testing' | 'deployment', true).filter((mark) => mark.target in expected);
      expect(marks.map((mark) => mark.target).sort()).toEqual(Object.keys(expected).sort());
      const onRoom = Object.fromEntries(marks.map((mark) => [mark.target, host.querySelector(mark.selector!)?.textContent?.trim() ?? null]));
      expect(onRoom).toEqual(expected);
      act(() => root.unmount()); root = createRoot(host);
      act(() => root.render(<PhaseAreaNav phase={detail as never} current={key === 'deployment' ? 'drill' : 'pr'} />));
      const onPage = Object.fromEntries(marks.map((mark) => [mark.target, host.querySelector(mark.selector!)?.textContent?.trim() ?? null]));
      expect(onPage).toEqual(expected);
    });
  }

  /** Opens the room on an address and reads which view of the row is pressed. */
  const pressed = () => [...nav().querySelectorAll(':scope > button[aria-pressed="true"]')].map((b) => b.textContent?.trim());
  it('Testing: each view\'s address opens it, and the name is then taken out of the address', async () => {
    await open(phase({ canPreview: true }), '?panel=evidence');
    expect(pressed()).toEqual(['Execution evidence']);
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}`, { scroll: false });
    act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks();
    await open(phase({ canPreview: true }), '?panel=preview');
    expect(pressed()).toEqual(['App preview']);
    expect(rig.router.replace).toHaveBeenCalledTimes(1);
    act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks();
    await open(phase(), '?panel=files');
    expect([...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase context"] > button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Your task', 'false'], ['Files', 'true']]);
    expect(rig.router.replace).toHaveBeenCalledTimes(1);
  });
  it('Deployment: Configuration is named by its address (the room opens on Pipeline), Pipeline by the room\'s own', async () => {
    await open(phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }));
    expect(pressed()).toEqual(['Pipeline']);
    act(() => root.unmount()); root = createRoot(host);
    await open(phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }), '?panel=code');
    expect(pressed()).toEqual(['Configuration']);
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}`, { scroll: false });
  });
  it('Deployment\'s ?panel=runbook keeps its address and opens the Pipeline\'s tools', async () => {
    await open(phase({ key: 'deployment', title: 'Deployment', order: 5, place: 5 }), '?panel=runbook');
    expect(rig.router.replace).not.toHaveBeenCalled();
    expect(pressed()).toEqual(['Pipeline']);
    expect($('[data-testid="bottom-panel"]')!.getAttribute('data-value')).toBe('pipeline');
  });
  it('Implementation: Code, Split, the preview and Files open by their address', async () => {
    for (const [query, view] of [['?panel=split', 'Split'], ['?panel=code', 'Code'], ['?panel=preview', 'App preview']] as const) {
      act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks();
      await open(phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, canPreview: true }), query);
      expect(pressed(), query).toEqual([view]);
      expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}`, { scroll: false });
    }
    act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks();
    await open(phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3 }), '?panel=files&file=src%2Fa.ts');
    // The address opens the left column's Files tab, as on every other code room.
    expect(nav().querySelector('[data-view="files"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase context"] > button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([['Your task', 'false'], ['Files', 'true']]);
    expect(rig.router.replace).toHaveBeenLastCalledWith(`/workspace/${rig.phaseId}?file=src%2Fa.ts`, { scroll: false });
  });
  it('an address no row names is left alone on every phase', async () => {
    for (const key of ['implementation', 'testing', 'deployment'] as const) {
      act(() => root.unmount()); root = createRoot(host); vi.clearAllMocks();
      await open(phase({ key, title: key }), '?panel=nonsense');
      expect(rig.router.replace, key).not.toHaveBeenCalled();
    }
  });
  /*
   * Implementation finds its file tree where Testing, Deployment and Maintenance do, the
   * "Your task | Files" tabs over the left column, and its row has no Files entry. The tab lit is the one the column
   * shows, and coming back to the room on the Files pane opens the column on the tree, not on the brief under a lit
   * Files.
   */
  it('Implementation\'s file tree is the left column\'s Files tab, and the lit tab is what the column shows, after coming back too', async () => {
    const implementation = () => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3 });
    const tabs = () => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Phase context"] > button')];
    const lit = () => tabs().map((b) => [b.textContent, b.getAttribute('aria-pressed')]);
    const showing = () => ({
      brief: !host.querySelector('.phase-workspace-context')!.hasAttribute('hidden'),
      tree: !host.querySelector('.phase-workspace-files')!.hasAttribute('hidden'),
    });
    await open(implementation());
    expect(nav().querySelector('[data-view="files"]')).toBeNull();
    expect([...nav().children].some((c) => c.textContent?.trim() === 'Files')).toBe(false);
    expect(showing()).toEqual({ brief: true, tree: false });
    expect(lit()).toEqual([['Your task', 'true'], ['Files', 'false']]);
    await press(tabs()[1]);
    expect(showing()).toEqual({ brief: false, tree: true });
    expect(lit()).toEqual([['Your task', 'false'], ['Files', 'true']]);
    // Leave the room and come back: the Files pane is brought back, and the column shows the tree it names.
    act(() => root.unmount()); root = createRoot(host);
    await open(implementation());
    expect(showing()).toEqual({ brief: false, tree: true });
    expect(lit()).toEqual([['Your task', 'false'], ['Files', 'true']]);
    await press(tabs()[0]);
    expect(showing()).toEqual({ brief: true, tree: false });
    expect(lit()).toEqual([['Your task', 'true'], ['Files', 'false']]);
  });
});

describe('the panel switches and the focused mode', () => {
  it('the brief and mentor switches sit in the view tabs, not a row of their own', async () => {
    await open(phase());
    const controls = host.querySelectorAll('[data-testid="panel-controls"]');
    expect(controls).toHaveLength(1);
    expect(controls[0].getAttribute('data-placement')).toBe('strip');
    expect(controls[0].closest('nav[aria-label="Phase working area"]')).not.toBeNull();
  });

  it('under 520 px of pane area: brief and mentor collapsed, toggles still open them, and a Code / Results switch', async () => {
    await open(phase());
    expect($('.phase-lab-workspace')!.getAttribute('data-focused')).toBeNull();
    expect($('[data-testid="focus-show-results"]')).toBeNull();
    rig.areaHeight = 480;
    await act(async () => { rig.observers.forEach((o) => o.cb()); });
    expect($('.phase-lab-workspace')!.getAttribute('data-focused')).toBe('true');
    const controls = $('[data-testid="panel-controls"]')!;
    expect(controls.getAttribute('data-brief')).toBe('false');
    expect(controls.getAttribute('data-mentor')).toBe('false');
    expect($('aside[data-workspace-panel="brief"]')!.hidden).toBe(true);
    // The toggle still opens the brief, for this visit.
    await press($('[data-testid="toggle-brief"]'));
    expect($('[data-testid="panel-controls"]')!.getAttribute('data-brief')).toBe('true');
    expect($('aside[data-workspace-panel="brief"]')!.hidden).toBe(false);
    // Code or Results, never a sliver of both.
    expect($('[data-testid="focus-show-code"]')!.getAttribute('aria-pressed')).toBe('true');
    await press($('[data-testid="focus-show-results"]'));
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    expect($('[data-testid="focus-show-results"]')!.getAttribute('aria-pressed')).toBe('true');
    await press($('[data-testid="focus-show-code"]'));
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    // Back over 520 px, the stored preferences return.
    rig.areaHeight = 700;
    await act(async () => { rig.observers.forEach((o) => o.cb()); });
    expect($('.phase-lab-workspace')!.getAttribute('data-focused')).toBeNull();
    expect($('[data-testid="panel-controls"]')!.getAttribute('data-brief')).toBe('true');
    expect($('[data-testid="focus-show-results"]')).toBeNull();
  });

  it('in the focused mode, Submit brings the results and the Review tab into view instead of leaving them behind the code', async () => {
    await open(phase());
    rig.areaHeight = 480;
    await act(async () => { rig.observers.forEach((o) => o.cb()); });
    expect(section().getAttribute('data-focus-show')).toBe('code');
    await press($('[data-testid="header-submit"]'));
    expect(section().getAttribute('data-focus-show')).toBe('results');
    expect(section().getAttribute('data-workspace-view')).toBe('evidence');
    expect($('[data-testid="bottom-panel"]')!.getAttribute('data-value')).toBe('feedback');
  });
});

/*
 * The workspace's results and its words.
 */
describe('the workspace\'s run, results and words', () => {
  const implementation = (over: Row = {}) => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, ...over });
  it('Implementation\'s footer runs the tests by the header\'s word, as the Tests tab does', async () => {
    await open(implementation());
    const footer = $('footer.implementation-console-bar')!;
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Console', 'Run tests']);
    expect(host.textContent).not.toContain('Run visible tests');
  });
  it('the app\'s console is "Console" in Testing as everywhere', async () => {
    await open(phase({ canPreview: true }));
    expect($('[data-testid="tab-console"]')!.textContent).toBe('Console');
    expect(host.textContent).not.toContain('App console');
  });
  it('the page preview has no heading of its own over the line that says what it is', async () => {
    await open(implementation({ files: [
      { path: 'web/index.html', content: '<div id="app"></div>', editable: false, language: 'html' },
      { path: 'web/src/main.ts', content: 'export {}', editable: true, language: 'typescript' },
    ] }));
    const preview = $('section[aria-label="Page preview from your open files"]')!;
    expect(preview).not.toBeNull();
    expect(preview.querySelector('header')).toBeNull();
    expect(preview.textContent).not.toContain('Page preview from your open files');
  });
  it('Split\'s icon is the code over the preview, as Split lays them out', async () => {
    await open(implementation());
    const split = [...host.querySelectorAll('nav[aria-label="Implementation working area"] > button')].find((b) => b.textContent?.trim() === 'Split')!;
    expect(split.querySelector('svg')!.getAttribute('class')).toContain('lucide-panel-bottom');
  });
  it('Split holds the code, the page preview, then the results in the page as on screen; Page preview keeps its console above', async () => {
    await open(implementation({ files: [
      { path: 'web/index.html', content: '<div id="app"></div>', editable: false, language: 'html' },
      { path: 'web/src/main.ts', content: 'export {}', editable: true, language: 'typescript' },
    ] }));
    const view = (label: string) => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Implementation working area"] > button')].find((b) => b.textContent?.trim() === label)!;
    const parts = () => [...section().children].map((el) =>
      el.matches('[data-testid="editor-host"]') ? 'editor'
        : el.matches('section.implementation-app') ? 'preview'
          : el.matches('[data-testid="bottom-panel"]') ? 'results'
            : el.matches('footer.implementation-console-bar') ? 'footer' : null).filter(Boolean);
    const consoleButton = () => host.querySelector<HTMLElement>('footer.implementation-console-bar button[aria-expanded]');
    await press(view('Split'));
    await press(consoleButton());
    expect(section().getAttribute('data-workspace-view')).toBe('split');
    expect(parts()).toEqual(['editor', 'preview', 'results', 'footer']);
    // no stylesheet reordering is left to undo the page's order
    const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf-8');
    expect(css).not.toMatch(/data-workspace-view=split\][^{]*\{[^}]*order:/);
    await press(view('Page preview'));
    expect(section().getAttribute('data-workspace-view')).toBe('preview');
    await press(consoleButton());
    expect(parts()).toEqual(['editor', 'results', 'preview', 'footer']);
    // and back in Split, the preview leads the results again
    await press(view('Split'));
    expect(parts()).toEqual(['editor', 'preview', 'results', 'footer']);
  });
  it('a room where the helper and its test are both editable opens on the helper', async () => {
    await open(phase({ key: 'maintenance', title: 'Maintenance', order: 6, place: 6, files: [
      { path: 'web/src/lib/overdue.test.ts', content: 'test()', editable: true, language: 'typescript' },
      { path: 'web/src/lib/overdue.ts', content: 'export const isOverdue = () => false;', editable: true, language: 'typescript' },
    ] }));
    expect($('textarea[aria-label="Code"]')!.getAttribute('data-path')).toBe('web/src/lib/overdue.ts');
  });
  it('an applied proposal, once read back, is announced in the centre column in the design room\'s words, nothing above the columns', async () => {
    await open(phase());
    expect($('[data-testid="workspace-applied-note"]')).toBeNull();
    await act(async () => { await rig.applied!(); });
    const note = $('[data-testid="workspace-applied-note"]')!;
    expect(note.textContent).toBe('The reviewed proposal is saved in this workspace.');
    // inside the centre column, right under its working-area row, as the design room draws it in its editor column
    expect(host.querySelector('.phase-code-surface')!.contains(note)).toBe(true);
    expect(host.querySelector('.phase-code-surface > nav[aria-label="Phase working area"]')!.nextElementSibling!.contains(note)).toBe(true);
    // not the full-width strip over the three columns, which would move the brief, the row and the mentor
    expect($('[data-testid="workspace-notice"]')).toBeNull();
    // a submission clears it, as it clears every notice of the room
    await press($('[data-testid="header-submit"]'));
    expect($('[data-testid="workspace-applied-note"]')).toBeNull();
  });
  it('starting the task over after an Apply takes the applied note away: the starter files are not the proposal', async () => {
    const task = { key: 'suite', order: 1, required: true, title: 'suite', artefactType: 'code', evidence: 'reviewed', sealed: true, status: 'in_progress',
      awaitingSignOff: false, attempts: 0, bestScore: null, passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null } };
    await open(phase({ tasks: [task], taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 } }));
    await act(async () => { await rig.applied!(); });
    expect($('[data-testid="workspace-applied-note"]')).not.toBeNull();
    expect(rig.reset, 'the room draws its start-over control').not.toBeNull();
    await act(async () => { await rig.reset!({ version: '2026-11-09T02:00:00.000Z' }, { restores: [TESTS], reseeds: [] }); });
    expect($('[data-testid="workspace-applied-note"]')).toBeNull();
  });
});

/*
 * A frame that is moved in the page reloads and loses what the learner did in it.
 * The preview sits in one fixed place of the centre column, so no switch of view moves or re-creates its frame; only
 * the results change place (Split: code, preview, results; Page preview: results above the preview).
 */
describe('no switch of view moves or re-creates the preview\'s frame', () => {
  const PAGE_FILES = [
    { path: 'web/index.html', content: '<div id="app"></div>', editable: false, language: 'html' },
    { path: 'web/src/main.ts', content: 'export {}', editable: true, language: 'typescript' },
  ];
  const parts = () => [...section().children].map((el) =>
    el.matches('[data-testid="editor-host"]') ? 'editor'
      : el.matches('section.implementation-app') ? 'preview'
        : el.matches('[data-testid="bottom-panel"]') ? 'results'
          : el.matches('footer.implementation-console-bar') ? 'footer' : null).filter(Boolean);
  /** Every node taken out of the centre column since the watch began: a moved node is taken out, then put back. */
  const watchMoves = () => {
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => records.forEach((r) => removed.push(...r.removedNodes)));
    observer.observe(section(), { childList: true, subtree: true });
    return {
      takenOut: (node: Node) => {
        observer.takeRecords().forEach((r) => removed.push(...r.removedNodes));
        return removed.some((n) => n === node || n.contains(node));
      },
      stop: () => observer.disconnect(),
    };
  };
  const implementation = (over: Row = {}) => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, ...over });
  const RUNNING = { status: 'ready', url: '/api/v1/preview/cap/', nonce: 1, session: null, console: [], errors: 0, starting: false, error: null, stop: () => {}, refresh: () => {} };

  it.each([
    ['the page preview drawn from the open files', () => implementation({ files: PAGE_FILES }), 'Page preview', 'page-preview-frame', null],
    ['the running app', () => implementation({ canPreview: true }), 'App preview', 'preview-frame', RUNNING],
  ] as const)('Implementation, %s: the same frame through Code, Split and the preview in every order, never taken out; Split reads code, preview, results', async (_name, detail, previewWord, frameId, running) => {
    rig.preview = running as Record<string, unknown> | null;
    await open(detail());
    const view = (label: string) => [...host.querySelectorAll<HTMLElement>('nav[aria-label="Implementation working area"] > button')].find((b) => b.textContent?.trim() === label)!;
    const openConsole = async () => {
      const button = host.querySelector<HTMLElement>('footer.implementation-console-bar button[aria-expanded]')!;
      if (button.getAttribute('aria-expanded') !== 'true') await press(button);
    };
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    const frame = $(`[data-testid="${frameId}"]`)!;
    expect(frame, 'the preview draws its frame').not.toBeNull();
    expect(frame.tagName).toBe('IFRAME');
    const moves = watchMoves();
    // Code to Split, Split to the preview, the preview to Code, Code to the preview, the preview to Split, Split to Code:
    // every switch between the three, each way.
    for (const [label, mode] of [['Split', 'split'], [previewWord, 'preview'], ['Code', 'code'], [previewWord, 'preview'], ['Split', 'split'], ['Code', 'code']] as const) {
      await press(view(label));
      // with the results drawn, so they have to change place where the view says
      await openConsole();
      expect(section().getAttribute('data-workspace-view')).toBe(mode);
      expect($(`[data-testid="${frameId}"]`), `${label}: the same frame`).toBe(frame);
      expect(frame.isConnected).toBe(true);
      expect(moves.takenOut(frame), `${label}: the frame was never taken out of the page`).toBe(false);
      expect(parts(), label).toEqual(mode === 'preview' ? ['editor', 'results', 'preview', 'footer'] : ['editor', 'preview', 'results', 'footer']);
    }
    moves.stop();
  });

  it.each([
    ['Testing', { key: 'testing', title: 'Testing', order: 4, place: 4 }],
    ['Deployment', { key: 'deployment', title: 'Deployment', order: 5, place: 5 }],
    ['Maintenance', { key: 'maintenance', title: 'Maintenance', order: 6, place: 6 }],
  ] as const)('%s: its preview is its own view; there the results never move it, and a switch of view never moves the results', async (_name, over) => {
    await open(phase({ ...over, files: PAGE_FILES }));
    const results = $('[data-testid="bottom-panel"]')!;
    const moves = watchMoves();
    await press(viewButton('Page preview'));
    expect(section().getAttribute('data-workspace-view')).toBe('preview');
    const frame = $('[data-testid="page-preview-frame"]')!;
    expect(frame).not.toBeNull();
    expect(parts()).toEqual(['editor', 'results', 'preview']);
    // every tab of the results in turn, with the preview open
    for (const tab of [...host.querySelectorAll<HTMLElement>('[data-testid="bottom-panel"] [role="tab"]')]) {
      await press(tab);
      expect($('[data-testid="page-preview-frame"]')).toBe(frame);
      expect(moves.takenOut(frame)).toBe(false);
    }
    await press(viewButton(over.key === 'testing' ? 'Write tests' : over.key === 'deployment' ? 'Pipeline' : 'Edit files'));
    expect($('[data-testid="bottom-panel"]')).toBe(results);
    expect(moves.takenOut(results)).toBe(false);
    moves.stop();
  });
});

/*
 * The Implementation room's first view. Split puts the preview beside the code and leaves a 1440 px window about six
 * editor lines, so the room opens on Code below 1600 px and on Split from 1600 px up, decided once on mount; Run app
 * from Code moves the room to Split, so the app the learner started is on screen.
 */
describe('the Implementation room opens on the view its window can hold', () => {
  const implementation = (over: Row = {}) => phase({ key: 'implementation', title: 'Implementation', order: 3, place: 3, ...over });
  const wide = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  afterEach(() => { if (wide) Object.defineProperty(window, 'innerWidth', wide); });
  const width = (px: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });

  it.each([[1280, 'code'], [1599, 'code'], [1600, 'split'], [1920, 'split']] as const)('at %i px it opens on %s', async (px, view) => {
    width(px);
    await open(implementation());
    expect(section().getAttribute('data-workspace-view')).toBe(view);
  });

  it('Run app from Code moves the room to Split', async () => {
    width(1280);
    rig.preview = { status: 'idle', console: [], errors: 0, stop: vi.fn(), start: vi.fn() };
    await open(implementation({ canPreview: true }));
    expect(section().getAttribute('data-workspace-view')).toBe('code');
    await press($('[data-testid="header-run-app"]'));
    expect(section().getAttribute('data-workspace-view')).toBe('split');
  });
});

// @vitest-environment jsdom
/**
 * The Design room drew "Design  Phase 2
 * of 6" with no state chip, where Implementation, Testing, Deployment and
 * Maintenance draw "In progress" beside the place. Design now draws the code
 * rooms' header (PhaseHeader): the place, one chip in the state words of
 * gate-state.ts, and the brief and Replay tutorial in its More menu.
 *
 * The rig is design-room-in-flight-submit's (itself design-room-signoff-submit's), with the
 * Chip drawn so its words can be read.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: 'learner-a', token: 'controlled-test-token', phaseId: 'design-a', agentBusy: false,
  save: vi.fn(), submit: vi.fn(), history: vi.fn(), load: vi.fn(), push: vi.fn(),
  invalidate: vi.fn(), refreshRecords: vi.fn(), clearCommit: vi.fn(), exitSave: vi.fn(),
  message: 'Explain the list contract',
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: state.phaseId }), useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/session', () => ({ getSession: () => state.owner ? { id: state.owner } : null, useSession: () => state.owner ? { id: state.owner } : null, onSessionEnd: () => () => undefined, subscribe: () => () => undefined }));
vi.mock('@/lib/api', async (importOriginal) => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { ApiError, getToken: () => state.token, API_URL: (await importOriginal<typeof import('@/lib/api')>()).API_URL, request: vi.fn(), tokenAtSessionEnd: () => null, onSessionLeaving: () => () => undefined, onSignOut: () => () => undefined, api: { phase: state.load, saveWorkspace: state.save, submit: state.submit, submissions: state.history, myEnrollment: vi.fn(async () => null) },
    describeError: (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback };
});
vi.mock('@/lib/api-workspace', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api-workspace')>(), saveVersionedWorkspaceOnExit: state.exitSave }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: state.invalidate }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: state.refreshRecords }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => state.message, clearCommitDraft: state.clearCommit }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/experience/shared', () => ({ reviewHref: (phase: string, id?: string) => `/feedback?phase=${phase}${id ? `&submission=${id}` : ''}` }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => state.agentBusy }));
vi.mock('@/components/workspace/WorkspaceViews', () => ({ useWorkspaceViewScroll: () => ({ view: 'api', select: vi.fn(), contentRef: { current: null } }) }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false }),
  /* The group's own class and name (what the tutorial's PANEL_TARGET reads), so where it sits can be read. */
  WorkspacePanelControls: ({ mentorNote }: { mentorNote?: string }) => <div className="workspace-panel-controls" role="group" aria-label="Workspace panels" data-testid="panel-switches">{mentorNote && <span data-testid="mentor-note">{mentorNote}</span>}</div>,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => children }));
// The breadcrumbs are drawn as a plain list so their words and addresses can be read.
vi.mock('@/components/shell', () => ({ WorkPage: ({ children, strip, crumbs }: { children: ReactNode; strip: ReactNode; crumbs?: { label: string; href?: string }[] }) => <main><ol data-testid="crumbs">{crumbs?.map(crumb => <li key={crumb.label} data-href={crumb.href}>{crumb.label}</li>)}</ol>{strip}{children}</main>, PhaseStrip: () => null,
  briefHref: () => '/brief', usePersona: () => ({}), PersonaComposer: () => null, PersonaFeed: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/ui', () => ({
  Button: ({ children, onClick, testId, busy, busyLabel, disabled, href, reason }: { children?: ReactNode; onClick?: () => void; testId?: string; busy?: boolean; busyLabel?: ReactNode; disabled?: boolean; href?: string; reason?: string }) => href
    ? <a href={href}>{children}</a> : <button data-testid={testId} disabled={disabled || busy} data-reason={disabled && !busy ? reason ?? '' : undefined} onClick={onClick}>{busy ? busyLabel : children}</button>,
  Avatar: () => null, Chip: ({ children, testId }: { children?: ReactNode; testId?: string }) => <span data-testid={testId}>{children}</span>, Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>, Notice: ({ children }: { children: ReactNode }) => <p role="alert">{children}</p>,
}));
vi.mock('@/components/workspace/panels/design/DesignBoard', () => Object.fromEntries([
  'Contradictions', 'DesignParts', 'DesignUnavailable', 'DrawnSection',
].map(name => [name, () => null])));
vi.mock('@/components/workspace/panels/design/BoardCards', () => ({ EntitiesCard: () => null, RelationsCard: () => null, NotesCard: () => null }));
vi.mock('@/components/workspace/panels/design/OperationsCard', () => ({ OperationsCard: () => null }));
vi.mock('@/components/workspace/panels/design/DecisionsCard', () => ({ DecisionsCard: () => null }));
vi.mock('@/components/workspace/panels/design/ScreensForm', () => ({ ScreensForm: () => null }));
vi.mock('@/components/workspace/panels/design/ChecksPanel', () => ({ ChecksPanel: () => null }));
vi.mock('@/components/workspace/panels/design/UmlDiagram', () => ({ UmlDiagram: () => null }));
vi.mock('@/components/workspace/panels/design/useDesign', () => ({ useDesign: () => ({
  doc: { entities: [], relations: [], operations: [], decisions: [] }, olderFormat: false, broken: null, results: [], apiText: undefined, screensText: undefined,
  contracts: { api: true, screens: false }, sequence: false, stories: [], floor: null, writing: false, busy: false,
  write: vi.fn(), writeContract: vi.fn(), setDecisionStatus: vi.fn(), check: vi.fn() }) }));
vi.mock('@/components/workspace/panels/design/useStories', () => ({ useOwnStoryRecord: () => undefined }));
vi.mock('@/components/workspace/panels/design/ApiWorkbench', () => ({ ApiWorkbench: ({ files, setFile }: { files: Record<string, string>; setFile: (path: string, value: string) => void }) =>
  <textarea aria-label="Contract draft" value={files['design/design.json']} onChange={event => setFile('design/design.json', event.target.value)} /> }));
vi.mock('@/components/workspace/panels/design/DiagramStudio', () => ({ DiagramStudio: () => null }));
vi.mock('@/components/workspace/panels/design/ClassDiagram', () => ({ ClassDiagram: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p>Loading</p> }));

import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';
import { STATE_LABEL } from '@/components/workspace/gate-state';
let host: HTMLDivElement, root: Root;
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'The design', artefactType: 'design', artefactPath: 'design/design.json', primaryPath: 'design/design.json',
  files: ['design/design.json'], evidence: 'signed-off', sealed: true, status: 'submitted', awaitingSignOff: false, attempts: 1, bestScore: 40,
  passedAt: null, lastSubmissionId: 'rev-1', resetAt: null, solution: { available: false, files: 0, readAt: null }, ...over,
});
/** Revisions are made a minute or two ago: one in flight older than the API's
 * age-out window (IN_FLIGHT_MAX_AGE_MS) does not hold Submit off. */
const FRESH = new Date(Date.now() - 120_000).toISOString();
const revision = (id: string, status: string, passed: boolean | null = null, taskKey = 'main') =>
  ({ id, taskKey, status, passed, createdAt: FRESH });
const detail = (tasks: Record<string, unknown>[], lastSubmission: unknown = null, status = 'submitted') => ({ id: 'design-a', key: 'design', title: 'Design', projectSlug: 'tasktrackr', status,
  workspaceUpdatedAt: '2026-10-04T00:00:00.000Z', files: [{ path: 'design/design.json', content: 'baseline', editable: true }], tasks, lastSubmission,
  taskCounts: { total: tasks.length, required: tasks.length, passed: 0, passedRequired: 0 } });
const render = () => act(async () => { root.render(<DesignPage />); });
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); state.owner = 'learner-a'; state.token = 'controlled-test-token'; state.phaseId = 'design-a'; state.agentBusy = false; state.message = 'Explain the list contract';
  state.save.mockResolvedValue({ version: '2026-10-04T00:00:01.000Z' }); state.history.mockResolvedValue([]);
  state.submit.mockRejectedValue(new Error('a resubmit reached the API'));
  window.history.replaceState(null, '', '/workspace/design-a/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });


const head = () => host.querySelector('[data-testid="phase-strip"]')!;

describe('the Design room\'s header chip', () => {
  it('in progress: the place and "In progress" beside the name, on the header row', async () => {
    state.load.mockResolvedValue({ ...detail([task({ status: 'in_progress', attempts: 0 })]), status: 'in_progress', place: 2, count: 6 });
    await render();
    expect(head().classList.contains('phase-header')).toBe(true);
    expect(head().querySelector('[data-testid="phase-title"]')?.textContent).toBe('Design');
    expect(head().querySelector('[data-testid="phase-place"]')?.textContent).toBe('Phase 2 of 6');
    expect(head().querySelector('[data-testid="phase-state"]')?.textContent).toBe(STATE_LABEL.inProgress);
  });

  it('a review that came back without a Pass: Needs revision', async () => {
    state.load.mockResolvedValue({ ...detail([task({ lastSubmissionId: 'rev-2' })], revision('rev-2', 'completed', false)), place: 2, count: 6 });
    await render();
    expect(head().querySelector('[data-testid="phase-state"]')?.textContent).toBe(STATE_LABEL.revise);
  });

  it('a passed Design: Review passed; credited: the credit words', async () => {
    state.load.mockResolvedValue({ ...detail([task({ status: 'passed' })], revision('rev-1', 'completed', true), 'passed'), place: 2, count: 6 });
    await render();
    expect(head().querySelector('[data-testid="phase-state"]')?.textContent).toBe(STATE_LABEL.reviewPassed);
    act(() => root.unmount());
    root = createRoot(host);
    state.load.mockResolvedValue({ ...detail([task({ status: 'passed' })], revision('rev-1', 'completed', false), 'passed'), place: 2, count: 6, evidenceNeeded: [{ key: '', title: 'Design' }] });
    await render();
    expect(head().querySelector('[data-testid="phase-state"]')?.textContent).toBe(STATE_LABEL.credited);
  });

  it('the breadcrumbs read Design › Design workspace, the phase\'s own address, as the row names the view', async () => {
    state.load.mockResolvedValue({ ...detail([task({ status: 'in_progress', attempts: 0 })]), status: 'in_progress', place: 2, count: 6 });
    await render();
    const crumbs = [...host.querySelectorAll('[data-testid="crumbs"] > li')].map(li => [li.textContent, li.getAttribute('data-href')]);
    expect(crumbs).toEqual([['Design', '/phases?phase=design'], ['Design workspace', null]]);
  });

  it('the brief is a door in the More menu, as in the code rooms', async () => {
    state.load.mockResolvedValue({ ...detail([task()]), place: 2, count: 6 });
    await render();
    const more = head().querySelector('[data-testid="phase-more"]');
    expect(more).not.toBeNull();
    expect(more!.querySelector('a[href="/brief"]')?.textContent).toContain('Brief');
  });
});

/**
 * At 1366 by 768, Hide brief / Hide mentor on a 47 px row of their own above
 * the Design room would start its work at 263 px (34.2 per cent), where the
 * Requirements room puts them on its tabs row (217 px). They sit at the end of
 * the model tabs' row. Measured in Chromium on static markup (brief shut,
 * mentor open, as at 1366 by default): the work starts at 216 px of 768
 * (28.1 per cent) and at 216 of 900 at 1440 by 900; the switches share the
 * tabs' row whenever it holds both, and wrap under the tabs (right end; left on
 * a phone) where it does not, never past the room.
 */
/**
 * The row now spans the room, above its three columns, as
 * Requirements' tabs row does, so the side columns of both rooms start under
 * the same row; the switches are still at the end of the tabs' row and the
 * mentor's carries Requirements' "Optional".
 */
describe('the Design room\'s panel switches are on its tabs row', () => {
  const PANEL_TARGET = '.workspace-panel-controls[aria-label="Workspace panels"]';
  it('one group, after the model tabs in their toolbar, one full-width row above the room: no row of its own', async () => {
    state.load.mockResolvedValue({ ...detail([task({ status: 'in_progress', attempts: 0 })]), status: 'in_progress', place: 2, count: 6 });
    await render();
    const groups = host.querySelectorAll('[data-testid="panel-switches"]');
    expect(groups.length).toBe(1);
    const toolbar = groups[0].parentElement!;
    expect(toolbar.classList.contains('design-tool-toolbar')).toBe(true);
    expect(toolbar.classList.contains('design-frame-toolbar')).toBe(true);
    expect([...toolbar.children].map(child => child.getAttribute('data-testid') ?? child.getAttribute('aria-label'))).toEqual(['Design working area', 'panel-switches']);
    // Above the room, not inside its middle column: the brief and the mentor start under it.
    expect(toolbar.closest('.design-tool-room')).toBeNull();
    expect(toolbar.closest('.design-room')).toBeNull();
    let next = toolbar.nextElementSibling;
    while (next && !next.classList.contains('design-room')) next = next.nextElementSibling;
    expect(next).not.toBeNull();
    expect(groups[0].querySelector('[data-testid="mentor-note"]')?.textContent).toBe('Optional');
    // The tutorial's step for the switches still finds them, and its tab steps still count the tabs from the first.
    expect(host.querySelector(PANEL_TARGET)).toBe(groups[0]);
    expect(host.querySelector('[aria-label="Design working area"] > :nth-child(1)')?.getAttribute('data-testid')).toBe('design-tab-model');
  });

  it('a design not yet read draws no tabs, and the switches are still there', async () => {
    state.load.mockReturnValue(new Promise(() => undefined));
    await render();
    const toolbar = host.querySelector('.design-tool-toolbar')!;
    expect(toolbar.querySelector('[aria-label="Design working area"]')).toBeNull();
    expect(toolbar.querySelector('[data-testid="panel-switches"]')).not.toBeNull();
  });

  const css = readFileSync(resolve(__dirname, '../components/workspace/phase-experience.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector}{`);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at + selector.length + 1, css.indexOf('}', at));
  };
  it('the sheet: one row that wraps the switches under the tabs only where it cannot hold both', () => {
    expect(rule('.design-tool-toolbar')).toMatch(/display:\s*flex/);
    expect(rule('.design-tool-toolbar')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.design-tool-toolbar>.design-tool-tabs')).toMatch(/flex:\s*1 0 auto/);
    const switches = rule('.design-tool-toolbar>.workspace-panel-controls');
    expect(switches).toMatch(/position:\s*static/);
    expect(switches).toMatch(/max-width:\s*100%/);
    expect(switches).toMatch(/justify-content:\s*flex-end/);
  });
  it('on a phone the switches start at the left of their line, as Requirements\' do', () => {
    expect(css).toContain('@media(max-width:700px){.design-tool-toolbar>.workspace-panel-controls{justify-content:flex-start;padding:4px 8px}}');
  });
  it('under 1024 px the whole row stays reachable while the page scrolls; the tabs are not stuck on their own', () => {
    expect(css).toMatch(/@media\(max-width:1023px\)\{\s*\.design-tool-toolbar\{position:sticky;top:0;z-index:4\}\s*\}/);
    expect(css).not.toMatch(/\.design-tool-tabs\{[^}]*position:\s*sticky/);
  });
});

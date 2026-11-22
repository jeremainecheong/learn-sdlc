// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: 'learner-a', token: 'controlled-test-token', phaseId: 'design-a', agentBusy: false,
  save: vi.fn(), submit: vi.fn(), history: vi.fn(), load: vi.fn(), push: vi.fn(), select: vi.fn(), poll: vi.fn(),
  invalidate: vi.fn(), refreshRecords: vi.fn(), clearCommit: vi.fn(), exitSave: vi.fn(),
  message: 'Explain the list contract', olderFormat: false, check: vi.fn(), screens: false,
  designFlush: null as null | (() => Promise<void>), agentFlush: null as null | (() => Promise<void>),
  // the mentor's Apply (the room's `refreshApplied`) and "Start this task over" (`onReset`), as the room hands them on
  agentRefresh: null as null | (() => Promise<void>), reset: null as null | ((result: { version: string }, plan: { restores: string[]; reseeds: string[] }) => void),
  broken: null as null | string,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: state.phaseId }), useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/session', () => ({ getSession: () => state.owner ? { id: state.owner } : null, useSession: () => state.owner ? { id: state.owner } : null, onSessionEnd: () => () => undefined, subscribe: () => () => undefined }));
vi.mock('@/lib/api', async (importOriginal) => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { ApiError, getToken: () => state.token, API_URL: (await importOriginal<typeof import('@/lib/api')>()).API_URL, request: vi.fn(), tokenAtSessionEnd: () => null, onSessionLeaving: () => () => undefined, onSignOut: () => () => undefined, api: { phase: state.load, saveWorkspace: state.save, submit: state.submit, submissions: state.history, getSubmission: state.poll, myEnrollment: vi.fn(async () => null) },
    describeError: (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback };
});
vi.mock('@/lib/api-workspace', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api-workspace')>(), saveVersionedWorkspaceOnExit: state.exitSave }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: state.invalidate }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: state.refreshRecords }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => state.message, clearCommitDraft: state.clearCommit }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/experience/shared', () => ({ reviewHref: (phase: string, id?: string) => `/feedback?phase=${phase}${id ? `&submission=${id}` : ''}` }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: (_phaseId: string, flushSave: () => Promise<void>, refresh: () => Promise<void>) => { state.agentFlush = flushSave; state.agentRefresh = refresh; return state.agentBusy; } }));
vi.mock('@/components/workspace/TaskResetControl', async importOriginal => ({ ...await importOriginal<typeof import('@/components/workspace/TaskResetControl')>(), TaskResetControl: ({ onReset }: { onReset: NonNullable<typeof state.reset> }) => { state.reset = onReset; return null; } }));
vi.mock('@/components/workspace/WorkspaceViews', () => ({ useWorkspaceViewScroll: () => ({ view: 'api', select: state.select, contentRef: { current: null } }) }));
// The verdict drawn in the room: which review it is and where it stands.
vi.mock('@/components/workspace/FeedbackPanel', () => ({ FeedbackPanel: ({ submission }: { submission: { id: string; status: string } }) => <p data-testid="held-verdict">{submission.id}: {submission.status}</p> }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false }), WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/shell', () => ({ WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>, PhaseStrip: ({ chips }: { chips?: ReactNode }) => <>{chips}</>,
  briefHref: () => '/brief', usePersona: () => ({}), PersonaComposer: () => null, PersonaFeed: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/ui', () => ({
  // `data-variant`: which of the real Button's looks it is handed, "primary" when none is named;
  // `data-size`: the size it is handed, "default" when none is named (the real Button draws `sm` as `btn-sm`).
  Button: ({ children, onClick, testId, busy, busyLabel, disabled, href, variant, size }: { children?: ReactNode; onClick?: () => void; testId?: string; busy?: boolean; busyLabel?: ReactNode; disabled?: boolean; href?: string; variant?: string; size?: string }) => href
    ? <a href={href} data-testid={testId} data-size={size ?? 'default'}>{children}</a> : <button data-testid={testId} data-variant={variant ?? 'primary'} data-size={size ?? 'default'} disabled={disabled || busy} onClick={onClick}>{busy ? busyLabel : children}</button>,
  Avatar: () => null, Chip: () => null, Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>, Notice: ({ children }: { children: ReactNode }) => <p role="alert">{children}</p>,
}));
vi.mock('@/components/workspace/panels/design/DesignBoard', () => ({ ...Object.fromEntries([
  'Contradictions', 'DesignParts', 'DrawnSection',
].map(name => [name, () => null])), DesignUnavailable: () => <p data-testid="phase-design-unavailable">Your design cannot be opened.</p> }));
vi.mock('@/components/workspace/panels/design/BoardCards', () => ({ EntitiesCard: () => null, RelationsCard: () => null, NotesCard: () => null }));
vi.mock('@/components/workspace/panels/design/OperationsCard', () => ({ OperationsCard: () => null }));
vi.mock('@/components/workspace/panels/design/DecisionsCard', () => ({ DecisionsCard: () => null }));
vi.mock('@/components/workspace/panels/design/ScreensForm', () => ({ ScreensForm: ({ onPendingDraftChange }: { onPendingDraftChange?: (pending: boolean) => void }) => <>
  <button data-testid="screen-pending" onClick={() => onPendingDraftChange?.(true)}>A screen without a route</button>
  <button data-testid="screen-routed" onClick={() => onPendingDraftChange?.(false)}>It has a route</button>
</> }));
vi.mock('@/components/workspace/panels/design/ChecksPanel', () => ({ ChecksPanel: () => null }));
vi.mock('@/components/workspace/panels/design/UmlDiagram', () => ({ UmlDiagram: () => null }));
vi.mock('@/components/workspace/panels/design/useDesign', () => ({ useDesign: ({ flushSave }: { flushSave: () => Promise<void> }) => (state.designFlush = flushSave, {
  doc: { entities: [], relations: [], operations: [], decisions: [] }, olderFormat: state.olderFormat, broken: state.broken, results: [], apiText: undefined, screensText: undefined,
  contracts: { api: true, screens: state.screens }, sequence: false, stories: [], floor: null, writing: false, busy: false,
  write: vi.fn(), writeContract: vi.fn(), setDecisionStatus: vi.fn(), check: state.check, assisted: () => [] }) }));
vi.mock('@/components/workspace/panels/design/useStories', () => ({ useOwnStoryRecord: () => undefined }));
vi.mock('@/components/workspace/panels/design/ApiWorkbench', () => ({ ApiWorkbench: ({ files, setFile }: { files: Record<string, string>; setFile: (path: string, value: string) => void }) =>
  <textarea aria-label="Contract draft" value={files['design/design.json']} onChange={event => setFile('design/design.json', event.target.value)} /> }));
vi.mock('@/components/workspace/panels/design/DiagramStudio', () => ({ DiagramStudio: () => null }));
vi.mock('@/components/workspace/panels/design/ClassDiagram', () => ({ ClassDiagram: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p>Loading</p> }));

import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';
import { ApiError } from '@/lib/api';
let host: HTMLDivElement, root: Root;
const detail = (status = 'in_progress') => ({ id: 'design-a', key: 'design', title: 'Design', projectSlug: 'tasktrackr', status,
  workspaceUpdatedAt: '2026-09-15T10:00:00.000Z', files: [{ path: 'design/design.json', content: 'baseline', editable: true }] });
const render = () => act(async () => { root.render(<DesignPage />); });
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="design-submit"]')!;
const click = () => act(async () => { fireEvent.click(button()); });
/** The review the room holds on its Review tab: Submit keeps the learner in the room. */
const held = () => host.querySelector('[data-testid="design-review"]')?.getAttribute('data-submission') ?? null;
const opened = (id: string) => { expect(held()).toBe(id); expect(state.select).toHaveBeenLastCalledWith('review'); expect(state.push).not.toHaveBeenCalled(); };
const type = (value: string) => act(() => { fireEvent.change(host.querySelector('textarea')!, { target: { value } }); });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); state.owner = 'learner-a'; state.token = 'controlled-test-token'; state.phaseId = 'design-a'; state.agentBusy = false; state.message = 'Explain the list contract'; state.olderFormat = false; state.screens = false; state.broken = null;
  // a "once" answer a test left unused never reaches the next test
  for (const mock of [state.load, state.save, state.history, state.submit, state.poll]) mock.mockReset();
  state.load.mockResolvedValue(detail()); state.save.mockResolvedValue({ version: '2026-09-15T10:00:01.000Z' }); state.history.mockResolvedValue([]);
  state.submit.mockResolvedValue({ id: 'review-1', status: 'queued' });
  // A review still being marked, unless a test says otherwise.
  state.poll.mockImplementation(() => new Promise(() => undefined));
  window.history.replaceState(null, '', '/workspace/design-a/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it('saves the last keystroke, posts once and holds the exact queued review on the Review tab without a query action', async () => {
  await render(); type('latest contract'); await click();
  expect(state.save).toHaveBeenCalledWith('design-a', { 'design/design.json': 'latest contract' }, '2026-09-15T10:00:00.000Z');
  expect(state.submit).toHaveBeenCalledExactlyOnceWith('design-a', 'Explain the list contract');
  expect(state.save.mock.invocationCallOrder[0]).toBeLessThan(state.submit.mock.invocationCallOrder[0]);
  opened('review-1');
  expect(state.invalidate).toHaveBeenCalledTimes(1); expect(state.refreshRecords).toHaveBeenCalledWith('design-a');
  expect(state.clearCommit).toHaveBeenCalledWith('design-a');
  await click(); expect(state.submit).toHaveBeenCalledTimes(1);
});
it('serializes an older in-flight autosave before the final flush and excludes repeated clicks and hotkeys', async () => {
  const older = deferred<object>(); const latest = deferred<object>(); const review = deferred<object>();
  state.save.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise); state.submit.mockReturnValue(review.promise);
  await render(); type('older'); await act(async () => vi.advanceTimersByTimeAsync(700));
  type('latest'); await click();
  await act(async () => { fireEvent.click(button()); fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.save).toHaveBeenCalledTimes(1); expect(state.submit).not.toHaveBeenCalled(); expect(button().disabled).toBe(true);
  await act(async () => older.resolve({ version: '2026-09-15T10:00:01.000Z' }));
  expect(state.save).toHaveBeenCalledTimes(2); expect(state.save.mock.calls[1][1]).toEqual({ 'design/design.json': 'latest' });
  expect(state.submit).not.toHaveBeenCalled(); await act(async () => latest.resolve({ version: '2026-09-15T10:00:02.000Z' }));
  expect(state.submit).toHaveBeenCalledTimes(1); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull();
  await act(async () => review.resolve({ id: 'accepted-delayed', status: 'queued' }));
  opened('accepted-delayed');
});
it('retains failed-save text and allows only an explicit retry to save and submit', async () => {
  state.save.mockRejectedValueOnce(new Error('offline')); await render(); type('keep me'); await click();
  expect(state.submit).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull();
  expect(host.textContent).toContain('nothing was submitted'); expect(host.querySelector('textarea')?.value).toBe('keep me');
  // The notice sits in its own box, never as a pane-level child of the editor (laid out as a column there)
  const notices = host.querySelector('[data-testid="design-room-notices"]')!;
  expect(notices.textContent).toContain('nothing was submitted');
  expect(notices.parentElement?.getAttribute('data-testid')).toBe('phase-design-editor');
  expect([...host.querySelector('[data-testid="phase-design-editor"]')!.children].some((child) => child.getAttribute('role') === 'alert')).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(state.save).toHaveBeenCalledTimes(1);
  await click(); expect(state.save).toHaveBeenCalledTimes(2); expect(state.submit).toHaveBeenCalledTimes(1);
});
it('keeps a conflicting Design draft and refuses submission until the server revision is resolved', async () => {
  await render(); type('my retained contract');
  state.load.mockResolvedValue({ ...detail(), workspaceUpdatedAt: '2026-09-15T10:00:02.000Z',
    files: [{ path: 'design/design.json', content: 'another tab contract', editable: true }] });
  state.save.mockRejectedValueOnce(new ApiError(409, 'This workspace changed elsewhere.'));
  await click();
  expect(state.save).toHaveBeenCalledExactlyOnceWith('design-a', { 'design/design.json': 'my retained contract' }, '2026-09-15T10:00:00.000Z');
  expect(state.submit).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull();
  expect(host.querySelector('textarea')?.value).toBe('my retained contract');
  expect(host.textContent).toContain('Compare versions');
  expect(host.querySelector('[data-testid="save-state"]')?.textContent).toBe('Unsaved');
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(state.save).toHaveBeenCalledTimes(1);
});
it('holds an existing queued review without sending another attempt or clearing a new commit draft', async () => {
  state.history.mockResolvedValue([{ id: 'already-running', status: 'running' }]); await render(); await click();
  expect(state.submit).not.toHaveBeenCalled(); expect(state.clearCommit).not.toHaveBeenCalled();
  opened('already-running');
});
it('recovers an accepted submission after its response is lost using GET only', async () => {
  state.submit.mockRejectedValue(new Error('response lost')); await render(); await click();
  expect(button().textContent).toBe('Check submission'); expect(state.clearCommit).not.toHaveBeenCalled();
  state.history.mockResolvedValue([{ id: 'receipt-after-loss', status: 'completed' }]); await click();
  expect(state.submit).toHaveBeenCalledTimes(1);
  opened('receipt-after-loss');
});
it('keeps failed reconciliation read-only and requires a separate explicit new submission after a no-match result', async () => {
  state.submit.mockRejectedValueOnce(new Error('response lost')); await render(); await click();
  state.history.mockRejectedValueOnce(new Error('history offline')); await click();
  expect(host.querySelector('[data-testid="design-submit-new"]')).toBeNull(); expect(state.submit).toHaveBeenCalledTimes(1);
  await click(); expect(state.submit).toHaveBeenCalledTimes(1); expect(host.textContent).toContain('No review was found');
  state.submit.mockResolvedValueOnce({ id: 'explicit-retry', status: 'queued' });
  await act(async () => fireEvent.click(host.querySelector('[data-testid="design-submit-new"]')!));
  expect(state.submit).toHaveBeenCalledTimes(2); opened('explicit-retry');
});
it('does not guess between multiple new receipts', async () => {
  state.submit.mockRejectedValue(new Error('response lost')); await render(); await click();
  state.history.mockResolvedValue([{ id: 'first', status: 'completed' }, { id: 'second', status: 'queued' }]); await click();
  expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull(); expect(state.submit).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('More than one new review'); expect(host.querySelector('[data-testid="design-submit-new"]')).toBeNull();
});
it('keeps a definite API refusal retryable without inventing a receipt', async () => {
  state.submit.mockRejectedValueOnce(new ApiError(400, 'Review attempts are not available.')); await render(); await click();
  expect(host.textContent).toContain('Review attempts are not available'); expect(button().textContent).toBe('Submit for review');
  expect(state.clearCommit).not.toHaveBeenCalled(); await click(); expect(state.submit).toHaveBeenCalledTimes(2);
});
it.each(['owner', 'phase', 'unmount', 'token'])('does not submit or hold a review after %s changes during save', async kind => {
  const save = deferred<object>(); state.save.mockReturnValue(save.promise); await render(); type('private draft'); await click();
  if (kind === 'owner') state.owner = 'learner-b';
  else if (kind === 'token') state.token = 'new-session-token';
  else if (kind === 'phase') { state.phaseId = 'design-b'; await render(); }
  else await act(async () => root.render(null));
  await act(async () => save.resolve({}));
  expect(state.submit).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull(); expect(state.clearCommit).not.toHaveBeenCalled();
});
it('does not hold a review or clear another account’s draft after a late enqueue response', async () => {
  const review = deferred<object>(); state.submit.mockReturnValue(review.promise); await render(); await click(); state.owner = 'learner-b';
  await act(async () => review.resolve({ id: 'old-owner-review', status: 'queued' }));
  expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull(); expect(state.clearCommit).not.toHaveBeenCalled(); expect(state.invalidate).not.toHaveBeenCalled();
});
it('does not reuse the previous phase’s accepted receipt when the route parameter changes', async () => {
  await render(); await click();
  state.phaseId = 'design-b'; state.load.mockResolvedValue({ ...detail(), id: 'design-b' });
  state.submit.mockResolvedValue({ id: 'review-b', status: 'queued' }); await render(); await click();
  expect(state.submit).toHaveBeenLastCalledWith('design-b', 'Explain the list contract');
  opened('review-b');
});
it('keeps a new phase’s submit lock when the old phase’s request finishes late', async () => {
  const older = deferred<object>(), current = deferred<object>();
  state.submit.mockReturnValueOnce(older.promise).mockReturnValueOnce(current.promise);
  await render(); await click(); state.phaseId = 'design-b'; state.load.mockResolvedValue({ ...detail(), id: 'design-b' });
  await render(); await click(); await act(async () => older.resolve({ id: 'old-a', status: 'queued' }));
  await act(async () => fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }));
  expect(state.submit).toHaveBeenCalledTimes(2); expect(button().disabled).toBe(true); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull();
  await act(async () => current.resolve({ id: 'current-b', status: 'queued' }));
  opened('current-b');
});
it.each(['locked', 'agent', 'loading'])('ignores submit hotkeys while %s blocks the workspace', async block => {
  if (block === 'locked') state.load.mockResolvedValue(detail('locked'));
  if (block === 'agent') state.agentBusy = true;
  if (block === 'loading') state.load.mockReturnValue(new Promise(() => undefined));
  await render(); await act(async () => fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }));
  expect(state.submit).not.toHaveBeenCalled(); expect(state.history).not.toHaveBeenCalled();
});
it('never submits from a reloadable submit query', async () => {
  window.history.replaceState(null, '', '/workspace/design-a/design?submit=1'); await render();
  await act(async () => vi.advanceTimersByTimeAsync(2000)); expect(state.submit).not.toHaveBeenCalled(); expect(state.push).not.toHaveBeenCalled(); expect(held()).toBeNull();
});

/**
 * The revisions this room reads back are the design task's.
 *
 * `GET /phases/:id/submissions` resolves the phase's only task and is refused
 * with 400 on a phase a teacher has split, so the receipt check, which is the
 * one thing standing between a lost response and a second graded attempt, was
 * a refusal on exactly the phases that have more than one task. It names the
 * task the board writes, which is the key it already submits under.
 */
const splitDetail = () => ({
  ...detail(),
  tasks: [
    { key: 'board', order: 1, required: true, title: 'The design', artefactType: 'design-doc', artefactPath: 'design/design.json', status: 'in_progress', attempts: 0, bestScore: null },
    { key: 'concepts', order: 2, required: false, title: 'Concept check', artefactType: 'quiz', status: 'in_progress', attempts: 0, bestScore: null },
  ],
  taskCounts: { total: 2, required: 1, passed: 0, passedRequired: 0 },
});

it('reads the receipt under the task that owns the design where the phase is split', async () => {
  state.load.mockResolvedValue(splitDetail()); await render(); await click();
  expect(state.history).toHaveBeenCalledWith('design-a', 'board');
  expect(state.submit).toHaveBeenCalledWith('design-a', 'Explain the list contract', 'board');
});

it('names no task on a phase with one, so the read is the phase route it always was', async () => {
  await render(); await click();
  // No key, so `api.submissions` builds `/phases/design-a/submissions`: the
  // route that resolves the phase's only task itself.
  expect(state.history).toHaveBeenCalledWith('design-a', undefined);
});

it('draws the tabs the switches leave on, each with its test id', async () => {
  await render();
  expect([...host.querySelectorAll('[data-testid^="design-tab-"]')].map((tab) => [tab.getAttribute('data-testid'), tab.textContent]))
    .toEqual([['design-tab-model', 'UML model'], ['design-tab-api', 'API contract'], ['design-tab-decisions', 'Decisions'], ['design-tab-review', 'Review']]);
  expect(host.textContent).not.toContain('Saved in');
  // a design-kind Design is worked in this room only: no door to the files
  expect(host.querySelector('[data-testid="open-workspace"]')).toBeNull();
});

it('on a Design task in the older format: the sentence, no tabs, and neither check nor submit', async () => {
  state.olderFormat = true;
  await render();
  expect(host.textContent).toContain("This project's Design task is in an older format; its owner needs to re-save it.");
  expect(host.querySelector('[data-testid^="design-tab-"]')).toBeNull();
  // the older format is still worked in the IDE, so its door stays
  expect(host.querySelector('[data-testid="open-workspace"]')).not.toBeNull();
  expect(button().disabled).toBe(true);
  expect(host.querySelector<HTMLButtonElement>('[data-testid="phase-design-render"]')!.disabled).toBe(true);
  await act(async () => fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }));
  expect(state.submit).not.toHaveBeenCalled(); expect(state.history).not.toHaveBeenCalled();
  // ⌘⇧↵ is refused too: the older format has no floor to report, never "0 of 0 checks pass"
  await act(async () => fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true, shiftKey: true }));
  expect(state.check).not.toHaveBeenCalled();
});

it("a submitted design is the learner's own: the assistant's marks are cleared", async () => {
  sessionStorage.setItem('learnsdlc:touched:design-a', JSON.stringify({ 'design/notes': 'written by the assistant' }));
  await render(); await click();
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem('learnsdlc:touched:design-a')).toBeNull();
});

it("a screen without a route is an unsaved edit: Submit, Check and Apply stay locked until it has one", async () => {
  state.screens = true;
  await render();
  await act(async () => { fireEvent.click(host.querySelector('[data-testid="screen-pending"]')!); });
  await click();
  expect(state.submit).not.toHaveBeenCalled(); expect(state.save).not.toHaveBeenCalled();
  // the refusal names the Screens form, never a generic sentence
  expect(host.textContent).toContain('Give each screen a route before continuing.');
  // the Check button's save and the Agentic Apply's prepare both wait on the same guard
  await expect(state.designFlush!()).rejects.toThrow('Give each screen a route before continuing. Your unfinished screen is kept in the form.');
  await expect(state.agentFlush!()).rejects.toThrow('Give each screen a route before continuing.');
  await act(async () => { fireEvent.click(host.querySelector('[data-testid="screen-routed"]')!); });
  await expect(state.agentFlush!()).resolves.toBeUndefined();
  await click();
  expect(state.submit).toHaveBeenCalledTimes(1);
});

/**
 * Design's Submit keeps the learner in the room, as Requirements'
 * does. The review is held on the Review tab and followed to its verdict
 * there; once it lands the phase is read again, so the band and the header's
 * chip can say where the phase stands. The feedback page stays the history.
 */
it('follows the held review to its verdict in the room, then reads the phase again for the band', async () => {
  // A review taken now: the room follows a review only inside the API's age-out window.
  const fresh = new Date().toISOString();
  const running = deferred<object>();
  state.poll.mockReturnValueOnce(running.promise).mockResolvedValue({ id: 'review-1', status: 'completed', passed: true, createdAt: fresh, report: {} });
  await render(); await click();
  opened('review-1');
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-1: queued');
  expect(host.querySelector('[data-testid="design-review-history"]')?.getAttribute('href')).toBe('/feedback?phase=design-a');
  const loads = state.load.mock.calls.length;
  state.load.mockResolvedValue({ ...detail('passed'), lastSubmission: { id: 'review-1', status: 'completed', passed: true, createdAt: fresh, report: {} } });
  await act(async () => running.resolve({ id: 'review-1', status: 'running', createdAt: fresh }));
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-1: running');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(state.poll).toHaveBeenCalledWith('review-1');
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-1: completed');
  expect(state.load.mock.calls.length).toBeGreaterThan(loads);
  expect(state.push).not.toHaveBeenCalled();
});

it('while the held review runs, Submit reads "In review" and ⌘↵ shows that review rather than starting another', async () => {
  await render(); await click(); state.select.mockClear();
  expect(button().disabled).toBe(true); expect(button().textContent).toBe('In review');
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.submit).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(1);
  expect(state.select).toHaveBeenLastCalledWith('review');
  expect(held()).toBe('review-1');
});

it('before any review the Review tab says so, with no history link', async () => {
  await render();
  expect(held()).toBeNull();
  expect(host.querySelector('[data-testid="design-review-empty"]')?.textContent).toBe('No review yet. Submit your saved design for an evidence-based Pass or Needs revision.');
  expect(host.querySelector('[data-testid="design-review-history"]')).toBeNull();
});

/**
 * Design decides between "show the held
 * review" and "start a new one" by Requirements' rule: only a review still
 * queued or running is shown again; once it has settled (failed, "Review
 * unavailable", Needs revision, a Pass) Submit starts a new review, whatever
 * changed the work since (typing, an applied proposal, a reset) or nothing.
 */
const at = '2026-09-15T10:00:03.000Z';
const verdict = (over: object) => ({ id: 'review-1', createdAt: at, ...over });
const review = () => host.querySelector<HTMLElement>('[data-testid="design-review"]')!;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
/** Submit once, with the room's poll answering `result` for review-1. */
async function submitAndSettle(result: object) {
  state.poll.mockResolvedValueOnce(result);
  await render(); await click(); await flush();
  expect(state.submit).toHaveBeenCalledTimes(1);
  expect(button().disabled).toBe(false);
  state.submit.mockResolvedValueOnce({ id: 'review-2', status: 'queued' });
}

it('a failed review is said in the room\'s own words, and Submit starts a new review', async () => {
  await submitAndSettle(verdict({ status: 'failed' }));
  expect(host.querySelector('[data-testid="held-verdict"]')).toBeNull();
  expect(review().textContent).toContain('The review could not complete. Revise or retry; no Pass was awarded.');
  expect(review().textContent).not.toContain('Return to the project');
  await click();
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('a failed review with the API\'s own sentence says that sentence', async () => {
  await submitAndSettle(verdict({ status: 'failed', error: 'The reviewer timed out.' }));
  expect(review().textContent).toContain('The reviewer timed out.');
});

it('a completed review with no report says no Pass can come from it, never "Return to the project"', async () => {
  await submitAndSettle(verdict({ status: 'completed' }));
  expect(host.querySelector('[data-testid="held-verdict"]')).toBeNull();
  expect(review().textContent).toContain('This review has no feedback evidence. No new Pass can be awarded from it.');
  await click(); expect(state.submit).toHaveBeenCalledTimes(2);
});

it('"Review unavailable" (the reviewer was busy): Submit starts a new review', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: false, report: { aiReview: { assessmentError: 'The AI reviewer is busy with the rest of the class.' } } }));
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-1: completed');
  await click();
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('Needs revision, then the fix applied from the mentor: Submit reviews the applied design', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: false, report: {} }));
  await act(async () => { await state.agentRefresh!(); });
  expect(host.textContent).toContain('The reviewed proposal is saved in this workspace.');
  await click();
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('Needs revision, then "Start this task over": Submit reviews the reset design', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: false, report: {} }));
  await act(async () => { state.reset!({ version: '2026-09-15T10:00:05.000Z' }, { restores: [], reseeds: [] }); });
  await flush();
  await click();
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('Needs revision, then typing: Submit reviews the edited design', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: false, report: {} }));
  type('revised contract'); await click();
  expect(state.save).toHaveBeenLastCalledWith('design-a', { 'design/design.json': 'revised contract' }, expect.any(String));
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('a Pass, then Submit again with nothing changed: a new review starts, as Requirements\' Submit does', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: true, report: {} }));
  await click();
  expect(state.submit).toHaveBeenCalledTimes(2); opened('review-2');
});

it('on a passed phase, Submit again shows the new review running ("In review", the Review tab holds it) until it settles', async () => {
  const fresh = new Date().toISOString();
  const passedReview = { id: 'review-1', status: 'completed', passed: true, createdAt: at, report: {} };
  state.load.mockResolvedValue({ ...detail('passed'), lastSubmission: passedReview });
  const second = deferred<object>();
  state.poll.mockReturnValue(second.promise);
  state.submit.mockResolvedValueOnce({ id: 'review-2', status: 'queued', createdAt: fresh });
  await render();
  expect(button().textContent).toBe('Submit again'); expect(button().disabled).toBe(false);
  await click();
  expect(state.submit).toHaveBeenCalledTimes(1);
  opened('review-2');
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-2: queued');
  expect(button().textContent).toBe('In review'); expect(button().disabled).toBe(true);
  state.load.mockResolvedValue({ ...detail('passed'), lastSubmission: { id: 'review-2', status: 'completed', passed: true, createdAt: fresh, report: {} } });
  await act(async () => second.resolve({ id: 'review-2', status: 'completed', passed: true, createdAt: fresh, report: {} }));
  await flush();
  expect(host.querySelector('[data-testid="held-verdict"]')?.textContent).toBe('review-2: completed');
  expect(button().textContent).toBe('Submit again'); expect(button().disabled).toBe(false);
});

it.each(['apply', 'reset'] as const)('an %s while the held review runs: the next Submit asks the API again rather than showing it from memory', async (kind) => {
  await render(); await click();
  expect(state.history).toHaveBeenCalledTimes(1);
  if (kind === 'apply') await act(async () => { await state.agentRefresh!(); });
  else { await act(async () => { state.reset!({ version: '2026-09-15T10:00:05.000Z' }, { restores: [], reseeds: [] }); }); await flush(); }
  // the API still holds review-1 in flight: it is shown, and nothing new is sent
  state.history.mockResolvedValue([{ id: 'review-1', status: 'running' }]);
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.history).toHaveBeenCalledTimes(2);
  expect(state.submit).toHaveBeenCalledTimes(1); expect(held()).toBe('review-1');
});

it('a reload while a review runs: Submit reads "In review", the room follows it, and ⌘↵ sends nothing new', async () => {
  // made a minute ago: inside the API's age-out window, so still in flight
  const fresh = new Date(Date.now() - 60_000).toISOString();
  state.load.mockResolvedValue({ ...detail('submitted'), lastSubmission: { id: 'review-0', status: 'running', createdAt: fresh } });
  state.history.mockResolvedValue([{ id: 'review-0', status: 'running', createdAt: fresh }]);
  await render(); await flush();
  expect(held()).toBe('review-0'); expect(state.poll).toHaveBeenCalledWith('review-0');
  expect(button().disabled).toBe(true); expect(button().textContent).toBe('In review');
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.submit).not.toHaveBeenCalled(); expect(held()).toBe('review-0');
  expect(state.select).toHaveBeenLastCalledWith('review');
});

it('a reload with a review older than the API\'s age-out window: Submit is on, and a press is what writes it off', async () => {
  const aged = { id: 'review-0', status: 'queued', createdAt: new Date(Date.now() - 11 * 60_000).toISOString() };
  state.load.mockResolvedValue({ ...detail('submitted'), lastSubmission: aged });
  // The API still lists the stalled row as queued (nothing sweeps it); only a submit writes it off.
  state.history.mockResolvedValue([aged]);
  state.submit.mockResolvedValueOnce({ id: 'review-1', status: 'queued', createdAt: new Date().toISOString() });
  await render(); await flush();
  expect(button().disabled).toBe(false); expect(button().textContent).toBe('Submit again');
  await click();
  expect(state.history).toHaveBeenCalledTimes(1);
  expect(state.submit).toHaveBeenCalledExactlyOnceWith('design-a', 'Explain the list contract');
  opened('review-1');
  // a second press while that new review runs shows it and sends nothing
  expect(button().textContent).toBe('In review');
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.submit).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(1); expect(held()).toBe('review-1');
});

it('a stalled review: within the age-out window a press shows it and sends nothing; past it a press submits once; a press while the new review runs sends nothing', async () => {
  // queued nine and a half minutes ago, and never marked: the poll keeps answering "queued" (a fresh object each time, as the API's)
  const stalled = { id: 'review-0', status: 'queued', createdAt: new Date(Date.now() - 9.5 * 60_000).toISOString() };
  state.load.mockResolvedValue({ ...detail('submitted'), lastSubmission: stalled });
  state.history.mockResolvedValue([stalled]);
  state.poll.mockImplementation((id: string) => id === 'review-0' ? Promise.resolve({ ...stalled }) : new Promise(() => undefined));
  state.submit.mockResolvedValueOnce({ id: 'review-1', status: 'queued' });
  await render(); await flush();
  expect(button().textContent).toBe('In review');
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.history).toHaveBeenCalledTimes(1); expect(state.submit).not.toHaveBeenCalled();
  expect(held()).toBe('review-0'); expect(state.select).toHaveBeenLastCalledWith('review');
  // a minute on, the window has passed: Submit is on, and a press reaches the API, which writes the stalled row off
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(button().disabled).toBe(false); expect(button().textContent).toBe('Submit again');
  await click();
  expect(state.history).toHaveBeenCalledTimes(2);
  expect(state.submit).toHaveBeenCalledExactlyOnceWith('design-a', 'Explain the list contract');
  opened('review-1');
  expect(button().textContent).toBe('In review');
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.submit).toHaveBeenCalledTimes(1); expect(state.history).toHaveBeenCalledTimes(2); expect(held()).toBe('review-1');
});

/*
 * Design's review poll followed a review stuck past the age-out window for ever, and the room
 * drew Submit again only when something else redrew it. It now follows the review only while it holds Submit (the
 * one-argument change Requirements got), and draws again when the window ends, as Requirements does.
 */
it('a stalled review whose poll never answers: the room draws Submit on by itself when the window ends', async () => {
  const stalled = { id: 'review-0', status: 'queued', createdAt: new Date(Date.now() - 9.5 * 60_000).toISOString() };
  state.load.mockResolvedValue({ ...detail('submitted'), lastSubmission: stalled });
  state.history.mockResolvedValue([stalled]);
  await render(); await flush();
  expect(button().textContent).toBe('In review'); expect(button().disabled).toBe(true);
  // thirty-one seconds on, the window has ended; the only thing that can redraw the room is its own timer
  await act(async () => vi.advanceTimersByTimeAsync(31_000));
  expect(button().disabled).toBe(false); expect(button().textContent).toBe('Submit again');
});

it('a stalled review is polled only inside the age-out window', async () => {
  const stalled = { id: 'review-0', status: 'queued', createdAt: new Date(Date.now() - 9.5 * 60_000).toISOString() };
  state.load.mockResolvedValue({ ...detail('submitted'), lastSubmission: stalled });
  state.history.mockResolvedValue([stalled]);
  state.poll.mockImplementation((id: string) => id === 'review-0' ? Promise.resolve({ ...stalled }) : new Promise(() => undefined));
  await render(); await flush();
  expect(state.poll).toHaveBeenCalledWith('review-0');
  await act(async () => vi.advanceTimersByTimeAsync(31_000));
  expect(button().textContent).toBe('Submit again');
  const polled = state.poll.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
  expect(state.poll.mock.calls.length).toBe(polled);
});

it('a review already settled when it is held (a submit answer, a recovered receipt) reads the phase again for the band', async () => {
  state.submit.mockResolvedValueOnce(verdict({ status: 'completed', passed: true, report: {} }));
  await render(); const loads = state.load.mock.calls.length;
  await click(); await flush();
  expect(state.poll).not.toHaveBeenCalled();
  expect(state.load.mock.calls.length).toBe(loads + 1);
});

it('a verdict whose phase read fails says so, as Requirements does', async () => {
  state.poll.mockResolvedValueOnce(verdict({ status: 'completed', passed: true, report: {} }));
  await render(); state.load.mockRejectedValueOnce(new Error('offline'));
  await click(); await flush();
  expect(host.textContent).toContain('The review finished, but the phase could not refresh. Try again.');
});

it('Submit brings the review into view and gives it focus; the region announces the verdict when it lands', async () => {
  const scroll = vi.fn();
  (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll;
  try {
    await render(); await click();
    expect(review().getAttribute('tabindex')).toBe('-1');
    expect(review().getAttribute('aria-live')).toBe('polite');
    expect(review().getAttribute('aria-label')).toBe('Review');
    expect(document.activeElement).toBe(review());
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
    expect(scroll.mock.contexts.at(-1)).toBe(review());
  } finally {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  }
});

it('a design that cannot be opened: Submit is off and ⌘↵ sends nothing; its notice sits in the notices\' box', async () => {
  state.broken = 'design.json is not valid JSON';
  await render();
  expect(button().disabled).toBe(true);
  await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
  expect(state.submit).not.toHaveBeenCalled(); expect(state.history).not.toHaveBeenCalled();
  const unavailable = host.querySelector('[data-testid="phase-design-unavailable"]')!;
  expect(unavailable.parentElement?.className).toBe('design-room-notices');
  expect(unavailable.parentElement?.parentElement?.getAttribute('data-testid')).toBe('phase-design-editor');
});

/*
 * The footer's Submit by the code rooms' rule. Before the first submission it reads and
 * looks as it always did (primary, "Submit for review"); after a Pass it is secondary, so it never stands primary
 * under the band's "Continue to next phase", and reads "Submit again"; while a review runs it is today's busy
 * "In review"; after a review that asked for a revision it leads again and reads "Submit again", since a submission
 * exists and handing in a revision is the next step ("Submit … again" where resubmitting is possible).
 */
const look = () => ({ label: button().textContent, variant: button().dataset.variant, disabled: button().disabled });
it('before any submission, Submit is primary and reads "Submit for review"', async () => {
  await render(); await flush();
  expect(look()).toEqual({ label: 'Submit for review', variant: 'primary', disabled: false });
});
it('a passed phase opened again: Submit is secondary and reads "Submit again"', async () => {
  state.load.mockResolvedValue({ ...detail('passed'), lastSubmission: verdict({ status: 'completed', passed: true, report: {} }) });
  await render(); await flush();
  expect(look()).toEqual({ label: 'Submit again', variant: 'secondary', disabled: false });
});
it('a Pass that lands in the room: Submit is secondary and reads "Submit again" before the phase is read again', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: true, report: {} }));
  expect(look()).toEqual({ label: 'Submit again', variant: 'secondary', disabled: false });
});
it('while the first review runs, Submit is today\'s busy "In review", primary', async () => {
  await render(); await click(); await flush();
  expect(look()).toEqual({ label: 'In review', variant: 'primary', disabled: true });
});
it('after a review that asked for a revision, Submit leads and reads "Submit again"', async () => {
  await submitAndSettle(verdict({ status: 'completed', passed: false, report: {} }));
  expect(look()).toEqual({ label: 'Submit again', variant: 'primary', disabled: false });
});
it('after a review that could not complete, Submit leads and reads "Submit again"', async () => {
  await submitAndSettle(verdict({ status: 'failed' }));
  expect(look()).toEqual({ label: 'Submit again', variant: 'primary', disabled: false });
});

/*
 * Design's footer buttons are the small size Requirements' footer
 * buttons are ("Check the story" and Submit are `size="sm"` there), in every
 * state the footer draws them: before a submission, and with a submission
 * whose answer was lost (Check submission, Review history, Start a new submission).
 */
const footerSizes = () => [...host.querySelectorAll('footer button, footer a')].map((el) => [el.textContent, (el as HTMLElement).dataset.size]);
it('the footer\'s Check the design and Submit are the small size', async () => {
  await render(); await flush();
  expect(footerSizes()).toEqual([['Check the design', 'sm'], ['Submit for review', 'sm']]);
});
it('a lost answer\'s footer buttons are the small size too', async () => {
  state.submit.mockRejectedValueOnce(new Error('response lost')); await render(); await click();
  state.history.mockRejectedValueOnce(new Error('history offline')); await click();
  await click(); expect(host.textContent).toContain('No review was found');
  expect(footerSizes()).toEqual([['Check the design', 'sm'], ['Check submission', 'sm'], ['Review history', 'sm'], ['Start a new submission', 'sm']]);
});

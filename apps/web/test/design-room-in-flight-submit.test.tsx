// @vitest-environment jsdom
/**
 * A revision in flight, in the design room.
 *
 * "Submit for review" is off while the design task waits on the teacher's
 * countersignature. Checking for a lost confirmation is a read and is
 * unaffected.
 *
 * The rig is design-room-signoff-submit.test.tsx's.
 *
 * The design room follows its review to the
 * verdict (the poll Requirements uses), so a hold now lifts when the verdict
 * lands. While a revision of this task is in flight, within the API's
 * age-out window (the code rooms' `revisionInFlight`), Submit reads "In
 * review" as Requirements' does; ⌘↵ in that state reads the history and
 * opens that review, handing nothing new in. One past the window holds
 * nothing: the next press is what writes it off.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: 'learner-a', token: 'controlled-test-token', phaseId: 'design-a', agentBusy: false,
  save: vi.fn(), submit: vi.fn(), history: vi.fn(), load: vi.fn(), push: vi.fn(), poll: vi.fn(),
  invalidate: vi.fn(), refreshRecords: vi.fn(), clearCommit: vi.fn(), exitSave: vi.fn(),
  message: 'Explain the list contract',
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
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => state.agentBusy }));
vi.mock('@/components/workspace/WorkspaceViews', () => ({ useWorkspaceViewScroll: () => ({ view: 'api', select: vi.fn(), contentRef: { current: null } }) }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: false, mentorOpen: false }), WorkspacePanelControls: () => null,
  WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/shell', () => ({ WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>, PhaseStrip: () => null,
  briefHref: () => '/brief', usePersona: () => ({}), PersonaComposer: () => null, PersonaFeed: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/ui', () => ({
  Button: ({ children, onClick, testId, busy, busyLabel, disabled, href, reason }: { children?: ReactNode; onClick?: () => void; testId?: string; busy?: boolean; busyLabel?: ReactNode; disabled?: boolean; href?: string; reason?: string }) => href
    ? <a href={href}>{children}</a> : <button data-testid={testId} disabled={disabled || busy} data-reason={disabled && !busy ? reason ?? '' : undefined} onClick={onClick}>{busy ? busyLabel : children}</button>,
  Avatar: () => null, Chip: () => null, Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>, Notice: ({ children }: { children: ReactNode }) => <p role="alert">{children}</p>,
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
import * as signoff from '@/components/workspace/signoff-status';
/** Read through the namespace so a missing export fails an assertion, not the import. */
const IN_FLIGHT = () => (signoff as Record<string, unknown>).REVISION_IN_FLIGHT_REASON as string | undefined;
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
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="design-submit"]')!;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); state.owner = 'learner-a'; state.token = 'controlled-test-token'; state.phaseId = 'design-a'; state.agentBusy = false; state.message = 'Explain the list contract';
  state.save.mockResolvedValue({ version: '2026-10-04T00:00:01.000Z' }); state.history.mockResolvedValue([]);
  state.submit.mockRejectedValue(new Error('a resubmit reached the API'));
  // a review still being marked, unless a test says otherwise
  state.poll.mockReset(); state.poll.mockImplementation(() => new Promise(() => undefined));
  window.history.replaceState(null, '', '/workspace/design-a/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

for (const status of ['queued', 'running']) {
  // The review in flight is opened in the room, on its Review tab, not on the feedback page.
  // Submit reads "In review" while it runs, as Requirements' does; ⌘↵ still reaches it.
  it(`${status}: Submit reads "In review"; ⌘↵ reads the history and opens the review in flight, handing nothing new in`, async () => {
    state.load.mockResolvedValue(detail([task()], revision('rev-2', status)));
    state.history.mockResolvedValue([revision('rev-2', status)]);
    await render();
    expect(IN_FLIGHT(), 'REVISION_IN_FLIGHT_REASON is still exported for the other rooms').toEqual(expect.any(String));
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('In review');
    await act(async () => { fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true }); });
    expect(state.history).toHaveBeenCalledTimes(1);
    expect(state.submit).not.toHaveBeenCalled();
    expect(state.push).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="design-review"]')?.getAttribute('data-submission')).toBe('rev-2');
  });
}
it('a split phase: a sibling task\'s revision in flight leaves this task\'s Submit on', async () => {
  state.submit.mockResolvedValue({ id: 'review-1', status: 'queued' });
  state.load.mockResolvedValue(detail([task({ key: 'design-task' }), task({ key: 'other', order: 2, artefactType: 'text', artefactPath: 'docs/notes.md', primaryPath: 'docs/notes.md', files: ['docs/notes.md'] })],
    revision('rev-2', 'queued', null, 'other')));
  await render();
  expect(button().disabled).toBe(false);
  expect(button().dataset.reason).toBeUndefined();
});
it('once the verdict is in, Submit is on with no reason and submits once', async () => {
  state.submit.mockResolvedValue({ id: 'review-1', status: 'queued' });
  state.load.mockResolvedValue(detail([task({ lastSubmissionId: 'rev-2' })], revision('rev-2', 'completed', false)));
  await render();
  expect(button().disabled).toBe(false);
  expect(button().dataset.reason).toBeUndefined();
  await act(async () => { fireEvent.click(button()); });
  expect(state.submit).toHaveBeenCalledTimes(1);
});
it('waiting on the countersignature keeps the sign-off reason', async () => {
  state.load.mockResolvedValue(detail([task({ awaitingSignOff: true, bestScore: 88 })], revision('rev-1', 'completed', true)));
  await render();
  expect(button().disabled).toBe(true);
  expect(button().dataset.reason).toBe(signoff.SIGN_OFF_SUBMIT_REASON);
});

it('design room opened mid-flight: the verdict lands, Submit comes back without a reload', async () => {
  state.submit.mockResolvedValue({ id: 'review-1', status: 'queued' });
  state.load.mockResolvedValue(detail([task()], revision('rev-2', 'running')));
  // The room follows the review: the first read finds it running, a later one finds the verdict.
  state.poll.mockReset();
  state.poll.mockResolvedValueOnce(revision('rev-2', 'running')).mockResolvedValue(revision('rev-2', 'completed', false));
  await render();
  expect(button().disabled, 'Submit is "In review" while the review runs').toBe(true);
  // The verdict lands on the server; the room is left open for two minutes.
  state.load.mockResolvedValue(detail([task({ lastSubmissionId: 'rev-2' })], revision('rev-2', 'completed', false)));
  await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
  expect(state.poll).toHaveBeenCalledWith('rev-2');
  expect(button().disabled, 'Submit should be on once the verdict is in').toBe(false);
  expect(button().dataset.reason).toBeUndefined();
  await act(async () => { fireEvent.click(button()); });
  expect(state.submit).toHaveBeenCalledTimes(1);
});

describe('the design room\'s in-flight hold is "In review", with no extra door', () => {
  it('while the revision is queued, Submit reads "In review" and there is no "See the review" link (the Review tab holds it)', async () => {
    state.load.mockResolvedValue(detail([task()], revision('rev-2', 'queued')));
    await render();
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe('In review');
    expect(Array.from(host.querySelectorAll('a')).some((one) => one.textContent === 'See the review')).toBe(false);
    expect(host.querySelector('[data-testid="design-see-review"]')).toBeNull();
  });
  it('with nothing in flight there is no such link', async () => {
    state.load.mockResolvedValue(detail([task({ lastSubmissionId: 'rev-2' })], revision('rev-2', 'completed', false)));
    await render();
    expect(Array.from(host.querySelectorAll('a')).some((one) => one.textContent === 'See the review')).toBe(false);
  });
  it('a revision older than the API\'s age-out window no longer holds Submit off: the next press is what writes it off', async () => {
    const aged = { ...revision('rev-2', 'queued'), createdAt: new Date(Date.now() - 11 * 60_000).toISOString() };
    state.load.mockResolvedValue(detail([task()], aged));
    // the history still lists it as queued: only the submit writes it off
    state.history.mockResolvedValue([aged]);
    state.submit.mockReset(); state.submit.mockResolvedValueOnce({ ...revision('rev-3', 'queued'), createdAt: new Date().toISOString() });
    await render();
    expect(button().disabled).toBe(false);
    expect(button().dataset.reason).toBeUndefined();
    await act(async () => { fireEvent.click(button()); });
    expect(state.history).toHaveBeenCalledTimes(1);
    expect(state.submit).toHaveBeenCalledTimes(1);
    expect(button().textContent).toBe('In review');
  });
});

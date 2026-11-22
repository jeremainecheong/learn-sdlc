// @vitest-environment jsdom
/**
 * Submit waits for the countersignature, in the design room.
 *
 * While the design task has passed its review and waits on the teacher's
 * countersignature, a refused resubmit would clear the task's place in the
 * sign-off queue. So "Submit for review" and ⌘↵ are off with
 * SIGN_OFF_SUBMIT_REASON and nothing is saved or submitted; after the
 * countersignature it submits normally. The rig is design-submit.test.tsx's,
 * with the button stand-in keeping `reason`.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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
import { SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';
let host: HTMLDivElement, root: Root;
const task = (over: Record<string, unknown> = {}) => ({
  key: 'main', order: 1, required: true, title: 'The design', artefactType: 'design', artefactPath: 'design/design.json', primaryPath: 'design/design.json',
  files: ['design/design.json'], evidence: 'signed-off', sealed: true, status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 88,
  passedAt: null, lastSubmissionId: 'rev-1', resetAt: null, solution: { available: false, files: 0, readAt: null }, ...over,
});
const detail = (tasks: Record<string, unknown>[], status = 'submitted', lastSubmission: unknown = null) => ({ id: 'design-a', key: 'design', title: 'Design', projectSlug: 'tasktrackr', status,
  workspaceUpdatedAt: '2026-09-15T10:00:00.000Z', files: [{ path: 'design/design.json', content: 'baseline', editable: true }], tasks, lastSubmission,
  taskCounts: { total: tasks.length, required: tasks.length, passed: 0, passedRequired: 0 } });
const render = () => act(async () => { root.render(<DesignPage />); });
const button = () => host.querySelector<HTMLButtonElement>('[data-testid="design-submit"]')!;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); state.owner = 'learner-a'; state.token = 'controlled-test-token'; state.phaseId = 'design-a'; state.agentBusy = false; state.message = 'Explain the list contract';
  state.save.mockResolvedValue({ version: '2026-09-15T10:00:01.000Z' }); state.history.mockResolvedValue([]);
  state.submit.mockRejectedValue(new Error('a resubmit reached the API'));
  window.history.replaceState(null, '', '/workspace/design-a/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it('while the design task waits on the countersignature, Submit is off with the reason and ⌘↵ hands nothing in', async () => {
  state.load.mockResolvedValue(detail([task()]));
  await render();
  expect(button().disabled).toBe(true);
  expect(button().dataset.reason).toBe(SIGN_OFF_SUBMIT_REASON);
  await act(async () => { fireEvent.click(button()); fireEvent.keyDown(window, { key: 'Enter', metaKey: true }); });
  expect(state.save).not.toHaveBeenCalled(); expect(state.history).not.toHaveBeenCalled(); expect(state.submit).not.toHaveBeenCalled();
});
it('the verdict that just landed holds the slot before the row knows it', async () => {
  state.load.mockResolvedValue(detail([task({ awaitingSignOff: false })], 'submitted', { id: 'rev-2', taskKey: 'main', status: 'completed', passed: true, createdAt: '2026-09-15T10:00:00.000Z' }));
  await render();
  expect(button().disabled).toBe(true);
  expect(button().dataset.reason).toBe(SIGN_OFF_SUBMIT_REASON);
});
it('after the countersignature the design submits once', async () => {
  state.submit.mockResolvedValue({ id: 'review-1', status: 'queued' });
  state.load.mockResolvedValue(detail([task({ status: 'passed', awaitingSignOff: false })], 'passed'));
  await render();
  expect(button().disabled).toBe(false);
  expect(button().dataset.reason).toBeUndefined();
  await act(async () => { fireEvent.click(button()); });
  expect(state.submit).toHaveBeenCalledTimes(1);
});

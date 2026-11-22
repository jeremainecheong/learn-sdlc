// @vitest-environment jsdom
/**
 * Design's Review tab hands the shared review the phase it holds, so a floor rule the
 * teacher set to 0 reads "Not required" there as on the pull request page. Fails if the call site stops passing
 * `floors={detail}` (the row then reads Passed). The rig is design-room-signoff-submit's, with the real ui kit so the
 * review's rows are drawn.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
// The real Chip, StatusSquare and the rest: the review's rows are drawn as on the page; Button keeps its test id.
vi.mock('@/components/ui', async (original) => ({
  ...await original<typeof import('@/components/ui')>(),
  Button: ({ children, onClick, testId, disabled, href }: { children?: ReactNode; onClick?: () => void; testId?: string; disabled?: boolean; href?: string }) => href
    ? <a href={href}>{children}</a> : <button data-testid={testId} disabled={disabled} onClick={onClick}>{children}</button>,
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
let host: HTMLDivElement, root: Root;
const zero = { id: 'design.decisions.min', label: 'At least 0 decisions', status: 'passed', detail: '0 decisions' };
const reviewed = {
  id: 'rev-floor', taskKey: 'main', status: 'completed', passed: true, score: 100, attempt: 1, createdAt: '2026-09-15T10:00:00.000Z',
  report: {
    assessmentMode: 'strict_binary', overall: 100, passed: true,
    criteria: [{ key: 'design', title: 'Design', weight: 1, score: 100, evidence: ['✓ The design record', '✓ At least 0 decisions'] }],
    checks: [zero],
    aiReview: { verdict: 'pass', summary: 'Fine.', strengths: [], improvements: [], processNote: '', provider: 'openai', criteriaEvidence: [] },
    aiReliance: { hintsThisPhase: 0, index: 0 },
    integrity: { relianceFlag: false, relianceIndex: 0, mentorPasteFlag: false, noEffortFlag: false, note: '' },
  },
};
const detail = {
  id: 'design-a', key: 'design', title: 'Design', projectSlug: 'tasktrackr', status: 'submitted', artifactKind: 'design',
  workspaceUpdatedAt: '2026-09-15T10:00:00.000Z', files: [{ path: 'design/design.json', content: 'baseline', editable: true }],
  tasks: [{ key: 'main', order: 1, required: true, title: 'The design', artefactType: 'design', artefactPath: 'design/design.json', primaryPath: 'design/design.json',
    files: ['design/design.json'], evidence: 'signed-off', sealed: true, status: 'submitted', awaitingSignOff: true, attempts: 1, bestScore: 100,
    passedAt: null, lastSubmissionId: 'rev-floor', resetAt: null, solution: { available: false, files: 0, readAt: null } }],
  taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
  lastSubmission: reviewed,
  design: { floor: { minEntities: 1, minRelations: 1, minOperations: 1, minDecisions: 0, minEndpoints: 1, minScreens: 0 } },
};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); state.owner = 'learner-a'; state.token = 'controlled-test-token'; state.phaseId = 'design-a'; state.agentBusy = false;
  state.history.mockResolvedValue([]); state.load.mockResolvedValue(detail);
  window.history.replaceState(null, '', '/workspace/design-a/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('Design\'s Review tab reads a floor of 0 as "Not required", from the phase it holds', async () => {
  await act(async () => { root.render(<DesignPage />); });
  await act(async () => { await Promise.resolve(); });
  const review = host.querySelector('[data-testid="design-review"]')!;
  expect(review.getAttribute('data-submission')).toBe('rev-floor');
  const chip = review.querySelector('[data-testid="check-not-required"]');
  expect(chip?.textContent).toBe('Not required');
  expect(chip!.closest('tr')!.textContent).toContain('At least 0 decisions');
});

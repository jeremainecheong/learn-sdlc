// @vitest-environment jsdom
/**
 * The words of the Design room's parts list and drawn section, on an uploaded project.
 *
 * They are reached without opening anything: "Your design" (its last row, "Component diagram") sits in the open
 * brief column, and the Review tab that Submit opens draws the drawn section (class diagram and component diagram)
 * under the verdict. This mounts the REAL Design room with the REAL parts list and drawn section, over the workspace
 * the Deadline badge Design holds (pack v5: the design record and nothing else, no code), and pins the words there.
 *
 * The rig is design-room-header's, with DesignBoard left real, the brief open and the class diagram drawn as
 * nothing (its layout is pinned elsewhere).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadlineBadgePhases, deadlineBadgeRoom } from './support/deadline-badge-pack';

const state = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), submit: vi.fn(), history: vi.fn(), push: vi.fn(), doc: null as unknown, enrollment: null as unknown,
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: 'design-v5' }), useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: 'learner-v5' }), useSession: () => ({ id: 'learner-v5' }), onSessionEnd: () => () => undefined, subscribe: () => () => undefined }));
vi.mock('@/lib/api', async (importOriginal) => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
  return { ApiError, getToken: () => 'learner-token', API_URL: (await importOriginal<typeof import('@/lib/api')>()).API_URL, request: vi.fn(), tokenAtSessionEnd: () => null, onSessionLeaving: () => () => undefined, onSignOut: () => () => undefined,
    api: { phase: state.load, saveWorkspace: state.save, submit: state.submit, submissions: state.history, myEnrollment: vi.fn(async () => null) },
    describeError: (error: unknown, fallback: string) => error instanceof ApiError ? error.message : fallback };
});
vi.mock('@/lib/api-workspace', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/api-workspace')>(), saveVersionedWorkspaceOnExit: vi.fn() }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: state.enrollment, analytics: null }), fullDetail: () => null, invalidateProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/experience/shared', () => ({ reviewHref: (phase: string) => `/feedback?phase=${phase}` }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/WorkspaceViews', () => ({ useWorkspaceViewScroll: () => ({ view: 'api', select: vi.fn(), contentRef: { current: null } }) }));
// The brief open.
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: false, briefId: 'design-brief' }),
  WorkspacePanelControls: () => null, WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/shell', () => ({ WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>, PhaseStrip: () => null,
  briefHref: () => '/brief', usePersona: () => ({}), PersonaComposer: () => null, PersonaFeed: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/panels/design/BoardCards', () => ({ EntitiesCard: () => null, RelationsCard: () => null, NotesCard: () => null }));
vi.mock('@/components/workspace/panels/design/OperationsCard', () => ({ OperationsCard: () => null }));
vi.mock('@/components/workspace/panels/design/DecisionsCard', () => ({ DecisionsCard: () => null }));
vi.mock('@/components/workspace/panels/design/ScreensForm', () => ({ ScreensForm: () => null }));
vi.mock('@/components/workspace/panels/design/ChecksPanel', () => ({ ChecksPanel: () => null }));
vi.mock('@/components/workspace/panels/design/UmlDiagram', () => ({ UmlDiagram: () => null }));
vi.mock('@/components/workspace/panels/design/useDesign', () => ({ useDesign: () => ({
  doc: state.doc, olderFormat: false, broken: null, results: [], apiText: undefined, screensText: undefined,
  contracts: { api: false, screens: false }, sequence: false, stories: [], floor: null, writing: false, busy: false,
  write: vi.fn(), writeContract: vi.fn(), setDecisionStatus: vi.fn(), check: vi.fn() }) }));
vi.mock('@/components/workspace/panels/design/useStories', () => ({ useOwnStoryRecord: () => undefined }));
vi.mock('@/components/workspace/panels/design/ApiWorkbench', () => ({ ApiWorkbench: () => null }));
vi.mock('@/components/workspace/panels/design/DiagramStudio', () => ({ DiagramStudio: () => null }));
vi.mock('@/components/workspace/panels/design/ClassDiagram', () => ({ ClassDiagram: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p>Loading</p> }));

import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';

/** Pack v5's reference design: the one entity Task and the one operation isOverdue(task, today) a learner types. */
const DESIGN = {
  entities: [{ id: 'E1', name: 'Task', kind: 'class',
    attributes: [{ name: 'title', type: 'string', note: '' }, { name: 'dueDate', type: 'date or null', note: 'yyyy-mm-dd' }],
    responsibilities: ['knows when it is due'], satisfies: ['US-1'] }],
  relations: [],
  operations: [{ id: 'O1', name: 'isOverdue(task, today)', inputs: ['task', 'today'], returns: 'boolean', errors: [], satisfies: ['US-1'],
    note: 'True only when the due date is before today. Due today is not overdue.' }],
  decisions: [],
  notes: '',
};
const task = (status: string) => ({
  key: '', order: 1, required: true, title: 'Design', artefactType: 'design', artefactPath: 'design/design.json', primaryPath: 'design/design.json',
  files: ['design/design.json'], evidence: 'automated', sealed: true, status, awaitingSignOff: false, attempts: status === 'passed' ? 1 : 0, bestScore: null,
  passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null },
});
/** The Deadline badge Design workspace: its design record, and no code of any kind. */
const v5Design = (status: 'in_progress' | 'passed') => ({
  id: 'design-v5', key: 'design', title: 'Design', projectSlug: 'deadline-badge', status, place: 2, count: 6, artifactKind: 'design',
  workspaceUpdatedAt: '2026-11-13T09:00:00.000Z', files: [{ path: 'design/design.json', content: `${JSON.stringify(DESIGN, null, 2)}\n`, editable: true }],
  tasks: [task(status)], lastSubmission: null, taskCounts: { total: 1, required: 1, passed: status === 'passed' ? 1 : 0, passedRequired: status === 'passed' ? 1 : 0 },
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers();
  state.doc = DESIGN;
  state.enrollment = null;
  state.save.mockResolvedValue({ version: '2026-11-13T09:00:01.000Z' }); state.history.mockResolvedValue([]);
  window.history.replaceState(null, '', '/workspace/design-v5/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

const NOTHING_TO_DRAW = 'Nothing in this phase to draw it from';
const NONE_HERE = "Drawn from the imports of the modules in this phase's files, and this phase holds none. The code is written in Implementation, in its own files.";
const DRIFT_NONE = 'No file in this phase defines the operations, so there is nothing to compare the diagram with.';

describe.each(['in_progress', 'passed'] as const)('the demo\'s Design room (Deadline badge, pack v5), %s', (status) => {
  it('the brief column\'s "Your design" ends "Component diagram", "Nothing in this phase to draw it from"', async () => {
    state.load.mockResolvedValue(v5Design(status));
    await act(async () => { root.render(<DesignPage />); });
    const brief = host.querySelector<HTMLElement>('aside[data-workspace-panel="brief"]')!;
    expect(brief.hidden).toBe(false);
    expect(brief.textContent).toContain('Your design');
    const row = brief.querySelector<HTMLElement>('[data-testid="phase-design-part-component-diagram"]')!;
    expect(row, 'the component row is in the brief column').not.toBeNull();
    expect(row.textContent).toContain('Component diagram');
    expect(row.textContent).toContain(NOTHING_TO_DRAW);
    expect(row.textContent).not.toContain('Waiting on the modules');
  });

  it('the Review tab draws, under the verdict, the drift and component sentences, word for word', async () => {
    state.load.mockResolvedValue(v5Design(status));
    await act(async () => { root.render(<DesignPage />); });
    const verdict = host.querySelector<HTMLElement>('[data-testid="design-review"]')!;
    const tab = verdict.parentElement!;
    // the Review tab's own box: the verdict first, the drawn section after it
    const components = tab.querySelector<HTMLElement>('[data-testid="phase-design-components"]')!;
    expect(components, 'the component diagram is in the Review tab').not.toBeNull();
    expect(verdict.compareDocumentPosition(components) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(components.textContent).toContain(NONE_HERE);
    expect(tab.textContent).toContain(DRIFT_NONE);
    expect(tab.textContent).not.toContain('The Implementation phase writes');
  });
});

describe('the fixture is the demo\'s Design workspace', () => {
  it('the Deadline badge pack\'s Design phase ships no files of its own, so its workspace holds the design record only', () => {
    expect(deadlineBadgePhases()).toContain('02-design');
    expect(deadlineBadgeRoom('02-design')).toEqual({});
    expect(v5Design('in_progress').files.map((file) => file.path)).toEqual(['design/design.json']);
  });
});

/*
 * On a Design the learner has left, the footer's Check the design and Submit again were two framed
 * buttons under the "moved on" band. They are quiet (ghost) there, same names, ids and keys. A learner still on Design,
 * up to their Continue, sees them as framed buttons. On a completed project Submit is still offered: a retry after
 * completion needs a Submit after it. The enrolment here is the shell's, as the room reads it.
 */
describe('the Design footer on a phase the learner has left', () => {
  const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
  const enrolment = (current: number, completed = false) => ({
    id: 'e-v5', projectSlug: 'deadline-badge', projectTitle: 'Deadline badge', currentPhaseOrder: current, completed, releases: [],
    phases: KEYS.map((key, at) => ({ id: key === 'design' ? 'design-v5' : `p-${key}`, key, order: at + 1, title: key, status: completed || at + 1 < current ? 'passed' : at + 1 === current ? 'in_progress' : 'locked' })),
  });
  const footer = async (status: 'in_progress' | 'passed', enrollment: unknown) => {
    state.enrollment = enrollment;
    state.load.mockResolvedValue(v5Design(status));
    await act(async () => { root.render(<DesignPage />); });
    return { check: host.querySelector<HTMLElement>('[data-testid="phase-design-render"]'), submit: host.querySelector<HTMLElement>('[data-testid="design-submit"]') };
  };

  it('in progress, and passed with the learner still on Design, the footer keeps Check the design secondary and Submit framed', async () => {
    for (const status of ['in_progress', 'passed'] as const) {
      const { check, submit } = await footer(status, enrolment(2));
      expect(check!.className).toContain('btn-secondary');
      expect(check!.textContent).toContain('Check the design');
      expect(submit!.className).not.toContain('btn-ghost');
    }
  });

  it('the studio mounts the gate band itself: one band on a passed Design', async () => {
    // The Design room is drawn by its own page, outside the document frame
    // that carries the band to the other sub-routes, so it needs its own.
    await footer('passed', enrolment(2));
    expect(host.querySelectorAll('[data-testid="gate-banner"]')).toHaveLength(1);
  });

  it('a split Design draws its task list with the phase, so the quiz row is a door to the quiz room', async () => {
    const quiz = { ...task('in_progress'), key: 'design-quiz', order: 2, title: 'Design concepts check', artefactType: 'quiz', artefactPath: undefined,
      primaryPath: undefined, files: [], evidence: 'automated' };
    state.enrollment = enrolment(2);
    state.load.mockResolvedValue({ ...v5Design('in_progress'), tasks: [{ ...task('in_progress'), key: 'design' }, quiz],
      taskCounts: { total: 2, required: 2, passed: 0, passedRequired: 0 } });
    await act(async () => { root.render(<DesignPage />); });
    expect(host.querySelector('[data-testid="task-open-design-quiz"]')?.tagName).toBe('A');
  });

  it('no gate band while Design is in progress', async () => {
    await footer('in_progress', enrolment(2));
    expect(host.querySelector('[data-testid="gate-banner"]')).toBeNull();
  });

  it('moved on: both quiet (ghost), with their names and ids', async () => {
    const { check, submit } = await footer('passed', enrolment(3));
    expect(check!.className).toContain('btn-ghost');
    expect(check!.className).not.toContain('btn-secondary');
    expect(submit!.className).toContain('btn-ghost');
    expect(check!.textContent).toContain('Check the design');
  });

  it('a completed project: Submit is still offered (quiet, pressable), as is Check the design', async () => {
    const { check, submit } = await footer('passed', enrolment(6, true));
    expect(submit!.textContent).toContain('Submit');
    expect(submit!.className).toContain('btn-ghost');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(check!.className).toContain('btn-ghost');
  });
});

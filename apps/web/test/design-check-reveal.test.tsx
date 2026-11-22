// @vitest-environment jsdom
/**
 * "Check the design" draws "Design checked: 8 of 8 checks pass." at the top of the middle column, which a person
 * scrolled down to Operations would not see (about 600 px above the view): the press would look dead. Once the check
 * answers, the room brings its notice into view in that column,
 * instantly, only when it is out of view, and never moves the keyboard focus; pressed by its shortcut while the person
 * types in a field of the column, nothing moves at all (that is read when the key arrives, since a browser takes the
 * focus off the field before the check answers). The notice's words, test id and box are unchanged by the reveal.
 * Nothing else the room draws there (the Apply's notice) scrolls anything.
 *
 * The rig is design-review-uploaded-words's: the REAL Design room over the Deadline badge design, the cards drawn as
 * nothing, and `useDesign` standing in so its check answers as the real one does (through `setNotice`).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), submit: vi.fn(), history: vi.fn(), push: vi.fn(),
  design: null as null | { setNotice: (m: string) => void; setError: (m: string) => void },
  applied: null as null | (() => Promise<unknown>),
  answer: 'notice' as 'notice' | 'error',
  // As a browser does: the field the shortcut was pressed in has lost the focus before the check answers.
  blurFirst: false,
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
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: vi.fn() }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: vi.fn() }));
vi.mock('@/lib/commit', () => ({ commitDraft: () => '', clearCommitDraft: vi.fn() }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: vi.fn() }));
vi.mock('@/components/experience/shared', () => ({ reviewHref: (phase: string) => `/feedback?phase=${phase}` }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({
  useAgentWorkspace: (_phase: string, _flush: unknown, refresh: () => Promise<unknown>) => { state.applied = refresh; return false; },
}));
vi.mock('@/components/workspace/WorkspaceViews', () => ({ useWorkspaceViewScroll: () => ({ view: 'model', select: vi.fn(), contentRef: { current: null } }) }));
vi.mock('@/components/workspace/WorkspacePanels', () => ({ useWorkspacePanels: () => ({ briefOpen: true, mentorOpen: false, briefId: 'design-brief' }),
  WorkspacePanelControls: () => null, WorkspaceMentorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/components/shell', () => ({ WorkPage: ({ children, strip }: { children: ReactNode; strip: ReactNode }) => <main>{strip}{children}</main>, PhaseStrip: () => null,
  briefHref: () => '/brief', usePersona: () => ({}), PersonaComposer: () => null, PersonaFeed: () => null }));
vi.mock('@/components/shell/PersonaPanel', () => ({ MentorSession: () => null }));
vi.mock('@/components/workspace/panels/design/BoardCards', () => ({ EntitiesCard: () => null, RelationsCard: () => null, NotesCard: () => null }));
vi.mock('@/components/workspace/panels/design/OperationsCard', () => ({ OperationsCard: () => <input data-testid="design-operation-0-errors" /> }));
vi.mock('@/components/workspace/panels/design/DecisionsCard', () => ({ DecisionsCard: () => null }));
vi.mock('@/components/workspace/panels/design/ScreensForm', () => ({ ScreensForm: () => null }));
vi.mock('@/components/workspace/panels/design/ChecksPanel', () => ({ ChecksPanel: () => null }));
vi.mock('@/components/workspace/panels/design/UmlDiagram', () => ({ UmlDiagram: () => null }));
vi.mock('@/components/workspace/panels/design/useDesign', () => ({ useDesign: (props: { setNotice: (m: string) => void; setError: (m: string) => void }) => {
  state.design = props;
  return {
    doc: { entities: [], relations: [], operations: [], decisions: [], notes: '' }, olderFormat: false, broken: null, results: [], apiText: undefined, screensText: undefined,
    contracts: { api: false, screens: false }, sequence: false, stories: [], floor: null, writing: false, busy: false, assisted: () => [],
    write: vi.fn(), writeContract: vi.fn(), setDecisionStatus: vi.fn(),
    // As the real check answers: the notice, or why the design did not save.
    check: vi.fn(async () => {
      if (state.blurFirst) (document.activeElement as HTMLElement | null)?.blur();
      if (state.answer === 'error') state.design!.setError('Your design did not save. Try the button again.');
      else state.design!.setNotice('Design checked: 8 of 8 checks pass.');
    }),
  };
} }));
vi.mock('@/components/workspace/panels/design/useStories', () => ({ useOwnStoryRecord: () => undefined }));
vi.mock('@/components/workspace/panels/design/ApiWorkbench', () => ({ ApiWorkbench: () => null }));
vi.mock('@/components/workspace/panels/design/DiagramStudio', () => ({ DiagramStudio: () => null }));
vi.mock('@/components/workspace/panels/design/ClassDiagram', () => ({ ClassDiagram: () => null }));
vi.mock('@/components/workspace/panels/design/DesignBoard', () => ({ DesignParts: () => null, Contradictions: () => null, DrawnSection: () => null, DesignUnavailable: () => null }));
vi.mock('@/components/workspace/PhaseBriefIntro', () => ({ PhaseBriefIntro: () => null }));
vi.mock('@/components/workspace/panels/RoomFallback', () => ({ RoomFallback: () => <p>Loading</p> }));

import DesignPage from '@/app/(app)/workspace/[phaseId]/design/page';

const design = () => ({
  id: 'design-v5', key: 'design', title: 'Design', projectSlug: 'deadline-badge', status: 'in_progress', place: 2, count: 6, artifactKind: 'design',
  workspaceUpdatedAt: '2026-11-13T09:00:00.000Z', files: [{ path: 'design/design.json', content: '{}\n', editable: true }],
  tasks: [{ key: '', order: 1, required: true, title: 'Design', artefactType: 'design', artefactPath: 'design/design.json', primaryPath: 'design/design.json',
    files: ['design/design.json'], evidence: 'automated', sealed: true, status: 'in_progress', awaitingSignOff: false, attempts: 0, bestScore: null,
    passedAt: null, lastSubmissionId: null, resetAt: null, solution: { available: false, files: 0, readAt: null } }],
  lastSubmission: null, taskCounts: { total: 1, required: 1, passed: 0, passedRequired: 0 },
});

/** Where things are drawn, as measured in a browser at 1440 by 900: the column from y 166 to 830. */
let noticeTop = -442;
/** The Errors field of the operation scrolled to, in view in the column. */
let fieldTop = 600;
const scrollTo = vi.fn();
let host: HTMLDivElement, root: Root, style: HTMLStyleElement;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); sessionStorage.clear();
  state.answer = 'notice'; state.blurFirst = false; noticeTop = -442; fieldTop = 600;
  state.save.mockResolvedValue({ version: '2026-11-13T09:00:01.000Z' }); state.history.mockResolvedValue([]);
  state.load.mockResolvedValue(design());
  // The column's own class, as the stylesheet draws it.
  style = document.createElement('style'); style.textContent = '.overflow-y-auto{overflow-y:auto}'; document.head.append(style);
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const id = this.getAttribute('data-testid');
    const [top, bottom] = id === 'phase-design-editor' ? [166, 830] : id === 'design-room-notices' ? [noticeTop, noticeTop + 50]
      : id === 'design-operation-0-errors' ? [fieldTop, fieldTop + 40] : [0, 0];
    return { top, bottom, height: bottom - top, left: 0, right: 700, width: 700, x: 0, y: top, toJSON() {} } as DOMRect;
  });
  window.history.replaceState(null, '', '/workspace/design-v5/design');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); style.remove(); vi.restoreAllMocks(); });

const open = async () => {
  await act(async () => { root.render(<DesignPage />); });
  await act(async () => { await Promise.resolve(); });
};
const column = () => host.querySelector<HTMLElement>('[data-testid="phase-design-editor"]')!;
const pressCheck = async () => {
  await act(async () => { host.querySelector<HTMLElement>('[data-testid="phase-design-render"]')!.click(); });
  await act(async () => { await Promise.resolve(); });
};

describe('the check\'s answer is brought into view in the column', () => {
  it('scrolled down to Operations: Check the design brings "Design checked: 8 of 8 checks pass." into view, instantly, in the column only', async () => {
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 1155 });
    expect(scrollTo).not.toHaveBeenCalled();
    await pressCheck();
    const box = host.querySelector<HTMLElement>('[data-testid="design-room-notices"]')!;
    expect(box.textContent).toBe('Design checked: 8 of 8 checks pass.');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.instances[0]).toBe(column());
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (-442 - 166 - 12), behavior: 'instant' });
  });

  it('a check that could not save: its error, in the same box, is brought into view too', async () => {
    state.answer = 'error';
    await open();
    await pressCheck();
    expect(host.querySelector('[data-testid="design-room-notices"]')!.textContent).toContain('Your design did not save.');
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('the keyboard focus is left where it was (a field being typed in keeps it)', async () => {
    await open();
    const field = host.querySelector<HTMLInputElement>('[data-testid="design-operation-0-errors"]')!;
    field.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement).toBe(field);
  });

  it('the shortcut pressed while typing in a field of the column: the notice is drawn, and the field is not scrolled out of view', async () => {
    await open();
    const field = host.querySelector<HTMLInputElement>('[data-testid="design-operation-0-errors"]')!;
    field.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="design-room-notices"]')!.textContent).toBe('Design checked: 8 of 8 checks pass.');
    // Bringing the notice in would move the column 620 px up and the field (y 600) out of the view: nothing moves.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field);
  });

  it('the shortcut from a field, the field blurred before the check answers (as a browser did): nothing moves', async () => {
    state.blurFirst = true;
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 1050 });
    const field = host.querySelector<HTMLInputElement>('[data-testid="design-operation-0-errors"]')!;
    field.focus();
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="design-room-notices"]')!.textContent).toBe('Design checked: 8 of 8 checks pass.');
    // The focus left the field before the answer (the check's doing, not the room's), yet the column stays at Operations.
    expect(document.activeElement).not.toBe(field);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('the shortcut from a field, even where bringing the notice in would keep the field in view: nothing moves', async () => {
    noticeTop = 100;
    await open();
    Object.defineProperty(column(), 'scrollTop', { configurable: true, writable: true, value: 500 });
    host.querySelector<HTMLInputElement>('[data-testid="design-operation-0-errors"]')!.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('the shortcut with the focus on the page body: the notice is brought in', async () => {
    state.blurFirst = true;
    await open();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.instances[0]).toBe(column());
  });

  it('a field outside the middle column does not count: the notice is brought in', async () => {
    await open();
    const outside = document.createElement('input');
    document.body.append(outside);
    outside.focus();
    await act(async () => { outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true, bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    outside.remove();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('the shortcut from a field, then a press on the button: the press brings the notice in', async () => {
    await open();
    host.querySelector<HTMLInputElement>('[data-testid="design-operation-0-errors"]')!.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(scrollTo).not.toHaveBeenCalled();
    host.querySelector<HTMLElement>('[data-testid="phase-design-render"]')!.focus();
    await pressCheck();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('the shortcut with the focus on no field (the button, the page): the notice is brought in as on a press', async () => {
    await open();
    host.querySelector<HTMLElement>('[data-testid="phase-design-render"]')!.focus();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, shiftKey: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('the notice already in view (the column at its top): nothing moves', async () => {
    noticeTop = 182;
    await open();
    await pressCheck();
    expect(host.querySelector('[data-testid="design-room-notices"]')!.textContent).toBe('Design checked: 8 of 8 checks pass.');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('opening the room, and an Apply\'s notice, scroll nothing', async () => {
    await open();
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => { await state.applied!(); });
    expect(host.querySelector('[data-testid="design-room-notices"]')!.textContent).toBe('The reviewed proposal is saved in this workspace.');
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

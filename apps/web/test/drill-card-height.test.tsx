// @vitest-environment jsdom
/**
 * The drill page's not-started INCIDENT-1 card is drawn straight in
 * the document's scrolling flex column and clips its overflow (a Section), so on a short window it could be
 * squeezed to its borders, as the change request's Change impact card was. It keeps its own height. The rig is
 * drill-page.test.tsx's (the frame stood in for by a plain column).
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNBOOK_JSON, type DrillState, type PhaseDetail } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  phaseId: 'drill-phase', load: vi.fn(), start: vi.fn(),
  frame: null as null | { mission?: ReactNode; right?: ReactNode },
  before: [] as string[],
}));
vi.mock('next/navigation', () => ({ useParams: () => ({ phaseId: rig.phaseId }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/api', () => ({
  api: { phase: rig.load, drillStart: rig.start, drillHealth: vi.fn(), drillResolve: vi.fn() },
  describeError: (_e: unknown, fallback: string) => fallback, getToken: () => 'token',
  // read by the drill's header Submit's modules: no session ends here
  onSessionLeaving: () => () => {}, onSignOut: () => () => {}, tokenAtSessionEnd: () => null,
}));
// `ownedByToken` for lib/commit, which the drill's header Submit reads the commit draft from: one session throughout.
vi.mock('@/lib/session', () => ({ getSession: () => ({ id: 'owner' }), useSession: () => ({ id: 'owner' }), onSessionEnd: () => () => {}, ownedByToken: () => () => undefined }));
vi.mock('@/lib/useProject', () => ({ useProject: () => ({ details: {}, enrollment: null, analytics: null }), fullDetail: () => null, invalidateProject: vi.fn() }));
vi.mock('@/lib/project', () => ({ setActiveProject: vi.fn() }));
vi.mock('@/lib/poll', () => ({ useRecoverWhenBack: () => {} }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ usePhaseTutorialReady: () => {} }));
vi.mock('@/components/workspace/useVersionedWorkspaceSave', () => ({
  useVersionedWorkspaceSave: () => ({ files: {}, flushSave: async () => {}, saveError: '', saving: false, dirty: false, conflict: null, resolveConflict: vi.fn() }),
}));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/workspace/mentor/useAppliedReadBack', () => ({ useAppliedReadBack: () => ({ readBack: vi.fn(), failed: false }) }));
vi.mock('@/components/shell', async () => ({
  ...await import('@/components/shell/routes'),
  DocPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({
  PhaseDocumentFrame: ({ children, mission, right, subNav, title, titleTestId }: { children: ReactNode; mission?: ReactNode; right?: ReactNode; subNav?: ReactNode; title?: ReactNode; titleTestId?: string }) => {
    rig.frame = { mission, right };
    return <main><aside data-testid="frame-brief">{mission}</aside><header data-testid="frame-header"><h1 data-testid={titleTestId}>{title}</h1>{right}</header>{subNav}<div data-testid="frame-content">{children}</div></main>;
  },
}));
vi.mock('@/components/phases/Brief', () => ({ MissionDetails: () => <details data-testid="mission-details"><summary>Mission and review criteria</summary></details> }));
vi.mock('@/components/workspace/panels/deployment/DrillDoc', async () => ({
  ...(await vi.importActual<object>('@/components/workspace/panels/deployment/DrillDoc')),
  FaultedDeployment: ({ beforeStderr }: { beforeStderr: string }) => { rig.before.push(beforeStderr); return <pre data-testid="faulted-before">{beforeStderr}</pre>; },
  ResolveChecklist: () => null, IncidentWriteUp: () => null,
}));

import DrillPage from '@/app/(app)/workspace/[phaseId]/drill/page';
import { rememberDrillAlert } from '@/components/workspace/panels/deployment/alert-text';
import { DRILL_CARD_PURPOSE, DRILL_CARD_TITLE, DRILL_NOT_STARTED, DRILL_NOT_STARTED_CHIP, drillNotStartedBody } from '@/components/workspace/panels/deployment/drill';

const PAGED = '2026-11-17T03:12:04.506Z';
const ALERT = 'selfcheck: API_URL points at 127.0.0.1:8000';
const drill = (over: Partial<DrillState> = {}): DrillState => ({
  fault: 'api-url', pagedAt: PAGED, runbookBefore: null, pagedExit: 1, healthRanAt: null, healthExit: null,
  fixAppliedAt: null, resolvedAt: null, incident: null, ...over,
});
const phase = (state: DrillState | null): PhaseDetail => ({
  id: rig.phaseId, key: 'deployment', title: 'Deployment', order: 5, place: 5, count: 6, status: 'in_progress', projectSlug: 'deadline-badge',
  artifactKind: 'config', runbook: { floor: { minEnvironment: 0, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true }, drill: true },
  files: [{ path: RUNBOOK_JSON, content: '{}', editable: true, language: 'json' }],
  attempts: 0, rubric: { criteria: [], passThreshold: 100 }, objectives: [], taskPanel: '', links: [], canRun: true, canPreview: false,
  runLabel: 'Run selfcheck', lastSubmission: null, drill: state,
}) as unknown as PhaseDetail;

let host: HTMLDivElement, root: Root, sequence = 0;
beforeEach(() => {
  rig.phaseId = `drill-phase-${++sequence}`; rig.frame = null; rig.before = []; vi.clearAllMocks(); sessionStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const open = async () => {
  await act(async () => { root.render(<DrillPage />); });
  await act(async () => { await Promise.resolve(); });
};

describe('the not-started drill card keeps its height in the scrolling column', () => {
  it('it is one of the column\'s own items, it clips, and it does not shrink', async () => {
    rig.load.mockResolvedValue(phase(null));
    await open();
    const column = host.querySelector('[data-testid="frame-content"]')!;
    const card = [...column.children].find((child) => (child.textContent ?? '').includes(DRILL_CARD_TITLE)) as HTMLElement;
    expect(card).toBeDefined();
    expect(card.className).toMatch(/(^|\s)overflow-hidden(\s|$)/);
    expect(card.classList.contains('shrink-0')).toBe(true);
  });
});

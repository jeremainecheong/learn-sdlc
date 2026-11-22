// @vitest-environment jsdom
/**
 * The incident drill page.
 *
 * - The line the paged run printed is shown on the drill page for as
 *   long as that drill is open, whichever page of the phase started it: the
 *   page keeps it for the tab when it starts the drill, and reads back what
 *   another page kept. A drill paged at another moment never shows it.
 * - The document draws no "Brief" and "Back to the workspace" links of its
 *   own. The frame's working-area row opens the workspace at every width, and
 *   its brief column holds the brief's words ("Mission and review
 *   criteria"), as the workspace's does.
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
const shown = () => host.querySelector('[data-testid="faulted-before"]')?.textContent ?? null;

describe('the drill page shows the paged line for the open drill', () => {
  it('reads back what another page of the phase kept for this drill', async () => {
    rememberDrillAlert(rig.phaseId, PAGED, ALERT);
    rig.load.mockResolvedValue(phase(drill()));
    await open();
    expect(shown()).toBe(ALERT);
  });

  it('a drill paged at another moment shows nothing kept (the page keeps its sentence)', async () => {
    rememberDrillAlert(rig.phaseId, '2026-11-16T09:00:00.000Z', ALERT);
    rig.load.mockResolvedValue(phase(drill()));
    await open();
    expect(shown()).toBe('');
  });

  it('started here, the line is kept for the tab: the page opened again still shows it', async () => {
    rig.load.mockResolvedValueOnce(phase(null)).mockResolvedValue(phase(drill()));
    rig.start.mockResolvedValue({ ...drill(), beforeStderr: ALERT });
    await open();
    await act(async () => { fireEvent.click(host.querySelector('[data-testid="phase-deployment-drill-start"]')!); });
    expect(shown()).toBe(ALERT);
    act(() => root.unmount()); root = createRoot(host);
    await open();
    expect(shown()).toBe(ALERT);
  });
});

describe('no Brief or Back to the workspace in the drill document', () => {
  it('the document draws neither link; the frame\'s brief column holds the mission, and the page hands the header nothing', async () => {
    rig.load.mockResolvedValue(phase(drill()));
    await open();
    const content = host.querySelector('[data-testid="frame-content"]')!;
    expect(content.querySelector('[data-testid="open-brief"]')).toBeNull();
    expect(content.querySelector('[data-testid="back-workspace"]')).toBeNull();
    expect([...host.querySelectorAll('a')].map((a) => a.textContent)).not.toEqual(expect.arrayContaining(['Brief', 'Back to the workspace']));
    expect(host.querySelector('[data-testid="frame-brief"] [data-testid="mission-details"]')).not.toBeNull();
    // The header is handed the phase's "Open the workspace" and "Submit PR-5" (mounted in
    // versioned-document-pages.test.tsx); what this case pins is that the document repeats neither as "Brief" or
    // "Back to the workspace" (above).
    expect(rig.frame?.right).toBeDefined();
    // the drill's own controls are still drawn
    expect(content.querySelector('[data-testid="phase-deployment-drill-health"]')).not.toBeNull();
    expect(content.querySelector('[data-testid="drill-clock"]')).not.toBeNull();
  });
});

describe('before the drill the page says the card the workspace says', () => {
  it('mounted with no drill: "Incident drill" as its title, and the INCIDENT-1 card, Not started, in the workspace\'s words', async () => {
    // a teacher's own application, as the workspace's card in deployment-maintenance-panels: no Compose configuration named
    rig.load.mockResolvedValue({ ...phase(null), provenance: { application: null } });
    await open();
    expect(host.querySelector('[data-testid="drill-title"]')!.textContent).toBe('Incident drill');
    const content = (host.querySelector('[data-testid="frame-content"]')!.textContent ?? '').replace(/\s+/g, ' ');
    expect(DRILL_CARD_TITLE).toBe('INCIDENT-1');
    expect(DRILL_NOT_STARTED_CHIP).toBe('Not started');
    for (const words of [DRILL_CARD_TITLE, DRILL_CARD_PURPOSE, DRILL_NOT_STARTED_CHIP, `${DRILL_NOT_STARTED}${drillNotStartedBody(false)}`]) expect(content, words).toContain(words);
    expect(content).not.toContain('You have not been paged yet');
  });
});

/*
 * The header's Submit is `size="sm"` (HeaderSubmit), the workspace header's size, so "Open the
 * workspace" beside it on the row is too (and the reference solution's door, read in Details). At the default size the
 * row was two sizes: Submit 34 px, the door beside it about 40 px.
 */
describe('the header the drill page draws is one size', () => {
  it('Open the workspace and Submit PR-5, each sm', async () => {
    rig.load.mockResolvedValue(phase(drill()));
    await open();
    const drawn = [...host.querySelector('[data-testid="frame-header"]')!.querySelectorAll<HTMLElement>('a, button')];
    expect(drawn.map((one) => one.dataset.testid)).toEqual(expect.arrayContaining(['open-workspace', 'header-submit']));
    for (const one of drawn) expect(one.className, one.textContent ?? '').toContain('btn-sm');
  });
});

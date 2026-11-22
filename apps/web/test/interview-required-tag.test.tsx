// @vitest-environment jsdom
/**
 * "Stakeholder interview Required" on a Requirements phase the
 * learner has finished with.
 *
 * A finished project's Requirements room must not read "Required" beside the
 * interview tab, as if a demand were open. Once the phase is passed AND the
 * learner has continued past it (or completed the project), by the gate band's
 * own rule (`movedOnFrom`), the word and the description that names it are left
 * out; the tab keeps its name, id, place and address.
 *
 * Everything a learner in the middle of a project meets is pinned here: the
 * tabs' markup by a file snapshot; the room in progress; the room PASSED with
 * the learner still on it (between its Submit for review and its Continue); and that
 * same room in the moment after its own Continue, when the advance's answer has
 * already reached the shell's enrolment but the router has not yet left.
 *
 * The shell is the seam, as in signoff-chip-wiring: `useProject` answers the
 * enrolment (here from the provider's context, so an advance can replace it),
 * and `request` answers the room's own reads.
 */
import { act, useContext, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { getByRole } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR, EMPTY_STORY, STORY_JSON, serialiseStory } from '@learnsdlc/shared';
import { ProjectContext } from '@/lib/project-context';

const PHASE_ID = 'f38-requirements';
const rig = vi.hoisted(() => ({
  request: vi.fn(),
  fetch: vi.fn(),
  advance: vi.fn(),
  push: vi.fn(),
  setProject: null as null | ((next: unknown) => void),
  shellFor: null as null | ((enrollment: unknown) => unknown),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: 'f38-requirements' }),
  usePathname: () => '/workspace/f38-requirements/issue',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: rig.push, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/useProject', async (original) => ({
  ...(await original<typeof import('@/lib/useProject')>()),
  useProject: () => useContext(ProjectContext),
  useProjectMaybe: () => useContext(ProjectContext),
  // The merge's invalidation puts the advance's answer into the shell's enrolment, as the real one does.
  invalidateProject: (answered?: unknown) => {
    if (answered && rig.setProject && rig.shellFor) rig.setProject(rig.shellFor(answered));
  },
}));
vi.mock('@/lib/api', async (original) => {
  const real = await original<typeof import('@/lib/api')>();
  return { ...real, request: rig.request, api: { ...real.api, advance: rig.advance } };
});
vi.mock('@/lib/records', async (original) => ({
  ...(await original<typeof import('@/lib/records')>()),
  refreshPhaseRecords: () => {},
}));
vi.mock('@/lib/socket', () => ({ getSocket: () => null, useSocketPaused: () => false }));
vi.mock('@/components/workspace/mentor/useAgentWorkspace', () => ({ useAgentWorkspace: () => false }));
vi.mock('@/components/shell/PersonaPanel', async (original) => ({
  ...(await original<typeof import('@/components/shell/PersonaPanel')>()),
  PersonaPanel: () => null,
  MentorSession: () => null,
}));
vi.mock('@/components/Markdown', () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('@/lib/theme', () => ({ useTheme: () => ['paper'], THEME_EVENT: 'theme', THEME_KEY: 'theme' }));
// The save belongs to this sign-in, so the room's Continue guard can flush it (as in requirements-design-rooms).
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'f38-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
  getSession: () => ({ id: 'f38-learner', role: 'LEARNER', displayName: 'Learner', avatar: 0, cohort: 'default', profileVersion: 0 }),
}));

import { TOKEN_KEY } from '@/lib/session';
import { RequirementsTabs, RequirementsWorkspace } from '@/components/workspace/requirements/RequirementsWorkspace';
import { namedMarkup } from './support/markup-snapshot';

const noop = () => undefined;

describe('RequirementsTabs', () => {
  const tabs = (active: 'interview' | 'backlog', noInterview: boolean, movedOn?: boolean) =>
    renderToStaticMarkup(<RequirementsTabs base="/workspace/p" active={active} noInterview={noInterview} movedOn={movedOn} onKeyDown={noop} onSelect={noop} />);

  it('without the moved-on prop, and with it false, the tabs are the recorded markup', async () => {
    const now = { interview: tabs('interview', false), backlog: tabs('backlog', false), noInterview: tabs('backlog', true) };
    expect({ interview: tabs('interview', false, false), backlog: tabs('backlog', false, false), noInterview: tabs('backlog', true, false) }).toEqual(now);
    await expect(namedMarkup({ 'the interview tab open': now.interview, 'My backlog open': now.backlog, 'no interview': now.noInterview }))
      .toMatchFileSnapshot('__snapshots__/requirements-tabs.html');
  });

  it('moved on: no "Required" and no description naming it; the tab keeps its name, id, address and selection', () => {
    const host = document.createElement('div');
    host.innerHTML = tabs('backlog', false, true);
    expect(host.textContent).not.toContain('Required');
    expect(host.querySelector('#requirements-interview-required')).toBeNull();
    const tab = getByRole(host, 'tab', { name: 'Stakeholder interview' });
    expect(tab.id).toBe('requirements-interview-tab');
    expect(tab.getAttribute('aria-describedby')).toBeNull();
    expect(tab.getAttribute('href')).toBe('/workspace/p/interview');
    expect(tab.getAttribute('aria-selected')).toBe('false');
    expect(tab.getAttribute('aria-controls')).toBe('requirements-interview-panel');
    expect(getByRole(host, 'tab', { name: 'My backlog' }).getAttribute('aria-selected')).toBe('true');
  });
});

/* ------------------------------ the real room ------------------------------ */

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const STORY = serialiseStory({
  ...EMPTY_STORY,
  id: 'US-1',
  title: 'Overdue badge',
  persona: 'team member',
  capability: 'to see an overdue badge on tasks due before today',
  benefit: 'I can see which tasks need attention',
});
const OWN_REQUIREMENTS = {
  phaseKey: 'requirements', referenceName: null, rollup: 'own', intro: 'own', interview: 'own', files: [], tasks: [], roomTask: 'other',
} as unknown as PhaseProvenanceView;

function phaseDetail(status: 'in_progress' | 'passed'): PhaseDetail {
  const passed = status === 'passed';
  return {
    id: PHASE_ID, key: 'requirements', order: 1, title: 'Requirements', status,
    attempts: passed ? 1 : 0, bestScore: passed ? 100 : null, reflection: null, passedAt: passed ? '2026-11-18T09:10:00.000Z' : null, opensAt: null, dueAt: null,
    projectSlug: 'deadline-badge', intro: 'Write the story for the badge.', taskPanel: 'The brief.', objectives: [], artifactKind: 'story',
    files: [{ path: STORY_JSON, content: STORY, editable: true, language: 'json' }],
    story: { id: 'US-1', hints: {}, floor: DEFAULT_STORY_FLOOR, providedStories: [] },
    rubric: { passThreshold: 70, criteria: [{ key: 'c1', title: 'Story', description: '', weight: 1 }] },
    tasks: [{
      key: 'main', order: 1, required: true, title: 'Your story', artefactType: 'user-story', artefactPath: STORY_JSON,
      primaryPath: STORY_JSON, files: [STORY_JSON], evidence: 'reviewed', sealed: true,
      status, awaitingSignOff: false, attempts: passed ? 1 : 0, bestScore: passed ? 100 : null,
      passedAt: passed ? '2026-11-18T09:10:00.000Z' : null, lastSubmissionId: null, resetAt: null,
      solution: { available: false, files: 0, readAt: null },
    } as unknown as PhaseTaskView],
    taskCounts: { total: 1, required: 1, passed: passed ? 1 : 0, passedRequired: passed ? 1 : 0 },
    canRun: false, canPreview: false, runLabel: 'Run tests', links: [],
    lastSubmission: null,
    updatedAt: '2026-11-18T09:00:00.000Z', workspaceUpdatedAt: '2026-11-18T08:50:00.000Z',
    provenance: OWN_REQUIREMENTS,
    stakeholder: { name: 'Team Lead', role: 'Team Lead', greeting: 'Team Lead here.' },
    scenario: 'own',
  } as unknown as PhaseDetail;
}

function enrolment(detail: PhaseDetail, current: number, completed = false): EnrollmentView {
  const phases = KEYS.map((key, at) =>
    at === 0
      ? ({ ...detail, view: undefined } as unknown as PhaseSummary)
      : ({ id: `f38-${key}`, key, order: at + 1, title: key[0].toUpperCase() + key.slice(1), status: completed || at + 1 < current ? 'passed' : at + 1 === current ? 'in_progress' : 'locked', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, scenario: 'own' } as PhaseSummary),
  );
  return {
    id: 'f38-enrolment', projectSlug: 'deadline-badge', projectTitle: 'Deadline badge demo', currentPhaseOrder: current, completed,
    startedAt: '2026-11-18T08:00:00Z', completedAt: completed ? '2026-11-18T10:00:00Z' : null, projectIsDefault: false, phases,
  } as unknown as EnrollmentView;
}

let held: PhaseDetail;
function shellFor(enrollment: EnrollmentView) {
  return {
    enrollment, currentPhase: enrollment.phases.find((p) => p.order === enrollment.currentPhaseOrder), details: { [PHASE_ID]: held }, analytics: null,
    loading: false, revalidating: false, error: '', reload: () => Promise.resolve(), projects: [], enrolledSlugs: [], slug: 'deadline-badge', map: null,
  };
}
function Shell({ start, children }: { start: unknown; children: ReactNode }) {
  const [project, setProject] = useState(start);
  rig.setProject = setProject;
  return <ProjectContext.Provider value={project as never}>{children}</ProjectContext.Provider>;
}

let host: HTMLDivElement;
let root: Root;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(TOKEN_KEY, 'f38-learner-token');
  rig.request.mockReset();
  rig.fetch.mockReset();
  rig.advance.mockReset();
  rig.push.mockReset();
  rig.shellFor = shellFor as never;
  vi.stubGlobal('fetch', rig.fetch);
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});

async function mountRoom(status: 'in_progress' | 'passed', current: number, completed = false) {
  held = phaseDetail(status);
  rig.request.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === `/phases/${PHASE_ID}`) return held;
    if (path.includes('/submit')) throw new Error('a submit reached the API');
    if (path.includes('/interview')) return { persona: { name: 'Team Lead', role: 'Lead' }, opening: 'Ask me.', startedAt: null, turns: [], facts: [], factsExpected: 0, turnsLeft: 10, closedAt: null };
    return [];
  });
  rig.fetch.mockImplementation(async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(String(input).endsWith(`/phases/${PHASE_ID}`) ? held : []), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  await act(async () => { root.render(<Shell start={shellFor(enrolment(held, current, completed))}><RequirementsWorkspace phaseId={PHASE_ID} /></Shell>); });
  await act(async () => { await Promise.resolve(); });
}
const interviewTab = () => host.querySelector<HTMLElement>('#requirements-interview-tab')!;
const tag = () => host.querySelector<HTMLElement>('[data-testid="requirements-interview-required"]');
const band = () => host.querySelector<HTMLElement>('[data-testid="gate-banner"]');

describe('the Requirements room\'s interview tag', () => {
  it('in progress: "Required", described by it', async () => {
    await mountRoom('in_progress', 1);
    expect(tag()?.textContent).toBe('Required');
    expect(interviewTab().getAttribute('aria-describedby')).toBe('requirements-interview-required');
  });

  it('passed with the learner still on the phase (between its Submit and its Continue): "Required"', async () => {
    await mountRoom('passed', 1);
    expect(band()?.textContent).toContain('Ready to continue.');
    expect(tag()?.textContent).toBe('Required');
    expect(interviewTab().getAttribute('aria-describedby')).toBe('requirements-interview-required');
  });

  it('passed and the learner has continued past it: no "Required"; the tab keeps its name, id and address', async () => {
    await mountRoom('passed', 3);
    expect(band()?.getAttribute('data-gate')).toBe('moved-on');
    expect(tag()).toBeNull();
    expect(host.querySelector('.requirements-tabs')!.textContent).not.toContain('Required');
    const tab = getByRole(host, 'tab', { name: 'Stakeholder interview' });
    expect(tab).toBe(interviewTab());
    expect(tab.getAttribute('aria-describedby')).toBeNull();
    expect(tab.getAttribute('href')).toBe(`/workspace/${PHASE_ID}/interview`);
  });

  it('a completed project: no "Required"', async () => {
    await mountRoom('passed', 6, true);
    expect(tag()).toBeNull();
  });

  it('the moment after this room\'s own Continue: the advance has reached the enrolment, the router has not left, and the tag is still "Required"', async () => {
    rig.advance.mockImplementation(async () => enrolment(held, 2));
    await mountRoom('passed', 1);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(rig.advance).toHaveBeenCalledWith(PHASE_ID);
    expect(rig.push).toHaveBeenCalled();
    expect(tag()?.textContent).toBe('Required');
    expect(band()?.getAttribute('data-gate')).toBeNull();
    expect(band()?.textContent).toContain('Ready to continue.');
  });

  /*
   * The room's hold and the band's agree. A Continue that did not go ahead (here the advance
   * failed) lets both go, so when the learner then continues in another tab, the band says "moved on" and the tab
   * drops its "Required" together.
   */
  it('a Continue that failed lets the room\'s hold go with the band\'s: a later move elsewhere drops "Required" with the band', async () => {
    rig.advance.mockRejectedValue(new Error('The phase could not be merged.'));
    await mountRoom('passed', 1);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]')!.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(rig.advance).toHaveBeenCalledWith(PHASE_ID);
    expect(tag()?.textContent).toBe('Required');
    expect(band()?.getAttribute('data-gate')).toBeNull();
    // the learner continues in another tab, and this one reads the enrolment again
    await act(async () => { rig.setProject?.(shellFor(enrolment(held, 2))); });
    expect(band()?.getAttribute('data-gate')).toBe('moved-on');
    expect(tag()).toBeNull();
  });
});

/*
 * The backlog's footer under the "moved on" band: Check the story and Submit again. On a phase the learner has left
 * they are quiet (ghost), same names and ids. A learner still on Requirements, up to their Continue, sees them as
 * framed buttons. On a completed project Submit again is still offered: a retry after completion needs a Submit
 * after it.
 */
describe('the Requirements footer on a phase the learner has left', () => {
  const check = () => host.querySelector<HTMLElement>('[data-testid="phase-requirements-render"]');
  const submit = () => host.querySelector<HTMLElement>('[data-testid="phase-requirements-submit"]');

  it('in progress, and passed with the learner still on the phase, the footer keeps Check secondary and Submit framed', async () => {
    await mountRoom('in_progress', 1);
    expect(check()!.className).toContain('btn-secondary');
    expect(submit()!.className).not.toContain('btn-ghost');
    await mountRoom('passed', 1);
    expect(check()!.className).toContain('btn-secondary');
    expect(submit()!.className).not.toContain('btn-ghost');
  });

  it('moved on: both quiet (ghost), with their names and ids', async () => {
    await mountRoom('passed', 3);
    expect(check()!.className).toContain('btn-ghost');
    expect(check()!.textContent).toContain('Check the story');
    expect(submit()!.className).toContain('btn-ghost');
    expect(submit()!.textContent).toContain('Submit again');
  });

  it('a completed project: Submit again is still offered (quiet, pressable), as is Check the story', async () => {
    await mountRoom('passed', 6, true);
    expect(submit()!.textContent).toContain('Submit again');
    expect(submit()!.className).toContain('btn-ghost');
    expect((submit() as HTMLButtonElement).disabled).toBe(false);
    expect(check()!.className).toContain('btn-ghost');
  });
});

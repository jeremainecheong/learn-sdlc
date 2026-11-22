// @vitest-environment jsdom
/**
 * One entrance to a phase.
 *
 * Every door opens the phase's room in one step, on a first visit as on a
 * return; the case file's words (the mission, what the phase produces, the
 * review criteria, the phase guide) are read in the room's brief panel under
 * "Mission and review criteria"; the case file page still answers its address
 * and leads into the workspace.
 *
 * Opening a phase has no server-side start to repeat on entry:
 * entering asks nothing of the server and writes nothing to the tab, and the
 * case file page's button makes no request either.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseSummary } from '@learnsdlc/shared';

const rig = vi.hoisted(() => ({
  push: vi.fn(),
  phaseId: 'p3',
  project: null as unknown,
  // Every call the page makes to the API client, by method name.
  calls: [] as string[],
  // The breadcrumbs the case file page hands its frame.
  crumbs: [] as { label: string; href?: string }[],
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/workspace/PhaseDocumentFrame', () => ({ PhaseDocumentFrame: ({ children, crumbs }: { children: ReactNode; crumbs: { label: string; href?: string }[] }) => { rig.crumbs = crumbs; return <>{children}</>; } }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: rig.phaseId }),
  usePathname: () => `/workspace/${rig.phaseId}/brief`,
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: rig.push, replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => rig.project, useProjectMaybe: () => rig.project }));
vi.mock('@/lib/api', () => ({
  // Any method the page reaches for is recorded, so "no request" is a fact the test can read.
  api: new Proxy({}, { get: (_target, name) => (...args: unknown[]) => { rig.calls.push(String(name)); void args; return Promise.resolve(null); } }),
  describeError: (error: Error) => error.message,
  onSessionLeaving: () => () => {},
  onSignOut: () => () => {},
}));

import BriefPage from '@/app/(app)/workspace/[phaseId]/brief/page';
import { MissionDetails } from '@/components/phases/Brief';
import { PHASE_SPEC } from '@/components/phases/spec';
import { phaseDoorHref, doorWithTasks } from '@/components/shell/routes';
import { navigationItems, phaseItems } from '@/components/shell/navigation';
import { mapNodeDoor } from '@/components/map/door';
import { settle } from './support/dom';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const ROOM: Record<PhaseKey, string> = {
  requirements: '/workspace/p1/interview',
  design: '/workspace/p2/design',
  implementation: '/workspace/p3',
  testing: '/workspace/p4',
  deployment: '/workspace/p5',
  maintenance: '/workspace/p6/change',
};
const summary = (key: PhaseKey, over: Partial<PhaseSummary> = {}): PhaseSummary => {
  const order = KEYS.indexOf(key) + 1;
  return { id: `p${order}`, key, order, title: key[0].toUpperCase() + key.slice(1), status: 'in_progress', attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, ...over } as PhaseSummary;
};
const detail = (key: PhaseKey, over: Partial<PhaseDetail> = {}): PhaseDetail =>
  ({
    ...summary(key),
    intro: 'The application runs except for one marked gap.\n\nFill it, then run the tests.',
    objectives: ['Read the contract', 'Fill the marked gap'],
    files: [
      { path: 'api/overdue.py', content: '', editable: true, language: 'python' },
      { path: 'api/models.py', content: '', editable: false, language: 'python' },
    ],
    tasks: [],
    rubric: { passThreshold: 70, criteria: [{ key: 'gap', title: 'The gap is filled', weight: 1, description: 'The failing test passes.' }] },
    ...over,
  }) as unknown as PhaseDetail;
const enrollment = (phases: PhaseSummary[]): EnrollmentView =>
  ({ id: 'enrolment-1', projectTitle: 'TaskTrackr', projectSlug: 'tasktrackr', projectIsDefault: true, currentPhaseOrder: 3, completed: false, phases, releases: [] }) as unknown as EnrollmentView;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  rig.calls = [];
  window.sessionStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('phase-entry › every way into a phase opens its room in one step', () => {
  const fresh = KEYS.map((key) => summary(key));

  it('the door, the sidebar, the phase list and the map open the room on a first visit (no submission, nothing in the tab)', () => {
    for (const phase of fresh) {
      expect(phaseDoorHref(phase), phase.key).toBe(ROOM[phase.key]);
      // The sidebar's "My project" row.
      expect(navigationItems('LEARNER', phase).find((row) => row.label === 'My project')?.href, phase.key).toBe(ROOM[phase.key]);
      // The map's block for the phase.
      expect(mapNodeDoor({ phase: phase.key, phaseId: phase.id } as never, enrollment(fresh), {}), phase.key).toBe(ROOM[phase.key]);
    }
    // The palette's and the phases page's rows.
    expect(phaseItems(fresh).map((row) => row.href)).toEqual(KEYS.map((key) => ROOM[key]));
  });

  it('a return visit, a new tab, a reviewed phase and a passed phase open the same room', () => {
    for (const key of KEYS) {
      const first = phaseDoorHref(summary(key));
      expect(phaseDoorHref(summary(key, { attempts: 2 })), key).toBe(first);
      expect(phaseDoorHref(summary(key, { attempts: 1, status: 'passed' })), key).toBe(first);
      // Credited without a submission: still the room, never the case file.
      expect(phaseDoorHref(summary(key, { attempts: 0, status: 'passed' })), key).toBe(first);
    }
  });

  it('a locked phase still has no door', () => {
    for (const key of KEYS) expect(phaseDoorHref(summary(key, { status: 'locked' }))).toBe('/phases');
  });

  it('entering writes nothing to the tab, so there is nothing to repeat on a return', () => {
    for (const phase of fresh) phaseDoorHref(doorWithTasks(phase, {}));
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('phase-entry › the case file page still answers its address', () => {
  const useScenario = () => {
    const phases = KEYS.map((key) => summary(key));
    rig.project = {
      enrollment: enrollment(phases),
      currentPhase: phases[2],
      details: { p3: detail('implementation') },
      analytics: null,
      loading: false,
      revalidating: false,
      error: '',
      reload: () => Promise.resolve(),
    };
  };

  it('draws the case file and one way into the workspace: Go to the workspace, no Begin', async () => {
    useScenario();
    await act(async () => root.render(<BriefPage />));
    await settle(10);
    expect(host.querySelector('[data-testid="brief"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="begin-phase"]')).toBeNull();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="go-to-workspace"]');
    expect(button?.textContent).toBe('Go to the workspace');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'Begin')).toBe(false);
    act(() => button!.click());
    expect(rig.push).toHaveBeenCalledTimes(1);
    expect(rig.push).toHaveBeenCalledWith('/workspace/p3');
  });

  it('pressing it asks nothing of the server and writes nothing to the tab (Begin never did either)', async () => {
    useScenario();
    await act(async () => root.render(<BriefPage />));
    await settle(10);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="go-to-workspace"]')!.click());
    await settle(10);
    // The detail was held, so the page made no read of its own; the press made no request at all.
    expect(rig.calls).toEqual([]);
    expect(window.sessionStorage.length).toBe(0);
  });
});

/**
 * The case file page's breadcrumb leaf is the
 * working-area row's word for it. Requirements' and Design's rows name the
 * page "Case file"; the code phases' rows have no entry for it, so it stays
 * "Brief" there.
 */
describe('phase-entry › the case file page’s breadcrumbs', () => {
  for (const [key, id, leaf] of [['requirements', 'p1', 'Case file'], ['design', 'p2', 'Case file'], ['implementation', 'p3', 'Brief']] as const) {
    it(`${key}: TaskTrackr › ${key[0].toUpperCase()}${key.slice(1)} › ${leaf}`, async () => {
      const phases = KEYS.map((one) => summary(one));
      rig.phaseId = id;
      rig.project = { enrollment: enrollment(phases), currentPhase: phases[KEYS.indexOf(key)], details: { [id]: detail(key) }, analytics: null, loading: false, revalidating: false, error: '', reload: () => Promise.resolve() };
      try {
        await act(async () => root.render(<BriefPage />));
        await settle(10);
        expect(rig.crumbs.map((crumb) => [crumb.label, crumb.href])).toEqual([
          ['TaskTrackr', '/dashboard'],
          [`${key[0].toUpperCase()}${key.slice(1)}`, `/phases?phase=${key}`],
          [leaf, undefined],
        ]);
      } finally { rig.phaseId = 'p3'; }
    });
  }
});

describe('phase-entry › the mission is read inside the workspace', () => {
  const draw = (node: ReactNode) => act(() => root.render(<>{node}</>));

  it('folds the case file under one named control: the mission, what the phase produces and the review criteria', () => {
    draw(<MissionDetails phase={{ key: 'implementation' }} detail={detail('implementation')} lessons />);
    const fold = host.querySelector<HTMLDetailsElement>('details[data-testid="phase-mission"]');
    expect(fold).not.toBeNull();
    // Folded: it adds one line to the panel, not a page.
    expect(fold!.open).toBe(false);
    expect(fold!.querySelector('summary')?.textContent).toBe('Mission and review criteria');
    const mission = host.querySelector('[data-testid="phase-mission-mission"]')!.textContent;
    expect(mission).toContain('Your mission');
    expect(mission).toContain(PHASE_SPEC.implementation.purpose);
    expect(mission).toContain('The application runs except for one marked gap.');
    expect(mission).toContain('Fill it, then run the tests.');
    expect([...host.querySelectorAll('[data-testid="phase-mission-mission"] li')].map((li) => li.textContent)).toEqual(['Read the contract', 'Fill the marked gap']);
    expect(host.querySelector('[data-testid="phase-mission-mission"] a')?.getAttribute('href')).toBe('/learn/implementation');
    // What the phase produces: the editable files only.
    const produce = host.querySelector('[data-testid="phase-mission-produce"]')!.textContent;
    expect(produce).toContain('What you will produce');
    expect(produce).toContain('api/overdue.py');
    expect(produce).not.toContain('api/models.py');
    const review = host.querySelector('[data-testid="phase-mission-review"]')!.textContent;
    expect(review).toContain('Review criteria');
    expect(review).toContain('Pass or Needs revision');
    expect(review).toContain('The gap is filled');
    expect(review).toContain('The failing test passes.');
    // No Begin anywhere in it.
    expect(host.textContent).not.toMatch(/\bBegin\b/);
  });

  it('offers no phase guide where the project offers none (a teacher\'s own phase)', () => {
    draw(<MissionDetails phase={{ key: 'implementation' }} detail={detail('implementation')} lessons={false} />);
    expect(host.querySelector('[data-testid="phase-mission"] a')).toBeNull();
    expect(host.querySelector('[data-testid="phase-mission"]')).not.toBeNull();
  });

  it('draws nothing before the detail has arrived, and survives a partial one', () => {
    draw(<MissionDetails phase={{ key: 'design' }} detail={null} lessons />);
    expect(host.querySelector('[data-testid="phase-mission"]')).toBeNull();
    draw(<MissionDetails phase={{ key: 'design' }} detail={{ id: 'p2', key: 'design' } as unknown as PhaseDetail} lessons={false} />);
    expect(host.querySelector('[data-testid="phase-mission"] summary')?.textContent).toBe('Mission and review criteria');
    expect(host.querySelector('[data-testid="phase-mission-produce"]')).toBeNull();
  });
});

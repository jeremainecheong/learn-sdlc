// @vitest-environment jsdom
/**
 * The project map on the learner's home and on its own page.
 *
 * Home draws "Your project map" between the project's own line and the phase
 * list: the folded map the project loader holds, a skeleton while nothing is
 * in hand to draw from, an empty state for a project with no phases, nothing
 * on a completed project whose map would be empty, and a link to the full
 * map. `/map` draws the whole unfolded map instead of redirecting, with its
 * own skeleton, empty and error states. Selecting a block on either opens the
 * door of the block's phase. The drawing answers what it is pointed at, and
 * a block whose state changed settles once.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, ProjectMapData } from '@learnsdlc/shared';

const routed = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), back: vi.fn() },
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routed.router,
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// The map page reads the project and the map cache; both are seams here.
const seams = vi.hoisted(() => ({
  project: null as null | Record<string, unknown>,
  held: null as ProjectMapData | null,
  load: vi.fn(),
}));
vi.mock('@/lib/useProject', () => ({ useProject: () => seams.project }));
vi.mock('@/lib/project-map', async (original) => ({
  ...(await original<typeof import('@/lib/project-map')>()),
  useProjectMap: () => seams.held,
  loadMap: (...args: unknown[]) => seams.load(...args),
}));

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];
const TITLES = ['Requirements', 'Design', 'Implementation', 'Testing', 'Deployment', 'Maintenance'];

function enrollmentOf(count = 6): EnrollmentView {
  return {
    id: 'enrol-1',
    projectSlug: 'room-desk',
    projectTitle: 'RoomDesk — book a meeting room',
    currentPhaseOrder: 3,
    completed: false,
    startedAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    phases: KEYS.slice(0, count).map((key, i) => ({
      id: `phase-${key}`,
      key,
      order: i + 1,
      title: TITLES[i],
      status: i < 2 ? 'passed' : i === 2 ? 'in_progress' : 'locked',
      bestScore: i < 2 ? 90 : null,
      attempts: i < 3 ? 1 : 0,
      reflection: null,
      passedAt: null,
      opensAt: null,
      dueAt: null,
    })),
  } as unknown as EnrollmentView;
}

/** A small folded map: a story, a contract, a function, a test, two locked placeholders. */
function mapOf(storyState: 'done' | 'warn' = 'done'): ProjectMapData {
  return {
    nodes: [
      { id: 'US-1', phase: 'requirements', kind: 'story', label: 'Book a room for a meeting', state: storyState, phaseId: 'phase-requirements' },
      { id: 'POST /bookings', phase: 'design', kind: 'operation', label: 'POST /bookings', state: 'done', phaseId: 'phase-design', mono: true },
      { id: 'create_booking', phase: 'implementation', kind: 'function', label: 'create_booking()', state: 'now', phaseId: 'phase-implementation', mono: true },
      { id: 'test_create', phase: 'testing', kind: 'test', label: 'create books a room', state: 'pass', phaseId: 'phase-implementation' },
      { id: 'locked-deployment', phase: 'deployment', kind: 'placeholder', label: 'Opens in phase 5', state: 'todo', phaseId: 'phase-deployment' },
      { id: 'locked-maintenance', phase: 'maintenance', kind: 'placeholder', label: 'Opens in phase 6', state: 'todo', phaseId: 'phase-maintenance' },
    ],
    edges: [
      { from: 'US-1', to: 'POST /bookings', kind: 'trace' },
      { from: 'POST /bookings', to: 'create_booking', kind: 'trace' },
      { from: 'create_booking', to: 'test_create', kind: 'trace' },
    ],
  } as unknown as ProjectMapData;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  routed.router.push.mockReset();
  seams.project = null;
  seams.held = null;
  seams.load.mockReset();
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

describe('Home: your project map', () => {
  async function home(props: Partial<Parameters<typeof import('@/components/home/HomeProjectMap').HomeProjectMap>[0]> = {}) {
    const { HomeProjectMap } = await import('@/components/home/HomeProjectMap');
    await render(
      <HomeProjectMap
        enrollment={enrollmentOf()}
        details={{}}
        map={mapOf()}
        pending={false}
        done={false}
        {...props}
      />,
    );
  }

  it('draws the folded map the project holds, with its figures, its legend and the link to the full map', async () => {
    await home();
    const section = q('home-project-map');
    expect(section).not.toBeNull();
    expect(section?.querySelector('h2')?.textContent).toBe('Your project map');
    expect(section?.textContent).toContain('for RoomDesk');
    expect(q('map-svg')).not.toBeNull();
    expect(q('map-node-US-1')).not.toBeNull();
    expect(host.querySelector('[aria-label="Map legend"]')).not.toBeNull();
    // Four blocks of work (the two placeholders are not work), three lines, three phases open.
    const figures = q('map-figures')?.textContent ?? '';
    expect(figures).toContain('4 blocks of your work');
    expect(figures).toContain('3 lines between them');
    expect(figures).toContain('3 of 6 phases open');
    const open = q('home-project-map-open');
    expect(open?.getAttribute('href')).toBe('/map');
    expect(open?.textContent).toContain('Open the full map');
  });

  it('opens the door of the phase a block was drawn from', async () => {
    await home();
    const node = q('map-node-create_booking') as SVGGElement;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(routed.router.push).toHaveBeenCalledWith('/workspace/phase-implementation');
    // A locked phase's placeholder opens the locked phase's door: progress.
    await act(async () => {
      (q('map-node-locked-deployment') as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(routed.router.push).toHaveBeenLastCalledWith('/phases');
  });

  it('draws a skeleton, not an empty map, while nothing is in hand to draw from', async () => {
    await home({ map: null, pending: true });
    expect(q('home-project-map-loading')).not.toBeNull();
    expect(q('home-project-map-loading')?.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(q('map-svg')).toBeNull();
    // The link to the full map stays: the header is drawn while the body loads.
    expect(q('home-project-map-open')).not.toBeNull();
  });

  it('draws from the enrolment itself when the project holds no map and nothing is on its way', async () => {
    await home({ map: null, pending: false });
    expect(q('home-project-map-loading')).toBeNull();
    // The same builder draws the locked phases as placeholders.
    expect(q('map-svg')).not.toBeNull();
    expect(host.querySelectorAll('[data-node]').length).toBeGreaterThan(0);
  });

  it('still draws when a phase summary lacks a part the builder reads', async () => {
    // A summary carries no brief; a maintenance phase without its task panel
    // would make the builder throw, and Home must not go down with it.
    const thin = { 'phase-maintenance': { id: 'phase-maintenance', key: 'maintenance', files: [] } } as unknown as Record<string, PhaseDetail>;
    await home({ map: null, pending: false, details: thin });
    expect(q('home-project-map')).not.toBeNull();
    expect(q('map-svg')).not.toBeNull();
  });

  it('says what to expect on a project with no phases yet', async () => {
    await home({ enrollment: enrollmentOf(0), map: { nodes: [], edges: [] } as unknown as ProjectMapData });
    const empty = q('home-project-map-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('This project has no phases yet.');
    expect(q('map-svg')).toBeNull();
  });

  it('is left off a completed project only when its map would be empty', async () => {
    await home({ enrollment: enrollmentOf(0), map: { nodes: [], edges: [] } as unknown as ProjectMapData, done: true });
    expect(q('home-project-map')).toBeNull();
    await home({ done: true });
    expect(q('home-project-map')).not.toBeNull();
  });

  // Its place on the dashboard, between the project line and the phase path, and the map the loader
  // holds being handed to it, are asserted on the rendered dashboard in `phase-progress-tasks.test.tsx`.
});

describe('the map page', () => {
  async function page() {
    const { default: MapPage } = await import('@/app/(app)/map/page');
    await render(<MapPage />);
  }
  const projectWith = (over: Record<string, unknown> = {}) => ({
    enrollment: enrollmentOf(),
    details: {} as Record<string, PhaseDetail>,
    slug: 'room-desk',
    loading: false,
    ...over,
  });

  it('draws the whole map full size instead of redirecting, under its title and purpose line', async () => {
    seams.project = projectWith();
    seams.held = mapOf();
    seams.load.mockResolvedValue(mapOf());
    await page();
    expect(q('project-map-page')).not.toBeNull();
    expect(q('map-title')?.textContent).toBe('Project map');
    expect(q('project-map-page')?.textContent).toContain('one lane per phase');
    expect(q('map-svg')).not.toBeNull();
    // It asks for the unfolded map, the shape the palette reads.
    expect(seams.load).toHaveBeenCalledWith('room-desk', { compact: false, showLocked: true });
    await act(async () => {
      (q('map-node-POST /bookings') as SVGGElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The same door the rest of the product opens for the phase: Design's room.
    const { phaseDoorHref } = await import('@/components/shell/routes');
    const design = enrollmentOf().phases[1];
    expect(routed.router.push).toHaveBeenCalledWith(phaseDoorHref(design));
    expect(phaseDoorHref(design)).toBe('/workspace/phase-design/design');
  });

  it('draws the skeleton while the map is on its way', async () => {
    seams.project = projectWith();
    seams.load.mockReturnValue(new Promise(() => {}));
    await page();
    expect(q('project-map-loading')).not.toBeNull();
    expect(q('map-svg')).toBeNull();
  });

  it('says the map could not be loaded, and asks again on Try again', async () => {
    seams.project = projectWith();
    seams.load.mockResolvedValue({ nodes: [], edges: [] });
    await page();
    const error = q('project-map-error');
    expect(error?.textContent).toContain('The map could not be loaded.');
    seams.load.mockResolvedValue(mapOf());
    const retry = Array.from(error?.querySelectorAll('button') ?? []).find((b) => b.textContent?.includes('Try again'));
    await act(async () => {
      retry?.click();
    });
    expect(seams.load).toHaveBeenLastCalledWith('room-desk', { compact: false, showLocked: true }, true);
    expect(q('project-map-error')).toBeNull();
    expect(q('map-svg')).not.toBeNull();
  });

  // A learner with no project sees the product's one start panel, the one
  // /artefacts and /progress draw, rather than a page of its own.
  const noProject = (over: Record<string, unknown> = {}) =>
    projectWith({
      enrollment: null,
      projects: [],
      start: vi.fn(),
      enrolling: null,
      error: null,
      reload: vi.fn(),
      revalidating: false,
      ...over,
    });

  it('offers a learner with no project the shared start panel', async () => {
    seams.project = noProject();
    await page();
    const panel = host.querySelector('section.exp-hero');
    expect(panel?.textContent).toContain('Your next chapter starts here.');
    expect(Array.from(panel?.querySelectorAll('button') ?? []).some((b) => b.textContent?.includes('Start Requirements'))).toBe(true);
    expect(q('project-map-empty')).toBeNull();
    expect(seams.load).not.toHaveBeenCalled();
  });

  it('says why a project could not be loaded and offers a retry, rather than claiming there is none', async () => {
    const reload = vi.fn();
    seams.project = noProject({ error: 'The project could not be loaded.', reload });
    await page();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The project could not be loaded.');
    const retry = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('Retry project'));
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    expect(reload).toHaveBeenCalled();
    expect(host.querySelector('section.exp-hero')).toBeNull();
    expect(seams.load).not.toHaveBeenCalled();
  });
});

describe('the drawing answers what it is pointed at', () => {
  async function map(data: ProjectMapData) {
    const { ProjectMap } = await import('@/components/map/ProjectMap');
    await render(<ProjectMap enrollment={enrollmentOf()} details={{}} data={data} compact fullTitles />);
  }
  const accentPaths = () =>
    Array.from(host.querySelectorAll('path.pm-edge')).filter((p) => p.getAttribute('stroke') === 'rgb(var(--c-accent))');

  it('lights a block’s own lines when the pointer is on it, and lets go when it leaves', async () => {
    await map(mapOf());
    expect(accentPaths()).toHaveLength(0);
    const node = q('map-node-POST /bookings') as SVGGElement;
    await act(async () => {
      node.dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    expect(accentPaths()).toHaveLength(2);
    await act(async () => {
      q('map-svg')?.dispatchEvent(new Event('pointerout', { bubbles: true }));
      q('map-svg')?.dispatchEvent(new Event('pointerleave', { bubbles: false }));
    });
    expect(accentPaths()).toHaveLength(0);
  });

  it('outlines a pointed-at lane and tints only its header band in its phase', async () => {
    await map(mapOf());
    const lane = host.querySelector('[data-col="0"] rect.pm-lane') as SVGRectElement;
    const fill = lane.getAttribute('fill');
    expect(fill).not.toBe('rgb(var(--tint-requirements))');
    expect(lane.getAttribute('stroke')).toBe('none');
    expect(host.querySelector('.pm-lane-band')).toBeNull();
    await act(async () => {
      lane.dispatchEvent(new Event('pointerover', { bubbles: true }));
    });
    // The lane keeps its own ground: no tint behind the drawing's text.
    expect(lane.getAttribute('fill')).toBe(fill);
    expect(lane.getAttribute('stroke')).toBe('rgb(var(--c-edge2))');
    const band = host.querySelector('[data-col="0"] rect.pm-lane-band');
    expect(band?.getAttribute('fill')).toBe('rgb(var(--tint-requirements))');
    expect(Number(band?.getAttribute('height'))).toBeLessThan(Number(lane.getAttribute('height')));
    expect(host.querySelectorAll('.pm-lane-band')).toHaveLength(1);
  });

  it('draws its own focus ring on every block and counts each lane’s work in the mono face', async () => {
    await map(mapOf());
    expect(host.querySelectorAll('.pm-node .pm-ring').length).toBe(host.querySelectorAll('.pm-node').length);
    const counts = Array.from(host.querySelectorAll('text.font-mono')).filter((t) => /^\d+$/.test(t.textContent ?? ''));
    expect(counts.length).toBeGreaterThan(0);
  });

  it('settles a block whose state changed, and nothing on the first drawing', async () => {
    await map(mapOf('done'));
    expect(host.querySelector('.pm-settle')).toBeNull();
    await map(mapOf('warn'));
    const settled = host.querySelectorAll('.pm-settle');
    expect(settled).toHaveLength(1);
    expect(settled[0].closest('[data-node]')?.getAttribute('data-node')).toBe('US-1');
  });
});

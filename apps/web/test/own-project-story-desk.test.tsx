// @vitest-environment jsdom
/**
 * The learner web on an uploaded (own) project.
 *
 * 1. The story desk on an own Requirements room names no 'US-4'. The id is
 *    `EMPTY_STORY.id`, the reference story's default (shared); the
 *    desk shows the learner's own id only where it differs from it.
 * 2. 'My project' and 'Continue my project' open an interview-less phase's
 *    Requirements room, not its `/interview` route, where the held detail's
 *    provenance says the phase holds no interview; the dashboard's empty
 *    review line says where such a project starts.
 * 3. The first-entry tour reads the provenance of the phase the
 *    room registers, so an own application's tour skips the reference steps
 *    even while the shell's details map does not hold the phase yet.
 * 4. No learner surface reads `referenceName`.
 *
 * Each item also checks that TaskTrackr renders exactly as recorded. The story desk's
 * renders are held in `__snapshots__/tasktrackr-story-desk.html`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseKey, PhaseProvenanceView, PhaseSummary } from '@learnsdlc/shared';
import { DEFAULT_STORY_FLOOR } from '@learnsdlc/shared';

const mount = vi.hoisted(() => ({ phaseId: 'w3b-phase-0', project: null as unknown }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ phaseId: mount.phaseId }),
  usePathname: () => `/workspace/${mount.phaseId}`,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, prefetch: () => {} }),
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
  useProject: () => mount.project,
  useProjectMaybe: () => mount.project,
}));
vi.mock('@/lib/session', async (original) => ({
  ...(await original<typeof import('@/lib/session')>()),
  useSession: () => ({ id: 'w3b-learner', role: 'LEARNER', displayName: 'Ada Example' }),
}));
vi.mock('@/lib/view-as', async (original) => ({
  ...(await original<typeof import('@/lib/view-as')>()),
  useViewAs: () => null,
}));
vi.mock('@/components/AppShell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/experience/shared', async (original) => ({
  ...(await original<typeof import('@/components/experience/shared')>()),
  useReviews: () => ({ reviews: [], loading: false, refreshing: false, error: '', refreshError: '', refresh: () => undefined }),
}));

import { IssueDesk } from '@/components/workspace/panels/requirements/IssueDesk';
import { EMPTY_STORY, type Story } from '@/components/workspace/panels/requirements/story';
import { useStoryFrom } from '@/components/workspace/panels/requirements/useStory';
import { doorWithTasks, phaseDoorHref, phaseWorkHref, roomHref } from '@/components/shell/routes';
import { navigationItems } from '@/components/shell/navigation';
import { phaseTutorialMarks } from '@/components/shell/tours';
import { usePhaseTutorialReady } from '@/components/shell/PhaseTutorial';
import Layout from '@/app/(app)/workspace/[phaseId]/layout';
import DashboardPage from '@/app/(app)/dashboard/page';
import { namedMarkup } from './support/markup-snapshot';

const KEYS: PhaseKey[] = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'];

/** The Shelf fixture's Requirements: the shelf pack's settled stories, and SH-5 the learner's. */
const SHELF_SPEC = {
  id: 'SH-5', hints: {}, floor: DEFAULT_STORY_FLOOR,
  providedStories: [
    { id: 'SH-1', title: 'Browse the shelf', persona: 'member', capability: 'to see every book in shelf order', benefit: 'I can find one without asking' },
    { id: 'SH-2', title: 'Lend a book', persona: 'librarian', capability: 'to record who has borrowed a book', benefit: 'I know where it is' },
  ],
};
const TASKTRACKR_SPEC = {
  id: 'US-4', hints: {}, floor: DEFAULT_STORY_FLOOR,
  providedStories: [
    { id: 'US-1', title: 'Create a task', persona: 'team member', capability: 'to create a task', benefit: 'nothing is forgotten' },
    { id: 'US-2', title: 'Complete a task', persona: 'team member', capability: 'to complete a task', benefit: 'the list stays current' },
  ],
};

function provenance(key: PhaseKey, over: Partial<PhaseProvenanceView> = {}): PhaseProvenanceView {
  return { phaseKey: key, referenceName: 'TaskTrackr', rollup: 'reference', intro: 'reference', interview: 'reference', files: [], tasks: [], roomTask: 'reference', ...over };
}
// `referenceName` is null on an own phase (the roll-up rule).
const OWN_REQUIREMENTS = () => provenance('requirements', { referenceName: null, rollup: 'own', intro: 'own', interview: null, roomTask: 'other' });

function summary(key: PhaseKey, scenario: PhaseSummary['scenario'], extra: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    id: `w3b-${key}`, key, order: KEYS.indexOf(key) + 1, title: key[0].toUpperCase() + key.slice(1), status: key === 'requirements' ? 'in_progress' : 'locked',
    attempts: 0, bestScore: null, reflection: null, passedAt: null, opensAt: null, dueAt: null, ...(scenario ? { scenario } : {}), ...extra,
  } as PhaseSummary;
}
function enrollment(title: string, scenario: PhaseSummary['scenario'], projectIsDefault: boolean): EnrollmentView {
  return {
    id: 'w3b-enrolment', projectSlug: projectIsDefault ? 'reference-slug' : 'shelf', projectTitle: `${title} — a project`, currentPhaseOrder: 1, completed: false,
    startedAt: '2026-10-02T00:00:00Z', completedAt: null, projectIsDefault, phases: KEYS.map((key) => summary(key, scenario)),
  } as unknown as EnrollmentView;
}
function heldDetail(key: PhaseKey, over: Record<string, unknown> = {}): PhaseDetail {
  return { ...summary(key, undefined), view: 'summary', intro: '', objectives: [], files: [], tasks: [], rubric: { passThreshold: 70, criteria: [] }, ...over } as unknown as PhaseDetail;
}
function shellState(enrol: EnrollmentView | null, details: PhaseDetail[] = []) {
  const held = Object.fromEntries(details.map((one) => [one.id, one]));
  return {
    enrollment: enrol, currentPhase: enrol?.phases[0] ?? null, details: held, loading: false, revalidating: false, error: '', analytics: null,
    reload: () => Promise.resolve(),
  };
}
const SHELF = () => enrollment('Shelf', 'own', false);
const TASKTRACKR = () => enrollment('TaskTrackr', 'reference', true);

let host: HTMLDivElement;
let root: Root;
const realShow = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  mount.project = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  HTMLDialogElement.prototype.showModal = realShow;
  HTMLDialogElement.prototype.close = realClose;
});
const render = (node: ReactNode) => act(() => root.render(<>{node}</>));
const click = (pattern: RegExp) => {
  const button = Array.from(host.querySelectorAll('button')).find((one) => pattern.test(one.textContent ?? ''));
  expect(button, String(pattern)).toBeDefined();
  act(() => button!.click());
};

/* ------------------------------------------------------------------ item 1 */

function Desk({ review, story = EMPTY_STORY, embedded = false, own = true }: { review: boolean; story?: Story; embedded?: boolean; own?: boolean }) {
  const spec = own ? SHELF_SPEC : TASKTRACKR_SPEC;
  const view = useStoryFrom(JSON.stringify(story), spec);
  return (
    <IssueDesk
      view={view}
      spec={spec}
      providedStories={spec.providedStories}
      projectTitle={own ? 'Shelf' : 'TaskTrackr'}
      statusLabel="In progress"
      statusTone="accent"
      storyState="now"
      assignedTo="Learner"
      canRecord
      setStory={() => undefined}
      phaseId="w3b-requirements"
      embedded={embedded}
      reviewOpen={review}
    />
  );
}

/** Every state of the desk a learner can reach before saving: both views, the create menu and the story editor. */
function deskStates(props: { story?: Story; own: boolean }): string[] {
  const seen: string[] = [];
  for (const embedded of [false, true]) {
    render(<Desk review={false} embedded={embedded} {...props} />);
    seen.push(host.innerHTML);
    click(/^Add to backlog$/);
    seen.push(host.innerHTML);
    render(<Desk review={false} embedded={embedded} {...props} />);
    click(/Create (US-4 |your )?story|Edit your story/);
    seen.push(host.innerHTML);
    render(<Desk review embedded={embedded} {...props} />);
    seen.push(host.innerHTML);
    act(() => root.unmount());
    root = createRoot(host);
  }
  return seen;
}

/** The names of `deskStates`' eight renders, in the order it draws them. */
const DESK_STATES = ['on its own', 'embedded'].flatMap((place) =>
  ['the backlog', 'Add to backlog pressed', 'the story editor', 'the Review view'].map((state) => `${place}: ${state}`));
const deskPrints = (list: string, states: string[]) => states.map((html, i) => [`${list}, ${DESK_STATES[i]}`, html] as const);

describe('1. no US-4 on an own Requirements room', () => {
  it('a mounted desk with reference=false (FIX-1\'s Requirements) contains no \'US-4\' anywhere', () => {
    mount.project = shellState(SHELF(), [heldDetail('requirements', { provenance: OWN_REQUIREMENTS(), stakeholder: null })]);
    for (const markup of deskStates({ own: true })) expect(markup).not.toContain('US-4');
  });

  it('the learner\'s own id shows where it differs from the default', () => {
    mount.project = shellState(SHELF(), [heldDetail('requirements', { provenance: OWN_REQUIREMENTS(), stakeholder: null })]);
    const own = { ...EMPTY_STORY, id: 'SH-5', title: 'Free books by an author' };
    const states = deskStates({ own: true, story: own });
    for (const markup of states) expect(markup).not.toContain('US-4');
    expect(states[0]).toContain('<code>SH-5</code>');
    expect(states[2]).toContain('aria-label="Edit story SH-5"');
  });

  it('a TaskTrackr desk matches its snapshot exactly', async () => {
    mount.project = shellState(TASKTRACKR(), [heldDetail('requirements', { provenance: provenance('requirements') })]);
    const tasktrackr = deskStates({ own: false });
    expect(tasktrackr[0]).toContain('<code>US-4</code>');
    expect(tasktrackr[2]).toContain('aria-label="Edit story US-4"');
    mount.project = null;
    const noShell = deskStates({ own: false });
    expect(tasktrackr).toHaveLength(DESK_STATES.length);
    expect(noShell).toHaveLength(DESK_STATES.length);
    await expect(namedMarkup([...deskPrints('TaskTrackr shell', tasktrackr), ...deskPrints('no shell', noShell)]))
      .toMatchFileSnapshot('__snapshots__/tasktrackr-story-desk.html');
  });
});

/* ------------------------------------------------------------------ item 2 */

describe('2. an interview-less upload opens its Requirements room', () => {
  const req = summary('requirements', 'own');
  const noInterview = { tasks: [], provenance: OWN_REQUIREMENTS() };

  it('the door built with the held detail opens the room, not /interview', () => {
    expect(roomHref({ ...req, provenance: OWN_REQUIREMENTS() })).toBe('/workspace/w3b-requirements');
    const door = doorWithTasks(req, { [req.id]: noInterview });
    expect(phaseWorkHref(door)).toBe('/workspace/w3b-requirements');
    expect(phaseDoorHref(door)).toBe('/workspace/w3b-requirements');
    const mine = navigationItems('LEARNER', req, false, { [req.id]: noInterview }).find((row) => row.label === 'My project');
    expect(mine?.href).toBe('/workspace/w3b-requirements');
  });

  it('Continue my project opens the room, and the empty review line points at the brief', () => {
    mount.project = shellState(SHELF(), [heldDetail('requirements', { provenance: OWN_REQUIREMENTS(), stakeholder: null })]);
    render(<DashboardPage />);
    const go = Array.from(host.querySelectorAll('a')).find((one) => one.textContent?.includes('Continue my project'));
    expect(go?.getAttribute('href')).toBe('/workspace/w3b-requirements');
    expect(host.textContent).not.toContain('Start by talking with stakeholders in Requirements.');
    expect(host.textContent).toContain('Your first submission will appear here. Start with the Requirements brief.');
  });

  it('a phase with an interview, or a door with no held provenance, keeps /interview and today\'s line', () => {
    const today = '/workspace/w3b-requirements/interview';
    for (const held of [undefined, { tasks: [] }, { tasks: [], provenance: provenance('requirements') }, { tasks: [], provenance: provenance('requirements', { rollup: 'own', interview: 'own' }) }, { tasks: [], provenance: null }]) {
      const label = JSON.stringify(held);
      const door = doorWithTasks(req, held ? { [req.id]: held as never } : undefined);
      expect(phaseDoorHref(door), label).toBe(today);
      expect(navigationItems('LEARNER', req, false, held ? { [req.id]: held as never } : undefined).find((row) => row.label === 'My project')?.href, label).toBe(today);
    }
    // A provenance without an `interview` member (an older build) is not "none".
    expect(roomHref({ ...req, provenance: { application: null } })).toBe(today);
    for (const [enrol, details] of [
      [TASKTRACKR(), [heldDetail('requirements', { provenance: provenance('requirements') })]],
      [TASKTRACKR(), []],
      [SHELF(), []],
    ] as const) {
      mount.project = shellState(enrol, [...details]);
      render(<DashboardPage />);
      const go = Array.from(host.querySelectorAll('a')).find((one) => one.textContent?.includes('Continue my project'));
      expect(go?.getAttribute('href')).toBe(today);
      expect(host.textContent).toContain('Your first submission will appear here. Start by talking with stakeholders in Requirements.');
      expect(host.textContent).not.toContain('Start with the Requirements brief.');
    }
  });
});

/* ------------------------------------------------------------------ item 3 */

describe('the tour reads the registered phase\'s provenance', () => {
  const realRect = Element.prototype.getBoundingClientRect;
  const realScroll = Element.prototype.scrollIntoView;
  let serial = 0;
  beforeEach(() => {
    mount.phaseId = `w3b-tour-${++serial}`;
    Element.prototype.getBoundingClientRect = function () {
      return { top: 20, left: 20, right: 120, bottom: 60, width: 100, height: 40, x: 20, y: 20, toJSON() {} } as DOMRect;
    };
    Element.prototype.scrollIntoView = () => {};
  });
  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect;
    Element.prototype.scrollIntoView = realScroll;
  });

  function Room({ detail }: { detail: PhaseDetail }) {
    usePhaseTutorialReady(detail);
    return (
      <nav aria-label="Implementation working area">
        <button type="button">Code</button>
        <button type="button">Split</button>
        <button type="button">Files</button>
        <button type="button" data-testid="header-run">Run tests</button>
      </nav>
    );
  }

  /** The layout finds its phase in the enrolment only (`details` is `{}`); the room registers its own GET. */
  const walk = (application: Pick<PhaseProvenanceView, 'application'> | undefined) => {
    const detail = {
      id: mount.phaseId, key: 'implementation', order: 3, title: 'Implementation', status: 'in_progress', files: [], tasks: [],
      ...(application === undefined ? {} : { provenance: provenance('implementation', { ...(application.application === null ? { rollup: 'own' as const, referenceName: null } : {}), interview: null, ...application }) }),
    } as unknown as PhaseDetail;
    const enrol = { ...SHELF(), phases: [{ ...summary('implementation', 'own'), id: mount.phaseId, status: 'in_progress' }] } as unknown as EnrollmentView;
    mount.project = { ...shellState(enrol, []), currentPhase: enrol.phases[0] };
    act(() => root.render(<Layout><Room detail={detail} /></Layout>));
    expect(host.querySelector('[data-testid="coach"]'), 'the tour opens on first entry').not.toBeNull();
    const targets: string[] = [];
    const texts: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const card = host.querySelector<HTMLElement>('[data-testid="coach-card"]')!;
      targets.push(card.getAttribute('data-target') ?? '');
      texts.push(card.querySelector('.coach-copy')?.textContent ?? '');
      const [at, of] = (host.querySelector('[data-testid="coach-count"]')?.textContent ?? '').split(' of ');
      if (at === of) break;
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="coach-next"]')!.click());
    }
    return { targets, texts };
  };

  it('details {} and an own registered detail: no reference steps', () => {
    const { targets, texts } = walk({ application: null });
    expect(targets).not.toContain('implementation-tutorial-preview');
    expect(texts.join(' ')).not.toMatch(/inspect the app preview/i);
    expect(targets).toEqual(phaseTutorialMarks('implementation', false, { application: null }).map((mark) => mark.target));
  });

  it('the TaskTrackr tour is unchanged', () => {
    for (const application of [undefined, { application: 'TaskTrackr' }]) {
      localStorage.clear();
      mount.phaseId = `w3b-tour-${++serial}`;
      const { targets } = walk(application);
      expect(targets, JSON.stringify(application)).toEqual(phaseTutorialMarks('implementation', false).map((mark) => mark.target));
      expect(targets).toContain('implementation-tutorial-preview');
      act(() => root.unmount());
      root = createRoot(host);
    }
  });
});

/* ------------------------------------------------------------------ item 4 */

/* ----------------------------------------------------------------- item 2b */

describe('2b. an interview-less Requirements tour names no interview', () => {
  it('the tour starts at the brief and never points at the interview tab', () => {
    for (const lessons of [true, false]) {
      const marks = phaseTutorialMarks('requirements', lessons, OWN_REQUIREMENTS());
      expect(marks.map((mark) => mark.selector)).not.toContain('#requirements-interview-tab');
      expect(JSON.stringify(marks)).not.toMatch(/interview/i);
      expect(marks[0].target).toBe('requirements-tutorial-brief');
      expect(marks.map((mark) => mark.target)).toContain('requirements-tutorial-backlog');
    }
  });

  it('a Requirements tour with an interview, or with no provenance, is the reference tour', () => {
    // The reference tour itself, the one with no provenance, is held by own-project-phase-tours's file snapshot.
    for (const lessons of [true, false]) {
      for (const held of [undefined, null, { application: 'TaskTrackr' }, {}, provenance('requirements'), provenance('requirements', { rollup: 'own', interview: 'own', roomTask: 'other' })]) {
        const marks = (phaseTutorialMarks as (key: PhaseKey, lessons?: boolean, provenance?: unknown) => unknown[])('requirements', lessons, held);
        expect(marks, `${lessons} ${JSON.stringify(held)}`).toEqual(phaseTutorialMarks('requirements', lessons));
      }
    }
    // Every other phase ignores the interview.
    for (const key of KEYS.filter((one) => one !== 'requirements')) {
      expect(phaseTutorialMarks(key, true, { ...provenance(key), interview: null, application: 'TaskTrackr' })).toEqual(phaseTutorialMarks(key, true));
    }
  });
});

describe('no learner surface reads referenceName', () => {
  it('only staff surfaces name the field', () => {
    const web = join(__dirname, '..');
    const readers: string[] = [];
    const walkDir = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walkDir(path);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(path, 'utf8').includes('referenceName')) readers.push(relative(web, path));
      }
    };
    for (const top of ['app', 'components', 'lib']) walkDir(join(web, top));
    const learner = readers.filter((path) => !path.startsWith('components/staff/') && !path.startsWith('app/(app)/teacher/'));
    expect(learner).toEqual([]);
  });

  it('with referenceName null on an own phase nothing renders TaskTrackr and nothing breaks', () => {
    const own = (key: PhaseKey) => provenance(key, { referenceName: null, rollup: 'own', intro: 'own', interview: null, roomTask: key === 'requirements' ? 'other' : 'none', ...(KEYS.indexOf(key) >= 2 ? { application: null } : {}) });
    const details = KEYS.map((key) => heldDetail(key, { provenance: own(key), stakeholder: null }));
    mount.project = shellState(SHELF(), details);
    render(<DashboardPage />);
    expect(host.innerHTML).not.toMatch(/tasktrackr/i);
    for (const markup of deskStates({ own: true })) expect(markup).not.toMatch(/tasktrackr/i);
    for (const key of KEYS) {
      expect(JSON.stringify(phaseTutorialMarks(key, false, own(key))), key).not.toMatch(/tasktrackr/i);
      expect(roomHref({ ...summary(key, 'own'), provenance: own(key) }), key).not.toMatch(/interview|change/);
    }
    expect(navigationItems('LEARNER', summary('requirements', 'own'), false, Object.fromEntries(details.map((one) => [one.id, one]))).find((row) => row.label === 'My project')?.href).toBe('/workspace/w3b-requirements');
  });
});

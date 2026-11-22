// @vitest-environment jsdom
import { act, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseDetail, PhaseSummary, PhaseTaskView } from '@learnsdlc/shared';

/**
 * The gate band on a phase the learner has already moved on
 * from, and on the last phase of a completed project.
 *
 * The band a learner meets while they still stand on the phase must not change
 * in any word, id, role, state or behaviour. The first block pins every ordinary state of the band
 * (and the merge sheet it opens) by a file snapshot of its markup, and renders
 * each of them twice: with the enrolment the shell holds (the learner on this
 * very phase) and with no enrolment at all. Both must give the recorded
 * markup, byte for byte.
 *
 * The second block is the moved-on state, reachable only when the enrolment says
 * the learner has continued past the phase (or completed the project).
 */
const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  reflect: vi.fn(),
  advance: vi.fn(),
  invalidate: vi.fn(),
  records: vi.fn(),
  project: null as { enrollment: EnrollmentView | null; details?: Record<string, Partial<PhaseDetail>> } | null,
}));
vi.mock('next/navigation', () => ({ useRouter: () => rig.router }));
vi.mock('@/lib/api', () => ({ api: { reflect: rig.reflect, advance: rig.advance } }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: rig.records }));
vi.mock('@/lib/useProject', () => ({
  useProjectMaybe: () => rig.project,
  invalidateProject: rig.invalidate,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { PhaseGateBanner, ShellPhaseGateBanner, movedOnFrom } from '@/components/workspace/PhaseGateBanner';
import { ProjectContext } from '@/lib/project-context';
import { namedMarkup } from './support/markup-snapshot';

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
function phase(order: number, over: Partial<PhaseSummary> = {}): PhaseSummary {
  return {
    id: `phase-${order}`,
    key: KEYS[order - 1],
    order,
    title: KEYS[order - 1][0].toUpperCase() + KEYS[order - 1].slice(1),
    status: order < 2 ? 'passed' : 'in_progress',
    bestScore: null,
    attempts: 0,
    reflection: null,
    passedAt: null,
    opensAt: null,
    dueAt: null,
    ...over,
  };
}
/** Six phases, the learner standing on `current`; phases before it passed. */
function enrolled(current: number, over: { completed?: boolean; phases?: Partial<Record<number, Partial<PhaseSummary>>> } = {}): EnrollmentView {
  const phases = [1, 2, 3, 4, 5, 6].map((order) =>
    phase(order, { status: order < current || over.completed ? 'passed' : order === current ? 'in_progress' : 'locked', ...(over.phases?.[order] ?? {}) }),
  );
  return {
    id: 'enrolment-1',
    projectSlug: 'tasktrackr',
    projectTitle: 'TaskTrackr',
    currentPhaseOrder: current,
    completed: Boolean(over.completed),
    startedAt: '2026-09-01T09:00:00.000Z',
    completedAt: over.completed ? '2026-11-17T09:00:00.000Z' : null,
    phases,
  } as EnrollmentView;
}
function task(over: Partial<PhaseTaskView> = {}): PhaseTaskView {
  return {
    key: 'story',
    order: 1,
    required: true,
    title: 'Story',
    artefactType: 'issue',
    evidence: 'reviewed',
    sealed: true,
    status: 'passed',
    awaitingSignOff: false,
    attempts: 1,
    bestScore: 100,
    passedAt: '2026-11-11T05:00:00.000Z',
    lastSubmissionId: 'sub-1',
    resetAt: null,
    solution: { available: false },
    ...over,
  } as PhaseTaskView;
}

let root: Root, host: HTMLDivElement;
/** Rendered as the shell renders a room: inside the provider's context, holding `rig.project` (none when null). */
const render = (element: ReactElement) =>
  act(async () => {
    root.render(rig.project ? <ProjectContext.Provider value={rig.project as never}>{element}</ProjectContext.Provider> : element);
  });
const banner = () => host.querySelector<HTMLElement>('[data-testid="gate-banner"]');

beforeEach(() => {
  vi.clearAllMocks();
  rig.project = null;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

/** A passed phase 2 handed to the band, as a room hands it. */
const room = (over: Partial<PhaseSummary> & { tasks?: PhaseTaskView[]; evidenceNeeded?: { key: string; title: string }[]; notReachedYet?: true } = {}, props: Record<string, unknown> = {}) => (
  <PhaseGateBanner phaseId="phase-2" phase={{ ...phase(2, { status: 'passed', bestScore: 92 }), ...over }} isLast={false} {...props} />
);

/** Every state of the band a learner standing on the phase can meet; their markup is held in a file snapshot. */
const ORDINARY: { name: string; element: () => ReactElement; current?: number; openSheet?: boolean }[] = [
  { name: 'in progress: nothing', element: () => room({ status: 'in_progress' }) },
  { name: 'ready to continue', element: () => room() },
  { name: 'ready, the last phase', element: () => room({}, { isLast: true }) },
  { name: 'ready, merge message recorded', element: () => room({ reflection: 'what changed' }) },
  { name: 'ready, a task the teacher signed off', element: () => room({ tasks: [task({ evidence: 'signed-off', title: 'Requirements (class edit)' })] }) },
  { name: 'ready, a room treatment and View review', element: () => room({}, { className: 'requirements-gate', onViewReview: () => undefined }) },
  { name: 'credited, a review still needed', element: () => room({ tasks: [task()], evidenceNeeded: [{ key: 'story', title: 'Story' }] }) },
  { name: 'passed ahead of the learner', element: () => room({ notReachedYet: true }), current: 1 },
  { name: 'the merge sheet, opened', element: () => room(), openSheet: true },
  { name: 'the merge sheet on the last phase, opened', element: () => room({}, { isLast: true }), openSheet: true },
];
const BANDS_SNAPSHOT = '__snapshots__/gate-band-learner-on-phase.html';

async function markup(element: ReactElement, openSheet = false): Promise<string> {
  await render(element);
  if (openSheet) {
    await act(async () => { fireEvent.click(host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]')!); });
    return document.body.innerHTML;
  }
  return host.innerHTML;
}

/** The band's markup with no enrolment held, as a room draws it before the shell has one, in a root of its own. */
async function bandWithoutEnrolment(element: ReactElement): Promise<string> {
  const saved = rig.project;
  rig.project = null;
  const html = await markup(element);
  await act(async () => root.unmount());
  root = createRoot(host);
  rig.project = saved;
  return html;
}

describe('the band a learner still on the phase sees is what it was', () => {
  it('every ordinary state renders the recorded markup, with and without an enrolment', async () => {
    const withEnrolment: Record<string, string> = {};
    const without: Record<string, string> = {};
    for (const state of ORDINARY) {
      // The learner stands on this phase (or, passed ahead, before it): the enrolment the shell holds.
      rig.project = { enrollment: enrolled(state.current ?? 2, { phases: { 2: { status: 'passed' } } }) };
      withEnrolment[state.name] = await markup(state.element(), state.openSheet);
      await act(async () => root.unmount());
      document.body.innerHTML = '';
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
      rig.project = null;
      without[state.name] = await markup(state.element(), state.openSheet);
      await act(async () => root.unmount());
      document.body.innerHTML = '';
      host = document.createElement('div');
      document.body.append(host);
      root = createRoot(host);
    }
    expect(without).toEqual(withEnrolment);
    await expect(namedMarkup(withEnrolment)).toMatchFileSnapshot(BANDS_SNAPSHOT);
  });

  it('the frame\'s band reads the same as the room\'s for a learner on the phase', async () => {
    const ready = await bandWithoutEnrolment(room());
    rig.project = { enrollment: enrolled(2, { phases: { 2: { status: 'passed', bestScore: 92 } } }), details: {} };
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(host.innerHTML).toBe(ready);
    expect(host.querySelector('[data-testid="open-reflection"]')!.textContent).toBe('Continue to next phase');
  });
});

describe('the band once the learner has moved on', () => {
  const text = () => banner()?.querySelector('.phase-gate-sentence')?.textContent ?? '';
  const next = () => host.querySelector<HTMLAnchorElement>('[data-testid="gate-next-phase"]');

  it('a phase the learner has continued past: Passed, a quiet true line and a plain door to the next phase, no Continue', async () => {
    rig.project = { enrollment: enrolled(4), details: {} };
    await render(room());
    expect(banner()!.getAttribute('data-gate')).toBe('moved-on');
    expect(text()).toBe('Passed. Phase evidence accepted. You have moved on from this phase.');
    expect(host.querySelector('[data-testid="open-reflection"]')).toBeNull();
    expect(host.textContent).not.toContain('Ready to continue');
    expect(host.textContent).not.toContain('Continue');
    expect(next()!.getAttribute('href')).toBe('/workspace/phase-3');
    expect(next()!.textContent).toBe('Open Implementation');
    // A plain door, not the band's primary action.
    expect(next()!.className).toContain('btn-ghost');
    expect(document.querySelector('[data-testid="reflection-modal"]')).toBeNull();
    // The class the verification scripts measure the band by, and the room's own chrome, are kept.
    expect(banner()!.classList.contains('phase-gate-banner')).toBe(true);
    await render(room({}, { className: 'requirements-gate' }));
    expect(banner()!.className).toBe('phase-gate-banner requirements-gate');
  });

  it('says nothing about a merge message, and names the teacher who signed the phase off', async () => {
    rig.project = { enrollment: enrolled(3), details: {} };
    await render(room({ reflection: 'what changed' }));
    expect(text()).not.toContain('Merge message recorded');
    await render(room({ tasks: [task({ evidence: 'signed-off', title: 'Requirements (class edit)' })] }));
    expect(text()).toBe('Passed. Your teacher signed off Requirements (class edit). You have moved on from this phase.');
  });

  it('keeps View review where the room has one', async () => {
    rig.project = { enrollment: enrolled(5), details: {} };
    await render(room({}, { onViewReview: () => undefined }));
    expect(host.querySelector('[data-testid="gate-view-review"]')).not.toBeNull();
  });

  it('the last phase of a completed project: "The project is complete." and no second "Complete the project"', async () => {
    rig.project = { enrollment: enrolled(6, { completed: true }), details: {} };
    await render(<PhaseGateBanner phaseId="phase-6" phase={phase(6, { status: 'passed', bestScore: 100 })} isLast />);
    expect(banner()!.getAttribute('data-gate')).toBe('complete');
    expect(text()).toBe('Passed. Phase evidence accepted. The project is complete.');
    expect(document.body.textContent).not.toContain('Complete the project');
    expect(host.querySelector('[data-testid="open-reflection"]')).toBeNull();
    expect(next()!.getAttribute('href')).toBe('/completion');
    expect(next()!.textContent).toBe('Open your completion record');
  });

  it('an earlier phase of a completed project still says the learner moved on from it, with its next phase', async () => {
    rig.project = { enrollment: enrolled(6, { completed: true }), details: {} };
    await render(room());
    expect(banner()!.getAttribute('data-gate')).toBe('moved-on');
    expect(next()!.textContent).toBe('Open Implementation');
  });

  it('the document frame\'s band says the same on a phase the learner has left', async () => {
    rig.project = { enrollment: enrolled(4, { phases: { 2: { bestScore: 92 } } }), details: {} };
    await render(<ShellPhaseGateBanner phaseId="phase-2" />);
    expect(banner()!.getAttribute('data-gate')).toBe('moved-on');
    expect(host.querySelector('[data-testid="open-reflection"]')).toBeNull();
  });

  it('a phase whose gate still wants a reviewed pass keeps its submit door, moved on or not', async () => {
    rig.project = { enrollment: enrolled(4), details: {} };
    await render(room({ tasks: [task()], evidenceNeeded: [{ key: 'story', title: 'Story' }] }));
    expect(banner()!.getAttribute('data-gate')).toBe('evidence-needed');
  });

  it('an enrolment that does not hold this phase changes nothing', async () => {
    const other = enrolled(4);
    const ready = await bandWithoutEnrolment(room());
    rig.project = { enrollment: { ...other, phases: other.phases.map((one) => ({ ...one, id: `other-${one.order}` })) }, details: {} };
    await render(room());
    expect(host.innerHTML).toBe(ready);
    expect(host.querySelector('[data-testid="open-reflection"]')!.textContent).toBe('Continue to next phase');
  });

  it('movedOnFrom: only a completed project or a learner on a later phase', () => {
    expect(movedOnFrom(null, 'phase-2')).toBeNull();
    expect(movedOnFrom(enrolled(2), 'phase-2')).toBeNull();
    expect(movedOnFrom(enrolled(1), 'phase-2')).toBeNull();
    expect(movedOnFrom(enrolled(3), 'phase-2')?.next?.id).toBe('phase-3');
    expect(movedOnFrom(enrolled(6, { completed: true }), 'phase-6')?.next).toBeNull();
    expect(movedOnFrom(enrolled(6), 'phase-6')).toBeNull();
  });
});

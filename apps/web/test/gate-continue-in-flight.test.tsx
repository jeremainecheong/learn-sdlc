// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { fireEvent } from '@testing-library/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnrollmentView, PhaseSummary } from '@learnsdlc/shared';

/**
 * The Continue a learner presses in the middle of a project.
 *
 * The band's "moved on" state is read from the shell's enrolment, and
 * the merge itself puts the advance's answer into that enrolment
 * (`invalidateProject(updated)`) a moment before the router leaves the room.
 * The room that pressed Continue must not draw the moved-on line, nor lose
 * the open drawer, in that moment: the band and its drawer stay as they are
 * until the next room replaces them. Here the router never leaves,
 * so the room is held in exactly that moment.
 */
const rig = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn() },
  reflect: vi.fn(),
  advance: vi.fn(),
  invalidate: vi.fn(),
  records: vi.fn(),
  setEnrollment: null as null | ((next: EnrollmentView) => void),
}));
vi.mock('next/navigation', () => ({ useRouter: () => rig.router }));
vi.mock('@/lib/api', () => ({ api: { reflect: rig.reflect, advance: rig.advance } }));
vi.mock('@/lib/records', () => ({ refreshPhaseRecords: rig.records }));
vi.mock('@/lib/useProject', () => ({
  useProjectMaybe: () => null,
  invalidateProject: rig.invalidate,
}));
vi.mock('next/link', () => ({
  default: ({ href, children, prefetch: _p, scroll: _s, ...rest }: { href: string; children: ReactNode; prefetch?: boolean; scroll?: boolean }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { PhaseGateBanner } from '@/components/workspace/PhaseGateBanner';
import { ProjectContext } from '@/lib/project-context';

const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
function enrolled(current: number, completed = false): EnrollmentView {
  return {
    id: 'enrolment-1',
    projectSlug: 'deadline-badge',
    projectTitle: 'Deadline badge',
    currentPhaseOrder: current,
    completed,
    startedAt: '2026-11-18T09:00:00.000Z',
    completedAt: completed ? '2026-11-18T10:00:00.000Z' : null,
    phases: [1, 2, 3, 4, 5, 6].map((order) => ({
      id: `phase-${order}`,
      key: KEYS[order - 1],
      order,
      title: KEYS[order - 1][0].toUpperCase() + KEYS[order - 1].slice(1),
      status: order < current || completed ? 'passed' : order === current ? 'passed' : 'locked',
      bestScore: order <= current ? 100 : null,
      attempts: order <= current ? 1 : 0,
      reflection: null,
      passedAt: null,
      opensAt: null,
      dueAt: null,
    })),
  } as EnrollmentView;
}
const passed = (order: number): PhaseSummary => ({ ...enrolled(order).phases[order - 1], status: 'passed' }) as PhaseSummary;

/** The shell's provider, reduced to the one thing that matters here: the enrolment it holds, which the merge replaces. */
function Shell({ start, children }: { start: EnrollmentView; children: ReactNode }) {
  const [enrollment, setEnrollment] = useState(start);
  rig.setEnrollment = setEnrollment;
  return <ProjectContext.Provider value={{ enrollment, details: {} } as never}>{children}</ProjectContext.Provider>;
}

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  rig.invalidate.mockImplementation((answered?: EnrollmentView) => { if (answered) rig.setEnrollment?.(answered); });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const band = () => host.querySelector<HTMLElement>('[data-testid="gate-banner"]')!;

async function pressContinue() {
  await act(async () => { fireEvent.click(host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]')!); });
  await act(async () => { fireEvent.click(document.querySelector<HTMLButtonElement>('[data-testid="reflection-submit"]')!); });
}

describe('Continue, pressed in the room the learner stands on', () => {
  it('the band and its drawer stay as they were while the router leaves for the next phase', async () => {
    rig.advance.mockResolvedValue(enrolled(3));
    await act(async () => {
      root.render(<Shell start={enrolled(2)}><PhaseGateBanner phaseId="phase-2" phase={passed(2)} isLast={false} /></Shell>);
    });
    const before = band().outerHTML;
    await pressContinue();
    expect(rig.advance).toHaveBeenCalledWith('phase-2');
    expect(rig.invalidate).toHaveBeenCalled();
    expect(rig.router.push).toHaveBeenCalledWith('/workspace/phase-3');
    // The enrolment now says the learner stands on phase 3, and this room is still on screen.
    expect(band().getAttribute('data-gate')).toBeNull();
    expect(band().outerHTML).toBe(before);
    expect(band().textContent).toContain('Ready to continue.');
    expect(document.querySelector('[data-testid="reflection-modal"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="gate-next-phase"]')).toBeNull();
  });

  it('the last phase: Complete the project does not turn into "The project is complete." before /complete opens', async () => {
    rig.advance.mockResolvedValue(enrolled(6, true));
    await act(async () => {
      root.render(<Shell start={enrolled(6)}><PhaseGateBanner phaseId="phase-6" phase={passed(6)} isLast /></Shell>);
    });
    await pressContinue();
    expect(rig.router.push).toHaveBeenCalledWith('/complete');
    expect(band().getAttribute('data-gate')).toBeNull();
    expect(band().textContent).toContain('Complete the project');
    expect(document.querySelector('[data-testid="reflection-modal"]')).not.toBeNull();
  });

  /*
   * The hold is for a Continue that went ahead. A Continue refused here (a reflection too short, an
   * advance that failed) leaves the enrolment as it was, so the hold is let go; if the learner then continues in
   * another tab, this band can still say so.
   */
  it('a Continue the room refused: the hold is let go, and a Continue made in another tab still shows here', async () => {
    const refuse = vi.fn().mockRejectedValue(new Error('Save your backlog draft before continuing.'));
    await act(async () => {
      root.render(<Shell start={enrolled(2)}><PhaseGateBanner phaseId="phase-2" phase={passed(2)} isLast={false} onBeforeContinue={refuse} /></Shell>);
    });
    await pressContinue();
    expect(refuse).toHaveBeenCalled();
    expect(rig.advance).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="reflection-modal"]')?.textContent).toContain('Save your backlog draft before continuing.');
    await act(async () => { rig.setEnrollment?.(enrolled(3)); });
    expect(band().getAttribute('data-gate')).toBe('moved-on');
  });

  it('an advance that failed: the hold is let go, and a Continue made in another tab still shows here', async () => {
    rig.advance.mockRejectedValue(new Error('The phase could not be merged.'));
    await act(async () => {
      root.render(<Shell start={enrolled(2)}><PhaseGateBanner phaseId="phase-2" phase={passed(2)} isLast={false} /></Shell>);
    });
    await pressContinue();
    expect(rig.advance).toHaveBeenCalledWith('phase-2');
    // still the band it was, with the drawer and its error
    expect(band().getAttribute('data-gate')).toBeNull();
    expect(document.querySelector('[data-testid="reflection-modal"]')?.textContent).toContain('The phase could not be merged.');
    await act(async () => { rig.setEnrollment?.(enrolled(3)); });
    expect(band().getAttribute('data-gate')).toBe('moved-on');
  });

  /*
   * A band that turns to "moved on" (the learner continued in another tab) while its drawer is open
   * closes the room's open state too, so the room's own actions, which stand down while the drawer is up, come back.
   */
  it('the drawer open when the learner continues in another tab: the room is told the drawer has closed', async () => {
    const seen: boolean[] = [];
    function Room() {
      const [open, setOpen] = useState(false);
      seen.push(open);
      return (
        <div data-testid="room" data-drawer={open ? 'open' : 'closed'}>
          <PhaseGateBanner phaseId="phase-2" phase={passed(2)} isLast={false} open={open} onOpenChange={setOpen} />
        </div>
      );
    }
    await act(async () => { root.render(<Shell start={enrolled(2)}><Room /></Shell>); });
    await act(async () => { fireEvent.click(host.querySelector<HTMLButtonElement>('[data-testid="open-reflection"]')!); });
    expect(host.querySelector('[data-testid="room"]')!.getAttribute('data-drawer')).toBe('open');
    await act(async () => { rig.setEnrollment?.(enrolled(3)); });
    expect(band().getAttribute('data-gate')).toBe('moved-on');
    expect(document.querySelector('[data-testid="reflection-modal"]')).toBeNull();
    expect(host.querySelector('[data-testid="room"]')!.getAttribute('data-drawer')).toBe('closed');
  });

  it('a room opened on a phase already left still draws the moved-on line', async () => {
    await act(async () => {
      root.render(<Shell start={enrolled(3)}><PhaseGateBanner phaseId="phase-2" phase={passed(2)} isLast={false} /></Shell>);
    });
    expect(band().getAttribute('data-gate')).toBe('moved-on');
  });
});

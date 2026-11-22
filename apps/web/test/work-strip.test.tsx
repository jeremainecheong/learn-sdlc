// @vitest-environment jsdom
/**
 * The real phase strip as the header of a Maintenance document page.
 *
 * The frame hands it the optional quick check in one of two places, by the
 * workspace header's rule: `rowLine` on the strip's own row (in view, in the
 * accessibility tree) or `menuLine` inside its Details. With `workHeader` the
 * strip carries the workspace header's class, so that header's layout rules
 * are the ones that apply, and, as in that header's More menu, Replay tutorial
 * and the reference solution's door are read inside Details, which leaves the
 * row its room for the check. "Later" pressed inside Details puts keyboard focus
 * back on the Details summary, as the workspace header's menu does. A strip
 * with none of the three is the strip it was.
 */
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: ComponentProps<'a'>) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@/lib/schedule', () => ({ useNow: () => null, isPast: () => false, dueLine: () => '' }));
vi.mock('@/lib/useProject', () => ({ useProjectMaybe: () => null }));
vi.mock('@/lib/scenario', () => ({ lessonsOfferedOn: () => false }));
vi.mock('@/components/shell/ShellProvider', () => ({ useShellConfig: () => undefined }));
vi.mock('@/components/shell/PhaseTutorial', () => ({ PhaseTutorialReplay: () => <button type="button" data-testid="replay">Replay tutorial</button> }));

import { PhaseStrip } from '@/components/shell/WorkPage';

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const PHASE = { key: 'maintenance' as const, title: 'Maintenance', place: 6, count: 6 };
/** The quick check's line, with the test ids the real one carries. */
const Line = ({ onLater }: { onLater?: () => void }) => (
  <section data-testid="concept-prompt"><button type="button" data-testid="concept-prompt-skip" onClick={onLater}>Later</button></section>
);
const ACTIONS = <><button type="button" data-testid="open-workspace">Open the workspace</button><button type="button" data-testid="solution-open">Read the reference solution</button><button type="button" data-testid="phase-maintenance-submit">Submit PR-6</button></>;
const draw = (props: { rowLine?: ReactNode; menuLine?: ReactNode; workHeader?: boolean }) =>
  act(() => root.render(<PhaseStrip phase={PHASE} titleLevel={1} right={ACTIONS} {...props} />));
const onRow = (testId: string) => { const node = strip().querySelector(`[data-testid="${testId}"]`); return Boolean(node) && node!.closest('details') === null; };
const strip = () => host.querySelector<HTMLElement>('[data-testid="phase-strip"]')!;

describe('the strip as the header of a Maintenance document page', () => {
  it('rowLine is drawn on the strip\'s own row, outside Details, before the row\'s own controls', () => {
    draw({ workHeader: true, rowLine: <Line /> });
    const line = strip().querySelector('[data-testid="concept-prompt"]')!;
    expect(line.parentElement).toBe(strip());
    expect(line.closest('details')).toBeNull();
    // after the spacer, before Details: where the workspace header draws its own
    expect(line.previousElementSibling?.matches('.phase-strip-spacer')).toBe(true);
    expect(line.nextElementSibling?.matches('details.phase-strip-details')).toBe(true);
    expect(strip().querySelector('details [data-testid="concept-prompt"]')).toBeNull();
  });
  it('menuLine is read inside Details, under the phase\'s place', () => {
    draw({ workHeader: true, menuLine: <Line /> });
    const line = strip().querySelector('[data-testid="concept-prompt"]')!;
    expect(line.closest('details.phase-strip-details')).not.toBeNull();
    expect(line.parentElement?.matches('.phase-strip-detail-panel')).toBe(true);
    expect([...strip().children].some((child) => child.matches('[data-testid="concept-prompt"]'))).toBe(false);
  });
  it('workHeader gives the strip the workspace header\'s class and its menu: Replay tutorial and the solution\'s door are in Details, the page\'s actions on the row', () => {
    draw({ workHeader: true });
    expect([...strip().classList]).toEqual(['phase-strip-approved', 'phase-header', 'phase-header--doc']);
    expect(strip().querySelector('details.phase-strip-details > summary')!.textContent).toContain('Details');
    expect(onRow('open-workspace')).toBe(true);
    expect(onRow('phase-maintenance-submit')).toBe(true);
    expect(onRow('replay')).toBe(false);
    expect(onRow('solution-open')).toBe(false);
    const group = strip().querySelector('details .phase-strip-secondary')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('Phase actions');
    expect([...group.children].map((c) => c.getAttribute('data-testid'))).toEqual(['replay', 'solution-open']);
  });
  it('"Later" inside Details closes it and puts focus back on its summary', () => {
    let put = 0;
    const view = (later: boolean) => draw({ workHeader: true, menuLine: later ? undefined : <Line onLater={() => { put += 1; view(true); }} /> });
    view(false);
    const details = strip().querySelector<HTMLDetailsElement>('details.phase-strip-details')!;
    details.open = true;
    const later = strip().querySelector<HTMLButtonElement>('[data-testid="concept-prompt-skip"]')!;
    later.focus();
    act(() => later.click());
    expect(put).toBe(1);
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector('summary'));
  });
  it('a door used inside Details closes it (Replay tutorial points at controls the open panel would cover); a press on plain text does not', () => {
    draw({ workHeader: true });
    const details = strip().querySelector<HTMLDetailsElement>('details.phase-strip-details')!;
    details.open = true;
    act(() => strip().querySelector<HTMLElement>('details .phase-strip-detail-panel strong')!.click());
    expect(details.open).toBe(true);
    act(() => strip().querySelector<HTMLButtonElement>('details [data-testid="replay"]')!.click());
    expect(details.open).toBe(false);
  });
  it('on every other document page a press inside Details leaves it open', () => {
    draw({ right: undefined } as never);
    act(() => root.render(<PhaseStrip phase={PHASE} titleLevel={1} right={<button type="button" data-testid="open-brief">Brief</button>} />));
    const details = strip().querySelector<HTMLDetailsElement>('details.phase-strip-details')!;
    details.open = true;
    act(() => strip().querySelector<HTMLButtonElement>('details [data-testid="open-brief"]')!.click());
    expect(details.open).toBe(true);
  });
  it('a strip handed none of the three is the strip every other document page draws', () => {
    draw({});
    expect([...strip().classList]).toEqual(['phase-strip-approved']);
    expect(strip().querySelector('[data-testid="concept-prompt"]')).toBeNull();
    // Replay tutorial and the solution's door stay on the row, and Details draws no empty group
    expect(strip().querySelector('.phase-strip-spacer')!.nextElementSibling?.matches('[data-testid="replay"]')).toBe(true);
    expect(onRow('solution-open')).toBe(true);
    expect(strip().querySelector('details .phase-strip-secondary')).toBeNull();
  });
  /*
   * On the planted bugs page the header held the quick check, Details, "Back to the workspace",
   * "Run the bugs again" and Submit, and wrapped to two lines at 1024 and 1100 px. "Back to the workspace" repeats the
   * working-area row's own edit entry, so on a strip laid out as the workspace's header it is read inside Details, as
   * the reference solution's door is; every other document page keeps it where it was.
   */
  it('on a work header the door back to the workspace is read inside Details; the page\'s own actions stay on the row', () => {
    const matrixActions = <><button type="button" data-testid="open-brief">Brief</button><a href="/workspace/p-4" data-testid="back-workspace">Back to the workspace</a><button type="button">Run the bugs again</button><button type="button" data-testid="phase-testing-submit">Submit PR-4</button></>;
    act(() => root.render(<PhaseStrip phase={{ key: 'testing', title: 'Testing', place: 4, count: 6 }} titleLevel={1} right={matrixActions} workHeader />));
    expect(onRow('back-workspace')).toBe(false);
    expect(strip().querySelector('details .phase-strip-secondary [data-testid="back-workspace"]')).not.toBeNull();
    expect([...strip().querySelectorAll('.phase-strip-primary > *')].map((c) => c.textContent)).toEqual(['Run the bugs again', 'Submit PR-4']);
    // on every other document page it stays on the row
    act(() => root.render(<PhaseStrip phase={{ key: 'testing', title: 'Testing', place: 4, count: 6 }} titleLevel={1} right={matrixActions} />));
    expect(onRow('back-workspace')).toBe(true);
  });
});

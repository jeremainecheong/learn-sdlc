// @vitest-environment jsdom
/**
 * The regression card's disabled control says why it is off.
 *
 * The change room's regression card draws its own control in the "No verdict
 * yet" state. It carries the reason the room's header Submit carries
 * (SIGN_OFF_SUBMIT_REASON while the task waits on the countersignature; the
 * in-flight reason while a newer revision is queued or running), as the
 * button's tooltip and accessible description, the Button pattern every room
 * uses. Busy with no reason, and on, carry no reason.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegressionTable } from '@/components/workspace/panels/maintenance/ChangeCards';
import type { MaintenanceModel } from '@/components/workspace/panels/maintenance/useMaintenance';
import { SIGN_OFF_SUBMIT_REASON } from '@/components/workspace/signoff-status';

const model = (awaitingVerdict = true) => ({ suites: [], mutation: null, ticket: { id: 'CR-1', title: 'The change' }, awaitingVerdict }) as unknown as MaintenanceModel;
const REASON = 'A reason the room hands down.';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

type Props = { busy: boolean; reason?: string; onSubmit?: () => void };
const draw = (props: Props) => act(() => {
  root.render(<RegressionTable m={model()} pr="PR-6" onSubmit={props.onSubmit ?? (() => undefined)} {...(props as { busy: boolean })} />);
});
const control = () => host.querySelector<HTMLButtonElement>('[data-testid="phase-maintenance-regression"] button')!;
const describedBy = (button: HTMLButtonElement) => {
  const id = button.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent ?? null : null;
};

describe('the regression card\'s own control', () => {
  it('off with a reason: the reason is its accessible description and its tooltip', () => {
    draw({ busy: true, reason: SIGN_OFF_SUBMIT_REASON });
    expect(control().disabled).toBe(true);
    // It submits, so it is named as every submit control of the phase is.
    expect(control().textContent).toContain('Submit PR-6');
    expect(control().textContent).not.toContain('Open');
    expect(describedBy(control())).toBe(SIGN_OFF_SUBMIT_REASON);
    expect(control().getAttribute('title')).toBe(SIGN_OFF_SUBMIT_REASON);
  });

  it('any reason the room hands down is the one it states', () => {
    draw({ busy: true, reason: REASON });
    expect(describedBy(control())).toBe(REASON);
  });

  it('off with no reason (the room is handing a revision in): off, and nothing described', () => {
    draw({ busy: true });
    expect(control().disabled).toBe(true);
    expect(control().getAttribute('aria-describedby')).toBeNull();
  });

  it('on: no reason, and a press reaches the room', () => {
    const onSubmit = vi.fn();
    draw({ busy: false, reason: REASON, onSubmit });
    expect(control().disabled).toBe(false);
    expect(control().getAttribute('aria-describedby')).toBeNull();
    act(() => control().click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

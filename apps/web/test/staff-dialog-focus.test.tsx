// @vitest-environment jsdom
/**
 * The staff confirm dialog keeps focus after a press on its backdrop, and the
 * page behind it is out of reach while it is open.
 *
 * jsdom moves no focus on a pointer press, so each case models the browser's
 * default action: a `mousedown` that is not cancelled on a control that cannot
 * take focus sends focus to `<body>`. Tab and Escape are then sent where focus
 * is, as a browser sends them. These cases model a browser rather than run
 * one (a real pointer, real Tab order and focus refused by an inert opener
 * need Playwright and axe), so the `inert` attribute and the opener's state
 * when focus is handed back are asserted directly.
 *
 * - A press on the backdrop leaves focus inside the dialog, so Tab wraps inside
 *   it and Escape still reaches it.
 * - While the dialog is open, everything beside it up to `<body>` is `inert`;
 *   on close each one is given back exactly as it was.
 */
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StaffDialog } from '@/components/staff/StaffDialog';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let beside: HTMLDivElement | null = null;
const onClose = vi.fn();

function Page({ startOpen = true, closable = true }: { startOpen?: boolean; closable?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <main>
      <button type="button" ref={opener} data-testid="behind" onClick={() => setOpen(true)}>
        A control on the page behind
      </button>
      <section data-testid="page-section">
        <a href="#somewhere" data-testid="behind-link">
          A link on the page behind
        </a>
        {open && (
          <StaffDialog
            title="Start deep validation"
            returnFocus={opener}
            closable={closable}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            testId="staff-dialog"
          >
            <p>Starting it boots microVMs.</p>
            <button type="button" data-testid="dialog-first">
              Start
            </button>
            <button type="button" data-testid="dialog-last">
              Cancel
            </button>
          </StaffDialog>
        )}
      </section>
    </main>
  );
}

beforeEach(() => {
  onClose.mockReset();
  beside = document.createElement('div');
  beside.setAttribute('data-testid', 'beside-root');
  const other = document.createElement('button');
  other.type = 'button';
  other.textContent = 'A control in another root';
  beside.appendChild(other);
  document.body.appendChild(beside);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  beside?.remove();
  root = null;
  host = null;
  beside = null;
});

const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const dialog = () => byId('staff-dialog') as HTMLElement;
const backdrop = () => dialog().parentElement as HTMLElement;

/** A pointer press as a browser makes it: focus leaves for `<body>` unless the press is cancelled. */
function press(target: HTMLElement) {
  let kept = false;
  act(() => {
    kept = !target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  if (!kept && target.tabIndex < 0 && !target.closest('[tabindex="-1"][role="dialog"]')) {
    (document.activeElement as HTMLElement | null)?.blur();
  }
}

/** A key sent where focus is; Tab with no handler moves to the next control in the page. */
function key(name: string, shiftKey = false) {
  const at = (document.activeElement as HTMLElement | null) ?? document.body;
  let handled = false;
  act(() => {
    handled = !at.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));
  });
  if (name === 'Tab' && !handled && at === document.body) {
    // The browser's own Tab from <body>: the first control that is not inert.
    const next = [...document.querySelectorAll<HTMLElement>('button, [href]')].find((one) => !one.closest('[inert]'));
    next?.focus();
  }
}

describe('the staff dialog after a press on its backdrop', () => {
  it('keeps focus inside: Tab wraps inside the dialog and Escape still closes it', async () => {
    await act(async () => root?.render(<Page />));
    expect(dialog().contains(document.activeElement)).toBe(true);

    press(backdrop());
    expect(dialog().contains(document.activeElement)).toBe(true);

    key('Tab');
    expect(dialog().contains(document.activeElement)).toBe(true);
    (byId('dialog-last') as HTMLElement).focus();
    key('Tab');
    expect(document.activeElement).toBe(byId('dialog-first'));

    press(backdrop());
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(byId('staff-dialog')).toBeNull();
    // Focus comes back to the control that opened it.
    expect(document.activeElement).toBe(byId('behind'));
  });

  it('the backdrop never closes the dialog, mid-save or not', async () => {
    await act(async () => root?.render(<Page />));
    act(() => {
      backdrop().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(byId('staff-dialog')).not.toBeNull();
  });

  it('a press inside the dialog body is not cancelled, so its text can still be selected', async () => {
    await act(async () => root?.render(<Page />));
    const text = dialog().querySelector('p') as HTMLElement;
    let kept = false;
    act(() => {
      kept = !text.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(kept).toBe(false);
  });

  it('mid-save, Escape after a backdrop press still reaches the dialog and does not close it', async () => {
    await act(async () => root?.render(<Page closable={false} />));
    press(backdrop());
    key('Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog().contains(document.activeElement)).toBe(true);
  });
});

describe('the page behind the staff dialog', () => {
  it('is inert while the dialog is open, and given back exactly as it was on close', async () => {
    const already = document.createElement('div');
    already.setAttribute('inert', '');
    document.body.appendChild(already);
    try {
      await act(async () => root?.render(<Page />));
      expect(byId('behind')?.closest('[inert]')).not.toBeNull();
      expect(byId('behind-link')?.closest('[inert]')).not.toBeNull();
      expect(byId('beside-root')?.hasAttribute('inert')).toBe(true);
      // The dialog and everything on the path to it stay reachable.
      expect(dialog().closest('[inert]')).toBeNull();

      (byId('dialog-first') as HTMLElement).focus();
      key('Escape');
      expect(byId('staff-dialog')).toBeNull();
      expect(document.querySelectorAll('[inert]').length).toBe(1);
      expect(already.hasAttribute('inert')).toBe(true);
      expect(byId('beside-root')?.hasAttribute('inert')).toBe(false);
    } finally {
      already.remove();
    }
  });

  it('gives the page back before focus returns, so a browser lets the opener take it', async () => {
    // jsdom lets focus() land on an inert node; a browser does not. So the
    // proof is the opener's state at the moment focus is handed back to it.
    await act(async () => root?.render(<Page />));
    (byId('dialog-first') as HTMLElement).focus();
    const calls: { id: string | null; inert: boolean }[] = [];
    const real = HTMLElement.prototype.focus;
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options) {
      calls.push({ id: this.getAttribute('data-testid'), inert: this.closest('[inert]') !== null });
      real.call(this, options);
    });
    try {
      key('Escape');
    } finally {
      spy.mockRestore();
    }
    expect(byId('staff-dialog')).toBeNull();
    const back = calls.filter((one) => one.id === 'behind');
    expect(back.length).toBe(1);
    expect(back[0].inert).toBe(false);
  });

  // What is added beside the dialog's path while it is open (a toast,
  // a portal, a polled control) is out of reach too, and given back on close.
  it('makes a sibling added while it is open inert, and gives it back on close', async () => {
    await act(async () => root?.render(<Page />));
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.setAttribute('data-testid', 'late-toast');
    const nearby = document.createElement('a');
    nearby.href = '#late';
    nearby.setAttribute('data-testid', 'late-link');
    await act(async () => {
      document.body.appendChild(toast);
      byId('page-section')?.appendChild(nearby);
      await Promise.resolve();
    });
    try {
      expect(toast.hasAttribute('inert')).toBe(true);
      expect(nearby.hasAttribute('inert')).toBe(true);
      expect(dialog().closest('[inert]')).toBeNull();
      (byId('dialog-first') as HTMLElement).focus();
      key('Escape');
      expect(byId('staff-dialog')).toBeNull();
      expect(toast.hasAttribute('inert')).toBe(false);
      expect(nearby.hasAttribute('inert')).toBe(false);
      expect(document.querySelectorAll('[inert]').length).toBe(0);
    } finally {
      toast.remove();
      nearby.remove();
    }
  });

  // The sign-off queue's confirm opens inside the class page's tab panel, which
  // is a tab stop (`tabPanelProps`) and cannot be inert with the dialog in it.
  it('takes the tab stop of a panel the dialog sits inside, and gives it back on close', async () => {
    function InPanel() {
      const [open, setOpen] = useState(true);
      return (
        <main tabIndex={-1} data-testid="skip-target">
          <div role="tabpanel" tabIndex={0} data-testid="panel">
            {open && (
              <StaffDialog title="Sign off Design" onClose={() => setOpen(false)} testId="staff-dialog">
                <button type="button" data-testid="dialog-first">
                  Confirm sign-off
                </button>
              </StaffDialog>
            )}
          </div>
        </main>
      );
    }
    await act(async () => root?.render(<InPanel />));
    const panel = byId('panel') as HTMLElement;
    expect(panel.hasAttribute('tabindex')).toBe(false);
    expect(panel.tabIndex).toBe(-1);
    expect(panel.hasAttribute('inert')).toBe(false);
    // A target focus is sent to, never a stop: left as it is.
    expect(byId('skip-target')?.getAttribute('tabindex')).toBe('-1');

    (byId('dialog-first') as HTMLElement).focus();
    key('Escape');
    expect(byId('staff-dialog')).toBeNull();
    expect(panel.getAttribute('tabindex')).toBe('0');
    expect(byId('skip-target')?.getAttribute('tabindex')).toBe('-1');
  });

  it('gives the page back when the dialog unmounts without closing', async () => {
    await act(async () => root?.render(<Page />));
    expect(byId('beside-root')?.hasAttribute('inert')).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(document.querySelectorAll('[inert]').length).toBe(0);
  });
});

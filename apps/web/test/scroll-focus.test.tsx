// @vitest-environment jsdom
/**
 * A region that scrolls can be scrolled from the keyboard.
 *
 * Axe's scrollable-region-focusable rule flags boxes that scroll with nothing
 * inside them that takes focus, such as the dossier's tables at phone width,
 * the deployment pipeline and timeline,
 * the design brief and model canvas, the implementation task card, the change
 * page's document, the interview transcript and the mentor thread. A keyboard
 * user cannot reach what those boxes hide.
 *
 * `lib/scroll-focus.ts` puts such a box in the tab order while (and only
 * while) it actually scrolls, so a table that fits adds no tab stop. It never
 * takes over a box that already says what its tab order is.
 */
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollFocusRef, syncScrollFocus, useScrollFocusRef, watchScrollFocus } from '@/lib/scroll-focus';
import { Table } from '@/components/ui';
import { Room } from '@/components/workspace/interview/Room';

/** jsdom lays nothing out, so each case says how big the box and its content are. */
function size(el: HTMLElement, box: { cw: number; sw: number; ch?: number; sh?: number }) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => box.cw });
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => box.sw });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => box.ch ?? 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => box.sh ?? 100 });
}

let style: HTMLStyleElement;
beforeEach(() => {
  // The utilities the product's scrollers are drawn with, as the browser reads them.
  style = document.createElement('style');
  style.textContent =
    '.overflow-x-auto{overflow-x:auto}.overflow-y-auto{overflow-y:auto}.overflow-hidden{overflow:hidden}';
  document.head.appendChild(style);
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
};
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  style.remove();
  root = null;
  host = null;
});

describe('syncScrollFocus', () => {
  it('puts a box that scrolls sideways in the tab order', () => {
    const el = document.createElement('div');
    el.className = 'overflow-x-auto';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 640 });
    expect(syncScrollFocus(el)).toBe(true);
    expect(el.getAttribute('tabindex')).toBe('0');
    el.remove();
  });

  it('puts a box that scrolls down in the tab order', () => {
    const el = document.createElement('div');
    el.className = 'overflow-y-auto';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 300, ch: 200, sh: 900 });
    expect(syncScrollFocus(el)).toBe(true);
    expect(el.getAttribute('tabindex')).toBe('0');
    el.remove();
  });

  it('adds no tab stop to a box whose content fits, and takes its own back when it stops scrolling', () => {
    const el = document.createElement('div');
    el.className = 'overflow-x-auto';
    document.body.appendChild(el);
    size(el, { cw: 640, sw: 640 });
    expect(syncScrollFocus(el)).toBe(false);
    expect(el.hasAttribute('tabindex')).toBe(false);
    size(el, { cw: 300, sw: 640 });
    syncScrollFocus(el);
    expect(el.getAttribute('tabindex')).toBe('0');
    size(el, { cw: 700, sw: 700 });
    syncScrollFocus(el);
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.remove();
  });

  it('does not count an axis the box clips rather than scrolls', () => {
    const el = document.createElement('div');
    el.className = 'overflow-hidden';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 640, ch: 100, sh: 400 });
    expect(syncScrollFocus(el)).toBe(false);
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.remove();
  });

  it('never overrides a tab order the markup already chose', () => {
    const el = document.createElement('div');
    el.className = 'overflow-x-auto';
    el.setAttribute('tabindex', '-1');
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 640 });
    syncScrollFocus(el);
    expect(el.getAttribute('tabindex')).toBe('-1');
    size(el, { cw: 700, sw: 700 });
    syncScrollFocus(el);
    expect(el.getAttribute('tabindex')).toBe('-1');
    el.remove();
  });

  it('gives the box back when it stops being watched', () => {
    const el = document.createElement('div');
    el.className = 'overflow-x-auto';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 640 });
    const stop = watchScrollFocus(el);
    expect(el.getAttribute('tabindex')).toBe('0');
    stop();
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.remove();
  });
});

describe('the scrollers the audit found', () => {
  it('a Table that scrolls sideways at phone width can be reached by the keyboard', () => {
    // Size the wrapper as the browser would at 390px before React commits the ref.
    const proto = HTMLDivElement.prototype;
    const spy = vi.spyOn(proto, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('overflow-x-auto') ? 640 : 0;
    });
    const spy2 = vi.spyOn(proto, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('overflow-x-auto') ? 300 : 0;
    });
    mount(<Table cols={[{ label: 'Phase' }, { label: 'Status' }]} rows={[['Requirements', 'Pass']]} testId="t" minWidth={640} />);
    const wrap = host!.querySelector<HTMLElement>('[data-testid="t"]')!;
    expect(wrap.classList.contains('overflow-x-auto')).toBe(true);
    expect(wrap.getAttribute('tabindex')).toBe('0');
    spy.mockRestore();
    spy2.mockRestore();
  });

  it('the interview transcript, when it scrolls, can be reached by the keyboard', () => {
    const proto = HTMLDivElement.prototype;
    const sh = vi.spyOn(proto, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'interview-transcript' ? 900 : 0;
    });
    const ch = vi.spyOn(proto, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('data-testid') === 'interview-transcript' ? 300 : 0;
    });
    mount(
      <Room
        persona={{ name: 'Maya', role: 'product owner' }}
        opening="The report is wrong."
        turns={[]}
        facts={[]}
        outgoing={[]}
        onRetry={() => {}}
        canRetry
        busy={false}
        scrollRef={createRef<HTMLDivElement>()}
      />,
    );
    const transcript = host!.querySelector<HTMLElement>('[data-testid="interview-transcript"]')!;
    expect(transcript.getAttribute('role')).toBe('log');
    expect(transcript.getAttribute('tabindex')).toBe('0');
    sh.mockRestore();
    ch.mockRestore();
  });

  it('is a stable callback ref, so a render does not re-attach it', () => {
    // Count the watches: each one observes its box with a ResizeObserver.
    let watches = 0;
    class Counting {
      constructor() {
        watches += 1;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', Counting);
    const sw = vi.spyOn(HTMLDivElement.prototype, 'scrollWidth', 'get').mockReturnValue(640);
    const cw = vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    function Box({ n }: { n: number }) {
      const forwarded = useScrollFocusRef<HTMLDivElement>();
      return (
        <>
          <div ref={scrollFocusRef} className="overflow-x-auto" data-testid="plain">
            {n}
          </div>
          <div ref={forwarded} className="overflow-x-auto" data-testid="forwarded">
            {n}
          </div>
        </>
      );
    }
    mount(<Box n={1} />);
    expect(watches).toBe(2);
    act(() => root!.render(<Box n={2} />));
    act(() => root!.render(<Box n={3} />));
    expect(watches, 'a render re-attached a watch').toBe(2);
    expect(host!.querySelector('[data-testid="plain"]')!.getAttribute('tabindex')).toBe('0');
    expect(host!.querySelector('[data-testid="forwarded"]')!.getAttribute('tabindex')).toBe('0');
    sw.mockRestore();
    cw.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe('a box that stops scrolling while it holds focus', () => {
  it('keeps its tab stop until focus leaves, so focus does not fall back to the page', () => {
    const el = document.createElement('div');
    el.className = 'overflow-y-auto';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 300, ch: 200, sh: 900 });
    syncScrollFocus(el);
    el.focus();
    expect(document.activeElement).toBe(el);
    // The transcript shrinks (or the window grows) while the learner is on it.
    size(el, { cw: 300, sw: 300, ch: 900, sh: 900 });
    expect(syncScrollFocus(el)).toBe(false);
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(el);
    el.blur();
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.remove();
  });

  it('keeps the tab stop if the box scrolls again before focus leaves', () => {
    const el = document.createElement('div');
    el.className = 'overflow-y-auto';
    document.body.appendChild(el);
    size(el, { cw: 300, sw: 300, ch: 200, sh: 900 });
    syncScrollFocus(el);
    el.focus();
    size(el, { cw: 300, sw: 300, ch: 900, sh: 900 });
    syncScrollFocus(el);
    size(el, { cw: 300, sw: 300, ch: 200, sh: 900 });
    syncScrollFocus(el);
    el.blur();
    expect(el.getAttribute('tabindex')).toBe('0');
    el.remove();
  });
});

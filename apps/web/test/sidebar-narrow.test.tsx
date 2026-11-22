/**
 * @vitest-environment jsdom
 */
/**
 * A pinned sidebar gives its width back below `lg`.
 *
 * A learner who chose "Keep open" is remembered as `full`. Drawn at every
 * width, that 232px column would leave the page 228px at 460px, and with the
 * change page's overflow-hidden main it would cut the Submit button off
 * entirely at 360 and 390px. Below 1024px the remembered `full` is
 * drawn as the rail (in the boot script's first paint, when the route
 * restores it, and when the window narrows past the breakpoint) and the
 * learner's choice is kept, so it comes back when the window is wide again. A
 * learner who presses the toggle on a phone still gets the column they asked
 * for, for that page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_BOOT_SCRIPT,
  SIDEBAR_IDE_KEY,
  SIDEBAR_KEY,
  appliedSidebar,
  useSidebar,
  type SidebarState,
} from '@/lib/sidebar';

/** A window `width` pixels wide, as matchMedia answers for the lg query. */
let width = 1280;
const listeners = new Set<(e: { matches: boolean }) => void>();
function stubWidth() {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = () => (max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false);
    return {
      get matches() {
        return matches();
      },
      media: query,
      addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
      addListener: (fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeListener: (fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
    };
  });
}
function resizeTo(next: number) {
  width = next;
  for (const fn of [...listeners]) fn({ matches: next <= 1023 });
}

const boot = (pathname: string): void => {
  window.history.replaceState({}, '', pathname);
  document.documentElement.removeAttribute('data-sidebar');
  // eslint-disable-next-line no-new-func
  new Function(SIDEBAR_BOOT_SCRIPT)();
};

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-sidebar');
  listeners.clear();
  width = 1280;
  stubWidth();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the boot script draws a pinned sidebar as the rail below lg', () => {
  it('keeps the column at 1024px and wider', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    width = 1024;
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('full');
  });

  it.each([360, 390, 460, 500, 820, 1023])('draws the rail at %ipx, on a document page and a working page', (w) => {
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    window.localStorage.setItem(SIDEBAR_IDE_KEY, 'full');
    width = w;
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
    boot('/workspace/abc/change');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('rail');
    // The learner's choice is kept for a wide window.
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('full');
    expect(window.localStorage.getItem(SIDEBAR_IDE_KEY)).toBe('full');
  });

  it('still boots where matchMedia is missing', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('matchMedia', undefined);
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    boot('/dashboard');
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('full');
  });
});

describe('useSidebar follows the breakpoint', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  let state: SidebarState | null = null;
  function Probe({ path }: { path: string }) {
    state = useSidebar(path);
    return null;
  }
  const mount = (path: string) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Probe path={path} />));
  };
  afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    state = null;
  });

  it('restores a pinned column as the rail on a phone, and gives it back on a wide window', () => {
    window.localStorage.setItem(SIDEBAR_IDE_KEY, 'full');
    width = 390;
    mount('/workspace/abc/change');
    expect(appliedSidebar()).toBe('rail');
    expect(state!.rail).toBe(true);
    act(() => resizeTo(1280));
    expect(appliedSidebar()).toBe('full');
    expect(state!.rail).toBe(false);
    act(() => resizeTo(460));
    expect(appliedSidebar()).toBe('rail');
    expect(window.localStorage.getItem(SIDEBAR_IDE_KEY)).toBe('full');
  });

  it('a learner who presses the toggle on a phone gets the column for that page', () => {
    width = 390;
    mount('/dashboard');
    expect(appliedSidebar()).toBe('rail');
    act(() => state!.toggle());
    expect(appliedSidebar()).toBe('full');
    expect(state!.rail).toBe(false);
    act(() => state!.toggle());
    expect(appliedSidebar()).toBe('rail');
    expect(state!.rail).toBe(true);
  });

  // A press below `lg` is for that page. Writing it would put a
  // phone's open-then-close ('rail') over the column the learner chose on a
  // wide window, and a phone draws a stored 'full' as the rail anyway.
  it('a press on a phone does not overwrite the width chosen on a wide window', () => {
    window.localStorage.setItem(SIDEBAR_KEY, 'full');
    width = 390;
    mount('/dashboard');
    expect(appliedSidebar()).toBe('rail');
    act(() => state!.toggle());
    expect(appliedSidebar()).toBe('full');
    act(() => state!.toggle());
    expect(appliedSidebar()).toBe('rail');
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('full');
    act(() => resizeTo(1280));
    expect(appliedSidebar()).toBe('full');
  });

  it('a press on a wide window is still remembered', () => {
    width = 1280;
    mount('/dashboard');
    expect(appliedSidebar()).toBe('rail');
    act(() => state!.toggle());
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe('full');
  });
});

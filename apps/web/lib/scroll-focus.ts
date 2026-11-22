'use client';

/**
 * A box that scrolls can be scrolled from the keyboard (WCAG 2.1.1; axe
 * `scrollable-region-focusable`).
 *
 * A pointer scrolls any overflowing box. A keyboard scrolls only the box that
 * holds focus, so a scroller with nothing focusable inside (a table of
 * results, a transcript, a diagram, a document pane) hides what is past its
 * edge from anybody without a mouse. An accessibility audit found 26 such
 * boxes on 15 pages.
 *
 * The answer is the one the product already uses where it draws a scroller on
 * purpose (`ScrollRegion`, `ConceptDiagram`, the Agentic diff): `tabIndex=0`.
 * The difference here is *when*. These boxes scroll at some widths and not at
 * others (the dossier's tables fit a laptop and scroll on a phone) so a box
 * joins the tab order while it actually scrolls and leaves it when its content
 * fits again, and a page whose tables fit gains no tab stops. The global focus
 * ring (`globals.css`, `[tabindex]:focus-visible`) draws it.
 *
 * A box whose markup already set a `tabindex` is left alone: that is somebody's
 * decision about its tab order, and this never takes it over.
 */
import { useCallback, useRef, type Ref, type RefObject } from 'react';

/** The boxes this module put in the tab order, so it only ever removes its own. */
const owned = new WeakSet<Element>();
/** Boxes that stopped scrolling while focused: their tab stop waits for the blur. */
const leaving = new WeakSet<Element>();

const scrollsOn = (value: string) => value === 'auto' || value === 'scroll' || value === 'overlay';

/**
 * Whether `el` scrolls right now, and its tab stop set to match. An axis counts
 * only when the box scrolls on it (`overflow: hidden` clips, it does not
 * scroll) and only when there is more than a rounding pixel behind the edge.
 */
export function syncScrollFocus(el: HTMLElement): boolean {
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
  const x = style ? scrollsOn(style.overflowX) : false;
  const y = style ? scrollsOn(style.overflowY) : false;
  const scrolls =
    (x && el.scrollWidth - el.clientWidth > 1) || (y && el.scrollHeight - el.clientHeight > 1);
  if (scrolls) {
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '0');
      owned.add(el);
    }
  } else if (owned.has(el)) {
    // Taking the tab stop from the box that holds focus would drop focus to
    // <body> and lose the learner's place; it goes when they move on.
    if (typeof document !== 'undefined' && document.activeElement === el) {
      if (!leaving.has(el)) {
        leaving.add(el);
        el.addEventListener(
          'blur',
          () => {
            leaving.delete(el);
            // Unless the watch already ended and took the tab stop back.
            if (owned.has(el)) syncScrollFocus(el);
          },
          { once: true },
        );
      }
    } else {
      el.removeAttribute('tabindex');
      owned.delete(el);
    }
  }
  return scrolls;
}

/**
 * Keep `el`'s tab stop true while its size or content changes. Returns the
 * cleanup, which takes back a tab stop this put there.
 */
export function watchScrollFocus(el: HTMLElement): () => void {
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null || typeof requestAnimationFrame !== 'function') return;
    frame = requestAnimationFrame(() => {
      frame = null;
      syncScrollFocus(el);
    });
  };
  syncScrollFocus(el);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  const observeChildren = () => {
    if (!resize) return;
    for (const child of Array.from(el.children)) resize.observe(child);
  };
  resize?.observe(el);
  observeChildren();
  const mutation =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          observeChildren();
          schedule();
        })
      : null;
  mutation?.observe(el, { childList: true, subtree: true, characterData: true });
  window.addEventListener('resize', schedule);
  return () => {
    resize?.disconnect();
    mutation?.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    if (owned.has(el)) {
      el.removeAttribute('tabindex');
      owned.delete(el);
    }
  };
}

/**
 * For a scroller with no ref of its own: `ref={scrollFocusRef}`. A module
 * function, so its identity never changes and a render never re-attaches it;
 * React 19 runs the returned cleanup when the node leaves.
 */
export function scrollFocusRef(el: HTMLElement | null): (() => void) | undefined {
  return el ? watchScrollFocus(el) : undefined;
}

/**
 * For a scroller that already has a ref another hook reads (an edge fade, the
 * pinned-to-newest thread, a width measurement): a callback ref that watches
 * the node and hands it on to `forward`, stable for as long as `forward` is.
 * A callback `forward` is called with the node and with `null`, as React would.
 */
export function useScrollFocusRef<T extends HTMLElement>(forward?: Ref<T> | RefObject<T | null>): (el: T | null) => void {
  const stop = useRef<(() => void) | null>(null);
  return useCallback(
    (el: T | null) => {
      stop.current?.();
      stop.current = el ? watchScrollFocus(el) : null;
      if (typeof forward === 'function') forward(el);
      else if (forward) (forward as { current: T | null }).current = el;
    },
    [forward],
  );
}

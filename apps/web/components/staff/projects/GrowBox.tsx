'use client';

/**
 * A text box of the teacher's editor that shows its text.
 *
 * The Brief, the Background and the other long fields of the builders' cards
 * hold texts a pack fills with seven paragraphs or more; at two or three rows a
 * click would land in the middle of the text with its end out of view. Drawn
 * as a `GrowBox`, such a field is as tall as its text, grows as the
 * teacher types, and stops at {@link GROW_BOX_MAX_ROWS} rows; past that it
 * scrolls inside. It never draws shorter than the `rows` it is given, and a box the teacher dragged taller with the resize
 * handle stays at least that tall.
 *
 * One rule for every such field: {@link growBoxHeight} is the arithmetic and
 * {@link fitGrowBox} the measuring, so a box in one card can never follow a
 * different cap from the same field in another. jsdom lays nothing out (its
 * `scrollHeight` is 0), so there the box is left exactly as React drew it.
 */
import { forwardRef, useCallback, useEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/** The tallest a growing box gets, in rows of its own text: about two screens of a card on a laptop are never one field. */
export const GROW_BOX_MAX_ROWS = 16;

/** What `growBoxHeight` reads off a box, every length in CSS pixels. */
interface GrowBoxMeasure {
  /** The box's `scrollHeight` with its height set to `auto`: its text and padding, never less than its `rows`. */
  scrollHeight: number;
  lineHeight: number;
  /** Top plus bottom padding. */
  paddingBlock: number;
  /** Top plus bottom border. */
  borderBlock: number;
  maxRows: number;
  /** A height the teacher dragged the box to, which it keeps as its least. */
  dragged?: number;
}

/**
 * The rule: as tall as the text (border-box), at most `maxRows` rows of text
 * plus the box's padding and border, and at least a height the teacher
 * dragged it to. `scrolls` is whether text sits past the box's foot.
 */
export function growBoxHeight(m: GrowBoxMeasure): { height: number; scrolls: boolean } {
  const whole = m.scrollHeight + m.borderBlock;
  const cap = Math.ceil(m.lineHeight * m.maxRows + m.paddingBlock + m.borderBlock);
  const height = Math.max(Math.min(whole, cap), m.dragged ?? 0);
  return { height, scrolls: whole > height };
}

const px = (value: string) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The height this module last gave a box, in pixels, so a height the resize
 * handle set can be told apart. Kept as a number and compared within half a
 * pixel: the browser may write a fractional height back with fewer digits
 * than it was given, and that is still ours, not a drag.
 */
const given = new WeakMap<HTMLTextAreaElement, number>();
/** Half a pixel: a height this close to the one last given is the one last given. */
const SAME_HEIGHT = 0.5;
/** The height the teacher last dragged a box to with the resize handle. */
const draggedTo = new WeakMap<HTMLTextAreaElement, number>();

/** The scrolled boxes around `el` and their scroll positions, so measuring never moves the page. */
function scrollPositions(el: HTMLElement): [Element, number][] {
  const out: [Element, number][] = [];
  for (let up = el.parentElement; up; up = up.parentElement) {
    const overflow = getComputedStyle(up).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && up.scrollTop > 0) out.push([up, up.scrollTop]);
  }
  const page = typeof document !== 'undefined' ? document.scrollingElement : null;
  if (page && page.scrollTop > 0) out.push([page, page.scrollTop]);
  return out;
}

/** Measure `el` and set its height and overflow by the rule. */
export function fitGrowBox(el: HTMLTextAreaElement, maxRows: number = GROW_BOX_MAX_ROWS): void {
  const style = getComputedStyle(el);
  const before = el.style.height;
  const styled = el.hasAttribute('style');
  // A height the handle set (not ours, not none) is the teacher's least from now on.
  const last = given.get(el);
  if (before && (last === undefined || Math.abs(px(before) - last) > SAME_HEIGHT)) draggedTo.set(el, px(before));
  const dragged = draggedTo.get(el);
  const kept = scrollPositions(el);
  el.style.height = 'auto';
  const scrollHeight = el.scrollHeight;
  if (scrollHeight === 0) {
    // Not laid out (hidden, or jsdom): leave the box exactly as it was drawn.
    el.style.height = before;
    if (!styled) el.removeAttribute('style');
    return;
  }
  const fontSize = px(style.fontSize) || 14;
  const lineHeight = px(style.lineHeight) || fontSize * 1.2;
  const { height, scrolls } = growBoxHeight({
    scrollHeight,
    lineHeight,
    paddingBlock: px(style.paddingTop) + px(style.paddingBottom),
    borderBlock: px(style.borderTopWidth) + px(style.borderBottomWidth),
    maxRows,
    dragged,
  });
  el.style.height = `${height}px`;
  el.style.overflowY = scrolls ? 'auto' : 'hidden';
  given.set(el, height);
  for (const [box, top] of kept) if (box.scrollTop !== top) box.scrollTop = top;
}

/**
 * Keep `ref`'s box fitted: on every change of `value`, before paint; when its
 * width changes (a window resized), in the next frame; and when the page's
 * fonts have loaded, since a font that swaps in after the first fit wraps the
 * same text onto more lines, and the last of them would be cut until the next
 * keystroke. A refit only sets the box's height: the scroll is put back and
 * the focus and caret are never touched.
 */
function useGrowBox(ref: { current: HTMLTextAreaElement | null }, value: unknown, maxRows: number = GROW_BOX_MAX_ROWS): void {
  useIsoLayoutEffect(() => {
    if (ref.current) fitGrowBox(ref.current, maxRows);
  }, [ref, value, maxRows]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    let width = el.clientWidth;
    let frame: number | null = null;
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // In the next frame: a size set inside the observer's own callback would loop it.
      if (frame === null) {
        frame = requestAnimationFrame(() => {
          frame = null;
          fitGrowBox(el, maxRows);
        });
      }
    });
    watch.observe(el);
    return () => {
      watch.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref, maxRows]);

  // The fonts: once those loading now are in (`ready`), and again whenever a later one finishes
  // (`loadingdone`). An engine with no `document.fonts` keeps the other two refits.
  useEffect(() => {
    const el = ref.current;
    const fonts = typeof document !== 'undefined' ? (document as { fonts?: FontFaceSet }).fonts : undefined;
    if (!el || !fonts) return;
    let live = true;
    const refit = () => {
      if (live) fitGrowBox(el, maxRows);
    };
    fonts.ready?.then(refit, () => undefined);
    fonts.addEventListener?.('loadingdone', refit);
    return () => {
      live = false;
      fonts.removeEventListener?.('loadingdone', refit);
    };
  }, [ref, maxRows]);
}

/** A `<textarea>` that follows the rule; every other attribute is the caller's, as written. */
export const GrowBox = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number }>(
  function GrowBox({ maxRows = GROW_BOX_MAX_ROWS, ...props }, forwarded) {
    const own = useRef<HTMLTextAreaElement | null>(null);
    useGrowBox(own, props.value, maxRows);
    const ref = useCallback(
      (el: HTMLTextAreaElement | null) => {
        own.current = el;
        if (typeof forwarded === 'function') forwarded(el);
        else if (forwarded) forwarded.current = el;
      },
      [forwarded],
    );
    return <textarea ref={ref} {...props} />;
  },
);

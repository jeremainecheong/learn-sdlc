'use client';

/**
 * Scroll positions kept across the Code / Results switch.
 *
 * The focused mode and Implementation's full-height results show the editor or
 * the results by `display:none` on the other, so nothing unmounts. Chromium
 * keeps no scroll offset for a box that is not rendered: a results tab the
 * learner had scrolled to its third failure came back at the top after a look
 * at the code. This hook remembers, for every native scroll container inside
 * the column, where the learner last left it, and after each switch puts back
 * any that the switch moved. A container that stayed on screen already holds
 * what was remembered, so it is left alone.
 *
 * The editor is not one of them: Monaco scrolls its own view (no native
 * scrollTop) and keeps it in its own view model across a hide, and a jump made
 * while it is hidden (a reveal from the results, a file opened from them) must
 * stand, so nothing here or in CodeEditor puts an older position back.
 */

import { useEffect, useRef, type RefObject } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/** Whether this element is drawn (an element under `display:none` has no boxes). */
const drawn = (node: Element) => node.getClientRects().length > 0;

/**
 * Put back the remembered positions of every drawn container the switch moved.
 * Returns how many it moved (for the tests).
 */
export function restoreScroll(kept: Map<Element, number>): number {
  let moved = 0;
  for (const [node, top] of kept) {
    if (!node.isConnected) {
      kept.delete(node);
      continue;
    }
    if (!drawn(node) || Math.abs(node.scrollTop - top) < 1) continue;
    node.scrollTop = top;
    moved += 1;
  }
  return moved;
}

export function useScrollKeeper(rootRef: RefObject<HTMLElement | null>, view: string): void {
  const kept = useRef(new Map<Element, number>());

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onScroll = (event: Event) => {
      const node = event.target;
      if (!(node instanceof Element) || node.closest('.monaco-editor')) return;
      // A container that has just been hidden reads 0 and is not drawn; that is
      // not the learner's position.
      if (!drawn(node)) return;
      kept.current.set(node, node.scrollTop);
    };
    // `scroll` does not bubble from an element; it is heard in the capture phase.
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, [rootRef]);

  const first = useRef(true);
  useIsoLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    restoreScroll(kept.current);
    // Content that lays out a frame later (a results table, a long log) can be
    // too short to take the position at once; try again once it has.
    if (typeof window === 'undefined') return;
    const frame = window.requestAnimationFrame(() => restoreScroll(kept.current));
    return () => window.cancelAnimationFrame(frame);
  }, [view]);
}

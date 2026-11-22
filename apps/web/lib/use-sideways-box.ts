'use client';

/**
 * A box's own width, and whether what it holds is wider than it (so it scrolls sideways), kept current as either
 * changes.
 *
 * A drawing or a grid that needs more room than its column gives it first fits itself to the room (a grid moves a
 * column, a drawing scales down to a floor where its words stay legible); only past that does its box scroll, and
 * then it says so in a line above the box (in view with the first rows), so nothing is cut without a
 * word. Both decisions read this measure.
 *
 * Measured before paint (a layout effect in the browser) and again whenever the box or its content changes size.
 * Zero and false until measured: on the server, and in a test without layout, the box is drawn unmeasured.
 */
import { useCallback, useState } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

export interface SidewaysBox {
  ref: (node: HTMLElement | null) => void;
  /** The box's inner width in CSS px; 0 until measured. */
  width: number;
  /** The content is wider than the box by more than a rounding pixel. */
  scrolls: boolean;
}

export function useSidewaysBox(): SidewaysBox {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [state, setState] = useState({ width: 0, scrolls: false });
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);
  useIsoLayoutEffect(() => {
    if (!node || typeof window === 'undefined') return;
    const measure = () => {
      const width = node.clientWidth;
      const scrolls = width > 0 && node.scrollWidth - width > 1;
      setState((prev) => (prev.width === width && prev.scrolls === scrolls ? prev : { width, scrolls }));
    };
    measure();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resize?.observe(node);
    for (const child of Array.from(node.children)) resize?.observe(child);
    window.addEventListener('resize', measure);
    return () => {
      resize?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [node]);
  return { ref, ...state };
}

/** The line above a box that scrolls sideways: what is past its edge, and how to reach it. */
export function sidewaysCue(what: string): string {
  return `Scroll sideways to see ${what}.`;
}

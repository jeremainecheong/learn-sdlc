'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Mount on the first visit, then keep draft fields and native scroll state. */
export function RetainedWorkspaceView({ active, children, className = '' }: {
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;
  return <div hidden={!active} className={className} style={!active ? { display: 'none' } : undefined}>{children}</div>;
}

function scrollContainer(node: HTMLElement | null): HTMLElement | null {
  for (let current = node; current; current = current.parentElement) {
    // Specialized phase pages scroll their content on desktop and the working
    // room on mobile. Never turn a clipped frame into an extra scroller.
    if (/^(auto|scroll)$/.test(getComputedStyle(current).overflowY)) return current;
  }
  return null;
}

/** Each tab keeps its reading position without animating layout or moving focus. */
export function useWorkspaceViewScroll<T extends string>(initial: T) {
  const [view, setView] = useState(initial);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const positions = useRef(new WeakMap<HTMLElement, Map<T, { top: number; left: number }>>());
  const selecting = useRef(false);
  const focusAfterSelection = useRef<string | null>(null);
  const select = useCallback((next: T, focusId?: string) => {
    if (next === view) return;
    const host = scrollContainer(contentRef.current);
    if (host) {
      let saved = positions.current.get(host);
      if (!saved) { saved = new Map(); positions.current.set(host, saved); }
      saved.set(view, { top: host.scrollTop, left: host.scrollLeft });
    }
    selecting.current = true;
    focusAfterSelection.current = focusId ?? null;
    setView(next);
  }, [view]);
  useLayoutEffect(() => {
    if (!selecting.current) return;
    selecting.current = false;
    const host = scrollContainer(contentRef.current);
    if (host) {
      const saved = positions.current.get(host)?.get(view);
      host.scrollTop = saved?.top ?? 0;
      host.scrollLeft = saved?.left ?? 0;
    }
    if (focusAfterSelection.current) document.getElementById(focusAfterSelection.current)?.focus({ preventScroll: true });
    focusAfterSelection.current = null;
  }, [view]);
  return { view, select, contentRef };
}

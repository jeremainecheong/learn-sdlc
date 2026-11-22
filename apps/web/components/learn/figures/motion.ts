'use client';
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(notify: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener?.('change', notify);
  return () => list.removeEventListener?.('change', notify);
}

/** True when the reader asked the system for reduced motion. Figures mark
 * themselves `data-motion="reduce"` from it, and the CSS also honours the
 * media query directly, so motion stops even before hydration. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches,
    () => false,
  );
}

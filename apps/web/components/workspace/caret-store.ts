'use client';

import { useSyncExternalStore } from 'react';

/** Where the caret is in the open file: 1-based line and column. */
export interface Caret {
  line: number;
  col: number;
}

/**
 * The editor's caret, held outside the IDE page's state.
 *
 * Monaco reports the caret on every character. Kept as page state, each report
 * would be a new `{ line, col }` and the whole IDE page, explorer, tabs, activity
 * bar, panels, would render again per keystroke for two numbers in the status
 * bar. A store lets the one reader that shows both numbers subscribe to them
 * alone; the page keeps only what it derives from the caret (the line).
 */
export interface CaretStore {
  get: () => Caret;
  set: (next: Caret) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createCaretStore(initial: Caret): CaretStore {
  let caret = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => caret,
    set: (next) => {
      if (next.line === caret.line && next.col === caret.col) return;
      caret = { line: next.line, col: next.col };
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The caret as React state, for the one component that draws it. */
export function useCaret(store: CaretStore): Caret {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

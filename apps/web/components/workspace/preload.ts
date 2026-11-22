'use client';

/**
 * The editor's chunk, loaded once and then held in memory.
 *
 * Monaco is the largest thing this product loads. The workspace loads it
 * through `dynamic()`, and also calls {@link preloadEditor} once it has drawn,
 * so the chunk is in memory for the next visit to a workspace in the same page
 * load, which then renders the editor in its first commit
 * ({@link loadedEditor}) instead of behind the lazy placeholder.
 *
 * The import is the same specifier the workspace's `dynamic()` call uses, so
 * webpack hands both of them the same chunk and the second call resolves from
 * memory. A failure is silent: an editor that was not preloaded is still
 * loaded by `dynamic()` when it is drawn.
 */
// Type-only: erased at build time, so naming the component here does not pull
// its chunk into whatever page imports this module.
import type { CodeEditor } from './CodeEditor';

let loaded: typeof CodeEditor | null = null;

/** Resolves when the editor chunk is in memory. Starts the load on first call. */
export function preloadEditor(): Promise<unknown> {
  if (typeof window === 'undefined') return Promise.resolve();
  return import('@/components/workspace/CodeEditor')
    .then((m) => {
      loaded = m.CodeEditor;
      return m;
    })
    .catch(() => undefined);
}

/**
 * The editor itself, when its chunk is already in memory.
 *
 * The workspace loads it through `dynamic()`, which suspends for at least a
 * tick even when there is nothing left to fetch: long enough to commit one
 * frame of "Loading editor…" over a code column that could have been drawn.
 * A page that has been warmed reads the component from here instead and
 * renders it in the same commit as the rest of the room.
 */
export function loadedEditor(): typeof CodeEditor | null {
  return loaded;
}

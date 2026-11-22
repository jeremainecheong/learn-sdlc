'use client';

/**
 * Whether the phase tutorial is open right now.
 *
 * `PhaseTutorialProvider` feeds it from CoachMarks' `onOpenChange` and
 * re-exports the hook, so the quick-check card can wait for the tutorial
 * instead of showing under it. It lives in its own module so a test that
 * stands in for the provider module still gives the card a working hook
 * (false: no tutorial, nothing to wait for).
 */
import { createContext, useContext } from 'react';

export const PhaseTutorialOpenContext = createContext(false);

/** True while the phase tutorial's dialog is open; false outside a provider. */
export function usePhaseTutorialOpen(): boolean {
  return useContext(PhaseTutorialOpenContext);
}

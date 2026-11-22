/**
 * The replay bus: Show me around and Replay tutorial ask the tour registered
 * for the page or the phase to open again.
 */
export const TOUR_EVENT = 'lsdlc:tour';

const replays = new Map<symbol, { run: () => void; priority: number }>();

const dispatchReplay = () => [...replays.values()].sort((a, b) => b.priority - a.priority)[0]?.run();

/** One replay recipient: a ready phase takes priority over the shell's page fallback. */
export function registerTourReplay(run: () => void, priority = 0): () => void {
  const id = Symbol('tour-replay');
  if (!replays.size) window.addEventListener(TOUR_EVENT, dispatchReplay);
  replays.set(id, { run, priority });
  return () => { replays.delete(id); if (!replays.size) window.removeEventListener(TOUR_EVENT, dispatchReplay); };
}

export function replayTour(): void { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(TOUR_EVENT)); }

/**
 * Whether a second ask may be sent inside the route's budget: at least
 * `floorMs`, and at least as long as the first ask itself took plus `marginMs`,
 * must be left. A slow first ask (a queue at the AI gate, a slow provider)
 * says a second may be as slow, and one that cannot finish would only make the
 * learner wait to the deadline for the same refused answer.
 */
export const reaskFits = (remainingMs: number, firstMs: number, floorMs: number, marginMs: number): boolean =>
  remainingMs >= Math.max(floorMs, firstMs + marginMs);

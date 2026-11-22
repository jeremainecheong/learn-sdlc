/**
 * How wide the function graphs (Implementation's call graph, Maintenance's
 * impact graphs) are laid out: the width their box measured, never narrower
 * than the floor, and the fallback while the box has not been measured yet.
 */

/** The narrowest a graph is laid out, whatever its box measures. */
export const GRAPH_MIN_WIDTH = 280;
/** The width a graph is laid out at before its box has been measured. */
export const GRAPH_FALLBACK_WIDTH = 320;

/** The width to lay a graph out at, from its box's measured width (0 while unmeasured). */
export const graphWidth = (measured: number) => Math.max(GRAPH_MIN_WIDTH, measured || GRAPH_FALLBACK_WIDTH);

/**
 * The first line of a test or analyzer message, which carries the point (the
 * rest is the trace): the message trimmed, then its first line. A line longer
 * than `max` characters is cut at `max`, the spaces the cut leaves at its end
 * are dropped, and an ellipsis is added.
 */
export function messageHead(text: string | undefined, max: number): string {
  const first = (text ?? '').trim().split('\n')[0];
  return first.length > max ? `${first.slice(0, max).trimEnd()}…` : first;
}

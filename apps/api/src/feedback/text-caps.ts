/**
 * Small text helpers the report builders share.
 *
 * A capped line keeps `max - 1` characters and an ellipsis, so the whole line,
 * ellipsis included, is never longer than `max`.
 */

/** `text` as it is when it fits in `max` characters, otherwise its first `max - 1` and an ellipsis. */
export function capWithEllipsis(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A string as it is, and anything else as the empty string. */
export const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

import { randomBytes } from 'crypto';

/**
 * A submission id that sorts in the order the rows were written.
 *
 * Every reader of this table orders by `(createdAt, id)`: `FeedbackService.latestFor`,
 * `listFor`, `attemptNumber`, and `newestSubmissionsPerPhaseState` in
 * `analytics.service.ts`, which even casts the id to text so both dialects
 * agree. That is deliberate and it is one ordering, but on sqlite `createdAt`
 * is stored to the second, so a learner who submits, edits and submits again
 * inside one second writes two rows the clock cannot separate, and a random
 * v4 uuid then decides which one is "last", by a coin flip. The Feedback tab
 * of a passed phase can therefore show the failing verdict that came first,
 * beside a gate banner that says the phase passed, from two rows a second
 * apart in the log and the same stored timestamp on both.
 *
 * So the id carries the time: a UUID version 7, 48 bits of milliseconds since
 * the epoch, then the version and variant bits, then randomness. Canonical
 * lower-case hex sorts the same way Postgres compares the sixteen bytes, so
 * `ORDER BY id` and `MAX(CAST(id AS text))` both become chronological without
 * any reader changing. Older rows may carry v4 ids, but each sits in its own
 * second, and two rows in one second are always both v7, so the two
 * generations never have to be compared.
 *
 * Two submissions inside one *millisecond* are still ordered by chance, and
 * that is honest: for one phase state they cannot happen, because
 * `UQ_submissions_in_flight` holds the phase's one grading slot until the
 * first has a verdict.
 */
export function submissionId(at: number = Date.now()): string {
  const ms = Math.max(0, Math.floor(at)).toString(16).padStart(12, '0').slice(-12);
  const rest = randomBytes(10);
  rest[0] = (rest[0] & 0x0f) | 0x70; // byte 6: version 7
  rest[2] = (rest[2] & 0x3f) | 0x80; // byte 8: the RFC 4122 variant
  const hex = ms + rest.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

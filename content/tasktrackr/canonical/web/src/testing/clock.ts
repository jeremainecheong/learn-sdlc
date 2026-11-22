/**
 * The clock your front-end tests read, and the twin of tests/clock.py.
 *
 * A test that hard-codes "2026-03-14" rots the day the fixture moves. A test
 * that reads the machine's clock is a different test every morning. Both
 * suites ask this one function instead, and the Run clock control pins it by
 * setting LEARNSDLC_NOW for the whole run.
 */

/** The day this run is happening on, as an ISO date: "2026-03-14". */
export function today(): string {
  const pinned =
    typeof process !== 'undefined' && process.env ? process.env.LEARNSDLC_NOW : undefined;
  const at = pinned ? new Date(pinned) : new Date();
  return at.toISOString().slice(0, 10);
}

/** `n` days before the pinned day, as an ISO date. Negative n is the future. */
export function daysAgo(n: number): string {
  const at = new Date(`${today()}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - n);
  return at.toISOString().slice(0, 10);
}

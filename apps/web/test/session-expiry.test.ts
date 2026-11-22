/**
 * Reading the hour off the session the API minted.
 *
 * A managed deployment signs a token that lives one hour, and without a
 * warning the hour can end under a learner half-way through a submission.
 * The only fact the browser holds
 * is the `exp` claim already inside the token, and reading it is a decision
 * about a line of text, never an authorisation one: the API re-verifies every
 * request. So these functions are deliberately generous: a token they cannot
 * read means no warning, never a sign-out.
 *
 * Node environment: nothing here touches a DOM, a store, or any token beyond
 * the string it is handed. Every token below is an obvious fake with no
 * signature.
 */
import { describe, expect, it } from 'vitest';
import { EXPIRY_WARN_MS, expiryState, minutesLeftLabel, tokenExpiresAt } from '@/lib/session-expiry';

/** A JWT-shaped string carrying the given payload and no real signature. */
function fakeToken(payload: Record<string, unknown>): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.not-a-signature`;
}

const NOW = Date.UTC(2026, 8, 17, 9, 0, 0);

describe('the hour a session has left', () => {
  it('reads the hour off the token the API minted', () => {
    const seconds = Math.floor(NOW / 1000) + 3_600;
    expect(tokenExpiresAt(fakeToken({ sub: 'learner-fake-id', ver: 1, exp: seconds }))).toBe(seconds * 1000);
  });

  it('reads a payload with characters outside ASCII in it', () => {
    // Some deployments put a display name in the payload. base64url is bytes,
    // not characters, so the decode has to come back through UTF-8 or the
    // JSON will not parse and a live session would be told nothing.
    const seconds = Math.floor(NOW / 1000) + 60;
    expect(tokenExpiresAt(fakeToken({ name: 'Adá Lovelacé', exp: seconds }))).toBe(seconds * 1000);
  });

  it('says nothing about a token it cannot read', () => {
    expect(tokenExpiresAt(null)).toBeNull();
    expect(tokenExpiresAt('')).toBeNull();
    expect(tokenExpiresAt('onesegment')).toBeNull();
    expect(tokenExpiresAt('not.a.jwt')).toBeNull();
    expect(tokenExpiresAt(fakeToken({ sub: 'learner-fake-id' }))).toBeNull();
    expect(tokenExpiresAt(fakeToken({ exp: 'soon' }))).toBeNull();
    // JSON has no infinity, so this arrives as null: still not a number.
    expect(tokenExpiresAt(fakeToken({ exp: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it('calls the session live outside the last five minutes', () => {
    expect(expiryState(NOW + 10 * 60_000, NOW)).toBe('live');
  });

  it('calls it ending inside the last five minutes', () => {
    expect(expiryState(NOW + 4 * 60_000, NOW)).toBe('ending');
    expect(expiryState(NOW + EXPIRY_WARN_MS, NOW)).toBe('ending');
    expect(expiryState(NOW + EXPIRY_WARN_MS + 1, NOW)).toBe('live');
  });

  it('calls it ended once the hour is up', () => {
    expect(expiryState(NOW - 1, NOW)).toBe('ended');
    expect(expiryState(NOW, NOW)).toBe('ended');
  });

  it('has nothing to say without an expiry it can read', () => {
    expect(expiryState(null, NOW)).toBe('unknown');
  });

  it('never counts down to zero minutes', () => {
    // This lands in a polite live region, where a precise countdown is read
    // out again on every change, and "0 minutes" is a sentence the product
    // should never write, so the last minute has a phrase of its own.
    const label = minutesLeftLabel(NOW + 20_000, NOW);
    expect(label).toContain('less than a minute');
    expect(label).not.toMatch(/0\s*minute/);
    expect(minutesLeftLabel(NOW + 60_000, NOW)).toBe('about 1 minute');
    expect(minutesLeftLabel(NOW + 4 * 60_000, NOW)).toBe('about 4 minutes');
    expect(minutesLeftLabel(NOW - 5_000, NOW)).toContain('less than a minute');
  });
});

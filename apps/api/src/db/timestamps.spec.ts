import { isoOrEmpty, isoOrNull, isoText, normalisedIso } from './timestamps';

describe('the stored-timestamp helpers', () => {
  const date = new Date('2026-03-01T09:14:00.000Z');
  const stored = '2026-03-01 09:14:00';

  it('write a Date as ISO text and keep a stored string as it is', () => {
    for (const helper of [isoText, isoOrNull, isoOrEmpty]) {
      expect(helper(date)).toBe('2026-03-01T09:14:00.000Z');
      expect(helper(stored)).toBe(stored);
    }
  });

  it('give each its own answer for a missing value', () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(undefined)).toBeNull();
    expect(isoOrEmpty(null)).toBe('');
    expect(isoOrEmpty(undefined)).toBe('');
  });

  it('normalise a parseable string to ISO and keep an unparseable one as written', () => {
    expect(normalisedIso(date)).toBe('2026-03-01T09:14:00.000Z');
    expect(normalisedIso('2026-03-01T09:14:00Z')).toBe('2026-03-01T09:14:00.000Z');
    expect(normalisedIso('not a date')).toBe('not a date');
    expect(normalisedIso('')).toBeNull();
    expect(normalisedIso(null)).toBeNull();
  });
});

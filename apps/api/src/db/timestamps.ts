/** An hour in milliseconds. */
export const HOUR_MS = 3_600_000;

/** A day in milliseconds. */
export const DAY_MS = 86_400_000;

/**
 * A timestamp column as a driver hands it back: PostgreSQL gives a Date,
 * sqlite gives the stored string.
 */
type StoredStamp = Date | string | null | undefined;

/** A Date as ISO text, a string as stored, and null for no value. */
export const isoOrNull = (value: StoredStamp): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : String(value);

/**
 * A NOT NULL timestamp column's value: a Date as ISO text, a string as
 * stored. It has no rule for a missing value, because the column has none.
 */
export const isoText = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** A Date as ISO text, a string as stored, and '' for no value. */
export const isoOrEmpty = (value: StoredStamp): string =>
  value == null ? '' : value instanceof Date ? value.toISOString() : String(value);

/**
 * A timestamp normalised to ISO text: a Date, or a string that parses as a
 * date, is written as ISO; a string that does not parse is kept as written;
 * null, undefined and '' give null.
 */
export function normalisedIso(value: StoredStamp): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

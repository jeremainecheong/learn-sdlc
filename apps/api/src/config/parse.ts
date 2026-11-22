/**
 * Parsers shared by the configuration resolvers. Each returns null for a value
 * that is absent or nonsense, so the caller's own default applies.
 */

/** A positive integer from the environment, or null when the value is absent or nonsense. */
export function positiveInt(raw: string | undefined): number | null {
  const value = Number((raw || '').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** A whole number of zero or more from the environment, or null when the value is absent or nonsense. */
export function nonNegativeInt(raw: string | undefined): number | null {
  const value = (raw || '').trim();
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

/** `32mb`, `512kb`, `2gb` or a plain byte count, in bytes; null for nonsense. */
export function byteSize(raw: string | undefined): number | null {
  const value = (raw || '').trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(value);
  if (!match) return null;
  const units: Record<string, number> = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 };
  const bytes = Math.floor(Number(match[1]) * units[match[2] || 'b']);
  return bytes > 0 ? bytes : null;
}

/**
 * The shape of a row id: a UUID in either case. A route id that does not
 * match is refused or treated as absent before it reaches a query, because
 * PostgreSQL raises on a malformed value for a `uuid` column where sqlite
 * would quietly find nothing.
 *
 * Dependency-free so every module may import it without closing a cycle. The
 * runner identity checks in execution/ use their own lower-case-only
 * patterns on purpose: there a value in upper case is refused.
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether value is a string shaped like a UUID. */
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

import type { AuditEventView } from '@learnsdlc/shared';
import type { EntityManager } from 'typeorm';
import { AuditEventEntity } from '../db/entities';

/**
 * Where a page of the audit trail starts: the row after this one, in
 * `createdAt DESC, id DESC` order.
 */
export interface AuditCursor {
  createdAt: Date;
  id: string;
}

/**
 * The start of the trail; newer than anything that can be in it.
 *
 * Asking for the first page as a range rather than as "no range" keeps one
 * query shape instead of two, and keeps the plan the same on every page:
 * `SEARCH audit_events USING INDEX ((createdAt,id)<(?,?))` rather than a walk
 * of the index on page one and a seek on the rest. The id is the largest uuid
 * there is, which is what the tie-break needs when two rows share a second.
 */
const AUDIT_CURSOR_START: AuditCursor = {
  createdAt: new Date('9999-12-31T23:59:59.999Z'),
  id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};

/**
 * The token that asks for the page after this row. It is `createdAt` and `id`
 * and nothing else (both already on every row the console has been given) so
 * it is opaque to the caller rather than secret, and a stale one is a page
 * boundary that has moved, never an error.
 */
export function auditCursor(
  row: Pick<AuditEventView, 'createdAt' | 'id'>,
): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, 'utf8').toString(
    'base64url',
  );
}

/**
 * A cursor read back, or the start of the trail.
 *
 * Anything unreadable (truncated, hand-edited, from an older format) is the
 * first page rather than a 400, for the reason `auditTake` gives a nonsense
 * limit the default: neither is worth failing a page load over, and a cursor
 * is a position, not an assertion about the data.
 */
export function decodeAuditCursor(
  token: string | undefined | null,
): AuditCursor {
  if (!token) return AUDIT_CURSOR_START;
  const text = Buffer.from(token, 'base64url').toString('utf8');
  const at = text.indexOf('|');
  if (at < 1) return AUDIT_CURSOR_START;
  const createdAt = new Date(text.slice(0, at));
  const id = text.slice(at + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return AUDIT_CURSOR_START;
  return { createdAt, id };
}

/**
 * An account id column, spelled so it can be compared with `users.id`.
 *
 * `users.id` is a `uuid` on Postgres while the columns that reference it
 * carry it as text, and Postgres has no `uuid = text` operator: the join
 * fails with `operator does not exist: uuid = character varying` where
 * sqlite, which has no uuid type at all, compares the two happily. The cast
 * goes on the referencing column rather than on `users.id`, so the lookup is
 * still the primary key. A tombstoned subject is NULL, and `CAST(NULL AS
 * uuid)` is NULL, which matches nobody, which is the right answer for a
 * class view.
 */
export function asUserId(manager: EntityManager, column: string): string {
  return manager.connection.options.type === 'postgres'
    ? `CAST(${column} AS uuid)`
    : column;
}

/**
 * The right-hand side of the keyset's second component, spelled for the
 * dialect.
 *
 * The cursor's id crosses the wire as text. Postgres stores `id` as `uuid`
 * and has no `uuid = text` operator, so the row-value comparison fails with
 * `operator does not exist: uuid = character varying` unless the parameter
 * says what it is; sqlite has no uuid type and would not know what to do
 * with the cast. Casting the *parameter* rather than the column is what
 * keeps the walk on `IDX_audit_events_created`; a cast on `a.id` would put
 * the sort back.
 */
export function cursorIdParam(manager: EntityManager): string {
  return manager.connection.options.type === 'postgres'
    ? 'CAST(:cursorId AS uuid)'
    : ':cursorId';
}

/**
 * A `Date` in the form the driver put in the column, which is the only form
 * it can be compared against. Postgres keeps a timestamp and takes the date
 * itself; sqlite keeps `YYYY-MM-DD HH:MM:SS.mmm` in UTC and would compare an
 * ISO string with its `T` and `Z` as text, wrongly. This is the conversion
 * TypeORM does when it writes the column, asked for by name.
 */
export function storedDate(manager: EntityManager, value: Date): unknown {
  const column = manager.connection
    .getMetadata(AuditEventEntity)
    .findColumnWithPropertyName('createdAt')!;
  return manager.connection.driver.preparePersistentValue(value, column);
}

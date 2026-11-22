import { EntityManager, In } from 'typeorm';
import type { AuditEventView } from '@learnsdlc/shared';
import { AuditEventEntity, UserEntity } from '../db/entities';
import { isoOrEmpty } from '../db/timestamps';

/** What one console page asks for, and the most it may ask for. */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/**
 * How many rows to read. A page is a page: a console that asks for the whole
 * term in one request gets the cap, and a missing or nonsense number gets the
 * default rather than an error, since neither is worth failing a page load over.
 */
export const auditTake = (limit?: number): number =>
  Math.min(
    Math.max(1, Math.trunc(Number(limit ?? AUDIT_DEFAULT_LIMIT)) || AUDIT_DEFAULT_LIMIT),
    AUDIT_MAX_LIMIT,
  );

export interface AuditRow {
  event: AuditEventView['event'];
  actorUserId: string;
  subjectUserId: string;
  targetId?: string | null;
  action?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}

/**
 * One row of the audit trail.
 *
 * The structured log line each caller writes stays exactly where it is: the
 * log stream is what an operator greps while something is on fire, and this
 * table is what an appeal reads six weeks later, when the stream has rotated
 * away and the only question left is who did this, to whom, and why.
 */
export async function recordAudit(manager: EntityManager, row: AuditRow): Promise<void> {
  await manager.save(
    manager.create(AuditEventEntity, {
      event: row.event,
      actorUserId: row.actorUserId,
      subjectUserId: row.subjectUserId,
      targetId: row.targetId ?? null,
      action: row.action ?? null,
      reason: row.reason ?? null,
      detail: row.detail ?? null,
    }),
  );
}

/**
 * Names for the ids, in one query for the whole page. An id alone answers the
 * "what" and none of the "who", and an audit page nobody can read is not one.
 */
export async function auditViews(
  manager: EntityManager,
  rows: AuditEventEntity[],
): Promise<AuditEventView[]> {
  // A tombstoned row carries no subject, and neither In(...) nor the name map
  // will take a null; the row still renders, with a nameless subject.
  const ids = [
    ...new Set(rows.flatMap((row) => [row.actorUserId, row.subjectUserId])),
  ].filter((id): id is string => Boolean(id));
  const people = ids.length
    ? await manager.find(UserEntity, { where: { id: In(ids) }, select: ['id', 'displayName'] })
    : [];
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    actorUserId: row.actorUserId,
    actorName: names.get(row.actorUserId) ?? null,
    subjectUserId: row.subjectUserId,
    subjectName: row.subjectUserId ? names.get(row.subjectUserId) ?? null : null,
    targetId: row.targetId,
    action: row.action,
    reason: row.reason,
    detail: row.detail,
    createdAt: isoOrEmpty(row.createdAt),
  }));
}

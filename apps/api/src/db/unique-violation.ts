/**
 * Both dialects' way of saying "that row already exists": Postgres raises
 * `23505`, better-sqlite3 says `UNIQUE constraint failed` in the message.
 *
 * It lives here rather than beside its first caller because three bounded
 * contexts now insert-and-catch against a unique index: enrolment, the
 * regrade batch and the bell, and a second copy of this detector is how one
 * of them comes to swallow an error that was not a duplicate at all. It has no
 * dependencies on purpose: `workflow.service.ts` and
 * `notifications/notifications.service.ts` both need it, and importing one
 * from the other closes a cycle through `feedback.service.ts` that Nest cannot
 * resolve.
 */
export function isUniqueViolation(err: unknown): boolean {
  const driver = err as { code?: string; message?: string } | null;
  if (!driver) return false;
  return driver.code === '23505' || /UNIQUE constraint failed/i.test(driver.message ?? '');
}

/**
 * The name of a thrown value, for a log line: `TypeError`, `QueryFailedError`
 * and so on, or `Error` when the value carries no name. Never its message,
 * which can hold a learner's code, a file path or a connection string.
 */
export function errorName(err: unknown): string {
  return (err as Error)?.name ?? 'Error';
}

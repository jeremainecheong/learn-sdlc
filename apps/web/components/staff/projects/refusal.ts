/**
 * A refusal, in the words it came with.
 *
 * Every door on these pages answers a refusal with a sentence the contract or
 * the API wrote, and the page prints it unchanged. A request that never
 * reached the API is the one exception, and `describeError` says that one.
 * (The upload door is stricter still, and keeps its own rule: see
 * `uploadRefusalOf`.)
 */
import { describeError } from '@/lib/api';

export function refusalOf(err: unknown, fallback: string): string {
  if (err instanceof Error && !(err instanceof TypeError) && err.message) return err.message;
  return describeError(err, fallback);
}

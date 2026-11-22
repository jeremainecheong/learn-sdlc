/**
 * An e-mail address as accounts store it: trimmed and lower-cased. Every path
 * that writes or looks up an account by address uses this, so an address
 * typed with different case or stray spaces still finds the same account.
 */
export function normaliseEmail(email: string): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}

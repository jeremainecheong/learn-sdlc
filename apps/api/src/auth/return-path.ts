/**
 * The page a sign-in sends a person back to, as both sign-in doors (Google
 * and the managed identity provider) carry it through their signed state.
 *
 * Only a path on this site survives; anything else becomes '' and the person
 * lands on the default page. An absolute or protocol-relative address here is
 * an open redirect, and so is any backslash, which several browsers normalise
 * to a slash before anything downstream sees it. Control characters are
 * refused before trimming, because URL parsers strip tabs and newlines before
 * they resolve an authority, so `/\t/host` would otherwise become `//host`.
 */

/** An origin that can never be real (`.invalid` is reserved), against which a path is resolved. */
export const RETURN_PATH_SENTINEL_ORIGIN = 'https://return.learnsdlc.invalid';

/** The longest return path kept, in characters. */
export const RETURN_PATH_MAX_LENGTH = 2048;

/** `next` when it is a path on this site, otherwise ''. */
export function safeReturnPath(next: unknown): string {
  if (typeof next !== 'string' || next.length > RETURN_PATH_MAX_LENGTH || /[\u0000-\u001f\u007f\\]/.test(next)) {
    return '';
  }
  const path = next.trim();
  if (!/^\/(?!\/)/.test(path)) return '';
  try {
    const url = new URL(path, RETURN_PATH_SENTINEL_ORIGIN);
    return url.origin === RETURN_PATH_SENTINEL_ORIGIN && !url.pathname.startsWith('//') ? path : '';
  } catch {
    return '';
  }
}

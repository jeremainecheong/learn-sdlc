/** Small, non-credential handoffs between registration, sign-in and setup.
 * Storage may be blocked; the current tab must still finish authentication. */
import { getSession, onSessionEnd } from './session';
import { safeLocalPath } from './navigation';
import { CLASS_CODE_FOR_KEY, CLASS_CODE_KEY, DOTTED_KEY, REGISTRATION_EMAIL_KEY, readStoredValue } from './storage-keys';
let email = '', code = '', claimedBy = '';
function read(key: string, fallback: string): string {
  try { return readStoredValue(sessionStorage, key, DOTTED_KEY[key]) ?? fallback; } catch { return fallback; }
}
function write(key: string, value: string): void {
  try {
    // The dotted spelling goes too, so a value cleared here is never carried back by the next read.
    const dotted = DOTTED_KEY[key];
    if (dotted) sessionStorage.removeItem(dotted);
    if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key);
  } catch { /* Current-tab handoff remains available in memory. */ }
}
export function rememberRegistrationEmail(value: string): void { email = value.trim(); write(REGISTRATION_EMAIL_KEY, email); }
export function registrationEmail(): string { return read(REGISTRATION_EMAIL_KEY, email); }
export function takeRegistrationEmail(): string { const value = read(REGISTRATION_EMAIL_KEY, email); email = ''; write(REGISTRATION_EMAIL_KEY, ''); return value; }
export function rememberClassCode(value: string): void { code = value.trim().slice(0, 64); write(CLASS_CODE_KEY, code); claimedBy = getSession()?.id ?? ''; write(CLASS_CODE_FOR_KEY, claimedBy); }
/**
 * The class code waiting in this tab, for the account signed in now.
 *
 * An invitation is read while signed out, so it waits for whoever signs in and
 * is theirs from the first read after that. A different account reading it is
 * the shared lab machine again (another tab signed somebody else in, which
 * changes this tab's profile without ending a session here) so it is dropped
 * rather than offered to them, the way the tab's project is dropped.
 */
export function pendingClassCode(): string {
  const value = read(CLASS_CODE_KEY, code);
  if (!value) return '';
  const account = getSession()?.id ?? '';
  if (!account) return value;
  const owner = read(CLASS_CODE_FOR_KEY, claimedBy);
  if (!owner) { claimedBy = account; write(CLASS_CODE_FOR_KEY, account); return value; }
  if (owner === account) return value;
  clearPendingClass();
  return '';
}
export function clearPendingClass(): void { code = ''; claimedBy = ''; write(CLASS_CODE_KEY, ''); write(CLASS_CODE_FOR_KEY, ''); }
export function invitationHref(path: string, value: string, next?: string): string {
  const [pathname, search = ''] = path.split('?');
  const params = new URLSearchParams(search);
  if (value) params.set('code', value);
  const destination = safeLocalPath(next, '');
  if (destination) params.set('next', destination);
  const query = params.toString().replace(/\+/g, '%20');
  return `${pathname}${query ? `?${query}` : ''}`;
}
/** Structured API refusal only; never route on a translated error sentence. */
export function confirmationEmail(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('body' in error)) return null;
  const body = error.body;
  return body && typeof body === 'object' && 'code' in body && body.code === 'CONFIRMATION_REQUIRED'
    && 'email' in body && typeof body.email === 'string' ? body.email : null;
}
onSessionEnd(() => { email = ''; code = ''; claimedBy = ''; write(REGISTRATION_EMAIL_KEY, ''); write(CLASS_CODE_KEY, ''); write(CLASS_CODE_FOR_KEY, ''); });

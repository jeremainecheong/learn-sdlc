'use client';

import { request } from './api';

/** Mirrors RecoveryService.status in apps/api/src/auth/recovery.service.ts. */
export interface VerifyStatus {
  email: string;
  verified: boolean;
  verifiedAt: string | null;
}

export const recoveryApi = {
  forgot: (email: string) =>
    request<{ sent: true; message: string; inboxUrl?: string; delivery?: 'local_inbox' | 'local_file' | 'code' }>('POST', '/auth/forgot', { email }),
  reset: (token: string, password: string) =>
    request<{ changed: true }>('POST', '/auth/reset', { token, password }),
  resetWithCode: (email: string, code: string, password: string) =>
    request<{ changed: true }>('POST', '/auth/reset', { email, code, password }),
  requestVerification: () =>
    request<{ sent: boolean; verified: boolean; message?: string; inboxUrl?: string }>('POST', '/auth/verify/request'),
  verify: (token: string) =>
    request<{ verified: true; email: string }>('POST', '/auth/verify', { token }),
  verifyStatus: () => request<VerifyStatus>('GET', '/auth/verify/status'),
};

/**
 * The token arrives as `?token=` on a link opened from an email. Read from
 * window.location rather than useSearchParams(): the latter forces a Suspense
 * boundary on the page and fails the production build (see login/page.tsx).
 *
 * Read once and taken out of the address bar in the same breath, the way the
 * Google callback treats its fragment: a reset link is good for an hour, and
 * left in the URL it sat in this tab and in the browser's history for the
 * next person at a shared machine to reopen. The page holds it in state.
 */
export function tokenFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  if (token) {
    params.delete('token');
    const rest = params.toString();
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    } catch {
      // A history that will not be rewritten still has the token; nothing
      // else here depends on the scrub having worked.
    }
  }
  return token;
}

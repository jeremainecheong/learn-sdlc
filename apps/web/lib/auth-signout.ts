'use client';

/**
 * What a deliberate sign-out does after the session is gone here, when this
 * deployment signs people in through the managed provider.
 *
 * `endSession` (lib/api.ts) has already saved what was typed, revoked the
 * token on the server and cleared it in this browser. The sign-in page then
 * says, once, that the person is signed out of LearnSDLC on this browser and
 * that Google is not (`SignedOutNotice.tsx`). The mark that asks for it is per tab, set only in
 * managed mode, and spent on first read, so a reload of /login never says it
 * twice.
 *
 * Whether the deployment is managed is the server's answer on
 * `GET /auth/providers`, the same one the sign-in page reads. When that answer
 * does not come, sign-out ends on /login with no sentence, as in local mode.
 */
import type { AuthProviders } from '@learnsdlc/shared';
import { API_BASE, SIGNED_OUT_KEY, request } from '@/lib/api';

/** The sentence /login shows once after a managed sign-out. It never claims a Google sign-out. */
export const SIGNED_OUT_NOTICE =
  'You are signed out of LearnSDLC on this browser. If you used Google, your Google account stays signed in until you sign out of Google.';

/** How long sign-out waits for the providers answer before it simply goes to /login. */
export const PROVIDER_LOOKUP_MS = 3_000;

/** Whether this deployment signs people in through the managed provider. Any failure reads as no. */
export async function managedSignIn(): Promise<boolean> {
  try {
    const providers = await request<AuthProviders>('GET', '/auth/providers', undefined, { timeoutMs: PROVIDER_LOOKUP_MS });
    return providers?.authProvider === 'cognito';
  } catch {
    return false;
  }
}

/** Leave the mark /login reads once. Storage a browser refuses costs only the sentence. */
export function markSignedOut(): void {
  try {
    window.sessionStorage.setItem(SIGNED_OUT_KEY, '1');
  } catch {
    // no sentence, and nothing else lost
  }
}

/** Whether this tab has just signed out in managed mode. Read once; the mark is spent. */
export function takeSignedOut(): boolean {
  try {
    const marked = window.sessionStorage.getItem(SIGNED_OUT_KEY) === '1';
    window.sessionStorage.removeItem(SIGNED_OUT_KEY);
    return marked;
  } catch {
    return false;
  }
}

/**
 * The managed provider keeps a session of its own, which the LearnSDLC
 * sign-out above does not reach. The API's `/auth/sso/signout` answers with a
 * redirect to the provider's `/logout`, and the provider sends the browser back
 * to /login. The address carries no token and no query: the server builds the
 * whole redirect from its own settings.
 */
export function ssoSignOutUrl(): string {
  return `${API_BASE}/auth/sso/signout`;
}

/** Leave the app for the provider's sign-out, as a full navigation. */
export function leaveForSsoSignOut(location: Pick<Location, 'assign'> = window.location): void {
  location.assign(ssoSignOutUrl());
}

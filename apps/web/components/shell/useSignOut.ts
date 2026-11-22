'use client';

import { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import { endSession, getToken, holdSignInRedirect } from '@/lib/api';
import { leaveForSsoSignOut, managedSignIn, markSignedOut } from '@/lib/auth-signout';

/**
 * Sign out, from wherever it is offered: the sidebar's foot, the palette,
 * /account.
 *
 * Three things, in this order: whatever is typed and not yet saved goes out
 * under the live token; the token is then revoked on the server, so a copy
 * taken from a shared machine stops working too; and only then is the session
 * cleared here. Clearing first meant the exit save went out unsigned and the
 * seven-day token stayed good everywhere else.
 *
 * Routing client-side means nothing else tears the page down, so the socket
 * would otherwise stay open and joined to this user's room for whoever signs
 * in next in the same tab. The socket client is imported lazily so it ships
 * with the workspace, the only page that opens one, rather than with the
 * chrome every page carries.
 *
 * Where it ends depends on the deployment (lib/auth-signout.ts). The
 * server's unsigned providers answer is read only after the session is
 * cleared; in managed mode the tab keeps a mark so /login says, once, what
 * did and did not end. Local mode, or no answer, ends on /login.
 */
export function useSignOut(): () => void {
  const router = useRouter();
  return useCallback(() => {
    // The session gate would otherwise send the tab to /login?next=… the
    // moment the token is cleared, before the mark below exists (lib/api).
    holdSignInRedirect(true);
    void endSession().then(async cleared => {
      if (!cleared || getToken()) return;
      import('@/lib/socket')
        .then((m) => { if (!getToken()) m.closeSocket(); })
        .catch(() => undefined);
      const managed = await managedSignIn();
      // A sign-in that landed while the answer was on its way owns this tab now.
      if (getToken()) return;
      if (managed) markSignedOut();
      // Managed mode: the provider's own session ends on its /logout, reached through
      // the API route, which sends the browser back to /login.
      if (managed) {
        leaveForSsoSignOut();
        return;
      }
      router.push('/login');
    }).finally(() => holdSignInRedirect(false));
  }, [router]);
}

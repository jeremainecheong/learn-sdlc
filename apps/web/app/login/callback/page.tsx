"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { UserProfile } from '@learnsdlc/shared';
import {
  ApiError,
  verifyAuthToken,
  describeError,
  storeAuth,
  takeGoogleSignInStart,
} from "@/lib/api";
import { AuthLayout, AuthNotice } from "@/components/landing/AuthLayout";
import { homeHrefFor, safeLocalPath } from "@/lib/navigation";
import { invitationHref, pendingClassCode } from '@/lib/auth-flow';
import { takeAuthHandoff } from '@/lib/auth-handoff';

/**
 * Where Google sign-in lands.
 *
 * The API puts the session in the URL fragment, so it is never sent to a
 * server and never written to an access log. Taking it out of the address bar
 * is not this page's job: the boot script in <head> does it while
 * the document is still parsing, and hands the token over in memory (see
 * lib/auth-handoff.ts). This page collects it (from that hand, or straight off
 * the fragment where no script ran), asks the API who it belongs to, and moves
 * on. Nothing here is a decision; if a learner sees this screen at all it is
 * for a fraction of a second.
 */
export default function GoogleCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [backHref, setBackHref] = useState('/login');
  const handoff = useRef<{ token: string | null; next: string | null; started: boolean } | null>(null);
  const verification = useRef<Promise<UserProfile> | null>(null);

  useEffect(() => {
    if (!handoff.current) {
    // Taken from the boot script's hand where it ran, and read off the
    // fragment where it did not: a client-side navigation, or a browser that
    // refused the history write.
    const token = takeAuthHandoff();
    const next = new URLSearchParams(window.location.search).get("next");
    // Either way the address bar ends at the bare path (no fragment, no query)
    // before the first await, so nothing this page loads next can pass
    // either of them on, whichever way the rest of this goes.
    window.history.replaceState(null, "", window.location.pathname);
    handoff.current = { token, next, started: Boolean(token && takeGoogleSignInStart()) };
    }
    const { token, next, started } = handoff.current;
    setBackHref(invitationHref('/login', pendingClassCode(), next || ''));

    // Only a tab that pressed the button is allowed to keep what comes back.
    // A link with a token in its fragment, opened cold, would otherwise sign
    // this browser into whoever built the link, and let them read everything
    // written here afterwards.
    if (!token || !started) {
      setError(
        "That sign-in did not carry a session. Start again from the sign-in page.",
      );
      return;
    }

    let live = true;
    (async () => {
      try {
        // Verify the incoming identity without replacing a returning session.
        verification.current ??= verifyAuthToken(token);
        const user = await verification.current;
        if (!live) return;
        storeAuth({ token, user });
        const home = homeHrefFor(user);
        // Only same-origin paths: an absolute URL, or a leading `/\` that a
        // browser will normalise into one, is an open redirect.
        router.replace(user.role === 'LEARNER' && user.onboardingCompleted === false ? home : safeLocalPath(next, home));
      } catch (err) {
        if (!live) return;
        // The API's own wording for a refused token is about a credential the
        // learner never saw. Everything else (offline, a 5xx and its
        // reference) is worth passing on as it is.
        setError(
          err instanceof ApiError && err.status === 401
            ? "That session was not accepted. Start again from the sign-in page."
            : describeError(
                err,
                "That sign-in could not be completed. Try again in a moment.",
              ),
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [router]);

  return (
    <AuthLayout
      title={error ? "That sign-in did not go through" : "Signing you in"}
      purpose={
        error ? undefined : "Verifying your sign-in. One moment."
      }
    >
      {error ? (
        <>
          <AuthNotice tone="fail" testId="google-callback-error">
            {error}
          </AuthNotice>
          <Link
            href={backHref}
            className="lh-primary lh-signin-submit"
            data-testid="to-login"
          >
            Back to sign in
          </Link>
        </>
      ) : (
        <p className="lh-auth-secondary" data-testid="google-callback-working">
          Taking you to your project.
        </p>
      )}
    </AuthLayout>
  );
}

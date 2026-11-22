"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { describeError, getToken } from "@/lib/api";
import { recoveryApi, tokenFromLocation } from "@/lib/api-recovery";
import { AuthLayout, AuthNotice } from "@/components/landing/AuthLayout";
import { homeHrefFor } from "@/lib/navigation";
import { useSession } from "@/lib/session";

type State =
  | { kind: "checking" }
  | { kind: "missing" }
  | { kind: "verified"; email: string }
  | { kind: "failed"; message: string };

export default function VerifyPage() {
  const user = useSession();
  const staff = user?.role === 'INSTRUCTOR' || user?.role === 'ADMIN';
  const [state, setState] = useState<State>({ kind: "checking" });
  const [signedIn, setSignedIn] = useState(false);
  const [resent, setResent] = useState("");
  const [busy, setBusy] = useState(false);
  const [inboxUrl, setInboxUrl] = useState('');
  const link = useRef<string | null>(null);
  const verification = useRef<ReturnType<typeof recoveryApi.verify> | null>(null);

  useEffect(() => {
    setSignedIn(Boolean(getToken()));
    const token = link.current ?? (link.current = tokenFromLocation());
    if (!token) {
      setState({ kind: "missing" });
      return;
    }
    let cancelled = false;
    // Share the request across effect replay, while each mounted effect owns
    // only its subscription to the result. The token stays out of the URL.
    verification.current ??= recoveryApi.verify(token);
    verification.current
      .then((res) => { if (!cancelled) setState({ kind: "verified", email: res.email }); })
      .catch((err) =>
        !cancelled && setState({
          kind: "failed",
          message: describeError(
            err,
            "This link could not be checked. Try again in a moment.",
          ),
        }),
      );
    return () => { cancelled = true; };
  }, []);

  const resend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await recoveryApi.requestVerification();
      setInboxUrl(res.inboxUrl || '');
      setResent(
        res.verified
          ? "This address is already verified."
          : res.message || "A new link is on its way.",
      );
    } catch (err) {
      setResent(
        describeError(
          err,
          "A new link could not be sent. Try again in a moment.",
        ),
      );
    } finally { setBusy(false); }
  };

  return (
    <AuthLayout
      title="Confirm your email address"
      purpose="Confirming it is how we reach you about your account — a reset link, or a notice about your class."
    >
      {state.kind === "checking" && (
        <p
          role="status"
          className="text-[14px] text-muted"
          data-testid="verify-checking"
        >
          Checking your link…
        </p>
      )}

      {state.kind === "verified" && (
        <div className="flex flex-col gap-3.5" data-testid="verify-done">
          <AuthNotice tone="pass">
            <span className="mono break-all">{state.email}</span> is confirmed.
          </AuthNotice>
          <Link
            href={signedIn ? homeHrefFor(user) : "/login"}
            className="lh-primary lh-signin-submit"
            data-testid="verify-continue"
          >
            {signedIn ? staff ? "Back to your classes" : "Back to your project" : "Sign in"}
          </Link>
        </div>
      )}

      {(state.kind === "failed" || state.kind === "missing") && (
        <div className="flex flex-col gap-3.5" data-testid="verify-failed">
          <AuthNotice tone="fail">
            {state.kind === "missing"
              ? "This page needs the link from your confirmation email."
              : state.message}
          </AuthNotice>
          {signedIn ? (
            <>
              <button
                onClick={resend}
                disabled={busy}
                className="lh-primary lh-signin-submit"
                data-testid="verify-resend"
              >
                {busy ? 'Sending…' : 'Send a new link'}
              </button>
              {inboxUrl && <a href={inboxUrl} target="_blank" rel="noopener noreferrer" className="lh-inline-action">Open the local test inbox</a>}
              {resent && (
                <p role="status" className="label">
                  {resent}
                </p>
              )}
            </>
          ) : (
            <p className="label">
              Sign in and you can ask for a fresh link from the notice at the
              top of your home page.
            </p>
          )}
        </div>
      )}

      <p className="lh-auth-secondary">
        <Link
          href={signedIn ? homeHrefFor(user) : "/login"}
          className="lh-inline-action"
        >
          {signedIn ? "Home" : "Sign in"}
        </Link>
      </p>
    </AuthLayout>
  );
}

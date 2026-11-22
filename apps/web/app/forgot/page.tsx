"use client";

import { useHydrated } from "@/lib/useHydrated";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, describeError } from "@/lib/api";
import { invitationHref, pendingClassCode, rememberRegistrationEmail } from '@/lib/auth-flow';
import { recoveryApi } from "@/lib/api-recovery";
import { AuthLayout, AuthNotice } from "@/components/landing/AuthLayout";
import { AuthField as Field } from "@/components/landing/AuthField";

export default function ForgotPage() {
  const ready = useHydrated();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [inboxUrl, setInboxUrl] = useState("");
  const [localDelivery, setLocalDelivery] = useState(false);
  const [codeDelivery, setCodeDelivery] = useState(false);
  const [cognito, setCognito] = useState(false);
  const [context, setContext] = useState({ code: '', next: '' });
  const active = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setContext({ code: query.get('code') || pendingClassCode(), next: query.get('next') || '' });
    let live = true;
    // Providers that will not load leave the form on the local reset path.
    api.providers().then(value => { if (live) setCognito(value.authProvider === 'cognito'); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => { if (error) notice.current?.focus(); }, [error]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      const res = await recoveryApi.forgot(email);
      // The API's own wording, which is the same whether or not the address
      // has an account: this page must not be the place that difference shows.
      setDone(res.message);
      setInboxUrl(res.inboxUrl || "");
      setLocalDelivery(res.delivery === 'local_inbox' || res.delivery === 'local_file');
      setCodeDelivery(res.delivery === 'code');
      rememberRegistrationEmail(email);
    } catch (err) {
      setError(
        describeError(
          err,
          "The password reset could not be requested. Try again in a moment.",
        ),
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      purpose={cognito ? 'Enter the address you signed up with to request a code and choose a new password.' : 'Enter the address you signed up with to request a password reset.'}
    >
      {done ? (
        <div className="lh-entry-form" data-testid="forgot-done">
          <AuthNotice tone="pass">{done}</AuthNotice>
          {inboxUrl && <a href={inboxUrl} target="_blank" rel="noopener noreferrer" className="lh-inline-action">Open the local test inbox</a>}
          {!localDelivery && <p className="label">
            Nothing after a few minutes? Check the spam folder, and make sure it
            is the address you signed up with.
          </p>}
          {codeDelivery && <Link href={invitationHref('/reset?delivery=code', context.code, context.next)} className="lh-primary lh-signin-submit" data-testid="enter-reset-code">Enter the reset code</Link>}
          <Link
            href={invitationHref('/login', context.code, context.next)}
            className="lh-primary lh-signin-submit"
            data-testid="to-login"
          >
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="lh-entry-form" data-ready={ready}>
          <Field
            id="email"
            label="Email"
            type="email"
            autoComplete="email"
            className="h-10 bg-ground"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? "recovery-error" : undefined}
            data-testid="forgot-email"
            required
          />
          {error && (
            <div id="recovery-error" ref={notice} tabIndex={-1}><AuthNotice tone="fail" testId="auth-error">
              {error}
            </AuthNotice></div>
          )}
          <button
            className="lh-primary lh-signin-submit"
            aria-busy={busy || undefined}
            disabled={busy || !ready}
            data-testid="forgot-submit"
          >
            {busy ? "Requesting…" : cognito ? "Request a reset code" : "Request a reset link"}
          </button>
        </form>
      )}
      <p className="lh-auth-secondary">
        Remembered it?{" "}
        <Link href={invitationHref('/login', context.code, context.next)} className="lh-inline-action">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

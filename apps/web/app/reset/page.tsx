"use client";

import { useHydrated } from "@/lib/useHydrated";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clearAuth, describeError } from "@/lib/api";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@learnsdlc/shared";
import { recoveryApi, tokenFromLocation } from "@/lib/api-recovery";
import { AuthLayout, AuthNotice } from "@/components/landing/AuthLayout";
import { AuthField as Field } from "@/components/landing/AuthField";
import { invitationHref, pendingClassCode, registrationEmail, rememberRegistrationEmail } from '@/lib/auth-flow';

const TITLE = "Choose a new password";
/**
 * A sentence, like every other message in this flow, and it belongs to
 * the box that can be wrong. Flagging the new-password field too said the
 * password itself was the problem when the only problem was the second copy.
 */
const MISMATCH =
  "The two passwords do not match. Type the same one in both boxes.";
const PURPOSE =
  "The link from your reset email opened this page. Pick a password you do not use anywhere else.";

export default function ResetPage() {
  const ready = useHydrated();
  // Null until mounted: the server render has no query string, and deciding
  // "no token" during render would flash the wrong state before hydration.
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'changed' | 'sign-in-required' | null>(null);
  const [codeMode, setCodeMode] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [resent, setResent] = useState('');
  const [context, setContext] = useState({ code: '', next: '' });
  const active = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  const completedNotice = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setCodeMode(params.get('delivery') === 'code');
    setEmail(registrationEmail());
    setContext({ code: params.get('code') || pendingClassCode(), next: params.get('next') || '' });
    const fromUrl = tokenFromLocation();
    // React's development effect replay must not replace the consumed link
    // with an empty second read after it has been scrubbed from the URL.
    setToken(current => current ?? fromUrl);
  }, []);
  useEffect(() => { if (error) {
    if (mismatch) document.getElementById('confirm')?.focus();
    else notice.current?.focus();
  } }, [error, mismatch]);
  useEffect(() => { if (done) completedNotice.current?.focus(); }, [done]);
  const purpose = codeMode ? 'Enter the code from your email and choose a new password.' : PURPOSE;
  const loginHref = invitationHref('/login', context.code, context.next);
  const forgotHref = invitationHref('/forgot', context.code, context.next);

  /** Editing either box makes the complaint about the pair stale. */
  const clearMismatch = () => {
    if (!mismatch) return;
    setMismatch(false);
    setError("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (active.current) return;
    if (password !== confirm) {
      setError(MISMATCH);
      setMismatch(true);
      return;
    }
    active.current = true; setBusy(true);
    setError("");
    setMismatch(false);
    const finish = (outcome: 'changed' | 'sign-in-required') => {
      clearAuth();
      if (codeMode) rememberRegistrationEmail(email);
      setPassword(''); setConfirm(''); setCode('');
      setDone(outcome);
    };
    try {
      if (codeMode) await recoveryApi.resetWithCode(email.trim(), code.trim(), password);
      else await recoveryApi.reset(token || "", password);
      // The reset signed every session out server-side; a stale token left in
      // this browser would only bounce the next page back to login anyway.
      finish('changed');
    } catch (err) {
      const body = err && typeof err === 'object' && 'body' in err ? err.body : null;
      if (codeMode && body && typeof body === 'object' && 'code' in body && body.code === 'PASSWORD_CHANGED_SIGN_IN_REQUIRED') {
        // Cognito already consumed the code and changed the password. Only
        // application session recovery failed, so repeating reset is unsafe.
        finish('sign-in-required');
      } else setError(
        describeError(
          err,
          "The password could not be reset. Try again in a moment.",
        ),
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };

  if (token === null) {
    return (
      <AuthLayout title={TITLE} purpose={PURPOSE}>
        <p role="status" className="text-[14px] text-muted">
          Checking your link…
        </p>
      </AuthLayout>
    );
  }

  if (!token && !codeMode) {
    return (
      <AuthLayout title={TITLE} purpose={PURPOSE}>
        <AuthNotice tone="fail" testId="reset-missing">
          This page needs the link from your reset email. Open it from the
          message, or request a new one.
        </AuthNotice>
        <Link
          href={forgotHref}
          className="lh-primary lh-signin-submit"
          data-testid="to-forgot"
        >
          Request a reset link
        </Link>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout
        title={done === 'sign-in-required' ? 'Password changed' : TITLE}
        purpose={done === 'sign-in-required' ? 'Continue by signing in with your new password.' : purpose}
      >
        <div className="lh-entry-form" data-testid="reset-done" ref={completedNotice} tabIndex={-1}>
          <AuthNotice tone={done === 'sign-in-required' ? 'warn' : 'pass'}>
            {done === 'sign-in-required'
              ? 'Your password has been changed. Application session recovery could not be completed. Sign in with your new password. If sign-in is unavailable, contact the LearnSDLC host.'
              : 'Your password has been changed. Every device that was signed in has been signed out; sign in again with the new one.'}
          </AuthNotice>
          <Link
            href={loginHref}
            className="lh-primary lh-signin-submit"
            data-testid="to-login"
          >
            Sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={TITLE} purpose={purpose}>
      <form onSubmit={submit} className="lh-entry-form" data-ready={ready}>
        {codeMode && <>
          <Field id="reset-email" label="Email address" type="email" autoComplete="email" value={email} required disabled={busy}
            onChange={event => { setEmail(event.target.value); setError(''); setResent(''); }} data-testid="reset-email" />
          <Field id="reset-code" label="Reset code" inputMode="numeric" autoComplete="one-time-code" value={code} required disabled={busy} maxLength={64}
            onChange={event => { setCode(event.target.value); setError(''); }} data-testid="reset-code" />
        </>}
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${PASSWORD_MIN_LENGTH} characters, and not one of the common breached passwords. Three unrelated words beats a clever substitution.`}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          className="h-10 bg-ground"
          value={password}
          disabled={busy}
          onChange={(e) => {
            setPassword(e.target.value);
            clearMismatch();
          }}
          data-testid="reset-password"
          required
        />
        <Field
          id="confirm"
          label="Type it again"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          className="h-10 bg-ground"
          value={confirm}
          disabled={busy}
          onChange={(e) => {
            setConfirm(e.target.value);
            clearMismatch();
          }}
          error={mismatch}
          aria-errormessage={mismatch ? "reset-error" : undefined}
          data-testid="reset-confirm"
          required
        />
        {/* Directly under the box it is about, and pointed at by that box's
            aria-errormessage when the box is the reason. A failure from the
            API is about the link, not either field, so it flags neither. */}
        {error && (
          <div id="reset-error" ref={notice} tabIndex={-1}>
            <AuthNotice tone="fail" testId="auth-error">
              {error}
            </AuthNotice>
          </div>
        )}
        <button
          className="lh-primary lh-signin-submit"
          aria-busy={busy || undefined}
          disabled={busy || !ready}
          data-testid="reset-submit"
        >
          {busy ? "Saving…" : "Set new password"}
        </button>
      </form>
      {codeMode && <>
        {resent && <p role="status" className="lh-auth-secondary">{resent}</p>}
        <button type="button" className="lh-inline-action" disabled={busy || !ready} data-testid="reset-resend" onClick={async () => {
          if (active.current || !(document.getElementById('reset-email') as HTMLInputElement)?.reportValidity()) return;
          active.current = true; setBusy(true); setError(''); setResent('');
          try { const result = await recoveryApi.forgot(email.trim()); setResent(result.message); setCode(''); }
          catch (err) { setError(describeError(err, 'A new code could not be requested. Try again.')); }
          finally { active.current = false; setBusy(false); }
        }}>Send a new reset code</button>
      </>}
      <p className="lh-auth-secondary">
        {!codeMode && 'Link expired? '}
        <Link href={codeMode ? loginHref : forgotHref} className="lh-inline-action">
          {codeMode ? 'Back to sign in' : 'Request another'}
        </Link>
      </p>
    </AuthLayout>
  );
}

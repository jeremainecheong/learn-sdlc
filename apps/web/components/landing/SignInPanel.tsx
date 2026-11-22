"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  api,
  describeError,
  getToken,
  probeSiteData,
  storeAuth,
} from "@/lib/api";
import { AuthField as Field } from "./AuthField";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "./AuthLayout";
import { GoogleSignIn } from "./GoogleSignIn";
import { useHydrated } from "@/lib/useHydrated";
import { confirmationEmail, invitationHref, pendingClassCode, rememberClassCode, takeRegistrationEmail } from "@/lib/auth-flow";
import { ConfirmationForm } from './ConfirmationForm';
import { homeHrefFor, safeLocalPath } from "@/lib/navigation";
import { useSession } from "@/lib/session";

/** Real sign-in with optional configured OAuth and persistent-session choice. */
export function SignInPanel({
  offerContinue = false,
}: {
  offerContinue?: boolean;
}) {
  const router = useRouter();
  const ready = useHydrated();
  const user = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(true);
  const [error, setError] = useState("");
  const [providerFailure, setProviderFailure] = useState<{ message: string; reference?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Signed-out during SSR and the first paint, then corrected: reading storage
  // while rendering would disagree with the server HTML.
  const [signedIn, setSignedIn] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [invitation, setInvitation] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const submitting = useRef(false);
  // A browser that keeps nothing can still be signed in (the session is held
  // in memory for the tab, lib/api), but it ends at the next reload, which is
  // worth saying before they start rather than after they lose the page.
  const [noStorage, setNoStorage] = useState(false);
  useEffect(() => {
    setSignedIn(Boolean(getToken()));
    setRegistered(
      new URLSearchParams(window.location.search).get("registered") === "1",
    );
    setNoStorage(!probeSiteData());
    const params = new URLSearchParams(window.location.search);
    const providerError = params.get('error');
    const providerMessage = providerError === 'sso_expired'
      ? 'This sign-in request expired after ten minutes. Choose your sign-in provider again to start a fresh attempt.'
      : providerError === 'identity_link_required'
        ? 'An existing LearnSDLC account uses this address. Sign in with its existing password to migrate it, or contact the host.'
        : providerError === 'sso_failed'
          ? 'That provider sign-in could not be completed. Try again or sign in with email and password.'
          : '';
    // Query parameters are untrusted. Only fixed provider copy and a complete
    // request UUID belong in this notice, never provider text or credentials.
    const reference = params.get('reference') || '';
    if (providerMessage) setProviderFailure({
      message: providerMessage,
      reference: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference) ? reference : undefined,
    });
    setNext(params.get('next') || '');
    setConfirmed(params.get('confirmed') === '1');
    setPasswordChanged(params.get('passwordChanged') === '1');
    const pending = params.get('code')?.trim() || pendingClassCode();
    setInvitation(pending);
    if (pending) rememberClassCode(pending);
    const enteredEmail = params.get('email')?.trim() || takeRegistrationEmail();
    setEmail(current => current || enteredEmail);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const auth = await api.login(email, password);
      storeAuth(auth, { persist: keepSignedIn });
      // A 401 mid-session redirects here with ?next=<where they were>, so
      // signing back in returns them to the phase they were working on rather
      // than dumping them on the dashboard. Read from window.location rather
      // than useSearchParams(): the latter forces a Suspense boundary on this
      // page and fails the production build.
      const next = new URLSearchParams(window.location.search).get("next");
      const home = homeHrefFor(auth.user);
      const code = new URLSearchParams(window.location.search).get("code");
      if (code || invitation) rememberClassCode(code || invitation);
      // Only same-origin paths are followed: an absolute URL, or a leading `/\`
      // that a browser normalises into one, would be an open redirect.
      router.push(
        auth.user.onboardingCompleted === false && auth.user.role === "LEARNER"
          ? home
          : safeLocalPath(next, home),
      );
    } catch (err) {
      const requiredEmail = confirmationEmail(err);
      if (requiredEmail !== null) { setConfirmation(requiredEmail || email); setPassword(''); }
      else
      setError(describeError(err, "Sign in failed. Try again in a moment."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {confirmation !== null ? <>
        <h2 className="lh-auth-secondary">Confirm your email to sign in</h2>
        <ConfirmationForm initialEmail={confirmation} signInHref={invitationHref('/login', invitation, next)} onConfirmed={confirmedEmail => {
          setEmail(confirmedEmail); setConfirmation(null); setConfirmed(true); setError('');
          requestAnimationFrame(() => document.getElementById('password')?.focus());
        }} />
      </> : <>
      {confirmed && <AuthNotice tone="pass" testId="confirmation-success">Your email is confirmed. Sign in with your password.</AuthNotice>}
      {passwordChanged && <AuthNotice tone="pass" testId="password-change-success">Your password has changed and all sessions have ended. Sign in with your new password.</AuthNotice>}
      {registered && (
        <AuthNotice tone="pass" testId="registration-success">
          Your account is ready. Sign in to start your learning journey.
        </AuthNotice>
      )}
      {offerContinue && signedIn && (
        <Link
          href={homeHrefFor(user)}
          className="btn h-11 w-full text-[14.5px]"
          data-testid="landing-continue"
        >
          {user?.role === 'INSTRUCTOR' || user?.role === 'ADMIN' ? 'Continue to your classes' : 'Continue to your project'}
          <Icon name="arrow-right" size={15} />
        </Link>
      )}

      {/* Renders nothing, rule included, on a server with no OAuth client. */}
      {providerFailure && <AuthNotice tone="fail" testId="sso-error">
        {providerFailure.message}
        {providerFailure.reference && <span className="block break-all" data-testid="sso-reference">Reference: {providerFailure.reference}</span>}
      </AuthNotice>}
      <GoogleSignIn />

      {noStorage && (
        <AuthNotice tone="warn" testId="storage-blocked">
          This browser is blocking site data, so you will be signed out when you
          reload the page. Allow site data for this site to stay signed in.
        </AuthNotice>
      )}

      <form onSubmit={submit} className="lh-entry-form" data-ready={ready}>
        <Field
          id="email"
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          className="h-10 bg-ground"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          error={Boolean(error)}
          data-testid="email"
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          placeholder="Enter your password"
          autoComplete="current-password"
          className="h-10 bg-ground"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          error={Boolean(error)}
          data-testid="password"
          required
        />
        {error && (
          <AuthNotice tone="fail" testId="auth-error">
            {error}
          </AuthNotice>
        )}
        <div className="lh-entry-options">
          <label className="lh-remember">
            <input
              type="checkbox"
              checked={keepSignedIn}
              disabled={busy}
              onChange={(event) => setKeepSignedIn(event.target.checked)}
            />
            Keep me signed in
          </label>
          <Link
            href={invitationHref('/forgot', invitation, next)}
            className="lh-inline-action"
            data-testid="to-forgot"
          >
            Forgot password?
          </Link>
        </div>
        <button
          className="lh-primary lh-signin-submit"
          aria-busy={busy || undefined}
          disabled={busy || !ready}
          data-testid="login-submit"
        >
          {busy ? "Signing in…" : "Sign in"}
          <Icon name="arrow-right" size={18} />
        </button>
      </form>

      <div className="lh-entry-divider" data-testid="new-here">
        New here?
      </div>
      <Link
        href={invitationHref('/register', invitation, next)}
        className="lh-create-account-cta"
        data-testid="to-register"
      >
        Create an account <Icon name="arrow-right" size={18} />
      </Link>
      </>}
    </>
  );
}

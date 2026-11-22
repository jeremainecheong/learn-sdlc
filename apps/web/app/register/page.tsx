"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useHydrated } from "@/lib/useHydrated";
import { useEffect, useRef, useState } from "react";
import { invitationHref, pendingClassCode, rememberClassCode, rememberRegistrationEmail } from "@/lib/auth-flow";
import { api, describeError } from "@/lib/api";
import { DISPLAY_NAME_MAX, DISPLAY_NAME_MIN, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@learnsdlc/shared";
import { AuthLayout, AuthNotice } from "@/components/landing/AuthLayout";
import { GoogleSignIn } from "@/components/landing/GoogleSignIn";
import { AuthField as Field } from "@/components/landing/AuthField";
import { ArrowRight } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();
  const ready = useHydrated();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorField, setErrorField] = useState<'displayName' | 'email' | 'password' | null>(null);
  const notice = useRef<HTMLDivElement>(null);
  const submitting = useRef(false);

  // An invitation link can carry the class code and the address across in
  // the query string. Read them after mount rather than through useSearchParams(),
  // which would force a Suspense boundary and fail the production build.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNext(params.get('next') || '');
    const invitation = params.get('code')?.trim() || pendingClassCode();
    setCode(invitation);
    if (invitation) rememberClassCode(invitation);
    const invited = params.get("email")?.trim();
    if (invited) setEmail(invited);
  }, []);
  useEffect(() => {
    if (!error) return;
    if (errorField) document.getElementById(errorField)?.focus();
    else notice.current?.focus();
  }, [error, errorField]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting.current) return;
    // The browser's own bubble would say "Please lengthen this text to 8
    // characters or more (you are currently using 4 characters)": Chrome's
    // sentence, in Chrome's voice, in a place this product never speaks. The
    // form is `noValidate` and the answer lands in the notice this page
    // already has, beside the field it is about.
    const field = !displayName.trim() || displayName.trim().length < DISPLAY_NAME_MIN || displayName.trim().length > DISPLAY_NAME_MAX ? 'displayName'
      : !email.trim() || (document.getElementById('email') as HTMLInputElement).validity.typeMismatch ? 'email'
      : password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH ? 'password' : null;
    if (field) {
      // An unchanged error does not rerun the effect. Repeated submit attempts
      // must still return focus from the button to the field needing correction.
      if (errorField === field) document.getElementById(field)?.focus();
      setErrorField(field);
      setError(field === 'displayName' ? !displayName.trim() ? 'Enter your name.' : `Use between ${DISPLAY_NAME_MIN} and ${DISPLAY_NAME_MAX} characters for your name.`
        : field === 'email' ? 'Enter a valid email address, such as you@example.com.'
        : password.length > PASSWORD_MAX_LENGTH ? `Use a password with no more than ${PASSWORD_MAX_LENGTH} characters.` : `Use at least ${PASSWORD_MIN_LENGTH} characters for your password. Three unrelated words are easier to remember.`);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    setErrorField(null);
    try {
      const result = await api.register(email.trim(), password, displayName.trim());
      rememberRegistrationEmail(email);
      setPassword('');
      // Registration creates the account; the next step is an explicit sign-in.
      router.push(invitationHref(result && 'confirmationRequired' in result && result.confirmationRequired ? '/confirm' : '/login?registered=1', code, next));
    } catch (err) {
      setError(
        describeError(
          err,
          "The account could not be created. Try again in a moment.",
        ),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Create your account"
      purpose="One account for your projects, feedback, and progress."
    >
      {/* Same button as the sign-in page: with Google there is no form to fill. */}
      <GoogleSignIn />

      <form onSubmit={submit} noValidate className="lh-entry-form" data-ready={ready}>
        <Field
          id="displayName"
          label="Your name"
          autoComplete="name"
          className="h-10 bg-ground"
          value={displayName}
          disabled={busy}
          onChange={(e) => setDisplayName(e.target.value)}
          data-testid="displayName"
          required
          minLength={DISPLAY_NAME_MIN}
          maxLength={DISPLAY_NAME_MAX}
          error={errorField === 'displayName'}
          errorMessage={errorField === 'displayName' ? error : undefined}
        />
        <Field
          id="email"
          label="Email address"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          className="h-10 bg-ground"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
          error={errorField === 'email'}
          errorMessage={errorField === 'email' ? error : undefined}
          data-testid="email"
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={errorField === 'password' ? undefined : `Use at least ${PASSWORD_MIN_LENGTH} characters. Three unrelated words are easier to remember.`}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          className="h-10 bg-ground"
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          error={errorField === 'password'}
          errorMessage={errorField === 'password' ? error : undefined}
          data-testid="password"
          required
        />
        {error && !errorField && (
          <div id="registration-error" ref={notice} tabIndex={-1}>
          <AuthNotice tone="fail" testId="auth-error">
            {error}
          </AuthNotice>
          </div>
        )}
        <button
          className="lh-primary lh-signin-submit lh-register-submit"
          aria-busy={busy || undefined}
          disabled={busy || !ready}
          data-testid="register-submit"
        >
          {busy ? "Creating account…" : "Create an account"}{" "}
          <ArrowRight size={18} />
        </button>
      </form>

      <p className="lh-entry-create">
        Already have an account?{" "}
        <Link href={invitationHref('/login', code, next)} data-testid="to-login">
          Sign in
        </Link>
      </p>
      <p className="lh-entry-card-foot">
        By creating an account you agree to the{" "}
        <Link href="/terms">terms of use</Link>.
      </p>
    </AuthLayout>
  );
}

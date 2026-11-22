'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api, describeError } from '@/lib/api';
import { rememberRegistrationEmail } from '@/lib/auth-flow';
import { useHydrated } from '@/lib/useHydrated';
import { AuthField } from './AuthField';
import { AuthNotice } from './AuthLayout';

/** Confirmation never signs a user in or retains the one-time code. */
export function ConfirmationForm({ initialEmail = '', signInHref = '/login', onConfirmed }: {
  initialEmail?: string; signInHref?: string; onConfirmed: (email: string) => void;
}) {
  const ready = useHydrated();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'confirm' | 'resend' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => { document.getElementById(initialEmail ? 'confirmation-code' : 'confirmation-email')?.focus(); }, [initialEmail]);
  useEffect(() => { if (error) notice.current?.focus(); }, [error]);
  async function act(kind: 'confirm' | 'resend') {
    if (active.current) return;
    active.current = true; setBusy(kind); setError(''); setMessage('');
    try {
      if (kind === 'resend') {
        const result = await api.resendConfirmation(email.trim());
        setCode('');
        setMessage(result.message || 'If this account needs confirmation, a new code has been sent. Check your inbox and spam folder.');
      } else {
        await api.confirmRegistration(email.trim(), code.trim());
        rememberRegistrationEmail(email); setCode(''); onConfirmed(email.trim());
      }
    } catch (err) {
      setError(describeError(err, kind === 'confirm' ? 'The code could not be confirmed. Check it or request another.' : 'A new code could not be requested. Try again.'));
    } finally { active.current = false; setBusy(null); }
  }
  return <div className="lh-entry-form" data-testid="confirmation-form">
    <p className="lh-auth-secondary">Enter the code from your email to confirm your account, then sign in. You can paste the complete code.</p>
    <form onSubmit={event => { event.preventDefault(); void act('confirm'); }} className="lh-entry-form" data-ready={ready}>
      <AuthField id="confirmation-email" label="Email address" type="email" autoComplete="email" value={email} disabled={Boolean(busy)} required
        onChange={event => { setEmail(event.target.value); setCode(''); setError(''); setMessage(''); }} data-testid="confirmation-email" />
      <AuthField id="confirmation-code" label="Confirmation code" inputMode="numeric" autoComplete="one-time-code" value={code} disabled={Boolean(busy)} required maxLength={64}
        onChange={event => { setCode(event.target.value); setError(''); }} data-testid="confirmation-code" />
      {error && <div ref={notice} tabIndex={-1} data-testid="confirmation-error"><AuthNotice tone="fail">{error}</AuthNotice></div>}
      {message && <p role="status" className="lh-auth-secondary" data-testid="confirmation-resent">{message}</p>}
      <button className="lh-primary lh-signin-submit" aria-busy={busy === "confirm" || undefined} disabled={Boolean(busy) || !ready} data-testid="confirmation-submit">{busy === 'confirm' ? 'Confirming…' : 'Confirm email'}</button>
    </form>
    <div className="flex flex-wrap items-center justify-between gap-x-4" data-testid="confirmation-actions">
    <button type="button" className="lh-inline-action" disabled={Boolean(busy) || !ready} data-testid="confirmation-resend" onClick={() => {
      if ((document.getElementById('confirmation-email') as HTMLInputElement)?.reportValidity()) void act('resend');
    }}>{busy === 'resend' ? 'Requesting code…' : 'Send a new code'}</button>
    <Link href={signInHref} className="lh-inline-action">Back to sign in</Link>
    </div>
  </div>;
}

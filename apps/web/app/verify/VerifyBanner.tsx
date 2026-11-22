'use client';

import { useEffect, useState } from 'react';
import { describeError, getToken } from '@/lib/api';
import { recoveryApi, type VerifyStatus } from '@/lib/api-recovery';

/**
 * Remembered per tab, not per browser: a dismissed banner stays gone for the
 * working session but comes back next visit, since nothing else will ever
 * remind them. Keyed on the address so signing into a second account in the
 * same tab is not silently pre-dismissed.
 */
const dismissKey = (email: string) => `lsdlc_verify_dismissed:${email}`;

/**
 * A quiet notice under the nav until the address is confirmed. Mount it on
 * signed-in pages (dashboard, account) directly below <Nav />; it renders
 * nothing while signed out, while verified, once dismissed, or if the status
 * request fails: a banner is never worth an error of its own.
 */
export function VerifyBanner() {
  const [status, setStatus] = useState<VerifyStatus | null>(null);
  const [dismissed, setDismissed] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [inboxUrl, setInboxUrl] = useState('');

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    // A status that will not load draws no banner.
    recoveryApi
      .verifyStatus()
      .then((s) => {
        if (cancelled || s.verified) return;
        let hidden = false;
        try {
          hidden = sessionStorage.getItem(dismissKey(s.email)) === '1';
        } catch {
          // Storage can throw in private windows; treat that as "not dismissed".
        }
        setStatus(s);
        setDismissed(hidden);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || dismissed) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissKey(status.email), '1');
    } catch {
      // Without storage the dismissal lasts until the next render, which is still a dismissal.
    }
    setDismissed(true);
  };

  const resend = async () => {
    setBusy(true);
    setNote('');
    try {
      const res = await recoveryApi.requestVerification();
      setNote(res.verified ? 'Already verified.' : res.message || `Sent to ${status.email}.`);
      setInboxUrl(res.inboxUrl || '');
    } catch (err) {
      setNote(describeError(err, 'The link could not be sent. Try again in a moment.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b-1.5 border-edge bg-tint" role="status" data-testid="verify-banner">
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-ink2">
          Confirm your email address to help recover your account:{' '}
          <span className="mono break-all text-ink">{status.email}</span>.
        </p>
        <div className="flex items-center gap-2">
          {note && (
            <span className="label" data-testid="verify-banner-note">
              {note}
            </span>
          )}
          {inboxUrl && <a href={inboxUrl} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm">Open local test inbox</a>}
            <button
              onClick={resend}
              disabled={busy}
              className="btn-secondary btn-sm"
              data-testid="verify-resend"
            >
              {busy ? 'Sending…' : 'Send confirmation link'}
            </button>
          <button onClick={dismiss} className="btn-ghost btn-sm" data-testid="verify-dismiss">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { api, googleSignInUrl, ssoSignInUrl, markGoogleSignInStarted } from '@/lib/api';
import type { AuthProviders } from '@learnsdlc/shared';
import { AuthNotice, AuthRule } from './AuthLayout';
import { safeLocalPath } from '@/lib/navigation';

/**
 * The first way in, when the server has an OAuth client: one button, then the
 * rule the password form sits under.
 *
 * Whether the button exists at all is the server's answer, not a build-time
 * flag, so one image runs both a deployment with Google configured and one
 * without. It renders nothing until that answer arrives, because a button
 * that appears and then disappears is worse than one that arrives late, and
 * a deployment without Google is the case that must look untouched.
 */
export function GoogleSignIn({ label = 'Continue with Google' }: { label?: string }) {
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [next, setNext] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // A 401 mid-session redirects to /login?next=<where they were>; carrying
    // it through Google puts them back on the phase they were working on.
    const next = new URLSearchParams(window.location.search).get('next');
    const destination = safeLocalPath(next, '');
    setNext(destination);

    // A failed read leaves `providers` null, so the provider buttons stay hidden and
    // email and password sign-in remains: the safe answer when the list is unknown.
    let live = true;
    api
      .providers()
      .then((p) => live && setProviders(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!providers) return null;
  const configured = providers.ssoProviders?.filter((provider, index, all) => provider.id && provider.label && all.findIndex(item => item.id === provider.id) === index) ?? [];
  const choices = configured.length ? configured : providers.google ? [{ id: 'Google', label: 'Google' }] : [];
  if (!choices.length) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* The mark is what lets the callback page tell this tab's own return
          from a link somebody else built with a token of theirs in it. */}
      {choices.map(provider => <a
        key={provider.id}
        href={providers.authProvider === 'cognito' || configured.length ? ssoSignInUrl(provider.id, next) : googleSignInUrl(next)}
        onClick={event => {
          if (!markGoogleSignInStarted()) {
            event.preventDefault(); setError('This sign-in needs site data in this tab. Allow site data and try again, or use email and password.');
          }
        }}
        className={`lh-sso-button${provider.id === 'Google' ? ' lh-google-button' : ''}`}
        data-testid={provider.id === 'Google' ? 'login-google' : `login-sso-${provider.id}`}
      >
        {provider.id === 'Google' && <span className="lh-google-mark" aria-hidden="true"><img src="/brand/google-g.png" width={20} height={20} alt="" /></span>}
        <span>{provider.id === 'Google' ? label : `Continue with ${provider.label}`}</span>
      </a>)}
      {error && <AuthNotice tone="fail" testId="sso-storage-error">{error}</AuthNotice>}
      <AuthRule />
    </div>
  );
}

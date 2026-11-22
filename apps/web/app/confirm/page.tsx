'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthLayout } from '@/components/landing/AuthLayout';
import { ConfirmationForm } from '@/components/landing/ConfirmationForm';
import { invitationHref, pendingClassCode, registrationEmail } from '@/lib/auth-flow';

export default function ConfirmPage() {
  const router = useRouter();
  const [context, setContext] = useState<{ email: string; code: string; next: string } | null>(null);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setContext({ email: registrationEmail(), code: query.get('code') || pendingClassCode(), next: query.get('next') || '' });
  }, []);
  return <AuthLayout title="Confirm your email" purpose="One last step to make your account ready.">
    {context ? <ConfirmationForm initialEmail={context.email} signInHref={invitationHref('/login', context.code, context.next)}
      onConfirmed={() => router.push(invitationHref('/login?confirmed=1', context.code, context.next))} /> : <p role="status">Loading your confirmation form…</p>}
  </AuthLayout>;
}

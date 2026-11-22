import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthLayout } from '@/components/landing/AuthLayout';
import { SignInPanel } from '@/components/landing/SignInPanel';
// A session that ended says so, above the form.
import { SessionEndedNotice } from './SessionEndedNotice';
// What a managed sign-out ended, once.
import { SignedOutNotice } from './SignedOutNotice';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to LearnSDLC, from the SMU School of Computing and Information Systems.',
  alternates: { canonical: '/login' },
};

export default function LoginPage() {
  return (
    <AuthLayout
      title="Sign in"
      purpose="Let’s get you back to your workspace."
    >
      {/* `useSearchParams` reads the query in the browser, so the page itself
          stays static and the notice appears as soon as it hydrates. */}
      <Suspense fallback={null}>
        <SessionEndedNotice />
      </Suspense>
      <SignedOutNotice />
      <SignInPanel />
    </AuthLayout>
  );
}

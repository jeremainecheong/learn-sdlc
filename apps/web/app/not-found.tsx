import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/landing/PublicLayout';
import { RecoveryHomeLink } from '@/components/landing/RecoveryHomeLink';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <PublicLayout active="status" showStart={false}>
      <section className="lh-status-card lh-frost">
        <p className="label">404</p>
        <h1>That page is not here</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink2">
          The link may be out of date, or the phase you were looking for belongs to a different
          project.
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          <RecoveryHomeLink />
          <Link href="/" className="lh-secondary">
            Back to the front page
          </Link>
        </div>
      </section>
    </PublicLayout>
  );
}

'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { PublicLayout } from '@/components/landing/PublicLayout';
import { homeHrefFor } from '@/lib/navigation';
import { useSession } from '@/lib/session';

/**
 * Route-level error boundary. Without this, a thrown render error in any page
 * shows the browser's blank screen in production.
 *
 * The user is never shown the raw error text (it can carry internal paths and
 * ids) but the digest is, because that is the string that lets someone
 * correlate a report with the server log.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const user = useSession();
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('route error', error);
  }, [error]);

  return (
    <PublicLayout active="status" showStart={false}>
      <section className="lh-status-card lh-frost">
        <p className="inline-flex items-center gap-2 text-[13px] font-medium text-fail">
          <Icon name="warning" size={15} />
          Something went wrong
        </p>
        <h1>This page failed to load</h1>
        {/* No promise that nothing has been lost: that is not something a
            render error can know. Saving is on a debounce and the
            last write out can fail, so the page says what is true: everything
            up to the last save is on the server, the seconds after it may not
            be, and the file is worth a look. */}
        <p className="mt-3 text-[15px] leading-relaxed text-ink2" data-testid="error-work-note">
          Your work up to the last save is on the server. The seconds of typing after it may not
          have reached it, so check the file when you go back.
        </p>
        {error.digest && (
          <p className="mono mt-3 break-all text-muted">Reference {error.digest}</p>
        )}
        <div className="mt-6 flex flex-wrap gap-2.5">
          <button onClick={reset} className="lh-primary">
            Try again
          </button>
          <Link href={homeHrefFor(user)} className="lh-secondary">
            Back to home
          </Link>
        </div>
      </section>
    </PublicLayout>
  );
}

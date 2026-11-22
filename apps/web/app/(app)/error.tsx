'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/Icon';
import { homeHrefFor } from '@/lib/navigation';
import { useSession } from '@/lib/session';

/**
 * The error boundary for the signed-in half of the app.
 *
 * Next resolves a thrown render error at the nearest boundary above it. Without
 * this file the nearest one would be `app/error.tsx`, a full-height page of its
 * own: one pane throwing inside the workspace would replace the top bar, the
 * sidebar and all three panes with a single card, unmounting the very shell
 * `app/(app)/layout.tsx` exists to keep alive, and leaving the learner with no
 * way back to their work except the browser's back button.
 *
 * This boundary sits inside that layout, so it takes the place of the page and
 * nothing else: the bar, the sidebar and the learner's bearings all survive,
 * and "Try again" re-renders the route in the shell it never left.
 *
 * The raw error text is not shown (it can carry internal paths and ids) but
 * the digest is, because that is the string that lets someone correlate a
 * report with the server log.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const user = useSession();
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('app route error', error);
  }, [error]);

  return (
    <main id="main" tabIndex={-1} className="min-w-0 flex-1 overflow-y-auto" data-testid="app-error">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3.5 p-4 sm:p-6">
        <div className="panel p-6">
          <p className="inline-flex items-center gap-2 text-[13px] font-medium text-fail">
            <Icon name="warning" size={15} />
            Something went wrong
          </p>
          <h1 className="h1 mt-2">This page stopped working</h1>
          {/* The same honest note the root boundary carries: a render error
              cannot know what reached the server, and saving is on a debounce. */}
          <p className="mt-3 text-[15px] leading-relaxed text-ink2" data-testid="error-work-note">
            Your work up to the last save is on the server. The seconds of typing after it may not
            have reached it, so check the file when you go back.
          </p>
          {error.digest && <p className="mono mt-3 break-all text-muted">Reference {error.digest}</p>}
          <div className="mt-6 flex flex-wrap gap-2.5">
            <button onClick={reset} className="btn" data-testid="error-retry">
              Try again
            </button>
            <Link href={homeHrefFor(user)} className="btn-secondary">
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

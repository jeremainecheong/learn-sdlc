'use client';

/**
 * The frame every signed-in page is drawn in, mounted once.
 *
 * This is the whole point of the route group: the bar and the sidebar are
 * created when the tab loads and are never created again, so a navigation
 * changes the text inside them rather than throwing them away and building a
 * new pair. A remount on every navigation would show a sidebar with one row
 * while a role effect ran, a missing name, a moon on a dark page, and a bell
 * that counted on Home and nowhere else.
 *
 * It also carries the three things every signed-in page needs when something
 * stops working: SessionGate confirms the profile before this frame mounts,
 * the offline banner is drawn here once, and {@link RetryNotice} and
 * {@link PaneBoundary} live here so all four learner pages say the same thing
 * in the same words.
 */
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { Notice } from '@/components/ui';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ViewAsBanner } from './ViewAsBanner';
import { SessionNotices } from './SessionNotices';
import { CoachMarks } from './CoachMarks';
import { tourPageFromPath } from './tours';
import './shell-fidelity.css';
import './page-loading.css';
export { SessionGate } from './SessionGate';

/**
 * One line across the top of the frame while the browser says it is offline.
 *
 * Without it every failure downstream looks like the app breaking, and the one
 * thing the learner can act on, the wifi, goes unsaid.
 */
function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const read = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false);
    read();
    window.addEventListener('online', read);
    window.addEventListener('offline', read);
    return () => {
      window.removeEventListener('online', read);
      window.removeEventListener('offline', read);
    };
  }, []);

  if (!offline) return null;
  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="print-hide shrink-0 border-b-1.5 border-warn/30 bg-warntint px-4 py-1.5 text-center text-[12.5px] text-warn"
    >
      You are offline. Nothing can be saved or loaded until the connection is back.
    </div>
  );
}

/**
 * The one notice a learner-facing page shows when the loader could not answer,
 * with the one control that fixes it.
 *
 * A raw message with no way out of it would leave a red line on the screen
 * after a blip during a restart until someone thought to reload the tab. The
 * message is already plain English by the time it reaches
 * here (lib/useProject, `learnerMessage`); this adds the button.
 */
export function RetryNotice({
  message,
  onRetry,
  busy = false,
  tone = 'fail',
  testId = 'load-error',
}: {
  message: string;
  onRetry: () => void;
  /** True while the retry is in flight, so the button says what it is doing. */
  busy?: boolean;
  tone?: 'fail' | 'warn';
  testId?: string;
}) {
  return (
    <Notice tone={tone} role="alert" testId={testId}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <span className="min-w-0">{message}</span>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          data-testid="retry"
          className="btn-secondary btn-sm shrink-0"
        >
          {busy ? 'Trying…' : 'Try again'}
        </button>
      </div>
    </Notice>
  );
}

// The pane boundary lives in its own module, so a page that is not drawn in
// this frame (the teacher portal's panels) can use it without loading the
// frame; it is re-exported here for the modules that import it from the frame.
export { PaneBoundary } from './PaneBoundary';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const user = useSession();
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    if (user?.role === 'LEARNER' && user.onboardingCompleted === false && path !== '/onboarding') router.replace('/onboarding');
  }, [user, path, router]);
  return (
    <div className="signed-in-frame">
      <Sidebar />
      <div className="shell-main">
      <TopBar />
      {/* Above the offline banner and above the content: an instructor has to
          be able to see, on every route, whose work they are looking at. */}
      <ViewAsBanner />
      {/* The hour this session has left, and the click the end of the last one
          ate. Above the offline banner, because a session that has ended
          is why nothing else on the page can work. */}
      <SessionNotices />
      <OfflineBanner />
      <div className="shell-page">{children}</div>
      </div>
      <CoachMarks key={`${user?.id ?? 'anonymous'}:${path}`} page={tourPageFromPath(path)} />
    </div>
  );
}

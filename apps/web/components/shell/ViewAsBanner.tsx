'use client';

/**
 * One line across the top of the frame while an instructor is viewing a
 * learner's work.
 *
 * The same shape as the offline banner beside it: full width, drawn by the
 * frame so it cannot be scrolled away or missed on a route that forgot it, and
 * a `role="status"` so it is announced when it appears. It sits above the main
 * content in the DOM as well as on the screen, which is what makes *Stop
 * viewing* the first thing a keyboard reaches after the top bar.
 */
import { useRouter } from 'next/navigation';
import { stopViewAs, useViewAs } from '@/lib/view-as';
import { resetProject } from '@/lib/useProject';

export function ViewAsBanner() {
  const router = useRouter();
  const viewing = useViewAs();
  if (!viewing) return null;

  const stop = () => {
    stopViewAs();
    // The project cache is keyed on the token, and the token did not change,
    // so nothing else would drop the learner's enrolment on the way out.
    resetProject();
    router.push(`/instructor/learners/${encodeURIComponent(viewing.userId)}`);
  };

  return (
    <div
      role="status"
      data-testid="view-as-banner"
      className="print-hide flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1.5 border-b-1.5 border-warn/30 bg-warntint px-4 py-1.5 text-center text-[12.5px] text-warn"
    >
      <span className="min-w-0">
        You are viewing {viewing.displayName}&apos;s work. Nothing here can be changed.
      </span>
      <button
        type="button"
        onClick={stop}
        data-testid="view-as-stop"
        className="shrink-0 rounded-ctl border-1.5 border-warn/40 px-2 py-0.5 font-medium text-warn transition-colors hover:bg-warn/10"
      >
        Stop viewing
      </button>
    </div>
  );
}

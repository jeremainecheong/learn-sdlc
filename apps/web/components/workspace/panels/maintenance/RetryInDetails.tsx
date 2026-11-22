'use client';

/**
 * Two readings the change request page takes once Maintenance has passed.
 *
 * - "Retry this task" on a passed change request is read inside the header's
 *   Details, as the workspace keeps it in its More menu, rather than in the
 *   body right under the Pass. It is still one press away and does what it
 *   did. `RetryInDetails` is the box that carries it there: the header places
 *   it by its `headerPlacement` (as it places the header's Submit), it keeps
 *   Details open while the retry's own confirm is up, and it holds the control
 *   while a proposal operation runs, as the body's box does.
 * - `changeMerged`: whether the change's pull request is merged, by the rule
 *   the pull request page reads (a release row for the phase, the project
 *   completed, or the learner on a later phase).
 */
import { useCallback, type ReactNode } from 'react';
import type { EnrollmentView, PhaseDetail } from '@learnsdlc/shared';

export function changeMerged(
  enrollment: Pick<EnrollmentView, 'completed' | 'currentPhaseOrder' | 'releases'> | null | undefined,
  detail: Pick<PhaseDetail, 'key' | 'order'>,
): boolean {
  return Boolean(
    enrollment &&
      (enrollment.releases?.some((release) => release.phaseKey === detail.key) ||
        enrollment.completed ||
        enrollment.currentPhaseOrder > detail.order),
  );
}

export function RetryInDetails({ held, children }: { held: boolean; children: ReactNode }) {
  // `inert` while a proposal operation runs: the control looks as it did and cannot be pressed (the body's rule).
  const hold = useCallback((node: HTMLDivElement | null) => {
    if (node) node.inert = held;
  }, [held]);
  return (
    <div
      ref={hold}
      className="phase-header-retry"
      aria-busy={held || undefined}
      data-testid="change-retry-details"
      // Details closes after a door inside it is used; the retry opens its confirm from here, so it stays open.
      onClick={(event) => event.stopPropagation()}
      // Escape inside the confirm closes the confirm, not Details around it.
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.target instanceof Element && event.target.closest('dialog')) event.stopPropagation();
      }}
    >
      {children}
    </div>
  );
}
/** Read by PhaseStrip without rendering: this box goes inside Details. */
RetryInDetails.headerPlacement = (): 'details' => 'details';

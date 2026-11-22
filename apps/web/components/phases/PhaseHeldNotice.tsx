'use client';

import type { PhaseSummary } from '@learnsdlc/shared';
import { previousPhaseOf } from '@learnsdlc/shared';
import { Notice } from '@/components/ui';
import { dueLine, isPast, opensLine, useNow } from '@/lib/schedule';

/**
 * What a locked phase tells the learner who opens it by its own route.
 *
 * A phase is shut for one of two reasons, or both: the phase before it has not
 * passed its gate, or the class holds it back until a release date. The
 * sentence says the gate only while the phase before is not passed, and the
 * class's dates are drawn under it, with the `phase-dates-*`, `phase-opens-*`
 * and `phase-due-*` testids. A due date blocks nothing; it is
 * said as a fact. Both wait for the browser's clock (`useNow`).
 */
export function PhaseHeldNotice({ phase, phases }: { phase: PhaseSummary; phases: readonly PhaseSummary[] | undefined }) {
  const now = useNow();
  // The phase before it in this project, by key: a project holds the phases
  // its teacher chose, so it is not always the one LearnSDLC numbers before it.
  const before = previousPhaseOf({ phases: phases ?? [] }, phase.key);
  const gateHeld = !before || before.status !== 'passed';
  const opens = now !== null && phase.opensAt && !isPast(phase.opensAt, now) ? phase.opensAt : null;
  return (
    <>
      <Notice tone="warn">
        {gateHeld || !opens
          ? `Pass your current phase before opening ${phase.title}.`
          : `${phase.title} opens on its release date.`}
      </Notice>
      {(opens || (now !== null && phase.dueAt)) && (
        <p className="label-sm mt-3" data-testid={`phase-dates-${phase.key}`}>
          {opens && (
            <span className="block" data-testid={`phase-opens-${phase.key}`}>
              {opensLine(opens)}
            </span>
          )}
          {now !== null && phase.dueAt && (
            <span className={`block ${isPast(phase.dueAt, now) ? 'text-warn' : ''}`} data-testid={`phase-due-${phase.key}`}>
              {dueLine(phase.dueAt, now)}
            </span>
          )}
        </p>
      )}
    </>
  );
}

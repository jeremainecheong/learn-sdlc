'use client';

/**
 * The work room's one header row.
 *
 * Which phase this is ("Testing", "Phase 4 of 6"), where it stands (one chip,
 * in the state words of `gate-state.ts`), the optional quick check where there
 * is one, Run tests and Run app where the room has them, and on the right at
 * most one primary action. Every other door, the brief, the phase's document,
 * the planted bugs, a resubmission, Replay tutorial, the phase guide, the
 * phase's details, and Retry this task, is in one labelled menu, "More", on
 * the same row.
 *
 * The menu is drawn with the strip's disclosure markup
 * (`details.phase-strip-details`, its panel and the strip's own styles), so it
 * looks like the strip's Details and every harness that opens that disclosure
 * finds it. It
 * closes on Escape (focus back on its summary), on a press outside it, and
 * after a door inside it is used: except the retry control, whose own
 * confirm dialog opens from inside it and must stay mounted while it is up.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PhaseKey } from '@learnsdlc/shared';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { Chip } from '@/components/ui';
import { PhaseTutorialReplay } from '@/components/shell/PhaseTutorial';
import { dueLine, isPast, useNow } from '@/lib/schedule';
import { phaseArt } from '@/lib/phase';
import { STATE_LABEL, STATE_TONE, type LearnerState } from './gate-state';
import { QuickCheckLine, type QuickCheckOffer } from './QuickCheck';
import { ResetNoteContext } from './TaskResetControl';

/**
 * Where the optional quick check is one item inside More instead
 * of a place on the row. From 701 to 1023 px wide it would need a row of its
 * own under the header, and from 1024 to 1279 px on a window 660 px tall or less
 * (where it would take a second header line; a laptop at 200 per cent zoom, a
 * short window) every row above the editor costs code lines. From 1280 px the
 * header holds it on its one line, so it stays there at any height. Phones
 * keep their own layout (the line at the strip's foot). The ranges are pinned
 * in test/short-window-chrome.test.tsx beside the CSS ones.
 */
export const QUICK_CHECK_IN_MORE = '(min-width: 701px) and (max-width: 1023px), (min-width: 701px) and (max-width: 1279px) and (max-height: 660px)';

// A host without matchMedia (a bare test document) keeps the line on the row.
const queryFor = () => (typeof window.matchMedia === 'function' ? window.matchMedia(QUICK_CHECK_IN_MORE) : null);
function subscribeQuickCheckPlace(listener: () => void) {
  const query = queryFor();
  query?.addEventListener?.('change', listener);
  return () => query?.removeEventListener?.('change', listener);
}
const quickCheckInMore = () => Boolean(queryFor()?.matches);
const quickCheckOnRowOnServer = () => false;

/**
 * Where the optional quick check sits right now: inside the menu (true) or on
 * the header's row. This header reads it, and so does the header of a
 * Maintenance document page, so the three pages of that phase place the
 * line by one rule.
 */
export function useQuickCheckInMore(): boolean {
  return useSyncExternalStore(subscribeQuickCheckPlace, quickCheckInMore, quickCheckOnRowOnServer);
}

export interface PhaseHeaderProps {
  phase: { key: PhaseKey; title: string; dueAt?: string | null };
  /** "Phase 4 of 6", or nothing where the enrolment does not place the phase. */
  place: string | null;
  /** Where the phase stands; nothing draws no chip. */
  state: LearnerState | null;
  /** The one sentence for this phase, read inside the menu. */
  headline?: ReactNode;
  /** The phase's progress chips, read inside the menu. */
  chips?: ReactNode;
  /** Whether the phase offers its lesson, so the menu names the phase guide. */
  lessons?: boolean;
  quickCheck?: QuickCheckOffer | null;
  /** The secondary controls kept on the row (Run tests, Run app). */
  visible?: ReactNode;
  /** The menu's doors, in order. */
  menu?: ReactNode;
  /** The retry control, at the foot of the menu. */
  retry?: ReactNode;
  /** The one primary action, or nothing where the gate band carries it. */
  primary?: ReactNode;
}

export function PhaseHeader({
  phase,
  place,
  state,
  headline,
  chips,
  lessons = false,
  quickCheck = null,
  visible,
  menu,
  retry,
  primary,
}: PhaseHeaderProps) {
  const now = useNow();
  const due = phase.dueAt ?? null;
  const more = useRef<HTMLDetailsElement>(null);
  // The retry control's short status ("Passed before, new attempt", "Task
  // started over"), told from inside the menu, so it stays in view on the row
  // while More is closed. Nothing when it has nothing to say.
  const [note, setNote] = useState<string | null>(null);
  const checkInMore = useQuickCheckInMore();

  // A press outside the open menu closes it. The retry dialog is inside the
  // menu's DOM, so a press on it (or its backdrop) is not outside.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const node = more.current;
      if (!node?.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const closeAfterDoor = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const door = target?.closest('a, button');
    if (!door || !more.current || door.closest('summary')) return;
    // The retry control opens its own confirm from here; it stays mounted.
    if (door.closest('[data-testid="task-reset"], dialog')) return;
    if ((door as HTMLButtonElement).disabled) return;
    more.current.open = false;
    // Later removes its own button, so keyboard focus goes back to More
    // rather than to the document's body.
    if (door.matches('[data-testid="concept-prompt-skip"]')) more.current.querySelector('summary')?.focus();
  };

  return (
    <ResetNoteContext.Provider value={setNote}>
    <div className="phase-strip-approved phase-header" data-testid="phase-strip">
      <div className="phase-strip-identity">
        <img src={phaseArt(phase.key)} alt="" width={36} height={36} />
        <h1 data-testid="phase-title">{phase.title}</h1>
      </div>
      {place && (
        <span className="phase-header-place tabular-nums" data-testid="phase-place">
          {place}
        </span>
      )}
      {state && (
        <Chip tone={STATE_TONE[state]} testId="phase-state">
          {STATE_LABEL[state]}
        </Chip>
      )}
      {note && (
        <span className="phase-header-note" data-testid="phase-retry-note" title={note}>
          {note}
        </span>
      )}
      <div className="phase-strip-spacer" />
      {!checkInMore && <QuickCheckLine offer={quickCheck} inline />}
      {visible}
      <details
        ref={more}
        className="phase-strip-details"
        data-testid="phase-more"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && event.currentTarget.open) {
            event.currentTarget.open = false;
            event.currentTarget.querySelector('summary')?.focus();
          }
        }}
      >
        <summary aria-label="More phase actions" data-testid="phase-more-toggle">
          More <ChevronDown size={13} aria-hidden="true" />
        </summary>
        <div className="phase-strip-detail-panel" onClick={closeAfterDoor}>
          {place && <strong className="tabular-nums">{place}</strong>}
          {headline && <p>{headline}</p>}
          {checkInMore && <QuickCheckLine offer={quickCheck} menu />}
          {now !== null && due && (
            <Chip tone={isPast(due, now) ? 'warn' : 'neutral'} testId="phase-strip-due">
              {dueLine(due, now)}
            </Chip>
          )}
          {chips && <div className="phase-strip-chips">{chips}</div>}
          <div className="phase-strip-secondary" role="group" aria-label="Phase actions">
            <PhaseTutorialReplay />
            {lessons && (
              <Link href={`/learn/${phase.key}`} className="phase-strip-guide">
                Optional phase guide
              </Link>
            )}
            {menu}
          </div>
          {retry && <div className="phase-header-retry">{retry}</div>}
        </div>
      </details>
      {primary && <div className="phase-strip-primary">{primary}</div>}
    </div>
    </ResetNoteContext.Provider>
  );
}

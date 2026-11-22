'use client';

/**
 * The brief and the mentor in and out of the focused mode.
 *
 * Under 520 px of pane area the work room is focused: the brief and the mentor
 * collapse, and their switches open them for this visit without touching the
 * learner's stored preference. Two moments must never leave a native modal (a
 * proposal being compared, an explanation being written) open inside a hidden
 * column, where the learner could neither see it nor reach its Close:
 *
 * - **entering** the focused mode keeps a side that holds an open modal;
 * - **leaving** it hands the sides back to the stored preference, except a side
 *   the learner had open in the mode that holds a true modal (`showModal`) and
 *   that the preference would close (it was opened just for the visit). That side stays open until its modal closes, then
 *   follows the preference. Pressing the side's own switch meanwhile is the
 *   learner's choice and ends the hold.
 *
 * The modal is never closed for the learner: what they were writing in it stays
 * where it was.
 */

import { useEffect, useState, type SetStateAction } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';
import type { WorkspacePanelsState } from './WorkspacePanels';

type Side = 'brief' | 'mentor';
type Sides = { brief?: boolean; mentor?: boolean };

/**
 * Whether the room's side column holds an open dialog right now: any open
 * `<dialog>`, as the mode has always read it on the way in (a compact chat
 * panel is a non-modal `<dialog open>` too, ChatSurface).
 */
export function sideHoldsModal(side: Side): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.querySelector(`[data-workspace-panel="${side}"] dialog[open]`));
}

/**
 * Whether the side holds a true modal (`showModal`, the top layer): the only
 * thing worth keeping a side open for on the way out. A non-modal
 * `<dialog open>` is ordinary content: the mentor's chat panel is always one,
 * and reading it as a modal kept the mentor open on every phone that left the
 * mode, so the pane switcher drew four tabs in a 104 px row (the a11y reflow
 * case, Deployment's Runbook at 360 px with the sidebar pinned).
 */
export function sideHoldsTrueModal(side: Side): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll(`[data-workspace-panel="${side}"] dialog[open]`)).some((dialog) => {
    try {
      return dialog.matches(':modal');
    } catch {
      return false;
    }
  });
}

const apply = (update: SetStateAction<boolean>, now: boolean) => (typeof update === 'function' ? update(now) : update);

export function useFocusPanels(focused: boolean, stored: WorkspacePanelsState): WorkspacePanelsState {
  const [visit, setVisit] = useState<Sides>({});
  const [held, setHeld] = useState<Sides>({});

  // Before paint, so the column is never hidden under the modal for a frame.
  useIsoLayoutEffect(() => {
    if (focused) {
      setHeld({});
      setVisit((now) => ({ brief: now.brief ?? (sideHoldsModal('brief') || undefined), mentor: now.mentor ?? (sideHoldsModal('mentor') || undefined) }));
      return;
    }
    // Only a side the learner had open in the mode, that the preference would
    // close, and that holds a true modal.
    setHeld({
      brief: (visit.brief === true && !stored.briefOpen && sideHoldsTrueModal('brief')) || undefined,
      mentor: (visit.mentor === true && !stored.mentorOpen && sideHoldsTrueModal('mentor')) || undefined,
    });
    setVisit({});
    // Only the change of mode decides; the stored preference is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  // A held side lets go once its modal has closed. `close` does not bubble,
  // so it is heard in the capture phase.
  const holding = Boolean(held.brief || held.mentor);
  useEffect(() => {
    if (!holding) return;
    const onClose = () => {
      setHeld((now) => {
        const next = { brief: (now.brief && sideHoldsTrueModal('brief')) || undefined, mentor: (now.mentor && sideHoldsTrueModal('mentor')) || undefined };
        return next.brief === now.brief && next.mentor === now.mentor ? now : next;
      });
    };
    document.addEventListener('close', onClose, true);
    return () => document.removeEventListener('close', onClose, true);
  }, [holding]);

  if (focused) {
    return {
      ...stored,
      briefOpen: visit.brief ?? false,
      mentorOpen: visit.mentor ?? false,
      setBriefOpen: (update) => setVisit((now) => ({ ...now, brief: apply(update, now.brief ?? false) })),
      setMentorOpen: (update) => setVisit((now) => ({ ...now, mentor: apply(update, now.mentor ?? false) })),
    };
  }
  if (!holding) return stored;
  return {
    ...stored,
    briefOpen: stored.briefOpen || Boolean(held.brief),
    mentorOpen: stored.mentorOpen || Boolean(held.mentor),
    setBriefOpen: (update) => {
      const open = stored.briefOpen || Boolean(held.brief);
      setHeld((now) => ({ ...now, brief: undefined }));
      stored.setBriefOpen(apply(update, open));
    },
    setMentorOpen: (update) => {
      const open = stored.mentorOpen || Boolean(held.mentor);
      setHeld((now) => ({ ...now, mentor: undefined }));
      stored.setMentorOpen(apply(update, open));
    },
  };
}

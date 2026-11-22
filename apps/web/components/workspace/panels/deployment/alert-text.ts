/**
 * What the faulted copy printed when the learner was paged: the line the
 * incident drill is diagnosed from.
 *
 * The API returns it once, in the answer to Start the drill
 * (`workflow.service.ts`, `drillStart`), and nowhere else: the drill state the
 * phase carries on a re-read has no copy of it, and the review's report holds
 * one only after the next review. So a page that was not the one that started
 * the drill, or the same page opened again, had nothing to show and said "This
 * page no longer holds the alert text".
 *
 * The page that starts the drill keeps the text for this browser tab, keyed by
 * the phase and by the drill's `pagedAt`, so every page of the phase can show
 * it while that drill is open. A drill paged at another moment (a new drill
 * after a reset) never reads an older drill's text and clears it, and so does
 * a resolved drill. No drill reads nothing and clears nothing, because a page
 * holds no drill until the phase has loaded. Storage that is missing or refuses answers nothing, and the
 * page keeps its sentence. Nothing here is sent anywhere or graded.
 */
import { useEffect, useState } from 'react';
import type { DrillState } from '@learnsdlc/shared';
import { onSessionEnd } from '@/lib/session';
import { DRILL_ALERT_PREFIX } from '@/lib/drill-alert-key';

/** The longest text kept, so one long output cannot fill the tab's storage. */
const MAX_KEPT = 20_000;

const PREFIX = DRILL_ALERT_PREFIX;
const keyOf = (phaseId: string) => `${PREFIX}${phaseId}`;

/*
 * Signing out leaves nothing of this account's drills for the next one in the same tab: `clearSession` removes every
 * key under this prefix itself, loaded or not (`lib/session.ts`), and this sweep, registered when the module loads,
 * also covers the session's other ends (a sign-in over a live session, a profile cleared) on a page that loaded it.
 */
onSessionEnd(() => {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key);
  } catch { /* nothing kept */ }
});

function forget(phaseId: string): void {
  try { sessionStorage.removeItem(keyOf(phaseId)); } catch { /* nothing kept */ }
}

/** Keep what the paged run printed, for the drill paged at `pagedAt`. */
export function rememberDrillAlert(phaseId: string, pagedAt: string, text: string): void {
  if (!text) return;
  try {
    sessionStorage.setItem(keyOf(phaseId), JSON.stringify({ pagedAt, text: text.slice(0, MAX_KEPT) }));
  } catch { /* nothing kept: the page keeps its sentence */ }
}

/**
 * The text kept for this drill, or '' when there is none: no drill (yet), a
 * resolved drill or a drill paged at another moment (these two clear what was
 * kept), or no storage.
 */
export function heldDrillAlert(phaseId: string, drill: Pick<DrillState, 'pagedAt' | 'resolvedAt'> | null): string {
  if (!drill) return '';
  if (drill.resolvedAt) {
    forget(phaseId);
    return '';
  }
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(keyOf(phaseId)) ?? 'null');
    if (!raw || typeof raw !== 'object') return '';
    const { pagedAt, text } = raw as { pagedAt?: unknown; text?: unknown };
    if (pagedAt !== drill.pagedAt || typeof text !== 'string') {
      forget(phaseId);
      return '';
    }
    return text;
  } catch {
    return '';
  }
}

/**
 * {@link heldDrillAlert} for a page: read after mount, so the server's render
 * and the first client render agree, and again whenever the drill moves
 * (paged, resolved, gone).
 */
export function useHeldDrillAlert(phaseId: string, drill: Pick<DrillState, 'pagedAt' | 'resolvedAt'> | null): string {
  const [held, setHeld] = useState('');
  const pagedAt = drill?.pagedAt ?? null;
  const resolvedAt = drill?.resolvedAt ?? null;
  useEffect(() => {
    setHeld(heldDrillAlert(phaseId, pagedAt === null ? null : { pagedAt, resolvedAt }));
  }, [phaseId, pagedAt, resolvedAt]);
  return held;
}

'use client';

/**
 * The optional quick check, offered in one line.
 *
 * It offers "Quick check before you start" before a phase and "What did you
 * learn?" once it has passed, and it is optional: not graded, locks nothing, no modal, no focus taken, and
 * "Later" puts it away for this visit only (a reload of the page is the same
 * visit; see {@link useQuickCheckOffer}). It is one line in the band above
 * the room rather than a card, so it never pushes the panes
 * down by more than that line.
 *
 * The phase layout holds the offer ({@link QuickCheckProvider}). A room that
 * has a place for it in its own header claims it
 * ({@link useClaimedQuickCheck}) and draws it there, inline; any other room
 * gets the line from the layout, above the room.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui';
import { conceptApi, conceptHref, conceptTitle, conceptToOffer, type ConceptKind } from '@/lib/api-concept';
import { usePhaseTutorialOpen } from './concept/tutorial-open';

/** The offer the line draws, or nothing to offer. */
export interface QuickCheckOffer {
  phaseId: string;
  kind: ConceptKind;
  /** How many questions the check has; 0 where the API did not say. */
  questions: number;
  putAway: () => void;
}

/**
 * "6 questions, not graded." The word "Optional" is the line's own label,
 * drawn before the title at every width, so the sentence does not
 * repeat it; it is the part that gives way first where the row is short.
 */
export function quickCheckSentence(questions: number): string {
  return questions > 0
    ? `${questions} ${questions === 1 ? 'question' : 'questions'}, not graded.`
    : 'Not graded.';
}

const LATER_KEY = 'lsdlc_quick_check_later:';
/** Whether a phase layout has mounted in this document yet: only the first one can be the page a reload restored. */
let layoutMountedHere = false;
/** This document was loaded by a reload (the browser's own navigation entry says so). */
function documentReloaded(): boolean {
  try {
    const entry = window.performance?.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === 'reload';
  } catch { return false; }
}
/**
 * What "Later" put away before a reload, for the first layout this reloaded
 * document mounts. Any other mount is an entry to the phase, which offers the
 * check afresh, so it reads nothing.
 */
function laterBeforeReload(phaseId: string): ReadonlySet<ConceptKind> {
  if (typeof window === 'undefined' || layoutMountedHere || !documentReloaded()) return new Set();
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(LATER_KEY + phaseId) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((kind): kind is ConceptKind => kind === 'before' || kind === 'after') : []);
  } catch { return new Set(); }
}
function writeLater(phaseId: string, kinds: ReadonlySet<ConceptKind>) {
  try {
    if (kinds.size) window.sessionStorage.setItem(LATER_KEY + phaseId, JSON.stringify([...kinds]));
    else window.sessionStorage.removeItem(LATER_KEY + phaseId);
  } catch { /* Kept for this mount only. */ }
}

/**
 * Which check to offer on this visit, if any: asked once per room visit, again
 * when the phase's status moves (passing it opens the after check), never on
 * the check's own page and never under the phase tutorial.
 */
export function useQuickCheckOffer(phaseId: string, phaseStatus?: string, enabled = true): QuickCheckOffer | null {
  const [offer, setOffer] = useState<{ kind: ConceptKind; questions: number } | null>(null);
  /*
   * What "Later" put away on this visit to the phase. A
   * visit is the time the phase layout holds the phase: moving between its
   * pages keeps it, and so does a reload of one of them, so the offer does not
   * come back in the same sitting. The choice is written to
   * this tab's sessionStorage as it changes and read back only by the first
   * layout a reloaded document mounts (`laterBeforeReload`). Every other entry
   * to the phase (a link, a typed address, Back after leaving it) offers the
   * check again until it is taken (the check nudges, it never blocks), and
   * clears what an earlier visit left. A storage that is
   * missing or throws keeps the choice for this mount only.
   */
  const [later, setLater] = useState<ReadonlySet<ConceptKind>>(() => laterBeforeReload(phaseId));
  useEffect(() => { layoutMountedHere = true; }, []);
  useEffect(() => {
    writeLater(phaseId, later);
    return () => writeLater(phaseId, new Set());
  }, [phaseId, later]);
  const pathname = usePathname() ?? '';
  const onCheckPage = /\/concept\/?$/.test(pathname);
  const tutorialOpen = usePhaseTutorialOpen();

  useEffect(() => {
    if (!enabled || onCheckPage) {
      setOffer(null);
      return;
    }
    let stale = false;
    setOffer(null);
    conceptApi.status(phaseId).then(
      (quizzes) => {
        if (stale) return;
        const kind = conceptToOffer(quizzes);
        setOffer(kind ? { kind, questions: quizzes?.[kind]?.questionCount ?? 0 } : null);
      },
      () => {
        // 404 (no checks for this phase) or any failure: say nothing.
        if (!stale) setOffer(null);
      },
    );
    return () => {
      stale = true;
    };
  }, [phaseId, phaseStatus, onCheckPage, enabled]);

  const kind = offer?.kind;
  const putAway = useCallback(() => {
    if (kind) setLater((kinds) => new Set(kinds).add(kind));
  }, [kind]);

  return useMemo(() => {
    if (!enabled || onCheckPage || tutorialOpen || !offer || later.has(offer.kind)) return null;
    return { phaseId, kind: offer.kind, questions: offer.questions, putAway };
  }, [enabled, onCheckPage, tutorialOpen, offer, later, phaseId, putAway]);
}

/**
 * The line. `inline` is the room header's version: it sits in the header's
 * own row and wraps under it only where the row has no room for it. `menu` is
 * the same line as one item inside the header's More (on a short or narrow
 * window), with the same words and buttons.
 */
export function QuickCheckLine({ offer, inline = false, menu = false }: { offer: QuickCheckOffer | null; inline?: boolean; menu?: boolean }) {
  if (!offer) return null;
  const title = conceptTitle(offer.kind);
  return (
    <section
      aria-label={title}
      className={`quick-check-line ${inline ? 'quick-check-line-inline' : ''} ${menu ? 'quick-check-line-menu' : ''}`.replace(/\s+/g, ' ').trim()}
      data-testid="concept-prompt"
    >
      <p className="quick-check-text">
        <span className="chip chip-outline quick-check-optional" data-testid="concept-prompt-optional">Optional</span>{' '}
        <strong data-testid="concept-prompt-title">{title}</strong>{' '}
        <span data-testid="concept-prompt-body">{quickCheckSentence(offer.questions)}</span>
      </p>
      <span className="quick-check-actions">
        <Button href={conceptHref(offer.phaseId, offer.kind)} variant="secondary" size="sm" testId="concept-prompt-start">
          Take the quick check
        </Button>
        <Button variant="ghost" size="sm" onClick={offer.putAway} testId="concept-prompt-skip">
          Later
        </Button>
      </span>
    </section>
  );
}

type Slot = { offer: QuickCheckOffer | null; claim: () => () => void };
const QuickCheckSlot = createContext<Slot | null>(null);

/**
 * The offer for one phase, held by the phase layout. Draws the line above the
 * room unless a room inside has claimed it for its own header.
 */
export function QuickCheckProvider({
  phaseId,
  phaseStatus,
  enabled = true,
  children,
}: {
  phaseId: string;
  phaseStatus?: string;
  /** False on the check's own page, which offers nothing. */
  enabled?: boolean;
  children: ReactNode;
}) {
  const offer = useQuickCheckOffer(phaseId, phaseStatus, enabled);
  const [claims, setClaims] = useState(0);
  const claim = useCallback(() => {
    setClaims((n) => n + 1);
    return () => setClaims((n) => n - 1);
  }, []);
  const slot = useMemo(() => ({ offer, claim }), [offer, claim]);
  return (
    <QuickCheckSlot.Provider value={slot}>
      {claims === 0 && <QuickCheckLine offer={offer} />}
      {children}
    </QuickCheckSlot.Provider>
  );
}

/**
 * Take the offer for this room's header. Outside a provider (a unit test that
 * mounts the room bare) there is nothing to claim and nothing to draw.
 */
export function useClaimedQuickCheck(): QuickCheckOffer | null {
  const slot = useContext(QuickCheckSlot);
  const claim = slot?.claim;
  useEffect(() => (claim ? claim() : undefined), [claim]);
  return slot?.offer ?? null;
}

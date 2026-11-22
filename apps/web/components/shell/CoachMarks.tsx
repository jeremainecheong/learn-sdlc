'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '@/components/ui';
import { registerTourReplay, markTourSeen, marksFor, phaseTutorialMarks, phaseTutorialTitle, phaseTutorialSeen, markPhaseTutorialSeen, type PhaseTutorialScope, type CoachMark, type TourPage } from './tours';
import './CoachMarks.css';
export type { CoachMark, TourPage };

/**
 * The outermost closed `<details>` (a menu such as the work room's More) that
 * hides the element: one it sits inside other than in that menu's own
 * `<summary>`. A real browser still lays such an element out with a size, so
 * the size test alone would spotlight empty space where the closed panel would
 * open. Null when nothing closed hides it.
 */
export function closedDetailsAround(element: Element): HTMLDetailsElement | null {
  let hiding: HTMLDetailsElement | null = null;
  for (let details = element.parentElement?.closest('details') ?? null; details; details = details.parentElement?.closest('details') ?? null) {
    if (details.open) continue;
    const summary = details.querySelector(':scope > summary');
    if (!summary?.contains(element)) hiding = details;
  }
  return hiding;
}

function targetFor(mark: CoachMark): HTMLElement | undefined {
  const selector = mark.selector ?? `[data-testid="${mark.target}"]${mark.altTarget ? `,[data-testid="${mark.altTarget}"]` : ''}`;
  for (const candidate of [selector, ...(Array.isArray(mark.fallbackSelector) ? mark.fallbackSelector : [mark.fallbackSelector])]) {
    if (!candidate) continue;
    const target = Array.from(document.querySelectorAll<HTMLElement>(candidate)).find(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return !element.closest('[hidden], [inert]') && !closedDetailsAround(element) && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    });
    if (target) return target;
  }
}
const FALLBACK: CoachMark = { target: 'nav-user', title: 'Find your way around', body: 'This page has no visible tour targets yet. You can close this tour, wait for the page to finish opening, and choose Show me around again from your account menu or search.' };
function blockingDialog(except?: HTMLDialogElement | null): boolean {
  // Compact ChatSurface panels are deliberately nonmodal <dialog open>.
  // Only their expanded mode blocks another modal (as with workspace shortcuts).
  return Array.from(document.querySelectorAll('dialog[open]:not(.chat-surface), .chat-surface[aria-modal="true"]')).some(node => node !== except);
}

/** One modal tour. It never clicks a target, navigates, or saves work. */
export function CoachMarks({ page = 'home', marks, force = false, onDone, phaseTutorial, onOpenChange }: {
  page?: TourPage; marks?: CoachMark[]; force?: boolean; onDone?: () => void; phaseTutorial?: PhaseTutorialScope;
  /** Told whenever the tour opens or closes. Optional. */
  onOpenChange?: (open: boolean) => void;
}) {
  const phaseKey = phaseTutorial?.phaseKey;
  // The last step names the phase guide only where the strip
  // draws it; the phase layout says which (`PhaseTutorialScope.lessons`).
  const lessons = phaseTutorial?.lessons ?? true;
  // An own application's room draws no App preview or Change request; the tour follows it.
  const provenance = phaseTutorial?.provenance;
  // A Design room of its own names only the tabs its pack switched on.
  const design = phaseTutorial?.design;
  const list = useMemo(() => marks ?? (phaseKey ? phaseTutorialMarks(phaseKey, lessons, provenance, design) : marksFor(page)), [marks, page, phaseKey, lessons, provenance, design]);
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<CoachMark[]>([]);
  const [at, setAt] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [cardPosition, setCardPosition] = useState<{ left: number; top: number } | undefined>();
  const dialog = useRef<HTMLDialogElement>(null);
  const card = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const returnToSearch = useRef(false);
  const showFailed = useRef(false);
  const scopeRef = useRef(phaseTutorial);
  scopeRef.current = phaseTutorial;
  const openChange = useRef(onOpenChange);
  openChange.current = onOpenChange;
  // Before paint, so what the listener hides is gone before the highlight is measured again.
  useLayoutEffect(() => { openChange.current?.(open); }, [open]);
  useLayoutEffect(() => () => openChange.current?.(false), []);
  const trap = useDialogFocus(dialog, open);
  const start = useCallback((automatic = false) => {
    if (automatic && showFailed.current) return;
    if (!automatic) showFailed.current = false;
    if (scopeRef.current && (!scopeRef.current.ready || !scopeRef.current.ownerId)) return;
    // An account-menu click closes its own modal later in the same event.
    // Check modality after React commits that close, immediately before showing.
    if (!dialog.current?.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      returnToSearch.current = Boolean(previousFocus.current?.closest('[data-testid="palette"]'));
    }
    const unavailable = document.querySelector('[data-testid="phase-locked"], [data-testid="phase-opening"], [data-testid="phase-view-mismatch"]');
    const currentList = unavailable ? marksFor('page') : !scopeRef.current && !marks && document.querySelector('[data-testid="requirements-workspace"]') ? marksFor('issue') : list;
    const available = scopeRef.current ? currentList : currentList.filter(mark => targetFor(mark));
    setSteps(available.length ? available : [FALLBACK]); setAt(0); setOpen(true);
  }, [list, marks]);
  useEffect(() => {
    if (phaseTutorial && !phaseTutorial.ready) return;
    return registerTourReplay(() => start(), phaseTutorial ? 1 : 0);
  }, [start, Boolean(phaseTutorial), phaseTutorial?.ready]);
  useEffect(() => { if (force) start(); }, [force, start]);
  useEffect(() => {
    if (!phaseTutorial) return;
    if (!phaseTutorial?.ready || !phaseTutorial.ownerId) { setOpen(false); return; }
    showFailed.current = false;
    const scope = phaseTutorial;
    // A phase the learner has passed and moved on from does not open its tutorial by itself; Replay still does.
    if (phaseTutorialSeen(scope) || scope.movedOn) return;
    let observer: MutationObserver | undefined;
    const stop = () => { observer?.disconnect(); window.removeEventListener('focusin', attempt); };
    const attempt = () => {
      if (phaseTutorialSeen(scope) || scopeRef.current?.movedOn) { stop(); return; }
      if (blockingDialog()) return;
      // A mounted detail is necessary; at least one actual tool must also be visible.
      if (!list.slice(0, -1).some(mark => targetFor(mark))) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return;
      start(true);
    };
    // Modal closure and late async UI updates can make this first entry safe.
    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-modal'] });
    window.addEventListener('focusin', attempt);
    attempt();
    return stop;
  }, [phaseTutorial?.ready, phaseTutorial?.ownerId, phaseTutorial?.phaseId, phaseTutorial?.movedOn, start]);
  const finish = useCallback(() => { setOpen(false); if (scopeRef.current) markPhaseTutorialSeen(scopeRef.current); else markTourSeen(page); onDone?.(); }, [page, onDone]);
  // Open the native dialog before measuring it, all before the browser paints.
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    if (blockingDialog(node)) { setOpen(false); return; }
    try { node.showModal(); } catch { showFailed.current = true; setOpen(false); return; }
    if (!node.open) { showFailed.current = true; setOpen(false); return; }
    if (scopeRef.current) markPhaseTutorialSeen(scopeRef.current);
    next.current?.focus({ preventScroll: true });
    return () => {
      node.close();
      const previous = previousFocus.current;
      const fallback = document.querySelector<HTMLElement>(returnToSearch.current ? '[data-testid="jump-to"]' : '[data-testid="nav-user"]');
      // Replay tutorial pressed from a menu (the work room's More) that closed
      // behind it: focus goes back to the menu's own toggle, not to a hidden
      // button and so to the page.
      const menu = previous?.isConnected ? closedDetailsAround(previous) : null;
      const toggle = menu?.querySelector<HTMLElement>(':scope > summary') ?? null;
      (previous?.isConnected && !previous.closest('dialog:not([open])') ? toggle ?? previous : fallback)?.focus({ preventScroll: true });
    };
  }, [open]);
  // A new step must never paint its text beside the previous step's target.
  useLayoutEffect(() => {
    if (!open || !dialog.current?.open) return;
    const mark = steps[at]; if (!mark) return;
    targetFor(mark)?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    let frame = 0;
    const measure = () => {
      const target = targetFor(mark), viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      dialog.current?.style.setProperty('--coach-vh', `${height}px`);
      if (!target) { setRect(null); setCardPosition(undefined); return; }
      const box = target.getBoundingClientRect();
      const left = Math.max(4, box.left - 4), top = Math.max(4, box.top - 4);
      const right = Math.min(width - 4, box.right + 4), bottom = Math.min(height - 4, box.bottom + 4);
      const visible = right > left && bottom > top;
      setRect(visible ? { left, top, width: right - left, height: bottom - top } : null);
      const size = card.current?.getBoundingClientRect();
      if (visible && size) {
        // Prefer an adjacent card; move it above/aside when it would cover its target.
        const clamp = (value: number, extent: number, limit: number) => Math.max(16, Math.min(value, limit - extent - 16));
        const candidates = [
          { left, top: bottom + 16 }, { left, top: top - size.height - 16 },
          { left: right + 16, top }, { left: left - size.width - 16, top },
          { left: 16, top: 16 }, { left: width - size.width - 16, top: height - size.height - 16 },
        ].map(position => ({ left: clamp(position.left, size.width, width), top: clamp(position.top, size.height, height) }));
        const overlap = (position: { left: number; top: number }) => Math.max(0, Math.min(right, position.left + size.width) - Math.max(left, position.left)) * Math.max(0, Math.min(bottom, position.top + size.height) - Math.max(top, position.top));
        candidates.sort((a, b) => overlap(a) - overlap(b));
        setCardPosition(candidates[0]);
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure(); schedule();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    const target = targetFor(mark); if (target) observer?.observe(target); if (card.current) observer?.observe(card.current);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    window.visualViewport?.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); window.visualViewport?.removeEventListener('resize', schedule); };
  }, [open, at, steps]);
  if (!open) return null;
  const mark = steps[at] ?? FALLBACK, last = at === steps.length - 1;
  return <dialog ref={dialog} className="coach-dialog" data-testid="coach" aria-label={phaseKey ? phaseTutorialTitle(phaseKey) : 'Show me around'} aria-modal="true" aria-describedby="coach-body"
    onCancel={event => { event.preventDefault(); finish(); }}
    onKeyDown={event => { trap.onKeyDown(event); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); } }}>
    {rect && <div className="coach-highlight" style={rect} aria-hidden="true" data-testid="coach-highlight" />}
    <section ref={card} style={cardPosition} className="coach-card" data-testid="coach-card" data-target={mark.target} aria-current="step">
      <div className="coach-heading"><span>{phaseKey ? phaseTutorialTitle(phaseKey) : 'Your quick tour'}</span><span data-testid="coach-count">{at + 1} of {steps.length}</span></div>
      <div className="coach-copy" aria-live="polite" aria-atomic="true"><h2>{mark.title}</h2><p id="coach-body">{mark.body}</p></div>
      {!rect && mark !== FALLBACK && <p className="coach-unavailable">This control is in another view or a closed panel. Follow these steps after closing the tutorial, or use Replay tutorial there.</p>}
      <div className="coach-actions">
        <button type="button" className="btn-secondary" onClick={finish} data-testid="coach-skip">Skip</button>
        <div><button type="button" className="btn-secondary" disabled={at === 0} onClick={() => { if (at === 1) next.current?.focus(); setAt(value => Math.max(0, value - 1)); }} data-testid="coach-back">Back</button>
        <button ref={next} type="button" className="btn" onClick={() => last ? finish() : setAt(value => value + 1)} data-testid="coach-next">{last ? 'Done' : 'Next'}</button></div>
      </div>
    </section>
  </dialog>;
}

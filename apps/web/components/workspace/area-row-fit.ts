'use client';

import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/**
 * Whether the row is too narrow for its entries with the switches' words.
 * Read by the switches at the row's right end, which then drop their
 * words (each keeps its icon, its name and a `title`).
 */
export const AreaRowCompact = createContext(false);

/** From 1024 px the row is one line; under it the row wraps and nothing is compacted. */
const ONE_LINE = '(min-width: 1024px)';
/** The switches' own left margin beside "Saved workspace" or the Code / Results switch, counted once. */
const SLACK = 8;
/** The row's status word (Implementation's "Saved workspace"): a word, not a control. */
export const AREA_ROW_STATUS = 'area-row-status';
/** How far an entry Tab reaches is kept clear of the pinned switches: their width now, and this much more. */
const CLEAR = 8;

/** What the row gives up, in order: nothing, its status word, then the switches' words too; last, its one line. */
type Fit = 0 | 1 | 2 | 3;

/**
 * The row's own measure of whether its entries and the switches fit on its
 * one line. A measured hook rather than a container query: the room a
 * row needs depends on its entries (four to six, and the preview's name),
 * which a fixed container width cannot know, so the row adds up what it
 * holds and compares that with its own width.
 *
 * Where the row has no room for everything, its status word ("Saved
 * workspace", a word and no control) is the first to go: it leaves the view
 * whole, never cut, and stays in the page for assistive technology (the row's
 * `data-quiet`, phase-experience.css). Where that is not enough, the
 * switches drop their words too. Each is counted at its full width while
 * hidden, so it comes back as soon as the row can hold it again. If the row is
 * still too narrow, it wraps onto a second line (`data-wrap`):
 * scrolled sideways under the pinned switches, an entry was cut mid-word ("App
 * previe", "Pull reque" at 1280 px with the brief and the mentor open) with
 * nothing to say there was more. The row's scroll padding is still the
 * switches' real width (`--area-row-end`), for a row that scrolls all the same.
 *
 * It measures before paint (a layout effect, so a row never shows a frame of
 * words it is about to drop), again whenever its box, its content or the
 * one-line media query changes, and again when web fonts finish loading (they
 * change the entries' widths and nothing else would say so): then it measures
 * from the full row once more, since widths remembered in the fallback font
 * no longer hold.
 */
export function useAreaRowFit(): { ref: (node: HTMLElement | null) => void; compact: boolean } {
  const [fit, setFit] = useState<Fit>(0);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const fitNow = useRef<Fit>(0);
  fitNow.current = fit;
  const full = useRef({ status: 0, switches: 0, compact: 0 });
  const ref = useCallback((next: HTMLElement | null) => setNode(next), []);
  const measure = useCallback(() => {
    if (!node || typeof window === 'undefined') return;
    const oneLine = typeof window.matchMedia !== 'function' || window.matchMedia(ONE_LINE).matches;
    const switches = node.querySelector<HTMLElement>(':scope > .workspace-panel-controls-strip');
    const status = node.querySelector<HTMLElement>(`:scope > .${AREA_ROW_STATUS}`);
    const width = node.clientWidth;
    // Not laid out (a hidden column, a test without layout), or nothing to give up: everything stays.
    if (!oneLine || (!switches && !status) || width <= 0) {
      node.style.removeProperty('--area-row-end');
      node.removeAttribute('data-wrap');
      if (fitNow.current !== 0) setFit(0);
      return;
    }
    const style = window.getComputedStyle(node);
    const gap = Number.parseFloat(style.columnGap) || 0;
    const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const entries = [...node.children].filter((child) => child !== switches && child !== status && (child as HTMLElement).getClientRects().length > 0) as HTMLElement[];
    const switchesNow = switches?.getBoundingClientRect().width ?? 0;
    if (fitNow.current < 2) full.current.switches = switchesNow;
    else full.current.compact = switchesNow;
    // The word's whole width, not the width a tight row has squeezed it to: a squeezed word reads as cut
    // ("Saved w") while its box still "fits", so the row would never give it up (seen by hand at 1440 px).
    if (fitNow.current < 1) full.current.status = status ? Math.max(status.getBoundingClientRect().width, status.scrollWidth || 0) : 0;
    const items = entries.length + (switches ? 1 : 0);
    const base = padding + SLACK + gap * Math.max(0, items - 1) + entries.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + full.current.switches;
    const withStatus = base + (status ? gap + full.current.status : 0);
    // Wordless switches, measured once they are drawn so: where the entries and those still do not fit, the row wraps.
    const tight = full.current.compact > 0 && base - full.current.switches + full.current.compact > width + 0.5;
    const next: Fit = withStatus <= width + 0.5 ? 0 : status && base <= width + 0.5 ? 1 : fitNow.current >= 2 && tight ? 3 : 2;
    if (switches) node.style.setProperty('--area-row-end', `${Math.ceil(switchesNow) + CLEAR}px`);
    if (next !== fitNow.current) setFit(next);
  }, [node]);
  // Before paint, after every change of what the row gives up: the status word's mark, then the widths as they are now.
  useIsoLayoutEffect(() => {
    if (!node) return;
    node.toggleAttribute('data-quiet', fit >= 1 && node.querySelector(`:scope > .${AREA_ROW_STATUS}`) !== null);
    node.toggleAttribute('data-wrap', fit === 3);
    measure();
  }, [node, fit, measure]);
  useEffect(() => {
    if (!node || typeof window === 'undefined') return;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    resize?.observe(node);
    // An entry that comes or goes (the Code / Results switch, the preview's name, "Show" for "Hide") changes what the row holds.
    const mutations = typeof MutationObserver === 'function' ? new MutationObserver(measure) : null;
    mutations?.observe(node, { childList: true, subtree: true, characterData: true });
    const media = typeof window.matchMedia === 'function' ? window.matchMedia(ONE_LINE) : null;
    media?.addEventListener?.('change', measure);
    // A web font that has loaded: measure from the full row again (the remembered widths were the fallback font's).
    let live = true;
    const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
    const refit = () => { if (!live) return; if (fitNow.current === 0) measure(); else setFit(0); };
    fonts?.addEventListener?.('loadingdone', refit);
    void fonts?.ready?.then(refit, () => undefined);
    return () => { live = false; resize?.disconnect(); mutations?.disconnect(); media?.removeEventListener?.('change', measure); fonts?.removeEventListener?.('loadingdone', refit); };
  }, [node, measure]);
  return { ref, compact: fit >= 2 };
}

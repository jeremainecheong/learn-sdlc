'use client';

/**
 * How wide the sidebar is, and who decides.
 *
 * Two shapes: `full` is the 232px column the design is drawn around, `rail`
 * is the 76px strip of icons. The learner chooses, with the button at the
 * foot of the sidebar or ⌘B, and the choice is remembered, so no page ever
 * takes the width away on its own. If one page (the map, say) asked for the
 * rail while the pages either side of it asked for the full column, walking
 * between them would snap the furniture back and forth.
 *
 * The one place a page still gets a say is the workspace, and it is a
 * *default* rather than an override: code needs the width, so the first visit
 * to a working page opens on the rail. Widen it there and that is remembered
 * for the workspace alone: leaving it returns to whatever the learner chose
 * for the document pages. Two contexts, two keys, no page-by-page fights.
 *
 * The width has to be right in the first paint, before React exists, or a
 * reload shows the other shape for a frame. So the truth lives on <html> as
 * `data-sidebar`, stamped by {@link SIDEBAR_BOOT_SCRIPT} in <head>, and the
 * two shapes are drawn by CSS off that attribute (see globals.css) rather than
 * by a React branch. React keeps a copy for the things CSS cannot say (the
 * test id and the button's label) and {@link useSidebar} syncs it before
 * paint. This is the same arrangement as the theme.
 */
import { useCallback, useState } from 'react';
import { useIsoLayoutEffect } from '@/lib/use-iso-layout-effect';

/** `full` is the 232px column; `rail` is the 76px strip of icons. */
export type SidebarWidth = 'full' | 'rail';

/** Which of the two remembered widths a route reads. */
export type SidebarContext = 'doc' | 'ide';

/** The document pages' width: Home, the map, the phases, the journal, the shelf. */
export const SIDEBAR_KEY = 'lsdlc_sidebar';
/** The workspace's own width, so an expansion there does not widen the rest. */
export const SIDEBAR_IDE_KEY = 'lsdlc_sidebar_ide';
/** Fired on window whenever the width changes, so both readers follow it. */
export const SIDEBAR_EVENT = 'lsdlc-sidebar';

export const SIDEBAR_KEYS: Record<SidebarContext, string> = {
  doc: SIDEBAR_KEY,
  ide: SIDEBAR_IDE_KEY,
};

/** What a context opens at before the learner has said anything. */
export const SIDEBAR_DEFAULT: Record<SidebarContext, SidebarWidth> = {
  doc: 'rail',
  ide: 'rail',
};

/**
 * All supported phase views share one working-page preference. The interview,
 * backlog, case file and evidence pages use WorkPage just as the editor does;
 * switching between them must not switch to the dashboard's saved width.
 *
 * A new working page has to be named here as well as built on `WorkPage`,
 * because the boot script reads the path and nothing else: it runs before any
 * page has had a chance to declare anything.
 */
const WORK_PATH = /^\/workspace\/[^/?#]+(?:\/(?:design|issue|interview|brief|pr|matrix|drill|change|solution))?\/?$/;

/** Which stored width a route reads. */
export function sidebarContext(pathname: string | null | undefined): SidebarContext {
  return pathname && WORK_PATH.test(pathname) ? 'ide' : 'doc';
}

const isWidth = (v: unknown): v is SidebarWidth => v === 'full' || v === 'rail';

/**
 * Below `lg` there is no room for the 232px column beside the page: at 460px
 * it would leave the page 228px, and at 360 and 390px it would push the
 * change page's "Submit" out of an overflow-hidden main entirely. So a
 * remembered `full` is drawn as the rail below this width
 * (in the first paint, on every restore and whenever the window narrows past
 * it) and the choice itself is kept for a wide window. The one exception is
 * the learner's own press of the toggle, which draws what they asked for on
 * that page and is not remembered.
 */
export const SIDEBAR_NARROW_QUERY = '(max-width: 1023px)';

/** Whether the window is below `lg` right now. False where it cannot be asked. */
export function sidebarNarrow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(SIDEBAR_NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** The width to draw for a remembered one: the rail below `lg`, else the choice. */
export function drawnSidebar(stored: SidebarWidth): SidebarWidth {
  return stored === 'full' && sidebarNarrow() ? 'rail' : stored;
}

/**
 * Runs inline in <head>, before any stylesheet is applied and before React
 * exists, so the first paint is already the right width. Kept as a plain
 * string for `dangerouslySetInnerHTML`: no imports, no modern syntax, wrapped
 * in try/catch because localStorage throws in private windows.
 */
export const SIDEBAR_BOOT_SCRIPT =
  `(function(){try{` +
  `var w=${WORK_PATH}.test(location.pathname);` +
  `var v=localStorage.getItem(w?'${SIDEBAR_IDE_KEY}':'${SIDEBAR_KEY}');` +
  `if(v!=='full'&&v!=='rail'){v='rail'}` +
  `if(v==='full'&&typeof window.matchMedia==='function'&&window.matchMedia('${SIDEBAR_NARROW_QUERY}').matches){v='rail'}` +
  `document.documentElement.setAttribute('data-sidebar',v)` +
  `}catch(e){}})();`;

/** The width remembered for a context, or its default. */
export function storedSidebar(context: SidebarContext): SidebarWidth {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT[context];
  try {
    const stored = window.localStorage.getItem(SIDEBAR_KEYS[context]);
    if (isWidth(stored)) return stored;
  } catch {
    // storage unavailable; the default is no loss
  }
  return SIDEBAR_DEFAULT[context];
}

/** The width actually applied right now, read back off <html>. */
export function appliedSidebar(): SidebarWidth | null {
  if (typeof document === 'undefined') return null;
  const attr = document.documentElement.getAttribute('data-sidebar');
  return isWidth(attr) ? attr : null;
}

/**
 * Puts a width on <html> and tells everything that shows it.
 *
 * `remember` is false when the width is only being restored (arriving on a
 * page whose context reads a different key) and true when the learner
 * actually asked for it. Restoring must not write, or moving to the workspace
 * once would overwrite the document pages' choice with the workspace's.
 */
export function applySidebar(
  context: SidebarContext,
  width: SidebarWidth,
  remember = true,
): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-sidebar', width);
  if (remember) {
    try {
      window.localStorage.setItem(SIDEBAR_KEYS[context], width);
    } catch {
      // storage refused; the attribute still holds for this page
    }
  }
  window.dispatchEvent(new CustomEvent<SidebarWidth>(SIDEBAR_EVENT, { detail: width }));
}

export interface SidebarState {
  width: SidebarWidth;
  /** Which key this route reads and writes. */
  context: SidebarContext;
  rail: boolean;
  /** Switch this context's width, and remember it. */
  toggle: () => void;
}

/**
 * The width as React state, for the parts CSS cannot draw: the test id, the
 * button's label, the palette's row.
 *
 * The storage read is in a layout effect rather than after paint, so React's
 * copy is right in the same commit the page is; the *width itself* is already
 * right before any of this runs, because the boot script stamped it. On a
 * client navigation there is no boot script, and this effect is what changes
 * the class: before the browser paints the page it belongs to.
 */
export function useSidebar(pathname: string | null | undefined): SidebarState {
  const context = sidebarContext(pathname);
  const [width, setWidth] = useState<SidebarWidth>(SIDEBAR_DEFAULT[context]);

  useIsoLayoutEffect(() => {
    const restore = () => {
      const drawn = drawnSidebar(storedSidebar(context));
      applySidebar(context, drawn, false);
      setWidth(drawn);
    };
    restore();
    // Crossing `lg` redraws the remembered width for the new window.
    const narrow =
      typeof window.matchMedia === 'function' ? window.matchMedia(SIDEBAR_NARROW_QUERY) : null;
    // Somebody switched it: this sidebar's own button, the palette's row, or
    // the shortcut. The attribute is already set; only React's copy is behind.
    const onChange = () => setWidth(appliedSidebar() ?? storedSidebar(context));
    // Another tab switched the same context; mirror it without writing back.
    const onStorage = (e: StorageEvent) => {
      if (e.key === SIDEBAR_KEYS[context]) restore();
    };
    window.addEventListener(SIDEBAR_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    narrow?.addEventListener?.('change', restore);
    return () => {
      window.removeEventListener(SIDEBAR_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
      narrow?.removeEventListener?.('change', restore);
    };
  }, [context]);

  const toggle = useCallback(() => {
    const now = appliedSidebar() ?? storedSidebar(context);
    // applySidebar fires the event this hook is listening to, so the state
    // follows from the one path every other switcher takes. Below `lg` the
    // press is for this page only: it is not written, so a phone's open and
    // close never replaces the width chosen on a wide window.
    applySidebar(context, now === 'rail' ? 'full' : 'rail', !sidebarNarrow());
  }, [context]);

  return { width, context, rail: width === 'rail', toggle };
}

import type { Page } from '@playwright/test';

/** A viewport the accessibility spec opens a screen at. */
export type Width = { readonly label: string; readonly width: number; readonly height: number };

/** Below this width a screen is checked as a phone (WCAG 1.4.10's 320 CSS px case, at 360 to 460). */
export const PHONE_BELOW = 600;

/** How many clipped elements or sideways panels a failure line names. */
const NAMED = 4;

export interface ReflowMeasure {
  /** The document's scroll width and the window's inner width. */
  sw: number;
  w: number;
  /** Neighbouring tabs in one row that draw over each other. */
  overlapping: number;
  /** Elements the clip probe measured, and the ones it found cut off. */
  checked: number;
  clipped: { what: string; control: boolean; visible: number }[];
  /** Page-sized panels that scroll sideways. */
  sideways: { what: string; scrollWidth: number; clientWidth: number }[];
}

/**
 * Runs in the page. Self-contained (it is serialised by `page.evaluate`), so
 * it reads nothing from this module.
 *
 * WCAG 1.4.10 in this product does not show as a wide document. Every
 * signed-in screen draws inside `.signed-in-frame` (position: fixed, inset 0,
 * overflow: clip) and every public one inside `.marketing` (overflow: clip),
 * and neither adds to the document's scroll width, so `sw <= w + 1` holds
 * whatever the content does. Content that does not reflow is
 * cut off instead, or it makes a panel inside the frame scroll sideways. So,
 * at phone width:
 *
 * - The clip probe. Every visible element that is interactive or carries
 *   text of its own is measured on the x axis: its box joined with its own
 *   text, intersected with the viewport and with each ancestor that clips it.
 *   An ancestor clips when its overflow-x is hidden, clip, auto or scroll (or
 *   it has paint containment) and it is on the element's containing-block
 *   chain: an absolutely positioned element escapes clipping ancestors below
 *   its positioned containing block, and a fixed one escapes everything below
 *   a transformed, filtered or contained ancestor. Anything that loses more
 *   than 1px is a finding.
 *   Not measured, each on purpose: content inside a real horizontal scroller
 *   (scrollWidth > clientWidth, overflow-x auto or scroll; axe's
 *   scrollable-region-focusable covers its keyboard reach, and the sideways
 *   check below covers a panel that is the page); truncation the design draws
 *   on purpose (text-overflow: ellipsis: the box that truncates is measured,
 *   not the text it hides); visually
 *   hidden text (an ancestor or the element 1px or less wide or tall, or a
 *   `clip` rectangle); content that is not drawn (checkVisibility with
 *   opacity and visibility) or that a reader is told is not there (inert,
 *   aria-hidden); the code editor and the terminal (`.monaco-editor`,
 *   `.xterm`), which scroll themselves and are a 1.4.10 exception; and SVG
 *   internals.
 *   An element that clips (a text area, an input, a select, an
 *   overflow-hidden box) bounds only what overflows it: its own borders and
 *   scrollbar are drawn, so its own clip is its border box, while an
 *   ancestor's clip is that ancestor's padding box.
 * - The sideways check. A visible scroller at least 60% as wide as the main
 *   landmark (or the viewport, without one) that scrolls sideways is the page
 *   scrolling in two directions. Not counted, each a 1.4.10 exception the
 *   markup declares: a data table, a code block or a text area (the scroller
 *   is one, or holds one as a direct child); a picture (svg, img, canvas,
 *   role img) wider than the scroller that holds it; a strip, meaning a tab
 *   list or a named navigation or toolbar whose drawn children are all
 *   controls the keyboard reaches, in one row (the scroller is one, or holds
 *   only one); and a named region in the tab order (role region with an
 *   accessible name and tabindex 0), which arrow keys scroll. A strip that
 *   wraps onto a second row, or holds text that is not a control, is counted.
 */
export function measureReflow(arg: { viewportWidth: number; phone: boolean }): ReflowMeasure {
  // Tabs in one row that draw over each other: the text cannot be read and a
  // tap on one lands on its neighbour, while the document stays one screen
  // wide (for example the project editor's phase row at 390, if each button
  // shrinks below its label and the labels spill over one another). Each
  // tab is measured by what it draws (its contents), not by its box.
  let overlapping = 0;
  for (const list of document.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')]
      .filter((t) => t.getBoundingClientRect().width > 0)
      .map((t) => {
        const range = document.createRange();
        range.selectNodeContents(t);
        const drawn = range.getBoundingClientRect();
        const box = t.getBoundingClientRect();
        return { left: Math.min(box.left, drawn.left), right: Math.max(box.right, drawn.right), top: box.top, bottom: box.bottom };
      })
      .filter((b) => b.bottom > b.top);
    for (let i = 1; i < tabs.length; i++) {
      const a = tabs[i - 1];
      const b = tabs[i];
      const sameRow = a.top < b.bottom && b.top < a.bottom;
      if (sameRow && a.right > b.left + 1) overlapping += 1;
    }
  }
  const measure: ReflowMeasure = {
    sw: document.documentElement.scrollWidth,
    w: window.innerWidth,
    overlapping,
    checked: 0,
    clipped: [],
    sideways: [],
  };
  if (!arg.phone) return measure;

  const SLACK = 1;
  const INTERACTIVE =
    'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])';
  const SELF_SCROLLING_CODE = '.monaco-editor,.xterm';
  const style = new Map<Element, CSSStyleDeclaration>();
  const css = (e: Element) => {
    let s = style.get(e);
    if (!s) {
      s = getComputedStyle(e);
      style.set(e, s);
    }
    return s;
  };
  const describe = (e: Element) => {
    const tag = e.tagName.toLowerCase();
    const testId = e.getAttribute('data-testid');
    if (testId) return `${tag}[data-testid="${testId}"]`;
    if (e.id) return `${tag}#${e.id}`;
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return cls.length ? `${tag}.${cls.join('.')}` : tag;
  };
  const clipsX = (s: CSSStyleDeclaration) =>
    s.overflowX === 'hidden' || s.overflowX === 'clip' || s.overflowX === 'auto' || s.overflowX === 'scroll' || /\b(paint|strict|content)\b/.test(s.contain);
  const scrollsX = (s: CSSStyleDeclaration) => s.overflowX === 'auto' || s.overflowX === 'scroll';
  const scrollingSideways = (e: Element, s: CSSStyleDeclaration) => scrollsX(s) && e.scrollWidth > e.clientWidth + 1;
  // What makes an element the containing block of a fixed descendant (and so
  // of an absolute one too).
  const holdsFixed = (s: CSSStyleDeclaration) =>
    s.transform !== 'none' ||
    s.perspective !== 'none' ||
    s.filter !== 'none' ||
    (s.backdropFilter !== undefined && s.backdropFilter !== 'none') ||
    /\b(paint|layout|strict|content)\b/.test(s.contain) ||
    /\b(transform|perspective|filter)\b/.test(s.willChange) ||
    (s.containerType !== undefined && s.containerType !== 'normal');
  const holdsAbsolute = (s: CSSStyleDeclaration) => s.position !== 'static' || holdsFixed(s);
  // A modal dialog or an open popover is drawn in the top layer: its
  // containing block is the viewport, whatever its DOM ancestors are, and no
  // ancestor's overflow or containment clips it. The walk up a containing-
  // block chain ends there (the layer element's own clip still counts).
  const TOP_LAYER = 'dialog:modal,:popover-open';
  const visuallyHidden = (e: Element, s: CSSStyleDeclaration) => {
    if (s.clip && s.clip !== 'auto' && (s.position === 'absolute' || s.position === 'fixed')) return true;
    const r = e.getBoundingClientRect();
    return clipsX(s) && (r.width <= 1 || r.height <= 1);
  };

  const vw = arg.viewportWidth;
  for (const el of document.body.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement)) continue; // SVG internals and MathML are not measured
    const interactive = el.matches(INTERACTIVE);
    let ownText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && /\S/.test(n.textContent || '')) {
        ownText = true;
        break;
      }
    }
    if (!interactive && !ownText) continue;
    if (el.closest('[inert],[aria-hidden="true"]') || el.closest(SELF_SCROLLING_CODE)) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const self = css(el);
    if (visuallyHidden(el, self)) continue;

    // What it draws on the x axis: its box and its own text.
    let left = box.left;
    let right = box.right;
    for (const n of el.childNodes) {
      if (n.nodeType !== Node.TEXT_NODE || !/\S/.test(n.textContent || '')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const t = range.getBoundingClientRect();
      if (t.width > 0) {
        left = Math.min(left, t.left);
        right = Math.max(right, t.right);
      }
    }
    // Its own text is clipped by the element itself when it clips (and does
    // not truncate on purpose).
    // A box that truncates on purpose (text-overflow: ellipsis) draws only
    // its own width: what it hides there is the design, not a clip.
    if (clipsX(self) && !scrollingSideways(el, self) && self.textOverflow === 'ellipsis') {
      left = Math.max(left, box.left + el.clientLeft);
      right = Math.min(right, box.left + el.clientLeft + el.clientWidth);
    }
    // An element that clips cuts only what overflows it, never its own
    // borders or scrollbar: those are drawn. So its own clip bounds what it
    // draws to its border box. (Bounding it to its padding box would read
    // every bordered text area, input, select and overflow-hidden box as cut
    // off by its own 1px borders.) Text that runs past its own box is still
    // lost, and still a finding.
    let visL = left;
    let visR = right;
    if (clipsX(self) && !scrollingSideways(el, self)) {
      visL = Math.max(visL, box.left);
      visR = Math.min(visR, box.right);
    }

    let skip = false;
    let need: 'absolute' | 'fixed' | null = self.position === 'absolute' ? 'absolute' : self.position === 'fixed' ? 'fixed' : null;
    for (let a = el.matches(TOP_LAYER) ? null : el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = css(a);
      if (need === 'absolute' && !holdsAbsolute(s)) continue;
      if (need === 'fixed' && !holdsFixed(s)) continue;
      // `a` is on the containing-block chain: it clips `el` if it clips at all.
      if (visuallyHidden(a, s) || scrollingSideways(a, s)) {
        skip = true;
        break;
      }
      if (clipsX(s)) {
        const c = a.getBoundingClientRect();
        const cl = c.left + a.clientLeft;
        const cr = cl + a.clientWidth;
        if (s.textOverflow === 'ellipsis') {
          left = Math.max(left, cl);
          right = Math.min(right, cr);
        }
        visL = Math.max(visL, cl);
        visR = Math.min(visR, cr);
      }
      if (a.matches(TOP_LAYER)) break;
      need = s.position === 'absolute' ? 'absolute' : s.position === 'fixed' ? 'fixed' : null;
    }
    if (skip) continue;
    visL = Math.max(visL, 0);
    visR = Math.min(visR, vw);
    measure.checked += 1;
    const drawn = right - left;
    const shown = Math.max(0, visR - visL);
    if (drawn > SLACK && shown < drawn - SLACK) {
      measure.clipped.push({ what: describe(el), control: interactive, visible: Math.round((100 * shown) / Math.max(1, drawn)) });
    }
  }

  const main = [...document.querySelectorAll<HTMLElement>('main,[role="main"]')].find((m) => m.checkVisibility());
  const wide = 0.6 * (main ? main.clientWidth || vw : vw);
  const ALLOWED_2D = 'table,pre,code,textarea,[role="table"],[role="grid"]';
  const PICTURE = 'svg,img,canvas,[role="img"]';
  const named = (e: Element) =>
    /\S/.test(e.getAttribute('aria-label') || '') ||
    (e.getAttribute('aria-labelledby') || '').split(/\s+/).some((id) => id && /\S/.test(document.getElementById(id)?.textContent || ''));
  const reachable = (e: Element) => (e as HTMLElement).tabIndex >= 0 && !e.closest('[inert]');
  const REACH = 'a[href],button:not(:disabled),[role="tab"]:not([aria-disabled="true"]),[tabindex]:not([tabindex="-1"])';
  const drawnKids = (e: Element) => [...e.children].filter((c) => c instanceof HTMLElement && c.checkVisibility() && c.getBoundingClientRect().width > 0);
  // A strip: a tab list, or a named navigation, made only of controls the
  // keyboard reaches (a tab by the tab list's arrow keys, a link or button by
  // Tab, which scrolls it into view), laid in one row. It scrolls in one
  // direction and the page does not. One rule for both, so a nav drawn as tabs
  // is held to the same shape as a tab list.
  const strip = (e: Element) => {
    if (!(e.matches('[role="tablist"]') || (e.matches('nav,[role="navigation"],[role="toolbar"]') && named(e)))) return false;
    const kids = drawnKids(e);
    if (kids.length === 0) return false;
    const rects = kids.map((c) => c.getBoundingClientRect());
    const oneRow = Math.max(...rects.map((r) => r.top)) < Math.min(...rects.map((r) => r.bottom));
    return oneRow && kids.every((c) => c.matches(REACH) && !c.closest('[inert]'));
  };
  // A declared scroller the keyboard reaches: a named region in the tab order
  // (ScrollRegion, the concept diagrams, the workspace status details). Arrow
  // keys scroll it, and its name says what it holds.
  const declaredRegion = (e: Element) => e.matches('[role="region"]') && named(e) && reachable(e);
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (!(el instanceof HTMLElement)) continue;
    const s = css(el);
    if (!scrollingSideways(el, s) || el.clientWidth < wide) continue;
    if (el.matches(ALLOWED_2D) || [...el.children].some((c) => c.matches(ALLOWED_2D))) continue;
    // A picture (a diagram, a chart) wider than its scroller is the 1.4.10
    // exception; a small icon beside text that overflows is not.
    if ([...el.children].some((c) => c.matches(PICTURE) && c.getBoundingClientRect().width > el.clientWidth + 1)) continue;
    const kids = drawnKids(el);
    if (strip(el) || (kids.length === 1 && strip(kids[0]))) continue;
    if (declaredRegion(el)) continue;
    if (el.closest('[inert],[aria-hidden="true"]') || el.closest(SELF_SCROLLING_CODE)) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    measure.sideways.push({ what: describe(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  // Controls first, the most hidden first: the failure line names those.
  measure.clipped.sort((a, b) => Number(b.control) - Number(a.control) || a.visible - b.visible);
  return measure;
}

/**
 * WCAG 1.4.10, as failure sentences. At every width: no tab row draws its tabs
 * over each other. At phone width: nothing is cut off (the clip probe), no
 * page-sized panel scrolls sideways, and, as a secondary line, the document is
 * not wider than the viewport (it cannot fail inside the app's frames; see
 * {@link measureReflow}).
 */
export async function reflow(page: Page, width: Width): Promise<string[]> {
  const phone = width.width < PHONE_BELOW;
  const r = await page.evaluate(measureReflow, { viewportWidth: width.width, phone });
  const out: string[] = [];
  if (phone && r.sw > width.width + 1) out.push(`reflow (serious, 1.4.10): the document is ${r.sw}px wide in a ${width.width}px viewport`);
  if (r.overlapping > 0) out.push(`reflow:tabs-overlap (serious, 1.4.10): ${r.overlapping} pair(s) of neighbouring tabs draw over each other`);
  if (r.clipped.length > 0) {
    const named = r.clipped.slice(0, NAMED).map((c) => `${c.what} ${c.visible}% visible`);
    out.push(
      `probe:clipped (serious, 1.4.10): ${r.clipped.length} of ${r.checked} element(s) cut off on the x axis by the viewport or an overflow-hidden ancestor — ${named.join(' | ')}`,
    );
  }
  if (r.sideways.length > 0) {
    const named = r.sideways.slice(0, NAMED).map((s) => `${s.what} ${s.scrollWidth}px in ${s.clientWidth}px`);
    out.push(`reflow:panel-scrolls-sideways (serious, 1.4.10): ${r.sideways.length} page-sized panel(s) scroll sideways — ${named.join(' | ')}`);
  }
  return out;
}

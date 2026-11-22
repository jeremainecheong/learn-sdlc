/**
 * Bringing a form the Projects page opens into view, and giving the focus back
 * when it closes.
 *
 * The page's three doors (Upload a project, New project, a row's Copy into a
 * new project) open their forms at the head of "Your projects". A door pressed
 * at the top of the page finds its form beside it; a Copy pressed thousands of
 * pixels down a long list does not, so the form is scrolled to, instantly
 * (nothing to wait for, nothing for reduced motion to object to), by the least
 * scroll that shows all of it, and only when it is not already wholly in view:
 * a press that can already see its form moves nothing. A form whose foot (its
 * buttons) opens below a short window is brought up just far enough. The
 * focus goes into that first field in the same tick as the press, never on a
 * timer, so a person or a script that types next types into it.
 */

/** The part of the window `el` can be seen through: the viewport, cut by every clipping box around it. */
function visibleBand(el: Element): { top: number; bottom: number } {
  let top = 0;
  let bottom = typeof window !== 'undefined' ? window.innerHeight || document.documentElement.clientHeight : 0;
  for (let up = el.parentElement; up; up = up.parentElement) {
    const overflow = getComputedStyle(up).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden' || overflow === 'clip') {
      const box = up.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }
  return { top, bottom };
}

/** Whether every pixel of `el`'s height can be seen without scrolling. */
export function whollyInView(el: Element): boolean {
  const box = el.getBoundingClientRect();
  const band = visibleBand(el);
  return box.top >= band.top && box.bottom <= band.bottom;
}

/** A box's scroll margins (`scroll-mt-*`, `scroll-mb-*`), in px: what a scroll leaves between it and the view's edge. */
function scrollMargins(el: Element): { top: number; bottom: number } {
  const style = getComputedStyle(el);
  const px = (value: string) => (Number.isFinite(parseFloat(value)) ? parseFloat(value) : 0);
  return { top: px(style.scrollMarginTop), bottom: px(style.scrollMarginBottom) };
}

/**
 * The least scroll that shows the whole of a form just opened, as the
 * `block` of a `scrollIntoView`, or null for none:
 * - null when the form and its first field are already wholly in view (a press
 *   that can see its form moves nothing);
 * - 'end' when the form fits the view with its margins, its head is in view or
 *   below it, and its foot is below the view: the foot comes up to its margin
 *   above the view's bottom, and the head, which fits, stays in view;
 * - 'start' otherwise: a form above the view, or taller than it, has its head
 *   put at the top (its margin below the view's top).
 */
export function revealBlock(form: Element, field: Element): 'start' | 'end' | null {
  const box = form.getBoundingClientRect();
  const band = visibleBand(form);
  const formShown = box.top >= band.top && box.bottom <= band.bottom;
  if (formShown && whollyInView(field)) return null;
  const margin = scrollMargins(form);
  const fits = box.bottom - box.top + margin.top + margin.bottom <= band.bottom - band.top;
  if (fits && box.top >= band.top && box.bottom > band.bottom) return 'end';
  return 'start';
}

/**
 * Show a form that has just been drawn (or pressed for again) and put the
 * focus in its first field, in the same tick: the least scroll that shows the
 * whole form (`revealBlock`), instant, and none when it is already in view.
 */
export function revealForm(form: HTMLElement | null, field: HTMLElement | null): void {
  if (!form || !field) return;
  const block = revealBlock(form, field);
  if (block && typeof form.scrollIntoView === 'function') {
    form.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' });
  }
  field.focus({ preventScroll: true });
}

/**
 * Give the focus back to the control that opened a form, or to `fallback` (the
 * door that opens the same form) when that control has left the page, and
 * bring it into view if it is out of sight, so the page is never left
 * scrolled to where the form was.
 */
export function returnFocus(opener: HTMLElement | null, fallback: HTMLElement | null): void {
  const target = opener?.isConnected ? opener : fallback;
  if (!target || !target.isConnected) return;
  target.focus({ preventScroll: true });
  if (!whollyInView(target) && typeof target.scrollIntoView === 'function') {
    target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
}

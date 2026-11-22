"use client";
/**
 * Presentation view: a per-browser switch, off by default, that
 * hides learners' email addresses in every teacher table, queue, quiz result
 * and learner panel while the screen is shared. Display names stay; join codes
 * stay masked as they always are. It changes no permission, membership or
 * grade: it is a drawing choice, kept in this browser's localStorage only.
 *
 * **Unknown means masked.** A switch that started every component at "off"
 * and read the stored value in an effect would let the first paint of a page
 * (the printable record's cover among them) draw the learner's email, with the
 * mask a frame later, on a shared screen. So the switch is an external store
 * read while rendering (`useSyncExternalStore`): a page
 * drawn in the browser reads it before its first paint, and the one render
 * that cannot read it (the server's, and the hydration that matches it) has
 * no value, which every component that draws an email treats as on.
 */
import { useCallback, useSyncExternalStore } from "react";

export const PRESENTATION_VIEW_KEY = "lsdlc_presentation_view";
const EVENT = "lsdlc-presentation-view";

/**
 * What this page's switch said last, kept only when storage refused it (a
 * private window), so a browser that refuses storage still agrees with itself.
 * Null whenever storage holds the answer.
 */
let said: boolean | null = null;

function readPresentationView(): boolean {
  try {
    return window.localStorage.getItem(PRESENTATION_VIEW_KEY) === "on";
  } catch {
    return false;
  }
}

export function writePresentationView(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(PRESENTATION_VIEW_KEY, "on");
    else window.localStorage.removeItem(PRESENTATION_VIEW_KEY);
    said = null;
  } catch {
    // Storage refused (a private window): the switch still holds for this page.
    said = on;
  }
  window.dispatchEvent(new CustomEvent<boolean>(EVENT, { detail: on }));
}

function subscribe(onChange: () => void): () => void {
  // Another tab changed the stored value: storage holds the answer again.
  const stored = () => {
    said = null;
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", stored);
  };
}

const current = (): boolean => said ?? readPresentationView();
/** The server cannot read this browser's switch: no value, never "off". */
const unread = (): null => null;

/**
 * The switch as stored: true, false, or null while it has not been read (the
 * server's render and the hydration that matches it). The switch itself and
 * the line that says it is on read this; a component that draws an email reads
 * `usePresentationView`, which treats null as on.
 */
export function usePresentationViewSetting(): boolean | null {
  return useSyncExternalStore(subscribe, current, unread);
}

/**
 * Whether to hide learners' email addresses, shared by every component on the
 * page that draws one: true when the switch is on and while it is still
 * unread, so an address is drawn only once the switch is known to be off.
 */
export function usePresentationView(): [boolean, (on: boolean) => void] {
  const setting = usePresentationViewSetting();
  const set = useCallback((next: boolean) => writePresentationView(next), []);
  return [setting !== false, set];
}

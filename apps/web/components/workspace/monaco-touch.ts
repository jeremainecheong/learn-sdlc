/**
 * Monaco's touch keyboard control, given a name.
 *
 * On a touch screen it takes for an iPad (a Macintosh user agent with touch
 * points, which is what iPadOS Safari reports), Monaco adds a 58px text area
 * to the editor's corner, `textarea.iPadShowKeyboard`, whose only job is to
 * take a tap and hand focus to the editor so the on-screen keyboard rises.
 * Monaco gives it no name and no editor option to give it one, so a screen
 * reader would meet an unlabelled form field (axe `label`, critical) in every code
 * room. It is labelled here for what a tap on it does. The control is added
 * after the editor mounts and again whenever read-only is switched off, so
 * the editor's node is watched for it rather than read once.
 */
export const TOUCH_KEYBOARD_LABEL = 'Show the keyboard for the code editor';

const SELECTOR = 'textarea.iPadShowKeyboard';

/** Names every unnamed touch keyboard control under `root`, now and as Monaco adds one. Returns the stop. */
export function nameTouchKeyboard(root: HTMLElement): () => void {
  const name = () => {
    for (const el of root.querySelectorAll<HTMLElement>(SELECTOR)) {
      if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', TOUCH_KEYBOARD_LABEL);
    }
  };
  name();
  if (typeof MutationObserver === 'undefined') return () => {};
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(SELECTOR) || node.querySelector(SELECTOR))) {
          name();
          return;
        }
      }
    }
  });
  watch.observe(root, { childList: true, subtree: true });
  return () => watch.disconnect();
}

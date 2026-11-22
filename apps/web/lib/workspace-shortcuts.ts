/** Window listeners receive keys even when a native modal makes the page
 * inert. Chat controls also keep their shortcuts in the compact view. */
export function workspaceShortcutBlocked(target: EventTarget | null): boolean {
  return Boolean(document.querySelector('dialog[open]:not(.chat-surface), .chat-surface[aria-modal="true"]'))
    || (target instanceof Element && Boolean(target.closest('.chat-surface, [data-testid="persona-panel"]')));
}

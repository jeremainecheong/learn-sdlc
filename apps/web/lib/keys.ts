'use client';

/**
 * How a keyboard shortcut is written down.
 *
 * A Mac writes it ⌘K; everything else writes it Ctrl K. The listeners accept
 * both modifiers either way, so this is only about the word on the button.
 */
export function shortcutWord(letter: string): string {
  if (typeof navigator === 'undefined') return `⌘${letter}`;
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
    ? `⌘${letter}`
    : `Ctrl ${letter}`;
}

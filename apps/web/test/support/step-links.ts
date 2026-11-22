/**
 * The check every builder's test runs on its row of steps: each step is a
 * link to its own card.
 * Where the link lands on screen is the card's scroll margin, which
 * `step-links.test.tsx` reads from the stylesheet (jsdom lays nothing
 * out).
 */
import { expect } from 'vitest';

/**
 * Every step link of the row names its own card: `#tre-step-<n>` is the
 * `.tre-card` section numbered n, whose heading is the step's label, and the
 * cards stand in the row's order. Answers the labels, in order.
 */
export function expectStepLinksLand(host: HTMLElement): string[] {
  const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="tre-steps"] a.tre-step-link')];
  expect(links.length).toBeGreaterThan(0);
  let last: Element | null = null;
  return links.map((link, at) => {
    const label = link.querySelector('.tre-step-l')?.textContent ?? '';
    expect(link.getAttribute('href')).toBe(`#tre-step-${at + 1}`);
    const card = document.getElementById(`tre-step-${at + 1}`);
    expect(card, `the card of step ${at + 1}`).not.toBeNull();
    expect(card!.tagName).toBe('SECTION');
    expect(card!.classList.contains('tre-card')).toBe(true);
    expect(card!.querySelector(`#tre-step-${at + 1}-title`)?.textContent).toBe(label);
    if (last) expect(last.compareDocumentPosition(card!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    last = card;
    return label;
  });
}

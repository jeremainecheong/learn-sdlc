// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LearningWalkthrough } from '@/components/landing/LearningWalkthrough';

let host: HTMLDivElement;
let root: Root;
const tabs = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const visiblePanel = () => host.querySelector('[role="tabpanel"][aria-hidden="false"]')!;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(<LearningWalkthrough />)); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('public learning walkthrough keyboard and touch access', () => {
  it('moves focus and the associated panel with arrows, Home and End while keeping one tab stop', () => {
    act(() => tabs()[0].focus());
    for (const [key, index] of [['ArrowDown', 1], ['End', 3], ['ArrowRight', 0], ['Home', 0]] as const) {
      act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
      expect(document.activeElement).toBe(tabs()[index]);
      expect(tabs().filter(tab => tab.tabIndex === 0)).toEqual([tabs()[index]]);
      expect(visiblePanel().id).toBe(tabs()[index].getAttribute('aria-controls'));
      expect(visiblePanel().getAttribute('aria-labelledby')).toBe(tabs()[index].id);
    }
  });

  it('allows pointer selection and cycles back without changing navigation or claiming a learner verdict', () => {
    act(() => tabs()[2].click());
    expect(visiblePanel().textContent).toContain('What should the user see if their draft cannot be saved?');
    const next = host.querySelector<HTMLButtonElement>('.lh-example-foot button')!;
    act(() => next.click());
    expect(visiblePanel().textContent).toContain('Carry the insight forward.');
    expect(next.textContent).toContain('Start again');
    act(() => next.click());
    expect(visiblePanel().textContent).toContain('What does the user need?');
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBe('01 / 04');
  });
});

/**
 * Small DOM helpers the component tests share.
 */
import { act } from 'react';
import { vi } from 'vitest';

/**
 * Lets React finish what a click or a resolved promise started: `rounds`
 * turns of the microtask queue, each inside `act`. Data a mocked call
 * resolves reaches the page within a few turns; a chain of awaits needs more.
 */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/**
 * Stands in for `window.matchMedia`, which jsdom does not provide: every query
 * answers `matches` and never changes.
 */
export function stubMatchMedia(matches = false): void {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
}

/**
 * Types `value` into a field the way a browser does: through the field's own
 * native value setter, so React sees a real change, then one bubbling `input`
 * (or `change`, for a select) event. Call it inside `act`.
 */
export function typeInto(el: HTMLElement, value: string, event: 'input' | 'change' = 'input'): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

/**
 * Waits until `ready()` holds, giving the page real time in between: each
 * round is one `tick` of real time inside `act`, so a local server's answer,
 * a resolved fetch or a timer the page set can land and render. Fails with
 * `label` (and `detail()`, when given) after `tries` rounds.
 */
export async function waitUntil(
  ready: () => unknown,
  label: string,
  { tries = 150, tick = 10, detail }: { tries?: number; tick?: number; detail?: () => string } = {},
): Promise<void> {
  for (let round = 0; round < tries; round += 1) {
    if (ready()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, tick));
    });
  }
  if (ready()) return;
  throw new Error(`waited for ${label}${detail ? `; ${detail()}` : ''}`);
}

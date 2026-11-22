/**
 * The check every builder's test runs on its step row's Sign-off entry.
 *
 * The entry follows the row of steps (it is not one of them), is named
 * "Sign-off" and points at the task's sign-off checkbox, which sits inside the
 * card that draws it. A plain press is taken by the page (the browser's own
 * jump to the fragment would put the box at the very top, under the sticky
 * bar): the box's row is scrolled to the middle of the view at once, the focus
 * goes to the checkbox without a second scroll, and the box keeps its state.
 *
 * jsdom has no `scrollIntoView`, so one that records its calls is put on
 * `HTMLElement.prototype` for the press and taken off again.
 */
import { act } from 'react';
import { fireEvent } from '@testing-library/dom';
import { expect } from 'vitest';
import { signOffBoxId } from '@/components/staff/projects/TaskEditor';

export interface SignOffJumpPress {
  /** The page took the press (no fragment written, no browser jump). */
  taken: boolean;
  /** Each `scrollIntoView` the press made: the element and its options. */
  scrolls: { el: Element; options: unknown }[];
  box: HTMLInputElement;
}

/** Press the Sign-off entry under `host` once, and report what it did. */
export async function pressSignOffJump(host: HTMLElement, taskKey: string, cardTestId: string): Promise<SignOffJumpPress> {
  const entry = host.querySelector<HTMLAnchorElement>('[data-testid="tre-signoff-jump"]');
  expect(entry, 'the Sign-off entry is drawn').not.toBeNull();
  expect(entry!.tagName).toBe('A');
  expect(entry!.textContent).toBe('Sign-off');
  expect(entry!.getAttribute('href')).toBe(`#${signOffBoxId(taskKey)}`);
  // After the row of steps, and not one of its steps.
  const steps = host.querySelector('[data-testid="tre-steps"]');
  expect(steps).not.toBeNull();
  expect(steps!.contains(entry)).toBe(false);
  expect(steps!.nextElementSibling).toBe(entry!.parentElement);

  const box = document.getElementById(signOffBoxId(taskKey));
  expect(box, 'the box the entry names is on the page').toBeInstanceOf(HTMLInputElement);
  const input = box as HTMLInputElement;
  expect(input.type).toBe('checkbox');
  expect(input.closest(`[data-testid="${cardTestId}"]`), `the box is in ${cardTestId}`).not.toBeNull();
  const checked = input.checked;

  const scrolls: { el: Element; options: unknown }[] = [];
  const proto = HTMLElement.prototype as { scrollIntoView?: (options?: unknown) => void };
  const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView');
  const before = proto.scrollIntoView;
  proto.scrollIntoView = function record(this: Element, options?: unknown) {
    scrolls.push({ el: this, options });
  };
  let taken = false;
  try {
    await act(async () => {
      taken = !fireEvent.click(entry!);
    });
  } finally {
    if (had) proto.scrollIntoView = before;
    else delete proto.scrollIntoView;
  }
  expect(input.checked, 'the press never ticks the box').toBe(checked);
  return { taken, scrolls, box: input };
}

/** The press as every builder's must land: taken, one instant centred scroll of the box's row, the focus on the box. */
export async function expectSignOffJumpLands(host: HTMLElement, taskKey: string, cardTestId: string): Promise<void> {
  const press = await pressSignOffJump(host, taskKey, cardTestId);
  expect(press.taken).toBe(true);
  expect(press.scrolls).toEqual([
    { el: press.box.closest(`[data-testid="task-signoff-box-${taskKey}"]`), options: { block: 'center', inline: 'nearest', behavior: 'instant' } },
  ]);
  expect(document.activeElement).toBe(press.box);
}

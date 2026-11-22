// @vitest-environment jsdom
/**
 * The helpers the rooms use to bring what a press just drew into view, `revealInScroller` and
 * `revealFoldHead`. They scroll only the nearest box that scrolls up and down (never the page's frame), instantly, by
 * the least move, and only when what they show is out of view: above or taller than the view, its top comes in;
 * below it, its foot comes in. A fold's head is its summary and its first lines, never the whole fold,
 * and a field the person is typing in is never scrolled out of view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_LINES, revealFoldHead, revealInScroller, verticalScroller } from '@/lib/reveal-in-view';

type Rect = { top: number; bottom: number };
const rects = new Map<Element, Rect>();
let frame: HTMLDivElement, column: HTMLDivElement, target: HTMLDivElement;
const scrollTo = vi.fn();

beforeEach(() => {
  scrollTo.mockClear();
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = rects.get(this) ?? { top: 0, bottom: 0 };
    return { top: r.top, bottom: r.bottom, height: r.bottom - r.top, left: 0, right: 100, width: 100, x: 0, y: r.top, toJSON() {} } as DOMRect;
  });
  // The page's frame scrolls too (as `.shell-page` does); the column inside it is the nearer box.
  frame = document.createElement('div'); frame.style.overflowY = 'hidden';
  column = document.createElement('div'); column.style.overflowY = 'auto';
  target = document.createElement('div');
  const inner = document.createElement('div');
  inner.append(target); column.append(inner); frame.append(column); document.body.append(frame);
  Object.defineProperty(column, 'scrollTop', { configurable: true, value: 1155, writable: true });
  rects.set(column, { top: 166, bottom: 830 });
});
afterEach(() => { frame.remove(); vi.restoreAllMocks(); rects.clear(); });

describe('revealInScroller', () => {
  it('finds the nearest box that scrolls up and down, past boxes that do not', () => {
    expect(verticalScroller(target)).toBe(column);
  });

  it('a target above the view (the Design notice at the top of the column): its top is brought in, instantly', () => {
    rects.set(target, { top: -442, bottom: -392 });
    expect(revealInScroller(target)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.instances[0]).toBe(column);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (-442 - 166 - 12), behavior: 'instant' });
  });

  it('a short target below the view (an opened fold): its foot is brought in, so all of it shows', () => {
    rects.set(target, { top: 820, bottom: 1020 });
    revealInScroller(target);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (1020 - 830 + 12), behavior: 'instant' });
  });

  it('a target taller than the view: its top is brought in, so its first lines show', () => {
    rects.set(target, { top: 820, bottom: 2400 });
    revealInScroller(target);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (820 - 166 - 12), behavior: 'instant' });
  });

  it('a target wholly in view moves nothing', () => {
    rects.set(target, { top: 180, bottom: 240 });
    expect(revealInScroller(target)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('with nothing around it that scrolls, nothing moves', () => {
    column.style.overflowY = 'visible';
    rects.set(target, { top: -442, bottom: -392 });
    expect(revealInScroller(target)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('the keyboard focus stays where it is', () => {
    const field = document.createElement('input');
    column.append(field);
    field.focus();
    rects.set(target, { top: -442, bottom: -392 });
    revealInScroller(target);
    expect(document.activeElement).toBe(field);
  });

  it('a move that would take the field being typed in out of view moves nothing', () => {
    const field = document.createElement('input');
    column.append(field);
    rects.set(field, { top: 600, bottom: 640 });
    rects.set(target, { top: -442, bottom: -392 });
    expect(revealInScroller(target, undefined, field)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a move that keeps the field in view goes ahead, and so does one whose field is out of view already', () => {
    const field = document.createElement('input');
    column.append(field);
    rects.set(field, { top: 600, bottom: 640 });
    rects.set(target, { top: 100, bottom: 150 });
    expect(revealInScroller(target, undefined, field)).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1155 + (100 - 166 - 12), behavior: 'instant' });
    rects.set(field, { top: 900, bottom: 940 });
    rects.set(target, { top: -442, bottom: -392 });
    expect(revealInScroller(target, undefined, field)).toBe(true);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });
});

describe('revealFoldHead', () => {
  let fold: HTMLDetailsElement, summary: HTMLElement, first: HTMLElement;
  beforeEach(() => {
    fold = document.createElement('details');
    summary = document.createElement('summary');
    first = document.createElement('p');
    fold.append(summary, first, document.createElement('div'));
    target.append(fold);
    rects.set(fold, { top: 790, bottom: 2400 });
  });

  it('a tall fold opened at the foot of the view: the least move that shows the summary and its first block, not its top to the top', () => {
    rects.set(summary, { top: 806, bottom: 830 });
    rects.set(first, { top: 842, bottom: 928 });
    expect(revealFoldHead(fold)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (928 - 830 + 12), behavior: 'instant' });
  });

  it('a first block longer than the first lines: only its first lines are brought in', () => {
    rects.set(summary, { top: 806, bottom: 830 });
    rects.set(first, { top: 842, bottom: 1600 });
    revealFoldHead(fold);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (830 + FIRST_LINES - 830 + 12), behavior: 'instant' });
  });

  it('a short fold below the view (it fits the view with its margins): all of it is brought in, its foot 12 px above the view\'s foot', () => {
    rects.set(fold, { top: 800, bottom: 1200 });
    rects.set(summary, { top: 816, bottom: 840 });
    rects.set(first, { top: 852, bottom: 900 });
    expect(revealFoldHead(fold)).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 1155 + (1200 - 830 + 12), behavior: 'instant' });
  });

  it('a fold exactly as tall as the view less its two margins comes in whole, its top 12 px under the view\'s top; one px taller, its head only', () => {
    rects.set(fold, { top: 790, bottom: 790 + 664 - 24 });
    rects.set(summary, { top: 806, bottom: 830 });
    rects.set(first, { top: 842, bottom: 928 });
    revealFoldHead(fold);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1155 + (790 - 166 - 12), behavior: 'instant' });
    rects.set(fold, { top: 790, bottom: 790 + 664 - 23 });
    revealFoldHead(fold);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 1155 + (928 - 830 + 12), behavior: 'instant' });
  });

  it('a short fold wholly in view moves nothing', () => {
    rects.set(fold, { top: 300, bottom: 800 });
    rects.set(summary, { top: 316, bottom: 340 });
    rects.set(first, { top: 352, bottom: 400 });
    expect(revealFoldHead(fold)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('the summary and its first lines in view already: nothing moves, however far the fold runs below', () => {
    rects.set(summary, { top: 400, bottom: 424 });
    rects.set(first, { top: 436, bottom: 522 });
    expect(revealFoldHead(fold)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

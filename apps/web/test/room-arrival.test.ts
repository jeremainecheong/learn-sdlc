// @vitest-environment jsdom
/**
 * Where the room of a split phase opens.
 *
 * At 1280x800 the task list above the IDE row fills most of the 547 px scroll
 * region, so without care the only part of the row on screen on arrival is
 * the file-tab strip. Two things would put it there:
 *
 *  - if nothing places the region on arrival, the stack above the row decides
 *    where the editor starts; and
 *  - if the file-tab strip brings its selected tab into view with
 *    `scrollIntoView`, which scrolls EVERY scrollable ancestor, it moves the
 *    room region down by just enough to show the strip at its bottom edge.
 *
 * The first is `arrivalScrollTop`: on arrival the region scrolls by the least
 * that puts `EDITOR_PEEK_PX` of the editor on screen, never past the top of
 * the IDE row, and a scroll that would stop just short of the row goes to it
 * rather than leaving a sliver of the list at the top. The second is
 * `revealTabInStrip`, which moves the strip sideways and nothing else.
 *
 * jsdom does no layout, so the cases below hand the arithmetic the offsets a
 * browser would measure rather than laying out a page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_SNAP_PX,
  EDITOR_PEEK_PX,
  arrivalScrollTop,
  measureArrival,
  revealTabInStrip,
} from '@/lib/room-arrival';

describe('arrivalScrollTop', () => {
  it('leaves the region at its top where the editor already shows (1920x1080)', () => {
    // Region 827 tall; the editor starts 652 px down the stack.
    expect(arrivalScrollTop({ viewport: 827, editorTop: 652, anchorTop: 283 })).toBe(0);
  });

  it('scrolls by the least that shows the editor when that stops well short of the IDE row (1440x900)', () => {
    const top = arrivalScrollTop({ viewport: 647, editorTop: 682, anchorTop: 283 });
    expect(top).toBe(682 + EDITOR_PEEK_PX - 647);
    // What is left on screen of the editor is exactly the peek.
    expect(647 - (682 - top)).toBe(EDITOR_PEEK_PX);
  });

  it('opens on the IDE row rather than a sliver of the list above it (1280x800)', () => {
    // The least scroll (265) would leave 18 px of the task list at the top.
    const top = arrivalScrollTop({ viewport: 547, editorTop: 652, anchorTop: 283 });
    expect(283 - (652 + EDITOR_PEEK_PX - 547)).toBeLessThan(ANCHOR_SNAP_PX);
    expect(top).toBe(283);
    expect(547 - (652 - top)).toBeGreaterThanOrEqual(EDITOR_PEEK_PX);
  });

  it('never scrolls past the IDE row, even where the peek would want more (1366x768)', () => {
    const top = arrivalScrollTop({ viewport: 515, editorTop: 700, anchorTop: 283 });
    expect(top).toBe(283);
  });

  it('is never negative and never past an anchor at the top', () => {
    expect(arrivalScrollTop({ viewport: 300, editorTop: 500, anchorTop: 0 })).toBe(0);
    expect(arrivalScrollTop({ viewport: 300, editorTop: 500, anchorTop: -12 })).toBe(0);
  });
});

/* ------------------------------ the tab strip ----------------------------- */

const rect = (left: number, width: number, top = 0, height = 38): DOMRect =>
  ({ left, right: left + width, width, top, bottom: top + height, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('revealTabInStrip', () => {
  const build = (tabLeft: number, tabWidth: number) => {
    const region = document.createElement('div');
    const strip = document.createElement('div');
    const tab = document.createElement('button');
    strip.append(tab);
    region.append(strip);
    document.body.append(region);
    region.scrollTop = 0;
    vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue(rect(0, 300));
    vi.spyOn(tab, 'getBoundingClientRect').mockReturnValue(rect(tabLeft, tabWidth));
    const into = vi.fn();
    Object.defineProperty(tab, 'scrollIntoView', { configurable: true, value: into });
    return { region, strip, tab, into };
  };

  it('moves the strip sideways to a tab past its right edge, and nothing else', () => {
    const { region, strip, tab, into } = build(350, 100);
    strip.scrollLeft = 20;
    revealTabInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(20 + 150);
    expect(into).not.toHaveBeenCalled();
    expect(region.scrollTop).toBe(0);
  });

  it('moves it back to a tab past its left edge', () => {
    const { strip, tab } = build(-60, 100);
    strip.scrollLeft = 200;
    revealTabInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(140);
  });

  it('leaves a tab that is already in view where it is', () => {
    const { strip, tab } = build(40, 100);
    strip.scrollLeft = 30;
    revealTabInStrip(strip, tab);
    expect(strip.scrollLeft).toBe(30);
  });
});

/* ------------------------------ the measuring ----------------------------- */

describe('measureArrival', () => {
  const room = ({ editorHeight = 276 } = {}) => {
    const region = document.createElement('div');
    const list = document.createElement('section');
    list.dataset.testid = 'task-switcher';
    const row = document.createElement('div');
    row.dataset.activePane = 'code';
    row.style.marginTop = '12px';
    const editor = document.createElement('div');
    editor.dataset.testid = 'editor-host';
    row.append(editor);
    region.append(list, row);
    document.body.append(region);
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 547 });
    region.scrollTop = 0;
    // A 1280x800 room with the region at its top: region at 227, the IDE row
    // 547 px into the stack, the editor 117 px into the row.
    vi.spyOn(region, 'getBoundingClientRect').mockReturnValue(rect(0, 1200, 227, 547));
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(0, 1200, 227 + 547, 560));
    vi.spyOn(editor, 'getBoundingClientRect').mockReturnValue(rect(0, 800, 227 + 664, editorHeight));
    return region;
  };

  it('reads the editor and the IDE row as offsets into the stack, the row with its margin', () => {
    expect(measureArrival(room())).toEqual({ viewport: 547, editorTop: 664, anchorTop: 535 });
  });

  it('measures nothing while the editor is not drawn (a phone’s other pane)', () => {
    expect(measureArrival(room({ editorHeight: 0 }))).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The finished TaskTrackr project's sequence diagram at 1280 px wide with the brief and the mentor open.
 *
 * - Lifelines 150 px apart in 130 px boxes, five participants 750 units wide, held at 520 px or more, would run the
 *   last lifeline past the edge of the 487 px canvas with labels of about 7 px. The drawing is as wide as its names
 *   and labels need, fits that canvas at a floor where its labels stay about 9 px, scrolls only below that floor, and
 *   then says so above the canvas.
 * - With both panels hidden at 1440 px the drawing grows to 1.2 times its size and no further (not to 1273 px, two
 *   messages to a screen).
 *
 * jsdom lays nothing out: the widths a browser would give are set on the boxes here; the drawn look at each width
 * is for a browser to show.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DESIGN } from '@learnsdlc/shared';
import { DiagramStudio, SEQUENCE, SEQUENCE_SCROLL_CUE, sequenceLabelWidth, sequenceLayout } from '@/components/workspace/panels/design/DiagramStudio';
import { parseSequence } from '@/components/workspace/panels/design/diagram';
import type { DesignState } from '@/components/workspace/panels/design/useDesign';
import { markupLines } from './support/markup-snapshot';

let host: HTMLDivElement, root: Root;
/** The widths a browser would give, by the box's test id: [clientWidth, scrollWidth]. */
const boxes = new Map<string, [number, number]>();
const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const realScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
beforeEach(() => {
  boxes.clear();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return boxes.get(this.dataset.testid ?? '')?.[0] ?? 0; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return boxes.get(this.dataset.testid ?? '')?.[1] ?? 0; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  if (realClient) Object.defineProperty(HTMLElement.prototype, 'clientWidth', realClient); else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  if (realScroll) Object.defineProperty(Element.prototype, 'scrollWidth', realScroll);
  delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
});
const render = (node: React.ReactNode) => act(() => root.render(node));
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

/* --------------------------- the drawing fits its canvas --------------------------- */

/** The finished learner's eight lines: five participants, replies written `-->`. */
const TASKTRACKR_SEQUENCE = [
  'Browser -> OverduePage: open dedicated report',
  'OverduePage -> ApiRoute: getOverdue(today) as GET /api/tasks/overdue',
  'ApiRoute -> Repository: validated today',
  'Repository -> SQLite: open tasks with due_date before today',
  'SQLite --> Repository: rows in due-date priority id order',
  'Repository --> ApiRoute: Task DTO array',
  'ApiRoute --> OverduePage: 200 JSON',
  'OverduePage --> Browser: title days late source list or explicit empty message',
].join('\n');
/** The canvas's room for the drawing (its 10 px padding off each side), as measured in a browser. */
const CANVAS_1280_PANELS = 487;
const CANVAS_1440_PANELS = 640;
const CANVAS_1440_HIDDEN = 1253;
const studio = (sequence: string) =>
  ({ doc: { ...EMPTY_DESIGN, sequence }, assisted: () => [], busy: false, write: () => {} }) as unknown as DesignState;
/** What a drawing `layout` is drawn at in a canvas `room` px wide: width 100%, between its floor and its cap. */
const drawnAt = (layout: { minWidth: number; maxWidth: number }, room: number) => Math.min(layout.maxWidth, Math.max(layout.minWidth, room));

describe('the sequence diagram fits its canvas at 1280 px with both panels open', () => {
  const layout = sequenceLayout(parseSequence(TASKTRACKR_SEQUENCE));

  it('the drawing is as wide as its five names need, and its floor fits the 487 px canvas', () => {
    // Before: 750 units (five lifelines 150 apart), held at 520 px or more, so it overflowed a 487 px canvas.
    expect(layout.width).toBeLessThan(5 * 150);
    expect(layout.minWidth).toBeLessThanOrEqual(CANVAS_1280_PANELS);
    expect(layout.minWidth).toBe(Math.round(layout.width * SEQUENCE.FLOOR));
    // drawn at 487 px its labels are about 9 px, where they were about 7
    const scale = drawnAt(layout, CANVAS_1280_PANELS) / layout.width;
    expect(SEQUENCE.LABEL_PX * scale).toBeGreaterThanOrEqual(9);
    // and at the floor, the least it is ever drawn at, they are still 8.8 px
    expect(SEQUENCE.LABEL_PX * SEQUENCE.FLOOR).toBeGreaterThanOrEqual(8.8);
  });

  it('every box holds its name, no two boxes touch, and every label stays inside the drawing', () => {
    const names = layout.participants.map((p) => sequenceLabelWidth(p.name, SEQUENCE.NAME_PX));
    for (const w of names) expect(w + 2 * SEQUENCE.BOX_PAD).toBeLessThanOrEqual(layout.box);
    const xs = layout.participants.map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBe(layout.box + SEQUENCE.GAP);
    expect(xs[0] - layout.box / 2).toBeGreaterThanOrEqual(0);
    expect(xs.at(-1)! + layout.box / 2).toBeLessThanOrEqual(layout.width);
    for (const m of layout.messages) {
      const half = sequenceLabelWidth(m.text) / 2;
      expect(m.labelX - half).toBeGreaterThanOrEqual(SEQUENCE.EDGE - 1e-9);
      expect(m.labelX + half).toBeLessThanOrEqual(layout.width - SEQUENCE.EDGE + 1e-9);
    }
  });

  it('at 1440 px with the panels open it is drawn at its full size or more, as the showcase walk shows it', () => {
    expect(drawnAt(layout, CANVAS_1440_PANELS)).toBeGreaterThanOrEqual(layout.width);
  });

  it('with both panels hidden it grows to 1.2 times its size, not to the canvas', () => {
    expect(layout.maxWidth).toBe(Math.round(layout.width * SEQUENCE.MAX_SCALE));
    expect(drawnAt(layout, CANVAS_1440_HIDDEN)).toBe(layout.maxWidth);
    // Before it was drawn 1253 px wide: 620 units tall became about 1036 px. Now it is about 1.2 x 620.
    expect((layout.height * drawnAt(layout, CANVAS_1440_HIDDEN)) / layout.width).toBeLessThanOrEqual(layout.height * 1.21);
  });

  it('a drawing with a label wider than its lifelines is as wide as the label, the lifelines centred in it', () => {
    const wide = sequenceLayout(parseSequence('A -> B: a very long label that needs far more room than two lifelines'));
    expect(wide.width).toBeGreaterThan(2 * (wide.box + SEQUENCE.GAP));
    const [a, b] = wide.participants;
    expect(a.x - 0).toBeCloseTo(wide.width - b.x, 5);
  });

  it('draws the floor and the cap on the drawing, and each box at the layout\'s width', async () => {
    await render(<DiagramStudio design={studio(TASKTRACKR_SEQUENCE)} />);
    const svg = host.querySelector('svg[role="img"]') as SVGSVGElement;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`);
    expect(svg.style.minWidth).toBe(`${layout.minWidth}px`);
    expect(svg.style.maxWidth).toBe(`${layout.maxWidth}px`);
    const rects = [...svg.querySelectorAll('rect')];
    expect(rects).toHaveLength(5);
    for (const r of rects) expect(Number(r.getAttribute('width'))).toBe(layout.box);
  });

  it('says so above the canvas while the drawing is wider than the canvas lets it be, and not otherwise', async () => {
    boxes.set('design-sequence-canvas', [CANVAS_1440_PANELS, CANVAS_1440_PANELS]);
    await render(<DiagramStudio design={studio(TASKTRACKR_SEQUENCE)} />);
    expect(q('design-sequence-scroll-cue')).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    // 1024 px with both panels open: about 200 px of canvas, under the drawing's floor
    boxes.set('design-sequence-canvas', [200, layout.minWidth + 20]);
    await render(<DiagramStudio design={studio(TASKTRACKR_SEQUENCE)} />);
    expect(q('design-sequence-scroll-cue')?.textContent).toBe(SEQUENCE_SCROLL_CUE);
    expect(SEQUENCE_SCROLL_CUE).toBe('Scroll sideways to see the whole drawing.');
  });
});

/* ------------------------------ the scroll cue ------------------------------ */

/**
 * At 1024 px the scroll cue sits ABOVE the canvas, not under it below the first view: one line, the same words, shown
 * on the same condition. Where nothing scrolls (1280 and 1440, panels open or hidden) the studio's markup is the one
 * recorded snapshot at every width (the arrowheads' `useId` value, which depends only on render order, is written as
 * ARROW first).
 */
const studioMarkup = () => {
  const arrow = host.querySelector('marker')?.id ?? 'none';
  return markupLines(host.innerHTML.split(arrow).join('ARROW'));
};

describe('the sequence cue is above the canvas, and only while it scrolls', () => {
  for (const room of [CANVAS_1280_PANELS, CANVAS_1440_PANELS, CANVAS_1440_HIDDEN]) {
    it(`at a ${room} px canvas nothing scrolls: no cue, no room kept for one, the markup as its snapshot holds`, async () => {
      boxes.set('design-sequence-canvas', [room, room]);
      await render(<DiagramStudio design={studio(TASKTRACKR_SEQUENCE)} />);
      expect(q('design-sequence-scroll-cue')).toBeNull();
      const canvas = q('design-sequence-canvas')!;
      expect(canvas.previousElementSibling?.tagName).toBe('TEXTAREA');
      expect(canvas.nextElementSibling).toBeNull();
      await expect(studioMarkup()).toMatchFileSnapshot('__snapshots__/design-sequence-studio.html');
    });
  }

  it('at 1024 px with both panels open the cue is the line just above the canvas, nothing under it', async () => {
    boxes.set('design-sequence-canvas', [252, 468]);
    await render(<DiagramStudio design={studio(TASKTRACKR_SEQUENCE)} />);
    const canvas = q('design-sequence-canvas')!;
    const cue = q('design-sequence-scroll-cue')!;
    expect(cue.textContent).toBe(SEQUENCE_SCROLL_CUE);
    expect(canvas.previousElementSibling).toBe(cue);
    expect(canvas.nextElementSibling).toBeNull();
    expect(host.querySelectorAll('[data-testid="design-sequence-scroll-cue"]')).toHaveLength(1);
  });
});

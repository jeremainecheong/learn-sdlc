// @vitest-environment jsdom
/**
 * The class diagram of the finished TaskTrackr design.
 *
 * - At 1280 px with the brief and the mentor open the drawing (680 px) is 140 px wider than its 540 px box; it
 *   must not cut Tag and TaskTag with no word. It fills its box up to its own width and no wider, shrinks to no less
 *   than UML_FLOOR of it (510 px, its words about 9 px), and below that its box scrolls with "Scroll sideways to see
 *   the whole drawing." on the line above it, as the sequence drawing and the planted bugs grid do. Where it already
 *   fits it is drawn at its own size, with nothing added around it.
 * - A cardinality at the end that carries the mark (the "0..*" at TaskTag's end of the slanted Task to TaskTag line)
 *   sits clear of the mark and of the line, not on its arrowhead.
 *
 * jsdom lays nothing out: the widths a browser would give are set on the box here, as sequence-diagram-fit does.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DESIGN, type Design } from '@learnsdlc/shared';
import { MARK_CLEAR, UML_FLOOR, UML_SCROLL_CUE, UmlDiagram, besideLine, cardShortfall, edgeTexts, layoutUmlApart, umlDrawnWidths } from '@/components/workspace/panels/design/UmlDiagram';
import { UML, layoutUml, type UmlEdge } from '@/components/workspace/panels/design/uml-layout';

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

const RESP = 'Represents work and its completion, with its due date, its priority and the list it belongs to';
/** The finished learner's four entities and three relations, as design-diagram-labels has them. */
const TASKTRACKR: Design = {
  ...EMPTY_DESIGN,
  entities: [
    { id: 'E1', name: 'List', kind: 'class', attributes: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }], responsibilities: ['Groups tasks for list views'], satisfies: [] },
    { id: 'E2', name: 'Tag', kind: 'class', attributes: [{ name: 'id', type: 'integer' }, { name: 'name', type: 'string' }], responsibilities: ['Names a reusable task label'], satisfies: [] },
    { id: 'E3', name: 'Task', kind: 'class', attributes: ['id', 'listId', 'title', 'status', 'priority', 'dueDate'].map((name) => ({ name, type: 'string' })), responsibilities: [RESP], satisfies: [] },
    { id: 'E4', name: 'TaskTag', kind: 'class', attributes: [{ name: 'taskId', type: 'integer' }, { name: 'tagId', type: 'integer' }], responsibilities: ['Stores the many-to-many task and tag links'], satisfies: [] },
  ],
  relations: [
    { id: 'R1', from: 'E1', to: 'E3', kind: 'composition', fromCard: '1', toCard: '0..*', label: 'holds' },
    { id: 'R2', from: 'E2', to: 'E4', kind: 'association', fromCard: '1', toCard: '0..*', label: 'tag links' },
    { id: 'R3', from: 'E3', to: 'E4', kind: 'association', fromCard: '1', toCard: '0..*', label: 'tag links' },
  ],
} as Design;

/** The box's inner width (the column less the card's padding and the box's border), as measured in a browser. */
const BOX_1280_PANELS = 540;
const BOX_1440_PANELS = 697;
const BOX_1440_HIDDEN = 1040;
const BOX_1024_PANELS = 380;
const BOX_ID = 'design-uml-frame';
/** What the drawing is drawn at in a box `room` px wide: width 100% between its floor and its own width. */
const drawnAt = (w: { minWidth: number; maxWidth: number }, room: number) => Math.min(w.maxWidth, Math.max(w.minWidth, room));

describe('the class diagram fits its box at 1280 px with both panels open', () => {
  const layout = layoutUml(TASKTRACKR);
  const widths = umlDrawnWidths(layout.width);

  it('the recorded layout (680 wide) is drawn between 510 px and its own 680 px', () => {
    expect(layout.width).toBe(680);
    expect(widths).toEqual({ minWidth: Math.round(680 * UML_FLOOR), maxWidth: 680 });
    expect(widths.minWidth).toBeLessThanOrEqual(BOX_1280_PANELS);
    // drawn at 540 px, its 12 px words are about 9.5 px, its 11 px cardinalities about 8.7 px
    const scale = drawnAt(widths, BOX_1280_PANELS) / layout.width;
    expect(12 * scale).toBeGreaterThanOrEqual(9.5);
    expect(11 * UML_FLOOR).toBeGreaterThanOrEqual(8.2);
  });

  it('at 1440 px, panels open or hidden, it is drawn at its own 680 px', () => {
    expect(drawnAt(widths, BOX_1440_PANELS)).toBe(680);
    expect(drawnAt(widths, BOX_1440_HIDDEN)).toBe(680);
  });

  it('draws the svg at width 100% between those widths, with its own width, height and viewBox kept for the export', async () => {
    await render(<UmlDiagram doc={TASKTRACKR} />);
    const svg = q('design-uml-svg') as unknown as SVGSVGElement;
    expect(svg.getAttribute('width')).toBe('680');
    expect(svg.getAttribute('height')).toBe(String(layout.height));
    expect(svg.getAttribute('viewBox')).toBe(`0 0 680 ${layout.height}`);
    expect(svg.style.width).toBe('100%');
    expect(svg.style.height).toBe('auto');
    expect(svg.style.minWidth).toBe(`${widths.minWidth}px`);
    expect(svg.style.maxWidth).toBe('680px');
  });

  for (const room of [BOX_1280_PANELS, BOX_1440_PANELS, BOX_1440_HIDDEN]) {
    it(`in a ${room} px box nothing scrolls: no line above the box, the box right under the heading row, nothing after it`, async () => {
      boxes.set(BOX_ID, [room, room]);
      await render(<UmlDiagram doc={TASKTRACKR} />);
      expect(q('design-uml-scroll-cue')).toBeNull();
      const box = q(BOX_ID)!;
      const section = q('design-uml')!;
      expect([...section.children]).toEqual([section.firstElementChild, box]);
      expect(box.previousElementSibling!.querySelector('h2')!.textContent).toBe('Class diagram');
      expect(box.nextElementSibling).toBeNull();
    });
  }

  it('narrower than its floor (1024 px, both panels) the box scrolls and the line above it says so', async () => {
    boxes.set(BOX_ID, [BOX_1024_PANELS, widths.minWidth]);
    await render(<UmlDiagram doc={TASKTRACKR} />);
    const cue = q('design-uml-scroll-cue')!;
    expect(cue.textContent).toBe(UML_SCROLL_CUE);
    expect(UML_SCROLL_CUE).toBe('Scroll sideways to see the whole drawing.');
    expect(q(BOX_ID)!.previousElementSibling).toBe(cue);
    expect(q(BOX_ID)!.nextElementSibling).toBeNull();
  });

  it("the IDE's Design tools draw it under their own test id, with the same line", async () => {
    boxes.set('phase-design-tools-uml-frame', [BOX_1024_PANELS, widths.minWidth]);
    await render(<UmlDiagram doc={TASKTRACKR} testId="phase-design-tools-uml" />);
    expect(q('phase-design-tools-uml-scroll-cue')!.textContent).toBe(UML_SCROLL_CUE);
  });
});

/* ----------------------------- a cardinality at the marked end ------------------------------ */

/** The 11 px card's box as drawn: centred on x, its capitals 9 px over the baseline. */
const cardBox = (at: { x: number; y: number }, card: string) => {
  const half = (card.length * UML.LABEL_CHAR_W) / 2;
  return { left: at.x - half, right: at.x + half, top: at.y - 9, bottom: at.y };
};

describe('a cardinality at the end that carries the mark sits clear of it', () => {
  const layout = layoutUml(TASKTRACKR);
  const r3 = layout.edges.find((e) => e.id === 'R3')!;

  it("TaskTag's 0..* on the slanted Task to TaskTag line: clear of the arrowhead and of the line", () => {
    expect(r3.y2).not.toBe(r3.y1); // the line slants
    const at = edgeTexts(r3).to;
    expect(at.anchor).toBe('middle');
    const box = cardBox(at, '0..*');
    // the arrowhead runs the last 12 px of the line into TaskTag's left side
    const markStart = r3.x2 - UML.MARK;
    expect(markStart - box.right).toBeGreaterThanOrEqual(MARK_CLEAR);
    // the line under the words, at either end of them, stays above their capitals by at least 3 px
    const lineAt = (x: number) => r3.y1 + ((x - r3.x1) * (r3.y2 - r3.y1)) / (r3.x2 - r3.x1);
    expect(box.top - Math.max(lineAt(box.left), lineAt(box.right))).toBeGreaterThanOrEqual(3);
    // before: centred 20 px back from the end, its right end inside the mark
    const before = cardBox(besideLine(r3.x2, r3.y2, r3.x1, r3.y1, 20, -10), '0..*');
    expect(before.right).toBeGreaterThan(markStart);
  });

  it('draws it there', async () => {
    await render(<UmlDiagram doc={TASKTRACKR} />);
    const texts = [...q('design-uml-edge-R3')!.querySelectorAll('text')];
    const card = texts.find((t) => t.textContent === '0..*')!;
    const at = edgeTexts(r3).to;
    expect([Number(card.getAttribute('x')), Number(card.getAttribute('y'))]).toEqual([at.x, at.y]);
  });

  it('the end with no mark, the cards beside lines that run down, and a short card on a level line are placed beside their lines', () => {
    expect(edgeTexts(r3).from).toEqual(besideLine(r3.x1, r3.y1, r3.x2, r3.y2, 20, 10));
    for (const id of ['R1', 'R2']) {
      const e = layout.edges.find((x) => x.id === id)!;
      expect(edgeTexts(e).to).toEqual(besideLine(e.x2, e.y2, e.x1, e.y1, 20, -10));
      expect(edgeTexts(e).from).toEqual(besideLine(e.x1, e.y1, e.x2, e.y2, 20, 10));
    }
    const level: UmlEdge = { id: 'L', kind: 'association', from: 'A', to: 'B', x1: 100, y1: 200, x2: 220, y2: 200, fromCard: '1', toCard: '*', label: 'has', self: false };
    expect(edgeTexts(level).to).toEqual(besideLine(220, 200, 100, 200, 20, -10));
    // a composition's mark is at its start: its end card keeps its place, its start card is moved
    const comp: UmlEdge = { ...level, kind: 'composition', fromCard: '1..*', toCard: '0..*' };
    expect(edgeTexts(comp).to).toEqual(besideLine(220, 200, 100, 200, 20, -10));
    expect(cardBox(edgeTexts(comp).from, '1..*').left - (100 + UML.MARK)).toBeGreaterThanOrEqual(MARK_CLEAR);
  });
});

/* ------------------------------ cardinality clear of the mark ------------------------------ */

/**
 * A school, its students and its courses: Student and Course are side by side in one row (both under School), and a
 * many-to-many "takes" runs level between them. Its labels are five characters or fewer, so the gap between the
 * columns is the 64 px floor.
 */
const SCHOOL = (fromCard: string, toCard: string): Design => ({
  ...EMPTY_DESIGN,
  entities: [
    { id: 'E1', name: 'School', kind: 'class', attributes: [{ name: 'id', type: 'integer' }], responsibilities: ['Runs courses'], satisfies: [] },
    { id: 'E2', name: 'Student', kind: 'class', attributes: [{ name: 'id', type: 'integer' }], responsibilities: ['Takes courses'], satisfies: [] },
    { id: 'E3', name: 'Course', kind: 'class', attributes: [{ name: 'id', type: 'integer' }], responsibilities: ['Is taught once'], satisfies: [] },
  ],
  relations: [
    { id: 'R1', from: 'E1', to: 'E2', kind: 'composition', fromCard: '1', toCard: '0..*', label: 'has' },
    { id: 'R2', from: 'E1', to: 'E3', kind: 'composition', fromCard: '1', toCard: '0..*', label: 'runs' },
    { id: 'R3', from: 'E2', to: 'E3', kind: 'association', fromCard, toCard, label: 'takes' },
  ],
} as Design);

/** The across gap between the two cards of a line written on one side of it (negative: they overlap). */
const cardGap = (edge: UmlEdge) => {
  const at = edgeTexts(edge);
  const a = cardBox(at.from, edge.fromCard);
  const b = cardBox(at.to, edge.toCard);
  return Math.max(b.left - a.right, a.left - b.right);
};

describe('the two cardinalities of a short level line keep apart', () => {
  for (const [fromCard, toCard] of [['0..*', '0..*'], ['1', '0..*']] as const) {
    it(`"${fromCard}" and "${toCard}" on a 64 px level line: the gap between the columns widens until they are ${MARK_CLEAR} px apart, each clear of its end`, () => {
      const plain = layoutUml(SCHOOL(fromCard, toCard));
      const short = plain.edges.find((e) => e.id === 'R3')!;
      // the line runs level across the 64 px floor gap, and cards placed only clear of the mark would run into each other there
      expect(short.y1).toBe(short.y2);
      expect(short.x2 - short.x1).toBe(UML.GAP_X);
      expect(cardGap(short)).toBeLessThan(MARK_CLEAR);
      expect(cardShortfall(short)).toBeGreaterThan(0);

      const apart = layoutUmlApart(SCHOOL(fromCard, toCard));
      const r3 = apart.edges.find((e) => e.id === 'R3')!;
      expect(r3.y1).toBe(r3.y2);
      expect(r3.x2 - r3.x1).toBeGreaterThan(UML.GAP_X);
      expect(r3.x2 - r3.x1).toBeLessThanOrEqual(UML.GAP_X_MAX);
      expect(cardShortfall(r3)).toBe(0);
      expect(cardGap(r3)).toBeGreaterThanOrEqual(MARK_CLEAR);
      // the end card still clear of the arrowhead, the start card where it always was (no mark at that end)
      const at = edgeTexts(r3);
      expect(r3.x2 - UML.MARK - cardBox(at.to, toCard).right).toBeGreaterThanOrEqual(MARK_CLEAR);
      expect(at.from).toEqual(besideLine(r3.x1, r3.y1, r3.x2, r3.y2, 20, 10));
      // the wider gap is the least that does it: one px less and they would not keep apart
      expect(plain.width + (r3.x2 - r3.x1 - UML.GAP_X)).toBe(apart.width);
      const lessByOne = layoutUml(SCHOOL(fromCard, toCard), r3.x2 - r3.x1 - UML.GAP_X - 1).edges.find((e) => e.id === 'R3')!;
      expect(cardShortfall(lessByOne)).toBeGreaterThan(0);
    });
  }

  it('the diagram draws the wider layout, and its cards where that layout puts them', async () => {
    const doc = SCHOOL('0..*', '0..*');
    const apart = layoutUmlApart(doc);
    await render(<UmlDiagram doc={doc} />);
    const svg = q('design-uml-svg') as unknown as SVGSVGElement;
    expect(apart.width).toBeGreaterThan(layoutUml(doc).width);
    expect(svg.getAttribute('width')).toBe(String(apart.width));
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${apart.width} ${apart.height}`);
    const r3 = apart.edges.find((e) => e.id === 'R3')!;
    const at = edgeTexts(r3);
    const cards = [...q('design-uml-edge-R3')!.querySelectorAll('text')].filter((t) => t.textContent === '0..*');
    expect(cards.map((t) => [Number(t.getAttribute('x')), Number(t.getAttribute('y'))])).toEqual([[at.from.x, at.from.y], [at.to.x, at.to.y]]);
  });

  it("TaskTrackr's layout is the recorded one, and the slanted Task to TaskTag line's 0..* sits clear of the head", () => {
    const apart = layoutUmlApart(TASKTRACKR);
    expect(apart).toEqual(layoutUml(TASKTRACKR));
    expect(apart.width).toBe(680);
    expect(apart.edges.map(cardShortfall)).toEqual([0, 0, 0]);
    const r3 = apart.edges.find((e) => e.id === 'R3')!;
    expect(r3.y2).not.toBe(r3.y1);
    // The "0..*" sits at (354, 269), clear of the mark (not on it at (365, 264)); the "1" at Task's end is at (315, 270)
    expect(edgeTexts(r3).to).toEqual({ x: 354, y: 269, anchor: 'middle' });
    expect(edgeTexts(r3).from).toEqual({ x: 315, y: 270, anchor: 'middle' });
    expect(r3.x2 - UML.MARK - cardBox(edgeTexts(r3).to, '0..*').right).toBeGreaterThanOrEqual(MARK_CLEAR);
  });

  it('a short level line whose cards already keep apart ("1" and "*") is laid out as the plain layout', () => {
    const doc = SCHOOL('1', '*');
    expect(layoutUmlApart(doc)).toEqual(layoutUml(doc));
    expect(layoutUmlApart(doc).width).toBe(layoutUml(doc).width);
  });
});

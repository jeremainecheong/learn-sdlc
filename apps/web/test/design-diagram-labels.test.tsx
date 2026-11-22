// @vitest-environment jsdom
/**
 * The drawn diagrams of a finished Design phase.
 *
 * The sequence diagram: a label centred over its arrow with nothing behind it
 * would have the dashed lifeline drawn through a long one ("GET
 * /api/tasks/overdue?today=YYYY-MM-DD", "select open tasks where dueDate <
 * today"), and a long first or last label could run past the drawing's edge.
 * Each label has its own background (a halo in the canvas
 * colour) and stays inside the drawing; a reply written `-->` ends in an open
 * arrowhead as well as a dashed line. Parsing is diagram.ts's (tested in
 * phase-experience.test.ts), and the drawing reads the same to a script: each
 * label the first text of its own <text>, the 70-character cut, the
 * aria-label.
 * The class diagram: a label beside a vertical line must not be centred on it
 * ("h|olds", "tag| links"), a label between two boxes side by side must not
 * meet their borders, and responsibilities must not be cut at the box's edge.
 * Labels grow
 * away from their line, the gap between columns fits the longest label and
 * its two end marks, and a responsibility wraps onto up to three lines.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_DESIGN, type Design } from '@learnsdlc/shared';
import { DiagramStudio, SEQUENCE, sequenceLabelWidth, sequenceLayout } from '@/components/workspace/panels/design/DiagramStudio';
import { parseSequence } from '@/components/workspace/panels/design/diagram';
import { UmlDiagram, besideLine, edgeTexts, relationLabelLines } from '@/components/workspace/panels/design/UmlDiagram';
import { UML, columnGap, layoutUml, wrapResponsibility } from '@/components/workspace/panels/design/uml-layout';
import type { DesignState } from '@/components/workspace/panels/design/useDesign';

let host: HTMLDivElement, root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** The finished learner's six lines, every arrow written `->`. */
const FINISHED = [
  'Browser -> Proxy: GET /api/tasks/overdue?today=YYYY-MM-DD',
  'Proxy -> Task service: getOverdue(today)',
  'Task service -> SQLite: select open tasks where dueDate < today',
  'SQLite -> Task service: overdue Task rows',
  'Task service -> Proxy: 200 Task[]',
  'Proxy -> Browser: 200 overdue report',
].join('\n');

const studio = (sequence: string) =>
  ({ doc: { ...EMPTY_DESIGN, sequence }, assisted: () => [], busy: false, write: () => {} }) as unknown as DesignState;

describe('the sequence diagram', () => {
  // Each box is as wide as the longest name needs and the lifelines 12 px further apart (here 100 and 112), so the
  // four participants draw 448 wide, not 150 apart in a drawing at least 600 wide.
  it('lays the finished learner\'s six messages out, every label inside the drawing', () => {
    const parsed = parseSequence(FINISHED);
    const layout = sequenceLayout(parsed);
    expect(layout.box).toBe(100);
    expect(layout.width).toBe(448);
    expect(layout.height).toBe(6 * 65 + 100);
    expect(layout.participants.map((p) => [p.name, p.x])).toEqual([['Browser', 56], ['Proxy', 168], ['Task service', 280], ['SQLite', 392]]);
    for (const [i, m] of layout.messages.entries()) {
      expect(m.y).toBe(85 + i * 65);
      expect(m.labelY).toBe(m.y - 10);
      const half = sequenceLabelWidth(m.text) / 2;
      expect(m.labelX - half).toBeGreaterThanOrEqual(SEQUENCE.EDGE - 1e-9);
      expect(m.labelX + half).toBeLessThanOrEqual(layout.width - SEQUENCE.EDGE + 1e-9);
      // centred over its arrow where that keeps it inside the drawing, else moved in just enough
      const middle = (m.x1 + m.x2) / 2;
      expect(m.labelX).toBeCloseTo(Math.min(Math.max(middle, SEQUENCE.EDGE + half), layout.width - SEQUENCE.EDGE - half), 9);
    }
  });

  it('moves a long label at the drawing\'s edge in, rather than cutting it', () => {
    const label = 'GET /api/tasks/overdue?today=YYYY-MM-DD&list=12&status=open&q=rent';
    const layout = sequenceLayout(parseSequence(`Browser -> Proxy: ${label}\nProxy -> Store: read`));
    const m = layout.messages[0];
    const half = sequenceLabelWidth(label) / 2;
    expect((m.x1 + m.x2) / 2 - half).toBeLessThan(0); // centred, it would start before the drawing
    expect(m.labelX).toBeCloseTo(SEQUENCE.EDGE + half, 5);
    // and at the right-hand edge the same
    const right = sequenceLayout(parseSequence(`A -> B: x\nB -> C: y\nC -> D: z\nD -> C: ${label}`));
    const r = right.messages[3];
    expect(r.labelX + half).toBeCloseTo(right.width - SEQUENCE.EDGE, 5);
  });

  /*
   * The clamp read every character as 6.2 px, so a label of wide letters at the drawing's edge could
   * still lose a few pixels. A capital W at 11 px is drawn about 10.7 px wide in the common sans faces (0.97 em);
   * the label must sit inside the drawing by that measure, not only by the estimate.
   */
  it('a label of wide letters at the edge is moved in by its real width, not an average letter\'s', () => {
    const wide = 'WMWMWMWMWMWMWMWMWMWMWMWMWMWMWM'; // 30 of the widest letters
    const real = wide.length * 0.97 * 11;
    const left = sequenceLayout(parseSequence(`Browser -> Proxy: ${wide}\nProxy -> Store: read`)).messages[0];
    expect(left.labelX - real / 2).toBeGreaterThanOrEqual(SEQUENCE.EDGE);
    const right = sequenceLayout(parseSequence(`A -> B: x\nB -> C: y\nC -> D: z\nD -> C: ${wide}`));
    expect(right.messages[3].labelX + real / 2).toBeLessThanOrEqual(right.width - SEQUENCE.EDGE);
    // the estimate errs wide for every kind of letter, and narrow letters still count for less
    expect(sequenceLabelWidth(wide)).toBeGreaterThanOrEqual(real);
    expect(sequenceLabelWidth('illi')).toBeLessThan(sequenceLabelWidth('WMWM'));
  });

  it('draws each label on its own background, the words still the first text of their <text>', async () => {
    await act(async () => root.render(<DiagramStudio design={studio(FINISHED)} />));
    const svg = host.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute('aria-label')).toBe('Sequence diagram of your authored messages');
    const first = (n: Element) => (n.childNodes[0]?.nodeType === 3 ? n.childNodes[0].nodeValue : n.textContent);
    const texts = [...svg.querySelectorAll('text')].map(first);
    for (const p of ['Browser', 'Proxy', 'Task service', 'SQLite']) expect(texts).toContain(p);
    for (const m of parseSequence(FINISHED).messages) expect(texts).toContain(m.label);
    const labels = [...svg.querySelectorAll('g > text')].filter((t) => t.querySelector('title'));
    expect(labels).toHaveLength(6);
    for (const t of labels) {
      expect(t.getAttribute('stroke')).toBe('rgb(var(--c-ground))');
      expect(t.getAttribute('paint-order')).toBe('stroke');
      expect(Number(t.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(4);
    }
  });

  it('a reply written `-->` is dashed with an open head; a call written `->` is solid with a filled one, as the source says', async () => {
    await act(async () => root.render(<DiagramStudio design={studio('Browser -> Route: GET /items\nRoute --> Browser: 200 items')} />));
    const lines = [...host.querySelectorAll('svg g[data-reply], svg g:not([data-reply]) > line[marker-end]')];
    const call = host.querySelector('svg g:not([data-reply]) > line[marker-end]')!;
    const reply = host.querySelector('svg g[data-reply="true"] > line')!;
    expect(lines.length).toBeGreaterThan(1);
    expect(call.getAttribute('stroke-dasharray')).toBeNull();
    expect(reply.getAttribute('stroke-dasharray')).toBe('5 4');
    const markerOf = (line: Element) => host.querySelector(line.getAttribute('marker-end')!.replace(/^url\((.*)\)$/, '$1'))!;
    expect(markerOf(call).querySelector('path')!.getAttribute('fill')).toBe('currentColor');
    expect(markerOf(reply).querySelector('path')!.getAttribute('fill')).toBe('none');
    // the finished learner's lines are all `->`, so none is drawn as a reply
    await act(async () => root.render(<DiagramStudio design={studio(FINISHED)} />));
    expect(host.querySelectorAll('svg g[data-reply]')).toHaveLength(0);
  });

  it('cuts a label over 70 characters at 67 with an ellipsis, as scripts read it', async () => {
    const long = 'x'.repeat(80);
    await act(async () => root.render(<DiagramStudio design={studio(`A -> B: ${long}`)} />));
    const label = [...host.querySelectorAll('svg text')].find((t) => t.querySelector('title'))!;
    expect(label.childNodes[0].nodeValue).toBe(`${'x'.repeat(67)}…`);
    expect(label.querySelector('title')!.textContent).toBe(long);
  });
});

/* -------------------------------- the class diagram -------------------------------- */

const RESP = 'Represents work and its completion, with its due date, its priority and the list it belongs to';
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

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('the class diagram', () => {
  const layout = layoutUml(TASKTRACKR);
  const node = (id: string) => layout.nodes.find((n) => n.id === id)!;
  const edge = (id: string) => layout.edges.find((e) => e.id === id)!;

  it('the gap between two columns holds the longest label and a mark at each end, and the drawing still fits the column at 1440 px', () => {
    const label = 'tag links'.length * UML.LABEL_CHAR_W;
    expect(columnGap(TASKTRACKR.relations)).toBe(Math.ceil(label + 2 * UML.MARK + 4));
    const across = edge('R3'); // Task and TaskTag side by side: the line leaves Task's right side for TaskTag's left
    expect(Math.abs(across.y2 - across.y1)).toBeLessThan(Math.abs(across.x2 - across.x1));
    expect(across.x2 - across.x1).toBeGreaterThanOrEqual(label + 2 * UML.MARK);
    // two columns of the widest box: 16 + 280 + 88 + 280 + 16 = 680, inside the 697 px the Design column gives it
    expect(layout.width).toBe(680);
    expect(layout.width).toBeLessThanOrEqual(697);
  });

  it('the gap stays 64 px for short labels and stops at 120 px', () => {
    expect(columnGap([{ label: 'has' }])).toBe(UML.GAP_X);
    expect(columnGap([])).toBe(UML.GAP_X);
    expect(columnGap([{ label: 'x'.repeat(40) }])).toBe(UML.GAP_X_MAX);
  });

  it('still draws no two boxes over each other', () => {
    for (const a of layout.nodes) for (const b of layout.nodes) if (a !== b) expect(overlap(a, b), `${a.name} / ${b.name}`).toBe(false);
  });

  it('a label beside a vertical line grows away from it; the cardinalities sit on the other side, clear of it', () => {
    const down = edge('R1'); // List above Task
    expect(down.x1).toBe(down.x2);
    const at = edgeTexts(down);
    expect(at.label.anchor).toBe('start');
    expect(at.label.x).toBeGreaterThan(down.x1);
    expect(at.from.anchor).toBe('end');
    expect(at.from.x).toBeLessThan(down.x1);
    expect(at.to.anchor).toBe('end');
    expect(at.to.x).toBeLessThan(down.x1);
  });

  it('beside a line that runs across, the words stay centred above (the label) and below (the cardinalities)', () => {
    const e = edge('R3');
    const at = edgeTexts(e);
    expect([at.label.anchor, at.from.anchor, at.to.anchor]).toEqual(['middle', 'middle', 'middle']);
    expect(at.label.y).toBeLessThanOrEqual((e.y1 + e.y2) / 2 - 7); // above the line where it is written, at its middle
    expect(at.from.y).toBeGreaterThan(e.y1 + 5);
    expect(at.to.y).toBeGreaterThan(e.y2 + 5);
    expect(besideLine(0, 0, 100, 0, 0, -8)).toEqual({ x: 0, y: -8, anchor: 'middle' });
  });

  it('draws those anchors', () => {
    const html = renderToStaticMarkup(<UmlDiagram doc={TASKTRACKR} />);
    expect(html).toMatch(/text-anchor="start"[^>]*font-style="italic"[^>]*>holds</);
    expect(html).toMatch(/text-anchor="middle"[^>]*font-style="italic"[^>]*>tag links</);
  });

  it('wraps a long responsibility onto lines that fit the box, nothing cut', () => {
    const lines = wrapResponsibility(RESP);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(UML.RESP_LINES);
    expect(lines.join(' ')).toBe(RESP);
    for (const line of lines) expect(line.endsWith('…')).toBe(false);
    const task = node('E3');
    expect(task.responsibilities).toEqual(lines);
    expect(task.respIndent).toEqual(lines.map((_, i) => i > 0));
    const widest = Math.max(...lines.map((l, i) => 10 + (i ? UML.RESP_INDENT : 0) + l.length * UML.CHAR_W));
    expect(widest).toBeLessThanOrEqual(task.w);
    expect(task.h).toBe(task.headH + task.attrH + lines.length * UML.LINE_H + UML.COMPARTMENT_PAD);
    const html = renderToStaticMarkup(<UmlDiagram doc={TASKTRACKR} />);
    for (const line of lines) expect(html).toContain(`>${line}<`);
  });

  it('a short responsibility is one line; one longer than three lines ends its third in an ellipsis', () => {
    expect(wrapResponsibility('Groups tasks for list views')).toEqual(['Groups tasks for list views']);
    const huge = wrapResponsibility(`${'word '.repeat(40)}end`);
    expect(huge).toHaveLength(UML.RESP_LINES);
    expect(huge[2].endsWith('…')).toBe(true);
    const unbroken = wrapResponsibility('x'.repeat(50));
    expect(unbroken[0]).toHaveLength(36);
    expect(unbroken.join('')).toBe('x'.repeat(50));
  });
});

/*
 * The gap between columns stops at 120 px, so a relation label longer than about 13 characters ran
 * past the gap into the boxes either side of a line that runs across. Such a label is now broken at its spaces onto
 * lines that each fit between the line's two end marks, stacked upwards from where the one line was.
 */
describe('a long relation label between two boxes side by side', () => {
  const LONG = 'is assigned to the owner of';
  const doc = {
    ...EMPTY_DESIGN,
    // As TaskTrackr's Task and TaskTag: two boxes in the same layer (each under a box of its own), related across.
    entities: [
      { id: 'P', name: 'List', kind: 'class', attributes: [], responsibilities: [], satisfies: [] },
      { id: 'Q', name: 'Team', kind: 'class', attributes: [], responsibilities: [], satisfies: [] },
      { id: 'A', name: 'Task', kind: 'class', attributes: [], responsibilities: [], satisfies: [] },
      { id: 'B', name: 'Owner', kind: 'class', attributes: [], responsibilities: [], satisfies: [] },
    ],
    relations: [
      { id: 'R0', from: 'P', to: 'A', kind: 'composition', fromCard: '1', toCard: '0..*', label: 'holds' },
      { id: 'R9', from: 'Q', to: 'B', kind: 'composition', fromCard: '1', toCard: '0..*', label: 'has' },
      { id: 'R1', from: 'A', to: 'B', kind: 'association', fromCard: '1', toCard: '1', label: LONG },
    ],
  } as unknown as Design;

  it('the two boxes sit side by side, the gap at its 120 px stop, too narrow for the label on one line', () => {
    const layout = layoutUml(doc);
    const [, , a, b] = layout.nodes;
    expect(a.y).toBe(b.y);
    expect(columnGap(doc.relations)).toBe(UML.GAP_X_MAX);
    const e = layout.edges[2];
    expect(Math.abs(e.y2 - e.y1)).toBeLessThan(Math.abs(e.x2 - e.x1));
    expect(LONG.length * UML.LABEL_CHAR_W).toBeGreaterThan(Math.abs(e.x2 - e.x1) - 2 * UML.MARK);
  });

  it('is broken at its spaces onto lines that each fit between the end marks, every word kept', () => {
    const e = layoutUml(doc).edges[2];
    const lines = relationLabelLines(e);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length * UML.LABEL_CHAR_W).toBeLessThanOrEqual(Math.abs(e.x2 - e.x1) - 2 * UML.MARK);
    expect(lines.join(' ')).toBe(LONG);
  });

  it('is drawn as those lines, the last where the one line was and the others above it', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(<UmlDiagram doc={doc} />);
    const text = host.querySelector('[data-testid="design-uml-edge-R1"] text[font-style="italic"]')!;
    const at = edgeTexts(layoutUml(doc).edges[2]).label;
    expect(text.getAttribute('y')).toBe(String(at.y));
    const spans = [...text.querySelectorAll('tspan')];
    expect(spans.map((span) => span.textContent)).toEqual(relationLabelLines(layoutUml(doc).edges[2]));
    const shifts = spans.map((span) => Number(span.getAttribute('dy')));
    expect(shifts.reduce((sum, dy) => sum + dy, 0)).toBe(0); // the last line ends on the label's own height
    expect(shifts[0]).toBeLessThan(0);
    for (const span of spans) expect(span.getAttribute('x')).toBe(String(at.x));
  });

  it('a label that fits, and a label beside a line that runs down, stay one line with no tspan', () => {
    const tasktrackr = layoutUml(TASKTRACKR);
    for (const e of tasktrackr.edges) expect(relationLabelLines(e)).toEqual([e.label]);
    expect(renderToStaticMarkup(<UmlDiagram doc={TASKTRACKR} />)).not.toContain('<tspan');
  });
});

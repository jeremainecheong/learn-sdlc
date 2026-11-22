/**
 * Where each box of the learner's class diagram goes.
 *
 * Pure and deterministic: the same record always lands the same way, so the
 * diagram does not jump while the learner types. Boxes are layered by their
 * relations (a whole above its parts, a parent above its children, a caller
 * above what it calls), breadth first from the sources; a cycle with no
 * source starts a new walk from its first box. Each layer wraps at four boxes
 * and every column is as wide as the widest box, so no two boxes can overlap.
 *
 * A responsibility wraps onto up to three lines instead of being
 * cut at the box's edge, and the gap between two columns widens for the
 * longest relation label between its two end marks, up to 120 px. A label
 * still wider than that is written on more than one line above its line
 * (`relationLabelLines` in UmlDiagram.tsx).
 */
import type { Design, DesignEntity, DesignRelation } from '@learnsdlc/shared';

export const UML = {
  PAD: 16,
  /** The least gap between two columns; it widens for a long relation label, up to {@link UML.GAP_X_MAX}. */
  GAP_X: 64,
  GAP_X_MAX: 120,
  /** A relation label is 11 px monospace. */
  LABEL_CHAR_W: 6.6,
  /** Room at each end of a line for its mark (an arrow, a diamond, a triangle). */
  MARK: 12,
  GAP_Y: 72,
  COLS: 4,
  CHAR_W: 7.2,
  LINE_H: 16,
  MIN_W: 140,
  MAX_W: 280,
  NAME_H: 26,
  STEREO_H: 14,
  COMPARTMENT_PAD: 10,
  /** The lines one responsibility may take before the last is cut. */
  RESP_LINES: 3,
  /** How far a responsibility's second and third lines are indented. */
  RESP_INDENT: 12,
};

const MAX_CHARS = Math.floor((UML.MAX_W - 20) / UML.CHAR_W);

export interface UmlNode {
  id: string;
  name: string;
  stereotype: string;
  attributes: string[];
  /** The responsibility compartment's lines, each responsibility wrapped onto up to three. */
  responsibilities: string[];
  /** Whether each line in {@link UmlNode.responsibilities} continues the one above it (drawn indented). */
  respIndent: boolean[];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Height of the name compartment. */
  headH: number;
  /** Height of the attribute compartment. */
  attrH: number;
}

export interface UmlEdge {
  id: string;
  kind: DesignRelation['kind'];
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  fromCard: string;
  toCard: string;
  label: string;
  self: boolean;
}

export interface UmlLayout {
  nodes: UmlNode[];
  edges: UmlEdge[];
  width: number;
  height: number;
}

const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();
export const clipText = (s: string, max = MAX_CHARS) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** The characters a continued responsibility line holds, its indent taken off. */
const CONT_CHARS = Math.floor((UML.MAX_W - 20 - UML.RESP_INDENT) / UML.CHAR_W);

/**
 * One responsibility as the lines it is drawn on: broken at spaces (a word
 * longer than a line is broken inside), the first line {@link MAX_CHARS} wide
 * and the rest {@link CONT_CHARS}, at most {@link UML.RESP_LINES}, the last cut
 * with an ellipsis only when the text is longer than that.
 */
export function wrapResponsibility(text: string): string[] {
  const lines: string[] = [];
  let rest = text.trim();
  while (rest && lines.length < UML.RESP_LINES) {
    const max = lines.length === 0 ? MAX_CHARS : CONT_CHARS;
    if (rest.length <= max) {
      lines.push(rest);
      rest = '';
      break;
    }
    const space = rest.lastIndexOf(' ', max);
    const cut = space > 0 ? space : max;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) lines[lines.length - 1] = clipText(`${lines[lines.length - 1]} ${rest}`, lines.length === 1 ? MAX_CHARS : CONT_CHARS);
  return lines;
}

/** The gap between two columns: the longest relation label and a mark at each end, between 64 and 120 px. */
export function columnGap(relations: Pick<DesignRelation, 'label'>[]): number {
  const longest = Math.max(0, ...relations.map((r) => clipText(flat(r.label ?? ''), 28).length));
  const need = Math.ceil(longest * UML.LABEL_CHAR_W + 2 * UML.MARK + 4);
  return Math.min(UML.GAP_X_MAX, Math.max(UML.GAP_X, need));
}

function sized(e: DesignEntity): Omit<UmlNode, 'x' | 'y'> {
  const name = clipText(flat(e.name) || 'Unnamed');
  const stereotype = e.kind === 'class' ? '' : `«${e.kind}»`;
  const attributes = e.attributes
    .filter((a) => flat(a.name))
    .map((a) => clipText(flat(a.type ?? '') ? `${flat(a.name)}: ${flat(a.type ?? '')}` : flat(a.name)));
  const wrapped = e.responsibilities.map(flat).filter(Boolean).map(wrapResponsibility);
  const responsibilities = wrapped.flat();
  const respIndent = wrapped.flatMap((lines) => lines.map((_, i) => i > 0));
  const longest = Math.max(
    name.length,
    stereotype.length,
    ...attributes.map((a) => a.length),
    ...responsibilities.map((r, i) => r.length + (respIndent[i] ? Math.ceil(UML.RESP_INDENT / UML.CHAR_W) : 0)),
  );
  const w = Math.round(Math.min(UML.MAX_W, Math.max(UML.MIN_W, 24 + longest * UML.CHAR_W)));
  const headH = UML.NAME_H + (stereotype ? UML.STEREO_H : 0);
  const attrH = attributes.length * UML.LINE_H + UML.COMPARTMENT_PAD;
  const respH = responsibilities.length * UML.LINE_H + UML.COMPARTMENT_PAD;
  return { id: e.id, name, stereotype, attributes, responsibilities, respIndent, w, h: headH + attrH + respH, headH, attrH };
}

/** The point where the line from the box's centre towards (tx, ty) leaves the box. */
function border(n: UmlNode, tx: number, ty: number): [number, number] {
  const cx = n.x + n.w / 2;
  const cy = n.y + n.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx === 0 ? Infinity : n.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : n.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return [Math.round((cx + dx * s) * 10) / 10, Math.round((cy + dy * s) * 10) / 10];
}

/**
 * `widen` adds px to the gap between columns, still no wider than {@link UML.GAP_X_MAX}: the
 * class diagram asks for it only where the two cardinalities of a line between boxes side by side would otherwise
 * run into each other (`layoutUmlApart` in UmlDiagram.tsx). Left at 0, the gap is the layout's own.
 */
export function layoutUml(doc: Design, widen = 0): UmlLayout {
  const entities = doc.entities;
  const boxes = entities.map(sized);
  const index = new Map(boxes.map((b, i) => [b.id, i]));
  const relations = doc.relations.filter((r) => index.has(r.from) && index.has(r.to));

  // Layering edges: the thing that owns, generalises or calls goes on top.
  const next: number[][] = boxes.map(() => []);
  const indeg = boxes.map(() => 0);
  for (const r of relations) {
    if (r.from === r.to) continue;
    const [a, b] = r.kind === 'inheritance' ? [index.get(r.to)!, index.get(r.from)!] : [index.get(r.from)!, index.get(r.to)!];
    if (next[a].includes(b)) continue;
    next[a].push(b);
    indeg[b] += 1;
  }
  const layer: number[] = boxes.map(() => -1);
  const walk = (starts: number[]) => {
    const queue = [...starts];
    for (const s of starts) layer[s] = 0;
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of next[u]) {
        if (layer[v] !== -1) continue;
        layer[v] = layer[u] + 1;
        queue.push(v);
      }
    }
  };
  walk(boxes.map((_, i) => i).filter((i) => indeg[i] === 0));
  for (let i = 0; i < boxes.length; i++) if (layer[i] === -1) walk([i]);

  // Rows: each layer in record order, wrapped at COLS.
  const rows: number[][] = [];
  const depth = boxes.length ? Math.max(...layer) : -1;
  for (let l = 0; l <= depth; l++) {
    const members = boxes.map((_, i) => i).filter((i) => layer[i] === l);
    for (let k = 0; k < members.length; k += UML.COLS) rows.push(members.slice(k, k + UML.COLS));
  }

  const colW = boxes.length ? Math.max(...boxes.map((b) => b.w)) : UML.MIN_W;
  const gapX = widen > 0 ? Math.min(UML.GAP_X_MAX, columnGap(relations) + widen) : columnGap(relations);
  const maxCols = rows.length ? Math.max(...rows.map((r) => r.length)) : 1;
  const nodes: UmlNode[] = new Array(boxes.length);
  let y = UML.PAD;
  for (const row of rows) {
    const rowH = Math.max(...row.map((i) => boxes[i].h));
    const offset = ((maxCols - row.length) * (colW + gapX)) / 2;
    row.forEach((i, col) => {
      const b = boxes[i];
      const x = UML.PAD + offset + col * (colW + gapX) + (colW - b.w) / 2;
      nodes[i] = { ...b, x: Math.round(x), y };
    });
    y += rowH + UML.GAP_Y;
  }
  const width = Math.round(UML.PAD * 2 + maxCols * colW + (maxCols - 1) * gapX);
  const height = rows.length ? y - UML.GAP_Y + UML.PAD : UML.PAD * 2 + 40;

  const edges: UmlEdge[] = relations.map((r) => {
    const a = nodes[index.get(r.from)!];
    const b = nodes[index.get(r.to)!];
    const base = { id: r.id, kind: r.kind, from: r.from, to: r.to, fromCard: r.fromCard ?? '', toCard: r.toCard ?? '', label: clipText(flat(r.label ?? ''), 28) };
    if (a === b) {
      // A relation to itself loops off the top-right corner.
      return { ...base, x1: a.x + a.w - 24, y1: a.y, x2: a.x + a.w, y2: a.y + 20, self: true };
    }
    const [x1, y1] = border(a, b.x + b.w / 2, b.y + b.h / 2);
    const [x2, y2] = border(b, a.x + a.w / 2, a.y + a.h / 2);
    return { ...base, x1, y1, x2, y2, self: false };
  });

  return { nodes, edges, width, height };
}

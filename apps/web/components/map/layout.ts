/**
 * Pure layout for the project map: columns, block rectangles, wrapped labels
 * and edge paths, computed from map data and a width. Kept free of React so
 * it can be exercised without a DOM and so the component's render is a plain
 * walk over precomputed numbers.
 */
import type { PhaseKey } from '@learnsdlc/shared';
import { PHASE_ORDER } from '@learnsdlc/shared';
import type { MapEdge, MapNode, ProjectMapData } from '@/lib/map';

export const FONT = 11.5;
export const SUB_FONT = 10.5;
export const LINE_H = 14;
export const PAD_Y = 7;
export const NODE_GAP = 6;
export const HEADER_H = 30;
/** Where the hairline under each lane's title is drawn. */
export const HEADER_RULE = 27;
export const GUTTER = 6;
export const MAX_COL_W = 340;

/** Column weights: criteria and tests carry the most words, ops and the change request the fewest. */
const WEIGHTS: Record<PhaseKey, number> = {
  requirements: 1.3,
  design: 1.1,
  implementation: 1.0,
  testing: 1.2,
  deployment: 0.75,
  maintenance: 0.7,
};
const SANS_EM = 0.54;
const MONO_EM = 0.62;
export const TEXT_X = 17;
const TEXT_PAD = 26;

export interface Placed {
  node: MapNode;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  subLines: string[];
}

export interface Column {
  key: PhaseKey;
  x: number;
  w: number;
  /** What the column holds, in two or three words: "Tests and planted bugs". */
  note: string;
  /** Whether the note fits beside the title without touching it. */
  showNote: boolean;
  /** Whether the full phase title fits; otherwise the short name is drawn. */
  fullTitle: boolean;
  /**
   * How many blocks the learner's work puts in the column, drawn in the mono
   * face at the header's right edge. A locked phase's placeholder is not
   * work, so a column holding only that counts nothing and draws no number.
   */
  count: number;
  /** Whether the count fits beside whichever title is drawn. */
  showCount: boolean;
}

export interface EdgeDrawn {
  key: string;
  d: string;
  kind: MapEdge['kind'];
  fail: boolean;
  from: string;
  to: string;
}

export interface Layout {
  width: number;
  height: number;
  columns: Column[];
  placed: Placed[];
  edges: EdgeDrawn[];
}

/**
 * Greedy word wrap that never drops text. Prose breaks at spaces; identifiers
 * break after underscores and opening brackets, closing brackets stay glued to
 * the piece before them, and a word longer than the line is split by
 * characters rather than cut.
 */
export function wrapLabel(label: string, maxChars: number, mono: boolean): string[] {
  const max = Math.max(8, maxChars);
  let pieces: string[];
  if (mono) {
    // quoted strings stay whole; identifiers may break after _ and (
    const raw = label.match(/"[^"]*"|'[^']*'|[A-Za-z0-9$]+[_(]?|[^A-Za-z0-9$\s"']+|\s+/g) || [label];
    pieces = [];
    raw.forEach((piece) => {
      // closing punctuation and separators belong to what they close
      if (pieces.length && /^[)\]}>,.;:"']+\s*$/.test(piece)) pieces[pieces.length - 1] += piece;
      else pieces.push(piece);
    });
  } else {
    pieces = label.split(/(\s+)/).filter((p) => p.length > 0);
  }
  const lines: string[] = [];
  let cur = '';
  /**
   * `atSpace` keeps the space the line was broken on. SVG collapses trailing
   * whitespace when it draws, so the picture is unchanged; the DOM text is
   * not, and the DOM text is what a screen reader speaks and what a copy of
   * the label yields. Without it every wrap welded two words together:
   * "Add a task with an emptytitle".
   */
  const flush = (atSpace = false) => {
    if (cur.trim()) lines.push(cur.trimEnd() + (atSpace ? ' ' : ''));
    cur = '';
  };
  for (const piece of pieces) {
    const isSpace = /^\s+$/.test(piece);
    if (isSpace) {
      if (cur) cur += ' ';
      continue;
    }
    if (cur.length + piece.length > max && cur.trim()) {
      // A break that lands between two words ends the line with the space
      // that separated them; a word split by characters below does not.
      flush(cur.endsWith(' '));
    }
    cur += piece;
    while (cur.length > max) {
      lines.push(cur.slice(0, max));
      cur = cur.slice(max);
    }
  }
  flush();
  return lines.length ? lines : [label];
}

/** Rough width of a column title in the 11.5px semibold face. */
/** What each column holds, drawn at its right edge when the column is wide. */
const COLUMN_NOTE: Record<PhaseKey, string> = {
  requirements: 'Stories and criteria',
  design: 'Contracts',
  implementation: 'Functions',
  testing: 'Tests and planted bugs',
  deployment: 'Runbook and CI',
  maintenance: 'Change request',
};

/**
 * A shorter note, still true, for a column too narrow for its own: at 1280 px the Testing lane (about 214 px) has no
 * room for "Tests and planted bugs" beside its title and its count, and without a note the lane would not say it
 * holds planted bugs as well as tests. Where the full note fits, the full note is drawn.
 */
const COLUMN_NOTE_SHORT: Partial<Record<PhaseKey, string>> = {
  testing: 'Tests and bugs',
};

/** Narrower than this and the column carries its title alone. */
const NOTE_MIN_W = 200;

function titleWidth(key: PhaseKey): number {
  const TITLES: Record<PhaseKey, number> = {
    requirements: 12,
    design: 6,
    implementation: 14,
    testing: 7,
    deployment: 10,
    maintenance: 11,
  };
  return TITLES[key] * FONT * 0.58;
}

/** Rough width of the column note in the 10.5px face. */
function noteWidth(note: string): number {
  return note.length * SUB_FONT * SANS_EM;
}

/** The count's width in the 10.5px mono face, with the gap before it; nothing for zero. */
export function countWidth(count: number): number {
  return count > 0 ? String(count).length * SUB_FONT * MONO_EM + 8 : 0;
}

export function layoutMap(
  data: ProjectMapData,
  width: number,
  minHeight: number,
  /** Insist on the full phase name in every lane heading, whatever the width. */
  fullTitles = false,
): Layout {
  const keys = PHASE_ORDER.filter((k) => data.nodes.some((n) => n.phase === k));
  const totalW = Math.max(0, width - GUTTER * 2);
  const sum = keys.reduce((a, k) => a + WEIGHTS[k], 0) || 1;
  const columns: Column[] = [];
  let x = GUTTER;
  keys.forEach((k) => {
    const w = Math.min(MAX_COL_W, (totalW * WEIGHTS[k]) / sum);
    const count = data.nodes.filter((n) => n.phase === k && n.kind !== 'placeholder').length;
    columns.push({ key: k, x, w, note: COLUMN_NOTE[k], showNote: false, fullTitle: true, count, showCount: false });
    x += w;
  });
  const colIndex = new Map<PhaseKey, number>();
  columns.forEach((c, i) => colIndex.set(c.key, i));

  const placed: Placed[] = [];
  const pos = new Map<string, Placed>();
  const cursor = columns.map(() => HEADER_H + 8);
  data.nodes.forEach((n) => {
    const ci = colIndex.get(n.phase);
    if (ci === undefined) return;
    const col = columns[ci];
    const w = col.w - 12;
    const maxChars = Math.floor((w - TEXT_PAD) / (FONT * (n.mono ? MONO_EM : SANS_EM)));
    const lines = wrapLabel(n.label, maxChars, Boolean(n.mono));
    const subLines = n.sub ? wrapLabel(n.sub, Math.floor((w - TEXT_PAD) / (SUB_FONT * SANS_EM)), false) : [];
    const h = PAD_Y * 2 + lines.length * LINE_H + subLines.length * (LINE_H - 1);
    const p: Placed = { node: n, col: ci, x: col.x + 6, y: cursor[ci], w, h, lines, subLines };
    placed.push(p);
    pos.set(n.id, p);
    cursor[ci] += h + NODE_GAP;
  });
  const height = Math.max(minHeight, ...cursor.map((y) => y + 6));
  columns.forEach((c) => {
    // the title starts 25px in; the count and the note need their own room on
    // the right, and only a column with room to spare gets a note at all
    const countW = countWidth(c.count);
    c.fullTitle = fullTitles || c.w - 25 - 14 - countW >= titleWidth(c.key);
    const fits = (note: string) => c.fullTitle && c.w >= NOTE_MIN_W && 25 + titleWidth(c.key) + 14 + noteWidth(note) + countW + 8 <= c.w;
    c.showNote = fits(c.note);
    const short = COLUMN_NOTE_SHORT[c.key];
    if (!c.showNote && short && fits(short)) {
      c.note = short;
      c.showNote = true;
    }
    // the short names are three to eight letters
    const drawnTitle = c.fullTitle ? titleWidth(c.key) : 8 * FONT * 0.58;
    c.showCount = c.count > 0 && 25 + drawnTitle + countW + 8 <= c.w;
  });

  const edges: EdgeDrawn[] = [];
  // Two builders can reach the same pair (a call edge and a trace edge between
  // the same function and test, say), and the same pair drawn twice is both a
  // duplicate React key and a doubled stroke. The kind is part of what makes an
  // edge distinct, so it is part of the key; a repeat of the same triple is
  // dropped rather than drawn on top of itself.
  const drawn = new Set<string>();
  data.edges.forEach((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return;
    const key = `${e.from}>${e.to}>${e.kind}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    let d: string;
    if (a.col === b.col) {
      const ex = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const y2 = b.y + b.h / 2;
      const bx = ex + 16;
      d = `M${ex} ${y1} C${bx} ${y1}, ${bx} ${y2}, ${ex} ${y2}`;
    } else {
      const [s, t] = a.x < b.x ? [a, b] : [b, a];
      const x1 = s.x + s.w;
      const y1 = s.y + s.h / 2;
      const x2 = t.x;
      const y2 = t.y + t.h / 2;
      const dx = Math.max(20, (x2 - x1) / 2);
      d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
    }
    edges.push({
      key,
      d,
      kind: e.kind,
      fail: a.node.state === 'fail' || b.node.state === 'fail',
      from: e.from,
      to: e.to,
    });
  });
  return { width, height, columns, placed, edges };
}

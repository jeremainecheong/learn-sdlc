'use client';

/**
 * The class diagram the board draws for the learner.
 *
 * Pure SVG, no library: three-compartment boxes (name with its stereotype,
 * attributes, responsibilities) and the five UML relations, each with its own
 * end, an open arrow for association, a hollow diamond for aggregation, a
 * filled one for composition, a hollow triangle for inheritance and a dashed
 * arrow for dependency, and the cardinality at both ends. It redraws from the
 * record on every change; `uml-layout.ts` decides where everything goes.
 *
 * The colours are fixed rather than theme tokens so the exported file looks
 * the same outside the app: white boxes, ink lines, no colour that means
 * nothing.
 */
import { useId, useMemo, useRef } from 'react';
import { useScrollFocusRef } from '@/lib/scroll-focus';
import { sidewaysCue, useSidewaysBox } from '@/lib/use-sideways-box';
import type { Design } from '@learnsdlc/shared';
import { RELATION_KINDS, type RelationKind } from './model';
import { UML, layoutUml, type UmlEdge, type UmlLayout } from './uml-layout';

const INK = '#1f2328';
const MUTED = '#57606a';
const EDGE = '#8c959f';
const WHITE = '#ffffff';

/** Which end of the line carries the kind's mark. */
const END: Record<RelationKind, 'start' | 'end'> = {
  association: 'end',
  aggregation: 'start',
  composition: 'start',
  inheritance: 'end',
  dependency: 'end',
};

function Marker({ id, kind }: { id: string; kind: RelationKind }) {
  const shape =
    kind === 'aggregation' || kind === 'composition' ? (
      <path data-marker={kind} d="M0,6 L6,1 L12,6 L6,11 Z" fill={kind === 'composition' ? INK : WHITE} stroke={INK} strokeWidth={1.2} />
    ) : kind === 'inheritance' ? (
      <path data-marker={kind} d="M0,0.5 L12,6 L0,11.5 Z" fill={WHITE} stroke={INK} strokeWidth={1.2} />
    ) : (
      <path data-marker={kind} d="M0,1 L12,6 L0,11" fill="none" stroke={INK} strokeWidth={1.2} />
    );
  return (
    <marker
      id={id}
      viewBox="0 0 12 12"
      refX={12}
      refY={6}
      markerWidth={12}
      markerHeight={12}
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      {shape}
    </marker>
  );
}

/** A point `along` px from (x, y) towards (tx, ty), pushed `side` px to its left. */
function near(x: number, y: number, tx: number, ty: number, along: number, side: number): [number, number] {
  const len = Math.hypot(tx - x, ty - y) || 1;
  const ux = (tx - x) / len;
  const uy = (ty - y) / len;
  return [Math.round(x + ux * along - uy * side), Math.round(y + uy * along + ux * side)];
}

export interface EdgeText {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

/**
 * Where a line's label or cardinality is written: `side` px to one
 * side of the point `along` px down the line, and anchored so the words grow
 * away from the line. Centred on a point beside a vertical line, a label
 * would straddle it ("h|olds"), so a label pushed to the right starts there, one
 * pushed to the left ends there, and either sits on the point's height. Beside
 * a line that runs across, the words are centred above or below it.
 */
export function besideLine(x: number, y: number, tx: number, ty: number, along: number, side: number): EdgeText {
  const len = Math.hypot(tx - x, ty - y) || 1;
  const ox = (-(ty - y) / len) * side;
  const oy = ((tx - x) / len) * side;
  const [px, py] = near(x, y, tx, ty, along, side);
  if (Math.abs(ox) > Math.abs(oy)) return { x: px, y: py + 4, anchor: ox > 0 ? 'start' : 'end' };
  return { x: px, y: py, anchor: 'middle' };
}

/** Where the two cardinalities and the label of a relation are written. */
export function edgeTexts(edge: UmlEdge): { from: EdgeText; to: EdgeText; label: EdgeText } {
  if (edge.self) {
    return {
      from: { x: edge.x1 - 10, y: edge.y1 - 6, anchor: 'middle' },
      to: { x: edge.x2 + 6, y: edge.y2 + 14, anchor: 'middle' },
      label: { x: edge.x2 + 8, y: edge.y1 - 4, anchor: 'middle' },
    };
  }
  const marked = END[edge.kind];
  return {
    from: marked === 'start' ? clearOfMark(edge, 'from') : besideLine(edge.x1, edge.y1, edge.x2, edge.y2, 20, 10),
    to: marked === 'end' ? clearOfMark(edge, 'to') : besideLine(edge.x2, edge.y2, edge.x1, edge.y1, 20, -10),
    label: clearOfSlant(edge, besideLine((edge.x1 + edge.x2) / 2, (edge.y1 + edge.y2) / 2, edge.x2, edge.y2, 0, -8)),
  };
}

/** The room kept between a cardinality and the mark at its end of the line, and between it and the line. */
export const MARK_CLEAR = 4;
const CARD_CLEAR = 3;

/**
 * The cardinality at the end of a line that carries its mark (an arrowhead, a diamond, a triangle), kept clear of
 * that mark. Beside a line that runs across, a cardinality is centred 20 px back from the end, so one of
 * three or more characters ("0..*", about 26 px) reached into the 12 px mark, and where the line slants it also
 * climbed into the words: TaskTag's "0..*" sat on the arrowhead of the slanted Task to TaskTag line. Its middle now
 * sits at least half its width and {@link MARK_CLEAR} px past the mark, and its capitals keep 3 px from the line under each end of
 * it. Unchanged: a short cardinality ("1", "*") beside a level line, which already cleared the mark, every
 * cardinality beside a line that runs down, and the end of a line with no mark.
 */
function clearOfMark(edge: UmlEdge, end: 'from' | 'to'): EdgeText {
  const [x, y, tx, ty, side] =
    end === 'from' ? [edge.x1, edge.y1, edge.x2, edge.y2, 10] : [edge.x2, edge.y2, edge.x1, edge.y1, -10];
  const plain = besideLine(x, y, tx, ty, 20, side);
  const card = end === 'from' ? edge.fromCard : edge.toCard;
  if (plain.anchor !== 'middle' || !card || tx === x) return plain;
  const half = (card.length * UML.LABEL_CHAR_W) / 2;
  const along = Math.max(20, UML.MARK + MARK_CLEAR + half);
  if (along === 20 && ty === y) return plain;
  const placed = besideLine(x, y, tx, ty, along, side);
  // Measured across the page, as the words are drawn: the push to one side of a slanted line moves them sideways too.
  const dir = Math.sign(tx - x);
  const least = x + dir * (UML.MARK + MARK_CLEAR + half);
  const at = { ...placed, x: dir > 0 ? Math.max(placed.x, Math.ceil(least)) : Math.min(placed.x, Math.floor(least)) };
  const slope = (ty - y) / (tx - x);
  const lineAt = (px: number) => y + (px - x) * slope;
  const ends = [lineAt(at.x - half), lineAt(at.x + half)];
  // Below the line: the capitals 3 px under its lowest point under the words. Above: the baseline 3 px over its highest.
  return at.y > lineAt(at.x)
    ? { ...at, y: Math.max(at.y, Math.ceil(Math.max(...ends) + CARD_CLEAR + LABEL_CAP)) }
    : { ...at, y: Math.min(at.y, Math.floor(Math.min(...ends) - CARD_CLEAR)) };
}

/** How far a relation label keeps from the line it names. */
export const LABEL_CLEAR = 8;
/** The height of an 11 px label's capitals above its baseline, a touch over what the monospace faces draw. */
const LABEL_CAP = 9;

/**
 * A label written across a slanted line, moved clear of it. A label above (or below) a line that runs
 * across is centred on the line's middle, 8 px off it, which is right for a level line. Where the line slants, the
 * words stay level while the line climbs, so one end of a long label would meet the line beside its arrowhead ("is
 * tagged through" between Task and TaskTag). The label is placed by where the line is under each end of its widest line:
 * 8 px above the higher of the two (or below the lower), so no letter crosses it. A level line gives the same place as
 * the centred one, and a label beside a line that runs down is not moved.
 */
function clearOfSlant(edge: UmlEdge, at: EdgeText): EdgeText {
  if (at.anchor !== 'middle' || edge.self || edge.x1 === edge.x2) return at;
  const lines = relationLabelLines(edge);
  if (!lines.length) return at;
  const half = (Math.max(...lines.map((line) => line.length)) * UML.LABEL_CHAR_W) / 2;
  const slope = (edge.y2 - edge.y1) / (edge.x2 - edge.x1);
  const lineAt = (x: number) => edge.y1 + (x - edge.x1) * slope;
  const ends = [lineAt(at.x - half), lineAt(at.x + half)];
  const middle = (edge.y1 + edge.y2) / 2;
  // Above: the last line's baseline 8 px over the line (the lines before it stack upwards). Below: the first line's
  // capitals 8 px under it, so the baseline also clears their height and the lines stacked above it.
  const y =
    at.y <= middle
      ? Math.min(at.y, Math.floor(Math.min(...ends) - LABEL_CLEAR))
      : Math.max(at.y, Math.ceil(Math.max(...ends) + LABEL_CLEAR + LABEL_CAP + (lines.length - 1) * LABEL_LINE_H));
  return { ...at, y };
}

/** The distance between the lines of a relation label written on more than one. */
const LABEL_LINE_H = 13;

/**
 * The lines a relation's label is written on. Beside a line that runs across, the label is centred
 * above it, and the gap between two columns stops at 120 px, so a label longer than the room between the line's two
 * end marks would run into the boxes on either side. Such a label is broken at its spaces (a word longer than a line is
 * broken inside) onto lines that each fit that room, drawn upwards from where the one line was. Every other label,
 * and every label that fits, is one line.
 */
export function relationLabelLines(edge: UmlEdge): string[] {
  const label = edge.label;
  if (!label) return [];
  const across = Math.abs(edge.x2 - edge.x1);
  if (edge.self || across <= Math.abs(edge.y2 - edge.y1)) return [label];
  const room = across - 2 * UML.MARK;
  if (label.length * UML.LABEL_CHAR_W <= room) return [label];
  const max = Math.max(1, Math.floor(room / UML.LABEL_CHAR_W));
  const lines: string[] = [];
  let rest = label;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const cut = space > 0 ? space : max;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) lines.push(rest);
  return lines;
}

/** The box an 11 px cardinality takes where it is written: its capitals over the baseline, its width by anchor. */
function cardSpan(at: EdgeText, card: string): { left: number; right: number; top: number; bottom: number } {
  const w = card.length * UML.LABEL_CHAR_W;
  const left = at.anchor === 'start' ? at.x : at.anchor === 'end' ? at.x - w : at.x - w / 2;
  return { left, right: left + w, top: at.y - LABEL_CAP, bottom: at.y };
}

/**
 * How many px the two cardinalities of one line lack to keep {@link MARK_CLEAR} px apart, 0 where they do. Two boxes
 * side by side are as close as 64 px, and a cardinality moved clear of its mark would then reach the one at the other
 * end, written on the same side of the line: "0..*" at both ends of a many-to-many overlapped by about 12 px, and "1"
 * then "0..*" could read "10..*". Two cardinalities at different heights (3 px or more between them) are apart however
 * far across they reach.
 */
export function cardShortfall(edge: UmlEdge): number {
  if (edge.self || !edge.fromCard || !edge.toCard) return 0;
  const at = edgeTexts(edge);
  const a = cardSpan(at.from, edge.fromCard);
  const b = cardSpan(at.to, edge.toCard);
  if (a.bottom + CARD_CLEAR <= b.top || b.bottom + CARD_CLEAR <= a.top) return 0;
  const gap = Math.max(b.left - a.right, a.left - b.right);
  return gap >= MARK_CLEAR ? 0 : MARK_CLEAR - gap;
}

/**
 * The class diagram's layout with every line's two cardinalities kept apart. Where a line
 * between two boxes side by side is too short for both (each clear of the mark at its end, as `cardSpan`
 * places them), the gap between the columns widens by what they lack, up to the layout's widest gap; the cards keep
 * their places, with room between them. A diagram whose cards already keep apart (TaskTrackr's among them) is laid
 * out exactly as `layoutUml` lays it out.
 */
export function layoutUmlApart(doc: Design): UmlLayout {
  let layout = layoutUml(doc);
  let widen = 0;
  // A wider gap changes the slant of a line between rows a little, so it is measured again, a few times at most.
  for (let round = 0; round < 4; round++) {
    const short = Math.max(0, ...layout.edges.map(cardShortfall));
    if (short === 0) break;
    widen += Math.ceil(short);
    const wider = layoutUml(doc, widen);
    // The gap is already at its widest: nothing more to give.
    if (wider.width === layout.width) break;
    layout = wider;
  }
  return layout;
}

function Edge({ edge, uid }: { edge: UmlEdge; uid: string }) {
  const marker = `url(#${uid}-${edge.kind})`;
  const ends = END[edge.kind] === 'start' ? { markerStart: marker } : { markerEnd: marker };
  const dash = edge.kind === 'dependency' ? { strokeDasharray: '6 4' } : {};
  const d = edge.self
    ? `M${edge.x1} ${edge.y1} C${edge.x1} ${edge.y1 - 14}, ${edge.x2 + 14} ${edge.y2}, ${edge.x2} ${edge.y2}`
    : `M${edge.x1} ${edge.y1} L${edge.x2} ${edge.y2}`;
  const at = edgeTexts(edge);
  const labelLines = relationLabelLines(edge);
  return (
    <g data-testid={`design-uml-edge-${edge.id}`} data-kind={edge.kind}>
      <path d={d} fill="none" stroke={INK} strokeWidth={1.3} {...dash} {...ends} />
      {edge.fromCard && (
        <text x={at.from.x} y={at.from.y} fontSize={11} textAnchor={at.from.anchor} fill={MUTED}>
          {edge.fromCard}
        </text>
      )}
      {edge.toCard && (
        <text x={at.to.x} y={at.to.y} fontSize={11} textAnchor={at.to.anchor} fill={MUTED}>
          {edge.toCard}
        </text>
      )}
      {edge.label && (
        <text x={at.label.x} y={at.label.y} fontSize={11} textAnchor={at.label.anchor} fill={INK} fontStyle="italic">
          {labelLines.length > 1
            ? labelLines.map((line, i) => (
                <tspan key={i} x={at.label.x} dy={i === 0 ? -(labelLines.length - 1) * LABEL_LINE_H : LABEL_LINE_H}>
                  {line}
                </tspan>
              ))
            : edge.label}
        </text>
      )}
    </g>
  );
}

/**
 * How small the drawing may be drawn to fit its column. Drawn at its own width, at 1280 px with the brief and the
 * mentor open TaskTrackr's 680 px drawing would run 140 px past its 540 px box, Tag and TaskTag cut with nothing to
 * say so. It fills the box up to its own width and no wider (where it fits, it is drawn at its own width), and
 * shrinks no further than this share of it: 510 px for TaskTrackr, its 12 px words about 9 px. Narrower
 * than that the box scrolls sideways and the line above it says so, as the sequence drawing and the planted bugs grid
 * do.
 */
export const UML_FLOOR = 0.75;

/** The CSS px the drawing is drawn between: its floor and its own width. */
export function umlDrawnWidths(width: number): { minWidth: number; maxWidth: number } {
  return { minWidth: Math.round(width * UML_FLOOR), maxWidth: width };
}

/** The line above the class diagram's box while it scrolls sideways. */
export const UML_SCROLL_CUE = sidewaysCue('the whole drawing');

export function UmlDiagram({ doc, testId = 'design-uml' }: { doc: Design; testId?: string }) {
  const uid = `uml${useId().replace(/[^A-Za-z0-9]/g, '')}`;
  const layout = useMemo(() => layoutUmlApart(doc), [doc]);
  const svgRef = useRef<SVGSVGElement>(null);
  const box = useSidewaysBox();
  const boxRef = useScrollFocusRef<HTMLDivElement>(box.ref);
  const count = layout.nodes.length;
  const description = `Class diagram: ${count} ${count === 1 ? 'box' : 'boxes'}, ${layout.edges.length} ${
    layout.edges.length === 1 ? 'relation' : 'relations'
  }.`;

  const exportSvg = () => {
    const svg = svgRef.current;
    if (!svg) return;
    // The on-screen fit (a `style` of CSS widths) stays on screen: the exported file is drawn at its own size.
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.removeAttribute('style');
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`;
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'class-diagram.svg';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId} aria-label="Class diagram">
      <div className="flex items-center gap-2">
        <h2 className="h3">Class diagram</h2>
        <span className="label-sm">Drawn from your board as you type</span>
        <span className="flex-1" />
        <button type="button" className="btn-secondary btn-sm" onClick={exportSvg} disabled={count === 0} data-testid={`${testId}-export`}>
          Export diagram (SVG)
        </button>
      </div>
      {count === 0 ? (
        <p className="label-sm wrap" data-testid={`${testId}-empty`}>
          Add an entity or a component below and its box appears here.
        </p>
      ) : (
        <>
          {box.scrolls && (
            <p className="label-sm wrap" data-testid={`${testId}-scroll-cue`}>
              {UML_SCROLL_CUE}
            </p>
          )}
          <div ref={boxRef} className="overflow-x-auto rounded-md border-1.5 border-edge" style={{ background: WHITE }} data-testid={`${testId}-frame`}>
            <svg
              ref={svgRef}
              xmlns="http://www.w3.org/2000/svg"
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              role="img"
              aria-label={description}
              data-testid={`${testId}-svg`}
              data-boxes={count}
              data-relations={layout.edges.length}
              className="block"
              style={{ width: '100%', height: 'auto', ...umlDrawnWidths(layout.width) }}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              <title>{description}</title>
              <defs>
                {RELATION_KINDS.map((kind) => (
                  <Marker key={kind} id={`${uid}-${kind}`} kind={kind} />
                ))}
              </defs>
              <rect x={0} y={0} width={layout.width} height={layout.height} fill={WHITE} />
              {layout.nodes.map((n) => (
                <g key={n.id} data-testid={`design-uml-box-${n.id}`}>
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} fill={WHITE} stroke={EDGE} strokeWidth={1.5} />
                  {n.stereotype && (
                    <text x={n.x + n.w / 2} y={n.y + 14} fontSize={11} textAnchor="middle" fill={MUTED}>
                      {n.stereotype}
                    </text>
                  )}
                  <text x={n.x + n.w / 2} y={n.y + n.headH - 9} fontSize={12} fontWeight={600} textAnchor="middle" fill={INK}>
                    {n.name}
                  </text>
                  <line x1={n.x} x2={n.x + n.w} y1={n.y + n.headH} y2={n.y + n.headH} stroke={EDGE} strokeWidth={1.2} />
                  {n.attributes.map((a, i) => (
                    <text key={`a${i}`} x={n.x + 10} y={n.y + n.headH + 5 + (i + 1) * UML.LINE_H - 4} fontSize={12} fill={INK}>
                      {a}
                    </text>
                  ))}
                  <line
                    x1={n.x}
                    x2={n.x + n.w}
                    y1={n.y + n.headH + n.attrH}
                    y2={n.y + n.headH + n.attrH}
                    stroke={EDGE}
                    strokeWidth={1.2}
                  />
                  {n.responsibilities.map((r, i) => (
                    <text
                      key={`r${i}`}
                      x={n.x + 10 + (n.respIndent[i] ? UML.RESP_INDENT : 0)}
                      y={n.y + n.headH + n.attrH + 5 + (i + 1) * UML.LINE_H - 4}
                      fontSize={12}
                      fill={MUTED}
                    >
                      {r}
                    </text>
                  ))}
                </g>
              ))}
              {layout.edges.map((e) => (
                <Edge key={e.id} edge={e} uid={uid} />
              ))}
            </svg>
          </div>
        </>
      )}
    </section>
  );
}

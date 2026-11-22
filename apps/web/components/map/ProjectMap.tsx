'use client';

/**
 * The project map drawn to scale: a weighted column per phase of the project, with
 * every block the learner has made and the lines that join what verifies
 * what. Pure SVG, no chart library, so the drawing follows the theme tokens
 * and stays crisp at any width.
 *
 * Layout is computed once per (data, width) in a memo; the render maps over
 * precomputed rectangles and path strings. Pointer and keyboard events are
 * delegated to the <svg>, so there is one handler rather than one closure per
 * block. Labels wrap rather than truncate: a block grows to fit its words.
 *
 * The drawing answers what it is pointed at. A block under the pointer or the
 * keyboard lights its own lines in the accent and lifts; a lane under the
 * pointer takes its phase's pale tint and lights every line that touches it;
 * everything else steps back. A block whose state changed since the last
 * drawing settles with one fading ring. It sits in a framed well that scrolls
 * sideways below its `minWidth` and says so. The look is in ProjectMap.css.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnrollmentView, PhaseDetail } from '@learnsdlc/shared';
import { PHASE_META, phaseHue, phaseTint } from '@/lib/phase';
import { useEdgeFade } from '@/components/ui';
import { Icon } from '@/components/Icon';
import { buildProjectMap, stateLabel, type MapEdge, type MapNode, type ProjectMapData } from '@/lib/map';
import { FONT, HEADER_RULE, LINE_H, PAD_Y, SUB_FONT, TEXT_X, countWidth, layoutMap, type EdgeDrawn } from './layout';
import { MapLegend } from './MapLegend';
import './ProjectMap.css';

export interface ProjectMapProps {
  enrollment: EnrollmentView | null | undefined;
  details: Record<string, PhaseDetail>;
  /** A map already built by the caller; when given, enrollment/details are not re-read. */
  data?: ProjectMapData;
  /** Fold criteria under given stories and tests under their function. */
  compact?: boolean;
  /** Show locked phases as one placeholder each. Default true. */
  showLocked?: boolean;
  selectedId?: string | null;
  onSelect?: (node: MapNode) => void;
  /** Minimum drawing height; the graph grows past it when a column needs more. */
  height?: number;
  className?: string;
  /** Draw the legend row under the graph. Default true. */
  legend?: boolean;
  /** Name every lane in full: Implementation, Deployment, Maintenance. */
  fullTitles?: boolean;
  /** The drawing never gets narrower than this; below it the container scrolls. Default 720. */
  minWidth?: number;
}

const C = {
  surface: 'rgb(var(--c-surface))',
  raised: 'rgb(var(--c-raised))',
  edge: 'rgb(var(--c-edge))',
  edge2: 'rgb(var(--c-edge2))',
  ink: 'rgb(var(--c-ink))',
  ink2: 'rgb(var(--c-ink2))',
  muted: 'rgb(var(--c-muted))',
  accent: 'rgb(var(--c-accent))',
  tint: 'rgb(var(--c-tint))',
  fail: 'rgb(var(--c-fail))',
  warn: 'rgb(var(--c-warn))',
};

function strokeFor(state: MapNode['state']): string {
  if (state === 'fail') return C.fail;
  if (state === 'warn') return C.warn;
  if (state === 'now') return C.accent;
  return C.edge2;
}

/**
 * How a line is drawn: a call inside the code is dashed, a line the learner
 * drew themselves is dotted, and what verifies what, including a test against
 * a planted bug, is solid.
 */
const DASH: Partial<Record<MapEdge['kind'], string>> = { system: '4 3', link: '2 3' };

/** The keys that move the graph's one tab stop from block to block. */
const MOVE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

function edgeStroke(e: EdgeDrawn): string {
  if (e.fail) return C.fail;
  return e.kind === 'system' ? C.edge : C.edge2;
}

function barFor(node: MapNode): string {
  if (node.state === 'todo') return C.edge2;
  if (node.state === 'fail') return C.fail;
  if (node.state === 'warn') return C.warn;
  return phaseHue(node.phase);
}

/** What the pointer or the keyboard is on: a block, or a phase's lane. */
interface Active {
  col: number;
  node: string | null;
}

const same = (a: Active | null, b: Active | null) =>
  a === b || (a !== null && b !== null && a.col === b.col && a.node === b.node);

export function ProjectMap({
  enrollment,
  details,
  data,
  compact = false,
  showLocked = true,
  selectedId = null,
  onSelect,
  height = 320,
  className = '',
  legend = true,
  fullTitles = false,
  minWidth = 720,
}: ProjectMapProps) {
  const built = useMemo(
    () => data ?? buildProjectMap(enrollment, details, { compact, showLocked }),
    [data, enrollment, details, compact, showLocked],
  );

  // container width, measured after mount; the first paint uses a sensible default
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width || 0);
      setMeasured((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = Math.max(minWidth, measured || 960);

  const lay = useMemo(
    () => layoutMap(built, width, height, fullTitles),
    [built, width, height, fullTitles],
  );
  const nodeById = useMemo(() => {
    const m = new Map<string, MapNode>();
    built.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [built]);

  const selectedEdges = useMemo(() => {
    if (!selectedId) return null;
    return new Set(lay.edges.filter((e) => e.from === selectedId || e.to === selectedId).map((e) => e.key));
  }, [lay, selectedId]);

  // The graph is one tab stop, not sixty. With a stop per block, a learner
  // reaching the map with the keyboard would have forty to sixty consecutive
  // stops between the view control and the skills strip, which is a wall rather than a
  // graph. One block holds the stop (the selected one, or the first) and the
  // arrows move between blocks the way the phase stepper moves between phases:
  // up and down inside a phase's column, left and right to the neighbouring
  // phase, Home and End to the ends of the drawing.
  const svgRef = useRef<SVGSVGElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const rovingId = useMemo(() => {
    const has = (id: string | null | undefined) =>
      Boolean(id) && lay.placed.some((p) => p.node.id === id);
    if (has(focusId)) return focusId;
    if (has(selectedId)) return selectedId;
    return lay.placed[0]?.node.id ?? null;
  }, [focusId, selectedId, lay]);

  const focusNode = useCallback((id: string) => {
    setFocusId(id);
    const root = svgRef.current;
    if (!root) return;
    const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const el = root.querySelector<SVGGElement>(`[data-node="${sel}"]`);
    el?.focus();
  }, []);

  /** Which block a key moves to, or null when there is nothing that way. */
  const nextFrom = useCallback(
    (from: string, key: string): string | null => {
      const cur = lay.placed.find((p) => p.node.id === from);
      if (!cur) return null;
      if (key === 'Home') return lay.placed[0]?.node.id ?? null;
      if (key === 'End') return lay.placed[lay.placed.length - 1]?.node.id ?? null;
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        const column = lay.placed.filter((p) => p.col === cur.col);
        const i = column.findIndex((p) => p.node.id === from);
        return column[i + (key === 'ArrowDown' ? 1 : -1)]?.node.id ?? null;
      }
      const step = key === 'ArrowRight' ? 1 : -1;
      // Phases with nothing on the map yet are stepped over rather than
      // swallowing the key.
      for (let c = cur.col + step; c >= 0 && c < lay.columns.length; c += step) {
        const column = lay.placed.filter((p) => p.col === c);
        if (column.length === 0) continue;
        return column.reduce((best, p) =>
          Math.abs(p.y - cur.y) < Math.abs(best.y - cur.y) ? p : best,
        ).node.id;
      }
      return null;
    },
    [lay],
  );

  const pick = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      const g = target.closest('[data-node]');
      const id = g?.getAttribute('data-node');
      const node = id ? nodeById.get(id) : undefined;
      if (!node) return;
      // The stop follows the last block touched, so Tab comes back to where
      // the learner was rather than to the top left of the drawing.
      setFocusId(node.id);
      onSelect?.(node);
    },
    [nodeById, onSelect],
  );
  const onClick = useCallback((e: React.MouseEvent) => pick(e.target), [pick]);
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as Element;
      const g = target.closest('[data-node]');
      if (!g) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(target);
        return;
      }
      if (!MOVE_KEYS.has(e.key)) return;
      const from = g.getAttribute('data-node');
      const to = from ? nextFrom(from, e.key) : null;
      if (!to) return;
      e.preventDefault();
      focusNode(to);
    },
    [pick, nextFrom, focusNode],
  );

  // What the pointer or the keyboard is on. A block lights its own lines in
  // the accent; a lane lights every line that touches one of its blocks, in
  // the ink, and tints itself in its phase. Everything else steps back.
  const [active, setActive] = useState<Active | null>(null);
  const colOf = useMemo(() => {
    const m = new Map<string, number>();
    lay.placed.forEach((p) => m.set(p.node.id, p.col));
    return m;
  }, [lay]);
  const activeOf = useCallback(
    (target: EventTarget | null): Active | null => {
      if (!(target instanceof Element)) return null;
      const g = target.closest('[data-node]');
      const id = g?.getAttribute('data-node');
      if (id && colOf.has(id)) return { col: colOf.get(id) as number, node: id };
      const lane = target.closest('[data-col]')?.getAttribute('data-col');
      return lane == null ? null : { col: Number(lane), node: null };
    },
    [colOf],
  );
  const onPointerOver = useCallback(
    (e: React.PointerEvent) => {
      const next = activeOf(e.target);
      setActive((prev) => (same(prev, next) ? prev : next));
    },
    [activeOf],
  );
  const onPointerLeave = useCallback(() => setActive(null), []);
  const onFocus = useCallback(
    (e: React.FocusEvent) => {
      const next = activeOf(e.target);
      setActive((prev) => (same(prev, next) ? prev : next));
    },
    [activeOf],
  );
  const onBlur = useCallback((e: React.FocusEvent) => {
    // Moving between blocks blurs one and focuses the next; only leaving the
    // drawing clears what is lit.
    const to = e.relatedTarget;
    if (to instanceof Node && svgRef.current?.contains(to)) return;
    setActive(null);
  }, []);

  const activeEdges = useMemo(() => {
    if (!active) return null;
    if (active.node) {
      const id = active.node;
      return new Set(lay.edges.filter((e) => e.from === id || e.to === id).map((e) => e.key));
    }
    return new Set(
      lay.edges.filter((e) => colOf.get(e.from) === active.col || colOf.get(e.to) === active.col).map((e) => e.key),
    );
  }, [active, lay, colOf]);

  // A block whose state changed since the last drawing settles once. The
  // first drawing has nothing to compare with, so nothing settles on arrival.
  const seen = useRef<Map<string, MapNode['state']> | null>(null);
  const changed = useMemo(() => {
    const before = seen.current;
    const out = new Set<string>();
    if (!before) return out;
    built.nodes.forEach((n) => {
      const was = before.get(n.id);
      if (was !== undefined && was !== n.state) out.add(n.id);
    });
    return out;
  }, [built]);
  useEffect(() => {
    seen.current = new Map(built.nodes.map((n) => [n.id, n.state]));
  }, [built]);

  // The well says it scrolls: the edge with more behind it fades, and a line
  // under it says so in words.
  const fade = useEdgeFade(wrapRef, [lay.width, built.nodes.length]);

  const dimmed = Boolean(selectedEdges || activeEdges);
  const isLit = (key: string) => Boolean(selectedEdges?.has(key) || (activeEdges?.has(key) && active?.node));
  const plain = lay.edges.filter((e) => !isLit(e.key));
  const lit = lay.edges.filter((e) => isLit(e.key));

  return (
    <div className={`pm-root min-w-0 ${className}`}>
      <div className="pm-well">
        <div ref={wrapRef} className={`pm-scroller w-full min-w-0 ${fade}`}>
          {built.nodes.length === 0 ? (
            <p className="m-0 px-4 py-3.5 text-[13px] text-muted">
              Nothing on the map yet. Open a phase and write something; it will appear here.
            </p>
          ) : (
            <svg
              ref={svgRef}
              data-testid="map-svg"
              role="group"
              aria-label="Project map, use the arrow keys to move between blocks"
              width={lay.width}
              height={lay.height}
              viewBox={`0 0 ${lay.width} ${lay.height}`}
              preserveAspectRatio="xMinYMin meet"
              className="block"
              style={{ minWidth: lay.width }}
              onClick={onClick}
              onKeyDown={onKeyDown}
              onPointerOver={onPointerOver}
              onPointerLeave={onPointerLeave}
              onFocus={onFocus}
              onBlur={onBlur}
            >
              {/* lanes: one per phase, its hue as a small square by the title;
                  a pointed-at lane is outlined and takes its phase's pale tint
                  in its header band only, never behind the drawing's text */}
              {lay.columns.map((c, i) => {
                const on = active?.col === i;
                const countX = c.x + c.w - 10;
                return (
                  <g key={c.key} data-col={i}>
                    <rect
                      className="pm-lane"
                      x={c.x + 2}
                      y={0}
                      width={c.w - 4}
                      height={lay.height}
                      rx={8}
                      fill={i % 2 ? C.raised : C.surface}
                      stroke={on ? C.edge2 : 'none'}
                      strokeWidth={1.5}
                    />
                    {on && (
                      <rect
                        className="pm-lane-band"
                        x={c.x + 2}
                        y={0}
                        width={c.w - 4}
                        height={HEADER_RULE}
                        rx={8}
                        fill={phaseTint(c.key)}
                      />
                    )}
                    <rect x={c.x + 10} y={9} width={9} height={9} rx={2} fill={phaseHue(c.key)} />
                    <text
                      className="pm-lane-title font-sans"
                      x={c.x + 25}
                      y={17}
                      fontSize={11.5}
                      fontWeight={600}
                      fill={on ? C.ink : C.ink2}
                    >
                      {c.fullTitle ? PHASE_META[c.key].title : PHASE_META[c.key].short}
                    </text>
                    {c.showCount && (
                      <text
                        x={countX}
                        y={17}
                        textAnchor="end"
                        fontSize={10.5}
                        fontWeight={600}
                        fill={C.ink2}
                        className="font-mono"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {c.count}
                      </text>
                    )}
                    {c.showNote && (
                      <text
                        x={c.showCount ? countX - countWidth(c.count) : countX}
                        y={17}
                        textAnchor="end"
                        fontSize={10.5}
                        fill={C.muted}
                        className="font-sans"
                      >
                        {c.note}
                      </text>
                    )}
                    <line
                      x1={c.x + 10}
                      x2={c.x + c.w - 10}
                      y1={HEADER_RULE}
                      y2={HEADER_RULE}
                      stroke={C.edge}
                      strokeWidth={1}
                    />
                  </g>
                );
              })}
              {/* lines under blocks; the lit ones drawn last, in accent */}
              <g fill="none" strokeLinecap="round">
                {plain.map((e) => {
                  const lane = activeEdges?.has(e.key) ?? false;
                  return (
                    <path
                      key={e.key}
                      className="pm-edge"
                      d={e.d}
                      stroke={lane && !e.fail ? C.ink2 : edgeStroke(e)}
                      strokeWidth={lane ? 1.75 : 1.5}
                      strokeDasharray={DASH[e.kind]}
                      opacity={dimmed && !lane ? 0.35 : 1}
                    />
                  );
                })}
                {lit.map((e) => (
                  <path
                    key={e.key}
                    className="pm-edge"
                    d={e.d}
                    stroke={C.accent}
                    strokeWidth={2}
                    strokeDasharray={DASH[e.kind]}
                  />
                ))}
              </g>
              {/* blocks */}
              {lay.placed.map((p) => {
                const n = p.node;
                const selected = n.id === selectedId;
                const todo = n.state === 'todo';
                const heavy = n.state === 'now' || n.state === 'fail' || n.state === 'warn';
                const textY = p.y + PAD_Y + FONT;
                return (
                  <g
                    key={n.id}
                    className="pm-node"
                    data-node={n.id}
                    data-testid={`map-node-${n.id}`}
                    role="button"
                    tabIndex={n.id === rovingId ? 0 : -1}
                    aria-pressed={selected}
                    aria-label={`${n.label}${n.sub ? `, ${n.sub}` : ''}, ${stateLabel(n.state, n.kind)}`}
                  >
                    {selected && (
                      <rect x={p.x - 3} y={p.y - 3} width={p.w + 6} height={p.h + 6} rx={9} fill="none" stroke={C.accent} strokeWidth={2} />
                    )}
                    <rect
                      className="pm-ring"
                      x={p.x - 3.5}
                      y={p.y - 3.5}
                      width={p.w + 7}
                      height={p.h + 7}
                      rx={9.5}
                      fill="none"
                      stroke={C.accent}
                      strokeWidth={2}
                    />
                    {changed.has(n.id) && (
                      <rect
                        key={`settle-${n.state}`}
                        className="pm-settle"
                        x={p.x - 3.5}
                        y={p.y - 3.5}
                        width={p.w + 7}
                        height={p.h + 7}
                        rx={9.5}
                        fill={C.tint}
                        stroke={C.accent}
                        strokeWidth={1.5}
                      />
                    )}
                    <rect
                      className="pm-body"
                      x={p.x}
                      y={p.y}
                      width={p.w}
                      height={p.h}
                      rx={7}
                      fill={todo ? 'transparent' : C.surface}
                      stroke={strokeFor(n.state)}
                      strokeWidth={heavy ? 2 : 1.5}
                      strokeDasharray={todo ? '5 4' : undefined}
                    />
                    <rect x={p.x + 6} y={p.y + 7} width={4} height={p.h - 14} rx={2} fill={barFor(n)} />
                    <text
                      x={p.x + TEXT_X}
                      y={textY}
                      fontSize={FONT}
                      fontWeight={600}
                      fill={todo ? C.muted : C.ink}
                      className={n.mono ? 'font-mono' : 'font-sans'}
                    >
                      {p.lines.map((l, i) => (
                        <tspan key={i} x={p.x + TEXT_X} dy={i === 0 ? 0 : LINE_H}>
                          {l}
                        </tspan>
                      ))}
                    </text>
                    {p.subLines.length > 0 && (
                      <text
                        x={p.x + TEXT_X}
                        y={textY + p.lines.length * LINE_H - 1}
                        fontSize={SUB_FONT}
                        fill={C.muted}
                        className="font-sans"
                      >
                        {p.subLines.map((l, i) => (
                          <tspan key={i} x={p.x + TEXT_X} dy={i === 0 ? 0 : LINE_H - 1}>
                            {l}
                          </tspan>
                        ))}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
      </div>
      {fade && built.nodes.length > 0 && (
        <p className="pm-hint" data-testid="map-scroll-hint">
          <Icon name="chevrons-right" size={14} strokeWidth={1.8} />
          The map is wider than the screen. Scroll sideways to see every phase.
        </p>
      )}
      {legend && built.nodes.length > 0 && (
        <MapLegend className="mt-3 px-1" calls={built.edges.some((e) => e.kind === 'system')} />
      )}
    </div>
  );
}

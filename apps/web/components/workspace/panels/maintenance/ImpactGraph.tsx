'use client';

/**
 * The call graph: one band per file, a box per function, an arrow from a
 * caller to what it calls, and a mark saying whether the change added it,
 * altered it or left it alone. Nothing here is filled in: it is drawn from
 * the code the learner already wrote.
 *
 * A box with no test reaching it is dashed, the same way an unwritten thing is
 * dashed everywhere else in the product, and the bar along its foot says how
 * much of the suite's attention the function gets.
 *
 * {@link GraphCanvas} is the drawing on its own, so the change request can put
 * two of them side by side, the code before the change and after it, without
 * a second copy of the node.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzerFunction, ImpactReport } from '@learnsdlc/shared';
import {
  MARK_GLYPH,
  MARK_WORD,
  buildImpactGraph,
  fnKey,
  nodeSub,
  readScope,
  unreadLine,
  type ChangeMark,
  type ImpactGraph as Graph,
  type ImpactNode,
} from './impact';
import { graphWidth } from '../graph-size';

const C = {
  ground: 'rgb(var(--c-ground))',
  surface: 'rgb(var(--c-surface))',
  raised: 'rgb(var(--c-raised))',
  edge: 'rgb(var(--c-edge))',
  edge2: 'rgb(var(--c-edge2))',
  ink: 'rgb(var(--c-ink))',
  ink2: 'rgb(var(--c-ink2))',
  muted: 'rgb(var(--c-muted))',
  accent: 'rgb(var(--c-accent))',
  pass: 'rgb(var(--c-pass))',
  warn: 'rgb(var(--c-warn))',
  onstatus: 'rgb(var(--c-onstatus))',
};

const STYLE = `
.mi-node{cursor:pointer;outline:none}
.mi-node .mi-box{transition:stroke-width .12s ease}
.mi-node:hover .mi-box{stroke-width:2.25}
.mi-node:focus-visible .mi-box{stroke:${C.accent};stroke-width:2.25}
@media (prefers-reduced-motion: reduce){.mi-node .mi-box{transition:none}}
`;

/** The badge fill for each mark. Unchanged is quiet: an edged box, not a fill. */
function badgeOf(mark: ChangeMark): { fill: string; stroke: string; ink: string } {
  if (mark === 'added') return { fill: C.pass, stroke: C.pass, ink: C.onstatus };
  if (mark === 'changed') return { fill: C.warn, stroke: C.warn, ink: C.onstatus };
  if (mark === 'removed') return { fill: C.raised, stroke: C.edge2, ink: C.muted };
  return { fill: 'none', stroke: C.edge2, ink: C.muted };
}

/** The most tests any one function in the drawing is reached by; at least one. */
export function maxReach(graph: Graph): number {
  return graph.nodes.reduce((max, n) => Math.max(max, n.reachedBy.length), 1);
}

/**
 * What a box's tooltip and accessible name say: its name, its mark's word, its tests, its file and line. A function of
 * a file this review did not read (`readScope`) is named without the mark's word: in the Before graph it is the
 * earlier code, and nothing says it was removed.
 */
export function nodeLabel(node: ImpactNode, unread = false): string {
  const mark = unread ? '' : `${MARK_WORD[node.change].toLowerCase()}, `;
  return `${node.label}, ${mark}${nodeSub(node)}, ${node.path} line ${node.line}`;
}

function Node({
  node,
  badge: showBadge,
  unread,
  reach,
  onOpen,
}: {
  node: ImpactNode;
  /** Draw the +/~ mark. The "before" graph has nothing to mark. */
  badge: boolean;
  /** Its file is one this review did not read: its label carries no mark's word. */
  unread: boolean;
  /** The busiest function in this drawing, so the bars share one scale. */
  reach: number;
  onOpen: (path: string) => void;
}) {
  const tests = node.reachedBy.length;
  const orphan = tests === 0;
  const badge = badgeOf(node.change);
  const barW = node.w - 18;
  const fill = orphan ? 0 : Math.max(0.12, Math.min(1, tests / reach));
  const label = nodeLabel(node, unread);
  return (
    <g
      className="mi-node"
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onOpen(node.path)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(node.path);
        }
      }}
    >
      <title>{label}</title>
      <rect
        className="mi-box"
        x={node.x}
        y={node.y}
        width={node.w}
        height={node.h}
        rx={7}
        fill={C.surface}
        stroke={C.edge2}
        strokeWidth={1.5}
        strokeDasharray={orphan ? '5 4' : undefined}
      />
      <text
        className="font-mono"
        x={node.x + 9}
        y={node.y + 17}
        fontSize={12.5}
        fontWeight={600}
        fill={orphan ? C.muted : C.ink}
      >
        {node.label}
      </text>
      <text x={node.x + 9} y={node.y + 31} fontSize={11.5} fill={C.muted}>
        {nodeSub(node)}
      </text>
      <rect x={node.x + 9} y={node.y + 37} width={barW} height={4} rx={2} fill={C.edge} />
      {fill > 0 && (
        <rect x={node.x + 9} y={node.y + 37} width={barW * fill} height={4} rx={2} fill={C.pass} />
      )}
      {showBadge && node.change !== 'unchanged' && (
        <>
          <rect
            x={node.x + node.w - 22}
            y={node.y + 6}
            width={15}
            height={15}
            rx={4}
            fill={badge.fill}
            stroke={badge.stroke}
            strokeWidth={1.5}
          />
          <text
            className="font-mono"
            x={node.x + node.w - 14.5}
            y={node.y + 17.5}
            fontSize={11}
            fontWeight={700}
            fill={badge.ink}
            textAnchor="middle"
          >
            {MARK_GLYPH[node.change]}
          </text>
        </>
      )}
    </g>
  );
}

/**
 * One drawing. The caller owns the width it was laid out at, so two canvases
 * on the same row are drawn to the same scale.
 */
export function GraphCanvas({
  graph,
  badges = true,
  unreadPaths,
  reach,
  onOpen,
  title,
  testId,
}: {
  graph: Graph;
  badges?: boolean;
  /**
   * The files this review did not read (`readScope`): their boxes are named without a mark's word. Only the Before
   * graph draws such a file; the After graph leaves it out.
   */
  unreadPaths?: ReadonlySet<string>;
  reach?: number;
  onOpen: (path: string) => void;
  /** What the drawing is, for the people who hear it rather than see it. */
  title?: string;
  testId?: string;
}) {
  if (graph.nodes.length === 0) return null;
  const scale = reach ?? maxReach(graph);
  const files = graph.bands.length === 1 ? '1 file' : `${graph.bands.length} files`;
  return (
    <svg
      width={graph.width}
      height={graph.height}
      viewBox={`0 0 ${graph.width} ${graph.height}`}
      role="img"
      aria-label={`${title ? `${title}: ` : ''}call graph, ${graph.nodes.length} functions across ${files}`}
      style={{ display: 'block', maxWidth: 'none' }}
      data-testid={testId}
    >
      <style>{STYLE}</style>
      <defs>
        <marker id="mi-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 1 L7 4 L0 7 z" fill={C.edge2} />
        </marker>
      </defs>
      {graph.bands.map((band, i) => (
        <rect
          key={band.path}
          x={band.x}
          y={band.y}
          width={band.w}
          height={band.h}
          rx={8}
          fill={i % 2 === 1 ? C.ground : 'none'}
          stroke={C.edge}
          strokeWidth={1.5}
        />
      ))}
      {graph.edges.map((e) => (
        <path key={e.key} d={e.d} fill="none" stroke={C.edge2} strokeWidth={1.5} markerEnd="url(#mi-arrow)" />
      ))}
      {graph.bands.map((band) => (
        <g key={`l-${band.path}`}>
          <text className="font-mono" x={band.x + 10} y={band.y + 15} fontSize={11.5} fill={C.ink2}>
            {band.label}
          </text>
          <text x={band.x + band.w - 10} y={band.y + 15} fontSize={11} fill={C.muted} textAnchor="end">
            {band.count === 1 ? '1 function' : `${band.count} functions`}
          </text>
        </g>
      ))}
      {graph.nodes.map((n) => (
        <Node key={fnKey(n)} node={n} badge={badges} unread={unreadPaths?.has(n.path) ?? false} reach={scale} onOpen={onOpen} />
      ))}
    </svg>
  );
}

export function LegendKey({ mark, label }: { mark: ChangeMark; label: string }) {
  const badge = badgeOf(mark);
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="mono inline-flex h-[15px] w-[15px] items-center justify-center rounded-sm text-[10.5px] font-bold leading-none"
        style={{ background: badge.fill, border: `1.5px solid ${badge.stroke}`, color: badge.ink, boxSizing: 'border-box' }}
        aria-hidden
      >
        {MARK_GLYPH[mark]}
      </span>
      <span className="label-sm">{label}</span>
    </span>
  );
}

/** The keys under a drawing: what the marks mean, and what the bar measures. */
export function GraphLegend({ className = '' }: { className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-0.5 ${className}`}>
      <LegendKey mark="added" label={MARK_WORD.added} />
      <LegendKey mark="changed" label={MARK_WORD.changed} />
      <span className="flex items-center gap-1.5">
        <span
          className="inline-block h-[15px] w-[18px] rounded-sm"
          style={{ border: '1.5px dashed rgb(var(--c-edge2))', boxSizing: 'border-box' }}
          aria-hidden
        />
        <span className="label-sm">No test named for it</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-1 w-[18px] rounded-sm bg-pass" aria-hidden />
        <span className="label-sm">Tests named for it, against the busiest function</span>
      </span>
    </div>
  );
}

/** The width a drawing may use, measured from the box it sits in. */
export function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width || 0);
      setWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * The line naming the files a graph after the change leaves out because this
 * review did not read them (`readScope`). Nothing when it leaves none out.
 */
export function UnreadNote({ unread }: { unread: ReturnType<typeof readScope>['unread'] }) {
  const line = unreadLine(unread);
  if (!line) return null;
  return (
    <p className="purpose wrap m-0" data-testid="phase-maintenance-impact-unread">
      {line}
    </p>
  );
}

/** The graph after the change, on its own: what the IDE's Change tab shows. */
export function ImpactGraph({
  impact,
  functions,
  editablePaths,
  onOpen,
  testId,
}: {
  impact: ImpactReport | undefined;
  functions: AnalyzerFunction[];
  /** The files the learner edits in this phase: a removed mark stands only where this review read the file (`readScope`). */
  editablePaths?: string[];
  onOpen: (path: string) => void;
  testId?: string;
}) {
  const [wrapRef, measured] = useMeasuredWidth();
  const scope = useMemo(() => readScope(impact, functions, editablePaths), [impact, functions, editablePaths]);
  const graph = useMemo(
    () => buildImpactGraph(scope.impact, functions, graphWidth(measured)),
    [scope, functions, measured],
  );

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div ref={wrapRef} className="min-w-0 overflow-x-auto" data-testid={testId}>
        <GraphCanvas graph={graph} onOpen={onOpen} title="After the change" />
      </div>
      <UnreadNote unread={scope.unread} />
      <GraphLegend />
    </div>
  );
}

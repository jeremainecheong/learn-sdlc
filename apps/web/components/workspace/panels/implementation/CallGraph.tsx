'use client';

/**
 * The call graph the analyzer already reports: a box per function, an arrow
 * from a caller to what it calls, and a red outline wherever a failing case's
 * traceback landed. Selecting a box opens that file at the function.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzerFunction } from '@learnsdlc/shared';
import { phaseHue } from '@/lib/phase';
import { buildCallGraph } from './pr';
import { graphWidth } from '../graph-size';

const C = {
  surface: 'rgb(var(--c-surface))',
  edge2: 'rgb(var(--c-edge2))',
  ink: 'rgb(var(--c-ink))',
  accent: 'rgb(var(--c-accent))',
  fail: 'rgb(var(--c-fail))',
};

const STYLE = `
.cg-node{cursor:pointer;outline:none}
.cg-node .cg-body{transition:stroke-width .12s ease}
.cg-node:hover .cg-body{stroke-width:2.25}
.cg-node:focus-visible .cg-body{stroke:${C.accent};stroke-width:2.25}
@media (prefers-reduced-motion: reduce){.cg-node .cg-body{transition:none}}
`;

export function CallGraph({
  functions,
  failing,
  onOpen,
  testId,
}: {
  functions: AnalyzerFunction[];
  /** Where every failing case's traceback landed. */
  failing: { path: string; line: number }[];
  onOpen: (path: string, line: number) => void;
  testId?: string;
}) {
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

  const graph = useMemo(
    () => buildCallGraph(functions, failing, graphWidth(measured)),
    [functions, failing, measured],
  );

  const byName = useMemo(() => {
    const m = new Map<string, { path: string; line: number }>();
    graph.nodes.forEach((n) => m.set(n.name, { path: n.path, line: n.line }));
    return m;
  }, [graph]);

  const pick = useCallback(
    (target: EventTarget | null) => {
      if (!(target instanceof Element)) return;
      const name = target.closest('[data-fn]')?.getAttribute('data-fn');
      const hit = name ? byName.get(name) : undefined;
      if (hit) onOpen(hit.path, hit.line);
    },
    [byName, onOpen],
  );
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as Element;
      if (!target.closest('[data-fn]')) return;
      e.preventDefault();
      pick(target);
    },
    [pick],
  );

  if (graph.nodes.length === 0) return null;

  return (
    <div className="min-w-0">
      <style>{STYLE}</style>
      <div ref={wrapRef} className="w-full min-w-0 overflow-x-auto">
        <svg
          data-testid={testId}
          role="group"
          aria-label="Call graph"
          width={graph.width}
          height={graph.height}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          preserveAspectRatio="xMinYMin meet"
          className="block"
          style={{ minWidth: graph.width }}
          onClick={(e) => pick(e.target)}
          onKeyDown={onKeyDown}
        >
          <defs>
            <marker
              id="cg-arrow"
              viewBox="0 0 8 8"
              refX="6.5"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M1 1L7 4L1 7" fill="none" stroke={C.edge2} strokeWidth={1.4} strokeLinecap="round" />
            </marker>
          </defs>
          <g fill="none" strokeLinecap="round">
            {graph.edges.map((e) => (
              <path key={e.key} d={e.d} stroke={C.edge2} strokeWidth={1.5} markerEnd="url(#cg-arrow)" />
            ))}
          </g>
          {graph.nodes.map((n) => (
            <g
              key={n.name}
              className="cg-node"
              data-fn={n.name}
              role="button"
              tabIndex={0}
              aria-label={`${n.name}, ${n.path} line ${n.line}${
                n.failing ? ', a failing case lands here' : ''
              }. Opens the file.`}
            >
              <rect
                className="cg-body"
                x={n.x}
                y={n.y}
                width={n.w}
                height={n.h}
                rx={7}
                fill={C.surface}
                stroke={n.failing ? C.fail : C.edge2}
                strokeWidth={n.failing ? 2 : 1.5}
              />
              <rect
                x={n.x + 6}
                y={n.y + 7}
                width={4}
                height={n.h - 14}
                rx={2}
                fill={n.failing ? C.fail : phaseHue('implementation')}
              />
              <text
                x={n.x + 16}
                y={n.y + n.h / 2 + 4}
                fontSize={11.5}
                fill={n.failing ? C.fail : C.ink}
                className="font-mono"
              >
                {n.label}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {graph.total > graph.nodes.length && (
        <p className="label-sm mt-2">
          The first {graph.nodes.length} of {graph.total} functions the analyzer resolved.
        </p>
      )}
    </div>
  );
}

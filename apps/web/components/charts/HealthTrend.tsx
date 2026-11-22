'use client';

import { useState } from 'react';
import type { HealthPoint } from '@/components/workspace/ide/health';

/**
 * The code-quality score across a phase's revisions, drawn under the code.
 * Same geometry as `HintsTrendChart`: a 2px line, markers ringed
 * in the surface colour, two hairlines for the scale and one direct label at
 * the end. It is smaller, because it lives in the bottom panel rather than on
 * a page of its own.
 *
 * The sentence beside it is not a caption. Below `md` the svg is hidden and the
 * sentence is the chart, so a phone and a screen reader read the same words.
 */
export function HealthTrend({ points, sentence }: { points: HealthPoint[]; sentence: string }) {
  const [focused, setFocused] = useState<number | null>(null);

  const width = 420;
  const height = 116;
  const pad = { top: 16, right: 30, bottom: 22, left: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;

  // The scale is always the whole criterion. A line that rescales to its own
  // best revision makes 62 look like a triumph.
  const x = (i: number) => pad.left + (points.length > 1 ? (i / (points.length - 1)) * plotW : plotW / 2);
  const y = (v: number) => pad.top + plotH - (v / 100) * plotH;

  const marks = points.map((p, i) => ({ px: x(i), py: y(p.quality), point: p }));
  const linePath = marks.map((m, i) => `${i === 0 ? 'M' : 'L'} ${m.px} ${m.py}`).join(' ');
  const areaPath =
    marks.length > 0
      ? `${linePath} L ${marks[marks.length - 1].px} ${baseline} L ${marks[0].px} ${baseline} Z`
      : '';

  return (
    <div className="flex flex-col gap-1.5" data-testid="health-trend">
      <div className="hidden overflow-x-auto md:block">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full min-w-[420px] max-w-[520px]"
          // Not role="img": that makes the svg a leaf and every per-revision
          // <title> below it would be dropped before it reached a screen reader.
          role="group"
          aria-label={sentence}
        >
          <line x1={pad.left} y1={pad.top} x2={pad.left + plotW} y2={pad.top} className="stroke-edge" strokeWidth={1} />
          <text
            x={pad.left - 8}
            y={pad.top + 4}
            fontSize={11}
            className="fill-muted"
            textAnchor="end"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            100
          </text>
          <line x1={pad.left} y1={baseline} x2={pad.left + plotW} y2={baseline} className="stroke-edge" strokeWidth={1} />
          <text
            x={pad.left - 8}
            y={baseline + 4}
            fontSize={11}
            className="fill-muted"
            textAnchor="end"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            0
          </text>
          {marks.length > 0 && (
            <>
              <path d={areaPath} className="fill-accent" opacity={0.08} />
              <path
                d={linePath}
                fill="none"
                className="stroke-accent"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
          {marks.map((m, i) => {
            const label = `Revision ${m.point.attempt}: code quality ${m.point.quality} of 100`;
            return (
              <g
                key={m.point.attempt}
                tabIndex={0}
                onFocus={() => setFocused(i)}
                onBlur={() => setFocused(null)}
                // Safari does not move focus to a focusable non-form element on
                // tap, which would leave the reading unreachable by touch.
                onPointerDown={(e) => e.currentTarget.focus()}
                // The ring is drawn below rather than left to the browser:
                // Safari paints no outline on a focused <g>.
                className="outline-none"
                data-testid={`health-trend-point-${m.point.attempt}`}
              >
                <title>{label}</title>
                <circle cx={m.px} cy={m.py} r={11} fill="transparent" />
                {focused === i && (
                  <circle cx={m.px} cy={m.py} r={9} fill="none" className="stroke-accent" strokeWidth={2} />
                )}
                <circle cx={m.px} cy={m.py} r={4} className="fill-accent stroke-surface" strokeWidth={2} />
                <text x={m.px} y={baseline + 15} fontSize={11} className="fill-muted" textAnchor="middle">
                  {m.point.attempt}
                </text>
                {i === marks.length - 1 && (
                  <text
                    x={m.px}
                    y={m.py - 9}
                    fontSize={11}
                    className="fill-ink"
                    textAnchor="middle"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {m.point.quality}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="purpose md:sr-only" data-testid="health-trend-sentence">
        {sentence}
      </p>
    </div>
  );
}

'use client';

/**
 * The pipeline as a drawing: one card per job, laid out left to right in the
 * order `needs:` puts them in, each step carrying its outcome from the last
 * verdict. Text is measured and wrapped so nothing spills out of a card, and
 * the whole drawing scrolls inside its own strip when the pane is narrow.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PipelineJob, PipelineStep, StepState } from './ci';
import { columnsOf } from './ci';
import { useScrollFocusRef } from '@/lib/scroll-focus';

const C = {
  surface: 'rgb(var(--c-surface))',
  edge: 'rgb(var(--c-edge))',
  edge2: 'rgb(var(--c-edge2))',
  ink: 'rgb(var(--c-ink))',
  ink2: 'rgb(var(--c-ink2))',
  muted: 'rgb(var(--c-muted))',
  accent: 'rgb(var(--c-accent))',
  pass: 'rgb(var(--c-pass))',
  fail: 'rgb(var(--c-fail))',
};

const PAD = 12;
const GAP = 30;
const HDR = 30;
// 12px is the floor the design system sets for drawn text; the column
// minimum below rises with it so a wider label scrolls rather than shrinks.
const FS = 12;
const LH = 15;
const ROW_PAD = 5;
const GAP_Y = 18;
const NOTE_LH = 14;

/** Geist is close enough to these ratios that a measured layout holds. */
const tw = (s: string, size: number, mono = false) => s.length * size * (mono ? 0.62 : 0.55);

function wrapText(s: string, maxW: number, size: number, mono: boolean, maxLines: number): string[] {
  const str = String(s ?? '');
  if (!str) return [];
  if (tw(str, size, mono) <= maxW) return [str];
  const tokens = mono ? str.split(/(?<=[_,(.\/=:\-\s])/) : str.split(/(?<=[\s\/=])/);
  const cw = size * (mono ? 0.62 : 0.55);
  const lines: string[] = [];
  let cur = '';
  const fits = (t: string) => tw(t.trimEnd(), size, mono) <= maxW;
  for (let tok of tokens) {
    if (fits(cur + tok)) {
      cur += tok;
      continue;
    }
    if (cur) {
      lines.push(cur.trimEnd());
      cur = '';
    }
    while (!fits(tok)) {
      const n = Math.max(1, Math.floor(maxW / cw));
      lines.push(tok.slice(0, n));
      tok = tok.slice(n);
    }
    cur = tok;
  }
  if (cur.trimEnd()) lines.push(cur.trimEnd());
  if (lines.length > maxLines) {
    lines.length = maxLines;
    const n = Math.max(1, Math.floor(maxW / cw) - 1);
    lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, n)}…`;
  }
  return lines;
}

const stepColour = (state: StepState) =>
  state === 'pass' ? C.pass : state === 'fail' ? C.fail : state === 'skip' ? C.edge2 : C.edge2;

function StepSquare({ x, y, state, size = 9 }: { x: number; y: number; state: StepState; size?: number }) {
  const filled = state === 'pass' || state === 'fail';
  return (
    <rect
      x={x}
      y={y}
      width={size}
      height={size}
      rx={2.5}
      fill={filled ? stepColour(state) : 'none'}
      stroke={filled ? 'none' : C.edge2}
      strokeWidth={1.5}
      strokeDasharray={state === 'todo' ? '2.5 2.5' : undefined}
    />
  );
}

interface Row {
  step: PipelineStep;
  /** The step's name, wrapped. */
  lines: string[];
  /** The command or action version, in mono under the name. */
  detail: string[];
  /** Why it failed, in the reading face. */
  note: string[];
  h: number;
}

interface Card {
  job: PipelineJob;
  rows: Row[];
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout(jobs: PipelineJob[], width: number) {
  const col = columnsOf(jobs);
  const nCols = Math.max(1, Math.max(0, ...jobs.map((j) => col.get(j.id) ?? 0)) + 1);
  const cw = (width - PAD * 2 - GAP * (nCols - 1)) / nCols;
  const full = Math.max(60, cw - 40);
  const cursor = new Array<number>(nCols).fill(6);
  const cards: Card[] = jobs.map((job) => {
    const rows: Row[] = job.steps.map((step) => {
      const lines = wrapText(step.name, full, FS, !step.todo, 3);
      const detail = step.detail ? wrapText(step.detail, full, 10, true, 2) : [];
      const note = step.note ? wrapText(step.note, full, 10, false, 2) : [];
      return {
        step,
        lines,
        detail,
        note,
        h: ROW_PAD * 2 + lines.length * LH + (detail.length + note.length) * NOTE_LH,
      };
    });
    const h = HDR + rows.reduce((a, r) => a + r.h, 0) + 8;
    const c = col.get(job.id) ?? 0;
    const card: Card = { job, rows, x: PAD + c * (cw + GAP), y: cursor[c], w: cw, h };
    cursor[c] += h + GAP_Y;
    return card;
  });
  const height = Math.max(...cursor) - GAP_Y + 12;
  return { cards, height, byId: new Map(cards.map((c) => [c.job.id, c])) };
}

// Labels are sentences with capitals, the same words the chips two panels
// over use.
const jobWord = (state: PipelineJob['state']) =>
  state === 'pass' ? 'Passed' : state === 'fail' ? 'Failed' : state === 'now' ? 'Part run' : 'Not run';

export function PipelineDrawing({ jobs }: { jobs: PipelineJob[] }) {
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

  const nCols = useMemo(() => {
    const col = columnsOf(jobs);
    return Math.max(1, Math.max(0, ...jobs.map((j) => col.get(j.id) ?? 0)) + 1);
  }, [jobs]);
  const minWidth = PAD * 2 + nCols * 180 + (nCols - 1) * GAP;
  const width = Math.max(minWidth, measured || minWidth);
  const { cards, height } = useMemo(() => layout(jobs, width), [jobs, width]);

  const summary = jobs.map((j) => `${j.id} ${jobWord(j.state).toLowerCase()}`).join(', ');
  // Wider than a phone, it scrolls; while it does, the keyboard can reach it.
  const wrap = useScrollFocusRef(wrapRef);

  return (
    <div ref={wrap} className="w-full min-w-0 overflow-x-auto">
      <svg
        role="img"
        aria-label={`Pipeline: ${summary}.`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        className="block"
        style={{ minWidth: width }}
      >
        {cards.flatMap((c) =>
          c.job.needs.map((need) => {
            const parent = cards.find((p) => p.job.id === need);
            if (!parent || parent === c) return null;
            const y0 = parent.y + HDR / 2;
            const y1 = c.y + HDR / 2;
            const x0 = parent.x + parent.w;
            const x1 = c.x;
            const jx = x0 + GAP / 2;
            const blocked = parent.job.state === 'fail' || parent.job.state === 'todo';
            return (
              <g key={`${need}-${c.job.id}`}>
                <path
                  d={`M${x0} ${y0} H${jx} V${y1} H${x1 - 6}`}
                  fill="none"
                  stroke={C.edge2}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeDasharray={blocked ? '4 3' : undefined}
                />
                <path
                  d={`M${x1 - 6} ${y1 - 3.6}L${x1} ${y1}L${x1 - 6} ${y1 + 3.6}Z`}
                  fill={C.edge2}
                />
              </g>
            );
          }),
        )}

        {cards.map((c) => {
          const failed = c.job.state === 'fail';
          let cy = c.y + HDR + 4;
          return (
            <g key={c.job.id}>
              <rect
                x={c.x}
                y={c.y}
                width={c.w}
                height={c.h}
                rx={7}
                fill={C.surface}
                stroke={failed ? C.fail : C.edge2}
                strokeWidth={1.5}
                strokeDasharray={c.job.state === 'todo' ? '5 4' : undefined}
              />
              <rect
                x={c.x + 10}
                y={c.y + 10}
                width={10}
                height={10}
                rx={2.5}
                fill={
                  c.job.state === 'pass'
                    ? C.pass
                    : c.job.state === 'fail'
                      ? C.fail
                      : 'none'
                }
                stroke={c.job.state === 'now' ? C.accent : c.job.state === 'todo' ? C.edge2 : 'none'}
                strokeWidth={c.job.state === 'now' ? 2 : 1.5}
                strokeDasharray={c.job.state === 'todo' ? '2.5 2.5' : undefined}
              />
              <text
                x={c.x + 26}
                y={c.y + 19}
                fontSize={12.5}
                fontWeight={600}
                fill={c.job.state === 'todo' ? C.muted : C.ink}
              >
                {wrapText(c.job.id, c.w - 74, 12.5, false, 1)[0] ?? c.job.id}
              </text>
              <text
                x={c.x + c.w - 10}
                y={c.y + 19}
                fontSize={12}
                textAnchor="end"
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                fill={failed ? C.fail : C.muted}
              >
                {jobWord(c.job.state)}
              </text>
              <path d={`M${c.x} ${c.y + HDR} H${c.x + c.w}`} stroke={C.edge} strokeWidth={1.5} />
              {c.rows.map((r, i) => {
                const top = cy;
                cy += r.h;
                const dim = r.step.state === 'todo' || r.step.state === 'skip';
                return (
                  <g key={`${c.job.id}-${i}`}>
                    <StepSquare x={c.x + 12} y={top + ROW_PAD + 1} state={r.step.state} />
                    {r.lines.map((line, li) => (
                      <text
                        key={li}
                        x={c.x + 28}
                        y={top + ROW_PAD + 9 + li * LH}
                        fontSize={FS}
                        fontFamily={
                          r.step.todo ? undefined : 'var(--font-geist-mono), ui-monospace, monospace'
                        }
                        fontStyle={r.step.todo ? 'italic' : undefined}
                        fill={dim ? C.muted : C.ink2}
                      >
                        {li === 0 && <title>{r.step.name}</title>}
                        {line}
                      </text>
                    ))}
                    {r.detail.map((line, di) => (
                      <text
                        key={`d${di}`}
                        x={c.x + 28}
                        y={top + ROW_PAD + 9 + r.lines.length * LH + di * NOTE_LH}
                        fontSize={12}
                        fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                        fill={C.muted}
                      >
                        {di === 0 && <title>{r.step.detail}</title>}
                        {line}
                      </text>
                    ))}
                    {r.note.map((line, ni) => (
                      <text
                        key={`n${ni}`}
                        x={c.x + 28}
                        y={top + ROW_PAD + 9 + r.lines.length * LH + (r.detail.length + ni) * NOTE_LH}
                        fontSize={12}
                        fill={r.step.state === 'fail' ? C.fail : C.muted}
                      >
                        {line}
                      </text>
                    ))}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

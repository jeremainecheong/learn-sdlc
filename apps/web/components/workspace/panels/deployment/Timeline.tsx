'use client';

/**
 * INCIDENT-1 on a time axis: a dot per event, labels alternating above and
 * below the line, and a red span across the minutes the deployment was broken.
 * The events come from the drill state, so the timeline is the record of what
 * actually happened rather than an illustration.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScrollFocusRef } from '@/lib/scroll-focus';
// "1 minute 10 seconds", worded once for the timeline, the incident card and the drill page's chip.
import { STILL_BROKEN, spoken } from './drill';

const C = {
  surface: 'rgb(var(--c-surface))',
  ground: 'rgb(var(--c-ground))',
  edge: 'rgb(var(--c-edge))',
  edge2: 'rgb(var(--c-edge2))',
  ink2: 'rgb(var(--c-ink2))',
  muted: 'rgb(var(--c-muted))',
  accent: 'rgb(var(--c-accent))',
  pass: 'rgb(var(--c-pass))',
  fail: 'rgb(var(--c-fail))',
  warn: 'rgb(var(--c-warn))',
};

export type EventKind = 'alert' | 'check' | 'fix' | 'verify' | 'note';

/** Labels are sentences with capitals: never the raw enum, never tracked. */
const KIND_WORD: Record<EventKind, string> = {
  alert: 'Alert',
  check: 'Check',
  fix: 'Fix',
  verify: 'Verify',
  note: 'Note',
};

export interface TimelineEvent {
  /** Seconds since the learner was paged. */
  at: number;
  /** The clock label under the dot, e.g. "1:50". */
  t: string;
  kind: EventKind;
  label: string;
  state?: 'pass' | 'fail';
}

const PAD = 14;
// 12px is the design system's floor for drawn text; the label width and the
// minimum drawing width below rise with it, so a long label scrolls instead
// of being set smaller than anything else in the product.
const FS = 12;
const KIND_FS = 12;
const LH = 15;
const GAP_L = 8;
const MAX_LABEL = 170;

const tw = (s: string, size: number, mono = false) => s.length * size * (mono ? 0.62 : 0.55);

function wrapText(s: string, maxW: number, size: number, maxLines: number): string[] {
  if (tw(s, size) <= maxW) return [s];
  const tokens = s.split(/(?<=[\s\/=])/);
  const cw = size * 0.55;
  const lines: string[] = [];
  let cur = '';
  const fits = (t: string) => tw(t.trimEnd(), size) <= maxW;
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

const kindColour = (e: TimelineEvent) =>
  e.state === 'pass'
    ? C.pass
    : e.state === 'fail'
      ? C.fail
      : e.kind === 'alert'
        ? C.warn
        : e.kind === 'fix'
          ? C.accent
          : e.kind === 'check' || e.kind === 'verify'
            ? C.ink2
            : C.muted;

interface Label {
  lines: string[];
  w: number;
  h: number;
  side: 'above' | 'below';
  x0: number;
}

function build(events: TimelineEvent[], width: number) {
  const t0 = Math.min(...events.map((e) => e.at));
  const t1 = Math.max(...events.map((e) => e.at));
  const span = t1 - t0;
  const ax0 = PAD + 6;
  const ax1 = width - PAD - 6;
  // Every event in the same second (a fast drill) would stack on one dot, so
  // the axis falls back to even spacing rather than drawing them on top of
  // each other.
  const xs = events.map((e, i) =>
    span > 0
      ? ax0 + ((e.at - t0) / span) * (ax1 - ax0)
      : ax0 + (events.length > 1 ? (i / (events.length - 1)) * (ax1 - ax0) : 0),
  );

  const measure = (e: TimelineEvent, maxW: number): Omit<Label, 'side' | 'x0'> => {
    const lines = wrapText(e.label, maxW - 12, FS, 4);
    const w = Math.max(...lines.map((l) => tw(l, FS)), tw(KIND_WORD[e.kind], KIND_FS) + 10) + 12;
    return { lines, w, h: 16 + lines.length * LH + 4 };
  };
  const labels: Label[] = events.map((e, i) => ({
    ...measure(e, MAX_LABEL),
    side: i % 2 ? 'below' : 'above',
    x0: 0,
  }));
  const centre = (l: Label, i: number) => {
    l.x0 = Math.max(PAD, Math.min(width - PAD - l.w, xs[i] - l.w / 2));
  };
  (['above', 'below'] as const).forEach((side) => {
    const group = labels.map((l, i) => ({ l, i })).filter((o) => o.l.side === side);
    if (group.length === 0) return;
    group.forEach((o) => centre(o.l, o.i));
    const fit = () => {
      for (let k = 1; k < group.length; k += 1) {
        const a = group[k - 1].l;
        const b = group[k].l;
        if (b.x0 < a.x0 + a.w + GAP_L) b.x0 = a.x0 + a.w + GAP_L;
      }
      const last = group[group.length - 1].l;
      if (last.x0 + last.w > width - PAD) last.x0 = width - PAD - last.w;
      for (let k = group.length - 2; k >= 0; k -= 1) {
        const a = group[k].l;
        const b = group[k + 1].l;
        if (a.x0 + a.w + GAP_L > b.x0) a.x0 = b.x0 - GAP_L - a.w;
      }
    };
    fit();
    if (group[0].l.x0 < PAD) {
      // The row is wider than the canvas: shrink every box on this side and re-wrap.
      const avail = width - PAD * 2 - GAP_L * (group.length - 1);
      const sum = group.reduce((acc, o) => acc + o.l.w, 0);
      const k = avail / sum;
      group.forEach((o) => {
        Object.assign(o.l, measure(events[o.i], Math.max(64, o.l.w * k)));
        centre(o.l, o.i);
      });
      fit();
      group.forEach((o) => {
        o.l.x0 = Math.max(PAD, o.l.x0);
      });
    }
  });

  const aboveH = Math.max(0, ...labels.filter((l) => l.side === 'above').map((l) => l.h));
  const belowH = Math.max(0, ...labels.filter((l) => l.side === 'below').map((l) => l.h));
  const axisY = 8 + aboveH + 30;
  const timeY = axisY + 16;
  const height = timeY + 14 + belowH + 10;
  const boxTop = (l: Label) => (l.side === 'above' ? axisY - 22 - l.h : timeY + 12);
  return { xs, labels, axisY, timeY, height, boxTop };
}

export function IncidentTimeline({
  events,
  className = '',
}: {
  events: TimelineEvent[];
  className?: string;
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
  const minWidth = 400;
  const width = Math.max(minWidth, measured || minWidth);
  const geo = useMemo(() => build(events, width), [events, width]);

  // The red span ends at the fix, the first passing health run after the
  // failure (the drill's `fixAppliedAt`), so a later re-run of the check does
  // not stretch it and the span is the one the incident card and the drill
  // page's chip state. With no fix drawn, the first pass after the
  // failure, then the last event. With neither (the incident is still open)
  // the span runs to the last event and says "Still broken": the drill page's
  // chip counts to now, and a length taken at the last event would be a
  // second, shorter one.
  const failIdx = events.findIndex((e) => e.state === 'fail');
  let endIdx = failIdx >= 0 ? events.findIndex((e, i) => i > failIdx && e.kind === 'fix') : -1;
  if (failIdx >= 0 && endIdx < 0) endIdx = events.findIndex((e, i) => i > failIdx && e.state === 'pass');
  const open = failIdx >= 0 && endIdx < 0;
  if (open) endIdx = events.length - 1;
  const broken = failIdx >= 0 && endIdx > failIdx;
  const brokenLabel = !broken ? '' : open ? STILL_BROKEN : `Broken for ${spoken(events[endIdx].at - events[failIdx].at)}`;

  const summary = events.map((e) => `${e.t} ${e.label}`).join('. ');
  // Wider than a phone, it scrolls; while it does, the keyboard can reach it.
  const wrap = useScrollFocusRef(wrapRef);

  return (
    <div ref={wrap} className={`w-full min-w-0 overflow-x-auto ${className}`}>
      <svg
        role="img"
        aria-label={`INCIDENT-1 timeline. ${summary}.`}
        width={width}
        height={geo.height}
        viewBox={`0 0 ${width} ${geo.height}`}
        preserveAspectRatio="xMinYMin meet"
        className="block"
        style={{ minWidth: width }}
      >
        <path
          d={`M${PAD} ${geo.axisY} H${width - PAD}`}
          stroke={C.edge2}
          strokeWidth={2}
          strokeLinecap="round"
        />
        {broken && (
          <g>
            <rect
              x={geo.xs[failIdx]}
              y={geo.axisY - 7}
              width={Math.max(2, geo.xs[endIdx] - geo.xs[failIdx])}
              height={14}
              rx={3}
              fill={C.fail}
              fillOpacity={0.14}
            />
            <path
              d={`M${geo.xs[failIdx]} ${geo.axisY} H${geo.xs[endIdx]}`}
              stroke={C.fail}
              strokeWidth={3}
              strokeLinecap="round"
            />
            <text
              x={(geo.xs[failIdx] + geo.xs[endIdx]) / 2}
              y={geo.axisY - 10}
              fontSize={12}
              fontWeight={500}
              textAnchor="middle"
              fill={C.fail}
            >
              {brokenLabel}
            </text>
          </g>
        )}
        {events.map((_, i) => {
          const l = geo.labels[i];
          const above = l.side === 'above';
          const ly0 = geo.boxTop(l);
          const stemEnd = above ? ly0 + l.h : ly0;
          const x = geo.xs[i];
          const inBox = x >= l.x0 + 6 && x <= l.x0 + l.w - 6;
          const d = inBox
            ? `M${x} ${geo.axisY + (above ? -6 : 6)} V${stemEnd}`
            : (() => {
                const jx = x < l.x0 ? l.x0 + 10 : l.x0 + l.w - 10;
                const my = above ? stemEnd + 8 : stemEnd - 8;
                return `M${x} ${geo.axisY + (above ? -6 : 6)} V${my} H${jx} V${stemEnd}`;
              })();
          return (
            <path key={`stem${i}`} d={d} fill="none" stroke={C.edge2} strokeWidth={1.5} strokeLinejoin="round" />
          );
        })}
        {events.map((e, i) => {
          const l = geo.labels[i];
          const ly0 = geo.boxTop(l);
          const colour = kindColour(e);
          const filled = e.state === 'pass' || e.state === 'fail' || e.kind === 'fix' || e.kind === 'alert';
          const x = geo.xs[i];
          const tWidth = tw(e.t, 12, true);
          const tX = Math.max(PAD + tWidth / 2, Math.min(width - PAD - tWidth / 2, x));
          return (
            <g key={`ev${i}`}>
              <circle
                cx={x}
                cy={geo.axisY}
                r={5}
                fill={filled ? colour : C.ground}
                stroke={filled ? C.ground : colour}
                strokeWidth={filled ? 2 : 1.5}
              />
              <rect
                x={tX - tWidth / 2 - 4}
                y={geo.timeY - 8}
                width={tWidth + 8}
                height={17}
                rx={3}
                fill={C.ground}
              />
              <text
                x={tX}
                y={geo.timeY + 3}
                fontSize={12}
                textAnchor="middle"
                fontWeight={500}
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                fill={C.muted}
              >
                {e.t}
              </text>
              <rect
                x={l.x0}
                y={ly0}
                width={l.w}
                height={l.h}
                rx={5}
                fill={C.surface}
                stroke={e.state ? colour : C.edge}
                strokeWidth={1.5}
              />
              <text
                x={l.x0 + 8}
                y={ly0 + 13}
                fontSize={KIND_FS}
                fontWeight={600}
                fill={e.state ? colour : C.muted}
              >
                {KIND_WORD[e.kind]}
              </text>
              {l.lines.map((line, li) => (
                <text key={li} x={l.x0 + 8} y={ly0 + 13 + LH + li * LH} fontSize={FS} fill={C.ink2}>
                  {li === 0 && <title>{e.label}</title>}
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

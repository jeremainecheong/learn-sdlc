'use client';

import type { PhaseKey } from '@learnsdlc/shared';
import { Icon } from '@/components/Icon';
import { PHASE_META, phaseHue, phaseTint } from '@/lib/phase';

/* ---------------------------------------------------------------------------
   PhaseTile: the numeral tile, phase tint with the phase-hue numeral. The
   only place a phase hue is a fill besides the map's node bars.
--------------------------------------------------------------------------- */
export function PhaseTile({
  phaseKey,
  size = 36,
  muted = false,
  className = '',
  icon = false,
  numeral,
}: {
  phaseKey: PhaseKey;
  size?: number;
  muted?: boolean;
  className?: string;
  /** Show the phase glyph instead of the numeral. */
  icon?: boolean;
  /**
   * The number on the tile: the phase's place in its project where the caller
   * knows it, else LearnSDLC's own number for the key.
   */
  numeral?: number;
}) {
  const meta = PHASE_META[phaseKey];
  const style: React.CSSProperties = muted
    ? {
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        border: '1.5px dashed rgb(var(--c-edge2))',
        color: 'rgb(var(--c-muted))',
      }
    : {
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        background: phaseTint(phaseKey),
        color: phaseHue(phaseKey),
      };
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center font-mono font-bold tabular-nums ${className}`}
      style={{ ...style, fontSize: Math.round(size * 0.44), boxSizing: 'border-box' }}
      aria-hidden
    >
      {icon ? <Icon name={phaseKey} size={Math.round(size * 0.55)} /> : (numeral ?? meta.order)}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   PhaseLine: the numeral tile, the phase's name, and where it sits in the
   project's phases. The one way the product says "you are in phase 2 of 3",
   counted over the phases this project holds.
--------------------------------------------------------------------------- */
export function PhaseLine({
  phaseKey,
  title,
  size = 22,
  place,
  count,
  muted = false,
  className = '',
}: {
  phaseKey: PhaseKey;
  /** The API's title for the phase. Falls back to the interface's own name. */
  title?: string;
  /** The phase's place in its project, 1 to `count` (`PhaseDetail.place`). */
  place: number;
  /** How many phases the project holds (`PhaseDetail.count`). */
  count: number;
  size?: number;
  muted?: boolean;
  className?: string;
}) {
  const meta = PHASE_META[phaseKey];
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <PhaseMark phaseKey={phaseKey} size={size} state={muted ? 'todo' : 'pass'} numeral={place} />
      <span className="truncate text-[13px] font-semibold text-ink">{title ?? meta.title}</span>
      <span className="label-sm whitespace-nowrap tabular-nums">phase {place} of {count}</span>
    </span>
  );
}

/* ---------------------------------------------------------------------------
   PhaseMark: the phase numeral as a solid mark.

   This is the only place a phase hue is a fill. `PhaseTile` is the quiet form
   (a numeral on its tint, for a list of many things) and this is the loud
   one, for the phases themselves: filled when the phase is behind you,
   filled and ringed when it is the one you are in, dashed and empty when it is
   not open yet. The numeral is drawn in `onstatus`, which is white on Paper
   and near-black on Graphite, because the hue swaps lightness between themes.
--------------------------------------------------------------------------- */
export function PhaseMark({
  phaseKey,
  state = 'pass',
  size = 22,
  /** The colour of the gap inside the ring: whatever the mark sits on. */
  ringGap = 'rgb(var(--c-surface))',
  numeral,
  className = '',
}: {
  phaseKey: PhaseKey;
  /** pass: behind you. now: where you are. todo: not open yet. */
  state?: 'pass' | 'now' | 'todo';
  /**
   * The number on the tile: the phase's place in its project where the caller
   * knows it, else LearnSDLC's own number for the key.
   */
  numeral?: number;
  size?: number;
  ringGap?: string;
  className?: string;
}) {
  const meta = PHASE_META[phaseKey];
  const hue = phaseHue(phaseKey);
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.27),
    fontSize: Math.round(size * 0.5),
    boxSizing: 'border-box',
  };
  const style: React.CSSProperties =
    state === 'todo'
      ? { ...base, border: '1.5px dashed rgb(var(--c-edge2))', color: 'rgb(var(--c-muted))' }
      : {
          ...base,
          background: hue,
          color: 'rgb(var(--c-onstatus))',
          ...(state === 'now' ? { boxShadow: `0 0 0 2px ${ringGap}, 0 0 0 3.5px ${hue}` } : null),
        };
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center font-bold tabular-nums ${className}`}
      style={style}
      aria-hidden
    >
      {numeral ?? meta.order}
    </span>
  );
}

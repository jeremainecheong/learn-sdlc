'use client';

import type { PhaseKey } from '@learnsdlc/shared';
import { phaseHue, phaseTint, type StatusState } from '@/lib/phase';

export type Tone = 'neutral' | 'pass' | 'fail' | 'warn' | 'accent';

/* ---------------------------------------------------------------------------
   Chip: 6px radius, 12px medium. Neutral on raised; status chips solid.
--------------------------------------------------------------------------- */
export function Chip({
  tone = 'neutral',
  hue,
  children,
  className = '',
  testId,
  title,
}: {
  tone?: Tone | 'phase' | 'outline';
  hue?: PhaseKey;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  title?: string;
}) {
  const cls =
    tone === 'pass'
      ? 'chip chip-pass'
      : tone === 'fail'
        ? 'chip chip-fail'
        : tone === 'warn'
          ? 'chip chip-warn'
          : tone === 'accent'
            ? 'chip chip-accent'
            : tone === 'outline'
              ? 'chip chip-outline'
              : 'chip';
  const style = tone === 'phase' && hue ? { background: phaseTint(hue), color: phaseHue(hue) } : undefined;
  return (
    <span className={`${cls} ${className}`} style={style} data-testid={testId} title={title}>
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   StatusSquare: the one status glyph.
--------------------------------------------------------------------------- */
export function StatusSquare({
  state,
  hue,
  size = 10,
  className = '',
  label,
}: {
  state: StatusState;
  hue?: PhaseKey;
  size?: number;
  className?: string;
  /** Spoken name for screen readers when the square stands alone. */
  label?: string;
}) {
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.max(2, Math.round(size * 0.28)),
    boxSizing: 'border-box',
    flex: 'none',
    display: 'inline-block',
  };
  const style: React.CSSProperties =
    state === 'pass'
      ? { ...base, background: 'rgb(var(--c-pass))' }
      : state === 'done'
        ? { ...base, background: hue ? phaseHue(hue) : 'rgb(var(--c-accent))' }
        : state === 'now'
          ? { ...base, border: '2px solid rgb(var(--c-accent))' }
          : state === 'fail'
            ? { ...base, background: 'rgb(var(--c-fail))' }
            : state === 'warn'
              ? { ...base, background: 'rgb(var(--c-warn))' }
              : { ...base, border: '1.5px dashed rgb(var(--c-edge2))' };
  return (
    <span
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
    />
  );
}

export const STATUS_WORD: Record<StatusState, string> = {
  pass: 'Passed',
  done: 'Done',
  now: 'In progress',
  todo: 'Not yet',
  fail: 'Failing',
  warn: 'Needs attention',
};

/* ---------------------------------------------------------------------------
   Stat: one number in a tinted box.
--------------------------------------------------------------------------- */
export function Stat({
  value,
  label,
  hint,
  tone = 'neutral',
  testId,
  className = '',
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  testId?: string;
  className?: string;
}) {
  const bg =
    tone === 'pass'
      ? 'bg-passtint'
      : tone === 'fail'
        ? 'bg-failtint'
        : tone === 'warn'
          ? 'bg-warntint'
          : tone === 'accent'
            ? 'bg-tint'
            : 'bg-raised';
  const fg =
    tone === 'pass'
      ? 'text-pass'
      : tone === 'fail'
        ? 'text-fail'
        : tone === 'warn'
          ? 'text-warn'
          : tone === 'accent'
            ? 'text-accent'
            : 'text-ink';
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 rounded-ctl px-3 py-2.5 ${bg} ${className}`} data-testid={testId}>
      <span className={`readout text-[20px] leading-tight ${fg}`}>{value}</span>
      <span className="label-sm wrap font-medium text-muted">{label}</span>
      {hint && <span className="label-sm wrap">{hint}</span>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Readout: the number a page is about, at the size that says so.
--------------------------------------------------------------------------- */
export function Readout({
  value,
  unit,
  label,
  size = 34,
  tone = 'neutral',
  className = '',
  testId,
}: {
  value: React.ReactNode;
  /** The small mono qualifier beside it: "of 100", "of 3". */
  unit?: React.ReactNode;
  label?: React.ReactNode;
  size?: number;
  tone?: Tone;
  className?: string;
  testId?: string;
}) {
  const fg =
    tone === 'pass' ? 'text-pass' : tone === 'fail' ? 'text-fail' : tone === 'warn' ? 'text-warn' : tone === 'accent' ? 'text-accent' : 'text-ink';
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`} data-testid={testId}>
      <span className="flex items-baseline gap-1.5">
        <span className={`readout leading-none ${fg}`} style={{ fontSize: size }}>
          {value}
        </span>
        {unit && <span className="mono text-[12.5px] text-muted">{unit}</span>}
      </span>
      {label && <span className="label-sm">{label}</span>}
    </div>
  );
}

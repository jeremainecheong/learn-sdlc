'use client';

import type { PhaseKey } from '@learnsdlc/shared';
import { phaseHue, phaseTint } from '@/lib/phase';

/* ---------------------------------------------------------------------------
   Avatar: initials in a ring. With a phaseKey the ring takes the phase hue
   (the reviewer persona for that phase).
--------------------------------------------------------------------------- */
export function Avatar({
  initials,
  phaseKey,
  size = 28,
  className = '',
  title,
}: {
  initials: string;
  phaseKey?: PhaseKey;
  size?: number;
  className?: string;
  title?: string;
}) {
  const style: React.CSSProperties = phaseKey
    ? {
        width: size,
        height: size,
        background: phaseTint(phaseKey),
        border: `1.5px solid ${phaseHue(phaseKey)}`,
        color: phaseHue(phaseKey),
      }
    : {
        width: size,
        height: size,
        background: 'rgb(var(--c-raised))',
        border: '1.5px solid rgb(var(--c-edge2))',
        color: 'rgb(var(--c-ink2))',
      };
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold tracking-[0.02em] ${className}`}
      style={{ ...style, fontSize: Math.round(size * 0.36), boxSizing: 'border-box' }}
      title={title}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? 'img' : undefined}
    >
      {initials.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Initials from a display name: "Mei Lin Tan" → "MT". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
}

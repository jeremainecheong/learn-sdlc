import type { ReactNode } from 'react';
import type { PhaseKey } from '@learnsdlc/shared';

/* Six flat phase icons on lucide's grid: 24 x 24, 1.5 px stroke in
 * currentColor, round caps and joins, no fill. Drawn by hand for LearnSDLC. */
const DRAWINGS: Record<PhaseKey, ReactNode> = {
  // A card with a question mark.
  requirements: <>
    <rect x="4.5" y="3" width="15" height="18" rx="2" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.25c-.7.35-1.1.95-1.1 1.75v.5" />
    <path d="M12 17.25v.01" />
  </>,
  // Two boxes joined by a line.
  design: <>
    <rect x="2.5" y="3.5" width="8" height="6" rx="1.5" />
    <rect x="13.5" y="14.5" width="8" height="6" rx="1.5" />
    <path d="M6.5 9.5v8h7" />
  </>,
  // Angle brackets with a text cursor between them.
  implementation: <>
    <path d="M8 6.5L2.5 12 8 17.5" />
    <path d="M16 6.5l5.5 5.5-5.5 5.5" />
    <path d="M12 7.5v9M10.5 7.5h3M10.5 16.5h3" />
  </>,
  // A flask with a tick.
  testing: <>
    <path d="M9 2.75h6" />
    <path d="M10 2.75v5.5L4.6 18.1A2 2 0 0 0 6.35 21h11.3a2 2 0 0 0 1.75-2.9L14 8.25v-5.5" />
    <path d="M9.25 15.5l1.9 1.9 3.6-3.9" />
  </>,
  // A box with an arrow leaving it upwards.
  deployment: <>
    <path d="M7.5 11.5H4.5v9h15v-9h-3" />
    <path d="M12 16V3M7.75 7.25L12 3l4.25 4.25" />
  </>,
  // A wrench crossing a branch.
  maintenance: <>
    <circle cx="6" cy="4.5" r="2" />
    <circle cx="6" cy="19.5" r="2" />
    <path d="M6 6.5v11" />
    <path d="M6 14c0-3.5 2.5-5 6-5" />
    <path d="M11.5 20.5l5.25-5.25" />
    <path d="M16.75 15.25a3.75 3.75 0 0 0 4.6-5.1l-2.1 2.1-2-.55-.55-2 2.1-2.1a3.75 3.75 0 0 0-5.1 4.6" />
  </>,
};

export interface PhaseGlyphProps {
  phaseKey: PhaseKey;
  /** Pixel size of the square (24 by default). */
  size?: number;
  /** Give the icon a name when it stands alone; leave it out when words sit beside it. */
  title?: string;
  className?: string;
}

/** One flat stroke icon per phase, for the map, the catalogue rows and the
 * path strip. Decorative (`aria-hidden`) unless given a `title`. */
export function PhaseGlyph({ phaseKey, size = 24, title, className }: PhaseGlyphProps) {
  return (
    <svg
      className={`phase-glyph${className ? ` ${className}` : ''}`}
      data-phase={phaseKey}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: false })}
    >
      {DRAWINGS[phaseKey]}
    </svg>
  );
}

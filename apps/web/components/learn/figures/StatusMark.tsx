import type { ReactNode } from 'react';

export type FigureStatus = 'passed' | 'failed' | 'survived' | 'killed' | 'not-run' | 'current';

/** The word each state is drawn with by default. A state is never colour alone. */
export const STATUS_WORDS: Record<FigureStatus, string> = {
  passed: 'Passed',
  failed: 'Failed',
  survived: 'Survived',
  killed: 'Killed',
  'not-run': 'Not run',
  current: 'You are here',
};

const GLYPHS: Record<FigureStatus, ReactNode> = {
  passed: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  killed: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
  failed: <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  survived: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" /></>,
  'not-run': <path d="M4 8h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  current: <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="8" cy="8" r="2" fill="currentColor" /></>,
};

export interface StatusMarkProps {
  status: FigureStatus;
  /** Replace the default word (for example "Not meaningful" with the not-run glyph). */
  label?: string;
  className?: string;
}

/** The one place a state becomes colour + glyph + word. The glyph is
 * decorative to assistive technology; the word is always drawn as text. */
export function StatusMark({ status, label, className }: StatusMarkProps) {
  return (
    <span className={`fig-status fig-status-${status}${className ? ` ${className}` : ''}`} data-status={status}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{GLYPHS[status]}</svg>
      <span className="fig-status-word">{label ?? STATUS_WORDS[status]}</span>
    </span>
  );
}

'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { usePrefersReducedMotion } from './motion';
import { codeFragments } from './CodeText';

export interface Step {
  /** A short heading for the frame. */
  title: string;
  /** What the frame shows, in one or two sentences; announced politely on each move. */
  text: string;
  /** The frame's picture: an SVG, a card, a table. */
  content?: ReactNode;
}

export interface StepThroughProps {
  /** The group's name, read out (for example "Propose, explain, apply"). */
  label: string;
  steps: readonly Step[];
  /** Zero-based frame to open on. */
  initialStep?: number;
  /** Told the zero-based frame after every move, for figures that redraw around it. */
  onStepChange?: (index: number) => void;
}

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

/** An ordered set of frames with Back, Next and Start again, a "Step 2 of 5"
 * counter and a polite live line. The arrow keys, Home and End move between
 * frames from anywhere inside the group (except a text field, or a ToggleSet,
 * which keeps its own arrows). Under reduced motion a frame swaps, it does not
 * slide. */
export function StepThrough({ label, steps, initialStep = 0, onStepChange }: StepThroughProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialStep, 0), steps.length - 1));
  const reduce = usePrefersReducedMotion();
  const back = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const last = steps.length - 1;
  const go = (to: number) => {
    const target = Math.min(Math.max(to, 0), last);
    if (target === index) return;
    setIndex(target);
    onStepChange?.(target);
  };
  // A button that has just become disabled would drop focus to the page;
  // hand it to the button that still moves.
  useEffect(() => {
    const active = document.activeElement;
    if (active === back.current && index === 0) next.current?.focus();
    else if (active === next.current && index === last) back.current?.focus();
  }, [index, last]);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (EDITABLE.test((event.target as HTMLElement).tagName)) return;
    const to =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null;
    if (to === null) return;
    event.preventDefault();
    go(to);
  };
  const step = steps[index];
  return (
    <section className="fig-steps" aria-label={label} data-motion={reduce ? 'reduce' : 'full'} onKeyDown={onKeyDown}>
      <div className="fig-steps-dots" aria-hidden="true">
        {steps.map((_, i) => (
          <span key={i} data-current={i === index} data-done={i < index} />
        ))}
      </div>
      <div className="fig-steps-head" aria-live="polite" aria-atomic="true">
        <span className="fig-steps-count">Step {index + 1} of {steps.length}</span>
        <strong>{codeFragments(step.title)}</strong>
        <p className="fig-steps-text">{codeFragments(step.text)}</p>
      </div>
      {step.content && (
        <div className="fig-steps-frame" key={index} data-step={index + 1}>
          {step.content}
        </div>
      )}
      <div className="fig-steps-controls">
        <button ref={back} type="button" className="fig-button" disabled={index === 0} onClick={() => go(index - 1)}>
          Back
        </button>
        <button ref={next} type="button" className="fig-button" disabled={index === last} onClick={() => go(index + 1)}>
          Next
        </button>
        <button type="button" className="fig-button" disabled={index === 0} onClick={() => { go(0); next.current?.focus(); }}>
          Start again
        </button>
      </div>
    </section>
  );
}

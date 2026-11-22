'use client';
import type { ComponentType } from 'react';

import { HowChecksWork } from './HowChecksWork';

/* The section for "How LearnSDLC checks your work" on the
 * Learn catalogue. The slot draws the section and its one h2; the mounted
 * component (`HowChecksWork`, no props) draws the figure under it and no
 * heading of its own. `component` lets a test mount something else. */
const MOUNTED: ComponentType | null = HowChecksWork;

/** The catalogue's section for the step-through: its heading and one line,
 * then the component. Draws nothing while no component is mounted. */
export function HowChecksWorkSlot({ component = MOUNTED }: { component?: ComponentType | null }) {
  const Mounted = component;
  if (!Mounted) return null;
  return (
    <section className="learn-how-checks" aria-labelledby="learn-how-checks-title" data-testid="how-checks-work">
      <header className="learn-section-heading">
        <h2 id="learn-how-checks-title">How LearnSDLC checks your work</h2>
        <span>Propose, explain, apply</span>
      </header>
      <Mounted />
    </section>
  );
}

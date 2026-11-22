import type { ComponentType } from 'react';
import type { PhaseKey } from '@learnsdlc/shared';
import type { PhaseFigures } from './types';
import { REQUIREMENTS_FIGURES } from './requirements';
import { DESIGN_FIGURES } from './design';
import { IMPLEMENTATION_FIGURES } from './implementation';
import { TESTING_FIGURES } from './testing';
import { DEPLOYMENT_FIGURES } from './deployment';
import { MAINTENANCE_FIGURES } from './maintenance';

/** Every guide figure, by phase. Each phase registers its figures in its own
 * `figures/<phase>.tsx`; this file only joins the six. */
export const FIGURES: Record<PhaseKey, PhaseFigures> = {
  requirements: REQUIREMENTS_FIGURES,
  design: DESIGN_FIGURES,
  implementation: IMPLEMENTATION_FIGURES,
  testing: TESTING_FIGURES,
  deployment: DEPLOYMENT_FIGURES,
  maintenance: MAINTENANCE_FIGURES,
};

/** The figures registered on one chapter (numbered from 1, as the reader
 * shows it), in the order their phase file lists them. */
export function figuresFor(phaseKey: PhaseKey, chapter: number): { id: string; Component: ComponentType }[] {
  return Object.entries(FIGURES[phaseKey])
    .filter(([, entry]) => entry.chapter === chapter)
    .map(([id, entry]) => ({ id, Component: entry.component }));
}

import type { PhaseKey } from '@learnsdlc/shared';
import type { PhasePanel } from './types';
import requirements from './requirements';
import design from './design';
import implementation from './implementation';
import testing from './testing';
import deployment from './deployment';
import maintenance from './maintenance';

export const PHASE_PANELS: Partial<Record<PhaseKey, PhasePanel>> = {
  requirements, design, implementation, testing, deployment, maintenance,
};
export type { DrillApi, PhasePanel, PhasePanelProps, PhasePanelHelpers } from './types';

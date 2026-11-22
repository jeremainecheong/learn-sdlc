'use client';

import type { PhasePanel } from '../types';
import MaintenanceBrief from './Brief';
import { MaintenanceTools } from './Tools';

/**
 * The maintenance phase's own tab. It is named for the artefact it holds,
 * the change, because the right pane already has Tests and Feedback tabs for
 * the run and the verdict.
 */
const panel: PhasePanel = {
  Brief: MaintenanceBrief,
  Tools: MaintenanceTools,
  toolsLabel: 'Change',
  toolsIcon: 'maintenance',
};

export default panel;

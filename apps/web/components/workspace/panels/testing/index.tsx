'use client';

import type { PhasePanel } from '../types';
import TestingBrief from './Brief';
import { TestingTools } from './Tools';

/**
 * The right pane already has a Tests tab for the run output, so this one is
 * named for what it holds: the criteria, and the evidence each test gives.
 */
const panel: PhasePanel = {
  Brief: TestingBrief,
  Tools: TestingTools,
  toolsLabel: 'Criteria',
  toolsIcon: 'target',
};

export default panel;

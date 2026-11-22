'use client';

import type { PhasePanel } from '../types';
import { DesignBrief } from './DesignBrief';
import { DesignTools } from './DesignTools';

/**
 * The Design phase in the IDE. The brief pane summarises the design; the
 * Design tab carries the same forms the Design room draws.
 */
const panel: PhasePanel = {
  Brief: DesignBrief,
  Tools: DesignTools,
  toolsLabel: 'Design',
  toolsIcon: 'design',
};
export default panel;

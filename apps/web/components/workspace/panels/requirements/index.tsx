'use client';

import type { PhasePanel } from '../types';
import RequirementsBrief from './BriefCard';
import IssueEditor from './IssueEditor';

/** Requirements: the backlog in the brief pane, US-4 as a form in the Issue tab. */
const panel: PhasePanel = {
  Brief: RequirementsBrief,
  Tools: IssueEditor,
  toolsLabel: 'Issue',
  toolsIcon: 'requirements',
};
export default panel;

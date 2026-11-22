/**
 * Agentic proposals as the learner sees them: the proposal, its
 * assessment and its field-by-field changes.
 */

import type { FieldChange } from '../projection-diff';

/* ---------------------- Agentic proposals: the learner's view ------------- */

/**
 * One assessed dimension of an explanation: the learner's own cited
 * sentences, verbatim, beside the server's finding. Absent on an intent
 * assessment and on a stored explanation record written without dimensions.
 * The server may omit any optional field or name a finding in words this
 * client does not know, so every field is narrowed again where it is drawn.
 */
export interface AgentAssessmentDimension {
  key: string; met: boolean; finding?: string; learnerEvidence?: string[]; reasoning?: string;
}
export interface AgentAssessment { adequate: boolean; feedback: string; questions: string[]; dimensions?: AgentAssessmentDimension[] }
export interface AgentProposal {
  id: string; phaseStateId: string; prompt: string; files: Record<string, string>;
  proposalHash: string; baseWorkspaceHash: string; assessment: AgentAssessment;
  explanation: string | null; explanationAssessment: AgentAssessment | null;
  approvedAt: string | null; appliedAt: string | null; createdAt: string;
  /** A structured kind's proposal (a story one that touches the record, any design one): its field-by-field changes from the saved documents. */
  changes?: FieldChange[];
  /** What a proposal never changes, kept and never listed as changes: the story's kept fields (`id`, `epics`, `parentEpicId`) or the design's kept ids and statuses ('entity E1', 'the status of D1'). */
  carried?: string[];
}

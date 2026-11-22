import { designReviewProjection, evaluateDesignFloor, type PhaseRubric } from '@learnsdlc/shared';
import type { DesignChecks } from '../content/content.types';
import { floorPartial, type FloorPartial } from './floor-partial';

export type DesignPartial = FloorPartial;

/**
 * The floor over the record, the contracts that are on and, when it is on, the
 * sequence diagram, scored as the story's: one required check per rule, every
 * criterion scored by the share that pass. A missing or invalid record fails
 * `design.record` and the rest is scored against the empty record.
 */
export function buildDesignReport(rubric: PhaseRubric, checks: DesignChecks, files: Record<string, string>): DesignPartial {
  return floorPartial(rubric, evaluateDesignFloor(files, checks));
}

/** What the reviewer reads: one labelled field per path, never a file. */
export function designWorkspaceForReview(checks: DesignChecks, files: Record<string, string>): Record<string, string> {
  return designReviewProjection(files, checks);
}

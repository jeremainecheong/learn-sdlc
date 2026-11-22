import {
  CHANGE_REQUEST_JSON, RUNBOOK_JSON, changeRequestReviewProjection, evaluateChangeFloor, evaluateRunbookFloor, runbookReviewProjection,
  type FeedbackCheck, type PhaseRubric,
} from '@learnsdlc/shared';
import { recordCriteriaOf, recordPathOf } from '../content/checks-validation';
import type { CodeChecks, ConfigChecks, PhaseChecks } from '../content/content.types';
import { floorPartial } from './floor-partial';

/**
 * A Deployment's runbook and a Maintenance's change request, graded beside
 * the phase's executable grading (spec section 6): each record criterion is
 * scored by `floorPartial`'s rule over the record's floor, and every floor
 * rule is a required check. The file rules, `build_smoke` and the four fixed
 * code keys are scored as they were.
 */
export interface RecordScores { scores: Map<string, number>; evidence: Map<string, string[]>; checks: FeedbackCheck[] }

/** The record criteria `keys`, each scored by the share of floor rules that pass, with one evidence line and one check per rule. */
export function recordFloorScores(rubric: PhaseRubric, keys: readonly string[], results: readonly { id: string; label: string; passed: boolean; detail: string }[]): RecordScores {
  const partial = floorPartial({ passThreshold: rubric.passThreshold, criteria: rubric.criteria.filter((c) => keys.includes(c.key)) }, results);
  return {
    scores: new Map(partial.criteria.map((c) => [c.key, c.score])),
    evidence: new Map(partial.criteria.map((c) => [c.key, c.evidence])),
    checks: partial.checks,
  };
}

/** The runbook floor over the learner's record, as the config report's record criteria. Null without a runbook. */
export function runbookFloorOf(checks: ConfigChecks, files: Record<string, string>, rubric: PhaseRubric): RecordScores | null {
  if (!checks.runbook) return null;
  return recordFloorScores(rubric, recordCriteriaOf(checks, rubric), evaluateRunbookFloor(files[RUNBOOK_JSON], checks.runbook.floor));
}

/** The change floor over the learner's change request, as the code report's record criteria. Null without one. */
export function changeFloorOf(checks: CodeChecks, files: Record<string, string>, rubric: PhaseRubric): RecordScores | null {
  if (!checks.change || !checks.ticket) return null;
  const results = evaluateChangeFloor(files[CHANGE_REQUEST_JSON], { contract: checks.change.contract, floor: checks.change.floor, ticket: checks.ticket });
  return recordFloorScores(rubric, recordCriteriaOf(checks, rubric), results);
}

/** What the reviewer reads of a phase with a record: its editable files without the record, and the record as labelled fields. Null otherwise. */
export function recordWorkspaceForReview(checks: PhaseChecks, snapshot: Record<string, string>, files: Record<string, string>): Record<string, string> | null {
  const record = recordPathOf(checks);
  if (!record) return null;
  const { [record]: _record, ...rest } = snapshot;
  const projection = checks.kind === 'code' && checks.change
    ? changeRequestReviewProjection(files[record], checks.change.contract)
    : runbookReviewProjection(files[record]);
  return { ...rest, ...projection };
}

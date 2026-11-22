import { storyFloorShown, type CriterionScore, type FeedbackCheck, type PhaseRubric } from '@learnsdlc/shared';

/** What a floor-graded kind (story, design) hands the report: the score, the criteria, one check per rule. */
export interface FloorPartial { overall: number; criteria: CriterionScore[]; checks: FeedbackCheck[] }

/** One floor rule's outcome, as both the story floor and the design floor report it. */
interface FloorResult { id: string; label: string; passed: boolean; detail: string }

/**
 * The scoring rule the story and design kinds share: one required check per
 * floor rule, and every rubric criterion scored `round(100 * passed / total)`
 * with one `✓ label` or `✗ label: detail` evidence line per rule. The
 * evidence lines are what the review shows, so they read a count of one in
 * the singular (`storyFloorShown`); the checks keep each rule's label
 * and detail byte for byte, because the reviewer model is sent those.
 */
export function floorPartial(rubric: PhaseRubric, results: readonly FloorResult[]): FloorPartial {
  const passed = results.filter((r) => r.passed).length;
  const score = Math.round((100 * passed) / results.length);
  const evidence = results.map((r) => storyFloorShown(r.passed ? `✓ ${r.label}` : `✗ ${r.label}: ${r.detail}`));
  return {
    overall: score,
    criteria: rubric.criteria.map((c) => ({ key: c.key, title: c.title, weight: c.weight, score, evidence: [...evidence] })),
    checks: results.map((r) => ({ id: r.id, label: r.label, status: r.passed ? 'passed' : 'failed', detail: r.detail })),
  };
}

import type { PhaseChecks } from '../content/content.types';
import type { PhaseDetail } from '@learnsdlc/shared';
export function phaseDetailStory(checks: PhaseChecks): PhaseDetail['story'] {
  if (checks.kind !== 'story') return undefined;
  return { id: checks.learnerStory.id, hints: { ...checks.learnerStory.hints }, floor: { ...checks.floor, requiredTags: [...checks.floor.requiredTags] }, providedStories: checks.providedStories.map(s => (s.criteria ? { ...s, criteria: s.criteria.map(c => ({ ...c })) } : { ...s })) };
}

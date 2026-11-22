import type { ProjectContent } from '../content/content.types';

/** A story id a prefix is read from: one to five capitals (a digit after the first allowed), a dash, digits. */
const STORY_ID = /^([A-Z][A-Z0-9]{0,4})-\d+$/;

/**
 * The prefixes a version's own stories use, for the Testing room's criterion
 * harvest (`PhaseDetail.storyPrefixes`): the ids of its Requirements phase's
 * provided stories, each cut at its dash (`SH-1` reads `SH`), in code-unit
 * order, `AC` never among them (a criterion's prefix). A version with no
 * Requirements phase, or none whose story check provides stories, reads
 * `['US']`, LearnSDLC's own numbering. Read from the version the learner is
 * served; grading never reads it.
 */
export function storyPrefixesOf(project: Pick<ProjectContent, 'phases'>): string[] {
  const requirements = project.phases.find((phase) => phase.key === 'requirements');
  const checks = requirements?.checks as { kind?: unknown; providedStories?: unknown } | undefined;
  const stories = checks?.kind === 'story' && Array.isArray(checks.providedStories) ? checks.providedStories : [];
  const prefixes = new Set<string>();
  for (const story of stories) {
    const id = story && typeof story === 'object' ? (story as { id?: unknown }).id : undefined;
    const found = typeof id === 'string' ? STORY_ID.exec(id) : null;
    if (found && found[1] !== 'AC') prefixes.add(found[1]);
  }
  return prefixes.size ? [...prefixes].sort() : ['US'];
}

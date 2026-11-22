import { In, type EntityManager } from 'typeorm';
import { seededStoryRecord } from '../content/content.service';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity } from '../content/project.entities';
import { LEGACY_OWN_STORY, storyChecksFromLegacyMarkdown } from '../content/story-legacy';
import { insertDocumentRow, phaseAndTasks, phaseWorkspace, type LegacyRequirementsOutcome } from './legacy-rows';
import { isOlderWritten } from '../content/older-written';

/**
 * One draft's Requirements phase, from the 2.x markdown kind to a story task,
 * written to its rows with the legacy adapter the upload door uses
 * (`storyChecksFromLegacyMarkdown`). Null when there is nothing to convert:
 * no Requirements phase, or no task grading the 2.x learner story.
 *
 * Drafts are converted where they are written, never on read, because the
 * rows are the source of truth an authoring write compiles from: the copy of
 * a published version (`createProject`), the next draft opened from one
 * (`createDraftVersion`), and once, for drafts stored before the story kind,
 * `AuthoringService.convertLegacyRequirementsDrafts` (or any sibling pass over
 * stored drafts, which converts every older phase of a draft it converts).
 * Each caller compiles
 * the draft afterwards, so its snapshot follows the rows.
 *
 * What moves is what the upload door's conversion moves: the task's checks
 * become the story checks and its artefact path goes (a story task's record
 * is JSON and reads none), the phase's kind becomes `story`, and the phase's
 * workspace files the adapter drops (the markdown story, the backlog and the
 * rule targets) leave the draft, and the seeded record the loader would mount
 * is mounted in their place. A refusal changes nothing and says why:
 * a second written task beside the story (a story phase holds one), or
 * whatever the adapter refused, in its words.
 */
export async function convertLegacyRequirementsRows(
  manager: EntityManager,
  versionId: string,
): Promise<LegacyRequirementsOutcome | null> {
  const scope = await phaseAndTasks(manager, versionId, 'requirements');
  if (!scope) return null;
  const { phase, tasks } = scope;
  const legacy = tasks.filter((task) => {
    // a stored row's checks, read as the older written kind they may still be
    const checks: unknown = task.checks;
    return isOlderWritten(checks) && checks.targets.includes(LEGACY_OWN_STORY);
  });
  if (legacy.length === 0) return null;
  const written = tasks.filter((task) => task.checks.kind !== 'quiz');
  if (legacy.length > 1 || written.length > 1) {
    return { converted: false, reason: 'the Requirements phase holds another written task beside the story, and a story phase cannot' };
  }
  const [task] = legacy;

  const { rows, files } = await phaseWorkspace(manager, versionId, phase.id);

  let converted: ReturnType<typeof storyChecksFromLegacyMarkdown>;
  try {
    converted = storyChecksFromLegacyMarkdown(files, task.checks);
  } catch (error) {
    return { converted: false, reason: (error as Error).message };
  }

  await manager.update(ProjectTaskEntity, { id: task.id }, { checks: converted.checks as ProjectTaskEntity['checks'], artefactPath: null });
  await manager.update(ProjectPhaseEntity, { id: phase.id }, { artifactKind: 'story' });
  const kept = new Set(converted.files.map((file) => file.path));
  const dropped = rows.filter((row) => !kept.has(row.path)).map((row) => row.id);
  if (dropped.length) await manager.delete(ProjectFileEntity, { id: In(dropped) });
  // The loader mounts a story phase's record, seeded, when the pack ships none;
  // the task owns it, and the compiler refuses a task graded on a path it does not own.
  const record = converted.checks.record;
  if (!kept.has(record)) await insertDocumentRow(manager, versionId, phase.id, record, seededStoryRecord(converted.checks));
  return { converted: true, note: converted.note };
}

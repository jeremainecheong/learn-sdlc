import { In, type EntityManager } from 'typeorm';
import { designDocumentPaths, type PhaseKey, type PhaseRubric, type RubricCriterion } from '@learnsdlc/shared';
import { seededDesignDocument } from '../content/content.service';
import type { ContentFileSpec, DesignChecks } from '../content/content.types';
import { designChecksFromLegacyMarkdown } from '../content/design-legacy';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity } from '../content/project.entities';
import { SettingEntity } from '../db/entities';
import { isInheritedTask, teacherWordedKeys } from './draft';
import { insertDocumentRow, phaseAndTasks, phaseWorkspace, writeBlob, type LegacyDesignOutcome } from './legacy-rows';
import { isOlderWritten } from '../content/older-written';

/**
 * Where a draft's Design conversion is kept for the builder to say: the
 * conversion removes every markdown file of the phase, a teacher's reference
 * documents among them, so the draft view names them rather than the log alone.
 */
export const designConversionKey = (versionId: string) => `design-conversion.${versionId}`;
export interface DesignConversionNote { note: string; removed: string[] }

/** The note a draft's Design conversion kept, or null. */
export async function designConversionOf(manager: EntityManager, versionId: string): Promise<DesignConversionNote | null> {
  const held = await manager.findOneBy(SettingEntity, { key: designConversionKey(versionId) });
  if (!held) return null;
  try {
    const parsed = JSON.parse(held.value) as Partial<DesignConversionNote>;
    return typeof parsed.note === 'string' && Array.isArray(parsed.removed) ? { note: parsed.note, removed: parsed.removed.filter((one) => typeof one === 'string') } : null;
  } catch {
    return null;
  }
}

/** The pack's criteria for the inherited Design task, as `AuthoringService.packCriteriaOf` reads them (null when unreadable). */
export type DesignPackCriteria = readonly RubricCriterion[] | null;

const SECOND_WRITTEN_TASK = 'the Design phase holds another written task beside the design, and a design phase cannot';

/** The one markdown task of a Design phase that holds no other written task: the task a conversion converts. */
function legacyDesignTask(tasks: readonly ProjectTaskEntity[]): ProjectTaskEntity | { refused: string } | null {
  const legacy = tasks.filter((task) => isOlderWritten(task.checks));
  if (legacy.length === 0) return null;
  const written = tasks.filter((task) => task.checks.kind !== 'quiz');
  return legacy.length > 1 || written.length > 1 ? { refused: SECOND_WRITTEN_TASK } : legacy[0];
}

/**
 * The criteria of a markdown Design task whose wording the teacher wrote
 * through the criteria door, told apart as every older-format conversion
 * tells them apart (`teacherWordedKeys`): against the wording its rules
 * derive and, on the inherited task, the pack's (`pack`; null keeps none). A
 * task the teacher added has no pack wording.
 */
function teacherWordingOf(task: ProjectTaskEntity, pack: DesignPackCriteria): Set<string> {
  // a stored row's checks, read as the older written kind they may still be
  const checks: unknown = task.checks;
  if (!isOlderWritten(checks)) return new Set();
  const was = {
    rules: checks.rules,
    minWords: checks.minWords,
    minWordsCriterion: checks.minWordsCriterion,
  };
  return teacherWordedKeys(task.rubric, was, isInheritedTask(task.taskKey) ? pack : []);
}

/**
 * One draft's Design phase, from the markdown kind to a design task, written
 * to its rows with the legacy adapter the upload door uses
 * (`designChecksFromLegacyMarkdown`, the adapter that turns an older
 * markdown Design phase into a design task). Null when there is nothing to convert: no Design phase, or no
 * markdown task in it (any markdown task of the Design phase is the design's).
 *
 * Drafts are converted where they are written, never on read, because the
 * rows are the source of truth an authoring write compiles from: the first
 * design save in the builder (`AuthoringService.updateTask`), and, beside the
 * Requirements conversion, a copy, the next draft opened from one, and the
 * one-time pass over drafts stored before the design kind
 * (`convertLegacyDesignDrafts`, run at boot, or any sibling pass over stored
 * drafts, which converts every older phase of a draft it converts). Each
 * caller compiles the draft
 * afterwards, so its snapshot follows the rows.
 *
 * Its tail mirrors `convertLegacyRequirementsRows` (update the task, the
 * phase's kind, drop the files the adapter left out, mount what it needs) and
 * differs because a design phase keeps rows the adapter rewrote (a folded
 * record, a contract made editable JSON) and mounts one row per switched-on
 * document, where a story phase mounts its one record. It also keeps a note
 * of what it removed for the builder (`designConversionKey`).
 *
 * What moves is what the adapter moves: the task's checks become the design
 * checks, its rubric the rubric whose descriptions are its rules' sentences
 * (behind the teacher's own wording, where they wrote one; `packCriteria`
 * reads the pack's, so the inherited task's can be told apart, and none is
 * kept without it), its artefact path goes (a design task writes JSON
 * documents and reads no prose) and its type is `design-doc`; the phase's
 * kind becomes `design`; the phase's markdown files leave the draft; a record the adapter folded or
 * replaced keeps its row with the new bytes; a contract mounted read-only or
 * in another language becomes editable JSON, as the adapter keeps it; and
 * each document the checks switch on that no row holds is mounted, seeded as
 * the loader seeds it. A refusal changes nothing and says why: a second
 * written task beside the design (a design phase holds one), or whatever the
 * adapter refused.
 */
export async function convertLegacyDesignRows(
  manager: EntityManager,
  versionId: string,
  packCriteria?: () => Promise<DesignPackCriteria>,
): Promise<LegacyDesignOutcome | null> {
  const scope = await phaseAndTasks(manager, versionId, 'design');
  if (!scope) return null;
  const { phase, tasks } = scope;
  const task = legacyDesignTask(tasks);
  if (!task) return null;
  if ('refused' in task) return { converted: false, reason: task.refused };

  const { rows, files } = await phaseWorkspace(manager, versionId, phase.id);
  let converted: ReturnType<typeof designChecksFromLegacyMarkdown>;
  try {
    const pack = isInheritedTask(task.taskKey) && packCriteria ? await packCriteria() : null;
    converted = designChecksFromLegacyMarkdown(files, task.checks, task.rubric, teacherWordingOf(task, pack));
  } catch (error) {
    return { converted: false, reason: (error as Error).message };
  }

  await manager.update(ProjectTaskEntity, { id: task.id }, {
    checks: converted.checks as ProjectTaskEntity['checks'],
    rubric: converted.rubric ?? task.rubric,
    artefactPath: null,
    artefactType: 'design-doc',
  });
  await manager.update(ProjectPhaseEntity, { id: phase.id }, { artifactKind: 'design' });
  const kept = new Map(converted.files.map((file) => [file.path, file]));
  const droppedRows = rows.filter((row) => !kept.has(row.path));
  const dropped = droppedRows.map((row) => row.id);
  if (dropped.length) await manager.delete(ProjectFileEntity, { id: In(dropped) });
  const conversion: DesignConversionNote = { note: converted.note, removed: droppedRows.map((row) => row.path).sort() };
  await manager.save(manager.create(SettingEntity, { key: designConversionKey(versionId), value: JSON.stringify(conversion) }));
  for (const row of rows) {
    const file = kept.get(row.path);
    const before = files.find((one) => one.path === row.path);
    // against the file as read (a row with no language reads as markdown), so a row the adapter kept as it was is not rewritten
    if (file && before && (file.content !== before.content || file.editable !== before.editable || file.language !== before.language)) {
      await manager.update(ProjectFileEntity, { id: row.id }, { blobSha: await writeBlob(manager, file.content), editable: file.editable, language: file.language });
    }
  }
  // The task owns every document its checks switch on, and the compiler
  // refuses a task graded on a path it does not own.
  for (const at of designDocumentPaths(converted.checks.contracts)) {
    if (!kept.has(at)) await insertDocumentRow(manager, versionId, phase.id, at, seededDesignDocument(at));
  }
  return { converted: true, note: converted.note };
}

/**
 * A Design task still in the older format, as its first design save would
 * convert it, for the editor's view: the checks and the rubric, read from the
 * phase's files and written nowhere. `pack` is the pack's criteria for the
 * inherited task, so the teacher's own wording shows as the save keeps it
 * (the builder saves the rubric it shows). Null for any other task, and for a
 * phase the conversion would refuse.
 */
export function olderDesignView(
  phaseKey: PhaseKey,
  row: ProjectTaskEntity,
  held: readonly ProjectTaskEntity[],
  files: ContentFileSpec[],
  pack: DesignPackCriteria = null,
): { checks: DesignChecks; rubric: PhaseRubric } | null {
  if (phaseKey !== 'design' || !isOlderWritten(row.checks)) return null;
  if (legacyDesignTask(held) !== row) return null;
  try {
    const converted = designChecksFromLegacyMarkdown(files, row.checks, row.rubric, teacherWordingOf(row, pack));
    return { checks: converted.checks, rubric: converted.rubric ?? row.rubric };
  } catch {
    return null;
  }
}

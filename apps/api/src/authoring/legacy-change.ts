import type { EntityManager } from 'typeorm';
import { CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, serialiseChangeRequest, type DraftTaskView, type PhaseKey, type PhaseRubric, type RubricCriterion } from '@learnsdlc/shared';
import { changeChecksFromLegacy } from '../content/change-legacy';
import type { CodeChecks, ContentFileSpec } from '../content/content.types';
import type { ProjectTaskEntity } from '../content/project.entities';
import { isInheritedTask, teacherWordedKeys } from './draft';
import { convertRecordRows, olderRecordOutput, type LegacyRowsOutcome, type RecordConversion, type RecordReference } from './legacy-rows';

/** TaskTrackr 4.0.0's Maintenance digests, computed once from the 4.0.0 tree before 5.0.0 replaced it: a copy whose digests equal these converts to 5.0.0's phase exactly. */
export const TASKTRACKR_400_MAINTENANCE = { executableDigestKey: 'maintenance|f9b438fdcb1132376abb8dd11bd54726a0848535cb2cbdad0a9f7f13f12fd356', applicationDigest: '31b925522733916b6b2e860e6081bbfc3297668ee3414ef15b0af9a2508cc05e' } as const;

/**
 * An older Maintenance (a code task with no ticket and no change request, a
 * `CHANGELOG.md` beside it) as `convertRecordRows` converts it, with the
 * adapter the upload door uses (`changeChecksFromLegacy`). The teacher's own
 * wording is told apart as `legacy-runbook.ts` tells it (a code task has no
 * rules), so the conversion names their wording when it cuts it.
 */
const CHANGE_CONVERSION: RecordConversion<CodeChecks> = {
  phaseKey: 'maintenance',
  phaseTitle: 'Maintenance',
  frozen: TASKTRACKR_400_MAINTENANCE,
  isOlder: (task) => task.checks.kind === 'code' && !(task.checks as CodeChecks).change,
  convert: changeChecksFromLegacy,
  teacherWording: (task, pack) =>
    teacherWordedKeys(task.rubric, { rules: [], minWords: undefined, minWordsCriterion: undefined }, isInheritedTask(task.taskKey) ? pack : []),
  record: CHANGE_REQUEST_JSON,
  emptyRecord: serialiseChangeRequest(EMPTY_CHANGE_REQUEST),
  beside: 'A second work task sits beside the older Maintenance task, and a Maintenance phase with a change request holds one.',
};

/**
 * The Maintenance task `taskId` of one draft converted to a Maintenance with
 * a ticket and a change request, written to its rows (`convertRecordRows`).
 * The builder's first ticket, change or rubric save names its task; a caller
 * with no task being saved names none, and the phase's one older task is
 * converted.
 *
 * `reference` is the copy's, the next draft's and the stored-draft pass's: a
 * copied Maintenance that is TaskTrackr 4.0.0's Maintenance (its two frozen digests) converts
 * to the reference's current Maintenance exactly (`convertRecordRows`).
 */
export function convertLegacyChangeRows(
  manager: EntityManager,
  versionId: string,
  packCriteria?: () => Promise<readonly RubricCriterion[] | null>,
  taskId?: string,
  reference?: () => Promise<RecordReference | null>,
): Promise<LegacyRowsOutcome | null> {
  return convertRecordRows(manager, versionId, CHANGE_CONVERSION, taskId, packCriteria, reference);
}

/**
 * A Maintenance task still in the older format, as its first ticket, change
 * or rubric save would convert it, for the builder's view: the ticket, the
 * contract switch, the floor and the rubric, or the sentence the conversion
 * would refuse with. Null for any other task.
 */
export function olderChangeView(
  phaseKey: PhaseKey,
  row: ProjectTaskEntity,
  held: readonly ProjectTaskEntity[],
  files: ContentFileSpec[],
  phase: { title: string; intro: string },
  pack: readonly RubricCriterion[] | null,
): { view: NonNullable<DraftTaskView['change']>; rubric: PhaseRubric } | { refused: string } | null {
  const out = olderRecordOutput(CHANGE_CONVERSION, phaseKey, row, held, files, phase, pack);
  if (!out || 'refused' in out) return out;
  return { view: { ticket: out.checks.ticket!, contract: out.checks.change!.contract, floor: out.checks.change!.floor }, rubric: out.rubric ?? row.rubric };
}

import type { EntityManager } from 'typeorm';
import { EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseRunbook, type DraftTaskView, type PhaseKey, type PhaseRubric, type RubricCriterion } from '@learnsdlc/shared';
import type { ConfigChecks, ContentFileSpec } from '../content/content.types';
import type { ProjectTaskEntity } from '../content/project.entities';
import { runbookChecksFromLegacy } from '../content/runbook-legacy';
import { isInheritedTask, teacherWordedKeys } from './draft';
import { convertRecordRows, olderRecordOutput, type LegacyRowsOutcome, type RecordConversion, type RecordReference } from './legacy-rows';

/** TaskTrackr 4.0.0's Deployment digests, computed once from the 4.0.0 tree before 5.0.0 replaced it: a copy whose digests equal these converts to 5.0.0's phase exactly. */
export const TASKTRACKR_400_DEPLOYMENT = { executableDigestKey: 'deployment|564fa8baa17b0871f2ce1b2b3a0b5b919eb36793ebe80701cbfbe0187ce73ab7', applicationDigest: '1f512f4811e34c5a2b7697d881da0ccd8b15f314d66226c0ced1f52123a5e4a0' } as const;

/**
 * An older Deployment (a config task grading `RUNBOOK.md` with rules) as
 * `convertRecordRows` converts it, with the adapter the upload door uses
 * (`runbookChecksFromLegacy`). The teacher's own wording is told apart as
 * `legacy-design.ts`'s `teacherWordingOf` tells it: against the wording the
 * task's rules derive and, on the inherited task, the pack's (null keeps
 * none); a task the teacher added has no pack wording.
 */
const RUNBOOK_CONVERSION: RecordConversion<ConfigChecks> = {
  phaseKey: 'deployment',
  phaseTitle: 'Deployment',
  frozen: TASKTRACKR_400_DEPLOYMENT,
  isOlder: (task) => task.checks.kind === 'config' && !(task.checks as ConfigChecks).runbook,
  convert: runbookChecksFromLegacy,
  teacherWording: (task, pack) =>
    teacherWordedKeys(task.rubric, { rules: (task.checks as ConfigChecks).rules, minWords: undefined, minWordsCriterion: undefined }, isInheritedTask(task.taskKey) ? pack : []),
  record: RUNBOOK_JSON,
  emptyRecord: serialiseRunbook(EMPTY_RUNBOOK),
  beside: 'A second work task sits beside the older Deployment task, and a Deployment phase with a runbook holds one.',
};

/**
 * The Deployment task `taskId` of one draft converted to a Deployment with a
 * runbook, written to its rows (`convertRecordRows`). The builder's first
 * runbook or rubric save names its task and compiles the draft afterwards;
 * a caller with no task being saved names none, and the phase's one older
 * task is converted.
 *
 * `reference` is the copy's, the next draft's and the stored-draft pass's: a
 * copied Deployment that is TaskTrackr 4.0.0's Deployment (its two frozen digests) converts
 * to the reference's current Deployment exactly (`convertRecordRows`).
 */
export function convertLegacyRunbookRows(
  manager: EntityManager,
  versionId: string,
  packCriteria?: () => Promise<readonly RubricCriterion[] | null>,
  taskId?: string,
  reference?: () => Promise<RecordReference | null>,
): Promise<LegacyRowsOutcome | null> {
  return convertRecordRows(manager, versionId, RUNBOOK_CONVERSION, taskId, packCriteria, reference);
}

/**
 * A Deployment task still in the older format, as its first runbook save
 * would convert it, for the builder's view: the runbook checks, the rubric
 * and the converted checks (for the Files-and-checks card), or the sentence
 * the conversion would refuse with. `pack` is the pack's criteria for the
 * inherited task, so the teacher's own wording shows as the save keeps it.
 * Null for any other task.
 */
export function olderRunbookView(
  phaseKey: PhaseKey,
  row: ProjectTaskEntity,
  held: readonly ProjectTaskEntity[],
  files: ContentFileSpec[],
  phase: { title: string; intro: string },
  pack: readonly RubricCriterion[] | null,
): { view: NonNullable<DraftTaskView['runbook']>; rubric: PhaseRubric; checks: ConfigChecks } | { refused: string } | null {
  const out = olderRecordOutput(RUNBOOK_CONVERSION, phaseKey, row, held, files, phase, pack);
  if (!out || 'refused' in out) return out;
  return { view: { ...out.checks.runbook!, drill: !!out.checks.drill }, rubric: out.rubric ?? row.rubric, checks: out.checks };
}

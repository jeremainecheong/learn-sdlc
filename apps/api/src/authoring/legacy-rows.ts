import { In, type EntityManager } from 'typeorm';
import type { PhaseKey, RubricCriterion } from '@learnsdlc/shared';
import { blobShaFor } from '../content/blob.store';
import type { ContentFileSpec, PhaseChecks, PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { ContentBlobEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import type { LegacyPhaseInput, LegacyPhaseOutput } from '../content/record-legacy';
import { applicationDigest } from '../content/reference-content';
import { isInheritedTask } from './draft';
import { executableDigestKey } from './provenance';

/**
 * The row scaffold the draft conversions share (`legacy-requirements.ts`,
 * `legacy-design.ts`, `legacy-runbook.ts`, `legacy-change.ts`): the outcome they answer, one phase's rows read as a
 * pack's files, and the raw blob and row writes a conversion makes. They
 * write rows directly, as a migration would, because a conversion runs
 * inside the doors that would otherwise ask (the copy, the next draft, the
 * first structured save) and only ever writes JSON documents no byte rule
 * concerns.
 */

/**
 * What converting one draft phase's rows came to: converted, with the note
 * that says what moved, or refused, with the reason, and nothing written.
 */
export type LegacyRowsOutcome = { converted: true; note: string } | { converted: false; reason: string };

/** What converting one draft's Requirements rows came to. */
export type LegacyRequirementsOutcome = LegacyRowsOutcome;

/** What converting one draft's Design rows came to. */
export type LegacyDesignOutcome = LegacyRowsOutcome;

/** One draft phase and its tasks, or null when the version has no phase of that key. */
export async function phaseAndTasks(
  manager: EntityManager,
  versionId: string,
  key: PhaseKey,
): Promise<{ phase: ProjectPhaseEntity; tasks: ProjectTaskEntity[] } | null> {
  const phase = await manager.findOne(ProjectPhaseEntity, { where: { projectVersionId: versionId, key } });
  if (!phase) return null;
  return { phase, tasks: await manager.find(ProjectTaskEntity, { where: { projectPhaseId: phase.id } }) };
}

/** A phase's workspace rows, and the files they mount with their bytes, as a legacy adapter reads them. */
export async function phaseWorkspace(
  manager: EntityManager,
  versionId: string,
  phaseId: string,
): Promise<{ rows: ProjectFileEntity[]; files: ContentFileSpec[] }> {
  const rows = await manager.find(ProjectFileEntity, {
    where: { projectVersionId: versionId, ownerKind: 'phase', ownerId: phaseId, role: 'workspace' },
  });
  const shas = [...new Set(rows.map((row) => row.blobSha))];
  const blobs = shas.length ? await manager.find(ContentBlobEntity, { where: { sha: In(shas) } }) : [];
  const bytes = new Map(blobs.map((blob) => [blob.sha, blob.bytes]));
  const files: ContentFileSpec[] = rows.map((row) => ({
    path: row.path,
    content: bytes.get(row.blobSha) ?? '',
    editable: row.editable,
    language: row.language ?? 'markdown',
  }));
  return { rows, files };
}

/** Bytes stored as a content blob (shared, so one already there is kept), answering its sha. */
export async function writeBlob(manager: EntityManager, bytes: string): Promise<string> {
  const sha = blobShaFor(bytes);
  await manager
    .createQueryBuilder()
    .insert()
    .into(ContentBlobEntity)
    .values({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') })
    .orIgnore()
    .execute();
  return sha;
}

/** One editable JSON workspace row of a phase, the record or document a structured task owns. */
export async function insertDocumentRow(
  manager: EntityManager,
  versionId: string,
  phaseId: string,
  path: string,
  bytes: string,
): Promise<void> {
  await manager.insert(ProjectFileEntity, {
    projectVersionId: versionId,
    ownerKind: 'phase',
    ownerId: phaseId,
    path,
    role: 'workspace',
    editable: true,
    language: 'json',
    blobSha: await writeBlob(manager, bytes),
  });
}

/**
 * One older Deployment or Maintenance conversion, as `convertRecordRows` and
 * `olderRecordOutput` run it: the phase, which task is still older, the
 * adapter the upload door uses, the criteria whose wording the teacher wrote
 * (one reading for the save and the view), the record row it mounts (the
 * empty record when the phase mounted no markdown file), and the reason it
 * refuses a phase holding another work task beside the older one.
 */
export interface RecordConversion<C extends PhaseChecks> {
  phaseKey: 'deployment' | 'maintenance';
  /** The phase's title as a note names it. */
  phaseTitle: 'Deployment' | 'Maintenance';
  /** The reference project's own older phase, by its two digests: a copy of it converts to the reference's current phase exactly. */
  frozen: { executableDigestKey: string; applicationDigest: string };
  isOlder: (task: ProjectTaskEntity) => boolean;
  convert: (input: LegacyPhaseInput) => LegacyPhaseOutput<C>;
  teacherWording: (task: ProjectTaskEntity, pack: readonly RubricCriterion[] | null) => Set<string>;
  record: string;
  emptyRecord: string;
  beside: string;
}

/**
 * `row` when it is still older and the phase's one work task (Design's
 * one-task guard), a refusal when another work task sits beside it, null
 * when it is not older.
 */
function olderTaskOf<C extends PhaseChecks>(conversion: RecordConversion<C>, held: readonly ProjectTaskEntity[], row: ProjectTaskEntity): ProjectTaskEntity | { refused: string } | null {
  if (!conversion.isOlder(row)) return null;
  const work = held.filter((one) => one.checks.kind !== 'quiz');
  return work.length === 1 && work[0].id === row.id ? row : { refused: conversion.beside };
}

/**
 * What the exact conversion of a copied reference phase reads, each
 * read only once an older task is found: the phase the draft compiles to before
 * the conversion (null when it does not compile), and the reference project's
 * current phase with its one work task and the name the note gives it (null
 * when the reference's published snapshot holds no structured phase of that
 * key, or is missing).
 */
export interface RecordReference {
  draft: PhaseContent | null;
  current: { phase: PhaseContent; task: CompiledTask; name: string } | null;
}

/**
 * The sentence a copy of the reference's own older phase adds to the generic
 * conversion's note when the reference's current phase cannot be read, so the
 * fallback is never silent.
 */
export const referenceMissingNote = (phaseTitle: string): string =>
  `The reference's current ${phaseTitle} could not be read as a structured phase with one work task, so this copy of its older ${phaseTitle} was converted the generic way.`;

/** Whether the phase the draft compiles to is the reference's own older phase, by the conversion's two frozen digests. */
function isFrozenReference<C extends PhaseChecks>(conversion: RecordConversion<C>, draft: PhaseContent | null): boolean {
  return !!draft && executableDigestKey(draft) === conversion.frozen.executableDigestKey && applicationDigest(draft) === conversion.frozen.applicationDigest;
}

/**
 * The older task of a copied reference phase written as the reference's
 * current phase exactly: the task's checks, rubric, brief, objectives and
 * artefact, the phase's mentor, and its files (a row left over is dropped,
 * a missing one mounted, one whose bytes or mount differ rewritten), so the
 * copy stays the reference's application. The rows written are the phase's
 * own workspace rows, the task row and the phase row; the draft's stored
 * snapshot, which the next compile reads as what the copy brought, takes the
 * reference's phase too, so the files keep the reference's order and an
 * application file's bytes are read from the rows just written. The task's
 * title is the row's own: no digest reads it, so a teacher's rename of the
 * older task still matches the frozen digests and is kept.
 */
async function convertToReference(
  manager: EntityManager,
  versionId: string,
  phaseId: string,
  task: ProjectTaskEntity,
  rows: readonly ProjectFileEntity[],
  current: NonNullable<RecordReference['current']>,
): Promise<void> {
  const { phase, task: reference } = current;
  await manager.update(ProjectTaskEntity, { id: task.id }, {
    checks: phase.checks as ProjectTaskEntity['checks'],
    rubric: phase.rubric,
    brief: phase.taskPanel,
    objectives: phase.objectives,
    artefactType: reference.artefactType,
    artefactPath: reference.artefactPath,
  });
  await manager.update(ProjectPhaseEntity, { id: phaseId }, { assistant: phase.assistant });
  const wanted = new Set(phase.files.map((file) => file.path));
  const dropped = rows.filter((row) => !wanted.has(row.path)).map((row) => row.id);
  if (dropped.length) await manager.delete(ProjectFileEntity, { id: In(dropped) });
  for (const file of phase.files) {
    const row = rows.find((one) => one.path === file.path);
    const sha = blobShaFor(file.content);
    if (row && row.blobSha === sha && row.editable === file.editable && (row.language ?? '') === (file.language ?? '')) continue;
    const blobSha = await writeBlob(manager, file.content);
    if (row) await manager.update(ProjectFileEntity, { id: row.id }, { blobSha, editable: file.editable, language: file.language });
    else {
      await manager.insert(ProjectFileEntity, {
        projectVersionId: versionId, ownerKind: 'phase', ownerId: phaseId, path: file.path, role: 'workspace', editable: file.editable, language: file.language, blobSha,
      });
    }
  }
  const version = await manager.findOneByOrFail(ProjectVersionEntity, { id: versionId });
  if (version.compiled) {
    const { files, checks, rubric, taskPanel, objectives } = phase;
    const phases = version.compiled.content.phases.map((one) => (one.key === phase.key ? { ...one, files, checks, rubric, taskPanel, objectives } : one));
    await manager.update(ProjectVersionEntity, { id: versionId }, { compiled: { ...version.compiled, content: { ...version.compiled.content, phases } } });
  }
}

const inputOf = (task: ProjectTaskEntity, phase: { title: string; intro: string }, files: ContentFileSpec[], teacherWorded: Set<string>): LegacyPhaseInput => ({
  files, checks: task.checks, rubric: task.rubric, title: phase.title, intro: phase.intro, taskPanel: task.brief, objectives: task.objectives, teacherWorded,
});

/**
 * The task `taskId` of one draft's older Deployment or Maintenance converted
 * to its record and written to its rows, as `convertLegacyDesignRows`
 * converts a Design: the task's checks and rubric move, the rows the adapter
 * left out (the markdown file) leave the draft, the task's artefact path goes
 * when it named one of them, and the record row is mounted with the starting
 * record the file became. With no `taskId` (the copy, the next draft and a
 * stored draft have no task being saved) the phase's older task is the one,
 * under the same one-task guard, so two older
 * work tasks are refused. Null when that task is not older (or the phase is
 * missing). `packCriteria` reads the pack's criteria for the inherited task,
 * so the teacher's own wording is told apart. A refusal writes nothing and
 * says why.
 *
 * `reference` is the copy's question: when the phase the draft
 * compiles to carries the reference's frozen older digests and the reference
 * holds its current structured phase, the task converts to that phase exactly
 * (`convertToReference`) in place of the generic conversion.
 */
export async function convertRecordRows<C extends PhaseChecks>(
  manager: EntityManager,
  versionId: string,
  conversion: RecordConversion<C>,
  taskId?: string,
  packCriteria?: () => Promise<readonly RubricCriterion[] | null>,
  reference?: () => Promise<RecordReference | null>,
): Promise<LegacyRowsOutcome | null> {
  const scope = await phaseAndTasks(manager, versionId, conversion.phaseKey);
  const saved = scope?.tasks.find((one) => (taskId === undefined ? conversion.isOlder(one) : one.id === taskId));
  if (!scope || !saved) return null;
  const task = olderTaskOf(conversion, scope.tasks, saved);
  if (!task) return null;
  if ('refused' in task) return { converted: false, reason: task.refused };
  const { rows, files } = await phaseWorkspace(manager, versionId, scope.phase.id);
  const exact = reference ? await reference() : null;
  const frozen = !!exact && isFrozenReference(conversion, exact.draft);
  if (frozen && exact?.current) {
    await convertToReference(manager, versionId, scope.phase.id, task, rows, exact.current);
    return { converted: true, note: `${conversion.phaseTitle} converted to ${exact.current.name}'s.` };
  }
  let out: LegacyPhaseOutput<C>;
  try {
    const pack = isInheritedTask(task.taskKey) && packCriteria ? await packCriteria() : null;
    out = conversion.convert(inputOf(task, scope.phase, files, conversion.teacherWording(task, pack)));
  } catch (error) {
    return { converted: false, reason: (error as Error).message };
  }
  const kept = new Set(out.files.map((f) => f.path));
  const left = rows.filter((row) => !kept.has(row.path));
  // The task's artefact path goes with the markdown file it named, as the Requirements and Design
  // conversions clear theirs: the record is JSON and reads none, and the compiler refuses a task
  // declaring a path it does not own. A path naming a row the conversion keeps stays the task's.
  const named = task.artefactPath !== null && left.some((row) => row.path === task.artefactPath);
  await manager.update(ProjectTaskEntity, { id: task.id }, {
    checks: out.checks as ProjectTaskEntity['checks'],
    rubric: out.rubric ?? task.rubric,
    ...(named ? { artefactPath: null } : {}),
  });
  if (left.length) await manager.delete(ProjectFileEntity, { id: In(left.map((row) => row.id)) });
  const record = out.files.find((f) => f.path === conversion.record);
  if (!rows.some((row) => row.path === conversion.record)) {
    await insertDocumentRow(manager, versionId, scope.phase.id, conversion.record, record?.content ?? conversion.emptyRecord);
  }
  return { converted: true, note: frozen ? `${out.note} ${referenceMissingNote(conversion.phaseTitle)}` : out.note };
}

/**
 * What the first save would convert `row` to, for the builder's view, read
 * from the phase's files and written nowhere; or the sentence that save
 * would refuse with. Null when `row` is not the phase's older task.
 */
export function olderRecordOutput<C extends PhaseChecks>(
  conversion: RecordConversion<C>,
  phaseKey: PhaseKey,
  row: ProjectTaskEntity,
  held: readonly ProjectTaskEntity[],
  files: ContentFileSpec[],
  phase: { title: string; intro: string },
  pack: readonly RubricCriterion[] | null,
): LegacyPhaseOutput<C> | { refused: string } | null {
  if (phaseKey !== conversion.phaseKey) return null;
  const task = olderTaskOf(conversion, held, row);
  if (!task || 'refused' in task) return task;
  try {
    return conversion.convert(inputOf(task, phase, files, conversion.teacherWording(task, pack)));
  } catch (error) {
    return { refused: (error as Error).message };
  }
}

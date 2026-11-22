import type { DataSource } from 'typeorm';
import { INHERITED_TASK_KEY, type ArtefactType, type PhaseKey } from '@learnsdlc/shared';
import { ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../src/content/project.entities';

/**
 * A draft's phase task said to hand in `artefactType`, in its task row and its
 * stored snapshot, as an older editor save could leave it. No editor save moves
 * a story task's type any more (it authors a user story, a design or a quiz),
 * so the export's refusal of an edit its archive cannot carry ("what it hands
 * in") is reached through the stored edit.
 */
export async function storeTaskTypeEdit(dataSource: DataSource, versionId: string, phaseKey: PhaseKey, artefactType: ArtefactType): Promise<void> {
  const phase = await dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: phaseKey });
  await dataSource.getRepository(ProjectTaskEntity).update({ projectPhaseId: phase.id, taskKey: INHERITED_TASK_KEY }, { artefactType });
  const versions = dataSource.getRepository(ProjectVersionEntity);
  const compiled = JSON.parse(JSON.stringify((await versions.findOneByOrFail({ id: versionId })).compiled));
  compiled.phases.find((one: { key: string }) => one.key === phaseKey).tasks[0].artefactType = artefactType;
  await versions.update({ id: versionId }, { compiled });
}

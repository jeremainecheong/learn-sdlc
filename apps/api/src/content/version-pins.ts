import { EntityManager, IsNull } from 'typeorm';
import { EnrollmentEntity, PhaseStateEntity } from '../db/entities';
import { ProjectPhaseEntity, ProjectVersionEntity } from './project.entities';

/*
 * The publish side of the null pin (`seed/null-pin.ts`): an enrolment stored
 * with a null `projectVersionId` whose project has no published version yet is
 * pinned at that project's first publish. The publish door
 * (`AuthoringService`) and the importer ask `hasStoredHead` before they
 * publish and, when there was none, call `pinNullRowsAtFirstPublish` inside
 * their own transaction.
 */

/** A project has a stored head: a published version row with a compiled snapshot, as the null-pin pass's `headsAsStored` asks. */
export async function hasStoredHead(manager: EntityManager, projectId: string): Promise<boolean> {
  const count = await manager
    .getRepository(ProjectVersionEntity)
    .createQueryBuilder('v')
    .where('v.projectId = :projectId', { projectId })
    .andWhere('v.status = :status', { status: 'published' })
    .andWhere('v.compiled IS NOT NULL')
    .getCount();
  return count > 0;
}

/** The version's phases by key, with each one's order: from its compiled snapshot, else from its phase rows. */
async function phaseOrdersOf(manager: EntityManager, versionId: string): Promise<Map<string, number>> {
  const version = await manager.findOne(ProjectVersionEntity, { where: { id: versionId }, select: { id: true, compiled: true } });
  const compiled = version?.compiled?.content?.phases;
  if (Array.isArray(compiled)) return new Map(compiled.map((phase) => [phase.key as string, phase.order]));
  const rows = await manager.find(ProjectPhaseEntity, { where: { projectVersionId: versionId }, select: { id: true, key: true, order: true } });
  return new Map(rows.map((phase) => [phase.key as string, phase.order]));
}

/**
 * The publish door's and the importer's pin: the project's null rows, to the version being published.
 *
 * The caller asks `hasStoredHead` before it publishes and calls this only when
 * the project had none, inside its own transaction, so a null row there
 * resolved nothing until this publish and resolves this version from now on.
 * Only `{ projectSlug, projectVersionId: null }` rows are written.
 *
 * A row whose states hold a key this version lacks, or whose states' orders
 * disagree with this version's orders by key, is pinned all the same, its
 * states kept untouched, and counted `pinnedPhaseMismatch`: left null it
 * would follow every later head, a move between versions whose phases
 * differ, which no path may make. The
 * board draws only the version's phases for it (`enrollmentView`).
 */
export async function pinNullRowsAtFirstPublish(
  manager: EntityManager,
  projectSlug: string,
  versionId: string,
): Promise<{ pinned: number; pinnedPhaseMismatch: number }> {
  const rows = await manager.find(EnrollmentEntity, { where: { projectSlug, projectVersionId: IsNull() }, select: { id: true } });
  if (!rows.length) return { pinned: 0, pinnedPhaseMismatch: 0 };
  const orders = await phaseOrdersOf(manager, versionId);
  let pinned = 0;
  let pinnedPhaseMismatch = 0;
  for (const row of rows) {
    const states = await manager.find(PhaseStateEntity, { where: { enrollmentId: row.id }, select: { id: true, phaseKey: true, phaseOrder: true } });
    const mismatch = states.some((state) => orders.get(state.phaseKey) !== state.phaseOrder);
    // Guarded as the pass is: a row another writer pinned in between keeps that pin and is not counted.
    const { affected } = await manager.update(EnrollmentEntity, { id: row.id, projectVersionId: IsNull() }, { projectVersionId: versionId });
    if (!affected) continue;
    pinned += 1;
    if (mismatch) pinnedPhaseMismatch += 1;
  }
  return { pinned, pinnedPhaseMismatch };
}

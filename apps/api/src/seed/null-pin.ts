import { EntityManager, IsNull } from 'typeorm';
import { compareProjectVersions } from '@learnsdlc/shared';
import { EnrollmentEntity } from '../db/entities';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';

/**
 * The null pin: an enrolment stored with a null `projectVersionId`, which
 * resolves its project's published head (`db/entities.ts`, the pin's column).
 * A null that follows the head would move its learner onto every later
 * version, whatever phases it holds, so it is pinned to the version it reads
 * before any later head can be published, and a null with no head
 * to read is pinned at its project's first publish.
 *
 * Five paths write an enrolment's version, and no other does: the
 * enrolment's creation (`WorkflowService.writeEnrollment`, from the class's
 * assignment or the head); this pass (first in the seed's bootstrap, before
 * the import, writing only a null pin); the re-pin (`StoryRepinService`, its
 * `toMove` update, last in the bootstrap); the first publish of a project,
 * through the publish door or the importer
 * (`pinNullRowsAtFirstPublish`, `content/version-pins.ts`); and the portability import
 * (`PortabilityService`), which pins only the enrolments it
 * creates and writes no null pin.
 *
 * Neither this pass nor the first-publish pin writes an audit row for the row it pins or touches its
 * `packVersion`: no learner moves, since each row is pinned to the
 * version it already resolved or, with no head, to the first version it will
 * resolve. The pass's record is its receipt (`null-pin.service.ts`); the
 * publish door's is the count on its own `project.publish` audit row.
 */

/** The settings row that keeps the pass's counts (`NullPinService`). */
export const NULL_PIN_RECEIPT_KEY = 'null-pin.receipt';

/** One run of the pass: rows pinned and rows left, each with the number of projects they are in. */
export interface NullPinResult {
  pinnedFromNull: number;
  pinnedProjects: number;
  unpinnedNoHead: number;
  unpinnedProjects: number;
}

/**
 * Each project's newest published version that holds a compiled snapshot and names a project row, by project slug.
 *
 * The same three conditions the registry installs a version under
 * (`project-registry.service.ts`, `publishedVersions`), ordered by
 * `compareProjectVersions` as the content service orders a project's
 * versions, so the head is the version a null pin resolved until this read.
 * A published row with no snapshot is skipped, which is what its null
 * resolved past.
 */
export async function headsAsStored(manager: EntityManager): Promise<Map<string, { id: string; version: string }>> {
  const projects = await manager.find(ProjectEntity, { select: { id: true, slug: true } });
  const slugOf = new Map(projects.map((one) => [one.id, one.slug]));
  const rows = await manager
    .getRepository(ProjectVersionEntity)
    .createQueryBuilder('v')
    .select(['v.id', 'v.projectId', 'v.version'])
    .where('v.status = :status', { status: 'published' })
    .andWhere('v.compiled IS NOT NULL')
    .getMany();
  const heads = new Map<string, { id: string; version: string }>();
  for (const row of rows) {
    const slug = slugOf.get(row.projectId);
    if (!slug) continue;
    const held = heads.get(slug);
    if (!held || compareProjectVersions(row.version, held.version) > 0) heads.set(slug, { id: row.id, version: row.version });
  }
  return heads;
}

/**
 * The pass: every null-pinned enrolment pinned to its project's stored head, or left and counted.
 *
 * A row whose project has no stored head, or whose slug names no project row,
 * stays null and is counted `unpinnedNoHead`: a null with no head resolves
 * nothing, so no learner moves, and the project's first publish pins it.
 * Each update is guarded on the pin still being null, so a row another
 * writer pinned in between keeps that pin and is counted in neither count.
 */
export async function pinNullRows(manager: EntityManager): Promise<NullPinResult> {
  const heads = await headsAsStored(manager);
  const rows = await manager.find(EnrollmentEntity, { where: { projectVersionId: IsNull() }, select: { id: true, projectSlug: true } });
  const pinned = new Set<string>();
  const left = new Set<string>();
  let pinnedFromNull = 0;
  let unpinnedNoHead = 0;
  for (const row of rows) {
    const head = heads.get(row.projectSlug);
    if (!head) {
      unpinnedNoHead += 1;
      left.add(row.projectSlug);
      continue;
    }
    // Only the pin: no audit row and packVersion as stored. The version is the one the row read until this boot.
    const { affected } = await manager.update(EnrollmentEntity, { id: row.id, projectVersionId: IsNull() }, { projectVersionId: head.id });
    if (!affected) continue;
    pinnedFromNull += 1;
    pinned.add(row.projectSlug);
  }
  return { pinnedFromNull, pinnedProjects: pinned.size, unpinnedNoHead, unpinnedProjects: left.size };
}

/** The pass's boot line, with one run's counts. */
export function nullPinLine(result: NullPinResult): string {
  return (
    `null pin: pinned ${result.pinnedFromNull} enrolment(s) in ${result.pinnedProjects} project(s) to the published version they read with no pin; ` +
    `left ${result.unpinnedNoHead} in ${result.unpinnedProjects} project(s) with no published version, to be pinned at their project's first publish`
  );
}

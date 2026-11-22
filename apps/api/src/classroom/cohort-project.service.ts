import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type {
  AssignProjectBody,
  AssignableVersionView,
  CohortProjectAssignmentView,
  CohortProjectView,
  PhaseKey,
  ProjectVersionStatus,
  VersionProvenanceView,
} from '@learnsdlc/shared';
import {
  ASSIGNMENT_REASON_MIN,
  CHANGE_OLDER_FORMAT_ASSIGN_REFUSAL,
  DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL,
  REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL,
  RUNBOOK_OLDER_FORMAT_ASSIGN_REFUSAL,
  retiredWrittenPhaseAssignRefusal,
  compareProjectVersions,
} from '@learnsdlc/shared';
import { atomic } from '../db/atomic';
import { isUniqueViolation } from '../db/unique-violation';
import {
  CohortEntity,
  CohortProjectAssignmentEntity,
  ProjectEntity,
  ProjectPhaseEntity,
  ProjectVersionEntity,
  UserEntity,
} from '../db/entities';
import { type AuditRow, recordAudit } from '../audit/audit';
import { type InstructorCaller, UNATTACHED_COHORT } from '../instructor/cohort-scope';
import { ContentService } from '../content/content.service';
import { projectProvenance, referenceNameFrom } from '../authoring/provenance';
import { olderFormatPhase, retiredWrittenPhase, type OlderFormatKey } from '../content/phase-grading';
import { UUID_PATTERN } from '../db/uuid';
import { normalisedIso } from '../db/timestamps';

/**
 * The one state inside `UQ_cohort_project_assignment_active`, and the one a
 * superseded row is moved to.
 *
 * `state varchar` rather than `active boolean` is the entity's own decision and
 * not a workaround: TypeORM's `@Index` carries one `where` string for both
 * dialects, so `active = true` / `active = 1` is not expressible, and
 * `WHERE state = 'active'` is the shape the codebase's other partial unique
 * indexes already vouch for. These two constants are what keep the write and
 * the index reading the same word.
 */
export const ASSIGNMENT_ACTIVE = 'active';
export const ASSIGNMENT_SUPERSEDED = 'superseded';

/**
 * A class the caller cannot reach, whether it is somebody else's or is not
 * there at all.
 *
 * A 404 rather than a 403, by the written policy at `cohort-scope.ts`: guessing
 * ids must tell a second teacher nothing about which classes exist on this
 * deployment.
 */
export const NOT_YOUR_CLASS = 'no class with that id in your classes';

/** A version that is not the caller's to give out, whoever else may hold it. */
export const NO_SUCH_VERSION =
  'no project version with that id you can put a class on';

/** Why a draft or an archived version cannot be what a class works. */
export function unpublishedVersionRefusal(
  title: string,
  version: string,
  status: ProjectVersionStatus,
): string {
  return status === 'archived'
    ? `${title} ${version} is archived, and a class works a published version. Publish a newer version and assign that.`
    : `${title} ${version} is a draft, and a class works a published version. Publish it, then assign it.`;
}

/**
 * A published row with no compiled snapshot. The registry skips it by name, so
 * a class put on it would silently resolve the project's newest version instead
 * of the one it was given, which is the opposite of what an assignment is for.
 */
export function noCompiledSnapshotRefusal(title: string, version: string): string {
  return `${title} ${version} was published without a compiled snapshot, so there is nothing for a learner to open. Publish it again, then assign it.`;
}

/** The ten characters every instructor override already asks for. */
export const ASSIGNMENT_REASON_MESSAGE =
  `give a reason of at least ${ASSIGNMENT_REASON_MIN} characters — it is recorded with the assignment`;

/** Two teachers pressed Assign on one class, and the database settled it. */
export const ASSIGNMENT_RACE =
  'this class was put on another project a moment ago. Read the class panel again and assign from what it says now.';

/**
 * The audit event this service writes, and the event name of its two log
 * lines. The column is a varchar on both dialects and `recordAudit` writes it
 * straight through.
 */
const ASSIGNMENT_AUDIT_EVENT: AuditRow['event'] = 'cohort.project';

/** A `projects` row paired with the versions of it a class could be put on. */
interface AssignableProject {
  project: ProjectEntity;
  mine: boolean;
  versions: ProjectVersionEntity[];
}

/** The class's one active assignment row, or none: the one copy of this read. */
function activeAssignmentRow(
  manager: EntityManager,
  cohortId: string,
): Promise<CohortProjectAssignmentEntity | null> {
  return manager.findOne(CohortProjectAssignmentEntity, {
    // `UQ_cohort_project_assignment_active` keeps at most one, so the order
    // is a tie-break for a database written round the index and not a policy.
    where: { cohortId, state: ASSIGNMENT_ACTIVE },
    order: { createdAt: 'DESC' },
  });
}

export type ClassProjectVersion =
  | { from: 'assignment'; projectVersionId: string }
  | { from: 'default'; projectSlugs: string[] };

/**
 * Which version a class is on, as the class card reads it.
 *
 * - The class's active assignment row, when it has one: that version, and
 *   only that one. A row naming a version this deployment no longer serves is
 *   still the answer (the caller then has nothing to read); it never falls
 *   through to the default.
 * - Otherwise the deployment's default project, the one the card says a
 *   learner who joins starts on: the flagged project rows, oldest first, by
 *   slug. The version is whatever the catalogue serves as that project's head
 *   (`WorkflowService.resolveForLearner` step 4 answers the first flagged slug
 *   the catalogue serves, at its head), so the caller resolves it.
 * - `null` when there is neither.
 *
 * Read only, two indexed reads at most, never `compiled`. Step 3 of the learner
 * resolution (`config.namedProject`) is not read here: the importer flags that
 * project whenever it imports it (`ensureDefaultProject`), so on a seeded
 * deployment the flag and the name agree.
 */
export async function classProjectVersionOf(
  manager: EntityManager,
  cohortId: string,
): Promise<ClassProjectVersion | null> {
  const held = await activeAssignmentRow(manager, cohortId);
  if (held) return { from: 'assignment', projectVersionId: held.projectVersionId };
  const flagged = await manager.find(ProjectEntity, {
    where: { isDefault: true },
    order: { createdAt: 'ASC' },
    select: { id: true, slug: true },
  });
  return flagged.length ? { from: 'default', projectSlugs: flagged.map((row) => row.slug) } : null;
}

/**
 * Which project a class works, and the record of every project it has worked.
 *
 * `WorkflowService.resolveForLearner` reads the table this writes at step 2 of
 * the resolution order; its partial unique index holds on both dialects. This
 * service is its only writer.
 *
 * It mirrors `ScheduleService.saveSchedule` deliberately, beat for beat
 * (owned-cohort guard, validation, write, structured log, audit row, return the
 * view) because a second idiom for "an instructor changed something about
 * their class" is how one of them comes to forget the guard or the row. The one
 * beat that is not copied is inside the guard, and `requireOwnedCohort` says
 * why: this route asks for ownership, not for a seat in the room.
 *
 * **What assigning changes, and what it never touches.** No enrolment row is
 * written, moved or re-pinned here; every pin stays the version its learner
 * started on. What changes is which project the resolution answers:
 *
 * - a learner who joins from now on is given this version;
 * - a learner working a teacher's project this class was given stays on it,
 *   at their own pin; a late joiner who also holds a platform row
 *   included;
 * - a learner whose own row is on a platform or default project other than
 *   this one is shown this project's Start next: the
 *   row is set aside for the class's project, kept whole, and still read by
 *   name in their record.
 *
 * The class card tells the teacher exactly this before they assign. Moving a
 * learner's work from one project to another is a separate, explicitly
 * audited action that refuses a learner holding an in-flight submission, and
 * it is not this route.
 */
@Injectable()
export class CohortProjectService {
  private readonly logger = new Logger(CohortProjectService.name);

  constructor(
    private readonly dataSource: DataSource,
    // The registry, for what a version holds.
    // Optional so every spec that builds this service by hand keeps its shape;
    // without it no view carries a provenance line.
    @Optional() private readonly content?: ContentService,
  ) {}

  /**
   * What one published version holds, in one line;
   * the class card's sentence. Read from the registry's own compiled
   * version (the pinned base, never a learner's overlay), and only when the
   * registry resolves **that** version: a version it does not hold would
   * resolve the head, and a line about the head is a line about something the
   * class was not given. Null when it cannot say.
   */
  private provenanceOfVersion(projectSlug: string, versionId: string): VersionProvenanceView | null {
    const content = this.content;
    if (!content || !projectSlug) return null;
    try {
      const pin = { projectSlug, projectVersionId: versionId };
      const resolved = content.resolveForEnrollment(pin);
      if (resolved.versionId !== versionId) return null;
      return projectProvenance(
        resolved.content.phases,
        (phase) => content.getTasksForEnrollment(pin, phase.key),
        referenceNameFrom(content),
      ).version;
    } catch {
      return null;
    }
  }

  /** `{ provenance }` where the registry can say it, nothing otherwise. */
  private provenanceField(projectSlug: string, versionId: string): { provenance?: VersionProvenanceView } {
    const provenance = this.provenanceOfVersion(projectSlug, versionId);
    return provenance ? { provenance } : {};
  }

  /* ------------------------------- the reads ------------------------------ */

  /**
   * The published versions this class could be put on: the platform's own
   * project, and the caller's own published projects.
   *
   * Another teacher's project is not in the list, and is not assignable at the
   * door either; `versionInReach` is the same predicate read from the other
   * side, so the list a teacher is shown and the set the write accepts cannot
   * drift apart.
   */
  async assignable(
    caller: InstructorCaller,
    cohortId: string,
  ): Promise<AssignableVersionView[]> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);
    const held = await this.activeAssignment(manager, cohortId);
    const groups = await this.assignableProjects(manager, caller);
    const phasesOf = await this.versionPhaseKeys(manager, groups.flatMap((group) => group.versions.map((version) => version.id)));

    const out: AssignableVersionView[] = [];
    for (const group of groups) {
      for (const version of group.versions) {
        out.push({
          projectId: group.project.id,
          projectSlug: group.project.slug,
          projectTitle: group.project.title,
          platformOwned: group.project.platformOwned,
          mine: group.mine,
          versionId: version.id,
          version: version.version,
          publishedAt: version.publishedAt ?? null,
          current: held?.projectVersionId === version.id,
          ...this.provenanceField(group.project.slug, version.id),
          ...(phasesOf.get(version.id)?.length ? { phases: phasesOf.get(version.id) } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Each listed version's phase keys in place order, read from its phase rows
   * in one query, so the class card names a version's phases and the class's
   * assignment carries its version's. A version with no
   * phase rows here is absent from the map.
   */
  private async versionPhaseKeys(manager: EntityManager, versionIds: string[]): Promise<Map<string, PhaseKey[]>> {
    const out = new Map<string, PhaseKey[]>();
    if (versionIds.length === 0) return out;
    const rows = await manager.find(ProjectPhaseEntity, {
      where: { projectVersionId: In(versionIds) },
      select: { id: true, key: true, order: true, projectVersionId: true },
    });
    for (const row of [...rows].sort((a, b) => a.order - b.order)) {
      const held = out.get(row.projectVersionId);
      if (held) held.push(row.key);
      else out.set(row.projectVersionId, [row.key]);
    }
    return out;
  }

  /** The assignment in force and everything the class has held before it. */
  async read(caller: InstructorCaller, cohortId: string): Promise<CohortProjectView> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);
    return this.view(manager, cohortId);
  }

  /* ------------------------------- the write ------------------------------ */

  /**
   * Put a class on a published version, with a reason.
   *
   * The deactivate is predicated on `state = 'active'` in its own WHERE clause
   * and a zero `affected` is a conflict rather than a silent no-op (the
   * compare-and-swap discipline the workspace save already uses) and the
   * insert then lands under `UQ_cohort_project_assignment_active`, so "one at a
   * time" is settled by the database rather than by a read-then-write two
   * teachers can both pass.
   */
  async assign(
    caller: InstructorCaller,
    cohortId: string,
    body: AssignProjectBody,
  ): Promise<CohortProjectView> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);

    const reason = (body.reason ?? '').trim();
    if (reason.length < ASSIGNMENT_REASON_MIN) {
      throw new BadRequestException(ASSIGNMENT_REASON_MESSAGE);
    }

    const { project, version } = await this.versionInReach(
      manager,
      caller,
      body.projectVersionId,
    );

    const held = await this.activeAssignment(manager, cohortId);
    if (held && held.projectVersionId === version.id) {
      // Nothing moved. A retry, a double-tapped button or a teacher
      // re-affirming what the class is already on is not a change of project,
      // and a history that records it as one is a history nobody can read: the
      // panel would show two rows an hour apart naming the same version. No
      // row, no audit line, and the view the caller gets back is the truth.
      this.logger.log({
        event: ASSIGNMENT_AUDIT_EVENT,
        actorId: caller.id,
        cohortId,
        projectSlug: project.slug,
        version: version.version,
        moved: false,
      });
      return this.view(manager, cohortId);
    }

    await atomic(this.dataSource, async (tx) => {
      if (held) {
        const swapped = await tx.update(
          CohortProjectAssignmentEntity,
          { id: held.id, state: ASSIGNMENT_ACTIVE },
          { state: ASSIGNMENT_SUPERSEDED },
        );
        // Zero rows means the active assignment moved between the read above
        // and this statement, so the row this write was computed against is not
        // the row in the table any more.
        if (!swapped.affected) throw new ConflictException(ASSIGNMENT_RACE);
      }
      try {
        await tx.save(
          tx.create(CohortProjectAssignmentEntity, {
            cohortId,
            projectVersionId: version.id,
            assignedByUserId: caller.id,
            state: ASSIGNMENT_ACTIVE,
            reason,
          }),
        );
      } catch (err) {
        // The index is the other half of the same answer, for the race the
        // read-then-write above cannot see: another transaction inserted its
        // active row while this one held none to supersede.
        if (isUniqueViolation(err)) throw new ConflictException(ASSIGNMENT_RACE);
        throw err;
      }
      // Inside the transaction, so a class can never be moved without the row
      // that says who moved it and why.
      await recordAudit(tx, {
        event: ASSIGNMENT_AUDIT_EVENT,
        actorUserId: caller.id,
        // The class is not a person. The subject is the teacher who acted, the
        // same shape `cohort.schedule` writes for the same reason.
        subjectUserId: caller.id,
        targetId: cohortId,
        action: project.slug,
        reason,
        detail: {
          projectId: project.id,
          projectSlug: project.slug,
          projectTitle: project.title,
          projectVersionId: version.id,
          version: version.version,
          fromProjectVersionId: held?.projectVersionId ?? null,
        },
      });
    });

    this.logger.log({
      event: ASSIGNMENT_AUDIT_EVENT,
      actorId: caller.id,
      cohortId,
      projectSlug: project.slug,
      version: version.version,
      from: held?.projectVersionId ?? null,
      moved: true,
    });
    return this.view(manager, cohortId);
  }

  /* -------------------------------- shaping ------------------------------- */

  /** The class's assignments, newest first, with the active one named. */
  private async view(manager: EntityManager, cohortId: string): Promise<CohortProjectView> {
    const rows = await manager.find(CohortProjectAssignmentEntity, {
      where: { cohortId },
      order: { createdAt: 'DESC' },
    });
    if (rows.length === 0) return { cohortId, active: null, history: [] };

    const versions = await manager.find(ProjectVersionEntity, {
      where: { id: In([...new Set(rows.map((row) => row.projectVersionId))]) },
      // Never the whole row: `compiled` is the compiled pack as `simple-json`,
      // a megabyte of text per version, and the panel wants a version string.
      select: { id: true, projectId: true, version: true },
    });
    const byVersion = new Map(versions.map((version) => [version.id, version]));
    const projects = versions.length
      ? await manager.find(ProjectEntity, {
          where: { id: In([...new Set(versions.map((version) => version.projectId))]) },
        })
      : [];
    const byProject = new Map(projects.map((project) => [project.id, project]));

    const actors = [...new Set(rows.map((row) => row.assignedByUserId))].filter(Boolean);
    const people = actors.length
      ? await manager.find(UserEntity, {
          where: { id: In(actors) },
          select: ['id', 'displayName'],
        })
      : [];
    const names = new Map(people.map((person) => [person.id, person.displayName]));
    // Each version's phases, from its phase rows, in one query.
    const phasesOf = await this.versionPhaseKeys(manager, [...byVersion.keys()]);

    const history: CohortProjectAssignmentView[] = rows.map((row) => {
      const version = byVersion.get(row.projectVersionId);
      const project = version ? byProject.get(version.projectId) : undefined;
      return {
        id: row.id,
        cohortId: row.cohortId,
        projectVersionId: row.projectVersionId,
        // A version this deployment no longer holds still has a row in the
        // class's record, and the record is what an appeal reads: the history
        // says what it can rather than dropping the line.
        projectSlug: project?.slug ?? '',
        projectTitle: project?.title ?? '',
        version: version?.version ?? '',
        assignedByUserId: row.assignedByUserId,
        // Null once that account is gone: the assignment is the class's record,
        // not the teacher's, so the id survives and the name stops resolving.
        assignedByName: names.get(row.assignedByUserId) ?? null,
        reason: row.reason,
        active: row.state === ASSIGNMENT_ACTIVE,
        createdAt: normalisedIso(row.createdAt) ?? '',
        // The class card's line, on the assignment in force only.
        ...(row.state === ASSIGNMENT_ACTIVE && project ? this.provenanceField(project.slug, row.projectVersionId) : {}),
        // The phases the version holds, so the teacher's views draw the class's
        // phases whoever owns the version; none for a version with
        // no phase rows here.
        ...(phasesOf.get(row.projectVersionId)?.length ? { phases: phasesOf.get(row.projectVersionId) } : {}),
      };
    });
    return {
      cohortId,
      active: history.find((row) => row.active) ?? null,
      history,
    };
  }

  /* -------------------------------- guards -------------------------------- */

  /**
   * The class has to be the caller's. A 404 rather than a 403, the rule every
   * instructor route here follows.
   *
   * The id is shape-checked before the query because Postgres raises on a
   * malformed uuid and that surfaces as a 500 where 404 is the truth, and
   * `'default'` is refused by name: it is not a class, it is the absence of
   * one, and no assignment is ever written against it.
   *
   * **Ownership, and not the caller's own `cohort` column.** This route is
   * otherwise a beat-for-beat mirror of `ScheduleService.saveSchedule`, which
   * accepts `caller.cohort === cohort.id` as well; that third arm is not copied
   * here, and it costs nothing, because `CohortsService.create` sets
   * `ownerUserId` at the same moment it moves the creator in; the teacher who
   * made the class passes on ownership. What the column adds is only the cases
   * where somebody sits in a class that is not theirs:
   * `AdminService.reassignCohortOwner` moves a class and deliberately leaves
   * every cohort column where it was, so a teacher who has had a class taken
   * off them carries its id for ever, and an admin may place any account in any
   * class. Either would keep the power to change what that whole class works
   * on, which is larger than the precedent: the schedule route moves dates,
   * while `assign` writes the row `WorkflowService.resolveForLearner` reads at
   * step 2, so every learner who joins from then on is given another project.
   */
  private async requireOwnedCohort(
    manager: EntityManager,
    caller: InstructorCaller,
    cohortId: string,
  ): Promise<CohortEntity> {
    const cohort =
      cohortId && cohortId !== UNATTACHED_COHORT && UUID_PATTERN.test(cohortId)
        ? await manager.findOne(CohortEntity, { where: { id: cohortId } })
        : null;
    const mine = cohort && (caller.role === 'ADMIN' || cohort.ownerUserId === caller.id);
    if (!mine) throw new NotFoundException(NOT_YOUR_CLASS);
    return cohort;
  }

  /**
   * One version the caller may put a class on, or the reason they may not.
   *
   * A version whose project is not in reach answers 404 with the rest (a
   * teacher learns nothing about what another teacher has published) and a
   * version they *can* see but that is not publishable content answers a
   * sentence naming what is wrong with it.
   */
  private async versionInReach(
    manager: EntityManager,
    caller: InstructorCaller,
    projectVersionId: string,
  ): Promise<{ project: ProjectEntity; version: ProjectVersionEntity }> {
    const version = UUID_PATTERN.test(projectVersionId ?? '')
      ? await manager.findOne(ProjectVersionEntity, {
          where: { id: projectVersionId },
          select: {
            id: true,
            projectId: true,
            version: true,
            status: true,
            publishedAt: true,
          },
        })
      : null;
    const project = version
      ? await manager.findOne(ProjectEntity, { where: { id: version.projectId } })
      : null;
    if (!version || !project || !this.inReach(caller, project)) {
      throw new NotFoundException(NO_SUCH_VERSION);
    }
    if (version.status !== 'published') {
      throw new BadRequestException(
        unpublishedVersionRefusal(project.title, version.version, version.status),
      );
    }
    if (!(await this.hasCompiledSnapshot(manager, version.id))) {
      throw new BadRequestException(
        noCompiledSnapshotRefusal(project.title, version.version),
      );
    }
    // Any version that still holds a structured phase in its older form, or a
    // written phase under a retired key, the platform's or a teacher's: the
    // learner's room no longer writes that work, so a class put on it would
    // start joiners on work nothing grades. The structured phases are named in
    // their order, Requirements first, before a retired written phase.
    const refusal = (await this.olderFormatVersions(manager, [version.id])).get(version.id);
    if (refusal) throw new BadRequestException(refusal);
    return { project, version };
  }

  /**
   * Whether this caller may hand this project to a class at all: the platform's
   * own project, which is assignable as it stands, and their own.
   *
   * An ADMIN sees every project, because an admin is the role that may read
   * everything, which is a different question from editing one, where an admin
   * is not an escape hatch.
   *
   * `isDefault` is deliberately not read here. It answers which project a
   * learner in no class is given, not who may hand a project out, and the
   * authoring side asks this same question without it
   * (`AuthoringService.requireVisibleProject` and `visibleProjects`). Nothing in
   * the schema ties the flag to `platformOwned`, so folding it in was a second
   * and wider answer to "which projects may this teacher reach": the day an
   * operator's default is a privately owned project, every instructor on the
   * deployment could put a class on it. The platform's own project keeps its
   * reach through `platformOwned`, which is what it has always been.
   */
  private inReach(caller: InstructorCaller, project: ProjectEntity): boolean {
    if (caller.role === 'ADMIN') return true;
    if (project.platformOwned) return true;
    return project.ownerUserId === caller.id;
  }

  /**
   * Every project in reach, with the versions of it a class could be put on.
   *
   * A published row whose `compiled` is null is left out here for the same
   * reason it is refused at the door: `ProjectRegistryService` skips it by
   * name, so a class put on it resolves the project's newest version instead
   * and the assignment says one thing while the learner gets another. Any
   * version that holds a structured phase in its older form, or a written
   * phase under a retired key, is left out here and refused at the door too
   * (`olderFormatVersions`).
   */
  private async assignableProjects(
    manager: EntityManager,
    caller: InstructorCaller,
  ): Promise<AssignableProject[]> {
    const all = await manager.find(ProjectEntity);
    const reachable = all.filter((project) => this.inReach(caller, project));
    if (reachable.length === 0) return [];

    const versions = await manager
      .getRepository(ProjectVersionEntity)
      .createQueryBuilder('version')
      // Never `compiled` itself: the question is whether there is one.
      .select([
        'version.id',
        'version.projectId',
        'version.version',
        'version.publishedAt',
      ])
      .where('version.projectId IN (:...projectIds)', {
        projectIds: reachable.map((project) => project.id),
      })
      .andWhere('version.status = :status', { status: 'published' })
      .andWhere('version.compiled IS NOT NULL')
      .getMany();

    // No version that holds an older-format or a retired written phase is
    // offered, the platform's or a teacher's own (the door refuses it too).
    const retired = await this.olderFormatVersions(manager, versions.map((version) => version.id));

    const byProject = new Map<string, ProjectVersionEntity[]>();
    for (const version of versions.filter((one) => !retired.has(one.id))) {
      const held = byProject.get(version.projectId);
      if (held) held.push(version);
      else byProject.set(version.projectId, [version]);
    }

    return reachable
      .map((project) => ({
        project,
        mine: project.ownerUserId === caller.id,
        versions: (byProject.get(project.id) ?? []).sort(
          // Newest first, compared field by field as numbers: `'2.0.10'` sorts
          // before `'2.0.9'` between strings, and a picker that offered them in
          // that order would put a superseded version at the top for ever.
          (a, b) => compareProjectVersions(b.version, a.version),
        ),
      }))
      .filter((group) => group.versions.length > 0)
      .sort((a, b) => {
        // The project a class gets by default comes first, then the rest of the
        // platform's, then the teacher's own by title; the order the picker is
        // read in, and stable, because two projects with one title would
        // otherwise swap places between two loads of the same page.
        const rank = (group: AssignableProject) =>
          group.project.isDefault ? 0 : group.project.platformOwned ? 1 : 2;
        return (
          rank(a) - rank(b) ||
          a.project.title.localeCompare(b.project.title) ||
          a.project.slug.localeCompare(b.project.slug)
        );
      });
  }

  /** The class's one active row, or none. */
  private activeAssignment(
    manager: EntityManager,
    cohortId: string,
  ): Promise<CohortProjectAssignmentEntity | null> {
    return activeAssignmentRow(manager, cohortId);
  }

  /**
   * Of these published versions, the ones the door refuses for their content,
   * each with the sentence it refuses with: a structured phase still in its
   * older form (`olderFormatPhase`, Requirements first), else a written phase
   * under a retired key (`retiredWrittenPhase`), named by its title. The list
   * and the door ask the same question. A published version's snapshot never
   * changes, so each version's answer is read from `compiled` once and kept by
   * version id: the picker reads only the versions it has not met before.
   */
  private async olderFormatVersions(
    manager: EntityManager,
    versionIds: string[],
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const id of versionIds) {
      const known = this.olderFormatByVersion.get(id);
      if (known) found.set(id, known);
    }
    const unknown = versionIds.filter((id) => !this.olderFormatByVersion.has(id));
    if (unknown.length === 0) return found;
    const rows = await manager.find(ProjectVersionEntity, {
      where: { id: In(unknown) },
      select: { id: true, status: true, compiled: true },
    });
    for (const row of rows) {
      const refusal = assignRefusalOf(row.compiled);
      // Only a published snapshot is immutable, so only its answer is kept.
      if (row.status === 'published' && row.compiled) this.olderFormatByVersion.set(row.id, refusal);
      if (refusal) found.set(row.id, refusal);
    }
    return found;
  }

  /** Per published version id, the sentence the door refuses it with for its content, or null (`olderFormatVersions`). */
  private readonly olderFormatByVersion = new Map<string, string | null>();

  /** Whether that version holds the snapshot the runtime reads, without reading it. */
  private async hasCompiledSnapshot(
    manager: EntityManager,
    versionId: string,
  ): Promise<boolean> {
    const count = await manager
      .getRepository(ProjectVersionEntity)
      .createQueryBuilder('version')
      .where('version.id = :versionId', { versionId })
      .andWhere('version.compiled IS NOT NULL')
      .getCount();
    return count > 0;
  }
}

/** The class door's sentence for each structured phase still in its older form. */
const OLDER_FORMAT_ASSIGN_REFUSAL: Record<OlderFormatKey, string> = {
  requirements: REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL,
  design: DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL,
  deployment: RUNBOOK_OLDER_FORMAT_ASSIGN_REFUSAL,
  maintenance: CHANGE_OLDER_FORMAT_ASSIGN_REFUSAL,
};

/**
 * Why a published snapshot cannot be put on a class for its content (spec
 * 7.4), or null: its first structured phase still in the older form, else its
 * first written phase under a retired key, named by the phase's own title.
 */
function assignRefusalOf(compiled: ProjectVersionEntity['compiled'] | null | undefined): string | null {
  const older = olderFormatPhase(compiled);
  if (older) return OLDER_FORMAT_ASSIGN_REFUSAL[older];
  const retired = retiredWrittenPhase(compiled);
  if (!retired) return null;
  const title = compiled?.content.phases.find((phase) => phase.key === retired)?.title ?? retired;
  return retiredWrittenPhaseAssignRefusal(title);
}

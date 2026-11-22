import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DataSource, Repository } from 'typeorm';
import {
  ASSIGNMENT_REASON_MIN,
  AUTHORING_ROUTES,
  CHANGE_OLDER_FORMAT_ASSIGN_REFUSAL,
  DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL,
  REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL,
  RUNBOOK_OLDER_FORMAT_ASSIGN_REFUSAL,
  retiredWrittenPhaseAssignRefusal,
} from '@learnsdlc/shared';
import { ROLES_KEY, type AuthUser } from '../auth/auth.decorators';
import { ProjectsController } from '../workflow/projects.controller';
import { ContentService } from '../content/content.service';
import { COMPILER_IDENTITY } from '../content/pack-compiler';
import {
  ALL_ENTITIES,
  AuditEventEntity,
  CohortEntity,
  CohortPhaseScheduleEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  NotificationEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  ReleaseRecordEntity,
  UserEntity,
} from '../db/entities';
import { ProjectPhaseEntity } from '../content/project.entities';
import type { FeedbackService } from '../feedback/feedback.service';
import type { InstructorCaller } from '../instructor/cohort-scope';
import { InstructorService } from '../instructor/instructor.service';
import type { AssistantService } from '../assistant/assistant.service';
import type { ModuleRef } from '@nestjs/core';
import type { EventsGateway } from '../events/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { NOT_YOUR_PROJECT, WorkflowService } from '../workflow/workflow.service';
import { CohortProjectController } from './cohort-project.controller';
import {
  ASSIGNMENT_ACTIVE,
  ASSIGNMENT_SUPERSEDED,
  CohortProjectService,
  NOT_YOUR_CLASS,
  NO_SUCH_VERSION,
  noCompiledSnapshotRefusal,
  unpublishedVersionRefusal,
} from './cohort-project.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * Which project a class works, as a row with a reason and an actor.
 *
 * The resolution order reads the table at step 2, and its partial unique
 * index holds on both dialects. The service is its only writer, and the three
 * properties the tests below exist to hold down are the three that would be
 * invisible in a screenshot:
 *
 * 1. **Scope is enforced at the API.** A class the caller does not own answers
 *    404 rather than 403, by the written policy in `cohort-scope.ts`, and a
 *    project that is neither the platform's nor the caller's own is not
 *    assignable at all; the list and the door take the same predicate, so they
 *    cannot disagree.
 * 2. **One active row.** Reassigning deactivates before it inserts, inside one
 *    transaction, under `UQ_cohort_project_assignment_active`; the history
 *    keeps every row the class ever held.
 * 3. **Assigning never moves a learner who is already enrolled.** Their pin is
 *    a fact about their attempt. A learner who arrives afterwards resolves the
 *    class's project through the resolution order. (A started platform or
 *    default row is set aside by the class's assignment to another project so
 *    the learner can start it; the row itself still does not move.)
 */
describe('the class project assignment', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let service: CohortProjectService;
  let workflow: WorkflowService;
  let audits: Repository<AuditEventEntity>;

  /** `project_versions.id` of the platform project, 1.0.0 and 1.1.0. */
  let platformV1 = '';
  let platformV2 = '';
  /** Dana's own project: one published version and one open draft. */
  let danaPublished = '';
  let danaDraft = '';
  /** A published version of Dana's whose compile never finished. */
  let danaUncompiled = '';
  /** Sam's project, which Dana can neither see nor assign. */
  let samPublished = '';

  let platformProjectId = '';
  let danaProjectId = '';

  let dana: InstructorCaller;
  let sam: InstructorCaller;
  let root: InstructorCaller;
  let danaId = '';
  let cohortId = '';
  let samCohortId = '';

  const PLATFORM_SLUG = 'tasktrackr';
  const DANA_SLUG = 'ledger-lab';
  const SAM_SLUG = 'rota-desk';

  const manager = () => dataSource.manager;
  const reason = 'the class moves to my own project this term';

  const saveUser = (fields: Partial<UserEntity>) =>
    manager().save(
      manager().create(UserEntity, { passwordHash: 'x', displayName: 'Someone', ...fields }),
    );

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    audits = dataSource.getRepository(AuditEventEntity);
    service = new CohortProjectService(dataSource);
    workflow = new WorkflowService(
      dataSource.getRepository(EnrollmentEntity),
      dataSource.getRepository(PhaseStateEntity),
      dataSource.getRepository(ReleaseRecordEntity),
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      dataSource,
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /**
   * Three projects as rows, and the same three installed in the registry.
   *
   * What the runtime reads is `project_versions.compiled`, so a
   * published row carrying a snapshot is exactly what a teacher-authored
   * project *is* to every reader in the resolution order. The snapshots are
   * clones of the imported pack with the slug, title and version rewritten,
   * which is the fixture style `default-resolution.spec.ts` already uses.
   */
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);

    const danaRow = await saveUser({
      email: 'dana@learnsdlc.test',
      displayName: 'Dana Okafor',
      role: 'INSTRUCTOR',
    });
    const samRow = await saveUser({ email: 'sam@learnsdlc.test', role: 'INSTRUCTOR' });
    const rootRow = await saveUser({ email: 'root@learnsdlc.test', role: 'ADMIN' });
    danaId = danaRow.id;

    const tuesday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Tuesday class',
        joinCode: 'ABCDEFGH',
        ownerUserId: danaRow.id,
      }),
    );
    const thursday = await manager().save(
      manager().create(CohortEntity, {
        name: 'Thursday class',
        joinCode: 'JKLMNPQR',
        ownerUserId: samRow.id,
      }),
    );
    cohortId = tuesday.id;
    samCohortId = thursday.id;
    dana = { id: danaRow.id, role: 'INSTRUCTOR', cohort: tuesday.id };
    sam = { id: samRow.id, role: 'INSTRUCTOR', cohort: thursday.id };
    root = { id: rootRow.id, role: 'ADMIN', cohort: 'default' };

    const base = content.getProject(PLATFORM_SLUG);
    const installed: { versionId: string; content: typeof base; compiler: string }[] = [];

    const project = async (fields: Partial<ProjectEntity>) =>
      manager().save(
        manager().create(ProjectEntity, {
          platformOwned: false,
          ownerUserId: null,
          isDefault: false,
          origin: 'fork',
          ...fields,
        } as ProjectEntity),
      );

    const version = async (
      projectId: string,
      slug: string,
      title: string,
      at: string,
      fields: Partial<ProjectVersionEntity> = {},
      register = true,
    ) => {
      const clone = { ...base, slug, title, version: at };
      const row = await manager().save(
        manager().create(ProjectVersionEntity, {
          projectId,
          version: at,
          status: 'published',
          manifest: {
            tagline: base.tagline,
            description: base.description,
            language: base.language,
            languages: base.languages,
          },
          compiled: { slug, version: at, content: clone, compiler: COMPILER_IDENTITY } as never,
          publishedAt: new Date().toISOString(),
          publishedByUserId: null,
          ...fields,
        } as ProjectVersionEntity),
      );
      if (register) installed.push({ versionId: row.id, content: clone, compiler: COMPILER_IDENTITY });
      return row.id;
    };

    const platform = await project({
      slug: PLATFORM_SLUG,
      title: base.title,
      platformOwned: true,
      isDefault: true,
      origin: 'seed',
    });
    platformProjectId = platform.id;
    platformV1 = await version(platform.id, PLATFORM_SLUG, base.title, '1.0.0');
    platformV2 = await version(platform.id, PLATFORM_SLUG, base.title, '1.1.0');

    const ledger = await project({ slug: DANA_SLUG, title: 'Ledger Lab', ownerUserId: danaRow.id });
    danaProjectId = ledger.id;
    danaPublished = await version(ledger.id, DANA_SLUG, 'Ledger Lab', '2.0.0');
    // A draft is not assignable, and neither is a published row whose compile
    // never finished: the registry skips the second by name, so a class put on
    // it would silently resolve the head instead of the version it was given.
    danaDraft = await version(
      ledger.id,
      DANA_SLUG,
      'Ledger Lab',
      '2.1.0',
      { status: 'draft', compiled: null, publishedAt: null },
      false,
    );
    danaUncompiled = await version(
      ledger.id,
      DANA_SLUG,
      'Ledger Lab',
      '1.9.0',
      { compiled: null },
      false,
    );

    const rota = await project({ slug: SAM_SLUG, title: 'Rota Desk', ownerUserId: samRow.id });
    samPublished = await version(rota.id, SAM_SLUG, 'Rota Desk', '3.0.0');

    content.installVersions(installed as never);
  });

  /* ------------------------------ the contract ----------------------------- */

  describe('the route table', () => {
    it('serves the three paths the contract names, staff only, with one audited write', () => {
      expect(AUTHORING_ROUTES['assignment.assignable']).toMatchObject({
        method: 'GET',
        path: '/instructor/cohorts/:cohortId/project/assignable',
        mutates: false,
        audit: null,
      });
      expect(AUTHORING_ROUTES['assignment.read']).toMatchObject({
        method: 'GET',
        path: '/instructor/cohorts/:cohortId/project',
        mutates: false,
        audit: null,
      });
      expect(AUTHORING_ROUTES['assignment.assign']).toMatchObject({
        method: 'PUT',
        path: '/instructor/cohorts/:cohortId/project',
        mutates: true,
        audit: 'cohort.project',
      });
      for (const key of ['assignment.assignable', 'assignment.read', 'assignment.assign'] as const) {
        expect([...AUTHORING_ROUTES[key].roles]).toEqual(['INSTRUCTOR', 'ADMIN']);
      }
    });

    /**
     * The scope is enforced at the API and not only in the page. `RolesGuard`
     * is a global guard reading exactly this metadata, so a controller that
     * lost its `@Roles` would serve the class library to any signed-in learner
     * and no test of the service would notice.
     */
    it("mounts the contract's paths behind the staff roles", () => {
      const mounted = (method: string, handler: keyof CohortProjectController) => {
        const fn = CohortProjectController.prototype[handler];
        return {
          method,
          path: `/${Reflect.getMetadata(PATH_METADATA, CohortProjectController)}/${Reflect.getMetadata(PATH_METADATA, fn)}`,
        };
      };

      expect(Reflect.getMetadata(ROLES_KEY, CohortProjectController)).toEqual([
        'INSTRUCTOR',
        'ADMIN',
      ]);
      expect(mounted('GET', 'assignable')).toEqual({
        method: 'GET',
        path: AUTHORING_ROUTES['assignment.assignable'].path,
      });
      expect(mounted('GET', 'read')).toEqual({
        method: 'GET',
        path: AUTHORING_ROUTES['assignment.read'].path,
      });
      expect(mounted('PUT', 'assign')).toEqual({
        method: 'PUT',
        path: AUTHORING_ROUTES['assignment.assign'].path,
      });
      // RequestMethod.GET is 0, PUT is 4; asserted by name rather than by
      // number so a reordering of Nest's enum cannot quietly pass.
      expect(
        Reflect.getMetadata(METHOD_METADATA, CohortProjectController.prototype.assign),
      ).toBe(RequestMethod.PUT);
      expect(
        Reflect.getMetadata(METHOD_METADATA, CohortProjectController.prototype.read),
      ).toBe(RequestMethod.GET);
    });
  });

  /* -------------------------------- the scope ------------------------------ */

  describe('whose class it is', () => {
    it('answers 404, not 403, for a class the caller does not own', async () => {
      await expect(service.read(sam, cohortId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.assignable(sam, cohortId)).rejects.toThrow(NOT_YOUR_CLASS);
      await expect(
        service.assign(sam, cohortId, { projectVersionId: platformV2, reason }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('answers 404 for a class id that names nothing, and for the unattached sentinel', async () => {
      await expect(service.read(dana, '11111111-2222-3333-4444-555555555555')).rejects.toThrow(
        NOT_YOUR_CLASS,
      );
      // Shape-checked before the query: Postgres raises on a malformed uuid and
      // that surfaces as a 500 where 404 is the truth.
      await expect(service.read(dana, 'not-a-uuid')).rejects.toThrow(NOT_YOUR_CLASS);
      await expect(service.read(dana, 'default')).rejects.toThrow(NOT_YOUR_CLASS);
      await expect(service.read(dana, '')).rejects.toThrow(NOT_YOUR_CLASS);
    });

    /**
     * A class is its owner's, and the caller's own `cohort` column is not
     * ownership: it is the seat they sit in.
     *
     * The reachable case is not hypothetical. `CohortsService.create` moves the
     * creator into the class they made, and `AdminService.reassignCohortOwner`
     * moves the class and deliberately leaves every cohort column where it was
     * ("the new owner is not moved into the class"), so a teacher who has had
     * a class taken off them still carries its id in their own column for ever.
     * Reading the column as reach would let that account keep changing what the
     * whole class works on, which is the one thing handing the class over was
     * supposed to end. Nothing legitimate is lost: creating a class sets
     * `ownerUserId` too, so the teacher who made it passes on ownership.
     */
    it('refuses a class the caller sits in but does not own', async () => {
      // The class Dana made, and was moved into, is handed to Sam. Dana's own
      // column still names it, and that column is all she has left.
      await manager().update(CohortEntity, { id: cohortId }, { ownerUserId: sam.id });
      expect(dana.cohort).toBe(cohortId);

      await expect(service.read(dana, cohortId)).rejects.toThrow(NOT_YOUR_CLASS);
      await expect(service.assignable(dana, cohortId)).rejects.toThrow(NOT_YOUR_CLASS);
      await expect(
        service.assign(dana, cohortId, { projectVersionId: platformV2, reason }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
      expect(await audits.count()).toBe(0);
    });

    it('lets an admin read and assign any class, because an admin may read everything', async () => {
      const view = await service.assign(root, cohortId, {
        projectVersionId: platformV2,
        reason,
      });
      expect(view.active?.projectSlug).toBe(PLATFORM_SLUG);
      expect(view.active?.assignedByUserId).toBe(root.id);
    });
  });

  /* ------------------------------- assignable ------------------------------ */

  describe('what a class could be put on', () => {
    it("offers the platform project and the caller's own, and never another teacher's", async () => {
      const rows = await service.assignable(dana, cohortId);
      // Two published versions of the platform's project and one of Dana's.
      expect([...rows.map((row) => row.projectSlug)].sort()).toEqual([
        DANA_SLUG,
        PLATFORM_SLUG,
        PLATFORM_SLUG,
      ]);
      expect(rows.some((row) => row.projectSlug === SAM_SLUG)).toBe(false);
      expect(rows.every((row) => row.versionId !== samPublished)).toBe(true);
    });

    it("marks what is the platform's and what is the caller's own", async () => {
      const rows = await service.assignable(dana, cohortId);
      const platform = rows.find((row) => row.projectSlug === PLATFORM_SLUG)!;
      const mine = rows.find((row) => row.projectSlug === DANA_SLUG)!;
      expect(platform).toMatchObject({ platformOwned: true, mine: false });
      expect(mine).toMatchObject({ platformOwned: false, mine: true, projectTitle: 'Ledger Lab' });
      expect(platform.projectId).toBe(platformProjectId);
      expect(mine.projectId).toBe(danaProjectId);
    });

    /**
     * `isDefault` answers "which project does a learner in no class get", not
     * "who may hand this project out". The authoring service asks the reach
     * question without it (`requireVisibleProject` and `visibleProjects` in
     * `authoring.service.ts` read `platformOwned` and `ownerUserId` only) and
     * two answers to "which projects may this teacher reach" is one answer too
     * many: the day an operator's default is a privately owned project, every
     * instructor on the deployment would be able to put a class on it.
     */
    it("never offers another teacher's project on the strength of the default flag", async () => {
      await manager().update(ProjectEntity, { slug: PLATFORM_SLUG }, { isDefault: false });
      await manager().update(ProjectEntity, { slug: SAM_SLUG }, { isDefault: true });

      const rows = await service.assignable(dana, cohortId);
      expect(rows.some((row) => row.projectSlug === SAM_SLUG)).toBe(false);
      // And the platform's own project is still there, because its reach was
      // never the flag: it is `platformOwned`.
      expect(rows.some((row) => row.projectSlug === PLATFORM_SLUG)).toBe(true);

      await expect(
        service.assign(dana, cohortId, { projectVersionId: samPublished, reason }),
      ).rejects.toThrow(NO_SUCH_VERSION);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('never offers a draft, and never a published version with no compiled snapshot', async () => {
      const rows = await service.assignable(dana, cohortId);
      const ids = rows.map((row) => row.versionId);
      expect(ids).toContain(danaPublished);
      expect(ids).not.toContain(danaDraft);
      expect(ids).not.toContain(danaUncompiled);
    });

    it("lists a project's versions newest first, compared as numbers", async () => {
      const rows = await service.assignable(dana, cohortId);
      const platform = rows.filter((row) => row.projectSlug === PLATFORM_SLUG);
      expect(platform.map((row) => row.version)).toEqual(['1.1.0', '1.0.0']);
    });

    it("names each assignable version's phases, in place order", async () => {
      // Dana's 2.0.0 holds three phases, written out of order; the class card names them by place
      for (const [key, order] of [['implementation', 3], ['requirements', 1], ['design', 2]] as const) {
        await manager().save(
          manager().create(ProjectPhaseEntity, {
            projectVersionId: danaPublished, key, order, title: key, intro: '', artifactKind: 'story', assistant: { systemPrompt: '', topics: [], progressive: [] },
          } as never),
        );
      }
      const rows = await service.assignable(dana, cohortId);
      expect(rows.find((row) => row.versionId === danaPublished)?.phases).toEqual(['requirements', 'design', 'implementation']);
      // a version with no phase rows here names none, rather than an empty list
      expect(rows.find((row) => row.versionId === platformV1)).not.toHaveProperty('phases');
    });

    it('marks the version the class is on right now, and only that one', async () => {
      const before = await service.assignable(dana, cohortId);
      expect(before.every((row) => row.current === false)).toBe(true);

      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const after = await service.assignable(dana, cohortId);
      expect(after.filter((row) => row.current).map((row) => row.versionId)).toEqual([platformV1]);
    });
  });

  /**
   * A version whose Requirements still grades the 2.x markdown story, the
   * platform's or a teacher's own: nothing grades it any more, so the picker
   * never offers it and the door refuses it with one fixed sentence.
   */
  describe('a version whose Requirements grades the 2.x markdown story', () => {
    const markdownSnapshot = (slug: string, title: string, at: string) => {
      const base = content.getProject(PLATFORM_SLUG);
      const phases = base.phases.map((phase) =>
        phase.key === 'requirements' ? { ...phase, checks: { kind: 'markdown', targets: ['requirements/my-story.md'] } } : phase,
      );
      return { slug, version: at, content: { ...base, slug, title, version: at, phases }, compiler: COMPILER_IDENTITY };
    };
    const markdownVersion = async (projectId: string, slug: string, title: string, at: string) =>
      (
        await manager().save(
          manager().create(ProjectVersionEntity, {
            projectId,
            version: at,
            status: 'published',
            manifest: {},
            compiled: markdownSnapshot(slug, title, at),
            publishedAt: new Date().toISOString(),
            publishedByUserId: null,
          } as never),
        )
      ).id;

    it("is not offered or assignable on the platform's project", async () => {
      const legacy = await markdownVersion(platformProjectId, PLATFORM_SLUG, 'TaskTrackr', '0.9.0');
      const rows = await service.assignable(dana, cohortId);
      expect(rows.map((row) => row.versionId)).not.toContain(legacy);
      expect(rows.map((row) => row.versionId)).toEqual(expect.arrayContaining([platformV1, platformV2]));
      await expect(service.assign(dana, cohortId, { projectVersionId: legacy, reason })).rejects.toThrow(
        REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL,
      );
      await expect(service.assign(root, cohortId, { projectVersionId: legacy, reason })).rejects.toBeInstanceOf(BadRequestException);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it("is not offered or assignable on a teacher's own project either", async () => {
      const own = await markdownVersion(danaProjectId, DANA_SLUG, 'Ledger Lab', '1.5.0');
      const rows = await service.assignable(dana, cohortId);
      expect(rows.map((row) => row.versionId)).not.toContain(own);
      expect(rows.map((row) => row.versionId)).toContain(danaPublished);
      await expect(service.assign(dana, cohortId, { projectVersionId: own, reason })).rejects.toThrow(
        new BadRequestException(REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL),
      );
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });
  });

  /**
   * The Design twin: a version whose Design still grades the older markdown
   * kind, the platform's or a teacher's own, is never offered and the door
   * refuses it with its own fixed sentence; one whose Requirements and Design
   * are both older names Requirements first.
   */
  describe('a version whose Design grades the older markdown kind', () => {
    const olderSnapshot = (slug: string, title: string, at: string, keys: readonly string[]) => {
      const base = content.getProject(PLATFORM_SLUG);
      const phases = base.phases.map((phase) =>
        keys.includes(phase.key) ? { ...phase, checks: { kind: 'markdown', targets: [`${phase.key}/my-${phase.key}.md`] } } : phase,
      );
      return { slug, version: at, content: { ...base, slug, title, version: at, phases }, compiler: COMPILER_IDENTITY };
    };
    const olderVersion = async (projectId: string, slug: string, title: string, at: string, keys: readonly string[] = ['design']) =>
      (
        await manager().save(
          manager().create(ProjectVersionEntity, {
            projectId,
            version: at,
            status: 'published',
            manifest: {},
            compiled: olderSnapshot(slug, title, at, keys),
            publishedAt: new Date().toISOString(),
            publishedByUserId: null,
          } as never),
        )
      ).id;

    it("is not offered or assignable on the platform's project", async () => {
      const legacy = await olderVersion(platformProjectId, PLATFORM_SLUG, 'TaskTrackr', '0.9.0');
      const rows = await service.assignable(dana, cohortId);
      expect(rows.map((row) => row.versionId)).not.toContain(legacy);
      expect(rows.map((row) => row.versionId)).toEqual(expect.arrayContaining([platformV1, platformV2]));
      await expect(service.assign(dana, cohortId, { projectVersionId: legacy, reason })).rejects.toThrow(
        DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL,
      );
      await expect(service.assign(root, cohortId, { projectVersionId: legacy, reason })).rejects.toBeInstanceOf(BadRequestException);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it("is not offered or assignable on a teacher's own project either", async () => {
      const own = await olderVersion(danaProjectId, DANA_SLUG, 'Ledger Lab', '1.5.0');
      const rows = await service.assignable(dana, cohortId);
      expect(rows.map((row) => row.versionId)).not.toContain(own);
      expect(rows.map((row) => row.versionId)).toContain(danaPublished);
      await expect(service.assign(dana, cohortId, { projectVersionId: own, reason })).rejects.toThrow(
        new BadRequestException(DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL),
      );
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('names Requirements first when both phases are older', async () => {
      const both = await olderVersion(danaProjectId, DANA_SLUG, 'Ledger Lab', '1.6.0', ['requirements', 'design']);
      expect((await service.assignable(dana, cohortId)).map((row) => row.versionId)).not.toContain(both);
      await expect(service.assign(dana, cohortId, { projectVersionId: both, reason })).rejects.toThrow(
        new BadRequestException(REQUIREMENTS_OLDER_FORMAT_ASSIGN_REFUSAL),
      );
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });
  });

  /**
   * The record twins, and a retired written phase: a version whose Deployment is a config task with no runbook,
   * whose Maintenance is a code task with no change request, or whose Testing is still a written (markdown) phase,
   * is never offered, and the door refuses it with its own sentence.
   */
  describe('a version whose Deployment or Maintenance is in the older format, or which holds a retired written phase', () => {
    type Edit = (phase: ReturnType<ContentService['getProject']>['phases'][number]) => object;
    const without = (key: string, field: string): Edit => (phase) => {
      if (phase.key !== key) return phase;
      const { [field]: _gone, ...checks } = phase.checks as unknown as Record<string, unknown>;
      return { ...phase, checks };
    };
    const writtenTesting: Edit = (phase) => (phase.key === 'testing' ? { ...phase, artifactKind: 'markdown', checks: { kind: 'markdown', targets: ['tests/notes.md'], rules: [] } } : phase);
    const editedVersion = async (projectId: string, slug: string, title: string, at: string, edit: Edit) => {
      const base = content.getProject(PLATFORM_SLUG);
      const compiled = { slug, version: at, content: { ...base, slug, title, version: at, phases: base.phases.map(edit) }, compiler: COMPILER_IDENTITY };
      return (
        await manager().save(
          manager().create(ProjectVersionEntity, {
            projectId, version: at, status: 'published', manifest: {}, compiled, publishedAt: new Date().toISOString(), publishedByUserId: null,
          } as never),
        )
      ).id;
    };

    it.each([
      ['Deployment', without('deployment', 'runbook'), RUNBOOK_OLDER_FORMAT_ASSIGN_REFUSAL],
      ['Maintenance', without('maintenance', 'change'), CHANGE_OLDER_FORMAT_ASSIGN_REFUSAL],
    ] as const)('an older %s is not offered or assignable, the platform\'s or a teacher\'s own', async (_name, edit, refusal) => {
      const legacy = await editedVersion(platformProjectId, PLATFORM_SLUG, 'TaskTrackr', '0.9.0', edit);
      const own = await editedVersion(danaProjectId, DANA_SLUG, 'Ledger Lab', '1.5.0', edit);
      const rows = (await service.assignable(dana, cohortId)).map((row) => row.versionId);
      expect(rows).not.toContain(legacy);
      expect(rows).not.toContain(own);
      expect(rows).toEqual(expect.arrayContaining([platformV1, platformV2, danaPublished]));
      await expect(service.assign(dana, cohortId, { projectVersionId: legacy, reason })).rejects.toThrow(new BadRequestException(refusal));
      await expect(service.assign(dana, cohortId, { projectVersionId: own, reason })).rejects.toThrow(new BadRequestException(refusal));
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('a version whose Testing is a written phase is not offered, and the door names the phase', async () => {
      const written = await editedVersion(danaProjectId, DANA_SLUG, 'Ledger Lab', '1.5.0', writtenTesting);
      expect((await service.assignable(dana, cohortId)).map((row) => row.versionId)).not.toContain(written);
      const title = content.getProject(PLATFORM_SLUG).phases.find((phase) => phase.key === 'testing')!.title;
      await expect(service.assign(dana, cohortId, { projectVersionId: written, reason })).rejects.toThrow(
        new BadRequestException(retiredWrittenPhaseAssignRefusal(title)),
      );
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });
  });

  /* --------------------------------- assign -------------------------------- */

  describe('putting a class on a version', () => {
    it('writes one active row, one audit row carrying the reason, and returns the view', async () => {
      const view = await service.assign(dana, cohortId, {
        projectVersionId: danaPublished,
        reason,
      });

      expect(view.cohortId).toBe(cohortId);
      expect(view.active).toMatchObject({
        cohortId,
        projectVersionId: danaPublished,
        projectSlug: DANA_SLUG,
        projectTitle: 'Ledger Lab',
        version: '2.0.0',
        assignedByUserId: danaId,
        assignedByName: 'Dana Okafor',
        reason,
        active: true,
      });
      expect(view.history).toHaveLength(1);
      expect(view.history[0].id).toBe(view.active!.id);

      const rows = await manager().find(CohortProjectAssignmentEntity, { where: { cohortId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe(ASSIGNMENT_ACTIVE);

      const trail = await audits.find();
      expect(trail).toHaveLength(1);
      expect(trail[0]).toMatchObject({
        event: AUTHORING_ROUTES['assignment.assign'].audit,
        actorUserId: danaId,
        subjectUserId: danaId,
        targetId: cohortId,
        action: DANA_SLUG,
        reason,
      });
      // The detail names what moved, so an appeal six weeks later reads the
      // change rather than the fact that there was one.
      expect(trail[0].detail).toMatchObject({
        projectVersionId: danaPublished,
        projectSlug: DANA_SLUG,
        version: '2.0.0',
        fromProjectVersionId: null,
      });
    });

    it('asks for a reason of at least the length every override already asks', async () => {
      await expect(
        service.assign(dana, cohortId, { projectVersionId: platformV2, reason: 'too short' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect('too short'.length).toBeLessThan(ASSIGNMENT_REASON_MIN);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('refuses a draft and an uncompiled publish by name, and writes nothing', async () => {
      await expect(
        service.assign(dana, cohortId, { projectVersionId: danaDraft, reason }),
      ).rejects.toThrow(unpublishedVersionRefusal('Ledger Lab', '2.1.0', 'draft'));
      await expect(
        service.assign(dana, cohortId, { projectVersionId: danaUncompiled, reason }),
      ).rejects.toThrow(noCompiledSnapshotRefusal('Ledger Lab', '1.9.0'));
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
      expect(await audits.count()).toBe(0);
    });

    it("answers 404 for a version that is not the caller's to give out", async () => {
      await expect(
        service.assign(dana, cohortId, { projectVersionId: samPublished, reason }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.assign(dana, cohortId, {
          projectVersionId: '99999999-8888-7777-6666-555555555555',
          reason,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.assign(dana, cohortId, { projectVersionId: 'not-a-uuid', reason }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await manager().count(CohortProjectAssignmentEntity)).toBe(0);
    });

    it('deactivates the old row before it inserts, and keeps the history newest first', async () => {
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const view = await service.assign(dana, cohortId, {
        projectVersionId: danaPublished,
        reason: 'the class moves to my own project after the break',
      });

      expect(view.active!.projectVersionId).toBe(danaPublished);
      expect(view.history.map((row) => row.projectVersionId)).toEqual([danaPublished, platformV1]);
      expect(view.history.map((row) => row.active)).toEqual([true, false]);

      const rows = await manager().find(CohortProjectAssignmentEntity, { where: { cohortId } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.state === ASSIGNMENT_ACTIVE)).toHaveLength(1);
      expect(rows.find((row) => row.projectVersionId === platformV1)!.state).toBe(
        ASSIGNMENT_SUPERSEDED,
      );
      expect(await audits.count()).toBe(2);
    });

    it('lets the database settle "one at a time" rather than a read-then-write', async () => {
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      // `UQ_cohort_project_assignment_active` is `UNIQUE (cohortId) WHERE
      // state = 'active'`. A second active row inserted behind the service's
      // back is what two teachers pressing Assign together would produce, and
      // the index is what refuses it on both dialects.
      await expect(
        manager().save(
          manager().create(CohortProjectAssignmentEntity, {
            cohortId,
            projectVersionId: platformV2,
            assignedByUserId: danaId,
            state: ASSIGNMENT_ACTIVE,
            reason,
          }),
        ),
      ).rejects.toThrow(/UNIQUE constraint failed/i);
    });

    it('treats re-assigning the version the class is already on as nothing moving', async () => {
      const first = await service.assign(dana, cohortId, {
        projectVersionId: platformV1,
        reason,
      });
      const again = await service.assign(dana, cohortId, {
        projectVersionId: platformV1,
        reason: 'pressed the button twice by accident',
      });

      // One history row, not two: the class is on what it was on, and a
      // history that logs a retry as a move is a history nobody can read.
      expect(again.history).toHaveLength(1);
      expect(again.active!.id).toBe(first.active!.id);
      expect(again.active!.reason).toBe(reason);
      expect(await audits.count()).toBe(1);
    });

    it('refuses a conflicting write rather than leaving two classes one row', async () => {
      // The service's own compare-and-swap: the deactivate is predicated on
      // `state = 'active'`, so a row that moved underneath it is a conflict.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const [race, settled] = await Promise.allSettled([
        service.assign(dana, cohortId, { projectVersionId: platformV2, reason }),
        service.assign(dana, cohortId, { projectVersionId: danaPublished, reason }),
      ]);
      const outcomes = [race.status, settled.status];
      expect(outcomes).toContain('fulfilled');
      const rows = await manager().find(CohortProjectAssignmentEntity, { where: { cohortId } });
      expect(rows.filter((row) => row.state === ASSIGNMENT_ACTIVE)).toHaveLength(1);
      for (const outcome of [race, settled]) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason).toBeInstanceOf(ConflictException);
        }
      }
    });
  });

  /* ---------------------------------- read --------------------------------- */

  describe('what the class panel reads', () => {
    it('says a class has never been given a project rather than guessing one', async () => {
      const view = await service.read(dana, cohortId);
      expect(view).toEqual({ cohortId, active: null, history: [] });
    });

    it('keeps the record of who assigned it once that account is gone', async () => {
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      await manager().delete(UserEntity, { id: danaId });

      const view = await service.read(root, cohortId);
      expect(view.active).toMatchObject({
        assignedByUserId: danaId,
        assignedByName: null,
        reason,
      });
    });

    it("names the assigned version's phases in place order, even for another teacher's version the caller cannot list", async () => {
      // Sam's 3.0.0 holds three phases, written out of order. An admin puts
      // Dana's class on it, so it is on no list Dana's assignable call answers:
      // the board and the class levers read the phases from the assignment.
      for (const [key, order] of [['testing', 3], ['design', 1], ['implementation', 2]] as const) {
        await manager().save(
          manager().create(ProjectPhaseEntity, {
            projectVersionId: samPublished, key, order, title: key, intro: '', artifactKind: 'story', assistant: { systemPrompt: '', topics: [], progressive: [] },
          } as never),
        );
      }
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      await service.assign(root, cohortId, { projectVersionId: samPublished, reason });

      expect((await service.assignable(dana, cohortId)).some((row) => row.versionId === samPublished)).toBe(false);
      const view = await service.read(dana, cohortId);
      expect(view.active?.projectVersionId).toBe(samPublished);
      expect(view.active?.phases).toEqual(['design', 'implementation', 'testing']);
      // an earlier assignment whose version holds no phase rows here names none, rather than an empty list
      expect(view.history.find((row) => row.projectVersionId === platformV1)).not.toHaveProperty('phases');
    });

    it("reads one class and never another's history", async () => {
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      await service.assign(sam, samCohortId, { projectVersionId: platformV2, reason });

      const mine = await service.read(dana, cohortId);
      expect(mine.history).toHaveLength(1);
      expect(mine.active!.projectVersionId).toBe(platformV1);
    });
  });

  /* ----------------------------- and the learner --------------------------- */

  describe('what the assignment does to a learner', () => {
    const joinClass = async (email: string, cohort: string) =>
      (await saveUser({ email, displayName: 'Lee', cohort })).id;

    it("sends a learner who joins afterwards to the class's project at the class's version", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);

      const pin = await workflow.projectVersionForLearner({ id: lee, cohort: cohortId });
      expect(pin).toEqual({ projectSlug: DANA_SLUG, projectVersionId: danaPublished });

      // And the enrolment the learner actually gets when they press Start is
      // that project at that version, so the row the learner holds and the row
      // the teacher wrote name one thing.
      //
      // The two agree here because the assigned version is the project's
      // newest published one, which is what a teacher assigns the day they
      // publish. They are two different reads (`writeEnrollment` stamps
      // `headVersionIdFor(slug)` (`workflow.service.ts:389`) and the resolution
      // answers the assignment) and a class deliberately held on a superseded
      // version is where they part.
      await workflow.enroll(lee, pin!.projectSlug);
      const held = await manager().findOneOrFail(EnrollmentEntity, { where: { userId: lee } });
      expect(held.projectSlug).toBe(DANA_SLUG);
      expect(held.projectVersionId).toBe(danaPublished);

      const board = await workflow.myEnrollmentForLearner({ id: lee, cohort: cohortId });
      expect(board!.projectSlug).toBe(DANA_SLUG);
    });

    /**
     * A learner already on the PLATFORM project has that row set aside once
     * the class is given a teacher's project, so the learner can start the
     * class's project: the resolution answers the class's project at the
     * class's version. The property this file exists for (the enrolment row
     * itself is not moved, re-pinned or deleted by an assignment) is asserted
     * down to the row's id. A TEACHER's row is left exactly where it is,
     * resolution and all: "keeps a learner on the teacher's project their own
     * class was moved off" and the "a class that works another project" describe below.
     */
    it('moves no enrolment row when the class is assigned, and sets a platform row aside for the class project', async () => {
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      await workflow.enroll(lee, PLATFORM_SLUG);
      const before = await manager().findOneOrFail(EnrollmentEntity, { where: { userId: lee } });

      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });

      const pin = await workflow.projectVersionForLearner({ id: lee, cohort: cohortId });
      expect(pin).toEqual({ projectSlug: DANA_SLUG, projectVersionId: danaPublished });
      const after = await manager().findOneOrFail(EnrollmentEntity, { where: { userId: lee } });
      expect(after.id).toBe(before.id);
      expect(after.projectVersionId).toBe(before.projectVersionId);
      expect(after.projectSlug).toBe(PLATFORM_SLUG);
    });

    it('sends a learner in no class to the deployment default, assignment or not', async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const nobody = await joinClass('nobody@learnsdlc.test', 'default');

      const pin = await workflow.projectVersionForLearner({ id: nobody, cohort: 'default' });
      expect(pin?.projectSlug).toBe(PLATFORM_SLUG);
      expect(pin?.projectVersionId).toBe(platformV2);
    });
  });

  /* ------------------ and what the learner may ask to start ---------------- */

  /**
   * The other half of the same rule, on the write side.
   *
   * If `POST /api/v1/enrollments` took the slug the browser sent and enrolled
   * into it, the resolution order above would decide what a learner was
   * *shown* and nothing at all about what they were *given*. On a shared lab
   * machine a learner signs out, the next one registers with no class, and
   * the tab still holds the first learner's slug, so the new account would be
   * pinned to a teacher's project it was never assigned.
   *
   * Naming a project is therefore a claim the server checks rather than an
   * instruction it follows: the only project a learner may start is the one
   * `projectVersionForLearner` answers for them.
   */
  describe('which project a learner may start', () => {
    const joinClass = async (email: string, cohort: string) =>
      (await saveUser({ email, displayName: 'Lee', cohort })).id;

    const enrolmentsOf = (userId: string) =>
      manager().count(EnrollmentEntity, { where: { userId } });

    it("refuses a learner in no class a teacher's project, and writes nothing", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const nobody = await joinClass('nobody@learnsdlc.test', 'default');

      await expect(
        workflow.enrollAsLearner({ id: nobody, cohort: 'default' }, DANA_SLUG),
      ).rejects.toThrow(NOT_YOUR_PROJECT);
      expect(await enrolmentsOf(nobody)).toBe(0);

      // The default is theirs, and so is the request that names nothing at all.
      const started = await workflow.enrollAsLearner(
        { id: nobody, cohort: 'default' },
        PLATFORM_SLUG,
      );
      expect(started.projectSlug).toBe(PLATFORM_SLUG);
      const unnamed = await workflow.enrollAsLearner({ id: nobody, cohort: 'default' });
      expect(unnamed.id).toBe(started.id);
      expect(await enrolmentsOf(nobody)).toBe(1);
    });

    it("gives a class's learner the assigned project at the assigned version", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);

      // Sam's project is published, and it is not this class's.
      await expect(
        workflow.enrollAsLearner({ id: lee, cohort: cohortId }, SAM_SLUG),
      ).rejects.toThrow(NOT_YOUR_PROJECT);
      // Neither is the platform's, while the class is on Dana's.
      await expect(
        workflow.enrollAsLearner({ id: lee, cohort: cohortId }, PLATFORM_SLUG),
      ).rejects.toThrow(NOT_YOUR_PROJECT);
      expect(await enrolmentsOf(lee)).toBe(0);

      const started = await workflow.enrollAsLearner({ id: lee, cohort: cohortId }, DANA_SLUG);
      expect(started.projectSlug).toBe(DANA_SLUG);
      const row = await manager().findOneOrFail(EnrollmentEntity, { where: { userId: lee } });
      // `startingPin` is untouched: the version is the class's assignment.
      expect(row.projectVersionId).toBe(danaPublished);
    });

    /**
     * A learner who started the platform's project in a class that had no
     * project yet, when the teacher then gives the class one: the class's
     * active assignment to another project sets a DEFAULT or PLATFORM row
     * aside so the learner can start the class's. A retry answers the same
     * board, the row they started is never deleted and its pin never moves.
     */
    it("sets aside the platform project a learner started once the class is given another", async () => {
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const started = await workflow.enrollAsLearner({ id: lee, cohort: cohortId });
      expect(started.projectSlug).toBe(PLATFORM_SLUG);
      // A retry before the class is given anything is still a retry.
      expect((await workflow.enrollAsLearner({ id: lee, cohort: cohortId }, PLATFORM_SLUG)).id).toBe(started.id);
      const pinned = (await manager().findOneOrFail(EnrollmentEntity, { where: { id: started.id } })).projectVersionId;

      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      await expect(
        workflow.enrollAsLearner({ id: lee, cohort: cohortId }, PLATFORM_SLUG),
      ).rejects.toThrow(NOT_YOUR_PROJECT);
      const moved = await workflow.enrollAsLearner({ id: lee, cohort: cohortId }, DANA_SLUG);
      expect(moved.projectSlug).toBe(DANA_SLUG);
      expect(await enrolmentsOf(lee)).toBe(2);
      const kept = await manager().findOneOrFail(EnrollmentEntity, { where: { id: started.id } });
      expect(kept.projectSlug).toBe(PLATFORM_SLUG);
      expect(kept.projectVersionId).toBe(pinned);
    });

    /**
     * The version `enrollAsLearner` checked is the version written.
     *
     * Resolving a pin, keeping only its slug, and letting `enroll` read the
     * class's assignment a second time would let a teacher moving the class
     * between the two reads put the learner on the old project at its HEAD
     * (a version nobody assigned) and step 1 would answer it for the rest of
     * the term.
     */
    it('writes the version it resolved, even if the class moves before the write', async () => {
      // The class is held on the platform's superseded 1.0.0 while 1.1.0 is out.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);

      const read = (workflow as any).assignedToClass.bind(workflow);
      jest.spyOn(workflow as any, 'assignedToClass').mockImplementationOnce(async (cohort) => {
        const answer = await read(cohort);
        // The teacher moves the class after the learner's project was resolved.
        await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
        return answer;
      });
      try {
        const started = await workflow.enrollAsLearner({ id: lee, cohort: cohortId });
        expect(started.projectSlug).toBe(PLATFORM_SLUG);
      } finally {
        jest.restoreAllMocks();
      }
      const row = await manager().findOneOrFail(EnrollmentEntity, { where: { userId: lee } });
      expect(row.projectVersionId).toBe(platformV1);
    });

    /**
     * What the Start card reads is the version the learner will be given.
     *
     * The catalogue listed the resolved project first and described it from
     * `getProject(slug)`; the newest published version, whatever the class
     * is held on. A learner of a class deliberately kept on the older version
     * read the newer version's phase titles on the card, pressed Start, and
     * was pinned (correctly) to a version whose phases differ from what the
     * card had promised. The same held for a project kept in their record.
     */
    it("describes the version the learner resolves to and the versions they hold, never the head", async () => {
      const HELD_TITLE = 'Requirements, as this class was given it';
      const NEWER_TITLE = 'Ledger Lab, rewritten for next term';
      // Dana publishes a newer version of her own project, and the platform's
      // 1.0.0 is given a phase title of its own, so each version says which it is.
      const rewrite = await manager().save(
        manager().create(ProjectVersionEntity, {
          projectId: danaProjectId,
          version: '2.2.0',
          status: 'published',
          manifest: {},
          compiled: null,
          publishedAt: new Date().toISOString(),
          publishedByUserId: null,
        } as unknown as ProjectVersionEntity),
      );
      const published = await manager().find(ProjectVersionEntity, { where: { status: 'published' } });
      const installable = published
        .filter((row) => row.compiled || row.id === rewrite.id)
        .map((row) => {
          if (row.id === rewrite.id) {
            const head = (published.find((one) => one.id === danaPublished)!.compiled as any).content;
            return { versionId: row.id, content: { ...head, title: NEWER_TITLE, version: '2.2.0' }, compiler: COMPILER_IDENTITY };
          }
          const held = (row.compiled as any).content;
          const content =
            row.id === platformV1
              ? { ...held, phases: held.phases.map((phase: any, at: number) => (at === 0 ? { ...phase, title: HELD_TITLE } : phase)) }
              : held;
          return { versionId: row.id, content, compiler: COMPILER_IDENTITY };
        });
      content.installVersions(installable as never);
      expect(content.headVersionIdFor(DANA_SLUG)).toBe(rewrite.id);
      expect(content.headVersionIdFor(PLATFORM_SLUG)).toBe(platformV2);

      // A class held on the platform's 1.0.0 while 1.1.0 is out.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const before = await workflow.catalogueForLearner({ id: lee, cohort: cohortId });
      expect(before.map((meta) => meta.slug)).toEqual([PLATFORM_SLUG]);
      expect(before[0].phaseTitles[0].title).toBe(HELD_TITLE);
      // And by name, which is the same answer.
      expect(
        (await workflow.projectMetaForLearner({ id: lee, cohort: cohortId }, PLATFORM_SLUG)).phaseTitles[0].title,
      ).toBe(HELD_TITLE);
      // The head is still what a request naming the project reads.
      expect(workflow.projectMeta(PLATFORM_SLUG).phaseTitles[0].title).not.toBe(HELD_TITLE);

      // A learner kept on Dana's 2.0.0 after leaving her class: the default is
      // theirs now, and the project in their record reads as the version they hold.
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const kofi = await joinClass('kofi@learnsdlc.test', cohortId);
      await manager().save(
        manager().create(EnrollmentEntity, { userId: kofi, projectSlug: DANA_SLUG, projectVersionId: danaPublished }),
      );
      await manager().update(UserEntity, { id: kofi }, { cohort: 'default' });
      const kept = await workflow.catalogueForLearner({ id: kofi, cohort: 'default' });
      expect(kept.map((meta) => meta.slug)).toEqual([PLATFORM_SLUG, DANA_SLUG]);
      expect(kept[1].title).toBe('Ledger Lab');
      expect(kept[1].title).not.toBe(NEWER_TITLE);
    });

    it('refuses in words that are true for every learner who can be refused', () => {
      // A learner kept on a teacher's project their class was moved off is
      // refused the class's new project, and nobody past onboarding
      // can open onboarding again: the sentence may promise neither, and it
      // names no project at all.
      expect(NOT_YOUR_PROJECT).not.toMatch(/learning setup|Your class works/);
      expect(NOT_YOUR_PROJECT).toMatch(/dashboard/);
      for (const slug of [PLATFORM_SLUG, DANA_SLUG, SAM_SLUG]) {
        expect(NOT_YOUR_PROJECT).not.toContain(slug);
      }
    });
  });

  /* ---------------- and when the learner's own membership moves ------------ */

  /**
   * The owner's rules, read after the learner has started: a teacher's project
   * reaches only learners of a class it is assigned to, and a learner in no
   * class gets the default.
   *
   * If step 1 answered any single enrolment a learner held, a learner who
   * LEFT their class (or moved to another) would keep the teacher's project
   * for good and be refused the one their membership now gives them. A class
   * being moved is different: a learner keeps a teacher's project their own
   * class was given, active or superseded. A started DEFAULT or PLATFORM
   * project is set aside by the class's active assignment to another project.
   */
  describe('when the learner’s own membership moves', () => {
    const joinClass = async (email: string, cohort: string) =>
      (await saveUser({ email, displayName: 'Lee', cohort })).id;
    const moveTo = (userId: string, cohort: string) =>
      manager().update(UserEntity, { id: userId }, { cohort });

    it("sends a learner who leaves their class to the default, and keeps the class's work", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const first = await workflow.enrollAsLearner({ id: lee, cohort: cohortId });
      expect(first.projectSlug).toBe(DANA_SLUG);

      await moveTo(lee, 'default');
      const solo = { id: lee, cohort: 'default' };
      expect(await workflow.projectVersionForLearner(solo)).toEqual({
        projectSlug: PLATFORM_SLUG,
        projectVersionId: platformV2,
      });
      // The warm-up's path, which reads the class off the users row.
      expect((await workflow.projectVersionForLearner({ id: lee }))?.projectSlug).toBe(PLATFORM_SLUG);
      expect(await workflow.myEnrollmentForLearner(solo)).toBeNull();

      await expect(workflow.enrollAsLearner(solo, DANA_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      const started = await workflow.enrollAsLearner(solo);
      expect(started.projectSlug).toBe(PLATFORM_SLUG);
      expect((await workflow.myEnrollmentForLearner(solo))!.id).toBe(started.id);

      // The class's project is still in their record, unmoved and unpinned.
      const kept = await manager().findOneOrFail(EnrollmentEntity, {
        where: { userId: lee, projectSlug: DANA_SLUG },
      });
      expect(kept.id).toBe(first.id);
      expect(kept.projectVersionId).toBe(danaPublished);
    });

    it("sends a learner who moves to another class to that class's project", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      await service.assign(sam, samCohortId, { projectVersionId: samPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      await workflow.enrollAsLearner({ id: lee, cohort: cohortId });

      await moveTo(lee, samCohortId);
      const moved = { id: lee, cohort: samCohortId };
      expect(await workflow.projectVersionForLearner(moved)).toEqual({
        projectSlug: SAM_SLUG,
        projectVersionId: samPublished,
      });
      await expect(workflow.enrollAsLearner(moved, DANA_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      const started = await workflow.enrollAsLearner(moved);
      expect(started.projectSlug).toBe(SAM_SLUG);
      expect((await workflow.myEnrollmentForLearner(moved))!.id).toBe(started.id);
    });

    it("keeps a learner on the teacher's project their own class was moved off", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const first = await workflow.enrollAsLearner({ id: lee, cohort: cohortId });

      // A reassignment, not a move by the learner: the assignment Dana's
      // project came from is superseded, and it still reaches this learner.
      await service.assign(dana, cohortId, { projectVersionId: platformV2, reason });
      expect(await workflow.projectVersionForLearner({ id: lee, cohort: cohortId })).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });
      await expect(
        workflow.enrollAsLearner({ id: lee, cohort: cohortId }, PLATFORM_SLUG),
      ).rejects.toThrow(NOT_YOUR_PROJECT);
      expect((await workflow.myEnrollmentForLearner({ id: lee, cohort: cohortId }))!.id).toBe(first.id);
    });

    it('leaves staff previewing a project exactly where they were', async () => {
      // Dana walks her own project before she assigns it to anybody; the
      // staff preview `POST /enrollments` keeps for non-learners.
      const preview = await workflow.enroll(danaId, DANA_SLUG);
      const asCaller = { id: danaId, cohort: cohortId, role: 'INSTRUCTOR' };
      expect((await workflow.myEnrollmentForLearner(asCaller))!.id).toBe(preview.id);
      // And on the path that hands over an id alone, which reads the row.
      expect((await workflow.projectVersionForLearner({ id: danaId }))?.projectSlug).toBe(DANA_SLUG);
    });

    /**
     * A learner who started the platform's project alone and then joins a
     * class on a teacher's project: the class's active assignment sets a
     * started DEFAULT or PLATFORM row aside, so the learner starts the class's
     * project (at the class's version) and the row they started stays whole
     * and pinned in their record. The "a class that works another project"
     * describe below asserts the rest.
     */
    it("starts a learner who joins a class on the class's project, keeping the platform one they had started", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      const first = await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      expect(first.projectSlug).toBe(PLATFORM_SLUG);

      await moveTo(lee, cohortId);
      const joined = { id: lee, cohort: cohortId, role: 'LEARNER' };
      expect(await workflow.projectVersionForLearner(joined)).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });
      // Not started yet: the dashboard offers the class's project.
      expect(await workflow.myEnrollmentForLearner(joined)).toBeNull();
      await expect(workflow.enrollAsLearner(joined, PLATFORM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      const started = await workflow.enrollAsLearner(joined, DANA_SLUG);
      expect(started.projectSlug).toBe(DANA_SLUG);
      expect((await workflow.myEnrollmentForLearner(joined))!.id).toBe(started.id);
      // And the platform board is still theirs, by name.
      expect((await workflow.myEnrollment(lee, PLATFORM_SLUG))!.id).toBe(first.id);
    });
  });

  /* ------------- a class's project and a learner's own start ------------- */

  /**
   * When a learner's current class has an ACTIVE assignment to a
   * different project, a started enrolment on a DEFAULT or PLATFORM project is
   * set aside so the learner can start the class's project.
   *
   * Set aside is a word about the resolution and nothing else. The row is never
   * deleted, its pin never moves, and every route that names the project still
   * answers it. A row on a TEACHER's project is never set aside this way: the
   * rule that a teacher's project reaches only learners of a class it was
   * ever assigned to keeps its meaning for it.
   */
  describe('D-23: a class that works another project', () => {
    const joinClass = async (email: string, cohort: string) =>
      (await saveUser({ email, displayName: 'Lee', cohort })).id;
    const moveTo = (userId: string, cohort: string) =>
      manager().update(UserEntity, { id: userId }, { cohort });
    // By slug, not by `startedAt`: two starts inside one second tie on sqlite.
    // DANA_SLUG ('ledger-lab') sorts before PLATFORM_SLUG ('tasktrackr').
    const rowsOf = (userId: string) =>
      manager().find(EnrollmentEntity, { where: { userId }, order: { projectSlug: 'ASC' } });

    it("lets a solo starter who joins start the class's project at the class's version, and keeps their own", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      const solo = await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      const [own] = await rowsOf(lee);
      expect(own.projectVersionId).toBe(platformV2);

      await moveTo(lee, cohortId);
      const joined = { id: lee, cohort: cohortId, role: 'LEARNER' };

      // What the learner is shown: the class's project first, the one they
      // started after it and marked as set aside; the notice's two titles.
      const catalogue = await workflow.catalogueForLearner(joined);
      expect(catalogue.map((meta) => [meta.slug, meta.setAside ?? null])).toEqual([
        [DANA_SLUG, null],
        [PLATFORM_SLUG, true],
      ]);
      // The warm-up's path, which reads the class and role off the users row.
      expect(await workflow.projectVersionForLearner({ id: lee })).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });

      const started = await workflow.enrollAsLearner(joined);
      expect(started.projectSlug).toBe(DANA_SLUG);
      const rows = await rowsOf(lee);
      expect(rows.map((row) => [row.projectSlug, row.projectVersionId])).toEqual([
        [DANA_SLUG, danaPublished],
        [PLATFORM_SLUG, platformV2],
      ]);
      expect(rows[1].id).toBe(solo.id);

      // Started, the class's project is simply theirs; the platform one is
      // still listed, still set aside, and still answers by name.
      expect((await workflow.catalogueForLearner(joined)).map((meta) => [meta.slug, meta.setAside ?? null])).toEqual([
        [DANA_SLUG, null],
        [PLATFORM_SLUG, true],
      ]);
      expect((await workflow.myEnrollment(lee, PLATFORM_SLUG))!.id).toBe(solo.id);
      expect((await workflow.phaseSummaries(lee, PLATFORM_SLUG)).length).toBeGreaterThan(0);
      expect((await workflow.projectMetaForLearner(joined, PLATFORM_SLUG)).setAside).toBe(true);
    });

    /**
     * Leaving later: the learner is in no class, so no class's project sets
     * anything aside, and the teacher's project stops reaching them (the
     * existing rule). They go back to the platform project they started, at
     * the pin it was started on (not at its head) because their own row is
     * step 1 of the resolution. Nothing is written by leaving.
     */
    it('returns a learner who leaves to the platform project they started, at its own pin', async () => {
      // The class starts on the platform's 1.0.0 while 1.1.0 is out, so the pin
      // and the head differ; then the teacher gives the class her own project.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const inClass = { id: lee, cohort: cohortId, role: 'LEARNER' };
      const first = await workflow.enrollAsLearner(inClass);
      expect((await rowsOf(lee)).map((row) => row.projectVersionId)).toEqual([platformV1]);

      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      expect((await workflow.projectVersionForLearner(inClass))?.projectSlug).toBe(DANA_SLUG);
      const danaRow = await workflow.enrollAsLearner(inClass);
      expect(danaRow.projectSlug).toBe(DANA_SLUG);

      await moveTo(lee, 'default');
      const left = { id: lee, cohort: 'default', role: 'LEARNER' };
      expect(await workflow.projectVersionForLearner(left)).toEqual({
        projectSlug: PLATFORM_SLUG,
        projectVersionId: platformV1,
      });
      expect((await workflow.myEnrollmentForLearner(left))!.id).toBe(first.id);
      // After the move nothing is set aside; the teacher's project is kept
      // by the existing rule, listed after, and unmarked.
      expect((await workflow.catalogueForLearner(left)).map((meta) => [meta.slug, meta.setAside ?? null])).toEqual([
        [PLATFORM_SLUG, null],
        [DANA_SLUG, null],
      ]);
      const rows = await rowsOf(lee);
      expect(rows.map((row) => [row.projectSlug, row.projectVersionId])).toEqual([
        [DANA_SLUG, danaPublished],
        [PLATFORM_SLUG, platformV1],
      ]);
    });

    it("shows the teacher their learner on the class's project first, the one they started marked", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      await moveTo(lee, cohortId);
      const roster = new InstructorService(
        dataSource,
        content,
        { tokensToday: async () => 0 } as unknown as AssistantService,
        workflow,
      );
      const seen = async () =>
        (await roster.learnerDetail(dana, lee)).enrollments.map((one) => [one.projectSlug, one.setAside ?? null]);

      // Joined, not started: the one row they hold is marked.
      expect(await seen()).toEqual([[PLATFORM_SLUG, true]]);

      await workflow.enrollAsLearner({ id: lee, cohort: cohortId, role: 'LEARNER' });
      // The platform row is the older by a day, so oldest-first would lead with it.
      await manager().update(
        EnrollmentEntity,
        { userId: lee, projectSlug: PLATFORM_SLUG },
        { startedAt: new Date(Date.now() - 86_400_000) },
      );
      expect(await seen()).toEqual([
        [DANA_SLUG, null],
        [PLATFORM_SLUG, true],
      ]);
      // Built without the resolution (the hand-built specs), the order is the old one.
      const legacy = new InstructorService(dataSource, content, { tokensToday: async () => 0 } as unknown as AssistantService);
      expect((await legacy.learnerDetail(dana, lee)).enrollments.map((one) => one.projectSlug)).toEqual([
        PLATFORM_SLUG,
        DANA_SLUG,
      ]);
    });

    it("never sets aside a teacher's project: a learner kept on X when the class moves to Y is not moved", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const inClass = { id: lee, cohort: cohortId, role: 'LEARNER' };
      const first = await workflow.enrollAsLearner(inClass);
      expect(first.projectSlug).toBe(DANA_SLUG);

      // An admin puts the class on another teacher's project (Sam's).
      await service.assign(root, cohortId, { projectVersionId: samPublished, reason });
      expect(await workflow.projectVersionForLearner(inClass)).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });
      await expect(workflow.enrollAsLearner(inClass, SAM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      expect((await workflow.catalogueForLearner(inClass)).map((meta) => [meta.slug, meta.setAside ?? null])).toEqual([
        [DANA_SLUG, null],
      ]);
      expect(await rowsOf(lee)).toHaveLength(1);
    });

    it("keeps a platform row when the class's project is that same project, at whatever version", async () => {
      // The class is held on 1.0.0; the learner started alone on 1.1.0.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      const solo = await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      await moveTo(lee, cohortId);
      const joined = { id: lee, cohort: cohortId, role: 'LEARNER' };
      expect(await workflow.projectVersionForLearner(joined)).toEqual({
        projectSlug: PLATFORM_SLUG,
        projectVersionId: platformV2,
      });
      expect((await workflow.enrollAsLearner(joined)).id).toBe(solo.id);
      expect((await workflow.catalogueForLearner(joined))[0].setAside).toBeUndefined();
    });

    it('decides which project the learner is in, not what reaches them: the platform one still does', async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      const inClass = { id: lee, cohort: cohortId, role: 'LEARNER' };
      // Nothing started: the platform's project reaches every learner (the
      // warm-up's by-name door), another teacher's unassigned one does not.
      expect(await workflow.reachesLearner(inClass, PLATFORM_SLUG)).toBe(true);
      expect(await workflow.reachesLearner(inClass, DANA_SLUG)).toBe(true);
      expect(await workflow.reachesLearner(inClass, SAM_SLUG)).toBe(false);
    });

    it('sets nothing aside for a class whose assignment this deployment cannot resolve', async () => {
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      const solo = await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      await manager().save(
        manager().create(CohortProjectAssignmentEntity, {
          cohortId,
          projectVersionId: '00000000-0000-4000-8000-000000000000',
          assignedByUserId: danaId,
          state: 'active',
          reason,
        }),
      );
      await moveTo(lee, cohortId);
      const joined = { id: lee, cohort: cohortId, role: 'LEARNER' };
      expect((await workflow.myEnrollmentForLearner(joined))!.id).toBe(solo.id);
      expect((await workflow.catalogueForLearner(joined))[0].setAside).toBeUndefined();
    });

    it('leaves staff holding the platform project exactly where they were', async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const preview = await workflow.enroll(danaId, PLATFORM_SLUG);
      const asCaller = { id: danaId, cohort: cohortId, role: 'INSTRUCTOR' };
      expect((await workflow.myEnrollmentForLearner(asCaller))!.id).toBe(preview.id);
      expect((await workflow.projectVersionForLearner({ id: danaId }))?.projectSlug).toBe(PLATFORM_SLUG);
    });

    /**
     * A class import writes a fresh class with no project and the learners'
     * rows as exported (`PortabilityService.write`), so nothing it writes can
     * be set aside: a learner arriving on the platform's project resolves to
     * it at its own pin.
     */
    it('leaves an imported class on the rows it arrived with', async () => {
      const imported = await manager().save(
        manager().create(CohortEntity, { name: 'Imported', joinCode: 'IMPRTED2', ownerUserId: danaId }),
      );
      const lee = await joinClass('lee@learnsdlc.test', imported.id);
      await manager().save(
        manager().create(EnrollmentEntity, { userId: lee, projectSlug: PLATFORM_SLUG, projectVersionId: platformV1 }),
      );
      const learner = { id: lee, cohort: imported.id, role: 'LEARNER' };
      expect(await workflow.projectVersionForLearner(learner)).toEqual({
        projectSlug: PLATFORM_SLUG,
        projectVersionId: platformV1,
      });
      expect((await workflow.catalogueForLearner(learner))[0].setAside).toBeUndefined();
    });

    /**
     * The late joiner the set-aside rule creates. Lee started
     * the platform's project alone, joined Dana's class and started its
     * project, exactly like Kim, who joined on time. Then Dana moves the class
     * to the platform's project. The class-history rule keeps a learner on the teacher's
     * project their class gave them, and it must keep Lee there as it keeps
     * Kim: the platform row he started before joining does not take the
     * teacher's row over by becoming the class's project. The platform row
     * yields to the teacher's (it is marked, as the class's project would mark
     * it), stays whole, and still answers by name.
     */
    it("keeps a late joiner on the teacher's project when the class moves to the platform's, as it keeps one who joined on time", async () => {
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      const lee = await joinClass('lee@learnsdlc.test', 'default');
      const solo = await workflow.enrollAsLearner({ id: lee, cohort: 'default' });
      await moveTo(lee, cohortId);
      const leeIn = { id: lee, cohort: cohortId, role: 'LEARNER' };
      const leeOnDana = await workflow.enrollAsLearner(leeIn);
      expect(leeOnDana.projectSlug).toBe(DANA_SLUG);
      const kim = await joinClass('kim@learnsdlc.test', cohortId);
      const kimIn = { id: kim, cohort: cohortId, role: 'LEARNER' };
      const kimOnDana = await workflow.enrollAsLearner(kimIn);

      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });

      // Kim: kept on the teacher's project by the class-history rule.
      expect((await workflow.myEnrollmentForLearner(kimIn))!.id).toBe(kimOnDana.id);
      // Lee: the same, at the teacher's pin, not his solo row at its own.
      expect(await workflow.projectVersionForLearner(leeIn)).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });
      expect(await workflow.projectVersionForLearner({ id: lee })).toEqual({
        projectSlug: DANA_SLUG,
        projectVersionId: danaPublished,
      });
      expect((await workflow.myEnrollmentForLearner(leeIn))!.id).toBe(leeOnDana.id);
      expect((await workflow.catalogueForLearner(leeIn)).map((meta) => [meta.slug, meta.setAside ?? null])).toEqual([
        [DANA_SLUG, null],
        [PLATFORM_SLUG, true],
      ]);
      await expect(workflow.enrollAsLearner(leeIn, PLATFORM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      expect((await workflow.enrollAsLearner(leeIn)).id).toBe(leeOnDana.id);
      // The teacher's roster reads him on the teacher's project, the solo row marked.
      const standing = await workflow.rosterStanding({ id: lee, cohort: cohortId }, await rowsOf(lee));
      expect(standing.current).toBe(DANA_SLUG);
      expect([...standing.setAside]).toEqual([solo.id]);
      // Kept whole, and read by name; nothing was written by the move.
      expect((await workflow.myEnrollment(lee, PLATFORM_SLUG))!.id).toBe(solo.id);
      expect((await rowsOf(lee)).map((row) => [row.projectSlug, row.projectVersionId])).toEqual([
        [DANA_SLUG, danaPublished],
        [PLATFORM_SLUG, platformV2],
      ]);

      // A learner who joins now is given the class's project, the platform's, at the class's version.
      const ray = await joinClass('ray@learnsdlc.test', cohortId);
      expect(await workflow.projectVersionForLearner({ id: ray, cohort: cohortId, role: 'LEARNER' })).toEqual({
        projectSlug: PLATFORM_SLUG,
        projectVersionId: platformV1,
      });
      // And Lee, leaving, is back on the platform project he started, at its own pin.
      await moveTo(lee, 'default');
      expect((await workflow.myEnrollmentForLearner({ id: lee, cohort: 'default', role: 'LEARNER' }))!.id).toBe(solo.id);
    });

    /**
     * The class's dates are per (class, project) and outlive a reassignment,
     * so a reminder sweep that read the class's dates alone would tell a
     * learner whose platform row was set aside for the class's project that
     * the set-aside project's phases were due; a project their dashboard no
     * longer opens. A reminder is about the project the learner is in.
     */
    it('reminds a learner of the dates of the project they are in, not of the one set aside', async () => {
      const dueSoon = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const dated = (projectSlug: string) =>
        manager().save(
          manager().create(CohortPhaseScheduleEntity, {
            cohortId,
            projectSlug,
            phaseKey: 'requirements',
            opensAt: null,
            dueAt: dueSoon,
          }),
        );
      const notifications = new NotificationsService(
        dataSource,
        content,
        { emitNotification: () => undefined } as unknown as EventsGateway,
        // What the app's module answers for LEARNER_RESOLUTION: the workflow service.
        { get: () => workflow } as unknown as ModuleRef,
      );
      const reminded = async (userId: string) =>
        (await manager().find(NotificationEntity, { where: { userId, kind: 'deadline.near' } })).length;

      // The class worked the platform's project and dated it; Lee started it.
      await service.assign(dana, cohortId, { projectVersionId: platformV1, reason });
      await dated(PLATFORM_SLUG);
      const lee = await joinClass('lee@learnsdlc.test', cohortId);
      await workflow.enrollAsLearner({ id: lee, cohort: cohortId, role: 'LEARNER' });
      await notifications.sweep();
      expect(await reminded(lee)).toBe(1);

      // Dana moves the class to her own project and dates it. The platform row
      // is set aside, so its date is not Lee's any more; the class's is, once
      // he has started it.
      await manager().delete(NotificationEntity, { userId: lee });
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      await dated(DANA_SLUG);
      await notifications.sweep();
      expect(await reminded(lee)).toBe(0);
      await workflow.enrollAsLearner({ id: lee, cohort: cohortId, role: 'LEARNER' });
      await notifications.sweep();
      const rows = await manager().find(NotificationEntity, { where: { userId: lee, kind: 'deadline.near' } });
      expect(rows).toHaveLength(1);
      const [danaRow] = (await rowsOf(lee)).filter((row) => row.projectSlug === DANA_SLUG);
      const state = await manager().findOneOrFail(PhaseStateEntity, {
        where: { enrollmentId: danaRow.id, phaseKey: 'requirements' },
      });
      expect(rows[0].subjectKey.startsWith(`${state.id}:`)).toBe(true);
    });
  });

  /* -------------- which project a member of staff may start -------------- */

  /**
   * An INSTRUCTOR may
   * start (POST /enrollments naming a slug) only a platform-owned published
   * project, a project they own, or a project assigned to a class they own.
   * ADMIN is unrestricted. It is authoring's `requireVisibleProject` plus the
   * classes the instructor owns, and it stops one teacher reading another
   * teacher's unassigned project through an enrolment. The refusal is the
   * learner's one sentence, whatever the slug names.
   */
  describe('D-24: which project a member of staff may start', () => {
    const staffRows = (userId: string) => manager().count(EnrollmentEntity, { where: { userId } });

    it('lets an instructor start the platform project and their own', async () => {
      expect((await workflow.enrollAsStaff(dana, PLATFORM_SLUG)).projectSlug).toBe(PLATFORM_SLUG);
      expect((await workflow.enrollAsStaff(dana, DANA_SLUG)).projectSlug).toBe(DANA_SLUG);
      expect(await staffRows(danaId)).toBe(2);
    });

    it("refuses another teacher's unassigned project, and a slug nobody published, in one sentence", async () => {
      await expect(workflow.enrollAsStaff(dana, SAM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      await expect(workflow.enrollAsStaff(dana, 'no-such-project')).rejects.toThrow(NOT_YOUR_PROJECT);
      // Sam's project assigned to Sam's own class is still not Dana's to start.
      await service.assign(sam, samCohortId, { projectVersionId: samPublished, reason });
      await expect(workflow.enrollAsStaff(dana, SAM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      expect(await staffRows(danaId)).toBe(0);
    });

    it("lets an instructor start another teacher's project once it is assigned to a class they own", async () => {
      // Only an admin can put Sam's project on Dana's class.
      await service.assign(root, cohortId, { projectVersionId: samPublished, reason });
      const started = await workflow.enrollAsStaff(dana, SAM_SLUG);
      expect(started.projectSlug).toBe(SAM_SLUG);
      // Moved on again, the class's history still names it: its learners may
      // still be working it, and so may their teacher.
      await service.assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      expect((await workflow.enrollAsStaff(dana, SAM_SLUG)).id).toBe(started.id);
    });

    it('leaves an admin unrestricted', async () => {
      expect((await workflow.enrollAsStaff(root, SAM_SLUG)).projectSlug).toBe(SAM_SLUG);
      expect((await workflow.enrollAsStaff(root, DANA_SLUG)).projectSlug).toBe(DANA_SLUG);
      await expect(workflow.enrollAsStaff(root, 'no-such-project')).rejects.toThrow(/unknown project/);
    });

    /**
     * The rule holds when no slug is named too. An instructor an admin has
     * seated in another teacher's class who sends `{}` goes through the
     * learner's resolution, whose step 2 is that class's project; the very
     * project `enrollAsStaff` refuses them by name. Naming nothing meets the
     * same rule, applied to what the resolution answers.
     */
    it("applies the same rule when an instructor names nothing, and refuses a class's project that is not theirs", async () => {
      await service.assign(sam, samCohortId, { projectVersionId: samPublished, reason });
      await manager().update(UserEntity, { id: danaId }, { cohort: samCohortId });
      const seated = { id: danaId, role: 'INSTRUCTOR', cohort: samCohortId };
      await expect(workflow.enrollAsStaff(dana, SAM_SLUG)).rejects.toThrow(NOT_YOUR_PROJECT);
      await expect(workflow.enrollAsStaff(seated)).rejects.toThrow(NOT_YOUR_PROJECT);
      expect(await staffRows(danaId)).toBe(0);

      // In no class, naming nothing starts the default, which is the platform's.
      await manager().update(UserEntity, { id: danaId }, { cohort: 'default' });
      const unseated = { id: danaId, role: 'INSTRUCTOR', cohort: 'default' };
      expect((await workflow.enrollAsStaff(unseated)).projectSlug).toBe(PLATFORM_SLUG);
      // Seated in their own class, naming nothing starts the class's project.
      expect((await workflow.enrollAsStaff(sam)).projectSlug).toBe(SAM_SLUG);
      // An admin seated anywhere is unrestricted, as by name.
      await manager().update(UserEntity, { id: root.id }, { cohort: samCohortId });
      expect((await workflow.enrollAsStaff({ ...root, cohort: samCohortId })).projectSlug).toBe(SAM_SLUG);
    });

    /**
     * The reading doors hold the same rule as the enrolment door. Otherwise
     * `GET /projects/:slug` would answer an instructor with any published
     * project's title, tagline, description and phase titles (another
     * teacher's unassigned one included) and `GET /projects` would list them
     * all. So both answer an instructor through the rule the enrolment door
     * applies, and a project outside it is the 404 an unknown slug gets, word
     * for word, so the refusal says nothing about what exists.
     */
    const asAuthUser = (who: { id: string; role: string; cohort: string }) =>
      ({ ...who, email: `${who.id}@learnsdlc.test` }) as unknown as AuthUser;
    const refusalOf = async (read: Promise<unknown>, slug: string): Promise<string> => {
      const failure = await read.then(
        () => null,
        (err: unknown) => err,
      );
      expect(failure).toBeInstanceOf(NotFoundException);
      return String((failure as NotFoundException).message).replace(slug, '<slug>');
    };

    it("answers an instructor naming another teacher's unassigned project with an unknown slug's 404", async () => {
      expect((await workflow.projectMetaForStaff(dana, PLATFORM_SLUG)).slug).toBe(PLATFORM_SLUG);
      expect((await workflow.projectMetaForStaff(dana, DANA_SLUG)).title).toBe('Ledger Lab');

      const foreign = await refusalOf(workflow.projectMetaForStaff(dana, SAM_SLUG), SAM_SLUG);
      const unknown = await refusalOf(
        workflow.projectMetaForStaff(dana, 'no-such-project'),
        'no-such-project',
      );
      expect(foreign).toBe(unknown);
      // Assigned to Sam's own class, it is still not Dana's to read.
      await service.assign(sam, samCohortId, { projectVersionId: samPublished, reason });
      await expect(workflow.projectMetaForStaff(dana, SAM_SLUG)).rejects.toThrow(NotFoundException);
      // Reading writes nothing.
      expect(await staffRows(danaId)).toBe(0);
    });

    it('lists an instructor only the projects they may start, and an admin every one', async () => {
      const slugs = async (who: { id: string; role: string; cohort: string }) =>
        (await workflow.catalogueForStaff(who)).map((meta) => meta.slug).sort();
      expect(await slugs(dana)).toEqual([DANA_SLUG, PLATFORM_SLUG].sort());
      expect(await slugs(sam)).toEqual([PLATFORM_SLUG, SAM_SLUG].sort());
      expect(await slugs(root)).toEqual([DANA_SLUG, PLATFORM_SLUG, SAM_SLUG].sort());
    });

    it("reads another teacher's project once it is assigned to a class the instructor owns", async () => {
      await service.assign(root, cohortId, { projectVersionId: samPublished, reason });
      expect((await workflow.projectMetaForStaff(dana, SAM_SLUG)).title).toBe('Rota Desk');
      expect((await workflow.catalogueForStaff(dana)).map((meta) => meta.slug)).toContain(SAM_SLUG);
    });

    it('leaves an admin reading every project by slug, and an unknown one still 404s', async () => {
      expect((await workflow.projectMetaForStaff(root, SAM_SLUG)).title).toBe('Rota Desk');
      await expect(workflow.projectMetaForStaff(root, 'no-such-project')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('routes both reads through the rule at the controller, for every role that is not a learner', async () => {
      const controller = new ProjectsController(workflow);
      const read = (who: { id: string; role: string; cohort: string }, slug: string) =>
        Promise.resolve().then(() => controller.get(asAuthUser(who), slug));
      await expect(read(dana, SAM_SLUG)).rejects.toThrow(NotFoundException);
      expect(((await read(root, SAM_SLUG)) as { slug: string }).slug).toBe(SAM_SLUG);
      const listed = (await controller.list(asAuthUser(dana))) as { slug: string }[];
      expect(listed.map((meta) => meta.slug)).not.toContain(SAM_SLUG);
    });
  });

  /* ---- what the class card says a version holds ---- */

  describe("a version's provenance, on the card and on the assignment", () => {
    const withContent = () => new CohortProjectService(dataSource, content);

    /** Reinstall every published row the registry held, plus one more version built from `edit`. */
    const installOwn = async (edit: (clone: ReturnType<ContentService['getProject']>) => void): Promise<string> => {
      const base = content.getProject(PLATFORM_SLUG);
      const clone = JSON.parse(JSON.stringify({ ...base, slug: DANA_SLUG, title: 'Ledger Lab', version: '2.2.0' }));
      edit(clone);
      const row = await manager().save(
        manager().create(ProjectVersionEntity, {
          projectId: danaProjectId,
          version: '2.2.0',
          status: 'published',
          manifest: { tagline: base.tagline, description: base.description, language: base.language, languages: base.languages },
          compiled: { slug: DANA_SLUG, version: '2.2.0', content: clone, compiler: COMPILER_IDENTITY } as never,
          publishedAt: new Date().toISOString(),
          publishedByUserId: null,
        } as unknown as ProjectVersionEntity),
      );
      const rows = await manager().find(ProjectVersionEntity, { where: { status: 'published' } });
      content.installVersions(
        rows
          .filter((one) => one.compiled)
          .map((one) => ({ versionId: one.id, content: (one.compiled as unknown as { content: never }).content, compiler: COMPILER_IDENTITY })) as never,
      );
      return row.id;
    };

    it("says every written phase is the reference's, and the application too, for an untouched version", async () => {
      const offered = await withContent().assignable(dana, cohortId);
      expect(offered.length).toBeGreaterThan(0);
      for (const one of offered) {
        expect([one.version, one.provenance]).toEqual([
          one.version,
          { ownPhases: 0, mixedPhases: 0, referencePhases: 2, applicationFrom: 'TaskTrackr' },
        ]);
      }
    });

    it("counts a written phase the teacher changed, and carries the same line on the assignment in force", async () => {
      const own = await installOwn((clone) => {
        const requirements = clone.phases.find((phase: { key: string }) => phase.key === 'requirements')!;
        requirements.intro = 'Book a meeting room: in this phase you interview the facilities manager.';
      });
      const card = withContent();
      const offered = await card.assignable(dana, cohortId);
      expect(offered.find((one) => one.versionId === own)?.provenance).toEqual({
        ownPhases: 0,
        mixedPhases: 1,
        referencePhases: 1,
        applicationFrom: 'TaskTrackr',
      });
      const assigned = await card.assign(dana, cohortId, { projectVersionId: own, reason });
      expect(assigned.active?.provenance).toEqual({ ownPhases: 0, mixedPhases: 1, referencePhases: 1, applicationFrom: 'TaskTrackr' });
      expect((await card.read(dana, cohortId)).active?.provenance).toEqual(assigned.active?.provenance);
    });

    it('says nothing it cannot read: no registry, or a version the registry does not hold, carries no provenance', async () => {
      for (const one of await service.assignable(dana, cohortId)) expect(one).not.toHaveProperty('provenance');
      const assigned = await withContent().assign(dana, cohortId, { projectVersionId: danaPublished, reason });
      await manager().update(CohortProjectAssignmentEntity, { id: assigned.active!.id }, { projectVersionId: danaUncompiled });
      const read = await withContent().read(dana, cohortId);
      expect(read.active).not.toBeNull();
      expect(read.active).not.toHaveProperty('provenance');
    });
  });
});

import 'reflect-metadata';
import * as path from 'path';
import { DataSource, EntityManager, UpdateQueryBuilder } from 'typeorm';
import {
  DRAFT_FIRST_VERSION,
  EXECUTABLE_SPLIT_NOT_READY,
  INHERITED_TASK_KEY,
  MULTI_TASK_CHECK_ID,
  QUIZ_ONLY_ADD_REFUSAL,
  TASK_KEY_INVALID,
  draftAlreadyOpenRefusal,
  draftFromStaleHeadRefusal,
  inheritedTaskRefusal,
  nothingPublishedRefusal,
  multiTaskPublishRefusal,
  noRequiredTaskRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  unsupportedLibraryRefusal,
  plainTextOf,
} from '@learnsdlc/shared';
import { config } from '../config';
import { AccountService } from '../account/account.service';
import { AuditEventEntity, EnrollmentEntity, UserEntity } from '../db/entities';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import type { CompiledSnapshot } from '../content/pack-compiler';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import {
  FIXTURE_QUIZ_NOTICE,
  fixtureQuizChecks,
  fixtureQuizRubric,
} from '../../test/quiz-fixture';
import { HOST_PHASE, HOST_QUIZ_KEYS, addHostQuizzes, hostQuizBody, importHostPack } from '../../test/written-phase-pack';
import { AuthoringService, withdrawnProjectRefusal } from './authoring.service';
import { memoryDataSource } from '../../test/support/memory-db';

const TEACHER = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };
const OTHER_TEACHER = { id: 'teacher-2', role: 'INSTRUCTOR' as const, cohort: 'default' };
const ADMIN = { id: 'admin-1', role: 'ADMIN' as const, cohort: 'default' };

/** The shape `exportData` hands a teacher back, as this file reads it. */
interface AuthoredExport {
  slug: string;
  title: string;
  versions: {
    version: string;
    status: string;
    phases: {
      key: string;
      title: string;
      tasks: { taskKey: string; title: string; brief: string; rules: { id: string }[] }[];
    }[];
  }[];
}

/**
 * The teacher's half of teacher-authored projects: list, copy, author, validate,
 * publish.
 *
 * Three properties are what this file is for, and they are asked of the real
 * shipped pack rather than of a fixture, because the fixture that matters is
 * the one project the platform actually ships: the one with hidden suites,
 * solutions, mutants and a customer interview in it.
 *
 * - **A teacher edits only what is theirs.** The platform's project is
 *   assignable and copyable and never editable in place; another teacher's is
 *   invisible; and ADMIN is the role that reads everything, not the role that
 *   edits everybody's.
 * - **Sealed bytes never leave through an authoring door.** Every route is
 *   walked against a copy that holds the shipped pack's sealed material and its
 *   contents are asserted absent from every response.
 * - **Publish cannot ship a phase the learner runtime cannot serve.** The gate
 *   is one constant, the refusal names the phase, and the draft keeps the work.
 */
describe('the authoring service', () => {
  let dataSource: DataSource;
  let importer: ProjectImporterService;
  let content: ContentService;
  let registry: ProjectRegistryService;
  let service: AuthoringService;
  let seedProjectId = '';
  let seedVersionId = '';

  /** Everything the seed wrote, so "TaskTrackr is unchanged" is a real assertion. */
  const seedFingerprint = async (): Promise<Record<string, unknown>> => {
    const project = await dataSource
      .getRepository(ProjectEntity)
      .findOneByOrFail({ id: seedProjectId });
    const versions = await dataSource
      .getRepository(ProjectVersionEntity)
      .find({ where: { projectId: seedProjectId }, order: { version: 'ASC' } });
    const phases = await dataSource
      .getRepository(ProjectPhaseEntity)
      .find({ where: { projectVersionId: seedVersionId }, order: { order: 'ASC' } });
    const files = await dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: seedVersionId }, order: { path: 'ASC' } });
    return {
      project: { slug: project.slug, title: project.title, owner: project.ownerUserId, isDefault: project.isDefault },
      versions: versions.map((one) => ({ version: one.version, status: one.status, digest: one.contentDigest })),
      phases: phases.map((one) => ({ key: one.key, title: one.title, order: one.order })),
      files: files.map((one) => ({ path: one.path, role: one.role, editable: one.editable, sha: one.blobSha })),
    };
  };

  const copyOfTheDefault = async (slug: string, title: string, caller = TEACHER) =>
    service.createProject(caller, { title, slug, fromVersionId: seedVersionId });

  /**
   * A copy of the story host (`test/written-phase-pack.ts`): Shelf's
   * Requirements phase, holding its one story task, to which a case adds the
   * host's quizzes (`addHostQuizzes`) when it needs a phase of several tasks.
   */
  let hostVersionId = '';
  const copyOfTheHost = async (slug: string, title: string, caller = TEACHER) =>
    service.createProject(caller, { title, slug, fromVersionId: hostVersionId });

  /** One task row of a draft, which is where the checks a grader will read live. */
  const taskRowFor = async (versionId: string, phaseKey: string, taskKey: string) => {
    const phase = await dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
    return dataSource
      .getRepository(ProjectTaskEntity)
      .findOneByOrFail({ projectPhaseId: phase.id, taskKey });
  };

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    importer = new ProjectImporterService(content, dataSource);
    registry = new ProjectRegistryService(content, dataSource, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);

    const imported = await importer.importPack(
      new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')),
      { origin: 'seed', platformOwned: true },
    );
    seedProjectId = imported.projectId;
    seedVersionId = imported.projectVersionId;
    await dataSource
      .getRepository(ProjectEntity)
      .update({ id: seedProjectId }, { isDefault: true });
    await registry.load();

    service = new AuthoringService(dataSource, importer, registry);
    hostVersionId = await importHostPack({ content, dataSource, registry }, { slug: 'release-authoring' });
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  /* ----------------------------- the library ----------------------------- */

  describe('the library', () => {
    it('shows the platform project as copyable and as nobody\'s to edit', async () => {
      const view = await service.listProjects(TEACHER);

      const seed = view.library.find((one) => one.id === seedProjectId);
      expect(seed).toBeDefined();
      expect(seed?.platformOwned).toBe(true);
      expect(seed?.mine).toBe(false);
      expect(seed?.isDefault).toBe(true);
      expect(seed?.publishedVersionId).toBe(seedVersionId);
      expect(view.mine.find((one) => one.id === seedProjectId)).toBeUndefined();
    });
  });

  /* --------------------------- create by copy ---------------------------- */

  describe('creating a project by copying one', () => {
    it('opens a draft the teacher owns, with the source\'s files by reference', async () => {
      const before = await seedFingerprint();
      const blobsBefore = await dataSource.getRepository(ContentBlobEntity).count();

      const made = await copyOfTheDefault('my-tracker', 'My Tracker');

      expect(made.draftVersion).toBe(DRAFT_FIRST_VERSION);
      expect(made.project.mine).toBe(true);
      expect(made.project.platformOwned).toBe(false);
      expect(made.project.origin).toBe('fork');
      expect(made.project.isDefault).toBe(false);
      expect(made.project.draftVersionId).toBe(made.draftVersionId);
      expect(made.project.publishedVersion).toBeNull();

      // metadata copied, bytes referenced: a hundred forks are one copy
      const source = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: seedVersionId } });
      const copied = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: made.draftVersionId } });
      expect(copied).toHaveLength(source.length);
      expect(await dataSource.getRepository(ContentBlobEntity).count()).toBe(blobsBefore);

      // and the platform's own project did not move
      expect(await seedFingerprint()).toEqual(before);
    });

    it('can never re-role a sealed row it copied', async () => {
      const made = await copyOfTheDefault('role-copy', 'Role Copy');
      const source = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: seedVersionId } });
      const copied = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: made.draftVersionId } });

      const roleAt = new Map(source.map((row) => [`${row.ownerId}|${row.path}`, row.role]));
      // the owner ids differ between versions, so compare by path and role counts
      const countRoles = (rows: typeof source) => {
        const out: Record<string, number> = {};
        for (const row of rows) out[row.role] = (out[row.role] ?? 0) + 1;
        return out;
      };
      expect(countRoles(copied)).toEqual(countRoles(source));
      expect(roleAt.size).toBeGreaterThan(0);

      // and the one door that could change a role refuses to
      const sealed = copied.find((row) => row.role === 'hidden');
      expect(sealed).toBeDefined();
      await expect(
        importer.updateFile(dataSource.manager, sealed!.id, {
          role: 'workspace',
        } as unknown as Parameters<typeof importer.updateFile>[2]),
      ).rejects.toThrow(/role is set when the row is created and never changed/);
    });

    it('materialises the inherited sole task under a key the editor can address', async () => {
      const made = await copyOfTheDefault('materialised', 'Materialised');
      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);

      expect(draft.phases).toHaveLength(6);
      for (const phase of draft.phases) {
        expect(phase.tasks).toHaveLength(1);
        expect(phase.tasks[0].taskKey).toBe(INHERITED_TASK_KEY);
        expect(phase.tasks[0].taskKey).not.toBe('');
        expect(phase.blocksPublish).toBe(false);
      }

      // the requirements and design tasks are prose a teacher may write; the
      // rest arrive with the project and say so
      const byKey = new Map(draft.phases.map((phase) => [phase.key, phase.tasks[0]]));
      expect(byKey.get('requirements')?.authorable).toBe(true);
      expect(byKey.get('design')?.authorable).toBe(true);
      for (const key of ['implementation', 'testing', 'deployment', 'maintenance'] as const) {
        expect(byKey.get(key)?.authorable).toBe(false);
        expect(byKey.get(key)?.notice).toContain('Inherited from the project you copied');
      }
      // and no minted path: the story task's record and the design task's
      // documents are no prose files, so they read none
      expect(byKey.get('design')?.artefactPath).toBeNull();
      expect(byKey.get('requirements')?.artefactPath).toBeNull();
    });

    it('refuses a slug that is already a project, and a slug of the wrong shape', async () => {
      await copyOfTheDefault('taken-slug', 'Taken');

      await expect(copyOfTheDefault('taken-slug', 'Taken Again')).rejects.toThrow(/already/i);
      await expect(
        service.createProject(TEACHER, { title: 'Bad', slug: 'Not A Slug', fromVersionId: seedVersionId }),
      ).rejects.toThrow(/lower case/i);
    });
  });

  /* ----------------------------- who may edit ---------------------------- */

  describe('who may edit what', () => {
    it("refuses an edit to the platform's project by name, and still lets it be copied", async () => {
      const seed = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedProjectId });

      await expect(
        service.updateMeta(TEACHER, seedProjectId, { title: 'Mine now' }),
      ).rejects.toThrow(platformProjectCopyOnlyRefusal(seed.title));

      // the copy door is open
      await expect(copyOfTheDefault('still-copyable', 'Still Copyable')).resolves.toBeDefined();
    });

    it("hides another teacher's project entirely, and refuses a write to one it can see", async () => {
      const mine = await copyOfTheDefault('teacher-one-project', 'Teacher One');

      // invisible: a 404 by the written policy, so guessing ids tells nobody anything
      await expect(service.getProject(OTHER_TEACHER, mine.project.id)).rejects.toThrow(
        /no project with that id/i,
      );
      const theirs = await service.listProjects(OTHER_TEACHER);
      expect(theirs.mine.map((one) => one.id)).not.toContain(mine.project.id);
      expect(theirs.library.map((one) => one.id)).not.toContain(mine.project.id);

      // ADMIN reads everything and still may not edit somebody else's
      await expect(service.getProject(ADMIN, mine.project.id)).resolves.toBeDefined();
      await expect(service.updateMeta(ADMIN, mine.project.id, { title: 'Admin edit' })).rejects.toThrow(
        projectNotYoursRefusal(),
      );
    });
  });

  /* ------------------------------- the tasks ----------------------------- */

  describe('authoring tasks in a draft', () => {
    it('adds a quiz beside the story task, and the phase does not block the publish', async () => {
      // the host (Shelf's Requirements) is a story phase: the task a teacher adds to it is a quiz
      const made = await copyOfTheHost('task-add', 'Task Add');
      const result = await service.addTask(TEACHER, made.project.id, made.draftVersionId, HOST_PHASE, hostQuizBody('late-marker'));

      const added = result.phase.tasks.find((one) => one.taskKey === 'late-marker');
      // a quiz owns no file, and its rubric is its one derived criterion
      expect(added?.artefactPath).toBeNull();
      expect(added?.required).toBe(true);
      expect(added?.order).toBe(2);
      expect(added?.rubric.criteria).toHaveLength(1);

      // and the phase does NOT block the publish: the learner runtime serves a
      // quiz beside the phase's work task. The same act in a phase the code
      // grader marks is what is still refused: 'says exactly why publish
      // would refuse' below.
      expect(result.phase.blocksPublish).toBe(false);
      expect(result.phase.checkKind).toBe('story');
      expect(result.validation.publishable).toBe(true);
      expect(result.validation.blocking).toEqual([]);
    });

    it('refuses a task key a learner\'s state could not follow', async () => {
      const made = await copyOfTheDefault('bad-key', 'Bad Key');

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
          taskKey: 'Late Marker',
          title: 'The late marker',
          brief: 'brief',
        }),
      ).rejects.toThrow(TASK_KEY_INVALID);
    });

    it('refuses a task that is not a concept quiz beside an executable phase\'s own task', async () => {
      const made = await copyOfTheDefault('bad-type', 'Bad Type');

      await expect(
        service.addTask(TEACHER, made.project.id, made.draftVersionId, 'implementation', {
          taskKey: 'api',
          title: 'Build the API',
          brief: 'brief',
          artefactType: 'code',
        }),
      ).rejects.toThrow(QUIZ_ONLY_ADD_REFUSAL);
    });

    it('refuses every edit to a task that came with the copied project', async () => {
      const made = await copyOfTheDefault('inherited-edits', 'Inherited Edits');
      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      const implementation = draft.phases.find((one) => one.key === 'implementation')!;
      const inherited = implementation.tasks[0];

      const refusal = inheritedTaskRefusal(inherited.title);
      // Every TaskTrackr 5.0.0 task's words now have an arm (the executable
      // editor, the design and story builders, the runbook arm), so no title
      // edit is refused here; the required and remove doors below still refuse
      // the implementation task itself.
      await expect(
        service.setTaskRequired(TEACHER, made.project.id, made.draftVersionId, 'implementation', inherited.taskKey, {
          required: false,
        }),
      ).rejects.toThrow(refusal);
      await expect(
        service.removeTask(TEACHER, made.project.id, made.draftVersionId, 'implementation', inherited.taskKey),
      ).rejects.toThrow(refusal);
    });

    it('carries the whole ordering at once, and may not add or drop a key', async () => {
      const made = await copyOfTheDefault('ordering', 'Ordering');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', hostQuizBody('late-marker'));

      const moved = await service.reorderTasks(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
        taskKeys: ['late-marker', INHERITED_TASK_KEY],
      });
      expect(moved.phase.tasks.map((one) => one.taskKey)).toEqual(['late-marker', INHERITED_TASK_KEY]);
      expect(moved.phase.tasks.map((one) => one.order)).toEqual([1, 2]);

      await expect(
        service.reorderTasks(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
          taskKeys: ['late-marker'],
        }),
      ).rejects.toThrow(/every task/i);
      await expect(
        service.reorderTasks(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
          taskKeys: ['late-marker', INHERITED_TASK_KEY, 'invented'],
        }),
      ).rejects.toThrow(/every task/i);
    });

    it('removes a task a teacher added, and leaves the rest alone', async () => {
      // Maintenance takes a concept quiz beside its code task; a quiz owns no
      // file, so the phase's files are the copy's after it leaves (an older
      // draft's written task takes its minted file with it: importer.spec)
      const made = await copyOfTheDefault('task-remove', 'Task Remove');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', hostQuizBody('late-marker'));

      const after = await service.removeTask(
        TEACHER,
        made.project.id,
        made.draftVersionId,
        'maintenance',
        'late-marker',
      );

      expect(after.phase.tasks.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
      expect(after.validation.publishable).toBe(true);
      // the inherited task's own record is untouched
      expect(
        await dataSource.getRepository(ProjectFileEntity).findOneBy({
          projectVersionId: made.draftVersionId,
          path: 'maintenance/change-request.json',
        }),
      ).not.toBeNull();
    });
  });

  /* ------------------------------ validation ----------------------------- */

  describe('the fast validation tier', () => {
    it('says exactly why publish would refuse, and publish says the same words', async () => {
      const made = await copyOfTheDefault('gate-words', 'Gate Words');
      // A phase the CODE grader marks holding a second graded task: the shape
      // the editor and the door still have to agree about. No door adds one
      // beside a phase's own work any more, so it is written by hand, as an
      // older draft could hold it.
      const phaseRow = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: made.draftVersionId, key: 'implementation' as never });
      const taskRows = dataSource.getRepository(ProjectTaskEntity);
      const own = await taskRows.findOneByOrFail({ projectPhaseId: phaseRow.id, taskKey: INHERITED_TASK_KEY });
      await taskRows.save(taskRows.create({ ...own, id: undefined, taskKey: 'late-marker', order: 2, title: 'The late marker' }));
      const validation = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const phase = (await service.readDraft(TEACHER, made.project.id, made.draftVersionId)).phases.find((one) => one.key === 'implementation')!;
      const result = { phase, validation };

      const sentence = multiTaskPublishRefusal(result.phase.title, 2, 'code');
      expect(sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);
      expect(result.phase.checkKind).toBe('code');
      expect(result.validation.blocking).toContain(sentence);
      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' }),
      ).rejects.toThrow(sentence);

      // and the draft keeps both tasks: only the publish was refused
      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      expect(draft.phases.find((one) => one.key === 'implementation')?.tasks).toHaveLength(2);
      expect(draft.status).toBe('draft');
    });

    it('refuses a phase no learner could ever pass', async () => {
      const made = await copyOfTheDefault('no-required', 'No Required');
      const result = await service.setTaskRequired(
        TEACHER,
        made.project.id,
        made.draftVersionId,
        'requirements',
        INHERITED_TASK_KEY,
        { required: false },
      );

      const title = result.phase.title;
      expect(result.validation.blocking).toContain(noRequiredTaskRefusal(title));
      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' }),
      ).rejects.toThrow(noRequiredTaskRefusal(title));
    });

    it('measures the runtime block against the runner the deployment bakes', async () => {
      const made = await copyOfTheDefault('unsupported-stack', 'Unsupported Stack');
      const version = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      await dataSource.getRepository(ProjectVersionEntity).update(
        { id: made.draftVersionId },
        {
          manifest: {
            ...version.manifest,
            runtime: {
              ...(version.manifest.runtime ?? {}),
              python: {
                version: version.manifest.runtime?.python?.version ?? '3.11',
                packages: [...(version.manifest.runtime?.python?.packages ?? []), 'pandas==2.2.0'],
              },
            },
          },
        },
      );

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      expect(report.blocking).toContain(unsupportedLibraryRefusal('python', 'pandas'));
      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' }),
      ).rejects.toThrow(unsupportedLibraryRefusal('python', 'pandas'));
    });

    it('stores the last report, so the editor reads it without running it again', async () => {
      const made = await copyOfTheDefault('stored-report', 'Stored Report');
      const ran = await service.validate(TEACHER, made.project.id, made.draftVersionId);

      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      expect(draft.validation?.ranAt).toBe(ran.ranAt);
      expect(draft.validation?.publishable).toBe(ran.publishable);

      const summary = (await service.listProjects(TEACHER)).mine.find(
        (one) => one.id === made.project.id,
      );
      expect(summary?.lastValidatedAt).toBe(ran.ranAt);
    });

    it('rewrites the report but not the megabyte, when nothing about the pack moved', async () => {
      const made = await copyOfTheDefault('idle-validate', 'Idle Validate');
      const first = await service.validate(TEACHER, made.project.id, made.draftVersionId);

      // Every write to the version row, `manager.update` and persist()'s
      // compare-and-swap alike, is an UpdateQueryBuilder; its values are the
      // patch.
      const patches: Record<string, unknown>[] = [];
      const real = UpdateQueryBuilder.prototype.execute;
      const spy = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(function (this: any) {
        if (this.expressionMap?.mainAlias?.target === ProjectVersionEntity) {
          patches.push({ ...(this.expressionMap.valuesSet as Record<string, unknown>) });
        }
        return real.call(this);
      } as never);

      let second: Awaited<ReturnType<typeof service.validate>>;
      try {
        second = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      } finally {
        spy.mockRestore();
      }

      expect(patches.length).toBeGreaterThan(0);
      expect(patches.every((patch) => !('compiled' in patch))).toBe(true);
      expect(patches.some((patch) => 'validation' in patch)).toBe(true);
      // and the report is still the one the editor reads back
      const draft = await service.readDraft(TEACHER, made.project.id, made.draftVersionId);
      expect(draft.validation?.ranAt).toBe(second.ranAt);
      expect(second.ranAt).not.toBe(first.ranAt);
      // the snapshot it did not rewrite is still the right one
      expect(draft.phases).toHaveLength(6);
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
    });

    it('does rewrite it when a task moves', async () => {
      const made = await copyOfTheDefault('moved-pack', 'Moved Pack');
      await service.validate(TEACHER, made.project.id, made.draftVersionId);

      // Every write to the version row, `manager.update` and persist()'s
      // compare-and-swap alike, is an UpdateQueryBuilder; its values are the
      // patch.
      const patches: Record<string, unknown>[] = [];
      const real = UpdateQueryBuilder.prototype.execute;
      const spy = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(function (this: any) {
        if (this.expressionMap?.mainAlias?.target === ProjectVersionEntity) {
          patches.push({ ...(this.expressionMap.valuesSet as Record<string, unknown>) });
        }
        return real.call(this);
      } as never);

      try {
        await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', INHERITED_TASK_KEY, {
          title: 'A title of my own',
        });
      } finally {
        spy.mockRestore();
      }

      expect(patches.some((patch) => 'compiled' in patch)).toBe(true);
    });
  });

  /* ------------------------------- publish ------------------------------- */

  describe('publishing', () => {
    it('freezes the draft and makes the version resolvable through the content service', async () => {
      const made = await copyOfTheDefault('publishable', 'Publishable');
      const published = await service.publish(TEACHER, made.project.id, made.draftVersionId, {
        version: '1.0.0',
        notes: 'first cut',
      });

      expect(published.version).toBe('1.0.0');
      expect(published.validation.publishable).toBe(true);
      expect(published.sandboxBudget).toBeGreaterThan(0);

      const row = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      expect(row.status).toBe('published');
      expect(row.publishedByUserId).toBe(TEACHER.id);
      expect(row.compiled?.version).toBe('1.0.0');
      expect(row.compiled?.slug).toBe('publishable');

      await registry.load();
      const project = content.getProject('publishable');
      expect(project.version).toBe('1.0.0');
      expect(project.phases.map((one) => one.key)).toEqual([
        'requirements',
        'design',
        'implementation',
        'testing',
        'deployment',
        'maintenance',
      ]);
    });

    it('refuses every write to a version that is no longer a draft', async () => {
      const made = await copyOfTheDefault('frozen', 'Frozen');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });

      await expect(
        service.setTaskRequired(TEACHER, made.project.id, made.draftVersionId, 'requirements', INHERITED_TASK_KEY, {
          required: false,
        }),
      ).rejects.toThrow(/Version 1\.0\.0 is published, and a published version never changes/);
      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.1' }),
      ).rejects.toThrow(/published/);
    });

    it('refuses a version that is not newer than one already published', async () => {
      const made = await copyOfTheDefault('version-order', 'Version Order');

      await expect(
        service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0' }),
      ).rejects.toThrow(/MAJOR\.MINOR\.PATCH/);
    });

    it('leaves one audit row per mutation, naming the actor and what moved', async () => {
      const before = await dataSource.getRepository(AuditEventEntity).count();
      const made = await copyOfTheDefault('audited', 'Audited');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', hostQuizBody('late-marker'));
      await service.removeTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', 'late-marker');
      await service.validate(TEACHER, made.project.id, made.draftVersionId);
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });

      const rows = await dataSource.getRepository(AuditEventEntity).find();
      const written = rows.slice(before);
      // `createdAt` is a second-resolution stamp and five writes land inside
      // one, so this asserts one row per mutation and which rows they are,
      // not an ordering the column cannot provide.
      expect(written.map((one) => one.event).sort()).toEqual(
        ['project.create', 'project.publish', 'project.tasks', 'project.tasks', 'project.validate'].sort(),
      );
      for (const one of written) {
        expect(one.actorUserId).toBe(TEACHER.id);
        expect(one.subjectUserId).toBe(TEACHER.id);
        expect(one.targetId).toBe(made.project.id);
        expect(one.detail).not.toBeNull();
      }
    });

    it('refuses to archive a project a learner is pinned to', async () => {
      const made = await copyOfTheDefault('pinned', 'Pinned');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      await dataSource.getRepository(EnrollmentEntity).save(
        dataSource.getRepository(EnrollmentEntity).create({
          userId: 'learner-1',
          projectSlug: 'pinned',
          projectVersionId: made.draftVersionId,
        }),
      );

      await expect(service.archiveProject(TEACHER, made.project.id)).rejects.toThrow(
        /learner/i,
      );
    });

    it('refuses to archive a project a learner resolves by slug, with no pin at all', async () => {
      const made = await copyOfTheDefault('head-resolved', 'Head Resolved');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      // what every enrolment through the front door looks like: the pin is
      // null and the read resolves the published head
      await dataSource.getRepository(EnrollmentEntity).save(
        dataSource.getRepository(EnrollmentEntity).create({
          userId: 'learner-head',
          projectSlug: 'head-resolved',
          projectVersionId: null,
        }),
      );

      await expect(service.archiveProject(TEACHER, made.project.id)).rejects.toThrow(
        /1 learner is/,
      );
      // and nothing was archived under them
      const versions = await dataSource
        .getRepository(ProjectVersionEntity)
        .find({ where: { projectId: made.project.id } });
      expect(versions.every((one) => one.status !== 'archived')).toBe(true);
    });
  });

  /* -------------------------------- the seal ----------------------------- */

  describe('the seal on sealed bytes', () => {
    it('never carries a hidden test, a solution or an interview through any door', async () => {
      const made = await copyOfTheDefault('sealed-walk', 'Sealed Walk');

      // the bytes the copy holds under a sealed role, straight from the store
      const sealedRows = await dataSource.getRepository(ProjectFileEntity).find({
        where: { projectVersionId: made.draftVersionId },
      });
      const sealedShas = sealedRows
        .filter((row) => row.role !== 'workspace' && row.role !== 'warmup')
        .map((row) => row.blobSha);
      expect(sealedShas.length).toBeGreaterThan(0);
      const blobs = await dataSource.getRepository(ContentBlobEntity).find();
      const bytesBySha = new Map(blobs.map((blob) => [blob.sha, blob.bytes]));
      const secrets = [...new Set(sealedShas)]
        .map((sha) => bytesBySha.get(sha) ?? '')
        .filter((bytes) => bytes.trim().length > 40);
      expect(secrets.length).toBeGreaterThan(0);

      const responses: unknown[] = [
        await service.listProjects(TEACHER),
        await service.getProject(TEACHER, made.project.id),
        await service.readDraft(TEACHER, made.project.id, made.draftVersionId),
        await service.validate(TEACHER, made.project.id, made.draftVersionId),
        await service.listTasks(TEACHER, made.project.id, made.draftVersionId, 'implementation'),
        await service.listFiles(TEACHER, made.project.id, made.draftVersionId),
        await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', hostQuizBody('postmortem')),
        await service.updateTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', 'postmortem', {
          title: 'The postmortem, rewritten',
        }),
        await service.setTaskRequired(TEACHER, made.project.id, made.draftVersionId, 'maintenance', 'postmortem', {
          required: false,
        }),
        await service.removeTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', 'postmortem'),
        await service.updateMeta(TEACHER, made.project.id, { tagline: 'A tracker of my own' }),
      ];

      const wire = JSON.stringify(responses);
      for (const secret of secrets) {
        expect(wire).not.toContain(secret);
      }
    });

    it('shows every file row with its role and size, and bytes for the two learner-facing roles', async () => {
      const made = await copyOfTheDefault('file-tree', 'File Tree');
      const files = await service.listFiles(TEACHER, made.project.id, made.draftVersionId);

      expect(files.length).toBeGreaterThan(100);
      for (const file of files) {
        expect(file.size).toBeGreaterThanOrEqual(0);
        if (file.role === 'workspace' || file.role === 'warmup') {
          expect(file.sealed).toBe(false);
          expect(typeof file.content).toBe('string');
          expect(file.notice).toBeNull();
        } else {
          expect(file.sealed).toBe(true);
          expect(file.content).toBeNull();
          expect(file.notice).not.toBeNull();
        }
      }
      // the roles the shipped pack actually seals are all there, withheld
      const sealedRoles = new Set(files.filter((file) => file.sealed).map((file) => file.role));
      expect([...sealedRoles].sort()).toEqual(
        expect.arrayContaining(['hidden', 'mutant', 'solution']),
      );
      expect(files.filter((file) => file.sealed).every((file) => file.content === null)).toBe(true);
    });
  });

  /* ------------------- what actually scores a learner --------------------- */

  /**
   * The half of authoring nothing else asks about: a teacher's writing has to
   * reach the grader, and nothing the platform already graded may fall out of
   * it on the way.
   *
   * The grader reads a *phase* (`buildFeedback` switches on
   * `phase.checks.kind` and each builder scores against
   * `phase.rubric`) so every assertion here is about the compiled phase the
   * registry serves, not about the row the editor drew.
   */
  describe('the rules that reach the grader', () => {
    it('copies the inherited Design task as a design task grading both contracts beside the record (no inherited written task is left to edit)', async () => {
      const made = await copyOfTheDefault('design-targets', 'Design Targets');
      const before = await taskRowFor(made.draftVersionId, 'design', INHERITED_TASK_KEY);
      // TaskTrackr's Design task grades the record with both contracts switched on
      expect(before.checks).toMatchObject({ kind: 'design', record: 'design/design.json', contracts: { api: true, screens: true } });
    });

    it('leaves an untouched copy scored by exactly the pack it copied', async () => {
      const made = await copyOfTheDefault('untouched-scoring', 'Untouched Scoring');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      await registry.load();

      const seed = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedProjectId });
      const source = content.getProject(seed.slug);
      for (const phase of content.getProject('untouched-scoring').phases) {
        const was = source.phases.find((one) => one.key === phase.key)!;
        expect(phase.checks).toEqual(was.checks);
        expect(phase.rubric).toEqual(was.rubric);
        expect(phase.taskPanel).toEqual(was.taskPanel);
      }
    });
  });

  /* ------------------ the publish assembles a phase ------------------ */

  /** How a published phase is assembled from its one task. */
  describe('a written phase a teacher edited', () => {
    it('a one-task phase\'s publish is byte-identical', async () => {
      // every copied project and every phase a teacher left alone compiles to
      // exactly what it did
      const made = await copyOfTheDefault('unsplit', 'Unsplit');
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      await registry.load();

      const seed = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedProjectId });
      const source = content.getProject(seed.slug);
      for (const phase of content.getProject('unsplit').phases) {
        const was = source.phases.find((one) => one.key === phase.key)!;
        expect(phase.checks).toEqual(was.checks);
        expect(phase.rubric).toEqual(was.rubric);
      }

      // and a phase a teacher edited but did not split keeps the lead task's
      // slice as the phase's, which is the ordinary overlay (on the host: its
      // story task, its rubric reweighted and one criterion reworded by the
      // teacher)
      const edited = await copyOfTheHost('unsplit-edited', 'Unsplit Edited');
      await service.updateTask(TEACHER, edited.project.id, edited.draftVersionId, HOST_PHASE, INHERITED_TASK_KEY, {
        rubric: {
          passThreshold: 70,
          criteria: [
            { key: 'story_quality', title: 'Story', description: 'Who wants it, what they want, and why.', weight: 0.3 },
            {
              key: 'acceptance_criteria',
              title: 'Acceptance criteria',
              description: 'Criteria a tester could run as written, the book already on loan among them.',
              weight: 0.5,
            },
            { key: 'completeness', title: 'Completeness', description: 'Enough criteria and scope lines to say what is in and what is left out.', weight: 0.2 },
          ],
        },
      });
      await service.publish(TEACHER, edited.project.id, edited.draftVersionId, { version: '1.0.0' });
      await registry.load();

      const only = content
        .getProject('unsplit-edited')
        .phases.find((one) => one.key === HOST_PHASE)!;
      const row = await taskRowFor(edited.draftVersionId, HOST_PHASE, INHERITED_TASK_KEY);
      expect(only.checks).toEqual(row.checks);
      expect(only.rubric).toEqual(row.rubric);
      // the row is the teacher's, not the pack's: had publish ignored it, the
      // phase would still hold the pack's rubric
      const pack = content.getProject('release-authoring').phases.find((one) => one.key === HOST_PHASE)!;
      expect(row.rubric).not.toEqual(pack.rubric);
    });

    it('leaves an executable phase for the compiler to refuse, in the compiler\'s own words', async () => {
      // the wall is `tasks-in-a-phase-share-one-kind`'s sentence to say; this
      // derivation has no rules to union on a `code` phase and must not
      // rewrite one on the way past
      const made = await copyOfTheDefault('split-code', 'Split Code');
      const before = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      const was = (before.compiled as CompiledSnapshot).content.phases.find(
        (one) => one.key === 'implementation',
      )!;

      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: made.draftVersionId, key: 'implementation' as never });
      const inherited = await dataSource
        .getRepository(ProjectTaskEntity)
        .findOneByOrFail({ projectPhaseId: phase.id, taskKey: INHERITED_TASK_KEY });
      await dataSource.getRepository(ProjectTaskEntity).save(
        dataSource.getRepository(ProjectTaskEntity).create({
          ...inherited,
          id: undefined,
          taskKey: 'second',
          order: 2,
          artefactPath: null,
        }),
      );

      const report = await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const after = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      const now = (after.compiled as CompiledSnapshot).content.phases.find(
        (one) => one.key === 'implementation',
      )!;

      expect(now.checks).toEqual(was.checks);
      expect(now.rubric).toEqual(was.rubric);
      expect(report.publishable).toBe(false);
      // and the gate row carries the one sentence, whatever the compiler said
      const gate = report.checks.find(
        (one) => one.id === MULTI_TASK_CHECK_ID && one.phaseKey === 'implementation',
      )!;
      expect(gate.status).toBe('failed');
      expect(gate.sentence).toContain(EXECUTABLE_SPLIT_NOT_READY);
    });
  });

  /* ---------------------- quizzes: which row is first ---------------------- */

  /**
   * Two regions of one file, taken together because both answer *which row is
   * first*, and fixing one without the other is the same defect moved.
   *
   * If `createProject` materialised only one row per phase, a quiz ordered
   * second would be dropped without a word and a quiz ordered first would
   * become the copy's `main` while the artefact task was dropped: a copy that
   * then refused its own publish, with the compiler's sentence about graded
   * units rather than one about quizzes. If `compile`'s per-phase overlay read
   * `tasks[0]` for the phase's brief, a quiz ordered first would speak for the phase in the
   * room, in the IDE mentor's system prompt, in the mentor's output reviewer,
   * in `mentorInstructionIdentity` (invalidating every cached reply for the
   * phase), in `integrityFor`'s `given` set, in the `CR-\d+` parser the
   * maintenance map and ticket panel scan, and in the testing panel.
   *
   * The equivalence test runs underneath both: a source of sole-task phases
   * (such as TaskTrackr) writes one row per phase, and a phase holding no
   * quiz compiles byte for byte. The copy specs above and the content golden
   * net are that assertion.
   */
  describe('the copy path, and the publish overlay\'s lead', () => {
    /** Every task row of one phase of one version, in the order a copy wrote them. */
    const tasksOf = async (versionId: string, phaseKey: string) => {
      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
      return dataSource
        .getRepository(ProjectTaskEntity)
        .find({ where: { projectPhaseId: phase.id }, order: { order: 'ASC' } });
    };

    /**
     * A quiz task row written straight to the store.
     *
     * A source version holding a quiz is exactly what these tests are about,
     * so the row goes in the way the split-phase specs above put a second row in: through
     * the repository, which is also how a row that arrived from an import or a
     * restore would look.
     */
    const writeQuizRow = async (
      versionId: string,
      phaseKey: string,
      taskKey: string,
      order: number,
    ): Promise<void> => {
      const phase = await dataSource
        .getRepository(ProjectPhaseEntity)
        .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
      const checks = fixtureQuizChecks();
      const repo = dataSource.getRepository(ProjectTaskEntity);
      await repo.save(
        repo.create({
          projectPhaseId: phase.id,
          taskKey,
          order,
          required: false,
          signOff: false,
          artefactType: 'quiz',
          artefactPath: null,
          title: `Fixture quiz "${taskKey}"`,
          brief: FIXTURE_QUIZ_NOTICE,
          objectives: [],
          primaryPath: null,
          anchor: null,
          rubric: fixtureQuizRubric(checks.criterion),
          checks,
        }),
      );
    };

    /** A published source whose `design` phase holds the artefact task and a quiz. */
    const publishedWithAQuiz = async (
      slug: string,
      title: string,
      order: 'quiz-first' | 'quiz-second',
    ) => {
      const made = await copyOfTheDefault(slug, title);
      await writeQuizRow(made.draftVersionId, 'design', 'concepts', 2);
      if (order === 'quiz-first') {
        await service.reorderTasks(TEACHER, made.project.id, made.draftVersionId, 'design', {
          taskKeys: ['concepts', INHERITED_TASK_KEY],
        });
      }
      await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });
      await registry.load();
      return made;
    };

    it('carries every task of a source phase, in order, each with its own checks', async () => {
      const source = await publishedWithAQuiz('quiz-source', 'Quiz Source', 'quiz-second');

      const copy = await service.createProject(TEACHER, {
        title: 'Quiz Copy',
        slug: 'quiz-copy',
        fromVersionId: source.draftVersionId,
      });

      // both rows, in the source's order, and the quiz is not the one keyed
      // `main`: the second row was silently dropped before this loop existed
      const rows = await tasksOf(copy.draftVersionId, 'design');
      expect(rows.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, 'concepts']);
      expect(rows.map((one) => one.order)).toEqual([1, 2]);
      // TaskTrackr 4.0.0's Design task: a design task, reading no prose file
      expect(rows[0].artefactType).toBe('design-doc');
      expect(rows[0].artefactPath).toBeNull();
      expect(rows[0].checks.kind).toBe('design');

      // the quiz carries its own slice across: the key and the explanations
      // are the version's, not a derivation's, and they arrive whole
      expect(rows[1].artefactType).toBe('quiz');
      expect(rows[1].artefactPath).toBeNull();
      expect(rows[1].required).toBe(false);
      expect(rows[1].checks).toEqual(fixtureQuizChecks());
      expect(rows[1].rubric.criteria.map((one) => one.key)).toEqual(['concepts']);

      // every other phase of the copy is the one row it has always been
      for (const key of ['requirements', 'implementation', 'testing', 'deployment', 'maintenance']) {
        const others = await tasksOf(copy.draftVersionId, key);
        expect(others.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY]);
      }
    });

    it('carries a split phase across under the keys its tasks already hold', async () => {
      // The loop is about *every* task and not about quizzes alone: a source
      // phase a teacher split lost every task after its first to the same
      // `[0]`. Each row keeps the key it was authored under, because that key
      // is what its brief and its checks are addressed by. On the host (Shelf's
      // Requirements): its story task and the two quizzes a teacher adds.
      const source = await copyOfTheHost('split-source', 'Split Source');
      await addHostQuizzes({ service }, { projectId: source.project.id, versionId: source.draftVersionId }, HOST_PHASE, TEACHER);
      await service.publish(TEACHER, source.project.id, source.draftVersionId, { version: '1.0.0' });

      const copy = await service.createProject(TEACHER, {
        title: 'Split Copy',
        slug: 'split-copy',
        fromVersionId: source.draftVersionId,
      });

      const rows = await tasksOf(copy.draftVersionId, HOST_PHASE);
      expect(rows.map((one) => one.taskKey)).toEqual([INHERITED_TASK_KEY, ...HOST_QUIZ_KEYS]);
      expect(rows.map((one) => one.order)).toEqual([1, 2, 3]);
      const was = await tasksOf(source.draftVersionId, HOST_PHASE);
      expect(rows.map((one) => one.title)).toEqual(was.map((one) => one.title));
      expect(rows.map((one) => one.title).slice(1)).toEqual(HOST_QUIZ_KEYS.map((key) => hostQuizBody(key).title));
      expect(rows.map((one) => one.checks)).toEqual(was.map((one) => one.checks));
      const report = await service.validate(TEACHER, copy.project.id, copy.draftVersionId);
      expect(report.blocking).toEqual([]);
    });

    it('does not displace the artefact task when the quiz is ordered first, and the copy publishes', async () => {
      const source = await publishedWithAQuiz('quiz-first-source', 'Quiz First', 'quiz-first');

      const copy = await service.createProject(TEACHER, {
        title: 'Quiz First Copy',
        slug: 'quiz-first-copy',
        fromVersionId: source.draftVersionId,
      });

      // the quiz keeps its own key rather than taking the artefact task's, and
      // the artefact task is still there: keying by position would have
      // written two rows keyed `main` into `UQ_project_tasks_key`
      const rows = await tasksOf(copy.draftVersionId, 'design');
      expect(rows.map((one) => one.taskKey)).toEqual(['concepts', INHERITED_TASK_KEY]);
      expect(rows[0].artefactType).toBe('quiz');
      expect(rows[1].checks.kind).toBe('design');

      // and the copy can publish: before the loop it carried the quiz as its
      // `main`, lost the artefact task and was refused by `tasks-partition-units`
      const report = await service.validate(TEACHER, copy.project.id, copy.draftVersionId);
      expect(report.blocking).toEqual([]);
      await expect(
        service.publish(TEACHER, copy.project.id, copy.draftVersionId, { version: '1.0.0' }),
      ).resolves.toBeDefined();
    });

    it('puts the non-quiz task\'s brief on the phase, whatever the teacher ordered', async () => {
      const source = await publishedWithAQuiz('quiz-lead-source', 'Quiz Lead', 'quiz-first');

      const seed = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedProjectId });
      const shipped = content.getProject(seed.slug);
      const published = content.getProject('quiz-lead-source');
      const design = published.phases.find((one) => one.key === 'design')!;

      // the panel is the artefact task's brief (which on an untouched copy is
      // the pack's own, stored plain at the draft's first save) and
      // never the quiz's, which is read by the room, the mentor's system
      // prompt, its output reviewer, the cache identity and `integrityFor`'s
      // `given` set
      expect(design.taskPanel).toBe(plainTextOf(shipped.phases.find((one) => one.key === 'design')!.taskPanel));
      expect(design.taskPanel).not.toContain(FIXTURE_QUIZ_NOTICE);

      // and the five phases holding no quiz are the pack's, their briefs stored plain
      for (const phase of published.phases.filter((one) => one.key !== 'design')) {
        const was = shipped.phases.find((one) => one.key === phase.key)!;
        expect(phase.taskPanel).toEqual(plainTextOf(was.taskPanel));
        expect(phase.checks).toEqual(was.checks);
        expect(phase.rubric).toEqual(was.rubric);
      }
    });

    it('keeps a maintenance phase\'s change request findable with a quiz ordered first', async () => {
      // The reader that would have failed silently: `map.ts` and the ticket
      // panel scan `PhaseContent.taskPanel` for `CR-\d+` to draw the learner's
      // change request, so a quiz speaking for the phase draws an empty one.
      const made = await copyOfTheDefault('quiz-maintenance', 'Quiz Maintenance');
      await writeQuizRow(made.draftVersionId, 'maintenance', 'concepts', 2);
      await service.reorderTasks(TEACHER, made.project.id, made.draftVersionId, 'maintenance', {
        taskKeys: ['concepts', INHERITED_TASK_KEY],
      });

      // through the compile rather than through a publish: `validate` stores
      // the compiled snapshot, which is all this assertion reads
      await service.validate(TEACHER, made.project.id, made.draftVersionId);
      const stored = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: made.draftVersionId });
      const maintenance = (stored.compiled as CompiledSnapshot).content.phases.find(
        (one) => one.key === 'maintenance',
      )!;

      expect(maintenance.taskPanel).toMatch(/CR-\d+/);
      expect(maintenance.taskPanel).not.toContain(FIXTURE_QUIZ_NOTICE);
    });
  });

  /* --------------------- the seal, and the store behind it ---------------- */

  describe('what a file listing reads out of the store', () => {
    it('draws the tree without ever reading a sealed blob', async () => {
      const made = await copyOfTheDefault('unread-seal', 'Unread Seal');
      const rows = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: made.draftVersionId } });
      const readableShas = new Set(
        rows.filter((row) => row.role === 'workspace' || row.role === 'warmup').map((row) => row.blobSha),
      );
      // a sha only a sealed row uses: identical bytes under two roles would be
      // the same bytes a learner already reads, and prove nothing either way
      const sealed = new Set(
        rows
          .filter((row) => row.role !== 'workspace' && row.role !== 'warmup')
          .map((row) => row.blobSha)
          .filter((sha) => !readableShas.has(sha)),
      );
      expect(sealed.size).toBeGreaterThan(0);

      const asked: { shas: string[]; columns: string[] }[] = [];
      const manager = dataSource.manager;
      const real = manager.find.bind(manager);
      const spy = jest.spyOn(manager, 'find').mockImplementation((async (entity: unknown, options: unknown) => {
        if (entity === ContentBlobEntity) {
          const opts = options as
            | { where?: { sha?: { value?: string[] } }; select?: string[] }
            | undefined;
          asked.push({
            shas: [...(opts?.where?.sha?.value ?? [])],
            columns: [...(opts?.select ?? [])],
          });
        }
        return real(entity as never, options as never);
      }) as never);

      try {
        const files = await service.listFiles(TEACHER, made.project.id, made.draftVersionId);
        expect(files.length).toBeGreaterThan(100);
        // the sizes are the real ones: a sealed row shows how big it is
        // without a byte of it leaving the store
        const sealedViews = files.filter((file) => file.sealed);
        expect(sealedViews.length).toBeGreaterThan(0);
        expect(sealedViews.every((file) => file.size > 0)).toBe(true);
        expect(sealedViews.every((file) => file.content === null)).toBe(true);
      } finally {
        spy.mockRestore();
      }

      // a query that can return bytes is a query that names no sealed row
      const carryingBytes = asked.filter(
        (one) => one.columns.length === 0 || one.columns.includes('bytes'),
      );
      expect(carryingBytes.length).toBeGreaterThan(0);
      for (const query of carryingBytes) {
        for (const sha of query.shas) expect(sealed.has(sha)).toBe(false);
      }
      // and the sizes came from the column that exists so nothing has to scan
      expect(
        asked.some((one) => one.columns.includes('size') && !one.columns.includes('bytes')),
      ).toBe(true);
    });
  });

  /* ------------------------- taking the work with you --------------------- */

  describe('the account export', () => {
    it('hands a teacher back the projects and briefs they wrote', async () => {
      await dataSource.getRepository(UserEntity).save(
        dataSource.getRepository(UserEntity).create({
          id: TEACHER.id,
          email: 'teacher-1@learnsdlc.invalid',
          passwordHash: 'not-a-hash',
          displayName: 'A teacher',
          role: 'INSTRUCTOR',
          cohort: 'default',
        }),
      );
      const made = await copyOfTheDefault('exported-work', 'Exported Work');
      await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'requirements', {
        ...hostQuizBody('my-own'),
        title: 'My own concept check',
        brief: 'The brief I wrote myself.',
      });

      const account = new AccountService(undefined as never, dataSource);
      const data = (await account.exportData(TEACHER.id)) as Record<string, unknown>;
      const authored = data.authoredProjects as AuthoredExport[];

      const mine = authored.find((one) => one.slug === 'exported-work');
      expect(mine).toBeDefined();
      expect(mine!.title).toBe('Exported Work');
      const requirements = mine!.versions[0].phases.find((one) => one.key === 'requirements')!;
      const task = requirements.tasks.find((one) => one.taskKey === 'my-own')!;
      expect(task.brief).toBe('The brief I wrote myself.');
      // a quiz carries no rules, and its key is not the teacher's prose
      expect(task.rules).toEqual([]);

      // and none of the pack they copied rides out with it
      const blobs = await dataSource.getRepository(ContentBlobEntity).find();
      const sealedShas = new Set(
        (
          await dataSource
            .getRepository(ProjectFileEntity)
            .find({ where: { projectVersionId: made.draftVersionId } })
        )
          .filter((row) => row.role !== 'workspace' && row.role !== 'warmup')
          .map((row) => row.blobSha),
      );
      const secrets = blobs
        .filter((blob) => sealedShas.has(blob.sha))
        .map((blob) => blob.bytes)
        .filter((bytes) => bytes.trim().length > 40);
      expect(secrets.length).toBeGreaterThan(0);
      const wire = JSON.stringify(authored);
      for (const secret of secrets) expect(wire).not.toContain(secret);
    });
  });

  /* ---------------- the next draft, off the published head ---------------- */

  /**
   * A project that has published is not a project that is finished.
   *
   * Once a project's draft publishes, its only editable version is gone, and
   * without a way back the teacher's own project would be as fixed as the
   * platform's. `versions.createDraft` opens the next one from the
   * published head: the rows copied, the blobs referenced, the task keys kept,
   * so the version a class is pinned to is untouched and the one after it starts
   * from what shipped rather than from what the copy brought.
   */
  describe('opening the next draft from the published head', () => {
    /** A copy of the default, published at 1.0.0 and holding no draft. */
    const publishedCopy = async (slug: string, title: string, caller = TEACHER) => {
      const made = await copyOfTheDefault(slug, title, caller);
      const done = await service.publish(caller, made.project.id, made.draftVersionId, {
        version: '1.0.0',
      });
      return { projectId: made.project.id, headVersionId: done.versionId };
    };

    it('copies the head\'s phases, tasks and files into a draft one patch newer', async () => {
      const blobsBefore = await dataSource.getRepository(ContentBlobEntity).count();
      const { projectId, headVersionId } = await publishedCopy('next-draft', 'Next Draft');
      const head = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: headVersionId });

      const draft = await service.createDraftVersion(TEACHER, projectId, {
        fromVersionId: headVersionId,
      });

      // one patch off the head, because publish refuses anything not newer and
      // a draft needs a number before anybody has chosen one
      expect(draft.version).toBe('1.0.1');
      expect(draft.status).toBe('draft');
      expect(draft.editable).toBe(true);
      expect(draft.versionId).not.toBe(headVersionId);
      expect(draft.tagline).toBe(head.manifest.tagline);
      expect(draft.description).toBe(head.manifest.description);
      // the row is stamped: the version list orders on it, and a draft opened
      // through the query builder rather than through `save` is where a missing
      // `@CreateDateColumn` would show up
      expect(new Date(draft.createdAt).getTime()).toBeGreaterThan(Date.now() - 300_000);

      // the task keys are the head's, because a learner's state follows the key
      const keysOf = (phases: { key: string; tasks: { taskKey: string }[] }[]) =>
        phases.map((one) => `${one.key}: ${one.tasks.map((task) => task.taskKey).join(',')}`);
      const was = await service.readDraft(TEACHER, projectId, headVersionId);
      expect(keysOf(draft.phases)).toEqual(keysOf(was.phases));
      expect(draft.phases).toHaveLength(6);

      // metadata copied, bytes referenced: opening a draft writes no blob
      const headFiles = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: headVersionId } });
      const draftFiles = await dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: draft.versionId } });
      expect(draftFiles).toHaveLength(headFiles.length);
      expect(await dataSource.getRepository(ContentBlobEntity).count()).toBe(blobsBefore);

      // and every role travels with its row, so a copy can never un-seal one
      const countRoles = (rows: ProjectFileEntity[]) => {
        const out: Record<string, number> = {};
        for (const row of rows) out[row.role] = (out[row.role] ?? 0) + 1;
        return out;
      };
      expect(countRoles(draftFiles)).toEqual(countRoles(headFiles));
      expect(draftFiles.some((one) => one.role === 'hidden')).toBe(true);

      // the phase rows a file hangs off are this version's own, or the file
      // tree and the editable paths a phase mounts would read another version's
      const draftPhases = await dataSource
        .getRepository(ProjectPhaseEntity)
        .find({ where: { projectVersionId: draft.versionId } });
      const mine = new Set(draftPhases.map((one) => one.id));
      for (const row of draftFiles.filter((one) => one.ownerKind === 'phase')) {
        expect(mine.has(row.ownerId)).toBe(true);
      }

      // the published head did not move
      const after = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: headVersionId });
      expect(after.status).toBe('published');
      expect(after.contentDigest).toBe(head.contentDigest);
      expect(after.compiled).toEqual(head.compiled);

      // and the project now reads as one published version with a draft open
      const detail = await service.getProject(TEACHER, projectId);
      expect(detail.project.publishedVersionId).toBe(headVersionId);
      expect(detail.project.draftVersionId).toBe(draft.versionId);
    });

    it('carries the teacher\'s published edits rather than what the copy brought', async () => {
      const { projectId, headVersionId } = await publishedCopy('next-draft-edits', 'Next Draft Edits');
      await service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId });
      const opened = (await service.getProject(TEACHER, projectId)).project.draftVersionId as string;

      await service.updateTask(TEACHER, projectId, opened, 'requirements', INHERITED_TASK_KEY, {
        brief: 'Rewritten for next term.',
      });
      const done = await service.publish(TEACHER, projectId, opened, { version: '1.1.0' });
      expect(done.version).toBe('1.1.0');

      // the draft after that one opens from 1.1.0's rows, brief included
      const next = await service.createDraftVersion(TEACHER, projectId, {
        fromVersionId: done.versionId,
      });
      expect(next.version).toBe('1.1.1');
      const requirements = next.phases.find((one) => one.key === 'requirements')!;
      expect(requirements.tasks[0].brief).toBe('Rewritten for next term.');
    });

    it('refuses a second draft, and says which one to edit', async () => {
      const { projectId, headVersionId } = await publishedCopy('one-draft', 'One Draft');
      await service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId });

      await expect(
        service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId }),
      ).rejects.toThrow(draftAlreadyOpenRefusal('1.0.1'));

      const drafts = await dataSource
        .getRepository(ProjectVersionEntity)
        .count({ where: { projectId, status: 'draft' } });
      expect(drafts).toBe(1);
    });

    it('lets the index, and not the read, be what stops the second draft', async () => {
      const { projectId, headVersionId } = await publishedCopy('draft-index', 'Draft Index');
      const draft = await service.createDraftVersion(TEACHER, projectId, {
        fromVersionId: headVersionId,
      });
      const versions = dataSource.getRepository(ProjectVersionEntity);
      const open = await versions.findOneByOrFail({ id: draft.versionId });

      // A second draft row written straight to the repository, which is the
      // only way past the read. `UQ_project_versions_draft` (the partial unique
      // index) is what refuses it, so the rule needs no new
      // migration and no new constraint to hold under two simultaneous calls.
      await expect(
        versions.insert(
          versions.create({
            projectId,
            version: '9.9.9',
            status: 'draft',
            manifest: open.manifest,
            compiled: open.compiled,
            validation: null,
            contentDigest: null,
            sandboxBudget: null,
            forkedFromVersionId: headVersionId,
            publishedAt: null,
            publishedByUserId: null,
            notes: null,
          }),
        ),
      ).rejects.toThrow(/UNIQUE|unique/i);
    });

    it('answers the loser of a race the same sentence, and writes nothing', async () => {
      const { projectId, headVersionId } = await publishedCopy('draft-race', 'Draft Race');
      await service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId });
      const audited = async () =>
        (await dataSource.getRepository(AuditEventEntity).find({ where: { targetId: projectId } }))
          .filter((one) => (one.event as string) === 'project.draft').length;
      expect(await audited()).toBe(1);

      // The second caller's read of the versions happened before the winner's
      // insert landed, so it sees no draft and inserts anyway. Hidden once, for
      // one query, which is exactly the window the index exists to close.
      const real = EntityManager.prototype.find;
      let hide = true;
      const spy = jest
        .spyOn(EntityManager.prototype, 'find')
        .mockImplementation(async function (this: EntityManager, target: never, options?: never) {
          const rows = await real.call(this, target, options);
          if (hide && (target as unknown) === ProjectVersionEntity) {
            hide = false;
            return (rows as ProjectVersionEntity[]).filter((one) => one.status !== 'draft');
          }
          return rows;
        } as never);

      try {
        await expect(
          service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId }),
        ).rejects.toThrow(draftAlreadyOpenRefusal('1.0.1'));
      } finally {
        spy.mockRestore();
      }

      // one draft, one audit row, and no half-copied phase rows left behind
      expect(
        await dataSource
          .getRepository(ProjectVersionEntity)
          .count({ where: { projectId, status: 'draft' } }),
      ).toBe(1);
      expect(await audited()).toBe(1);
    });

    it('refuses a project that has published nothing, by its title', async () => {
      const made = await copyOfTheDefault('never-published', 'Never Published');
      const project = await dataSource
        .getRepository(ProjectEntity)
        .findOneByOrFail({ id: made.project.id });
      // the draft a copy opens with is still open, so the first refusal is the
      // one about the draft; drop it and the honest answer is the second
      await dataSource.getRepository(ProjectVersionEntity).delete({ id: made.draftVersionId });

      await expect(
        service.createDraftVersion(TEACHER, made.project.id, { fromVersionId: made.draftVersionId }),
      ).rejects.toThrow(nothingPublishedRefusal(project.title));
    });

    it('refuses a withdrawn project in its own words, not the ones about a draft it has not got', async () => {
      const { projectId, headVersionId } = await publishedCopy('withdrawn-draft', 'Withdrawn Draft');
      await service.archiveProject(TEACHER, projectId);

      // the state the sentence has to be true of: this project holds versions,
      // and every one of them is withdrawn, so there is no draft to publish
      // and it is not a project that never published anything
      const versions = await dataSource
        .getRepository(ProjectVersionEntity)
        .find({ where: { projectId } });
      expect(versions.length).toBeGreaterThan(0);
      expect(versions.every((one) => one.status === 'archived')).toBe(true);

      const refused = await service
        .createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId })
        .then(
          () => null,
          (error: Error) => error,
        );
      expect(refused?.message).toBe(withdrawnProjectRefusal('Withdrawn Draft'));
      // neither clause of the no-published-version sentence is true here
      expect(refused?.message).not.toContain('has no published version yet');
      expect(refused?.message).not.toContain('Publish the draft you have open');

      // and nothing was opened by the ask
      expect(
        await dataSource
          .getRepository(ProjectVersionEntity)
          .count({ where: { projectId, status: 'draft' } }),
      ).toBe(0);
    });

    it('refuses a fromVersionId that is not the head any more, naming the head', async () => {
      const { projectId, headVersionId } = await publishedCopy('stale-head', 'Stale Head');
      const draft = await service.createDraftVersion(TEACHER, projectId, {
        fromVersionId: headVersionId,
      });
      await service.publish(TEACHER, projectId, draft.versionId, { version: '2.0.0' });

      // the page that still holds 1.0.0's id asks for a draft off it: honoured,
      // it would copy 1.0.0's rows and quietly undo 2.0.0
      await expect(
        service.createDraftVersion(TEACHER, projectId, { fromVersionId: headVersionId }),
      ).rejects.toThrow(draftFromStaleHeadRefusal('2.0.0'));

      expect(
        await dataSource
          .getRepository(ProjectVersionEntity)
          .count({ where: { projectId, status: 'draft' } }),
      ).toBe(0);
    });

    it('refuses the platform\'s project, another teacher\'s, and one nobody can see', async () => {
      const seed = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedProjectId });
      await expect(
        service.createDraftVersion(TEACHER, seedProjectId, { fromVersionId: seedVersionId }),
      ).rejects.toThrow(platformProjectCopyOnlyRefusal(seed.title));

      const { projectId, headVersionId } = await publishedCopy('draft-not-yours', 'Draft Not Yours');
      // ADMIN reads everything and is still not an escape hatch for editing
      await expect(
        service.createDraftVersion(ADMIN, projectId, { fromVersionId: headVersionId }),
      ).rejects.toThrow(projectNotYoursRefusal());
      // and a project a second teacher cannot see at all answers 404
      await expect(
        service.createDraftVersion(OTHER_TEACHER, projectId, { fromVersionId: headVersionId }),
      ).rejects.toThrow(/no project with that id/i);
    });

    it('leaves exactly one audit row, and publishing the draft does not move the earlier version', async () => {
      const { projectId, headVersionId } = await publishedCopy('draft-audit', 'Draft Audit');
      const head = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: headVersionId });

      const draft = await service.createDraftVersion(TEACHER, projectId, {
        fromVersionId: headVersionId,
      });

      const rows = await dataSource
        .getRepository(AuditEventEntity)
        .find({ where: { targetId: projectId } });
      const drafted = rows.filter((one) => (one.event as string) === 'project.draft');
      expect(drafted).toHaveLength(1);
      expect(drafted[0].actorUserId).toBe(TEACHER.id);
      expect(drafted[0].targetId).toBe(projectId);

      await service.updateTask(TEACHER, projectId, draft.versionId, 'requirements', INHERITED_TASK_KEY, {
        brief: 'Next term.',
      });
      await service.publish(TEACHER, projectId, draft.versionId, { version: '1.1.0' });

      // the version a class may be pinned to is byte for byte what it was
      const after = await dataSource
        .getRepository(ProjectVersionEntity)
        .findOneByOrFail({ id: headVersionId });
      expect(after.status).toBe('published');
      expect(after.version).toBe('1.0.0');
      expect(after.compiled).toEqual(head.compiled);
      expect(after.contentDigest).toBe(head.contentDigest);
      expect(after.publishedAt).toBe(head.publishedAt);
    });
  });

  /* ------------------------ the platform's own project -------------------- */

  it('leaves TaskTrackr exactly as the import wrote it', async () => {
    const before = await seedFingerprint();
    const made = await copyOfTheDefault('untouched', 'Untouched');
    // Maintenance takes a concept quiz beside its code task
    await service.addTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', hostQuizBody('shape'));
    await service.removeTask(TEACHER, made.project.id, made.draftVersionId, 'maintenance', 'shape');
    await service.publish(TEACHER, made.project.id, made.draftVersionId, { version: '1.0.0' });

    expect(await seedFingerprint()).toEqual(before);
    expect(
      await dataSource.getRepository(ProjectTaskEntity).count({
        where: { projectPhaseId: seedVersionId },
      }),
    ).toBe(0);
  });
});

/* ======================================================================== *
 * End to end: a copy whose sole code task's                                *
 * slice was edited (the shape a sealed write leaves on the row) compiles   *
 * to a phase that carries the edit, unions included.                       *
 * ======================================================================== */
describe('an edited executable task reaches the compiled phase', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helpers = require('../../test/tasktrackr-phase') as typeof import('../../test/tasktrackr-phase');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SealedRoleService } = require('./sealed-roles') as typeof import('./sealed-roles');
  let world: Awaited<ReturnType<typeof helpers.openForkWorld>>;
  const sealOf = () => new SealedRoleService(world.dataSource, new ProjectImporterService(world.content, world.dataSource));

  beforeAll(async () => {
    world = await helpers.openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  it("the compiled implementation phase carries the edited task's hidden suite in hiddenTestFiles and its answer in solutionSources", async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-s2-edited-code');
    const impl = (await helpers.draftSnapshot(world, fork)).content.phases.find((one) => one.key === 'implementation')!
      .checks as import('../content/content.types').CodeChecks;
    const run = impl.runs[0];
    const hidden = Object.keys(run.hiddenTestFiles)[0];
    const answered = impl.editableTargets[0];
    // through the sealed-role door, the one way a teacher's edit reaches a sealed byte
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${run.hiddenTestFiles[hidden]}\n# MARKER-HIDDEN-S2E\n`);
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'solution', answered, '# MARKER-SOLUTION-S2E\n');

    const snapshot = await helpers.draftSnapshot(world, fork);
    const compiled = snapshot.content.phases.find((one) => one.key === 'implementation')!.checks as import('../content/content.types').CodeChecks;
    expect(compiled.hiddenTestFiles[hidden]).toContain('MARKER-HIDDEN-S2E');
    expect(compiled.runs[0].hiddenTestFiles[hidden]).toContain('MARKER-HIDDEN-S2E');
    expect(compiled.solutionSources).toContain('# MARKER-SOLUTION-S2E\n');
    expect(compiled.solutionFiles[answered]).toBe('# MARKER-SOLUTION-S2E\n');
  });

  it('the derivation is stable: compiled twice and three times, the edited phase reads the same', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-s2-twice');
    const checks = (await helpers.draftSnapshot(world, fork)).content.phases.find((one) => one.key === 'implementation')!
      .checks as import('../content/content.types').CodeChecks;
    const hidden = Object.keys(checks.runs[0].hiddenTestFiles)[0];
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${checks.runs[0].hiddenTestFiles[hidden]}\n# MARKER-TWICE\n`);
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'solution', checks.editableTargets[0], '# MARKER-TWICE-SOLUTION\n');

    const passes: string[] = [];
    for (let at = 0; at < 3; at += 1) {
      const snapshot = await helpers.draftSnapshot(world, fork);
      const phase = snapshot.content.phases.find((one) => one.key === 'implementation')!;
      const compiled = phase.checks as import('../content/content.types').CodeChecks;
      expect(compiled.hiddenTestFiles[hidden]).toContain('MARKER-TWICE');
      expect(compiled.solutionSources).toContain('# MARKER-TWICE-SOLUTION\n');
      // the sole task reads the phase's slice back, never a second copy of it
      expect(snapshot.phases.find((one) => one.key === 'implementation')!.tasks[0].checks).toBeUndefined();
      passes.push(JSON.stringify(phase.checks));
    }
    expect(new Set(passes).size).toBe(1);
  });

  it("a sealed write through the sealed-role door reaches the compiled phase: hidden suite, solution, and a tests task's new mutant", async () => {
    const seal = sealOf();
    const fork = await helpers.copyTaskTrackr(world, 'rx-s2-sealed-rows');
    const before = await helpers.draftSnapshot(world, fork);
    const impl = before.content.phases.find((one) => one.key === 'implementation')!.checks as import('../content/content.types').CodeChecks;
    const hidden = Object.keys(impl.runs[0].hiddenTestFiles)[0];
    const answered = impl.editableTargets[0];

    await seal.write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${impl.runs[0].hiddenTestFiles[hidden]}\n# MARKER-SEALED-HIDDEN\n`);
    await seal.write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'solution', answered, `${impl.solutionFiles[answered]}\n# MARKER-SEALED-SOLUTION\n`);
    const testing = before.content.phases.find((one) => one.key === 'testing')!.checks as import('../content/content.types').TestsChecks;
    const [file, bytes] = Object.entries(testing.mutants[0].files)[0];
    await seal.write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'testing', INHERITED_TASK_KEY, 'mutant', `zz-sealed-extra/${file}`, `${bytes}\n# MARKER-SEALED-MUTANT\n`);

    const after = await helpers.draftSnapshot(world, fork);
    const code = after.content.phases.find((one) => one.key === 'implementation')!.checks as import('../content/content.types').CodeChecks;
    expect(code.runs[0].hiddenTestFiles[hidden]).toContain('MARKER-SEALED-HIDDEN');
    expect(code.hiddenTestFiles[hidden]).toContain('MARKER-SEALED-HIDDEN');
    expect(code.solutionFiles[answered]).toContain('MARKER-SEALED-SOLUTION');
    expect(code.solutionSources.join('\n')).toContain('MARKER-SEALED-SOLUTION');
    const tests = after.content.phases.find((one) => one.key === 'testing')!.checks as import('../content/content.types').TestsChecks;
    const added = tests.mutants.find((one) => one.name === 'zz-sealed-extra');
    expect(added?.files[file]).toContain('MARKER-SEALED-MUTANT');
    expect(added?.run).toBe(testing.mutants[0].run);
    // stable under a second compile
    expect(JSON.stringify((await helpers.draftSnapshot(world, fork)).content.phases.find((one) => one.key === 'implementation')!.checks)).toBe(JSON.stringify(code));
  });

  it('GUARD › an untouched copy compiles every executable phase byte for byte as the source', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-s2-untouched');
    await helpers.draftSnapshot(world, fork);
    const snapshot = await helpers.draftSnapshot(world, fork);
    const seed = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
    for (const key of ['implementation', 'testing', 'deployment', 'maintenance']) {
      const mine = snapshot.content.phases.find((one) => one.key === key)!;
      const theirs = (seed.compiled as CompiledSnapshot).content.phases.find((one) => one.key === key)!;
      expect(JSON.stringify(mine.checks)).toBe(JSON.stringify(theirs.checks));
    }
  });
});

/* ======================================================================== *
 * The publish arm. Publish additionally                                    *
 * refuses a version above the microVM ceiling (naming the phase and the    *
 * count), a runtime outside the baked profile (naming the package), a pack *
 * argv outside the allowed test-run shapes, and an executable phase whose  *
 * bytes are not the reference project's without a current deep receipt.    *
 * A fresh, unedited copy still publishes.                                  *
 * ======================================================================== */
describe('the publish arm', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helpers = require('../../test/tasktrackr-phase') as typeof import('../../test/tasktrackr-phase');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SealedRoleService } = require('./sealed-roles') as typeof import('./sealed-roles');
  const sealOf = () => new SealedRoleService(world.dataSource, new ProjectImporterService(world.content, world.dataSource));
  const checksOf = async (fork: { projectId: string; versionId: string }, key: string) =>
    (await helpers.draftSnapshot(world, fork)).content.phases.find((one) => one.key === key)!.checks as any;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const shared = require('@learnsdlc/shared') as typeof import('@learnsdlc/shared');
  let world: Awaited<ReturnType<typeof helpers.openForkWorld>>;

  beforeAll(async () => {
    world = await helpers.openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  const editManifest = async (versionId: string, edit: (manifest: Record<string, any>) => void) => {
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    const manifest = JSON.parse(JSON.stringify(row.manifest));
    edit(manifest);
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: versionId }, { manifest });
  };
  const refusalOf = async (fork: { projectId: string; versionId: string }): Promise<string> => {
    try {
      await world.service.publish(helpers.S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
    } catch (error) {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as { message?: unknown } | undefined;
      return String(response?.message ?? (error as Error).message);
    }
    return 'PUBLISHED';
  };

  it('publish refuses a version priced above the ceiling, naming the phase and the count', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-ceiling');
    const checks = await checksOf(fork, 'testing');
    // one more mutant on a ten-microVM phase: eleven, one over the ceiling
    const [file, bytes] = Object.entries(checks.mutants[0].files as Record<string, string>)[0];
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'testing', INHERITED_TASK_KEY, 'mutant', `zz-one-more/${file}`, `${bytes}\n# one more\n`);

    const said = await refusalOf(fork);
    expect(said).toContain(shared.budgetCeilingRefusal(11, 'Testing'));
    expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId })).status).toBe('draft');
  });

  it('publish refuses a runtime outside the baked profile, naming the package', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-runtime');
    // a name the image bakes, at a version no reviewed checksum covers: the
    // supported-stack row reads only names, the profile reads the pin
    await editManifest(fork.versionId, (manifest) => {
      manifest.runtime.node.tools.esbuild = '0.99.0';
    });
    const said = await refusalOf(fork);
    expect(said).not.toBe('PUBLISHED');
    expect(said).toMatch(/esbuild/);
    expect(said).toMatch(/runtime profile/i);
  });

  it('publish refuses a pack argv outside the run-shape rule’s list', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-argv');
    await editManifest(fork.versionId, (manifest) => {
      manifest.preview.service.command = ['bash', '-c', 'curl example'];
    });
    const said = await refusalOf(fork);
    expect(said).not.toBe('PUBLISHED');
    expect(said).toMatch(/project\.preview\.service\.command/);
  });

  it('publish refuses an edited executable phase without a current deep receipt', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-deep');
    const run = (await checksOf(fork, 'implementation')).runs[0];
    const hidden = Object.keys(run.hiddenTestFiles)[0];
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${run.hiddenTestFiles[hidden]}\n# an edited hidden case\n`);

    const said = await refusalOf(fork);
    expect(said).not.toBe('PUBLISHED');
    expect(said).toMatch(/Implementation/);
    expect(said).toMatch(/deep validation/i);
  });

  it('a fast validation never overwrites the stored deep receipt', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-x27');
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    const deep = { contentDigest: 'd'.repeat(64), status: 'passed', checks: [], microVMs: 4, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: fork.versionId }, { validation: { ...(row.validation as object), deep } as never });
    await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const after = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    expect((after.validation as unknown as { deep?: unknown }).deep).toEqual(deep);
  });

  it("an upload of the reference's own bytes publishes; an edited hidden suite is refused for its deep receipt, never by a gate on the reference's executable scope", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DirectoryPackSource: Source } = require('../content/pack-source') as typeof import('../content/pack-source');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-upload-'));
    try {
      // the reference project's own pack, uploaded as the teacher's: its bytes
      // are copied, so the reference comparison must still find them its own;
      // the warm-up is a platform pack's alone, so the archive leaves warmup/ out
      const tasktrackr = path.join(config.contentDir, 'tasktrackr');
      fs.cpSync(tasktrackr, path.join(dir, 'pack'), { recursive: true, filter: (from) => path.relative(tasktrackr, from).split(path.sep)[0] !== 'warmup' });
      const importer = new ProjectImporterService(world.content, world.dataSource);
      const same = await importer.importTeacherDraft(new Source(path.join(dir, 'pack')), { ownerId: helpers.S1_TEACHER.id, title: 'Same bytes' });
      expect(await refusalOf({ projectId: same.projectId, versionId: same.versionId })).toBe('PUBLISHED');

      // now the implementation's hidden suite edited: not the reference's any more
      const fork = await helpers.copyTaskTrackr(world, 'copy-n5');
      const run = (await checksOf(fork, 'implementation')).runs[0];
      const hidden = Object.keys(run.hiddenTestFiles)[0];
      await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${run.hiddenTestFiles[hidden]}\n# n5\n`);
      const said = await refusalOf(fork);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const validation = require('./validation') as typeof import('./validation');
      expect(said).toContain(validation.deepReceiptRefusal('Implementation'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a deep receipt is held against the bytes publish compiles, not the stored snapshot: current lifts the row, a later sealed write makes it stale', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { executableContentDigest } = require('./deep-validation') as typeof import('./deep-validation');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    const fork = await helpers.copyTaskTrackr(world, 'copy-stale');
    const run = (await checksOf(fork, 'implementation')).runs[0];
    const hidden = Object.keys(run.hiddenTestFiles)[0];
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${run.hiddenTestFiles[hidden]}\n# proved\n`);
    await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    const deep = { contentDigest: executableContentDigest(row), status: 'passed', checks: [], microVMs: 4, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: fork.versionId }, { validation: { ...(row.validation as object), deep } as never });

    // current: the deep row passes (read off the report, since publish
    // succeeds on a current receipt and the version would leave draft)
    const current = await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const deepRow = current.checks.find((one) => one.id === validation.DEEP_RECEIPT_CHECK_ID && one.phaseKey === 'implementation');
    expect(deepRow).toMatchObject({ status: 'passed' });
    expect(current.checks.map((one) => one.sentence)).not.toContain(validation.deepReceiptRefusal('Implementation'));
    // the report draws no executable-scope row
    expect(current.checks.some((one) => one.id === 'executable-review-ready')).toBe(false);

    // a sealed write after the proof (no recompile in between): the receipt is stale
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, 'import unittest\n# always passes\n');
    expect(await refusalOf(fork)).toContain(validation.deepReceiptRefusal('Implementation'));
  });

  it("a fast validation carries every key the deep-validation service keeps (the receipt and the run token), read fresh", async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-x27-run');
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    const deepRun = { token: 't-1', state: 'running', startedAt: '2026-10-01T00:00:00Z' };
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: fork.versionId }, { validation: { ...(row.validation as object), deepRun } as never });
    await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const after = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    expect((after.validation as unknown as { deepRun?: unknown }).deepRun).toEqual(deepRun);
  });

  it("persist is a compare-and-swap: a receipt deep validation commits between persist's read and its write is carried, never overwritten", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { UpdateQueryBuilder } = require('typeorm') as typeof import('typeorm');
    const fork = await helpers.copyTaskTrackr(world, 'rx-c-cas');
    await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const deep = { contentDigest: 'c'.repeat(64), status: 'passed', checks: [], microVMs: 4, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    let injected = false;
    const original = UpdateQueryBuilder.prototype.execute;
    const spy = jest.spyOn(UpdateQueryBuilder.prototype, 'execute').mockImplementation(async function (this: any) {
      const values = (this.expressionMap?.valuesSet ?? {}) as Record<string, unknown>;
      if (!injected && this.expressionMap?.mainAlias?.target === ProjectVersionEntity && 'validation' in values) {
        injected = true;
        // deep validation's finish(), committed between persist's read and its write
        const [held] = (await world.dataSource.query('SELECT validation FROM project_versions WHERE id = ?', [fork.versionId])) as { validation: string | null }[];
        const now = JSON.parse(held?.validation ?? '{}') as Record<string, unknown>;
        await world.dataSource.query('UPDATE project_versions SET validation = ? WHERE id = ?', [JSON.stringify({ ...now, deep }), fork.versionId]);
      }
      return original.call(this);
    });
    try {
      await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    } finally {
      spy.mockRestore();
    }
    expect(injected).toBe(true);
    const after = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    expect((after.validation as unknown as { deep?: unknown }).deep).toEqual(deep);
    expect((after.validation as unknown as { tier?: unknown }).tier).toBe('fast');
  });

  it("an uploaded own-bytes executable phase is refused at publish for its deep receipt, and reads own", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    const shelf = path.join(config.contentDir, '..', 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const made = await importer.importTeacherDraft(new DirectoryPackSource(shelf), { ownerId: helpers.S1_TEACHER.id, title: 'Shelf at publish' });
    const said = await refusalOf({ projectId: made.projectId, versionId: made.versionId });
    for (const title of ['Implementation', 'Testing', 'Deployment', 'Maintenance']) {
      // an upload's words: no mention of the reference application it never had
      expect(said).toContain(validation.deepReceiptRefusal(title, { uploaded: true }));
      expect(said).not.toContain(validation.deepReceiptRefusal(title));
    }
    const draft = await world.service.readDraft(helpers.S1_TEACHER, made.projectId, made.versionId);
    for (const phase of draft.phases.filter((one) => ['implementation', 'testing', 'deployment', 'maintenance'].includes(one.key))) {
      expect(phase.provenance?.application).toBeNull();
      expect(phase.provenance?.rollup).toBe('own');
    }
  });

  it("the deep-receipt sentence for four kinds of project: the reference (no row), a copy of it whose application changed (names the reference), an upload and a copy of an upload (the upload's words)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { executableContentDigest } = require('./deep-validation') as typeof import('./deep-validation');
    // at validate the row is an advisory, at publish a refusal: the words are the same
    const receipts = (report: { checks: { id: string; sentence: string }[] }) =>
      report.checks.filter((one) => one.id === validation.DEEP_RECEIPT_CHECK_ID).map((one) => one.sentence);
    const long = validation.deepReceiptRefusal('Implementation');
    const short = validation.deepReceiptRefusal('Implementation', { uploaded: true });

    // 1. the reference project: platform-owned, so this service never validates
    // it (copy only), and a copy that keeps its application as it shipped draws
    // no receipt row at all
    const seed = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
    const referenceProject = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seed.projectId });
    expect(referenceProject.origin).toBe('seed');
    await expect(world.service.validate(helpers.S1_TEACHER, seed.projectId, seed.id)).rejects.toThrow(platformProjectCopyOnlyRefusal(referenceProject.title));
    const pristine = await helpers.copyTaskTrackr(world, 's13-four-pristine');
    const kept = await world.service.validate(helpers.S1_TEACHER, pristine.projectId, pristine.versionId);
    expect(kept.checks.length).toBeGreaterThan(0);
    expect(receipts(kept)).toEqual([]);

    // 2. a copy of the reference whose application changed: the long sentence
    const fork = await helpers.copyTaskTrackr(world, 's13-four-fork');
    const run = (await checksOf(fork, 'implementation')).runs[0];
    const hidden = Object.keys(run.hiddenTestFiles)[0];
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, `${run.hiddenTestFiles[hidden]}\n# s13\n`);
    const copied = await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    expect(receipts(copied)).toContain(long);
    expect(receipts(copied)).not.toContain(short);

    // 3. an upload: the short sentence
    const shelf = path.join(config.contentDir, '..', 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const made = await importer.importTeacherDraft(new DirectoryPackSource(shelf), { ownerId: helpers.S1_TEACHER.id, title: 'Shelf, four kinds' });
    const uploaded = await world.service.validate(helpers.S1_TEACHER, made.projectId, made.versionId);
    expect(receipts(uploaded)).toContain(short);
    expect(receipts(uploaded)).not.toContain(long);

    // 4. a copy of that upload, once it is published: origin 'fork', and still
    // the upload's words, since none of its phases is the reference application
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const deep = { contentDigest: executableContentDigest(row), status: 'passed', checks: [], microVMs: 4, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: made.versionId }, { validation: { ...(row.validation as object), deep } as never });
    expect(await refusalOf({ projectId: made.projectId, versionId: made.versionId })).toBe('PUBLISHED');
    const copy = await world.service.createProject(helpers.S1_TEACHER, { title: 'Copy of Shelf', slug: 's13-four-upload-copy', fromVersionId: made.versionId });
    expect((await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: copy.project.id })).origin).toBe('fork');
    const ofUpload = await world.service.validate(helpers.S1_TEACHER, copy.project.id, copy.draftVersionId);
    expect(receipts(ofUpload)).toContain(short);
    expect(receipts(ofUpload)).not.toContain(long);
    // words only: the upload and its copy refuse the same rows
    expect(ofUpload.checks.map((one) => [one.id, one.status, one.phaseKey])).toEqual(uploaded.checks.map((one) => [one.id, one.status, one.phaseKey]));
  });

  it("a words edit on a copy's implementation task makes the phase the teacher's: mixed, no reference application, and publish asks for deep validation", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    const bodies: [string, { title?: string; brief?: string; objectives?: string[] }][] = [
      ['rx-c-brief', { title: 'Build something else entirely', brief: 'Write a poem in api/app.py.' }],
      ['rx-c-objectives', { objectives: ['Write a sonnet.'] }],
    ];
    for (const [slug, body] of bodies) {
      const fork = await helpers.copyTaskTrackr(world, slug);
      const before = await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId);
      const task = before.phases.find((one) => one.key === 'implementation')!.tasks[0];
      await world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', task.taskKey, { ...body });
      const draft = await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId);
      const implementation = draft.phases.find((one) => one.key === 'implementation')!;
      expect([slug, implementation.provenance?.application]).toEqual([slug, null]);
      expect([slug, implementation.provenance?.rollup]).toEqual([slug, 'mixed']);
      expect([slug, implementation.provenance?.tasks[0].provenance]).toEqual([slug, 'edited']);
      const said = await refusalOf(fork);
      expect(said).toContain(validation.deepReceiptRefusal('Implementation'));
      expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId })).status).toBe('draft');
    }
  });

  it("GUARD › a title-only edit on a copy's implementation task is marked, stays the reference's and publishes", async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-c-title');
    const before = await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const task = before.phases.find((one) => one.key === 'implementation')!.tasks[0];
    await world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', task.taskKey, { title: 'Build it' });
    const draft = await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    const implementation = draft.phases.find((one) => one.key === 'implementation')!;
    expect(implementation.provenance?.application).not.toBeNull();
    expect(implementation.provenance?.tasks[0]).toMatchObject({ provenance: 'reference', titleEdited: true });
    expect(await refusalOf(fork)).toBe('PUBLISHED');
  });

  it('GUARD › a fresh copy of TaskTrackr publishes, publishable, with its sandbox budget', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'copy-fresh');
    const out = await world.service.publish(helpers.S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
    expect(out.sandboxBudget).toBe(20);
    expect(out.validation.publishable).toBe(true);
  });

  it("GUARD › TaskTrackr's 20 microVMs fit the ceiling, no phase above it", async () => {
    const seed = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
    expect(seed.sandboxBudget).toBe(20);
    expect(seed.sandboxBudget).toBeLessThanOrEqual(shared.BUDGET_CEILING.perVersion);
  });

  /* ---- a profile that cannot be read is a refusal by sentence, never a 500 ---- */
  it('a runtime block that makes runtimeProfileRefusals throw is refused by sentence at validate and at publish (not a 500)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    const fork = await helpers.copyTaskTrackr(world, 'rx-s6-unreadable');
    // the runner's manifest without the lock beside it: the baked layer's
    // versions cannot be read, so the runtime profile's reader throws (a missing runtime lock)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-s6-runner-'));
    fs.copyFileSync(path.join(config.runnerDir, 'runtime_manifest.py'), path.join(dir, 'runtime_manifest.py'));
    const held = config.runnerDir;
    (config as { runnerDir: string }).runnerDir = dir;
    try {
      let report: Awaited<ReturnType<typeof world.service.validate>> | null = null;
      let thrown = '';
      try {
        report = await world.service.validate(helpers.S1_TEACHER, fork.projectId, fork.versionId);
      } catch (error) {
        thrown = (error as Error).message;
      }
      expect(thrown).toBe('');
      const sentence = (validation as Record<string, unknown>).RUNTIME_PROFILE_UNREADABLE as string;
      expect(typeof sentence).toBe('string');
      expect(report!.checks.find((one) => one.id === validation.RUNTIME_PROFILE_CHECK_ID)).toMatchObject({ status: 'failed', sentence });
      expect(report!.blocking).toContain(sentence);
      expect(JSON.stringify(report)).not.toContain(dir);

      const said = await refusalOf(fork);
      expect(said).toContain(sentence);
      expect(said).not.toContain(dir);
      expect(said).not.toMatch(/runtime-locks|python-requirements|package\.json/);
      expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId })).status).toBe('draft');
    } finally {
      (config as { runnerDir: string }).runnerDir = held;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // and with the lock back in place the same copy publishes as before
    expect(await refusalOf(fork)).toBe('PUBLISHED');
  });

  /* ---- an uploaded executable phase publishes on its own current deep receipt ---- */
  describe('an uploaded executable phase publishes on its own deep receipt', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const validation = require('./validation') as typeof import('./validation');
    const shelf = path.join(config.contentDir, '..', 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
    const EXECUTABLE = ['Implementation', 'Testing', 'Deployment', 'Maintenance'];
    const upload = async (title: string) =>
      new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(new DirectoryPackSource(shelf), { ownerId: helpers.S1_TEACHER.id, title });

    it('› an uploaded own-bytes executable phase with a current deep receipt publishes', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { executableContentDigest } = require('./deep-validation') as typeof import('./deep-validation');
      const made = await upload('Shelf proved');
      await world.service.validate(helpers.S1_TEACHER, made.projectId, made.versionId);
      const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
      const deep = { contentDigest: executableContentDigest(row), status: 'passed', checks: [], microVMs: 16, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
      await world.dataSource.getRepository(ProjectVersionEntity).update({ id: made.versionId }, { validation: { ...(row.validation as object), deep } as never });

      const said = await refusalOf({ projectId: made.projectId, versionId: made.versionId });
      expect(said).toBe('PUBLISHED');
      expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).status).toBe('published');
    });

    it('GUARD › without a current deep receipt it is still refused by deepReceiptRefusal', async () => {
      const made = await upload('Shelf unproved');
      const said = await refusalOf({ projectId: made.projectId, versionId: made.versionId });
      for (const title of EXECUTABLE) expect(said).toContain(validation.deepReceiptRefusal(title, { uploaded: true }));
      expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).status).toBe('draft');
    });

    it('GUARD › TaskTrackr and a fresh copy of it publish unchanged', async () => {
      const seed = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
      expect([seed.status, seed.sandboxBudget]).toEqual(['published', 20]);
      const fork = await helpers.copyTaskTrackr(world, 'rx-s5-fresh');
      const out = await world.service.publish(helpers.S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
      expect(out.sandboxBudget).toBe(20);
      expect(out.validation.publishable).toBe(true);
      expect(out.validation.checks.filter((one) => one.status === 'failed')).toEqual([]);
      expect(out.validation.checks.some((one) => one.id === validation.DEEP_RECEIPT_CHECK_ID || one.id === 'executable-review-ready')).toBe(false);
    });
  });
});

/* ======================================================================== *
 * The executable editor reads the                                          *
 * sole work task's view off its draft row (every sealed member a digest   *)
 * and saves its editable members through tasks.update. The sealed bytes  *
 * go through the sealed-role door only; nothing here reads or writes one.  *
 * ======================================================================== */
describe("the executable editor's seam", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helpers = require('../../test/tasktrackr-phase') as typeof import('../../test/tasktrackr-phase');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SealedRoleService } = require('./sealed-roles') as typeof import('./sealed-roles');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sha256Hex } = require('../content/blob.store') as typeof import('../content/blob.store');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sandboxBudgetFor } = require('../content/pack-compiler') as typeof import('../content/pack-compiler');
  let world: Awaited<ReturnType<typeof helpers.openForkWorld>>;
  const sealOf = () => new SealedRoleService(world.dataSource, new ProjectImporterService(world.content, world.dataSource));
  type Task = import('@learnsdlc/shared').DraftTaskView & { executable?: import('@learnsdlc/shared').ExecutableTaskView };
  const taskOf = async (fork: { projectId: string; versionId: string }, key: string): Promise<Task> => {
    const draft = await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId);
    return draft.phases.find((one) => one.key === key)!.tasks.find((one) => one.taskKey === INHERITED_TASK_KEY) as Task;
  };
  const views = (files: Record<string, string>) =>
    Object.keys(files).sort().map((at) => ({ path: at, sha256: sha256Hex(files[at]), bytes: Buffer.byteLength(files[at], 'utf-8') }));
  const runBodies = (task: Task) =>
    task.executable!.runs.map(({ id, shape, label, testPaths, visibleTests, learnerTestFiles }) => ({ id, shape, label, testPaths, visibleTests, learnerTestFiles }));
  const said = async (made: Promise<unknown>): Promise<string> => {
    try {
      await made;
    } catch (error) {
      const response = (error as { getResponse?: () => unknown }).getResponse?.() as { message?: unknown } | undefined;
      return String(response?.message ?? (error as Error).message);
    }
    return 'SAVED';
  };

  beforeAll(async () => {
    world = await helpers.openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  it("the draft carries the sole executable task's view on its row: runs, shapes, the profile and the price, every sealed member a digest and never its bytes", async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-wt-view');
    const snapshot = await helpers.draftSnapshot(world, fork);
    const impl = snapshot.content.phases.find((one) => one.key === 'implementation')!;
    const code = impl.checks as import('../content/content.types').CodeChecks;
    const hidden = Object.keys(code.runs[0].hiddenTestFiles)[0];
    const edited = `${code.runs[0].hiddenTestFiles[hidden]}\n# MARKER-WT-VIEW\n`;
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', hidden, edited);

    const task = await taskOf(fork, 'implementation');
    const view = task.executable!;
    expect(view).toBeDefined();
    expect(view.taskKey).toBe(INHERITED_TASK_KEY);
    expect([view.checkKind, view.artefactType, view.profile]).toEqual(['code', 'code', 'baked']);
    expect(view.owns).toEqual(task.owns);
    expect(view.runs.map((run) => [run.id, run.shape, run.label])).toEqual([
      ['api', 'run-python-hidden', 'API tests'],
      ['web', 'run-typescript-hidden', 'Front end'],
    ]);
    expect(view.runs[0].visibleTests).toEqual(code.runs[0].visibleTests);
    expect(view.runs[0].testPaths).toEqual(code.runs[0].testPaths);
    // the sealed suite as digests: the edited file's digest is the new bytes'
    expect(view.runs[0].hidden).toEqual(views({ ...code.runs[0].hiddenTestFiles, [hidden]: edited }));
    expect(view.solution).toEqual(views(code.solutionFiles));
    expect([view.minTests, view.coverageKeywords, view.mutants]).toEqual([null, [], []]);
    expect(view.sandboxBudget).toBe(sandboxBudgetFor(impl, snapshot.phases.find((one) => one.key === 'implementation')!.tasks));

    const testing = (await taskOf(fork, 'testing')).executable!;
    const tests = snapshot.content.phases.find((one) => one.key === 'testing')!.checks as import('../content/content.types').TestsChecks;
    expect([testing.checkKind, testing.minTests]).toEqual(['tests', tests.minTests]);
    expect(testing.runs.map((run) => [run.id, run.shape])).toEqual([['api', 'run-python'], ['web', 'run-typescript']]);
    expect(testing.runs[0].learnerTestFiles).toEqual(tests.runs[0].learnerTestFiles);
    expect(testing.coverageKeywords).toEqual(tests.coverageKeywords.flatMap((group) => group.keywords));
    expect(testing.mutants).toEqual(
      tests.mutants.flatMap((mutant) => views(mutant.files).map((one) => ({ ...one, path: `${mutant.name}/${one.path}` }))),
    );

    // a written phase's task carries none
    expect((await taskOf(fork, 'requirements')).executable).toBeUndefined();
    // and the whole draft holds no sealed byte
    const wire = JSON.stringify(await world.service.readDraft(helpers.S1_TEACHER, fork.projectId, fork.versionId));
    expect(wire).not.toContain('MARKER-WT-VIEW');
    expect(wire).not.toContain(code.solutionFiles[code.editableTargets[0]].trim().split('\n').find((line) => line.trim().length > 20)!.trim());
  });

  it("tasks.update saves an executable task's run labels, its collected paths and a tests task's minimum: the compiled phase follows and the deep receipt is no longer current", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { executableContentDigest } = require('./deep-validation') as typeof import('./deep-validation');
    const fork = await helpers.copyTaskTrackr(world, 'rx-wt-save');
    const row = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    const deep = { contentDigest: executableContentDigest(row), status: 'passed', checks: [], microVMs: 4, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z' };
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: fork.versionId }, { validation: { ...(row.validation as object), deep } as never });

    const impl = await taskOf(fork, 'implementation');
    const runs = runBodies(impl);
    runs[0].label = 'Shelf API tests';
    await world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, {
      brief: '## Your task\n\nMake the API answer.\n',
      owns: impl.owns,
      runs,
    } as never);
    const testing = await taskOf(fork, 'testing');
    await world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'testing', INHERITED_TASK_KEY, {
      owns: testing.owns,
      runs: runBodies(testing),
      minTests: testing.executable!.minTests! + 2,
      coverageKeywords: testing.executable!.coverageKeywords,
    } as never);

    const snapshot = await helpers.draftSnapshot(world, fork);
    const code = snapshot.content.phases.find((one) => one.key === 'implementation')!;
    expect((code.checks as import('../content/content.types').CodeChecks).runs[0].label).toBe('Shelf API tests');
    expect(code.taskPanel).toContain('Make the API answer.');
    const tests = snapshot.content.phases.find((one) => one.key === 'testing')!.checks as import('../content/content.types').TestsChecks;
    expect(tests.minTests).toBe(testing.executable!.minTests! + 2);
    // the hidden suites still ride, untouched by a structural save
    expect(Object.keys((code.checks as import('../content/content.types').CodeChecks).hiddenTestFiles).length).toBeGreaterThan(0);
    expect((await taskOf(fork, 'implementation')).executable!.runs[0].label).toBe('Shelf API tests');
    // the proof was of the old bytes: publish asks for a new one
    const after = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    expect(executableContentDigest(after)).not.toBe(deep.contentDigest);
  });

  it('tasks.update refuses what an executable task cannot be edited to, and writes nothing', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-wt-refuse');
    // a second hidden file, written through the sealed-role door: the run now collects two
    await sealOf().write(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', 'tests/test_hidden_extra.py', 'import unittest\n');
    const impl = await taskOf(fork, 'implementation');
    const testing = await taskOf(fork, 'testing');
    const save = (key: string, body: Record<string, unknown>) =>
      said(world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, key as never, INHERITED_TASK_KEY, body as never));
    const before = JSON.stringify(await world.dataSource.getRepository(ProjectTaskEntity).find({ order: { id: 'ASC' } }));
    const withRun = (task: Task, patch: Record<string, unknown>) => {
      const runs = runBodies(task);
      Object.assign(runs[0], patch);
      return runs;
    };

    const hiddenOfApi = impl.executable!.runs[0].hidden.map((one) => one.path);
    expect(hiddenOfApi).toContain('tests/test_hidden_extra.py');
    const cases: [() => Promise<string>, RegExp][] = [
      // the runs are the ones the project ships: none added, removed, renamed or re-shaped
      [() => save('implementation', { runs: runBodies(impl).slice(0, 1) }), /cannot be added, removed, renamed or moved/],
      [() => save('implementation', { runs: withRun(impl, { id: 'apis' }) }), /cannot be added, removed, renamed or moved/],
      [() => save('implementation', { runs: withRun(impl, { shape: 'run-python' }) }), /keeps the run shape/],
      // every hidden file stays collected, or part of the suite is mounted and never graded
      [() => save('implementation', { runs: withRun(impl, { testPaths: ['tests/test_tasks_api.py'] }) }), /holds none of its hidden test files/],
      [() => save('implementation', { runs: withRun(impl, { testPaths: hiddenOfApi.filter((at) => at !== 'tests/test_hidden_extra.py') }) }), /mounted and never graded/],
      // a visible test is a file of the phase, and no path climbs or is absolute
      [() => save('implementation', { runs: withRun(impl, { visibleTests: ['tests/not_shipped.py'] }) }), /files the phase ships/],
      [() => save('implementation', { runs: withRun(impl, { testPaths: ['../tests'] }) }), /not a plain path inside the project/],
      [() => save('implementation', { runs: withRun(impl, { testPaths: ['/etc'] }) }), /not a plain path inside the project/],
      // a code task has no learner suite, minimum or keywords
      [() => save('implementation', { minTests: 3 }), /no smallest suite/],
      [() => save('implementation', { runs: withRun(impl, { learnerTestFiles: ['tests/test_tasks_api.py'] }) }), /holds no learner suite/],
      // which files are editable is the starter's, set at upload
      [() => save('implementation', { owns: [...impl.owns, 'api/new_module.py'] }), /which files are editable/],
      // a quiz is a quiz task's
      [() => save('implementation', { quiz: { questions: [] } }), /not by rules/],
      // the learner's suite is where the reference suite lands, and stays collected
      [() => save('testing', { runs: withRun(testing, { learnerTestFiles: ['tests/conftest.py'] }) }), /where the reference suite lands/],
      [() => save('testing', { runs: withRun(testing, { testPaths: ['web'] }) }), /holds none of its learner's test files/],
      [() => save('testing', { minTests: 0 }), /whole number of tests from 1 to 500/],
      // keywords are grouped by the criterion each group evidences: a flat edit cannot regroup them
      [() => save('testing', { coverageKeywords: ['complete', 'filter'] }), /cannot regroup them/],
      // and a written task has no executable members at all
      [() => save('requirements', { runs: [] }), /not graded by running tests/],
    ];
    for (const [made, sentence] of cases) {
      const answer = await made();
      expect(answer).toMatch(sentence);
      // never the path the teacher typed back at them
      expect(answer).not.toMatch(/\/etc|not_shipped|new_module/);
    }
    expect(JSON.stringify(await world.dataSource.getRepository(ProjectTaskEntity).find({ order: { id: 'ASC' } }))).toBe(before);
  });

  it('GUARD › a save that changes nothing leaves the compiled phase byte for byte as the copy', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-wt-noop');
    const before = await helpers.draftSnapshot(world, fork);
    for (const key of ['implementation', 'testing'] as const) {
      const task = await taskOf(fork, key);
      await world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, key, INHERITED_TASK_KEY, {
        owns: task.owns,
        runs: runBodies(task),
        ...(key === 'testing' ? { minTests: task.executable!.minTests, coverageKeywords: task.executable!.coverageKeywords } : {}),
      } as never);
    }
    const after = await helpers.draftSnapshot(world, fork);
    for (const key of ['implementation', 'testing']) {
      expect(JSON.stringify(after.content.phases.find((one) => one.key === key)!.checks)).toBe(
        JSON.stringify(before.content.phases.find((one) => one.key === key)!.checks),
      );
    }
  });

  it("a sole work task graded another way than its phase is told so, never told to upload two tasks as one", async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-wt-x22');
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key: 'testing' });
    const implPhase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key: 'implementation' });
    const code = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: implPhase.id, taskKey: INHERITED_TASK_KEY });
    await world.dataSource.getRepository(ProjectTaskEntity).update({ projectPhaseId: phase.id, taskKey: INHERITED_TASK_KEY }, { checks: code.checks, artefactType: code.artefactType });
    const sentence = await said(
      world.service.updateTask(helpers.S1_TEACHER, fork.projectId, fork.versionId, 'testing', INHERITED_TASK_KEY, { title: 'Mine' }),
    );
    expect(sentence).not.toMatch(/more than one task|Upload the project again/);
    expect(sentence).toMatch(/is not graded the way Testing is/);
  });
});

/* ======================================================================== *
 * The editor marks a task as needing                                       *
 * the teacher's countersignature. `tasks.update { signOff }` on a draft:   *
 * the row takes it, the compile carries it (pack-compiler's                 *
 * `authored.signOff === true`), and the draft shows it. Every work kind the *
 * class sign-off queue countersigns takes it; a quiz is refused by name.   *
 * ======================================================================== */
describe('the sign-off mark', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const helpers = require('../../test/tasktrackr-phase') as typeof import('../../test/tasktrackr-phase');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validate } = require('class-validator') as typeof import('class-validator');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { plainToInstance } = require('class-transformer') as typeof import('class-transformer');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UpdateTaskDto } = require('./authoring.dto') as typeof import('./authoring.dto');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { signOffQuizRefusal } = require('./authoring.service') as { signOffQuizRefusal?: (title: string) => string };
  const shelf = path.join(config.contentDir, '..', 'apps', 'api', 'test', 'fixtures', 'upload-packs', 'shelf');
  const KEYS = ['requirements', 'design', 'implementation', 'testing', 'deployment', 'maintenance'] as const;
  let world: Awaited<ReturnType<typeof helpers.openForkWorld>>;
  let n = 0;
  const upload = async () =>
    new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(new DirectoryPackSource(shelf), {
      ownerId: helpers.S1_TEACHER.id,
      title: `Shelf sign-off ${++n}`,
    });
  const mark = (made: { projectId: string; versionId: string }, key: string, body: Record<string, unknown>, taskKey = INHERITED_TASK_KEY) =>
    world.service.updateTask(helpers.S1_TEACHER, made.projectId, made.versionId, key as never, taskKey, body as never);
  const said = async (made: Promise<unknown>): Promise<string> => {
    try {
      await made;
    } catch (error) {
      const response = (error as { getResponse?: () => unknown; getStatus?: () => number }).getResponse?.() as { message?: unknown } | undefined;
      return `${(error as { getStatus?: () => number }).getStatus?.() ?? 'thrown'} ${String(response?.message ?? (error as Error).message)}`;
    }
    return 'SAVED';
  };
  const compiledMark = async (made: { versionId: string }, key: string, taskKey = INHERITED_TASK_KEY) =>
    (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).compiled!.phases
      .find((one) => one.key === key)!.tasks.find((one) => one.taskKey === taskKey)?.signOff;
  const draftMark = async (made: { projectId: string; versionId: string }, key: string, taskKey = INHERITED_TASK_KEY) =>
    (await world.service.readDraft(helpers.S1_TEACHER, made.projectId, made.versionId)).phases
      .find((one) => one.key === key)!.tasks.find((one) => one.taskKey === taskKey)?.signOff;

  beforeAll(async () => {
    world = await helpers.openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
  });

  it("marks an uploaded phase's sole task (the key the editor addresses): the answer, the draft and the compiled snapshot carry signOff true", async () => {
    const made = await upload();
    const result = await mark(made, 'requirements', { signOff: true });
    expect(result.phase.tasks.map((one) => [one.taskKey, one.signOff])).toEqual([[INHERITED_TASK_KEY, true]]);
    expect(await compiledMark(made, 'requirements')).toBe(true);
    expect(await draftMark(made, 'requirements')).toBe(true);
    // the class queue's countersign path keys the task by a row (never the sole key)
    expect(await compiledMark(made, 'requirements')).not.toBeUndefined();
    // one audit row says what moved
    const audit = (await world.dataSource.getRepository(AuditEventEntity).find({ where: { targetId: made.projectId } })).filter((one) => one.event === 'project.tasks');
    expect(audit.map((one) => (one.detail as { signOff?: boolean }).signOff)).toEqual([true]);
  });

  it('every work kind of the Shelf pack takes the mark (written, code, tests, config), and an unmarked task carries no mark (absent reads false; the pinned recordings keep their shape)', async () => {
    const made = await upload();
    for (const key of KEYS) expect([key, await draftMark(made, key)]).toEqual([key, undefined]);
    for (const key of KEYS) {
      expect([key, await said(mark(made, key, { signOff: true }))]).toEqual([key, 'SAVED']);
      expect([key, await compiledMark(made, key)]).toEqual([key, true]);
    }
  });

  it('GUARD › an absent signOff leaves the mark unchanged; false takes it off', async () => {
    const made = await upload();
    await mark(made, 'requirements', { signOff: true });
    await mark(made, 'requirements', { title: 'Write the shelf story' });
    expect(await compiledMark(made, 'requirements')).toBe(true);
    await mark(made, 'implementation', { signOff: true });
    await mark(made, 'implementation', { brief: '## Your task\n\nShelve the books.\n' });
    expect(await compiledMark(made, 'implementation')).toBe(true);
    await mark(made, 'requirements', { signOff: false });
    expect(await compiledMark(made, 'requirements')).toBe(false);
    expect(await draftMark(made, 'requirements')).toBeUndefined();
  });

  it("a quiz is refused by name with a 400 (it is scored by its key and never waits for a countersignature), and nothing is written", async () => {
    expect(typeof signOffQuizRefusal).toBe('function');
    const fork = await helpers.copyTaskTrackr(world, 'rx-s22-quiz');
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key: 'design' });
    const repo = world.dataSource.getRepository(ProjectTaskEntity);
    const checks = fixtureQuizChecks();
    await repo.save(repo.create({
      projectPhaseId: phase.id, taskKey: 'concepts', order: 2, required: false, signOff: false, artefactType: 'quiz', artefactPath: null,
      title: 'Design concepts', brief: FIXTURE_QUIZ_NOTICE, objectives: [], primaryPath: null, anchor: null, rubric: fixtureQuizRubric(checks.criterion), checks,
    }));
    const before = JSON.stringify(await repo.find({ order: { id: 'ASC' } }));
    expect(await said(mark(fork, 'design', { signOff: true }, 'concepts'))).toBe(`400 ${signOffQuizRefusal!('Design concepts')}`);
    expect(JSON.stringify(await repo.find({ order: { id: 'ASC' } }))).toBe(before);
  });

  it("a TaskTrackr copy's inherited task takes the mark too: marked, never counted; provenance, the anchors and the reviewer scope do not move", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { phaseProvenance } = require('./provenance') as typeof import('./provenance');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scope = require('../assistant/project-scope') as typeof import('../assistant/project-scope');
    const fork = await helpers.copyTaskTrackr(world, 'rx-s22-copy');
    const untouched = await helpers.draftSnapshot(world, fork);
    const facts = (snapshot: CompiledSnapshot) =>
      snapshot.content.phases.map((phase) => {
        const tasks = snapshot.phases.find((one) => one.key === phase.key)!.tasks;
        return {
          key: phase.key,
          provenance: phaseProvenance(phase, tasks, 'TaskTrackr'),
          anchors: tasks.map((task) => (phase.checks.kind === 'story' || phase.checks.kind === 'design' ? scope.referenceAnchor(phase, task) : scope.executableReferenceAnchor(phase, task))),
          scope: tasks.map((task) => scope.taskScopeOf(phase, task, tasks).kind),
        };
      });
    // the copy's first save stores its markdown plain: its anchors move to the plain-text twin, and
    // provenance and the reviewer scope stay the reference's through it (the plain-text twin)
    expect(await said(mark(fork, 'design', { signOff: false }))).toBe('SAVED');
    const before = await helpers.draftSnapshot(world, fork);
    const sameIdentity = (snapshot: CompiledSnapshot) => facts(snapshot).map(({ key, provenance, scope: kinds }) => ({ key, provenance, kinds }));
    expect(JSON.parse(JSON.stringify(sameIdentity(before)))).toEqual(JSON.parse(JSON.stringify(sameIdentity(untouched))));
    expect(before.content.phases.find((one) => one.key === 'requirements')!.taskPanel).toBe(plainTextOf(untouched.content.phases.find((one) => one.key === 'requirements')!.taskPanel));
    // the written arm (requirements), the executable arm (implementation), and a task neither arm edits (deployment's config)
    for (const key of ['requirements', 'implementation', 'deployment']) {
      expect([key, await said(mark(fork, key, { signOff: true }))]).toEqual([key, 'SAVED']);
      expect([key, await compiledMark(fork, key)]).toEqual([key, true]);
    }
    const after = await helpers.draftSnapshot(world, fork);
    expect(JSON.parse(JSON.stringify(facts(after)))).toEqual(JSON.parse(JSON.stringify(facts(before))));
    // and only the mark moved in the compiled task lists
    const unmarked = (snapshot: CompiledSnapshot) => snapshot.phases.map((phase) => ({ ...phase, tasks: phase.tasks.map((task) => ({ ...task, signOff: false })) }));
    expect(JSON.stringify(unmarked(after))).toBe(JSON.stringify(unmarked(before)));
    expect(JSON.stringify(after.content)).toBe(JSON.stringify(before.content));
  });

  it('GUARD › a task neither arm edits still refuses every other member (the inherited-task refusal), with or without the mark', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-s22-inherited');
    // TaskTrackr 5.0.0's Deployment takes the runbook arm, so the task neither arm edits is a config task in the
    // older shape: the copy's Deployment row with its runbook taken out, as a draft stored before the records holds it.
    const deploymentPhase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: fork.versionId, key: 'deployment' });
    const tasks = world.dataSource.getRepository(ProjectTaskEntity);
    const row = await tasks.findOneByOrFail({ projectPhaseId: deploymentPhase.id });
    const { runbook: _runbook, ...older } = row.checks as import('../content/content.types').ConfigChecks;
    await tasks.update({ id: row.id }, { checks: older as ProjectTaskEntity['checks'] });
    const answer = await said(mark(fork, 'deployment', { signOff: true, title: 'Ship it' }));
    expect(answer).toMatch(/^403 /);
    expect(await compiledMark(fork, 'deployment')).toBe(false);
  });

  it('GUARD › a published version refuses the mark with the existing draft-only refusal', async () => {
    const fork = await helpers.copyTaskTrackr(world, 'rx-s22-published');
    await world.service.publish(helpers.S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
    const title = await said(mark(fork, 'requirements', { title: 'Anything' }));
    expect(title).toMatch(/^409 /);
    expect(await said(mark(fork, 'requirements', { signOff: true }))).toBe(title);
  });

  it("UpdateTaskDto takes signOff as a boolean only (the whitelist pipe no longer strips it)", async () => {
    const errorsOf = async (body: Record<string, unknown>) => (await validate(plainToInstance(UpdateTaskDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((one) => one.property);
    expect(await errorsOf({ signOff: true })).toEqual([]);
    expect(await errorsOf({ signOff: false })).toEqual([]);
    expect(await errorsOf({ signOff: 'yes' })).toEqual(['signOff']);
    expect(await errorsOf({ signOff: 1 })).toEqual(['signOff']);
    expect(await errorsOf({})).toEqual([]);
  });
});

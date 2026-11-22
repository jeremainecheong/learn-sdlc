import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import type { AssistantService } from '../assistant/assistant.service';
import { config } from '../config';
import { HealthService } from '../health/health.service';
import type { JobsService } from '../jobs/jobs.service';
import { SeedService } from '../seed/seed.service';
import { EXECUTABLE_SPLIT_NOT_READY } from '@learnsdlc/shared';
import { ContentService } from './content.service';
import type { PhaseContent, ProjectContent } from './content.types';
import { ProjectImporterService } from './importer.service';
import { COMPILER_IDENTITY, checksOf, soleTaskFor } from './pack-compiler';
import { ProjectEntity, ProjectVersionEntity } from './project.entities';
import { ProjectRegistryService } from './project-registry.service';
import { compiledQuizSnapshot, fixtureQuizChecks } from '../../test/quiz-fixture';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The wiring that serves content out of the database.
 *
 * `import-identity.spec.ts` settles the equality, what the compiler produces
 * from a pack's bytes is what the loader produces from them, by building the
 * whole chain by hand. That proof is worth nothing to a learner unless the
 * running application is the thing that takes it, and this spec asserts that
 * it does: the registry is registered, and the answers come out of
 * `project_versions` rather than off a walk of `CONTENT_DIR`.
 *
 * So the first describe boots the real `AppModule` against an empty database
 * and asks the questions only the database path can answer. The tell is
 * `headVersionIdFor`: a `project_versions.id` exists nowhere on disk, so an
 * answer that carries one came out of the table.
 *
 * The rest are the failure modes, each of which had to be decided rather than
 * discovered: an empty database with a readable pack, an import that refuses,
 * a boot that would otherwise serve an empty catalogue, and a snapshot some
 * other build of this code compiled.
 */

const SHIPPED = 'tasktrackr';

/** A `SeedService` that has imported what it is told it has. */
const seedThatImported = (results: unknown[] | null): SeedService =>
  ({ importedContent: results }) as unknown as SeedService;

const freshDatabase = async (): Promise<DataSource> =>
  memoryDataSource();

describe('a boot serves the project out of the database', () => {
  let app: INestApplication;
  let db: DataSource;
  let content: ContentService;
  let onDisk: ProjectContent;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    db = app.get(DataSource);
    content = app.get(ContentService);
    const loader = new ContentService();
    loader.loadAll();
    onDisk = loader.getProject(SHIPPED);
  });

  afterAll(async () => {
    await app.close();
  });

  it('the first boot imports the pack, publishes it and installs the snapshot', async () => {
    const published = await db
      .getRepository(ProjectVersionEntity)
      .find({ where: { status: 'published' } });
    expect(published).toHaveLength(1);
    expect(published[0].compiled).not.toBeNull();
    expect(published[0].version).toBe(onDisk.version);

    // The tell. `loadAll()` installs no version rows, so a head id at all:
    // let alone this one: can only have come out of `project_versions`.
    expect(content.headVersionIdFor(SHIPPED)).toBe(published[0].id);
    expect(content.getProject(SHIPPED).version).toBe(published[0].version);
  });

  it('what the running application serves is what the directory holds', () => {
    expect(content.getProject(SHIPPED)).toEqual(onDisk);
    expect(content.listProjects().map((p) => p.slug)).toEqual([SHIPPED]);
  });

  it('the boot does not walk a directory to find its content', () => {
    // The service has no `onModuleInit` at all, not an empty one: a method
    // that exists is a method a later edit can put a `loadAll()` into.
    expect((content as unknown as { onModuleInit?: unknown }).onModuleInit).toBeUndefined();
  });

  it('an enrolment can be pinned to the version this boot published', () => {
    const head = content.headVersionIdFor(SHIPPED) as string;
    expect(head).toEqual(expect.any(String));
    expect(content.getForEnrollment({ projectSlug: SHIPPED, projectVersionId: head })).toEqual(
      onDisk,
    );
    // and the legacy row, which has no pin and is not given one by a read
    expect(
      content.getForEnrollment({ projectSlug: SHIPPED, projectVersionId: null }),
    ).toEqual(onDisk);
  });

  it('readiness names the content this instance is serving', async () => {
    const health = new HealthService(
      db,
      { backendName: 'in-process', durable: false, ping: async () => undefined } as unknown as JobsService,
      { activeProviderName: () => 'mock-ai' } as unknown as AssistantService,
      content,
    );
    const report = await health.readiness();
    const entry = report.dependencies.find((d) => d.name === 'content');
    expect(entry).toMatchObject({ ok: true, required: true });
    expect(entry?.detail).toContain(`${SHIPPED} ${onDisk.version}`);
    expect(report.dependencies.find((d) => d.name === 'content-compiler')).toMatchObject({
      ok: true,
      required: false,
    });
  });

  it('a probe nobody is credentialled for is told how many, not which', async () => {
    // `GET /health/ready` is `@Public()` and answers the whole report, so the
    // two probes above were publishing this deployment's catalogue, and the
    // build's internal compiler identity: to anyone who asked. The registry
    // holds every teacher-authored project, so that would be an anonymous
    // enumeration of every teacher's work. The counts are what a load balancer needs; the names are for
    // an operator, behind the credential `metricsAccess` already defines.
    const health = new HealthService(
      db,
      { backendName: 'in-process', durable: false, ping: async () => undefined } as unknown as JobsService,
      { activeProviderName: () => 'mock-ai' } as unknown as AssistantService,
      content,
    );
    const nodeEnv = process.env.NODE_ENV;
    try {
      // Production with no METRICS_TOKEN set: `metricsAccess` closes it.
      process.env.NODE_ENV = 'production';
      const report = await health.readiness();
      const entry = report.dependencies.find((d) => d.name === 'content');
      // Still the probe a load balancer reads: required, and green.
      expect(entry).toMatchObject({ ok: true, required: true });
      expect(entry?.detail).toBe('1 project registered');
      expect(entry?.detail).not.toContain(SHIPPED);
      const compiler = report.dependencies.find((d) => d.name === 'content-compiler');
      expect(compiler).toMatchObject({ ok: true, required: false });
      expect(compiler?.detail).not.toContain(COMPILER_IDENTITY);
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });
});

describe('the boot refuses rather than serving nothing', () => {
  let dir = '';
  let loaded: ProjectContent;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-registry-boot-'));
    const loader = new ContentService();
    loader.loadAll();
    loaded = loader.getProject(SHIPPED);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the registry refuses the boot when the import has not run', async () => {
    const db = await freshDatabase();
    try {
      const registry = new ProjectRegistryService(new ContentService(), db, seedThatImported(null));
      await expect(registry.onApplicationBootstrap()).rejects.toThrow(
        /ran before the content import/,
      );
    } finally {
      await db.destroy();
    }
  });

  it('the registry refuses the boot when nothing is published', async () => {
    const db = await freshDatabase();
    try {
      const registry = new ProjectRegistryService(new ContentService(), db, seedThatImported([]));
      await expect(registry.onApplicationBootstrap()).rejects.toThrow(
        /no published project version/,
      );
      // and the sentence tells an operator where the packs come from, which is
      // the whole difference between a refusal and a 404 for every learner
      await expect(registry.onApplicationBootstrap()).rejects.toThrow(/import-pack/);
    } finally {
      await db.destroy();
    }
  });

  it('an import that refuses stops the boot, and leaves nothing to install', async () => {
    const root = path.join(dir, 'broken');
    const pack = path.join(root, SHIPPED);
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.join(config.contentDir, SHIPPED), pack, { recursive: true });
    const at = path.join(pack, 'project.json');
    const meta = JSON.parse(fs.readFileSync(at, 'utf-8')) as Record<string, unknown>;
    delete meta.language;
    fs.writeFileSync(at, JSON.stringify(meta, null, 2), 'utf-8');

    const db = await freshDatabase();
    try {
      const seed = new SeedService(
        undefined as never,
        undefined as never,
        undefined as never,
        new ProjectImporterService(new ContentService(), db),
        undefined as never,
        undefined as never,
      );
      await expect(seed.importPlatformContent(root)).rejects.toThrow(/project\.json: language/);
      // nothing half-imported, and nothing for the registry to install: the
      // boot stops here rather than at a catalogue that answers every learner
      // "unknown project"
      expect(await db.getRepository(ProjectVersionEntity).count()).toBe(0);
      expect(seed.importedContent).toBeNull();
    } finally {
      await db.destroy();
    }
  });

  it('a restart installs what is published before the rest of the boot reads it', async () => {
    // Every module-init hook runs before every bootstrap hook, and one service
    // that sweeps at bootstrap asks the pack for a phase title
    // (`NotificationsService.phaseTitle`). It sits at a shallower dependency
    // depth than this registry can have, so the early read is what keeps a
    // restart's first notification carrying the phase's title rather than its
    // key. The seed is deliberately one that has *not* run: this read does not
    // wait for it.
    const db = await freshDatabase();
    try {
      await new ProjectImporterService(new ContentService(), db).importContentDirectory(
        config.contentDir,
        { origin: 'seed', platformOwned: true },
      );
      const registered = new ContentService();
      await new ProjectRegistryService(registered, db, seedThatImported(null)).onModuleInit();
      expect(registered.getProject(SHIPPED)).toEqual(loaded);
    } finally {
      await db.destroy();
    }
  });

  it('a first boot has nothing to install early, and that is not a refusal', async () => {
    const db = await freshDatabase();
    try {
      const registered = new ContentService();
      await expect(
        new ProjectRegistryService(registered, db, seedThatImported(null)).onModuleInit(),
      ).resolves.toBeUndefined();
      expect(registered.listProjects()).toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it('an early read that cannot answer is left to the boot, not thrown', async () => {
    const db = await freshDatabase();
    await db.destroy();
    const registered = new ContentService();
    // A database that is not up is a reason to wait for the bootstrap read,
    // not a reason to stop the process before the import has had its turn.
    await expect(
      new ProjectRegistryService(registered, db, seedThatImported(null)).onModuleInit(),
    ).resolves.toBeUndefined();
    expect(registered.listProjects()).toEqual([]);
  });

  it('a reload that finds nothing leaves the answer the registry already gave', async () => {
    const registered = new ContentService();
    registered.installVersions([
      { versionId: 'a-version-id', content: loaded, compiler: COMPILER_IDENTITY },
    ]);
    const db = await freshDatabase();
    try {
      // `load()` is the reload, and an empty read is not a reason to empty a
      // catalogue that is answering learners right now
      expect(await new ProjectRegistryService(registered, db, seedThatImported([])).load()).toBe(0);
      expect(registered.getProject(SHIPPED)).toEqual(loaded);
    } finally {
      await db.destroy();
    }
  });
});

describe('the compiler that produced a snapshot is recorded with it', () => {
  let db: DataSource;
  let loaded: ProjectContent;
  let versionId = '';

  beforeAll(async () => {
    db = await freshDatabase();
    const loader = new ContentService();
    loader.loadAll();
    loaded = loader.getProject(SHIPPED);
    const result = await new ProjectImporterService(loader, db).importContentDirectory(
      config.contentDir,
      { origin: 'seed', platformOwned: true },
    );
    versionId = result[0].projectVersionId;
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('a published version stores the compiler identity beside the snapshot', async () => {
    const row = await db.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    expect(row.compiled?.compiler).toBe(COMPILER_IDENTITY);
  });

  it('a snapshot another build compiled is served unchanged and reported as drift', async () => {
    const versions = db.getRepository(ProjectVersionEntity);
    const row = await versions.findOneByOrFail({ id: versionId });
    await versions.update(
      { id: versionId },
      { compiled: { ...row.compiled!, compiler: 'an-older-build' } },
    );

    const registered = new ContentService();
    expect(await new ProjectRegistryService(registered, db, seedThatImported([])).load()).toBe(1);

    // The pin's guarantee first: the stored snapshot is what a learner pinned
    // to this version resolves, and a drift does not recompile it.
    expect(registered.getProject(SHIPPED)).toEqual(loaded);
    expect(registered.compilerDrift()).toEqual([
      {
        slug: SHIPPED,
        version: loaded.version,
        compiledBy: 'an-older-build',
        thisBuild: COMPILER_IDENTITY,
      },
    ]);
  });

  it('readiness says which version carries the older compile', async () => {
    const registered = new ContentService();
    await new ProjectRegistryService(registered, db, seedThatImported([])).load();
    const health = new HealthService(
      db,
      { backendName: 'in-process', durable: false, ping: async () => undefined } as unknown as JobsService,
      { activeProviderName: () => 'mock-ai' } as unknown as AssistantService,
      registered,
    );
    const report = await health.readiness();
    const entry = report.dependencies.find((d) => d.name === 'content-compiler');
    // Not `required`: the deployment serves every learner correctly, and the
    // thing an operator has to be told is that a version bump is owed.
    expect(entry).toMatchObject({ ok: false, required: false });
    expect(entry?.detail).toContain(`${SHIPPED} ${loaded.version}`);
    expect(entry?.detail).toContain('an-older-build');
    // the content itself is still being served
    expect(report.dependencies.find((d) => d.name === 'content')).toMatchObject({ ok: true });
  });

  it('readiness says which version this build cannot grade at all', async () => {
    // Teacher-authored projects: the runtime half of the wall. A
    // stored phase whose checks are not `markdown` and whose task list holds
    // two or more is refused at the learner's seam, so nobody meets an error
    // and nothing in the logs says a class has stopped working. The boot
    // `logger.warn` is one line at start-up that scrolls away; this is the
    // line an operator can probe for afterwards, and it is why the fact is
    // surfaced here as well as recorded there.
    const registered = new ContentService();
    const loader = new ContentService();
    loader.loadAll();
    const project = loader.getProject(SHIPPED);
    // an executable phase: a written or a story phase may split into tasks
    const executable = project.phases.find((one) => ['code', 'tests', 'config'].includes(one.checks.kind));
    expect(executable).toBeDefined();
    const phase = executable as PhaseContent;
    const sole = soleTaskFor(phase);
    registered.installVersions([
      {
        versionId: 'v-a-later-build-compiled-this',
        content: project,
        compiler: COMPILER_IDENTITY,
        phases: project.phases.map((one) =>
          one.key === phase.key
            ? {
                key: one.key,
                tasks: [
                  { ...sole, taskKey: 'one', order: 1 },
                  { ...sole, taskKey: 'two', order: 2 },
                ],
              }
            : { key: one.key, tasks: [soleTaskFor(one)] },
        ),
      },
    ]);
    const health = new HealthService(
      db,
      { backendName: 'in-process', durable: false, ping: async () => undefined } as unknown as JobsService,
      { activeProviderName: () => 'mock-ai' } as unknown as AssistantService,
      registered,
    );
    const report = await health.readiness();
    const entry = report.dependencies.find((d) => d.name === 'content-compiler');
    expect(entry).toMatchObject({ ok: false, required: false });
    expect(entry?.detail).toContain(phase.key);
    expect(entry?.detail).toContain(EXECUTABLE_SPLIT_NOT_READY);

    // And the count without the names, for the probe nobody is credentialled
    // for: the same rule the two probes beside it already follow.
    const nodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const closed = (await health.readiness()).dependencies.find(
        (d) => d.name === 'content-compiler',
      );
      expect(closed).toMatchObject({ ok: false });
      expect(closed?.detail).toContain('1 registered version');
      expect(closed?.detail).not.toContain(phase.key);
    } finally {
      process.env.NODE_ENV = nodeEnv;
    }
  });
});

describe('the catalogue an unordered SELECT hands back', () => {
  /**
   * `listProjects()` is the catalogue, and two production sites take its
   * first element as a tie-break when a caller has no project of their own:
   * a class's schedule (`instructor/schedule.service.ts`) and the class map
   * (`analytics/analytics.service.ts`).
   *
   * Before the swap the order was `directoryPacksIn`'s, which sorts by
   * directory name. After it, the rows arrive from
   * `project_versions.find({ where: { status: 'published' } })`: an unordered
   * SELECT, whose order no database promises and whose heap order moves under
   * UPDATE and VACUUM. A tie-break that changes at a restart with no content
   * change is a class schedule and a class map that can each answer a
   * different project, so the order has to be a fact about the
   * content rather than about the storage.
   */
  it('is in slug order, whatever order the rows arrive in', () => {
    const loader = new ContentService();
    loader.loadAll();
    const shipped = loader.getProject(SHIPPED);
    const other: ProjectContent = { ...shipped, slug: 'a-ledger-lab', title: 'Ledger Lab' };

    const registered = new ContentService();
    registered.installVersions([
      { versionId: 'pv-shipped', content: shipped, compiler: COMPILER_IDENTITY },
      { versionId: 'pv-other', content: other, compiler: COMPILER_IDENTITY },
    ]);

    expect(registered.listProjects().map((project) => project.slug)).toEqual([
      'a-ledger-lab',
      SHIPPED,
    ]);
  });
});

/* ------------------- the key the scorer has and the browser does not ------- */

/**
 * **A published quiz reaches the runtime with its key intact.**
 *
 * The other half of the seal. `taskViews` is asserted to carry no question, no
 * `correct` and no `explanation` (`task-view.spec.ts`), and a seal that held
 * because the questions never arrived at all would be a quiz nothing could
 * score. So this reads the same fact from the server's side of the wall: the
 * registry's read path carries `compiled.phases` out of the stored snapshot,
 * and what the scorer holds for a quiz task is the whole `QuizChecks` slice
 * (every question of the **pool**, its key and its explanation) for the design
 * phase, where a quiz needs no rule at all, and for the deployment phase,
 * which is the all-six-phases rule.
 *
 * It goes through a real `project_versions` row rather than `installVersions`
 * because `publishedVersions`' `phases: row.compiled.phases ?? undefined` is
 * the line under test: without it the task list is dropped, and a spec that
 * handed the list straight to `installVersions` would never touch it.
 */
describe('a published quiz reaches the runtime with its key', () => {
  let db: DataSource;
  let registered: ContentService;
  let pin = { projectSlug: '', projectVersionId: null as string | null };

  beforeAll(async () => {
    db = await freshDatabase();
    const snapshot = compiledQuizSnapshot();
    const projects = db.getRepository(ProjectEntity);
    const project = await projects.save(
      projects.create({
        slug: snapshot.slug,
        title: snapshot.content.title,
        platformOwned: false,
        ownerUserId: 'a-teacher',
        origin: 'blank',
      }),
    );
    const versions = db.getRepository(ProjectVersionEntity);
    const version = await versions.save(
      versions.create({
        projectId: project.id,
        version: snapshot.version,
        status: 'published',
        manifest: {
          tagline: snapshot.content.tagline,
          description: snapshot.content.description,
          language: snapshot.content.language,
          languages: snapshot.content.languages,
        },
        compiled: snapshot,
        publishedAt: '2026-09-19T00:00:00.000Z',
      }),
    );
    registered = new ContentService();
    expect(await new ProjectRegistryService(registered, db, seedThatImported([])).load()).toBe(1);
    pin = { projectSlug: snapshot.slug, projectVersionId: version.id };
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('the version resolves rather than being refused at the enrolment seam', () => {
    // A phase holding one executable task and one quiz divides nothing, so
    // the runtime wall serves it. A version recorded unservable here would
    // publish green and 500 every learner pinned to it on their next board.
    expect(registered.unservableVersions()).toEqual([]);
    expect(registered.getPhaseForEnrollment(pin, 'deployment').key).toBe('deployment');
  });

  it('hands the scorer the whole pool, its key and its explanations', () => {
    const expected = fixtureQuizChecks();
    for (const [key, quizKey] of [
      ['design', 'design-check'],
      ['deployment', 'deployment-check'],
    ]) {
      const tasks = registered.getTasksForEnrollment(pin, key);
      expect(tasks.map((task) => task.taskKey)).toEqual(['main', quizKey]);

      const quiz = tasks[1];
      expect(quiz.checkKind).toBe('quiz');
      const checks = checksOf(registered.getPhaseForEnrollment(pin, key), quiz);
      expect(checks.kind).toBe('quiz');
      if (checks.kind !== 'quiz') throw new Error('unreachable');

      // The whole pool, not the draw: a pool exists so that a retake is a
      // different paper, and the undrawn half is what makes it one.
      expect(checks.questions.map((question) => question.id)).toEqual(
        expected.questions.map((question) => question.id),
      );
      expect(checks.questions.map((question) => question.correct)).toEqual(
        expected.questions.map((question) => question.correct),
      );
      expect(checks.questions.map((question) => question.explanation)).toEqual(
        expected.questions.map((question) => question.explanation),
      );
      expect(checks.drawn).toBe(expected.drawn);
      expect(checks.passMark).toBe(expected.passMark);
      expect(checks.attempts).toEqual(expected.attempts);
      expect(checks.criterion).toBe(expected.criterion);
    }
  });

  it('leaves the executable task reading the phase’s own checks', () => {
    // The exemption that lets a sole non-quiz task omit its own checks, read
    // back through the runtime: the sole non-quiz task
    // carries no slice of its own, so the stored snapshot holds the phase's
    // checks once and `checksOf` is what answers for it. A copy would have put
    // every sealed byte in `project_versions.compiled` twice.
    const phase = registered.getPhaseForEnrollment(pin, 'deployment');
    const [executable, quiz] = registered.getTasksForEnrollment(pin, 'deployment');
    expect(executable.checks).toBeUndefined();
    expect(checksOf(phase, executable)).toBe(phase.checks);
    // and the quiz is the one task that must never take that fallback
    expect(quiz.checks).toBeDefined();
    expect(checksOf(phase, quiz)).not.toBe(phase.checks);
  });
});

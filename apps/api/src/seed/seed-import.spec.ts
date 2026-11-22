import { passwordWorkFixture } from '../../test/password-work.fixture';
import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { compareProjectVersions } from '@learnsdlc/shared';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import { config } from '../config';
import {
  ContentBlobEntity,
  EnrollmentEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectVersionEntity,
  SettingEntity,
  UserEntity,
} from '../db/entities';
import { ContentService } from '../content/content.service';
import { ProjectImporterService, packDigestOf } from '../content/importer.service';
import { describeImport } from '../content/import-report';
import { COMPILER_IDENTITY, contentDigestOf } from '../content/pack-compiler';
import { DirectoryPackSource } from '../content/pack-source';
import { SeedService } from './seed.service';
import { StoryRepinService } from './story-repin.service';
import { NullPinService } from './null-pin.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The seed's content branch.
 *
 * A content fix reaches production by baking the pack directory into the
 * image, and the pack on disk is an import source at boot. The danger is
 * precise: an idempotence rule written as "has this project been seeded"
 * would make the on-disk pack inert for ever after the first boot, and a
 * redeploy that ships new content would silently change nothing.
 *
 * So idempotence is on `(slug, version)` **and the import's content digest**,
 * and the three answers are different in kind: the same version from the same
 * bytes is a no-op and one log line, a bumped version is a new published head,
 * and the same version from *different* bytes refuses the boot by name. The
 * last one is the assertion that `origin = 'seed'` is never used as an
 * existence check.
 */
describe("the seed's content import", () => {
  let dataSource: DataSource;
  let seed: SeedService;
  let importer: ProjectImporterService;
  let root = '';
  let logged: string[] = [];

  /** A content root holding one copy of the shipped pack, which a test may edit. */
  const packRoot = (name: string): string => {
    const at = path.join(root, name);
    fs.mkdirSync(at, { recursive: true });
    fs.cpSync(path.join(config.contentDir, 'tasktrackr'), path.join(at, 'tasktrackr'), {
      recursive: true,
    });
    return at;
  };

  const metaOf = (at: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(at, 'tasktrackr', 'project.json'), 'utf-8'));

  const writeMeta = (at: string, meta: Record<string, unknown>): void =>
    fs.writeFileSync(
      path.join(at, 'tasktrackr', 'project.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );

  const counts = async (): Promise<Record<string, number>> => ({
    content_blobs: await dataSource.getRepository(ContentBlobEntity).count(),
    projects: await dataSource.getRepository(ProjectEntity).count(),
    project_versions: await dataSource.getRepository(ProjectVersionEntity).count(),
    project_phases: await dataSource.getRepository(ProjectPhaseEntity).count(),
    project_files: await dataSource.getRepository(ProjectFileEntity).count(),
  });

  const versionsOf = async (slug: string): Promise<ProjectVersionEntity[]> => {
    const project = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ slug });
    return dataSource
      .getRepository(ProjectVersionEntity)
      .find({ where: { projectId: project.id } });
  };

  /** A content root holding one copy of the shipped pack under another slug. */
  const addPack = (at: string, dir: string, slug: string): void => {
    fs.mkdirSync(at, { recursive: true });
    fs.cpSync(path.join(config.contentDir, 'tasktrackr'), path.join(at, dir), { recursive: true });
    const meta = path.join(at, dir, 'project.json');
    writeMetaAt(meta, { ...JSON.parse(fs.readFileSync(meta, 'utf-8')), slug });
  };

  const writeMetaAt = (at: string, meta: Record<string, unknown>): void =>
    fs.writeFileSync(at, JSON.stringify(meta, null, 2), 'utf-8');

  /** Which projects claim to be the one a request naming none answers for. */
  const flaggedSlugs = async (): Promise<string[]> =>
    (await dataSource.getRepository(ProjectEntity).find({ where: { isDefault: true } }))
      .map((row) => row.slug)
      .sort();

  const platform = { origin: 'seed' as const, platformOwned: true };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-seed-'));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    dataSource = await memoryDataSource();
    importer = new ProjectImporterService(new ContentService(), dataSource);
    seed = new SeedService(
      new AuthService(
        passwordWorkFixture(),
        dataSource.getRepository(UserEntity),
        new JwtService({ secret: 'seed-import-spec' }),
      ),
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(SettingEntity),
      importer,
      new StoryRepinService(dataSource),
      new NullPinService(dataSource),
    );
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('a first boot imports, compiles, publishes and flags the default', async () => {
    const at = packRoot('first-boot');
    const [result] = await seed.importPlatformContent(at);

    expect(result.outcome).toBe('imported');
    const projects = await dataSource.getRepository(ProjectEntity).find();
    expect(projects).toHaveLength(1);
    expect({
      slug: projects[0].slug,
      origin: projects[0].origin,
      isDefault: projects[0].isDefault,
      platformOwned: projects[0].platformOwned,
      ownerUserId: projects[0].ownerUserId,
    }).toEqual({
      slug: 'tasktrackr',
      origin: 'seed',
      isDefault: true,
      platformOwned: true,
      ownerUserId: null,
    });

    const versions = await versionsOf('tasktrackr');
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('published');
    expect(versions[0].version).toBe('6.0.0');
    expect(versions[0].compiled).not.toBeNull();
    expect(versions[0].contentDigest).toMatch(/^[0-9a-f]{64}$/);
    // 0 + 0 + 4 + 10 + 2 + 4, the deployment's 2 being the
    // smoke run plus the incident drill's own smoke.
    expect(versions[0].sandboxBudget).toBe(20);
    expect(versions[0].compiled?.sandboxBudgetByPhase).toEqual({
      requirements: 0,
      design: 0,
      implementation: 4,
      testing: 10,
      deployment: 2,
      maintenance: 4,
    });
    // nobody published it here, so no person is named
    expect(versions[0].publishedByUserId).toBeNull();
    expect(await dataSource.getRepository(ProjectPhaseEntity).count()).toBe(6);
  });

  it('a second boot with unchanged bytes writes nothing', async () => {
    const at = packRoot('second-boot');
    await seed.importPlatformContent(at);
    const before = await counts();
    logged = [];
    const warned: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warned.push(String(message));
    });

    const [again] = await seed.importPlatformContent(at);

    expect(again.outcome).toBe('unchanged');
    expect(await counts()).toEqual(before);
    expect(logged.filter((line) => line.includes('tasktrackr'))).toHaveLength(1);
    expect(logged[0]).toMatch(/6\.0\.0/);
    // and nothing to warn about: this build compiled the snapshot this version
    // holds, so the drift line below must not fire on an ordinary boot.
    expect(warned).toEqual([]);
  });

  it('a bumped project.json imports as a new published version and becomes the head', async () => {
    const at = packRoot('bumped');
    await seed.importPlatformContent(at);
    const first = (await versionsOf('tasktrackr'))[0];

    writeMeta(at, { ...metaOf(at), version: '6.0.1' });
    const [bumped] = await seed.importPlatformContent(at);

    expect(bumped.outcome).toBe('imported');
    const versions = await versionsOf('tasktrackr');
    expect(versions).toHaveLength(2);
    // both published, both immutable: the superseded version is what an
    // enrolment pinned to it keeps resolving
    expect(versions.map((v) => `${v.version}:${v.status}`).sort()).toEqual([
      '6.0.0:published',
      '6.0.1:published',
    ]);
    expect(versions.find((v) => v.version === '6.0.0')!.id).toBe(first.id);
    expect(versions.find((v) => v.version === '6.0.0')!.contentDigest).toBe(first.contentDigest);

    // the head is the newest published version, compared field by field as
    // numbers rather than as strings
    const head = await importer.newestPublishedVersion(dataSource.manager, versions[0].projectId);
    expect(head?.version).toBe('6.0.1');
    expect(compareProjectVersions('6.0.1', '6.0.0')).toBeGreaterThan(0);

    // `isDefault` is on the project, not the version, so a bump moves the head
    // with no further write
    const projects = await dataSource.getRepository(ProjectEntity).find();
    expect(projects).toHaveLength(1);
    expect(projects[0].isDefault).toBe(true);
  });

  it('an enrolment pinned to the superseded version still resolves it', async () => {
    const at = packRoot('pinned');
    await seed.importPlatformContent(at);
    const [old] = await versionsOf('tasktrackr');
    // a learner with a term of work, pinned the day they enrolled
    const enrollment = await dataSource.getRepository(EnrollmentEntity).save({
      userId: 'pinned-learner',
      projectSlug: 'tasktrackr',
      packVersion: old.version,
      projectVersionId: old.id,
    });

    writeMeta(at, { ...metaOf(at), version: '6.0.1', title: 'TaskTrackr, retitled' });
    await seed.importPlatformContent(at);

    // The row half of the version pin: `ContentService.getForEnrollment`
    // reads exactly this row, so the property it needs is that the pinned
    // version is still there, still published and still the old bytes.
    const pinned = await dataSource
      .getRepository(ProjectVersionEntity)
      .findOneByOrFail({ id: enrollment.projectVersionId! });
    expect(pinned.version).toBe('6.0.0');
    expect(pinned.status).toBe('published');
    expect(pinned.compiled?.content.title).toBe('TaskTrackr — a task manager you can run');

    // and a learner enrolling now gets the head, which is the other half
    const head = await importer.newestPublishedVersion(dataSource.manager, pinned.projectId);
    expect(head?.version).toBe('6.0.1');
    expect(head?.compiled?.content.title).toBe('TaskTrackr, retitled');
  });

  it('the same version from different bytes refuses boot by name', async () => {
    const at = packRoot('changed-bytes');
    await seed.importPlatformContent(at);
    const before = await counts();

    // A content fix that forgot the version bump. `origin = 'seed'` as an
    // existence check would make this boot a silent no-op: the pack inert, a
    // redeploy that ships content changing nothing, so the digest is
    // what decides, and this is the assertion that it does.
    writeMeta(at, { ...metaOf(at), title: 'TaskTrackr, quietly edited' });

    await expect(seed.importPlatformContent(at)).rejects.toThrow(
      /tasktrackr is at 6\.0\.0, which is already published from different bytes\. A published version is immutable — bump project\.json's version to import this change\./,
    );
    expect(await counts()).toEqual(before);
    const [version] = await versionsOf('tasktrackr');
    expect(version.compiled?.content.title).toBe('TaskTrackr — a task manager you can run');
  });

  it("the digest is the pack's own bytes, so a deploy that only changed code still boots", async () => {
    const at = packRoot('compiler-drift');
    const [first] = await seed.importPlatformContent(at);
    const versions = dataSource.getRepository(ProjectVersionEntity);
    const row = await versions.findOneByOrFail({ id: first.projectVersionId });
    const budget = row.compiled?.sandboxBudget as number;

    // The column the refusal reads is a digest of the pack's files and of
    // nothing else, not of the compiled snapshot, which embeds the loader's
    // whole output and the compiler's derived tasks.
    expect(first.contentDigest).toBe(
      packDigestOf(new DirectoryPackSource(path.join(at, 'tasktrackr'))),
    );
    expect(first.contentDigest).not.toBe(contentDigestOf(row.compiled!));

    // A deployment whose code moved and whose content did not. A new build can
    // change the loader and the compiler by design, so the snapshot this
    // version was published with is not the snapshot this build compiles from
    // the same bytes. A digest taken over the *snapshot* would therefore
    // differ for content nobody had touched, and the boot would refuse with a
    // sentence blaming the pack's bytes. Simulated here by editing the
    // stored snapshot, which is what another build's output is.
    await versions.update({ id: row.id }, { compiled: { ...row.compiled!, sandboxBudget: budget + 1 } });
    const said: string[] = [];
    const record = (message: unknown): void => {
      said.push(String(message));
    };
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(record);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(record);

    const [again] = await seed.importPlatformContent(at);

    expect(again.outcome).toBe('unchanged');
    expect(again.contentDigest).toBe(first.contentDigest);
    // Said out loud, naming the compiler rather than the bytes, and returned
    // rather than only logged, which is the difference between a fact an
    // operator can act on and a warning nobody is tailing: the same value is
    // what `import-pack.ts` prints on a terminal and what readiness reports
    // for a version whose pack is not on this machine's disk at all.
    expect(again.compilerDrift).toMatchObject({
      slug: 'tasktrackr',
      version: '6.0.0',
      thisBuild: COMPILER_IDENTITY,
    });
    expect(describeImport(again)).toMatch(/tasktrackr 6\.0\.0/);
    expect(describeImport(again)).toMatch(/compiles these bytes differently from this build/);
    expect(said.join('\n')).toMatch(/tasktrackr 6\.0\.0/);
    // and the published snapshot is not rewritten on the way past: immutable
    // means immutable, and recompiling one in place would move the ground under
    // every enrolment pinned to it.
    expect((await versions.findOneByOrFail({ id: row.id })).compiled?.sandboxBudget).toBe(budget + 1);
  });

  it('every byte under the pack directory is part of the version', async () => {
    const at = packRoot('every-byte');
    await seed.importPlatformContent(at);

    // The digest is over the pack's files, so a file the loader never reads is
    // still a change to the pack, which is the honest reading of "the same
    // version from different bytes" and of the authoring format's version-bump
    // requirement.
    fs.writeFileSync(path.join(at, 'tasktrackr', 'NOTES.md'), 'a note to self\n', 'utf-8');

    await expect(seed.importPlatformContent(at)).rejects.toThrow(
      /already published from different bytes/,
    );
  });

  it('a boot that loses the insert race reads what the winner wrote', async () => {
    const at = packRoot('lost-the-race');
    await seed.importPlatformContent(at);

    // The runbook starts the replicas concurrently (`--scale api=3`) and every
    // one of them imports at boot. The read that answers "no row for this
    // version" and the insert that follows it are not one statement, so the
    // loser of that race meets a unique violation inside its own transaction:
    // and `onApplicationBootstrap` is awaited with nothing catching it, so
    // without handling that container's boot would fail at the one deploy that
    // bumps a content version.
    const violation = Object.assign(new Error('UNIQUE constraint failed: projects.slug'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const write = (importer as unknown as { writePack: (...args: unknown[]) => Promise<unknown> })
      .writePack.bind(importer);
    const spy = jest
      .spyOn(importer as unknown as { writePack: (...args: unknown[]) => Promise<unknown> }, 'writePack')
      .mockImplementationOnce(() => Promise.reject(violation))
      .mockImplementation((...args: unknown[]) => write(...args));

    const [result] = await seed.importPlatformContent(at);

    // The loser wanted this version imported and it is; it is handed the
    // winner's row rather than an error, exactly as `enroll` does.
    expect(result.outcome).toBe('unchanged');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await versionsOf('tasktrackr')).toHaveLength(1);
  });

  it('the retry is one retry, and only for a lost race', async () => {
    const at = packRoot('one-retry');
    const violation = Object.assign(new Error('UNIQUE constraint failed: projects.slug'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const spy = jest
      .spyOn(importer as unknown as { writePack: () => Promise<unknown> }, 'writePack')
      .mockRejectedValue(violation);

    await expect(seed.importPlatformContent(at)).rejects.toThrow(/UNIQUE constraint failed/);
    expect(spy).toHaveBeenCalledTimes(2);

    // and anything that is not a lost race is not retried at all
    spy.mockReset();
    spy.mockRejectedValue(new Error('no space left on device'));
    await expect(seed.importPlatformContent(at)).rejects.toThrow('no space left on device');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('which project a request naming none answers for', () => {
    it('does not move because a pack sorted earlier', async () => {
      const at = path.join(root, 'default-stays');
      addPack(at, 'zz-pack', 'zz-pack');
      await seed.importPlatformContent(at);
      expect(await flaggedSlugs()).toEqual(['zz-pack']);

      // The resolution's fourth step is "the project the importer flagged", and that has
      // to be a fact about the database rather than a re-reading of the
      // directory: a pack added later, or a renamed directory, must not move
      // every learner who names no project onto another project overnight.
      addPack(at, 'aa-pack', 'aa-pack');
      await seed.importPlatformContent(at);

      expect(await flaggedSlugs()).toEqual(['zz-pack']);
    });

    it("moves when an operator names one, which is step 3's own choice", async () => {
      const at = path.join(root, 'default-named');
      addPack(at, 'zz-pack', 'zz-pack');
      addPack(at, 'aa-pack', 'aa-pack');
      await seed.importPlatformContent(at);
      expect(await flaggedSlugs()).toEqual(['aa-pack']);

      await importer.importContentDirectory(at, { ...platform, defaultSlug: 'zz-pack' });

      expect(await flaggedSlugs()).toEqual(['zz-pack']);
    });

    it('is exactly one row, whatever it found', async () => {
      const at = path.join(root, 'default-one-row');
      addPack(at, 'zz-pack', 'zz-pack');
      addPack(at, 'aa-pack', 'aa-pack');
      await seed.importPlatformContent(at);

      // Nothing in the database enforces "exactly one row is true", and
      // clearing and setting the flag row by row outside a transaction would
      // let a crash between the two statements leave a deployment with no
      // default at all and the fourth step with no answer. Two flagged rows are
      // healed to one, and the write is one transaction.
      await dataSource
        .getRepository(ProjectEntity)
        .update({ isDefault: false }, { isDefault: true });
      expect(await flaggedSlugs()).toEqual(['aa-pack', 'zz-pack']);

      await seed.importPlatformContent(at);

      expect(await flaggedSlugs()).toEqual(['aa-pack']);
    });

    it('is not the directory the seed happened to read first', async () => {
      // The seed must not hand the importer `config.defaultProject`, which is
      // the operator's choice *or* the first directory holding a project.json:
      // with `DEFAULT_PROJECT` unset both arms of `ensureDefaultProject` would
      // answer "whichever directory sorted first", which is exactly the guess
      // the resolution order exists to avoid.
      const spy = jest.spyOn(importer, 'importContentDirectory').mockResolvedValue([]);

      await seed.importPlatformContent(path.join(root, 'nothing-here'));

      expect(config.namedProject).toBe('');
      expect(config.defaultProject).not.toBe('');
      expect(spy.mock.calls[0][1]?.defaultSlug).toBeUndefined();
    });
  });

  it('a draft at the same version is replaced', async () => {
    const at = packRoot('draft');
    // A teacher's unfinished edit at the version the pack declares. Drafts are
    // mutable, that is the whole difference between the two statuses, so the
    // import replaces it rather than refusing.
    const project = await dataSource
      .getRepository(ProjectEntity)
      .save({ slug: 'tasktrackr', title: 'A draft', origin: 'seed', platformOwned: true });
    const draft = await dataSource.getRepository(ProjectVersionEntity).save({
      projectId: project.id,
      version: '6.0.0',
      status: 'draft',
      manifest: { tagline: 't', description: 'd', language: 'python', languages: ['python'] },
    });
    const phase = await dataSource.getRepository(ProjectPhaseEntity).save({
      projectVersionId: draft.id,
      key: 'requirements',
      order: 1,
      title: 'A draft phase',
      intro: 'i',
      artifactKind: 'story',
      assistant: { systemPrompt: 'help', topics: [], progressive: [] },
    });
    await dataSource.getRepository(ProjectFileEntity).save({
      projectVersionId: draft.id,
      ownerKind: 'phase',
      ownerId: phase.id,
      path: 'requirements/story.json',
      role: 'workspace',
      editable: true,
      language: 'json',
      blobSha: 'f'.repeat(64),
    });

    const [result] = await seed.importPlatformContent(at);

    expect(result.outcome).toBe('draft-replaced');
    const versions = await versionsOf('tasktrackr');
    expect(versions).toHaveLength(1);
    expect(versions[0].status).toBe('published');
    expect(versions[0].id).not.toBe(draft.id);
    // the draft's phases and files went with it
    expect(
      await dataSource.getRepository(ProjectPhaseEntity).count({ where: { projectVersionId: draft.id } }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(ProjectFileEntity).count({ where: { projectVersionId: draft.id } }),
    ).toBe(0);
    expect(await dataSource.getRepository(ProjectPhaseEntity).count()).toBe(6);
  });
  it('a second pack that refuses leaves the first one unimported', async () => {
    // The rule is "never half-import". With each pack written in its own
    // transaction, a directory holding two of them would have a committed
    // first pack the moment the second refused: a deployment published at
    // one version of one project and not the other, with nothing saying so.
    const at = packRoot('half-import');
    // `zz-` so the walk, which sorts by directory name, reaches it second: the
    // question is what the first pack's rows do when a later one refuses.
    addPack(at, 'zz-ledger', 'ledger-lab');
    const meta = path.join(at, 'zz-ledger', 'project.json');
    writeMetaAt(meta, { ...JSON.parse(fs.readFileSync(meta, 'utf-8')), version: '1.0.0-rc.1' });

    await expect(seed.importPlatformContent(at)).rejects.toThrow(/MAJOR\.MINOR\.PATCH/);

    expect(await counts()).toMatchObject({
      projects: 0,
      project_versions: 0,
      project_phases: 0,
      project_files: 0,
    });
    expect(await flaggedSlugs()).toEqual([]);
    expect(seed.importedContent).toBeNull();
  });

  it('a replica whose database has not been migrated refuses the boot by name', async () => {
    // The runbook starts replicas with RUN_MIGRATIONS=false
    // (`database.module.ts`). One started before the migration has been
    // applied meets `projects.findOneBy` as the import's first statement, and
    // without a check what comes back is the driver's own "no such table":
    // no sentence, no instruction, and nothing catching it. Content is served
    // from the database, not the disk, so such a replica must refuse by name.
    const at = packRoot('unmigrated');
    await dataSource.query('DROP TABLE projects');

    const refusal = await seed
      .importPlatformContent(at)
      .then(() => null, (error: Error) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal!.message).toContain('the project tables are not there');
    expect(refusal!.message).toContain('RUN_MIGRATIONS');
    expect(refusal!.message).toContain(at);
    // and the driver's own words are kept, because that is what an operator
    // pastes into a search when the named half is not enough
    expect(refusal!.message).toMatch(/no such table|does not exist/);
    expect(seed.importedContent).toBeNull();
  });

  it("the boot skips a pack whose slug a teacher's project holds, publishes the rest, and stays up", async () => {
    // The boot path never refuses for a held slug: a throw inside `importAll`'s one
    // transaction would abort every pack and stop the boot. It asks the
    // importer to skip, and the skipped pack writes nothing.
    const at = packRoot('held-at-boot');
    addPack(at, 'zz-held', 'zz-held');
    const teacher = await dataSource.getRepository(ProjectEntity).save(
      dataSource.getRepository(ProjectEntity).create({ slug: 'zz-held', title: 'A teacher project', origin: 'upload', platformOwned: false, ownerUserId: 'teacher-1', isDefault: false }),
    );
    const spy = jest.spyOn(importer, 'importContentDirectory');

    const results = await seed.importPlatformContent(at);

    expect((spy.mock.calls[0][1] as { heldSlug?: string } | undefined)?.heldSlug).toBe('skip');
    expect(results.map((one) => [one.slug, one.outcome])).toEqual([
      ['tasktrackr', 'imported'],
      ['zz-held', 'skipped-held'],
    ]);
    expect(await dataSource.getRepository(ProjectVersionEntity).countBy({ projectId: teacher.id })).toBe(0);
    expect(logged).toContain('"zz-held": skipped; a teacher\'s project holds this slug, so the platform pack was not imported');
    expect(await flaggedSlugs()).toEqual(['tasktrackr']);
    expect(seed.importedContent).toEqual(results);
  });
});

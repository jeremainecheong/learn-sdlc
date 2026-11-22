import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, In, type EntityManager } from 'typeorm';
import { DRAFT_FIRST_VERSION, INHERITED_TASK_KEY, isProjectSlug } from '@learnsdlc/shared';
import { config } from '../config';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../db/entities';
import { ContentService } from './content.service';
import { RESERVED_FILE_PREFIXES, compilePack } from './pack-compiler';
import { DirectoryPackSource } from './pack-source';
import { layoutFromManifest } from './legacy-layout';
import { LAYOUT_SENTENCES, LayoutRefusal } from './folder-layout';
import { folderPack, writeConverted, type PackFiles } from '../../test/fixtures/folder-packs';
import { ProjectImporterService, SEALED_ROW_DIRECTORY, mintTeacherSlug } from './importer.service';
// The task block's reader
import { BadRequestException, Logger } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UPLOAD_REFUSALS, UPLOAD_REFUSAL_DETAIL_MAX } from '@learnsdlc/shared';
import { UpdateTaskDto } from '../authoring/authoring.dto';
import type { CompiledTask } from './pack-compiler';
import * as reportModule from './import-report';
import * as taskBlocksModule from './task-blocks';
const { PHASE_TASK_BLOCK_KEYS, checkedTaskBlock, soleTaskForBlock, taskBlockRefusal } = taskBlocksModule as unknown as {
  PHASE_TASK_BLOCK_KEYS: readonly string[];
  checkedTaskBlock: (where: string, raw: unknown, layout: 'older' | 'folder') => unknown;
  soleTaskForBlock: (where: string, tasks: CompiledTask[], block: Record<string, unknown>) => CompiledTask;
  taskBlockRefusal: (where: string, reason: string) => BadRequestException;
};
// The editor's overlay and compile, spied and compared
import * as draftModule from '../authoring/draft';
import { blobShaFor, canonicalJson, sha256Hex } from './blob.store';
import type { InterviewBrief } from './content.types';
import type { OlderWrittenChecks } from './older-written';
import { copyTaskTrackr, openForkWorld, type Fork, type ForkWorld } from '../../test/tasktrackr-phase';
import { hostPack } from '../../test/written-phase-pack';
import { memoryDataSource } from '../../test/support/memory-db';
import { uploadPack } from '../../test/fixtures/paths';

/**
 * The importer: a pack's bytes become rows, once.
 *
 * It reads a pack through the same `loadProject` the directory walk uses, so
 * every validation a pack is held to runs against the import,
 * which is the property that makes the compiled snapshot worth trusting, and
 * then writes the bytes deduplicated by sha, the rows that say what each byte
 * is, and the compiled snapshot the runtime reads.
 *
 * The two questions here are the two that decide whether the import is safe
 * to run at every boot: is a second import of the same bytes a no-op, and is one
 * copy of a shared byte enough.
 */
describe('the importer', () => {
  let dataSource: DataSource;
  let importer: ProjectImporterService;
  let content: ContentService;
  let dir = '';

  const shippedPack = (): DirectoryPackSource =>
    new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr'));

  /** Row counts across every table the import writes, keyed so a failure names one. */
  const counts = async (): Promise<Record<string, number>> => ({
    content_blobs: await dataSource.getRepository(ContentBlobEntity).count(),
    projects: await dataSource.getRepository(ProjectEntity).count(),
    project_versions: await dataSource.getRepository(ProjectVersionEntity).count(),
    project_phases: await dataSource.getRepository(ProjectPhaseEntity).count(),
    project_tasks: await dataSource.getRepository(ProjectTaskEntity).count(),
    project_files: await dataSource.getRepository(ProjectFileEntity).count(),
  });

  /** The shipped pack in a directory of its own, so a test may edit it. */
  const copyOfThePack = (name: string): DirectoryPackSource => {
    const at = path.join(dir, name, 'tasktrackr');
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.cpSync(path.join(config.contentDir, 'tasktrackr'), at, { recursive: true });
    return new DirectoryPackSource(at);
  };

  const rewriteVersion = (source: DirectoryPackSource, version: string): void => {
    const at = path.join(source.location, 'project.json');
    const meta = JSON.parse(fs.readFileSync(at, 'utf-8'));
    fs.writeFileSync(at, JSON.stringify({ ...meta, version }, null, 2), 'utf-8');
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-import-'));
    dataSource = await memoryDataSource();
    content = new ContentService();
    importer = new ProjectImporterService(content, dataSource);
    await importer.importPack(shippedPack(), { origin: 'seed', platformOwned: true });
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('importing the same version twice writes nothing new', async () => {
    const before = await counts();
    const again = await importer.importPack(shippedPack(), {
      origin: 'seed',
      platformOwned: true,
    });

    expect(again.outcome).toBe('unchanged');
    expect(await counts()).toEqual(before);
    // and the version row is the same row, not a replacement
    const versions = await dataSource.getRepository(ProjectVersionEntity).find();
    expect(versions).toHaveLength(1);
    expect(versions[0].id).toBe(again.projectVersionId);
    expect(versions[0].status).toBe('published');
  });

  it('blobs dedupe by sha', async () => {
    const rows = await counts();
    // 165 rows over 89 blobs, measured: the canonical implementation is mounted
    // by three phases and is a solution or a reference in two more.
    expect(rows.content_blobs).toBeLessThan(rows.project_files);

    // The five shas that are both a locked `workspace` row and a sealed
    // `solution` file: one blob each, reached by rows under two roles.
    for (const sha of [
      'b1ec2b8726f65cfe2dfeb91567768b42377ccca4cafa83c82bb0b0f70e093f6b',
      'd3215fe30f7996cde62c152dbddda76195fda4d6e69ce4cb654d9a4b46235350',
      '45737739a73d658cb5cb40e9baf182f5404c7af44400d46bb2b96fdc91e23e5a',
      '03cfbdbbde4b509fc80cda50a3507400f0303dc1de0a97fe36f3e94d64b917df',
      '54448befa1305d0fc4006c5e2591a7fb5c2f00277fe609f3cee7735e59ce219c',
    ]) {
      expect(await dataSource.getRepository(ContentBlobEntity).count({ where: { sha } })).toBe(1);
      const holders = await dataSource.getRepository(ProjectFileEntity).find({ where: { blobSha: sha } });
      expect(holders.length).toBeGreaterThanOrEqual(2);
      expect(new Set(holders.map((row) => row.role)).size).toBeGreaterThanOrEqual(2);
    }

    // every row's bytes are actually there, which is what makes the row model a
    // store rather than an index
    const files = await dataSource.getRepository(ProjectFileEntity).find();
    const blobs = new Set(
      (await dataSource.getRepository(ContentBlobEntity).find()).map((blob) => blob.sha),
    );
    expect(files.filter((file) => !blobs.has(file.blobSha))).toEqual([]);
    // and a blob's recorded size is its bytes, so a storage report needs no scan
    for (const blob of await dataSource.getRepository(ContentBlobEntity).find()) {
      expect(blob.size).toBe(Buffer.byteLength(blob.bytes, 'utf-8'));
    }
  });

  it('the compiled snapshot is written on publish and read back identically', async () => {
    const compiled = compilePack(content.loadProject(shippedPack()));
    const [version] = await dataSource.getRepository(ProjectVersionEntity).find();

    expect(version.compiled).toEqual(compiled);
    expect(version.sandboxBudget).toBe(compiled.sandboxBudget);
    expect(version.publishedAt).not.toBeNull();
    // the manifest is the pack's header, and the phases are rows of their own
    expect(version.manifest.language).toBe('python');
    expect(version.manifest.languages).toEqual(compiled.content.languages);
    const phases = await dataSource
      .getRepository(ProjectPhaseEntity)
      .find({ where: { projectVersionId: version.id }, order: { order: 'ASC' } });
    expect(phases.map((phase) => phase.key)).toEqual(compiled.content.phases.map((p) => p.key));
    // a phase's sole task is never a row, so the table ships empty
    expect(await dataSource.getRepository(ProjectTaskEntity).count()).toBe(0);
  });

  it('a version string that is not MAJOR.MINOR.PATCH is refused by sentence', async () => {
    const source = copyOfThePack('prerelease');
    // The loader accepts a `-prerelease` suffix and always has. The importer
    // does not: a version in this model is compared field by field as numbers
    // to resolve the published head, and a suffix has no place in that order.
    rewriteVersion(source, '2.0.2-rc1');

    await expect(importer.importPack(source, { origin: 'seed' })).rejects.toThrow(
      /tasktrackr\/project\.json: version \("2\.0\.2-rc1"\) must be MAJOR\.MINOR\.PATCH/,
    );
    expect(await dataSource.getRepository(ProjectVersionEntity).count()).toBe(1);
  });

  it('every prefix a sealed row is stored under is a reserved prefix', () => {
    // The two lists have to agree or the refusal below guards the wrong
    // letters: `SEALED_ROW_DIRECTORY` is where the rows go, and the compiler's
    // list is what a learner file may not be mounted at.
    for (const [, directory] of SEALED_ROW_DIRECTORY) {
      expect(RESERVED_FILE_PREFIXES).toContain(`${directory}/`);
    }
    // the two the directory table does not carry, because their paths are
    // built by hand: one row per mutant file, one interview brief per phase
    expect(RESERVED_FILE_PREFIXES).toContain('mutants/');
    expect(RESERVED_FILE_PREFIXES).toContain('interview/');
  });

  it('a learner file written under a reserved path prefix is refused', async () => {
    const [version] = await dataSource.getRepository(ProjectVersionEntity).find();
    const phase = await dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: version.id, key: 'implementation' });

    // the collision is real, not theoretical: this phase already holds its
    // answer key at exactly this shape of path, under the same owner
    const sealed = await dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: version.id, ownerId: phase.id, role: 'solution' } });
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed.every((row) => row.path.startsWith('solution/'))).toBe(true);

    const before = await counts();
    await expect(
      importer.insertFiles(dataSource.manager, version.id, [
        {
          ownerKind: 'phase',
          ownerId: phase.id,
          path: 'solution/api/repository/tasks.py',
          role: 'workspace',
          editable: true,
          language: 'python',
          bytes: '# the learner types here\n',
        },
      ]),
    ).rejects.toThrow(/is under "solution\/"/);
    // refused before anything is written, blobs included
    expect(await counts()).toEqual(before);
  });

  it('a dot-prefixed file is part of a pack\'s identity', async () => {
    // `packDigestOf` is the idempotence key, and its docstring is the rule:
    // "a file the loader never reads is still a byte of the pack, so adding one
    // needs a version bump like any other change". The walk it digested was the
    // *loading* walk, which skips every dot-prefixed entry at every level, and
    // the shipped pack carries `canonical/.gitignore` and `canonical/.env.example`,
    // neither of which the digest could see. A
    // phase may source any of them (`read()` and `exists()` skip nothing), so
    // the failure was an operator editing one, redeploying at the same version,
    // being told "unchanged", and then being told the *build* had moved,
    // because the recompiled snapshot differs from the stored one.
    const source = copyOfThePack('dotfile-identity');
    const at = path.join(source.location, 'canonical', '.env.example');
    expect(fs.existsSync(at)).toBe(true);
    fs.writeFileSync(at, `${fs.readFileSync(at, 'utf-8')}# an operator's fix\n`, 'utf-8');

    await expect(importer.importPack(source, { origin: 'seed' })).rejects.toThrow(
      /already published from different bytes/,
    );
  });

  /*
   * `writePack` finds a project by slug. A teacher's project that holds a
   * platform pack's slug (an upload, a copy) must never be published into by the
   * boot: the boot skips that pack, writes nothing for it, names it in one
   * line, and imports the rest of the directory in the same transaction.
   */
  describe("a platform pack whose slug a teacher's project holds", () => {
    const { heldSlugBootLine, describeFirstPublishPins: pinsLine } = reportModule as unknown as {
      heldSlugBootLine: (slug: string) => string;
      describeFirstPublishPins: (result: unknown) => string | null;
    };
    const platform = { origin: 'seed' as const, platformOwned: true };
    /** What the boot prints for two fresh host packs when no slug is held, as literals. */
    const EXPECTED_BOOT_LINES = [
      'imported "line-one" 1.0.0 and published it: 1 phases, 3 files, 3 new blobs, 0 microVMs for one full pass',
      'imported "line-two" 1.0.0 and published it: 1 phases, 3 files, 0 new blobs, 0 microVMs for one full pass',
      '"line-one" is the project a request naming none answers for',
    ];
    let world: DataSource;
    let boot: ProjectImporterService;
    let logged: string[] = [];

    /** A host pack on disk under `root/<folder>`, with the given slug. */
    const writeHostPack = (root: string, folder: string, slug: string): string => {
      const source = layoutFromManifest(hostPack({ slug })).source;
      for (const name of source.walkForDigest()) {
        fs.mkdirSync(path.dirname(path.join(root, folder, name)), { recursive: true });
        fs.writeFileSync(path.join(root, folder, name), source.bytesOf(name)!);
      }
      return path.join(root, folder);
    };
    const versionOf = (at: string): string => content.loadProject(new DirectoryPackSource(at)).version;

    /** A teacher's own project holding `slug`, with a draft at `version`. */
    const teacherHolds = async (slug: string, version: string): Promise<ProjectEntity> => {
      const row = await world.manager.save(
        world.manager.create(ProjectEntity, { slug, title: 'A teacher project', origin: 'upload', platformOwned: false, ownerUserId: 'teacher-1', isDefault: false }),
      );
      await world.manager.save(
        world.manager.create(ProjectVersionEntity, {
          projectId: row.id,
          version,
          status: 'draft',
          manifest: {} as never,
          compiled: { content: { phases: [] } } as never,
        }),
      );
      return row;
    };

    /** Everything stored under one project, digested, so "unchanged" is about bytes and not only counts. */
    const heldRows = async (projectId: string): Promise<{ count: number; digest: string }> => {
      const project = await world.manager.findOneByOrFail(ProjectEntity, { id: projectId });
      const versions = await world.manager.find(ProjectVersionEntity, { where: { projectId }, order: { version: 'ASC' } });
      const ids = versions.map((one) => one.id);
      const phases = ids.length ? await world.manager.find(ProjectPhaseEntity, { where: { projectVersionId: In(ids) } }) : [];
      const files = ids.length ? await world.manager.find(ProjectFileEntity, { where: { projectVersionId: In(ids) } }) : [];
      const rows = {
        project: [project.slug, project.title, project.origin, project.platformOwned, project.ownerUserId, project.isDefault],
        versions: versions.map((one) => [one.id, one.version, one.status, one.contentDigest, one.manifest, one.compiled, one.publishedAt]),
        phases: phases.map((one) => one.id).sort(),
        files: files.map((one) => one.id).sort(),
      };
      return { count: 1 + versions.length + phases.length + files.length, digest: sha256Hex(canonicalJson(rows)) };
    };
    const flagged = async (): Promise<string[]> =>
      (await world.getRepository(ProjectEntity).find({ where: { isDefault: true } })).map((row) => row.slug).sort();

    beforeEach(async () => {
      world = await memoryDataSource();
      boot = new ProjectImporterService(content, world);
      logged = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      if (world.isInitialized) await world.destroy();
    });

    it('skips at boot a platform pack whose slug a teacher\'s project holds, writes nothing for it, and names it in the boot line', async () => {
      const root = path.join(dir, 'held-boot');
      writeHostPack(root, 'a-free', 'free-pack');
      const heldAt = writeHostPack(root, 'b-held', 'held-pack');
      const teacher = await teacherHolds('held-pack', versionOf(heldAt));
      const before = await heldRows(teacher.id);

      const results = await boot.importContentDirectory(root, platform);

      const held = results.find((one) => one.slug === 'held-pack')!;
      expect(held).toEqual({
        outcome: 'skipped-held',
        slug: 'held-pack',
        version: versionOf(heldAt),
        projectId: '',
        projectVersionId: '',
        contentDigest: '',
        sandboxBudget: 0,
        blobsWritten: 0,
        fileRows: 0,
        phaseRows: 0,
        compilerDrift: null,
      });
      expect(JSON.stringify(held)).not.toContain(teacher.id);
      expect(await heldRows(teacher.id)).toEqual(before);
      const line = '"held-pack": skipped; a teacher\'s project holds this slug, so the platform pack was not imported';
      expect(logged.filter((one) => one === line)).toHaveLength(1);
      expect(heldSlugBootLine('held-pack')).toBe(line);
      expect(logged.filter((one) => one.includes('held-pack'))).toEqual([line]);
    });

    it('a boot import with a held slug still commits the other packs', async () => {
      const root = path.join(dir, 'held-commits');
      writeHostPack(root, 'a-held', 'held-first');
      writeHostPack(root, 'b-free', 'free-after');
      await teacherHolds('held-first', '0.9.0');

      const results = await boot.importContentDirectory(root, platform);

      expect(results.map((one) => [one.slug, one.outcome])).toEqual([
        ['held-first', 'skipped-held'],
        ['free-after', 'imported'],
      ]);
      const free = await world.manager.findOneByOrFail(ProjectEntity, { slug: 'free-after' });
      expect(free.platformOwned).toBe(true);
      const published = await world.manager.find(ProjectVersionEntity, { where: { projectId: free.id } });
      expect(published.map((one) => one.status)).toEqual(['published']);
      const teacher = await world.manager.findOneByOrFail(ProjectEntity, { slug: 'held-first' });
      expect((await world.manager.find(ProjectVersionEntity, { where: { projectId: teacher.id } })).map((one) => [one.version, one.status])).toEqual([['0.9.0', 'draft']]);
    });

    it('an ownerless non-platform row (its teacher deleted their account) is skipped the same way', async () => {
      const root = path.join(dir, 'held-ownerless');
      const heldAt = writeHostPack(root, 'a-held', 'held-ownerless');
      const teacher = await teacherHolds('held-ownerless', versionOf(heldAt));
      await world.manager.update(ProjectEntity, { id: teacher.id }, { ownerUserId: null });
      const before = await heldRows(teacher.id);

      const [result] = await boot.importContentDirectory(root, platform);

      expect(result.outcome).toBe('skipped-held');
      expect(await heldRows(teacher.id)).toEqual(before);
      expect(logged).toContain(heldSlugBootLine('held-ownerless'));
    });

    it('a platform row with the pack\'s slug is still imported', async () => {
      const root = path.join(dir, 'platform-row');
      const at = writeHostPack(root, 'a-own', 'own-pack');
      await world.manager.save(world.manager.create(ProjectEntity, { slug: 'own-pack', title: 'Own pack', origin: 'seed', platformOwned: true, ownerUserId: null, isDefault: false }));

      const [result] = await boot.importContentDirectory(root, platform);

      expect(result.outcome).toBe('imported');
      expect(result.version).toBe(versionOf(at));
      expect(result.projectVersionId).not.toBe('');
      expect(logged.some((one) => one.includes('skipped'))).toBe(false);
    });

    it('a held slug never becomes the default project, even when DEFAULT_PROJECT names it', async () => {
      const root = path.join(dir, 'held-default');
      writeHostPack(root, 'a-free', 'free-default');
      await boot.importContentDirectory(root, platform);
      expect(await flagged()).toEqual(['free-default']);

      const heldAt = writeHostPack(root, 'b-held', 'held-default');
      await teacherHolds('held-default', versionOf(heldAt));
      logged = [];
      const results = await boot.importContentDirectory(root, { ...platform, defaultSlug: 'held-default' });

      const held = results.find((one) => one.slug === 'held-default')!;
      expect(held.outcome).toBe('skipped-held');
      expect(await flagged()).toEqual(['free-default']);
      expect((await world.manager.findOneByOrFail(ProjectEntity, { slug: 'held-default' })).isDefault).toBe(false);
      expect(pinsLine(held)).toBeNull();
      expect(logged.some((one) => one.includes('is the project a request naming none answers for'))).toBe(false);
    });

    it('a held slug alone leaves the default where it was', async () => {
      const root = path.join(dir, 'held-alone');
      const heldAt = writeHostPack(root, 'a-held', 'held-alone');
      await teacherHolds('held-alone', versionOf(heldAt));

      const results = await boot.importContentDirectory(root, { ...platform, defaultSlug: 'held-alone' });

      expect(results.map((one) => one.outcome)).toEqual(['skipped-held']);
      expect(await flagged()).toEqual([]);
    });

    it('a boot with no held slug prints one line per pack and the default line', async () => {
      const root = path.join(dir, 'no-held');
      writeHostPack(root, 'a-one', 'line-one');
      writeHostPack(root, 'b-two', 'line-two');

      await boot.importContentDirectory(root, platform);

      // One line per pack and the default line, and no summary line.
      expect(logged).toEqual(EXPECTED_BOOT_LINES);
    });
  });
});

/* ======================================================================== *
 * The importer's doors for a copy the teacher owns. Draft only; a role     *
 * never changes; the two byte rules re-asked; and no door here reaches a   *
 * sealed row, an application's file, or a file a remaining task owns.      *
 * ======================================================================== */
describe("the importer's doors for a teacher's draft", () => {
  let world: ForkWorld;
  let fork: Fork;

  const rowsOf = async (versionId: string, phaseKey: string) => {
    const phase = await world.dataSource
      .getRepository(ProjectPhaseEntity)
      .findOneByOrFail({ projectVersionId: versionId, key: phaseKey as never });
    const rows = await world.dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: versionId, ownerKind: 'phase', ownerId: phase.id } });
    return { phase, rows, at: (at: string) => rows.find((row) => row.path === at)! };
  };
  const importerOf = () => new ProjectImporterService(world.content, world.dataSource);
  const inTransaction = <T>(fn: (manager: EntityManager) => Promise<T>) => world.dataSource.transaction(fn);
  const bytesOfSha = async (sha: string) =>
    (await world.dataSource.getRepository(ContentBlobEntity).findOneByOrFail({ sha })).bytes;

  beforeAll(async () => {
    world = await openForkWorld();
    fork = await copyTaskTrackr(world, 'bx-importer-doors');
  });
  afterAll(async () => {
    await world?.close();
  });

  describe('replaceFileBytes', () => {
    it('writes a new blob under the same row: path, role and editability unchanged', async () => {
      // Design's starting screen contract (since TaskTrackr 4.0.0 Design mounts its three records and nothing read-only)
      const { at } = await rowsOf(fork.versionId, 'design');
      const before = at('shared/contract/screens.json');
      const bytes = '{\n  "screens": []\n}\n';
      await inTransaction((manager) => importerOf().replaceFileBytes(manager, [before.id], bytes));
      const after = (await rowsOf(fork.versionId, 'design')).at('shared/contract/screens.json');
      expect({ id: after.id, path: after.path, role: after.role, editable: after.editable }).toEqual({
        id: before.id, path: before.path, role: before.role, editable: before.editable,
      });
      expect(after.blobSha).toBe(blobShaFor(bytes));
      expect(await bytesOfSha(after.blobSha)).toBe(bytes);
    });

    it('refuses every role but workspace, the interview brief and a hidden suite included', async () => {
      const implementation = await rowsOf(fork.versionId, 'implementation');
      const hidden = implementation.rows.find((row) => row.role === 'hidden')!;
      const interview = (await rowsOf(fork.versionId, 'requirements')).rows.find((row) => row.role === 'interview')!;
      for (const row of [hidden, interview]) {
        await expect(
          inTransaction((manager) => importerOf().replaceFileBytes(manager, [row.id], 'anything')),
        ).rejects.toThrow(/only a workspace file/);
        expect((await world.dataSource.getRepository(ProjectFileEntity).findOneByOrFail({ id: row.id })).blobSha).toBe(row.blobSha);
      }
    });

    it("refuses an application phase's file, whose bytes are the reference application's", async () => {
      const { rows } = await rowsOf(fork.versionId, 'implementation');
      const code = rows.find((row) => row.role === 'workspace' && row.editable)!;
      await expect(
        inTransaction((manager) => importerOf().replaceFileBytes(manager, [code.id], 'def ours(): ...\n')),
      ).rejects.toThrow(/application/);
    });

    it("refuses a hidden suite's bytes in a learner's file, and a solution's in an editable one (rule 1, rule 2)", async () => {
      const implementation = await rowsOf(fork.versionId, 'implementation');
      const hiddenBytes = await bytesOfSha(implementation.rows.find((row) => row.role === 'hidden')!.blobSha);
      const solutionBytes = await bytesOfSha(implementation.rows.find((row) => row.role === 'solution')!.blobSha);
      const { at } = await rowsOf(fork.versionId, 'design');
      // two of the files a learner reads and edits in Design (it mounts nothing read-only since 4.0.0)
      const readOnly = at('shared/contract/api.json');
      const editable = at('design/design.json');
      await expect(
        inTransaction((manager) => importerOf().replaceFileBytes(manager, [readOnly.id], hiddenBytes)),
      ).rejects.toThrow(/sealed material may not be mounted where a learner reads it/);
      await expect(
        inTransaction((manager) => importerOf().replaceFileBytes(manager, [editable.id], solutionBytes)),
      ).rejects.toThrow(/cannot be handed the finished one to edit/);
    });

    it('refuses a published version: the rows a class is pinned to never move', async () => {
      const seed = await rowsOf(world.seedVersionId, 'design');
      await expect(
        inTransaction((manager) =>
          importerOf().replaceFileBytes(manager, [seed.at('shared/contract/screens.json').id], '{"screens":[]}\n'),
        ),
      ).rejects.toThrow(/only a draft's file rows can be changed/);
    });
  });

  describe('deleteFileRows', () => {
    it('deletes a workspace row no task owns, and keeps its blob', async () => {
      const { phase } = await rowsOf(fork.versionId, 'requirements');
      await inTransaction((manager) =>
        importerOf().insertFiles(manager, fork.versionId, [
          { ownerKind: 'phase', ownerId: phase.id, path: 'requirements/notes.md', role: 'workspace', editable: false, language: 'markdown', bytes: '# Notes\n' },
        ]),
      );
      const notes = (await rowsOf(fork.versionId, 'requirements')).at('requirements/notes.md');
      expect(await inTransaction((manager) => importerOf().deleteFileRows(manager, fork.versionId, [notes.id]))).toBe(1);
      expect((await rowsOf(fork.versionId, 'requirements')).rows.some((row) => row.path === 'requirements/notes.md')).toBe(false);
      expect(await bytesOfSha(blobShaFor('# Notes\n'))).toBe('# Notes\n');
    });

    it('refuses every role but workspace: a hidden suite, a mutant, the interview brief', async () => {
      const implementation = await rowsOf(fork.versionId, 'implementation');
      const testing = await rowsOf(fork.versionId, 'testing');
      const requirements = await rowsOf(fork.versionId, 'requirements');
      for (const row of [
        implementation.rows.find((one) => one.role === 'hidden')!,
        testing.rows.find((one) => one.role === 'mutant')!,
        requirements.rows.find((one) => one.role === 'interview')!,
      ]) {
        await expect(
          inTransaction((manager) => importerOf().deleteFileRows(manager, fork.versionId, [row.id])),
        ).rejects.toThrow(/only a workspace file/);
        expect(await world.dataSource.getRepository(ProjectFileEntity).findOneBy({ id: row.id })).not.toBeNull();
      }
    });

    it("refuses an application phase's workspace file", async () => {
      const { rows } = await rowsOf(fork.versionId, 'implementation');
      const code = rows.find((row) => row.role === 'workspace')!;
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, fork.versionId, [code.id])),
      ).rejects.toThrow(/application/);
    });

    it("deletes the file a teacher's own task minted in an application phase, and only as that task leaves", async () => {
      // An older draft may hold a teacher's own written task in Maintenance, and
      // its minted file is theirs, not the application's: removing the task
      // takes the file with it. No other caller, and no other row, gets this.
      // No door adds such a task any more, so its rows are written here as an
      // older draft stored them, its checks in the retired markdown kind.
      const other = await copyTaskTrackr(world, 'bx-importer-minted');
      const before = await rowsOf(other.versionId, 'maintenance');
      const minted0 = 'docs/maintenance/postmortem.md';
      const older: OlderWrittenChecks = {
        kind: 'markdown',
        targets: [minted0],
        rules: [{ id: 'has-cause', label: 'Names a cause', criterion: 'cause', pattern: 'cause', required: true, failDetail: 'Name the cause.' }],
      };
      const tasks = world.dataSource.getRepository(ProjectTaskEntity);
      await tasks.save(tasks.create({
        projectPhaseId: before.phase.id, taskKey: 'postmortem', order: 2, required: true, signOff: false,
        artefactType: 'document', artefactPath: minted0, title: 'The postmortem', brief: 'Write the postmortem.',
        objectives: [], primaryPath: null, anchor: null,
        rubric: { passThreshold: 70, criteria: [{ key: 'cause', title: 'Names a cause', description: 'd', weight: 1 }] },
        checks: older as never,
      }));
      await inTransaction((manager) => importerOf().insertFiles(manager, other.versionId, [
        { ownerKind: 'phase', ownerId: before.phase.id, path: minted0, role: 'workspace', editable: true, language: 'markdown', bytes: '# The postmortem\n' },
      ]));
      const maintenance = await rowsOf(other.versionId, 'maintenance');
      const task = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: maintenance.phase.id, taskKey: 'postmortem' });
      const minted = maintenance.rows.find((row) => row.path === task.artefactPath)!;
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, other.versionId, [minted.id])),
      ).rejects.toThrow(/application/);
      expect(
        await inTransaction((manager) =>
          importerOf().deleteFileRows(manager, other.versionId, [minted.id], { removingTaskId: task.id }),
        ),
      ).toBe(1);
      // the application's own files stay refused even for a leaving task
      const inherited = await world.dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: maintenance.phase.id, taskKey: 'main' });
      const code = maintenance.rows.find((row) => row.role === 'workspace' && row.editable && row.path !== task.artefactPath)!;
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, other.versionId, [code.id], { removingTaskId: inherited.id })),
      ).rejects.toThrow(/application/);
    });

    it('refuses a file a remaining task owns', async () => {
      const { at } = await rowsOf(fork.versionId, 'design');
      // the design record, which the Design phase's one task owns
      const story = at('design/design.json');
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, fork.versionId, [story.id])),
      ).rejects.toThrow(/still owns it/);
      expect(await world.dataSource.getRepository(ProjectFileEntity).findOneBy({ id: story.id })).not.toBeNull();
    });

    it('refuses a published version, and a row of another version', async () => {
      const seed = await rowsOf(world.seedVersionId, 'design');
      const backlog = seed.at('shared/contract/screens.json');
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, world.seedVersionId, [backlog.id])),
      ).rejects.toThrow(/only a draft's file rows can be changed/);
      await expect(
        inTransaction((manager) => importerOf().deleteFileRows(manager, fork.versionId, [backlog.id])),
      ).rejects.toThrow(/not a file of/);
    });
  });

  describe('replaceInterviewRow', () => {
    it('keeps exactly one sealed row in step with the brief, deleting before inserting', async () => {
      const { phase } = await rowsOf(fork.versionId, 'requirements');
      const brief = { ...(phase.interview as InterviewBrief), maxTurns: 9 };
      await inTransaction((manager) => importerOf().replaceInterviewRow(manager, fork.versionId, phase.id, brief));
      const rows = (await rowsOf(fork.versionId, 'requirements')).rows.filter((row) => row.role === 'interview');
      expect(rows).toHaveLength(1);
      expect(rows[0].path).toBe('interview/brief.json');
      expect(rows[0].editable).toBe(false);
      expect(rows[0].blobSha).toBe(sha256Hex(canonicalJson(brief)));
    });

    it('removes the row with the interview', async () => {
      const { phase } = await rowsOf(fork.versionId, 'requirements');
      await inTransaction((manager) => importerOf().replaceInterviewRow(manager, fork.versionId, phase.id, null));
      expect((await rowsOf(fork.versionId, 'requirements')).rows.filter((row) => row.role === 'interview')).toEqual([]);
    });

    it('refuses a published version', async () => {
      const { phase } = await rowsOf(world.seedVersionId, 'requirements');
      await expect(
        inTransaction((manager) => importerOf().replaceInterviewRow(manager, world.seedVersionId, phase.id, null)),
      ).rejects.toThrow(/only a draft's file rows can be changed/);
    });
  });

  // The importer's own door re-points a copy.
  describe('copyFilesToVersion carries each row to its new owner (#31(5))', () => {
    it('writes each copy under the owner the caller maps it to, and leaves an unmapped owner as it was', async () => {
      const source = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
      const phases = await world.dataSource
        .getRepository(ProjectPhaseEntity)
        .find({ where: { projectVersionId: fork.versionId } });
      const held = await world.dataSource
        .getRepository(ProjectFileEntity)
        .find({ where: { projectVersionId: fork.versionId } });
      expect(held.some((row) => row.ownerKind === 'project')).toBe(true);

      // every phase moves to a new id; the project row is deliberately left
      // out of the map, so the "unmapped keeps its owner" half is asserted too
      const moves = new Map(phases.map((phase, at) => [phase.id, `00000000-0000-4000-8000-${String(at).padStart(12, '0')}`]));

      const copied = await inTransaction(async (manager) => {
        const target = await manager.save(
          manager.create(ProjectVersionEntity, {
            projectId: fork.projectId,
            version: '8.0.0',
            // not a second draft: `UQ_project_versions_draft` holds one per
            // project, and this row only has to exist for the copy to land in
            status: 'archived',
            manifest: source.manifest,
          }),
        );
        const count = await importerOf().copyFilesToVersion(manager, fork.versionId, target.id, moves);
        return { count, rows: await manager.find(ProjectFileEntity, { where: { projectVersionId: target.id } }) };
      });

      expect(copied.count).toBe(held.length);
      // one path can be held by more than one phase (a shared contract file),
      // so the rows are compared whole, as a sorted list of what each one is
      const shape = (row: ProjectFileEntity, ownerId: string) =>
        [ownerId, row.ownerKind, row.path, row.role, String(row.editable), row.language ?? '', row.blobSha].join('|');
      // metadata only: no byte, role or path moves; only the owner does
      expect(copied.rows.map((row) => shape(row, row.ownerId)).sort()).toEqual(
        held.map((row) => shape(row, moves.get(row.ownerId) ?? row.ownerId)).sort(),
      );
      // and the project-owned rows, which the map does not name, kept theirs
      expect(copied.rows.filter((row) => row.ownerKind === 'project').every((row) => row.ownerId === fork.projectId)).toBe(
        true,
      );
      expect(copied.rows.filter((row) => row.ownerKind === 'phase').every((row) => [...moves.values()].includes(row.ownerId))).toBe(true);
    });

    it("a teacher's copy and a next draft hang every phase row off their own version's phases (guard)", async () => {
      for (const versionId of [fork.versionId]) {
        const own = new Set(
          (await world.dataSource.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: versionId } })).map(
            (phase) => phase.id,
          ),
        );
        const rows = await world.dataSource
          .getRepository(ProjectFileEntity)
          .find({ where: { projectVersionId: versionId } });
        for (const row of rows) {
          if (row.ownerKind === 'phase') expect(own.has(row.ownerId)).toBe(true);
          else expect(row.ownerId).toBe(fork.projectId);
        }
      }
    });
  });
});

/* ======================================================================== *
 * The importer's draft mode for a teacher's own upload. A separate method  *
 * beside the seed's: owned by the teacher, never platform-owned, never     *
 * published, never the default; the slug is minted from the title and     *
 * never a reserved one.                                                    *
 * ======================================================================== */

/**
 * A spec-local minimal own pack: one written phase and one
 * code phase, no reference project's name, path or fact. It is authored in
 * the older (pointer) layout a teacher's older export carries, and written to
 * disk converted once (`writeConverted`), as the upload door converts such an
 * archive, since the loader reads only the folder layout.
 */
function writeMiniPack(root: string, slug = 'pantry'): string {
  const at = path.join(root, slug);
  const older: PackFiles = {};
  const put = (rel: string, body: string): void => {
    older[rel] = body;
  };
  const json = (rel: string, value: unknown): void => put(rel, JSON.stringify(value, null, 2));
  const assistant = { systemPrompt: 'You are a mentor for a small pantry counter. Never write the answer.', topics: [], progressive: [] };
  json('project.json', {
    slug,
    version: '3.4.5',
    title: 'Pantry — a store cupboard counter',
    tagline: 'Count what is on the shelf.',
    description: 'A tiny Python module that counts tins in a pantry.',
    language: 'python',
    languages: ['python'],
    phases: ['phases/01-requirements', 'phases/02-implementation'],
  });
  json('phases/01-requirements/phase.json', {
    key: 'requirements',
    order: 1,
    title: 'Requirements',
    intro: 'Write the story for counting tins.',
    artifactKind: 'markdown',
    canRun: false,
    runLabel: '',
    taskFile: 'task.md',
    objectives: ['Write one user story for counting tins'],
    files: [{ path: 'requirements/story.md', source: 'files/story.md', editable: true, language: 'markdown' }],
    rubric: { passThreshold: 70, criteria: [{ key: 'story', title: 'Story', weight: 1, description: 'The story names the pantry.' }] },
    checks: {
      kind: 'markdown',
      targets: ['requirements/story.md'],
      rules: [
        { id: 'names-pantry', label: 'The story names the pantry', criterion: 'story', pattern: 'pantry', flags: 'i', required: true, failDetail: 'Say which pantry the story is about.' },
      ],
    },
    assistant,
  });
  put('phases/01-requirements/task.md', '## Your task\n\nWrite one story about the pantry.\n');
  put('phases/01-requirements/files/story.md', '# Story\n\n');
  json('phases/02-implementation/phase.json', {
    key: 'implementation',
    order: 2,
    title: 'Implementation',
    intro: 'Count the tins.',
    artifactKind: 'code',
    canRun: true,
    runLabel: 'Run visible tests',
    taskFile: 'task.md',
    objectives: ['Implement count_tins'],
    files: [
      { path: 'pantry/__init__.py', source: 'files/pantry/__init__.py', editable: false, language: 'python' },
      { path: 'pantry/count.py', source: 'files/pantry/count.py', editable: true, language: 'python' },
      { path: 'tests/test_count.py', source: 'files/tests/test_count.py', editable: false, language: 'python' },
    ],
    rubric: {
      passThreshold: 70,
      criteria: [
        { key: 'correctness_hidden', title: 'Correctness (hidden tests)', weight: 0.5, description: 'Hidden cases pass.' },
        { key: 'visible_tests', title: 'Visible tests', weight: 0.2, description: 'Visible cases pass.' },
        { key: 'code_quality', title: 'Code quality', weight: 0.2, description: 'No TODOs left.' },
        { key: 'process', title: 'Process', weight: 0.1, description: 'You ran the tests.' },
      ],
    },
    checks: {
      kind: 'code',
      editableTargets: ['pantry/count.py'],
      solutionDir: 'solution',
      runs: [
        { id: 'api', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'Pantry tests', visibleTests: ['tests/test_count.py'], hiddenTestDir: 'hidden_tests', supportFiles: [] },
      ],
    },
    assistant,
  });
  put('phases/02-implementation/task.md', '## Your task\n\nImplement count_tins.\n');
  put('phases/02-implementation/files/pantry/__init__.py', '');
  put('phases/02-implementation/files/pantry/count.py', 'def count_tins(shelf):\n    """Return how many tins are on the shelf."""\n    raise NotImplementedError("TODO(learner)")\n');
  put('phases/02-implementation/files/tests/test_count.py', 'from pantry.count import count_tins\n\n\ndef test_empty():\n    assert count_tins([]) == 0\n');
  put('phases/02-implementation/solution/pantry/count.py', 'def count_tins(shelf):\n    """Return how many tins are on the shelf."""\n    return sum(1 for item in shelf if item == "tin")\n');
  put('phases/02-implementation/hidden_tests/test_hidden_count.py', 'import unittest\n\nfrom pantry.count import count_tins\n\n\nclass Hidden(unittest.TestCase):\n    def test_mixed(self):\n        self.assertEqual(count_tins(["tin", "jar", "tin"]), 2)\n');
  writeConverted(folderPack(older, slug), at);
  return at;
}

/** Every row one import wrote, owner ids replaced by what they own, digested. */
async function seedRowsDigest(dataSource: DataSource): Promise<string> {
  const projects = await dataSource.getRepository(ProjectEntity).find();
  const versions = await dataSource.getRepository(ProjectVersionEntity).find();
  const phases = await dataSource.getRepository(ProjectPhaseEntity).find();
  const owner = new Map<string, string>([
    ...phases.map((one) => [one.id, `phase:${one.key}`] as [string, string]),
    ...projects.map((one) => [one.id, `project:${one.slug}`] as [string, string]),
  ]);
  const rows = {
    projects: projects.map((one) => [one.slug, one.title, one.origin, one.platformOwned, one.ownerUserId, one.isDefault]),
    versions: versions.map((one) => ({
      version: one.version,
      status: one.status,
      manifest: one.manifest,
      compiled: one.compiled,
      validation: one.validation,
      contentDigest: one.contentDigest,
      sandboxBudget: one.sandboxBudget,
      forkedFromVersionId: one.forkedFromVersionId,
      publishedByUserId: one.publishedByUserId,
      notes: one.notes,
      stamped: one.publishedAt !== null,
    })),
    phases: phases
      .map((one) => [one.key, one.order, one.title, one.intro, one.artifactKind, one.canRun, one.canPreview, one.runLabel, one.assistant, one.interview])
      .sort((a, b) => (a[1] as number) - (b[1] as number)),
    tasks: await dataSource.getRepository(ProjectTaskEntity).count(),
    files: (await dataSource.getRepository(ProjectFileEntity).find())
      .map((one) => [owner.get(one.ownerId), one.ownerKind, one.path, one.role, one.editable, one.language, one.blobSha].join('|'))
      .sort(),
    blobs: (await dataSource.getRepository(ContentBlobEntity).find()).map((one) => `${one.sha}|${one.size}`).sort(),
  };
  return sha256Hex(canonicalJson(rows));
}

/**
 * The seed's rows on a fresh database, digested: the rows the importer writes
 * for the shipped pack. Two things move it and nothing else should. A new
 * release of the pack under `content/` (its version bumped) moves the pack's
 * own rows, and is re-recorded here in the same change. A change to what the
 * importer writes moves it too, and is the change this guard exists to catch.
 * The pack digest leaves out built output (`web/.test/`), so a run of the
 * pack's own tests on one machine never moves it.
 */
const SEED_ROWS_DIGEST = 'a7a3f65e8d11ee51e1f89bf871a883596ee2281b6cdf2720bb37d1a6bfd4c494';

describe("the importer's draft mode for a teacher's upload", () => {
  let world: ForkWorld;
  let dir = '';
  const TEACHER = { id: 'teacher-draft', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const importerOf = () => new ProjectImporterService(world.content, world.dataSource);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-draft-import-'));
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a draft upload is owned by the teacher, not platform-owned, not published, not default', async () => {
    const source = new DirectoryPackSource(writeMiniPack(path.join(dir, 'owned')));
    const before = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ isDefault: true });

    const made = await importerOf().importTeacherDraft(source, { ownerId: TEACHER.id, title: 'Pantry counter' });

    const project = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: made.projectId });
    expect(project.ownerUserId).toBe(TEACHER.id);
    expect(project.platformOwned).toBe(false);
    expect(project.isDefault).toBe(false);
    expect(project.origin).toBe('upload');
    expect(project.title).toBe('Pantry counter');
    expect(project.slug).toBe(made.slug);

    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.projectId).toBe(made.projectId);
    expect(version.status).toBe('draft');
    expect(version.version).toBe(DRAFT_FIRST_VERSION);
    expect(version.publishedAt).toBeNull();
    expect(version.publishedByUserId).toBeNull();
    expect(version.compiled).not.toBeNull();
    expect(version.compiled?.slug).toBe(made.slug);
    // never published, so the registry's published set is unchanged, and the
    // default never moved
    expect(await world.dataSource.getRepository(ProjectVersionEntity).count({ where: { projectId: made.projectId, status: 'published' } })).toBe(0);
    expect((await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ isDefault: true })).id).toBe(before.id);
    expect(await world.dataSource.getRepository(ProjectEntity).count({ where: { isDefault: true } })).toBe(1);

    // the fast tier ran and its report is stored the way the editor reads it
    expect(made.report.tier).toBe('fast');
    expect((version.validation as unknown as { report: unknown }).report).toEqual(made.report);

    // file rows carry their roles exactly as the seed writes them
    const files = await world.dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: made.versionId } });
    const roles = new Map(files.map((one) => [one.path, one.role]));
    expect(roles.get('pantry/count.py')).toBe('workspace');
    expect(roles.get('hidden/tests/test_hidden_count.py')).toBe('hidden');
    expect(roles.get('solution/pantry/count.py')).toBe('solution');

    // and the draft opens and validates in the teacher's editor like any other
    const draft = await world.service.readDraft(TEACHER, made.projectId, made.versionId);
    expect(draft.editable).toBe(true);
    expect(draft.phases.map((one) => one.key)).toEqual(['requirements', 'implementation']);
    const report = await world.service.validate(TEACHER, made.projectId, made.versionId);
    expect(report.blocking).toEqual([]);
    // what publish will still ask of it is said now, as a warning
    expect(report.checks.filter((one) => one.advisory === 'warning').map((one) => one.id).sort()).toEqual(
      ['deep-validation-current'],
    );
  });

  it('mintTeacherSlug never answers the reference slug, even on a deployment that holds no project yet', () => {
    expect(mintTeacherSlug('TaskTrackr', new Set())).toMatch(/^tasktrackr-\d+$/);
    expect(mintTeacherSlug('Tins & Jars', new Set())).toBe('tins-jars');
    expect(mintTeacherSlug('tins-jars', new Set(['tins-jars', 'tins-jars-2']))).toBe('tins-jars-3');
    expect(mintTeacherSlug('42 shelves', new Set())).toBe('project-42-shelves');
    expect(mintTeacherSlug('!!!', new Set())).toBe('project');
  });

  it('the slug is minted from the title and refuses tasktrackr and every existing slug', async () => {
    // the archive's own slug is never taken: the pack below calls itself
    // tasktrackr, and the title is what the slug is minted from
    const hostile = new DirectoryPackSource(writeMiniPack(path.join(dir, 'named'), 'tasktrackr'));
    const minted = await importerOf().importTeacherDraft(hostile, { ownerId: TEACHER.id, title: 'Spice Rack!' });
    expect(minted.slug).toBe('spice-rack');

    // a title that would mint the reference project's slug never takes it
    const reserved = await importerOf().importTeacherDraft(
      new DirectoryPackSource(writeMiniPack(path.join(dir, 'reserved'))),
      { ownerId: TEACHER.id, title: 'TaskTrackr' },
    );
    expect(reserved.slug).not.toBe('tasktrackr');
    expect(reserved.slug).toMatch(/^tasktrackr-\d+$/);

    // nor any existing slug, its own earlier uploads included
    const again = await importerOf().importTeacherDraft(
      new DirectoryPackSource(writeMiniPack(path.join(dir, 'again'))),
      { ownerId: TEACHER.id, title: 'Spice Rack!' },
    );
    expect(again.slug).not.toBe('spice-rack');
    expect(again.slug).toMatch(/^spice-rack-\d+$/);
    const slugs = (await world.dataSource.getRepository(ProjectEntity).find()).map((one) => one.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.filter((one) => one === 'tasktrackr')).toHaveLength(1);
    expect(isProjectSlug(again.slug)).toBe(true);
  });

  it('the seed import writes the pinned rows on a fresh database (GUARD)', async () => {
    const fresh = await memoryDataSource();
    try {
      await new ProjectImporterService(new ContentService(), fresh).importPack(
        new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')),
        { origin: 'seed', platformOwned: true },
      );
      // pinned against the seed import's rows; a draft mode that touched the
      // seed's writes moves this digest
      expect(await seedRowsDigest(fresh)).toBe(SEED_ROWS_DIGEST);
    } finally {
      await fresh.destroy();
    }
  });

  it("the Shelf pack imported through DirectoryPackSource compiles to the task list its known facts name", async () => {
    // the real `shelf` pack (apps/api/test/fixtures/upload-packs/shelf), held
    // to its known facts rather than to a second compile of itself
    const shelf = uploadPack('shelf');
    // loaded as the draft import loads it: Shelf's Deployment and Maintenance are of the older shape and convert to their records
    const scratch = compilePack(new ContentService().loadProject(new DirectoryPackSource(shelf), { convertLegacyRequirements: true, convertLegacyDesign: true, convertLegacyRunbook: true, convertLegacyChange: true }));
    const made = await importerOf().importTeacherDraft(new DirectoryPackSource(shelf), { ownerId: TEACHER.id, title: 'Books on a shelf' });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const shape = (snapshot: { phases: { key: string; tasks: { artefactType: string; owns: string[]; gradedUnits: unknown; required: boolean }[] }[] }) =>
      snapshot.phases.map((phase) => ({ key: phase.key, tasks: phase.tasks.map((task) => [task.artefactType, task.owns, task.gradedUnits, task.required]) }));
    expect(shape(version.compiled!)).toEqual(shape(scratch));
    // six phases, one task each, priced 0/0/4/6/2/4 = 16
    expect(version.compiled!.phases.map((phase) => [phase.key, phase.tasks.length])).toEqual([
      ['requirements', 1], ['design', 1], ['implementation', 1], ['testing', 1], ['deployment', 1], ['maintenance', 1],
    ]);
    expect(version.compiled!.sandboxBudget).toBe(16);
    expect(version.compiled!.content.phases.map((phase) => phase.checks.kind)).toEqual(['story', 'design', 'code', 'tests', 'config', 'code']);
    // the rows the editor addresses are one task per phase, keyed as a copy keys them
    const phaseIds = (await world.dataSource.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: made.versionId } })).map((one) => one.id);
    const tasks = await world.dataSource.getRepository(ProjectTaskEntity).find({ where: { projectPhaseId: In(phaseIds) } });
    expect(tasks.map((one) => one.taskKey)).toEqual(Array(6).fill(INHERITED_TASK_KEY));
    // and the editor's own fast tier, publish arm included: within the ceiling,
    // inside the profile, every run a closed shape: only the publish
    // condition left (the deep-validation receipt) is said, as a warning, on
    // the four executable phases
    const report = await world.service.validate(TEACHER, made.projectId, made.versionId);
    expect(report.blocking).toEqual([]);
    expect(report.checks.filter((one) => one.advisory === 'warning').map((one) => `${one.phaseKey}:${one.id}`).sort()).toEqual(
      ['deployment', 'implementation', 'maintenance', 'testing'].map((key) => `${key}:deep-validation-current`),
    );
  });

  it('an uploaded TaskTrackr 4.0.0 archive converts its Deployment and Maintenance the generic way, keeps their briefs, and publish asks for deep validation', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { olderTaskTrackrPack } = require('../../test/legacy-phase') as typeof import('../../test/legacy-phase');
    // the archive converted once, as the upload door converts an older archive before the import reads it
    const made = await importerOf().importTeacherDraft(layoutFromManifest(olderTaskTrackrPack()).source, { ownerId: TEACHER.id, title: 'An older export' });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const head = new ContentService().loadProject(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')));
    for (const key of ['deployment', 'maintenance']) {
      const stored = version.compiled!.content.phases.find((phase) => phase.key === key)!;
      // a record of its own, not the reference's current phase: the exact conversion belongs to copy, next draft and boot
      expect(stored.checks).toHaveProperty(key === 'deployment' ? 'runbook' : 'change');
      expect(stored.taskPanel).not.toBe(head.phases.find((phase) => phase.key === key)!.taskPanel);
    }
    const deployment = version.compiled!.content.phases.find((phase) => phase.key === 'deployment')!;
    expect(deployment.taskPanel).toContain('Four deployment artefacts are scaffolded');
    const report = await world.service.validate(TEACHER, made.projectId, made.versionId);
    const asked = report.checks.filter((one) => one.id === 'deep-validation-current').map((one) => one.phaseKey);
    expect(asked).toEqual(expect.arrayContaining(['deployment', 'maintenance']));
  });

  it("never reads a warm-up from the host disk: an archive's warm-up, or a folder's that leaves its pack, is refused before the loader runs", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MemoryPackSource } = require('./memory-pack-source') as typeof import('./memory-pack-source');
    const hostWarmup = path.join(config.contentDir, 'tasktrackr', 'warmup');
    const archiveOf = (root: string, warmup: string) =>
      fs.readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((one) => one.isFile())
        .map((one) => {
          const name = path.relative(root, path.join(one.parentPath, one.name)).split(path.sep).join('/');
          const raw = fs.readFileSync(path.join(root, name));
          return { name, bytes: name === 'project.json' ? Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString('utf-8')), warmup })) : raw };
        });
    const titles = ['Warm host absolute', 'Warm host climb', 'Warm folder escape'];
    const refused = async (made: Promise<unknown>) => {
      const error = await made.then(() => null, (thrown: Error) => thrown);
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/warm-up/i);
      // the refusal never prints the host path it was handed
      expect(error!.message).not.toContain(config.contentDir);
    };

    // an archive: its location is a label, never a directory, so any warm-up it declares is refused
    const mini = writeMiniPack(path.join(dir, 'warm-archive'));
    await refused(importerOf().importTeacherDraft(new MemoryPackSource(archiveOf(mini, hostWarmup), 'pantry'), { ownerId: TEACHER.id, title: titles[0] }));
    await refused(importerOf().importTeacherDraft(new MemoryPackSource(archiveOf(mini, '../../../content/tasktrackr/warmup'), 'pantry'), { ownerId: TEACHER.id, title: titles[1] }));

    // a folder whose warm-up climbs out of the pack folder
    const escaping = writeMiniPack(path.join(dir, 'warm-folder'));
    fs.writeFileSync(path.join(escaping, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(escaping, 'project.json'), 'utf-8')), warmup: path.relative(escaping, hostWarmup) }));
    await refused(importerOf().importTeacherDraft(new DirectoryPackSource(escaping), { ownerId: TEACHER.id, title: titles[2] }));

    // nothing was written for any of them
    expect(await world.dataSource.getRepository(ProjectEntity).count({ where: { title: In(titles) } })).toBe(0);

    // a folder whose warm-up sits inside it: in the folder layout a warm-up is a platform pack's warmup/
    // folder, which an upload never holds, so it is refused by name too and nothing is written
    const inside = path.join(dir, 'warm-inside');
    fs.cpSync(path.join(config.contentDir, 'tasktrackr'), inside, { recursive: true });
    const insideError = await importerOf().importTeacherDraft(new DirectoryPackSource(inside), { ownerId: TEACHER.id, title: 'Warm inside' }).then(() => null, (thrown: Error) => thrown);
    expect(insideError).toBeInstanceOf(LayoutRefusal);
    expect(insideError!.message).toBe(LAYOUT_SENTENCES.warmupUploaded);
    expect(await world.dataSource.getRepository(ProjectEntity).count({ where: { title: 'Warm inside' } })).toBe(0);
  });
});

/* ======================================================================== *
 * importTeacherDraft's optional `onWritten`                                 *
 * runs inside the draft's own transaction, just before it returns, so a     *
 * caller's write (the upload audit) commits with the draft or not at all.   *
 * ======================================================================== */

describe("importTeacherDraft's onWritten hook", () => {
  let world: ForkWorld;
  let dir = '';
  const OWNER = 'teacher-onwritten';
  const importerOf = () => new ProjectImporterService(world.content, world.dataSource);
  type Hooked = Parameters<ProjectImporterService['importTeacherDraft']>[1] & {
    onWritten?: (manager: EntityManager, ids: { projectId: string; versionId: string; slug: string }) => Promise<void>;
  };
  /** A mini pack with one byte no other pack in this world holds, so its blobs are new. */
  const uniquePack = (name: string): DirectoryPackSource => {
    const at = writeMiniPack(path.join(dir, name));
    // the story file the older pack's files/story.md mounted, where the converted pack holds it
    fs.writeFileSync(path.join(at, 'phases/01-requirements/files/requirements/story.md'), `# Story\n\n<!-- ${name} ${Date.now()} -->\n`, 'utf-8');
    return new DirectoryPackSource(at);
  };
  const counts = async () => ({
    projects: await world.dataSource.getRepository(ProjectEntity).count(),
    versions: await world.dataSource.getRepository(ProjectVersionEntity).count(),
    phases: await world.dataSource.getRepository(ProjectPhaseEntity).count(),
    tasks: await world.dataSource.getRepository(ProjectTaskEntity).count(),
    files: await world.dataSource.getRepository(ProjectFileEntity).count(),
    blobs: await world.dataSource.getRepository(ContentBlobEntity).count(),
  });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-s12-'));
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an onWritten that throws leaves no project/version/blob row', async () => {
    const before = await counts();
    const opts: Hooked = {
      ownerId: OWNER,
      title: 'Hooked pantry that throws',
      onWritten: async () => {
        throw new Error('the caller refused after the draft was written');
      },
    };
    const outcome = await importerOf().importTeacherDraft(uniquePack('throws'), opts).then(
      () => 'imported',
      (error: Error) => error.message,
    );
    expect(outcome).toBe('the caller refused after the draft was written');
    expect(await counts()).toEqual(before);
    expect(await world.dataSource.getRepository(ProjectEntity).count({ where: { title: 'Hooked pantry that throws' } })).toBe(0);
  });

  it('onWritten runs once, inside the transaction, with the ids the draft returns; its write commits with the draft', async () => {
    const seen: { projectId: string; versionId: string; slug: string; status: string | null }[] = [];
    const opts: Hooked = {
      ownerId: OWNER,
      title: 'Hooked pantry that writes',
      onWritten: async (manager, ids) => {
        // the draft's own rows are visible through the manager it is handed
        const version = await manager.findOneBy(ProjectVersionEntity, { id: ids.versionId });
        seen.push({ ...ids, status: version?.status ?? null });
        await manager.update(ProjectVersionEntity, { id: ids.versionId }, { notes: 'written by onWritten' });
      },
    };
    const made = await importerOf().importTeacherDraft(uniquePack('writes'), opts);
    expect(seen).toEqual([{ projectId: made.projectId, versionId: made.versionId, slug: made.slug, status: 'draft' }]);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.notes).toBe('written by onWritten');
  });

  it('GUARD: with no onWritten the draft is written with no extra step', async () => {
    const before = await counts();
    const made = await importerOf().importTeacherDraft(uniquePack('plain'), { ownerId: OWNER, title: 'Plain pantry' });
    const after = await counts();
    expect(after.projects).toBe(before.projects + 1);
    expect(after.versions).toBe(before.versions + 1);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.status).toBe('draft');
    expect(version.notes).toBeNull();
  });
});

/* ======================================================================== *
 * A phase.json `task` block.                                               *
 * `"task": { key?, title?, brief?, objectives? }`, named and capped as the  *
 * editor's UpdateTaskBody, on a phase whose compiled list holds exactly one *
 * non-quiz task; applied through the editor's own task-words overlay and    *
 * its own draft compile. Anything else is NOT_A_PACK with a detail.         *
 * ======================================================================== */

/** Every row a draft import wrote, ids replaced by what they own and clock fields dropped, digested. */
async function draftRowsDigest(dataSource: DataSource, versionId: string): Promise<string> {
  const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
  const project = await dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: version.projectId });
  const phases = (await dataSource.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: versionId } })).sort((a, b) => a.order - b.order);
  const keyOf = new Map(phases.map((one) => [one.id, one.key]));
  const tasks = await dataSource.getRepository(ProjectTaskEntity).find({ where: { projectPhaseId: In(phases.map((one) => one.id)) } });
  const files = await dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId } });
  const blobs = await dataSource.getRepository(ContentBlobEntity).find({ where: { sha: In([...new Set(files.map((one) => one.blobSha))]) } });
  const clockless = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value ?? null), (key, inner) => (key === 'when' || key === 'ranAt' ? undefined : inner));
  return sha256Hex(
    canonicalJson({
      project: [project.slug, project.title, project.origin, project.platformOwned, project.ownerUserId, project.isDefault],
      version: [version.version, version.status, version.manifest, version.compiled, clockless(version.validation), version.contentDigest, version.sandboxBudget, version.notes],
      phases: phases.map((one) => [one.key, one.order, one.title, one.intro, one.artifactKind, one.canRun, one.canPreview, one.runLabel, one.assistant, one.interview]),
      tasks: tasks
        .map((one) => [keyOf.get(one.projectPhaseId), one.taskKey, one.order, one.required, one.signOff, one.artefactType, one.artefactPath, one.title, one.brief, one.objectives, one.primaryPath, one.anchor, one.rubric, one.checks])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      files: files.map((one) => [one.ownerKind === 'phase' ? keyOf.get(one.ownerId) : 'project', one.ownerKind, one.path, one.role, one.editable, one.language, one.blobSha].join('|')).sort(),
      blobs: blobs.map((one) => `${one.sha}|${one.size}`).sort(),
    }),
  );
}

/**
 * The rows a draft import of the shelf fixture writes when no phase carries a
 * task block, as a pinned digest: the block reader must leave such a pack's
 * rows exactly as they are. The digest covers the stored validation report,
 * sentences and labels included, and the owning teacher's id, so it moves when
 * the shelf fixture or that id changes, or
 * when a validation check is reworded, and must then be recorded again.
 */
const SHELF_DRAFT_ROWS_DIGEST = '29ff65d7060583c01e2f5bcd95cf5ae3dc63778dea5a04858d5113606984ce6a';

describe("a phase.json task block", () => {
  let world: ForkWorld;
  let dir = '';
  const TEACHER = { id: 'teacher-blocks', role: 'INSTRUCTOR' as const, cohort: 'default' };
  const SHELF = uploadPack('shelf');
  const importerOf = () => new ProjectImporterService(world.content, world.dataSource);
  /**
   * The shelf pack in a folder of its own, with `task` blocks written into the named phases' phase.json,
   * and a phase's brief, where the folder layout keeps it (its taskPanel), from `panels`.
   */
  const shelfWith = (name: string, blocks: Record<string, unknown>, panels: Record<string, string> = {}): DirectoryPackSource => {
    const at = path.join(dir, name, 'shelf');
    fs.mkdirSync(path.dirname(at), { recursive: true });
    fs.cpSync(SHELF, at, { recursive: true });
    for (const [rel, block] of Object.entries(blocks)) {
      const file = path.join(at, rel, 'phase.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), task: block }, null, 2), 'utf-8');
    }
    for (const [rel, taskPanel] of Object.entries(panels)) {
      const file = path.join(at, rel, 'phase.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), taskPanel }, null, 2), 'utf-8');
    }
    return new DirectoryPackSource(at);
  };
  /** A block holding a brief: the folder layout refuses it by name before its text is read, since the brief is the phase's taskPanel. */
  const refusedAsBlockBrief = (name: string, thrown: unknown): void => {
    expect({ name, layout: thrown instanceof LayoutRefusal, message: (thrown as Error).message }).toEqual({
      name, layout: true, message: LAYOUT_SENTENCES.blockBrief('phases/03-implementation'),
    });
  };
  const counts = async () => ({
    projects: await world.dataSource.getRepository(ProjectEntity).count(),
    versions: await world.dataSource.getRepository(ProjectVersionEntity).count(),
    phases: await world.dataSource.getRepository(ProjectPhaseEntity).count(),
    tasks: await world.dataSource.getRepository(ProjectTaskEntity).count(),
    files: await world.dataSource.getRepository(ProjectFileEntity).count(),
    blobs: await world.dataSource.getRepository(ContentBlobEntity).count(),
  });
  const taskRowsOf = async (versionId: string) => {
    const phases = (await world.dataSource.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: versionId } })).sort((a, b) => a.order - b.order);
    const tasks = await world.dataSource.getRepository(ProjectTaskEntity).find({ where: { projectPhaseId: In(phases.map((one) => one.id)) } });
    return phases.map((phase) =>
      tasks
        .filter((one) => one.projectPhaseId === phase.id)
        .map((one) => ({ phase: phase.key, taskKey: one.taskKey, order: one.order, required: one.required, signOff: one.signOff, artefactType: one.artefactType, artefactPath: one.artefactPath, title: one.title, brief: one.brief, objectives: one.objectives, primaryPath: one.primaryPath, anchor: one.anchor, rubric: one.rubric, checks: one.checks })),
    );
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-s13-'));
    world = await openForkWorld();
  });
  afterAll(async () => {
    await world?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GUARD: a pack with no task block writes the pinned rows and report', async () => {
    // first in this world, so the minted slug is the title's own
    const made = await importerOf().importTeacherDraft(new DirectoryPackSource(SHELF), { ownerId: TEACHER.id, title: 'Guard shelf' });
    expect(made.slug).toBe('guard-shelf');
    expect(await draftRowsDigest(world.dataSource, made.versionId)).toBe(SHELF_DRAFT_ROWS_DIGEST);
    expect(sha256Hex(canonicalJson(JSON.parse(JSON.stringify(made.report), (key, inner) => (key === 'ranAt' ? undefined : inner))))).toBe(
      sha256Hex(canonicalJson(JSON.parse(JSON.stringify((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).validation), (key, inner) => (key === 'ranAt' || key === 'when' ? undefined : inner)).report)),
    );
  });

  it('GUARD: the seed import is unchanged: the rows it writes on a fresh database digest as pinned', async () => {
    const fresh = await memoryDataSource();
    try {
      await new ProjectImporterService(new ContentService(), fresh).importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), { origin: 'seed', platformOwned: true });
      expect(await seedRowsDigest(fresh)).toBe(SEED_ROWS_DIGEST);
    } finally {
      await fresh.destroy();
    }
  });

  it('a pack carrying a task block LOADS through ContentService unchanged (the loader ignores the key)', () => {
    const plain = new ContentService().loadProject(new DirectoryPackSource(SHELF));
    const blocked = new ContentService().loadProject(
      shelfWith('loads', {
        // no brief: the folder layout keeps the brief in taskPanel and refuses one in a block
        'phases/03-implementation': { key: 'main', title: 'Shelve the books', objectives: ['One'] },
        'phases/01-requirements': { title: 'Write the shelf story' },
      }),
    );
    expect(canonicalJson({ ...blocked, warmup: undefined })).toBe(canonicalJson({ ...plain, warmup: undefined }));
  });

  // The folder layout keeps a phase's brief in its taskPanel and refuses one in a block, so the brief
  // this case replaces rides in taskPanel beside the block's title and objectives; the editor's door
  // is handed the same three words.
  it("a phase.json task block renames the sole task and replaces its objectives, and taskPanel its brief, exactly as the editor's overlay would", async () => {
    const words = {
      'phases/01-requirements': { phase: 'requirements' as const, block: { title: 'Write the shelf story' } },
      'phases/03-implementation': {
        phase: 'implementation' as const,
        block: { key: 'main', title: 'Shelve the books', objectives: ['Sort by author', '  Keep the shelf stable  '] },
        brief: 'Your task\n\nShelve every book by its author.',
      },
      'phases/04-testing': { phase: 'testing' as const, block: { objectives: [] as string[] }, brief: 'Write the tests that catch a wrong shelf order.' },
    };
    const blocked = await importerOf().importTeacherDraft(
      shelfWith(
        'renamed',
        Object.fromEntries(Object.entries(words).map(([rel, one]) => [rel, one.block])),
        Object.fromEntries(Object.entries(words).flatMap(([rel, one]) => ('brief' in one ? [[rel, one.brief]] : []))),
      ),
      { ownerId: TEACHER.id, title: 'Block shelf' },
    );
    // the same draft, uploaded plain and then edited through the editor's own door
    const edited = await importerOf().importTeacherDraft(new DirectoryPackSource(SHELF), { ownerId: TEACHER.id, title: 'Edited shelf' });
    for (const one of Object.values(words)) {
      const { key: _key, ...body } = one.block as { key?: string; title?: string; objectives?: string[] };
      await world.service.updateTask(TEACHER, edited.projectId, edited.versionId, one.phase, INHERITED_TASK_KEY, 'brief' in one ? { ...body, brief: one.brief } : body);
    }

    const stored = await taskRowsOf(blocked.versionId);
    expect(stored).toEqual(await taskRowsOf(edited.versionId));
    const implementation = stored.flat().find((one) => one.phase === 'implementation')!;
    expect(implementation.title).toBe('Shelve the books');
    // stored as the editor's door stores it: plain, every word kept
    expect(implementation.brief).toBe('Your task\n\nShelve every book by its author.');
    expect(implementation.objectives).toEqual(['Sort by author', 'Keep the shelf stable']);
    expect(stored.flat().find((one) => one.phase === 'requirements')!.title).toBe('Write the shelf story');
    expect(stored.flat().find((one) => one.phase === 'testing')!.objectives).toEqual([]);

    // and the stored compile is the one the editor stores for that edit
    const compiledOf = async (versionId: string) => (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled!;
    const a = await compiledOf(blocked.versionId);
    const b = await compiledOf(edited.versionId);
    expect(canonicalJson(a.phases)).toBe(canonicalJson(b.phases));
    expect(canonicalJson(a.content.phases)).toBe(canonicalJson(b.content.phases));
    expect(a.sandboxBudget).toBe(b.sandboxBudget);
    expect(a.content.phases.find((one) => one.key === 'implementation')!.taskPanel).toBe('Your task\n\nShelve every book by its author.');
    // the editor opens it, and it validates as the plain upload does
    expect(blocked.report.blocking).toEqual([]);
    const report = await world.service.validate(TEACHER, blocked.projectId, blocked.versionId);
    expect(report.blocking).toEqual([]);
    expect(report.checks.filter((one) => one.advisory === 'warning').map((one) => `${one.phaseKey}:${one.id}`).sort()).toEqual(
      ['deployment', 'implementation', 'maintenance', 'testing'].map((key) => `${key}:deep-validation-current`),
    );
    expect(canonicalJson((await compiledOf(blocked.versionId)).phases)).toBe(canonicalJson(a.phases));
  });

  it('a malformed block is refused by NOT_A_PACK with a detail and writes no row', async () => {
    const HOSTILE = 'def test_secret():\n    assert SECRET == 42\n';
    const cases: [string, unknown, RegExp][] = [
      ['not-object', 'Shelve the books', /must be an object/],
      ['array', ['Shelve'], /must be an object/],
      ['null', null, /must be an object/],
      // the block holds signOff too; Shelf is in the folder layout, whose block never holds brief
      ['unknown-key', { title: 'Shelve', hidden: HOSTILE }, /only key, title, objectives and signOff \(its sign-off\)\./],
      ['title-type', { title: 7 }, /title must be text/],
      // a block holding brief in the folder layout is refused for holding it at all (refusedAsBlockBrief below); the
      // older layout's brief type and cap are pinned in "an older archive's task block: ..."
      ['brief-type', { brief: { source: 'task.md' } }, /brief is the phase's taskPanel/],
      ['objectives-type', { objectives: HOSTILE }, /objectives must be a list of text/],
      ['objective-type', { objectives: ['ok', 3] }, /objectives must be a list of text/],
      ['key-type', { key: 3, title: 'Shelve' }, /key must be text/],
      ['key-other', { key: 'other-task', title: 'Shelve' }, /key names no task of this phase/],
      ['title-empty', { title: '   ' }, /A title cannot be empty/],
      ['title-cap', { title: 'x'.repeat(161) }, /at most 160 characters/],
      ['brief-cap', { brief: 'x'.repeat(20001) }, /brief is the phase's taskPanel/],
      ['objective-cap', { objectives: ['x'.repeat(301)] }, /at most 300 characters/],
      ['objectives-cap', { objectives: Array.from({ length: 21 }, (_, at) => `Objective ${at}`) }, /at most 20 objectives/],
    ];
    const before = await counts();
    for (const [name, block, reason] of cases) {
      const thrown = await importerOf()
        .importTeacherDraft(shelfWith(`bad-${name}`, { 'phases/03-implementation': block }), { ownerId: TEACHER.id, title: `Bad block ${name}` })
        .then(() => null, (error: unknown) => error);
      if (block && typeof block === 'object' && 'brief' in block) {
        refusedAsBlockBrief(name, thrown);
        expect({ name, detail: reason.test((thrown as Error).message) }).toEqual({ name, detail: true });
        continue;
      }
      expect({ name, http: thrown instanceof BadRequestException }).toEqual({ name, http: true });
      const response = (thrown as BadRequestException).getResponse() as { code: string; sentence: string; detail: string; statusCode: number; findings: unknown[] };
      expect({ name, code: response.code, sentence: response.sentence, statusCode: response.statusCode, findings: response.findings }).toEqual({
        name, code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, statusCode: 400, findings: [],
      });
      expect(response.detail.startsWith("phases/03-implementation's phase.json task block: ")).toBe(true);
      expect({ name, detail: reason.test(response.detail) }).toEqual({ name, detail: true });
      expect(response.detail.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
      expect(response.detail).not.toContain('SECRET');
      expect(response.detail).not.toContain('hidden');
      expect(response.detail).not.toContain('xxxxxxxxxx');
    }
    expect(await counts()).toEqual(before);
  });

  it("an older archive's task block: its brief must be text, and at most 20000 characters, each refused in its own words", () => {
    const detailOf = (block: unknown): string => {
      try {
        checkedTaskBlock('phases/03-implementation', block, 'older');
      } catch (error) {
        return ((error as BadRequestException).getResponse() as { detail: string }).detail;
      }
      return 'accepted';
    };
    expect(detailOf({ brief: { source: 'task.md' } })).toBe("phases/03-implementation's phase.json task block: its brief must be text.");
    expect(detailOf({ brief: 7 })).toBe("phases/03-implementation's phase.json task block: its brief must be text.");
    expect(detailOf({ brief: 'x'.repeat(20001) })).toMatch(/^phases\/03-implementation's phase\.json task block: .*at most 20000 characters/);
    expect(detailOf({ brief: 'x'.repeat(20000) })).toBe('accepted');
  });

  it('a block on a phase whose compiled list does not hold exactly one non-quiz task is refused by NOT_A_PACK', () => {
    const task = (taskKey: string, checkKind: string) => ({ taskKey, checkKind }) as unknown as CompiledTask;
    const refused = (tasks: CompiledTask[]) => {
      try {
        soleTaskForBlock('phases/03-implementation', tasks, { title: 'x' });
        return null;
      } catch (error) {
        return (error as BadRequestException).getResponse() as { code: string; detail: string };
      }
    };
    for (const tasks of [[], [task('quiz', 'quiz')], [task('a-one', 'code'), task('b-two', 'code')]]) {
      const response = refused(tasks);
      expect(response?.code).toBe('NOT_A_PACK');
      expect(response?.detail).toMatch(/^phases\/03-implementation's phase\.json task block: .*exactly one task/);
    }
    // a quiz beside the sole work task is fine: the block names the work task
    expect(refused([task('quiz', 'quiz'), task('', 'code')])).toBeNull();
    expect(soleTaskForBlock('phases/03-implementation', [task('quiz', 'quiz'), task('', 'code')], { key: 'main' }).checkKind).toBe('code');
  });

  it("the block's field names and caps are the editor's own (UpdateTaskDto accepts exactly what the block accepts)", async () => {
    const probes: Record<string, unknown>[] = [
      { title: 'x'.repeat(160) }, { title: 'x'.repeat(161) }, { title: '' }, { title: 5 },
      { brief: 'x'.repeat(20000) }, { brief: 'x'.repeat(20001) }, { brief: '' },
      { objectives: Array(20).fill('o') }, { objectives: Array(21).fill('o') }, { objectives: ['x'.repeat(300)] }, { objectives: ['x'.repeat(301)] }, { objectives: [] },
      // the sign-off mark, a boolean on both walls
      { signOff: true }, { signOff: false }, { signOff: 'yes' }, { signOff: 1 },
    ];
    const dtoAccepts = async (body: Record<string, unknown>) => (await validate(plainToInstance(UpdateTaskDto, body))).length === 0;
    for (const body of probes) {
      let blockAccepts = true;
      try {
        checkedTaskBlock('phases/03-implementation', body, 'older');
      } catch {
        blockAccepts = false;
      }
      expect({ body: Object.keys(body)[0], size: JSON.stringify(body).length, same: blockAccepts === (await dtoAccepts(body)) }).toEqual({ body: Object.keys(body)[0], size: JSON.stringify(body).length, same: true });
    }
    // 'signOff' comes last; the earlier keys keep their order
    expect([...PHASE_TASK_BLOCK_KEYS]).toEqual(['key', 'title', 'brief', 'objectives', 'signOff']);
  });

  /* ---- character counting and the detail's shape ---- */

  it("CLOSER: the caps count characters as the editor does (a surrogate pair is one), beyond ASCII too", async () => {
    // the editor: UpdateTaskDto (class-validator counts a pair as one character), then requireText (trimmed, UTF-16)
    const editorAccepts = async (body: Record<string, unknown>): Promise<boolean> => {
      if ((await validate(plainToInstance(UpdateTaskDto, body))).length) return false;
      try {
        draftModule.taskWordsPatch(body as never);
        return true;
      } catch {
        return false;
      }
    };
    const pair = '\u{1F4DA}';
    const probes: Record<string, unknown>[] = [
      { title: `${pair.repeat(80)} ` }, { title: pair.repeat(80) }, { title: pair.repeat(81) }, { title: `${'x'.repeat(159)}${pair}` },
      { brief: `${pair.repeat(10000)}  ` }, { brief: `${pair.repeat(10000)}x` },
      { objectives: [`${pair.repeat(150)} `] }, { objectives: [pair.repeat(151)] }, { objectives: [`é${'x'.repeat(299)}`] },
    ];
    for (const body of probes) {
      let blockAccepts = true;
      try {
        checkedTaskBlock('phases/03-implementation', body, 'older');
      } catch {
        blockAccepts = false;
      }
      const label = `${Object.keys(body)[0]}:${JSON.stringify(body).length}`;
      expect({ label, block: blockAccepts }).toEqual({ label, block: await editorAccepts(body) });
    }
  });

  it("CLOSER: a refusal's detail is wire-shaped: printable characters only, one trailing full stop, at most the cap", () => {
    const detailOf = (where: string, reason: string): string =>
      ((taskBlockRefusal(where, reason).getResponse() as { detail: string }).detail);
    expect(detailOf('phases/03-‮implementation', 'its key must be text')).toBe("phases/03-implementation's phase.json task block: its key must be text.");
    expect(detailOf('phases/03-implementation', 'A title cannot be empty.')).toBe("phases/03-implementation's phase.json task block: A title cannot be empty.");
    expect(detailOf('phases/03-impl\u0007', 'x')).toBe("phases/03-impl's phase.json task block: x.");
    const long = detailOf('phases/03-implementation', 'y'.repeat(600));
    expect(long.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
    expect(long.endsWith('y.')).toBe(true);
    // every reason the reader gives ends in exactly one full stop
    for (const block of [{ title: 7 }, { title: ' ' }, { objectives: 'x' }, { key: 3 }, { other: 1 }, 'x']) {
      let detail = '';
      try {
        checkedTaskBlock('phases/03-implementation', block, 'older');
      } catch (error) {
        detail = ((error as BadRequestException).getResponse() as { detail: string }).detail;
      }
      expect({ block, stop: /[^.]\.$/.test(detail) }).toEqual({ block, stop: true });
    }
  });

  /* ---- the block's text is text a row can store, from any PackSource ---- */

  /** The shelf pack as archive entries (MemoryPackSource's input), with `task` blocks written into the named phases' phase.json. */
  const shelfEntriesWith = (blocks: Record<string, unknown>) =>
    fs.readdirSync(SHELF, { recursive: true, withFileTypes: true })
      .filter((one) => one.isFile())
      .map((one) => {
        const name = path.relative(SHELF, path.join(one.parentPath, one.name)).split(path.sep).join('/');
        const raw = fs.readFileSync(path.join(SHELF, name));
        const rel = name.endsWith('/phase.json') ? name.slice(0, -'/phase.json'.length) : null;
        // JSON.stringify writes U+0000 and a lone surrogate as \u escapes, which is how a pack would spell them
        return { name, bytes: rel && rel in blocks ? Buffer.from(JSON.stringify({ ...JSON.parse(raw.toString('utf-8')), task: blocks[rel] }, null, 2)) : raw };
      });

  it('a title, brief or objective holding a NUL or half of a surrogate pair is refused by NOT_A_PACK naming the folder, the member and the reason, before any row is written', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MemoryPackSource } = require('./memory-pack-source') as typeof import('./memory-pack-source');
    const MARK = 'BLOCK-MARKER';
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['nul-title', { title: `Shelve ${MARK}\u0000 the books` }, /its title holds a null character/],
      ['surrogate-brief', { brief: `Shelve ${MARK} every book \uD83D by its author.` }, /its brief holds half of a surrogate pair/],
      ['nul-objective', { objectives: ['Sort by author', `Keep ${MARK}\u0000 stable`] }, /its objectives hold a null character/],
    ];
    const before = await counts();
    for (const [name, block, reason] of cases) {
      const thrown = await importerOf()
        .importTeacherDraft(new MemoryPackSource(shelfEntriesWith({ 'phases/03-implementation': block }), 'shelf'), { ownerId: TEACHER.id, title: `Block ${name}` })
        .then(() => null, (error: unknown) => error);
      if ('brief' in block) {
        refusedAsBlockBrief(name, thrown);
        expect((thrown as Error).message).not.toContain(MARK);
        continue;
      }
      expect({ name, http: thrown instanceof BadRequestException }).toEqual({ name, http: true });
      const response = (thrown as BadRequestException).getResponse() as { code: string; sentence: string; detail: string; statusCode: number };
      expect({ name, code: response.code, sentence: response.sentence, statusCode: response.statusCode }).toEqual({
        name, code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK, statusCode: 400,
      });
      expect({ name, where: response.detail.startsWith("phases/03-implementation's phase.json task block: "), reason: reason.test(response.detail) }).toEqual({ name, where: true, reason: true });
      expect(response.detail.length).toBeLessThanOrEqual(400);
      expect(response.detail).not.toContain(MARK);
    }
    expect(await counts()).toEqual(before);
  });

  it('ordinary text (a tab, a newline, U+FFFD, an emoji pair) in a block imports as the editor would store it', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MemoryPackSource } = require('./memory-pack-source') as typeof import('./memory-pack-source');
    // a block's words are its title and objectives: the folder layout keeps the brief in taskPanel and refuses one here
    const block = { title: 'Shelve\tthe books \u{1F4DA}\nLine two �', objectives: ['Sort \u{1F4DA} by author', 'Keep\tit stable'] };
    const made = await importerOf().importTeacherDraft(new MemoryPackSource(shelfEntriesWith({ 'phases/03-implementation': block }), 'shelf'), {
      ownerId: TEACHER.id,
      title: 'Block ordinary text',
    });
    const implementation = (await taskRowsOf(made.versionId)).flat().find((one) => one.phase === 'implementation')!;
    const { patch } = draftModule.taskWordsPatch(block as never) as { patch: { title?: string; brief?: string; objectives?: string[] } };
    expect({ title: implementation.title, objectives: implementation.objectives }).toEqual({
      title: patch.title,
      objectives: patch.objectives,
    });
    expect(made.report.blocking).toEqual([]);
  });

  /* ---- the block carries the sign-off mark ---- */

  it("a block {signOff:true} gives the draft's sole task signOff true, exactly as the editor's mark would", async () => {
    const blocked = await importerOf().importTeacherDraft(shelfWith('signoff', { 'phases/01-requirements': { signOff: true } }), {
      ownerId: TEACHER.id,
      title: 'Signed shelf',
    });
    const edited = await importerOf().importTeacherDraft(new DirectoryPackSource(SHELF), { ownerId: TEACHER.id, title: 'Signed by the editor' });
    await world.service.updateTask(TEACHER, edited.projectId, edited.versionId, 'requirements', INHERITED_TASK_KEY, { signOff: true } as never);
    const stored = await taskRowsOf(blocked.versionId);
    expect(stored.flat().map((one) => [one.phase, one.signOff])).toEqual([
      ['requirements', true], ['design', false], ['implementation', false], ['testing', false], ['deployment', false], ['maintenance', false],
    ]);
    expect(stored).toEqual(await taskRowsOf(edited.versionId));
    const compiledOf = async (versionId: string) => (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).compiled!;
    const a = await compiledOf(blocked.versionId);
    expect(a.phases.find((one) => one.key === 'requirements')!.tasks.map((one) => one.signOff)).toEqual([true]);
    expect(canonicalJson(a.phases)).toBe(canonicalJson((await compiledOf(edited.versionId)).phases));
    expect(canonicalJson(a.content.phases)).toBe(canonicalJson((await compiledOf(edited.versionId)).content.phases));
    expect(blocked.report.blocking).toEqual([]);
  });

  it("a block {signOff:'yes'} is NOT_A_PACK, the detail naming the folder and the member and never the value, and writes no row", async () => {
    const before = await counts();
    for (const [name, value] of [['yes', 'yes'], ['one', 1], ['null', null], ['list', [true]]] as [string, unknown][]) {
      const thrown = await importerOf()
        .importTeacherDraft(shelfWith(`bad-signoff-${name}`, { 'phases/01-requirements': { signOff: value } }), { ownerId: TEACHER.id, title: `Bad signOff ${name}` })
        .then(() => null, (error: unknown) => error);
      expect({ name, http: thrown instanceof BadRequestException }).toEqual({ name, http: true });
      const response = (thrown as BadRequestException).getResponse() as { code: string; sentence: string; detail: string };
      expect({ name, code: response.code, sentence: response.sentence }).toEqual({ name, code: 'NOT_A_PACK', sentence: UPLOAD_REFUSALS.NOT_A_PACK });
      expect(response.detail).toBe("phases/01-requirements's phase.json task block: its signOff must be true or false.");
    }
    expect(await counts()).toEqual(before);
  });

  it('the unknown-member sentence names sign-off among the members a block holds', () => {
    let detail = '';
    try {
      checkedTaskBlock('phases/01-requirements', { title: 'Shelve', hidden: 'x' }, 'older');
    } catch (error) {
      detail = ((error as BadRequestException).getResponse() as { detail: string }).detail;
    }
    expect(detail).toBe("phases/01-requirements's phase.json task block: it holds a member the editor does not have; a task block holds only key, title, brief, objectives and signOff (its sign-off).");
  });

  it("a new-layout block's unknown-member sentence names the members it may hold, which are not brief", () => {
    const detailOf = (raw: unknown): string => {
      try {
        checkedTaskBlock('phases/01-requirements', raw, 'folder');
      } catch (error) {
        return ((error as BadRequestException).getResponse() as { detail: string }).detail;
      }
      return '';
    };
    expect(detailOf({ title: 'Shelve', hidden: 'x' })).toBe(
      "phases/01-requirements's phase.json task block: it holds a member the editor does not have; a task block holds only key, title, objectives and signOff (its sign-off).",
    );
    expect(detailOf('Shelve')).toBe("phases/01-requirements's phase.json task block: it must be an object holding key, title, objectives or signOff.");
  });

  it("refuses brief in a new-layout block naming the member, and keeps it in an older archive's block, which the conversion moves into taskPanel", () => {
    let detail = '';
    try {
      checkedTaskBlock('phases/03-implementation', { key: 'main', brief: 'Do the work.', hidden: 'x' }, 'folder');
    } catch (error) {
      detail = ((error as BadRequestException).getResponse() as { detail: string }).detail;
    }
    expect(detail).toBe("phases/03-implementation's phase.json task block: the brief is the phase's taskPanel now; move it there.");
    expect(checkedTaskBlock('implementation', { key: 'main', brief: 'Do the work.' }, 'older')).toEqual({ key: 'main', brief: 'Do the work.' });
  });

  it("CLOSER: a draft that does not compile after the blocks' words names the phase whose block carries words, not the first block's", async () => {
    const spy = jest.spyOn(draftModule, 'compileDraft').mockReturnValue({ snapshot: null, error: 'refused', content: {} as never });
    try {
      const before = await counts();
      const thrown = await importerOf()
        .importTeacherDraft(
          shelfWith('nocompile', { 'phases/01-requirements': { key: 'main' }, 'phases/03-implementation': { title: 'Shelve the books' } }),
          { ownerId: TEACHER.id, title: 'No compile block' },
        )
        .then(() => null, (error: unknown) => error);
      expect(thrown).toBeInstanceOf(BadRequestException);
      const detail = ((thrown as BadRequestException).getResponse() as { detail: string }).detail;
      expect(detail).toMatch(/^phases\/03-implementation's phase\.json task block: /);
      expect(detail).not.toContain('01-requirements');
      expect(await counts()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
});

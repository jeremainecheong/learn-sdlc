import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { ALL_ENTITIES, EnrollmentEntity, SettingEntity } from '../db/entities';
import { NULL_PIN_RECEIPT_KEY } from '../seed/null-pin';
import { hostPack } from '../../test/written-phase-pack';
import { importPacks, parse } from './import-pack';
import { layoutFromManifest } from '../content/legacy-layout';

/**
 * The CLI importer runs the null-pin pass first, as the boot does: a stored
 * null pin is pinned to the version it read before this
 * command's import can publish another. Over a scratch SQLite file, through
 * `config.dbPath`, as the doc on `importPacks` intends.
 */
describe('import-pack (the CLI importer)', () => {
  let dir = '';
  let previous: { databaseUrl: string; dbPath: string };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-import-pack-'));
    previous = { databaseUrl: config.databaseUrl, dbPath: config.dbPath };
  });

  afterEach(() => {
    Object.assign(config, previous);
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the null-pin pass before its import, and prints the first-publish pin beside the pack\'s line', async () => {
    const shipped = path.join(config.contentDir, 'tasktrackr');
    const [major] = new ContentService().loadProject(new DirectoryPackSource(shipped)).version.split('.').map(Number);
    const file = path.join(dir, 'store.sqlite');
    const seeded = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES, synchronize: true }).initialize();
    const project = await seeded.manager.save(seeded.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const stored = await seeded.manager.save(
      seeded.manager.create(ProjectVersionEntity, {
        projectId: project.id,
        version: `${major - 1}.0.0`,
        status: 'published',
        manifest: {} as never,
        compiled: { content: { phases: [{ key: 'requirements', checks: { kind: 'markdown' } }] } } as never,
        publishedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const reading = await seeded.manager.save(seeded.manager.create(EnrollmentEntity, { userId: 'learner-reading', projectSlug: 'tasktrackr', projectVersionId: null }));
    const waiting = await seeded.manager.save(seeded.manager.create(EnrollmentEntity, { userId: 'learner-waiting', projectSlug: 'cli-host', projectVersionId: null }));
    await seeded.destroy();

    // a pack with no stored version: its waiting row is left by the pass and pinned by the import
    // the host is an older pack; the disk holds it in the folder layout, as it holds every platform pack
    const host = layoutFromManifest(hostPack({ slug: 'cli-host' })).source;
    for (const name of host.walkForDigest()) {
      fs.mkdirSync(path.dirname(path.join(dir, 'cli-host', name)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'cli-host', name), host.bytesOf(name)!);
    }

    Object.assign(config, { databaseUrl: '', dbPath: file });
    const order: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      order.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    const options = parse(['--pack', shipped, '--pack', path.join(dir, 'cli-host')]);
    if (!options || options === 'help') throw new Error('the two --pack options should parse');
    const code = await importPacks(options, { log: (message) => order.push(message), error: (message) => errors.push(message) });
    expect(errors).toEqual([]);
    expect(code).toBe(0);

    const pass = order.findIndex((line) => line.startsWith('null pin: pinned 1 enrolment(s) in 1 project(s)'));
    const tasktrackrLine = order.findIndex((line) => line.startsWith('imported "tasktrackr"'));
    const hostLine = order.findIndex((line) => line.startsWith('imported "cli-host"'));
    expect(pass).toBeGreaterThan(-1);
    expect(pass).toBeLessThan(tasktrackrLine);
    expect(order[hostLine + 1]).toBe("null pin: pinned 1 enrolment(s) waiting on this project's first version");

    const after = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES }).initialize();
    try {
      // pinned to the version it read before this import published the shipped one
      expect((await after.manager.findOneByOrFail(EnrollmentEntity, { id: reading.id })).projectVersionId).toBe(stored.id);
      const hostProject = await after.manager.findOneByOrFail(ProjectEntity, { slug: 'cli-host' });
      const hostVersion = await after.manager.findOneByOrFail(ProjectVersionEntity, { projectId: hostProject.id });
      expect((await after.manager.findOneByOrFail(EnrollmentEntity, { id: waiting.id })).projectVersionId).toBe(hostVersion.id);
      const receipt = JSON.parse((await after.manager.findOneByOrFail(SettingEntity, { key: NULL_PIN_RECEIPT_KEY })).value);
      expect(receipt).toMatchObject({ pinnedFromNull: 1, pinnedProjects: 1, unpinnedNoHead: 1, unpinnedProjects: 1 });
    } finally {
      await after.destroy();
    }
  });

  /*
   * The command's arm of the held-slug rule: a platform pack whose slug a teacher's project
   * holds is refused by name with a non-zero exit, from both arms. Only the
   * pack rows are asserted: the null-pin pass runs before either arm and is
   * the command's existing behaviour, unchanged.
   */
  const HELD_REFUSAL = (slug: string): string =>
    `"${slug}": a teacher's project holds this slug, so the platform pack was not imported. Give the pack another slug and import it again.`;

  /** A host pack on disk under `root/<folder>`, with the given slug. */
  const writeHostPack = (root: string, folder: string, slug: string): string => {
    const source = layoutFromManifest(hostPack({ slug })).source;
    for (const name of source.walkForDigest()) {
      fs.mkdirSync(path.dirname(path.join(root, folder, name)), { recursive: true });
      fs.writeFileSync(path.join(root, folder, name), source.bytesOf(name)!);
    }
    return path.join(root, folder);
  };

  /** A scratch store where a teacher's own project holds `slug`, with a draft at `version`. */
  const storeWithTeacherHolding = async (file: string, slug: string, version: string): Promise<void> => {
    const seeded = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES, synchronize: true }).initialize();
    const project = await seeded.manager.save(
      seeded.manager.create(ProjectEntity, { slug, title: 'A teacher project', origin: 'upload', platformOwned: false, ownerUserId: 'teacher-1', isDefault: false }),
    );
    await seeded.manager.save(
      seeded.manager.create(ProjectVersionEntity, { projectId: project.id, version, status: 'draft', manifest: {} as never, compiled: { content: { phases: [] } } as never }),
    );
    await seeded.destroy();
  };

  /** The pack rows the store holds: each project with its owner and its versions. */
  const packRows = async (file: string): Promise<unknown[]> => {
    const after = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES }).initialize();
    try {
      const projects = await after.manager.find(ProjectEntity, { order: { slug: 'ASC' } });
      const out: unknown[] = [];
      for (const project of projects) {
        const versions = await after.manager.find(ProjectVersionEntity, { where: { projectId: project.id } });
        out.push([project.slug, project.platformOwned, project.ownerUserId, versions.map((one) => [one.version, one.status]).sort()]);
      }
      return out;
    } finally {
      await after.destroy();
    }
  };

  it("refuses a pack whose slug a teacher's project holds, prints the refusal and exits non-zero", async () => {
    const at = writeHostPack(dir, 'cli-held', 'cli-held');
    const version = new ContentService().loadProject(new DirectoryPackSource(at)).version;
    const file = path.join(dir, 'store.sqlite');
    await storeWithTeacherHolding(file, 'cli-held', version);
    const before = await packRows(file);

    Object.assign(config, { databaseUrl: '', dbPath: file });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const printed: string[] = [];
    const errors: string[] = [];
    const options = parse(['--pack', at]);
    if (!options || options === 'help') throw new Error('the --pack option should parse');
    const code = await importPacks(options, { log: (message) => printed.push(message), error: (message) => errors.push(message) });

    expect(code).not.toBe(0);
    expect(errors).toEqual([HELD_REFUSAL('cli-held')]);
    expect(printed.some((line) => line.includes('cli-held'))).toBe(false);
    expect(await packRows(file)).toEqual(before);
    expect(before).toEqual([['cli-held', false, 'teacher-1', [[version, 'draft']]]]);
  });

  it('refuses a pack whose slug an ownerless non-platform project holds, too', async () => {
    const at = writeHostPack(dir, 'cli-ownerless', 'cli-ownerless');
    const version = new ContentService().loadProject(new DirectoryPackSource(at)).version;
    const file = path.join(dir, 'store.sqlite');
    await storeWithTeacherHolding(file, 'cli-ownerless', version);
    const orphan = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES }).initialize();
    await orphan.manager.update(ProjectEntity, { slug: 'cli-ownerless' }, { ownerUserId: null });
    await orphan.destroy();
    const before = await packRows(file);

    Object.assign(config, { databaseUrl: '', dbPath: file });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    const options = parse(['--pack', at]);
    if (!options || options === 'help') throw new Error('the --pack option should parse');
    const code = await importPacks(options, { log: () => undefined, error: (message) => errors.push(message) });

    expect(code).toBe(1);
    expect(errors).toEqual([HELD_REFUSAL('cli-ownerless')]);
    expect(await packRows(file)).toEqual(before);
    expect(before).toEqual([['cli-ownerless', false, null, [[version, 'draft']]]]);
  });

  it('refuses with --all too, imports nothing from the directory and exits non-zero', async () => {
    const packs = path.join(dir, 'content');
    writeHostPack(packs, 'a-free', 'cli-free');
    const heldAt = writeHostPack(packs, 'b-held', 'cli-held-all');
    const version = new ContentService().loadProject(new DirectoryPackSource(heldAt)).version;
    const file = path.join(dir, 'store.sqlite');
    await storeWithTeacherHolding(file, 'cli-held-all', version);
    const before = await packRows(file);

    const contentDir = config.contentDir;
    Object.assign(config, { databaseUrl: '', dbPath: file, contentDir: packs });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    let code: number;
    try {
      const options = parse(['--all']);
      if (!options || options === 'help') throw new Error('the --all option should parse');
      code = await importPacks(options, { log: () => undefined, error: (message) => errors.push(message) });
    } finally {
      Object.assign(config, { contentDir });
    }

    expect(code).toBe(1);
    expect(errors).toEqual([HELD_REFUSAL('cli-held-all')]);
    // neither pack written: the refusal aborted the directory's one transaction,
    // so the free pack that sorted first is not there either
    expect(await packRows(file)).toEqual(before);
  });
});

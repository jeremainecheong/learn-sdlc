import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { config } from '../config';
import {
  AuditEventEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ReleaseRecordEntity,
  SettingEntity,
  UserEntity,
} from '../db/entities';
import { AuthoringService } from '../authoring/authoring.service';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { describeFirstPublishPins, describeImport } from '../content/import-report';
import { MemoryPackSource } from '../content/memory-pack-source';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
import { WorkflowService } from '../workflow/workflow.service';
import { HOST_PHASE, HOST_SLUG, copyHost, hostPack } from '../../test/written-phase-pack';
import { NULL_PIN_RECEIPT_KEY, headsAsStored, nullPinLine, pinNullRows } from './null-pin';
import { pinNullRowsAtFirstPublish } from '../content/version-pins';
import { NullPinService } from './null-pin.service';
import { RECEIPT_RUNS } from './receipts';
import { StoryRepinService } from './story-repin.service';
import { layoutFromManifest } from '../content/legacy-layout';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The null-pin pass and the two first-publish pins. An enrolment stored
 * with a null `projectVersionId` resolves its
 * project's published head; the pass, first in the seed's bootstrap and before
 * the import, pins it to that head as the rows stand, so this boot's import
 * cannot move it. A null row whose project has no published version is left
 * null and counted, and the first publish of its project, through the publish
 * door or the importer, pins it to that version.
 *
 * The pass's own cases write the rows directly, holding only what the pass
 * reads, as `story-repin.spec.ts` does; the first-publish cases go through
 * the real publish door and the real importer over the one-phase host
 * (`test/written-phase-pack.ts`, Shelf's Requirements alone), which is also
 * what lets a null row hold a state for a phase its version lacks.
 */

/** A stand-in compiled snapshot: the pass asks only that one is there. */
const SNAPSHOT = { content: { phases: [{ key: 'requirements', checks: { kind: 'markdown' } }] } } as never;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const freshStore = (): Promise<DataSource> =>
  memoryDataSource();

/** Rows by hand: a project, its versions, and enrolments with or without a pin. */
function rowsOf(db: () => DataSource) {
  return {
    project: async (slug: string) =>
      (await db().manager.save(db().manager.create(ProjectEntity, { slug, title: slug, platformOwned: false, origin: 'upload' }))).id,
    version: async (projectId: string, version: string, options: { status?: ProjectVersionEntity['status']; compiled?: boolean } = {}) =>
      (
        await db().manager.save(
          db().manager.create(ProjectVersionEntity, {
            projectId,
            version,
            status: options.status ?? 'published',
            manifest: {} as never,
            compiled: options.compiled === false ? null : SNAPSHOT,
            publishedAt: (options.status ?? 'published') === 'draft' ? null : new Date(Date.now() - 60_000).toISOString(),
          }),
        )
      ).id,
    enrol: async (projectSlug: string, projectVersionId: string | null = null, userId = `learner-${Math.random().toString(36).slice(2, 10)}`) =>
      db().manager.save(db().manager.create(EnrollmentEntity, { userId, projectSlug, projectVersionId, packVersion: 'as stored' })),
    state: (enrolment: EnrollmentEntity, phaseKey: string, phaseOrder: number) =>
      db().manager.save(
        db().manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: enrolment.userId, phaseKey: phaseKey as never, phaseOrder }),
      ),
    pinOf: async (id: string) => (await db().manager.findOneByOrFail(EnrollmentEntity, { id })).projectVersionId,
    receipt: async () => {
      const row = await db().manager.findOneBy(SettingEntity, { key: NULL_PIN_RECEIPT_KEY });
      return row ? { raw: row.value, parsed: JSON.parse(row.value) as Record<string, unknown> & { runs: unknown[] } } : null;
    },
  };
}

describe('the null-pin pass', () => {
  let db: DataSource;
  let logged: string[];
  const rows = rowsOf(() => db);

  beforeEach(async () => {
    db = await freshStore();
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (db?.isInitialized) await db.destroy();
  });

  it('pins a null row on a project with two stored published versions to the newer stored one, not to the version the boot\'s import publishes', async () => {
    // TaskTrackr as a store holds it the boot before a new pack version: two
    // published versions below the one on disk, and a learner with no pin. The
    // shipped pack stands for the version this boot imports.
    const shipped = new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr'));
    const onDisk = new ContentService().loadProject(shipped).version;
    const [major] = onDisk.split('.').map(Number);
    const older = `${major - 2}.0.0`;
    const newer = `${major - 1}.0.0`;
    const tasktrackr = await rows.project('tasktrackr');
    await rows.version(tasktrackr, older);
    const read = await rows.version(tasktrackr, newer);
    const learner = await rows.enrol('tasktrackr');

    expect(await headsAsStored(db.manager)).toEqual(new Map([['tasktrackr', { id: read, version: newer }]]));
    expect(await new NullPinService(db).run()).toEqual({ pinnedFromNull: 1, pinnedProjects: 1, unpinnedNoHead: 0, unpinnedProjects: 0 });
    expect(await rows.pinOf(learner.id)).toBe(read);

    const imported = await new ProjectImporterService(new ContentService(), db).importPack(shipped, { origin: 'seed', platformOwned: true });
    expect(imported.version).toBe(onDisk);
    // the import published the head; the learner still names what they read
    expect(await rows.pinOf(learner.id)).toBe(read);
    // and packVersion is as stored
    expect((await db.manager.findOneByOrFail(EnrollmentEntity, { id: learner.id })).packVersion).toBe('as stored');
  });

  it('skips a published row with no compiled snapshot when it chooses the head', async () => {
    const project = await rows.project('tasktrackr');
    const withSnapshot = await rows.version(project, '4.0.0');
    await rows.version(project, '5.0.0', { compiled: false });
    await rows.version(project, '6.0.0', { status: 'draft' });
    const learner = await rows.enrol('tasktrackr');

    await pinNullRows(db.manager);
    expect(await rows.pinOf(learner.id)).toBe(withSnapshot);
  });

  it('leaves a null row on a project with no published version, counted unpinnedNoHead, and one whose slug names no project', async () => {
    const draftOnly = await rows.project('draft-only');
    await rows.version(draftOnly, '1.0.0', { status: 'draft' });
    const noHead = await rows.enrol('draft-only');
    const noProject = await rows.enrol('gone-project');

    expect(await pinNullRows(db.manager)).toEqual({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 2, unpinnedProjects: 2 });
    expect(await rows.pinOf(noHead.id)).toBeNull();
    expect(await rows.pinOf(noProject.id)).toBeNull();
  });

  it('writes null-pin.receipt with counts and project counts only, and prints the boot line', async () => {
    const shelf = await rows.project('shelf');
    await rows.version(shelf, '1.0.0');
    await rows.enrol('shelf');
    await rows.enrol('draft-only');
    await rows.enrol('gone-project');
    const pinnedAlready = await rows.enrol('shelf', 'some-version');

    const result = await new NullPinService(db).run();
    expect(result).toEqual({ pinnedFromNull: 1, pinnedProjects: 1, unpinnedNoHead: 2, unpinnedProjects: 2 });
    expect(await rows.pinOf(pinnedAlready.id)).toBe('some-version');

    const receipt = await rows.receipt();
    expect(receipt?.parsed).toMatchObject({ pinnedFromNull: 1, pinnedProjects: 1, unpinnedNoHead: 2, unpinnedProjects: 2 });
    expect(receipt?.parsed.runs).toHaveLength(1);
    expect(receipt?.raw).not.toMatch(UUID);
    for (const slug of ['shelf', 'draft-only', 'gone-project', 'some-version']) expect(receipt?.raw).not.toContain(slug);

    const line =
      "null pin: pinned 1 enrolment(s) in 1 project(s) to the published version they read with no pin; left 2 in 2 project(s) with no published version, to be pinned at their project's first publish";
    expect(nullPinLine(result)).toBe(line);
    expect(logged).toContain(line);
  });

  it('a second boot pins nothing, leaves the running total and the latest count as the first boot wrote them, and adds one run', async () => {
    const shelf = await rows.project('shelf');
    await rows.version(shelf, '1.0.0');
    await rows.enrol('shelf');
    await rows.enrol('draft-only');

    await new NullPinService(db).run();
    const first = (await rows.receipt())!.parsed;
    const second = await new NullPinService(db).run();
    expect(second).toEqual({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 1, unpinnedProjects: 1 });

    const after = (await rows.receipt())!.parsed;
    expect(after.pinnedFromNull).toBe(first.pinnedFromNull);
    expect(after.unpinnedNoHead).toBe(first.unpinnedNoHead);
    expect(after.runs).toHaveLength(first.runs.length + 1);
  });

  it('writes the receipt and prints the line on a boot that pins nothing and leaves nothing, its counts 0', async () => {
    expect(await rows.receipt()).toBeNull();
    expect(await new NullPinService(db).run()).toEqual({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 0, unpinnedProjects: 0 });
    expect((await rows.receipt())?.parsed).toMatchObject({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 0, unpinnedProjects: 0 });
    expect(logged).toContain(
      "null pin: pinned 0 enrolment(s) in 0 project(s) to the published version they read with no pin; left 0 in 0 project(s) with no published version, to be pinned at their project's first publish",
    );
  });

  it('keeps running totals when a later boot pins more', async () => {
    const shelf = await rows.project('shelf');
    await rows.version(shelf, '1.0.0');
    await rows.enrol('shelf');
    await new NullPinService(db).run();

    const library = await rows.project('library');
    await rows.version(library, '2.0.0');
    await rows.enrol('library');
    expect((await new NullPinService(db).run()).pinnedFromNull).toBe(1);

    const receipt = (await rows.receipt())!.parsed;
    expect(receipt).toMatchObject({ pinnedFromNull: 2, pinnedProjects: 2 });
    expect(receipt.runs).toHaveLength(2);
  });

  /** The manager's next update, preceded by another writer's pin of `id` (a replica's pass, or the CLI beside a booting server). */
  const pinnedInBetween = (id: string) => {
    const update = db.manager.update.bind(db.manager);
    jest.spyOn(db.manager, 'update').mockImplementationOnce((async (...args: Parameters<typeof update>) => {
      await update(EnrollmentEntity, { id }, { projectVersionId: 'another-writer' });
      return update(...args);
    }) as never);
  };

  it('counts a row another writer pinned between the read and the guarded update in neither count, and keeps that pin', async () => {
    const shelf = await rows.project('shelf');
    await rows.version(shelf, '1.0.0');
    const raced = await rows.enrol('shelf');
    pinnedInBetween(raced.id);

    expect(await pinNullRows(db.manager)).toEqual({ pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 0, unpinnedProjects: 0 });
    expect(await rows.pinOf(raced.id)).toBe('another-writer');
  });

  it('the first-publish pin counts a row another writer pinned in between in neither pinned nor pinnedPhaseMismatch', async () => {
    const library = await rows.project('library');
    const version = await rows.version(library, '1.0.0');
    const raced = await rows.enrol('library');
    // a key the version lacks: counted pinnedPhaseMismatch, were it pinned here
    await rows.state(raced, 'design', 2);
    pinnedInBetween(raced.id);

    expect(await pinNullRowsAtFirstPublish(db.manager, 'library', version)).toEqual({ pinned: 0, pinnedPhaseMismatch: 0 });
    expect(await rows.pinOf(raced.id)).toBe('another-writer');
  });

  it('keeps the last RECEIPT_RUNS runs in the receipt, the oldest dropped and the newest last', async () => {
    const old = Array.from({ length: RECEIPT_RUNS }, (_, i) => ({ at: `run-${i}`, pinnedFromNull: 0, pinnedProjects: 0, unpinnedNoHead: 0, unpinnedProjects: 0 }));
    await db.manager.save(db.manager.create(SettingEntity, { key: NULL_PIN_RECEIPT_KEY, value: JSON.stringify({ pinnedFromNull: 4, pinnedProjects: 2, runs: old }) }));
    const shelf = await rows.project('shelf');
    await rows.version(shelf, '1.0.0');
    await rows.enrol('shelf');

    await new NullPinService(db).run();
    const receipt = (await rows.receipt())!.parsed as { pinnedFromNull: number; runs: { at: string; pinnedFromNull: number }[] };
    expect(receipt.runs).toHaveLength(RECEIPT_RUNS);
    expect(receipt.runs[0].at).toBe('run-1');
    expect(receipt.runs.at(-1)).toMatchObject({ pinnedFromNull: 1 });
    expect(receipt.runs.at(-1)?.at).not.toMatch(/^run-/);
    // the running total counts every run, the dropped one included
    expect(receipt.pinnedFromNull).toBe(5);
  });

  it('adds nothing to the re-pin\'s result or its receipts', async () => {
    const compiledWith = (kind: 'markdown' | 'story') =>
      ({
        content: {
          phases: [
            { key: 'requirements', checks: kind === 'story' ? { kind, learnerStory: { id: 'US-4', hints: {} } } : { kind } },
            { key: 'design', intro: 'the design', checks: { kind: 'markdown' } },
          ],
        },
      }) as never;
    await db.manager.save(db.manager.create(UserEntity, { email: 'admin@null-pin.test', passwordHash: 'x', displayName: 'Admin', role: 'ADMIN' }));
    const tasktrackr = await rows.project('tasktrackr');
    const markdown = (
      await db.manager.save(
        db.manager.create(ProjectVersionEntity, { projectId: tasktrackr, version: '2.0.1', status: 'published', manifest: {} as never, compiled: compiledWith('markdown'), publishedAt: new Date(Date.now() - 60_000).toISOString() }),
      )
    ).id;
    const story = (
      await db.manager.save(
        db.manager.create(ProjectVersionEntity, { projectId: tasktrackr, version: '3.0.0', status: 'published', manifest: {} as never, compiled: compiledWith('story'), publishedAt: new Date(Date.now() - 60_000).toISOString() }),
      )
    ).id;
    await rows.enrol('tasktrackr', markdown);
    const nullRow = await rows.enrol('tasktrackr');

    await new NullPinService(db).run();
    expect(await rows.pinOf(nullRow.id)).toBe(story);
    const receiptKeys = [STORY_MIGRATION_RECEIPT_KEY, DESIGN_MIGRATION_RECEIPT_KEY, RUNBOOK_MIGRATION_RECEIPT_KEY, CHANGE_MIGRATION_RECEIPT_KEY];
    for (const key of receiptKeys) expect(await db.manager.findOneBy(SettingEntity, { key })).toBeNull();

    const repinned = await new StoryRepinService(db).run();
    expect(repinned).not.toBeNull();
    expect(repinned).not.toHaveProperty('pinnedFromNull');
    expect(repinned).not.toHaveProperty('unpinnedNoHead');
    // the re-pin moved its own learner only: the null row was already on the head
    expect(repinned?.moved).toBe(1);
    expect(logged.find((line) => line.startsWith('structured re-pin:'))).not.toMatch(/null pin/);
  });
});

describe('the first-publish pins', () => {
  const TEACHER = { id: 'teacher-null-pin', role: 'INSTRUCTOR' as const, cohort: 'default' };
  let db: DataSource;
  let content: ContentService;
  let importer: ProjectImporterService;
  let registry: ProjectRegistryService;
  let service: AuthoringService;
  let hostVersionId = '';
  const rows = rowsOf(() => db);

  /** A teacher's copy of the one-phase host: a project of Requirements alone, not yet published. */
  const teacherProject = async (slug: string) => {
    const fork = await copyHost({ service }, hostVersionId, slug, TEACHER);
    return { ...fork, slug };
  };
  const publish = (fork: { projectId: string; versionId: string }, version = '1.0.0') =>
    service.publish(TEACHER, fork.projectId, fork.versionId, { version });
  const publishAudit = async (version: string) =>
    (await db.manager.find(AuditEventEntity, { where: { event: 'project.publish' } })).find((row) => row.action === version && row.actorUserId === TEACHER.id);
  const auditFor = async (projectId: string) =>
    (await db.manager.find(AuditEventEntity, { where: { event: 'project.publish', targetId: projectId } }));

  /** The host pack at another version, so the importer has a later publish to make. */
  const hostAt = (version: string, slug = HOST_SLUG): MemoryPackSource => {
    const source = layoutFromManifest(hostPack({ slug })).source;
    const entries = source.walkForDigest().map((name) => {
      const bytes = source.bytesOf(name)!;
      if (name !== 'project.json') return { name, bytes };
      return { name, bytes: Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), version }, null, 2)) };
    });
    return new MemoryPackSource(entries, slug);
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db = await freshStore();
    content = new ContentService();
    importer = new ProjectImporterService(content, db);
    registry = new ProjectRegistryService(content, db, { importedContent: [] } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    hostVersionId = (await importer.importPack(layoutFromManifest(hostPack({ slug: 'null-pin-host' })).source, { origin: 'seed', platformOwned: true })).projectVersionId;
    await registry.load();
    service = new AuthoringService(db, importer, registry);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (db?.isInitialized) await db.destroy();
  });

  it('the publish door pins a no-head project\'s null rows to its first published version, and counts them in the audit row', async () => {
    const fork = await teacherProject('first-publish');
    const waiting = await rows.enrol(fork.slug);
    await rows.state(waiting, HOST_PHASE, 1);
    const otherProject = await rows.enrol('someone-else');

    const published = await publish(fork);
    expect(await rows.pinOf(waiting.id)).toBe(published.versionId);
    expect(await rows.pinOf(otherProject.id)).toBeNull();
    expect((await publishAudit('1.0.0'))?.detail).toMatchObject({ pinnedFromNull: 1 });
    expect((await auditFor(fork.projectId))[0]?.detail).not.toHaveProperty('pinnedPhaseMismatch');
  });

  it('the publish door pins such a row even when its states hold a phase the version lacks, and counts it', async () => {
    const fork = await teacherProject('extra-phase');
    const waiting = await rows.enrol(fork.slug);
    await rows.state(waiting, HOST_PHASE, 1);
    const extra = await rows.state(waiting, 'design', 2);

    const published = await publish(fork);
    expect(await rows.pinOf(waiting.id)).toBe(published.versionId);
    expect((await auditFor(fork.projectId))[0]?.detail).toMatchObject({ pinnedFromNull: 1, pinnedPhaseMismatch: 1 });
    // kept, never deleted
    expect(await db.manager.findOneBy(PhaseStateEntity, { id: extra.id })).not.toBeNull();
  });

  it('the learner\'s board draws only the version\'s phases for such a row', async () => {
    const fork = await teacherProject('extra-phase-board');
    const waiting = await rows.enrol(fork.slug);
    await rows.state(waiting, HOST_PHASE, 1);
    await rows.state(waiting, 'design', 2);
    await publish(fork);

    const workflow = new WorkflowService(
      db.getRepository(EnrollmentEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(ReleaseRecordEntity) as Repository<ReleaseRecordEntity>,
      content,
      { latestFor: async () => null } as unknown as FeedbackService,
      db,
    );
    const view = await workflow.enrollmentView(await db.manager.findOneByOrFail(EnrollmentEntity, { id: waiting.id }));
    expect(view.phases.map((phase) => phase.key)).toEqual([HOST_PHASE]);
    expect((await db.manager.find(PhaseStateEntity, { where: { enrollmentId: waiting.id } })).map((state) => state.phaseKey).sort()).toEqual(['design', HOST_PHASE]);
  });

  it('counts a pinned row whose states\' orders disagree with the version\'s as pinnedPhaseMismatch', async () => {
    const fork = await teacherProject('order-differs');
    const agrees = await rows.enrol(fork.slug);
    await rows.state(agrees, HOST_PHASE, 1);
    const differs = await rows.enrol(fork.slug);
    await rows.state(differs, HOST_PHASE, 2);

    const published = await publish(fork);
    expect(await rows.pinOf(agrees.id)).toBe(published.versionId);
    expect(await rows.pinOf(differs.id)).toBe(published.versionId);
    expect((await auditFor(fork.projectId))[0]?.detail).toMatchObject({ pinnedFromNull: 2, pinnedPhaseMismatch: 1 });
  });

  it('a project whose only published row has no compiled snapshot pins its null rows at its next publish, not before', async () => {
    const fork = await teacherProject('no-snapshot');
    // below the draft's own number (DRAFT_FIRST_VERSION), as an earlier publish would be
    await rows.version(fork.projectId, '0.0.1', { compiled: false });
    const waiting = await rows.enrol(fork.slug);

    // the pass asks for a stored head as the registry installs one, so it leaves the row
    expect(await pinNullRows(db.manager)).toMatchObject({ pinnedFromNull: 0 });
    expect(await rows.pinOf(waiting.id)).toBeNull();

    const published = await publish(fork);
    expect(await rows.pinOf(waiting.id)).toBe(published.versionId);
    expect((await publishAudit('1.0.0'))).toBeDefined();
    expect((await auditFor(fork.projectId))[0]?.detail).toMatchObject({ pinnedFromNull: 1 });

    // the importer asks the same question
    const slug = 'no-snapshot-import';
    const project = await rows.project(slug);
    // a platform row, as the boot's own import leaves one: a platform import
    // skips a slug a non-platform project holds
    await db.manager.update(ProjectEntity, { id: project }, { platformOwned: true, origin: 'seed' });
    await rows.version(project, '0.1.0', { compiled: false });
    const importWaiting = await rows.enrol(slug);
    const imported = await importer.importPack(hostAt('1.0.0', slug), { origin: 'seed', platformOwned: true });
    expect(await rows.pinOf(importWaiting.id)).toBe(imported.projectVersionId);
  });

  it('the importer\'s first publish of a platform project pins its null rows', async () => {
    const slug = 'platform-first';
    const waiting = await rows.enrol(slug);
    const imported = await importer.importPack(hostAt('1.0.0', slug), { origin: 'seed', platformOwned: true });
    expect(imported.outcome).toBe('imported');
    expect(await rows.pinOf(waiting.id)).toBe(imported.projectVersionId);
    // counted on the result, for the line printed beside describeImport (counts only)
    expect(imported.pinnedFromNull).toBe(1);
    expect(describeFirstPublishPins(imported)).toBe("null pin: pinned 1 enrolment(s) waiting on this project's first version");
    // packVersion as stored
    expect((await db.manager.findOneByOrFail(EnrollmentEntity, { id: waiting.id })).packVersion).toBe('as stored');
  });

  it('the importer\'s later publish pins nothing', async () => {
    const slug = 'platform-later';
    const first = await rows.enrol(slug);
    const v1 = await importer.importPack(hostAt('1.0.0', slug), { origin: 'seed', platformOwned: true });
    expect(await rows.pinOf(first.id)).toBe(v1.projectVersionId);

    // a null row written after the first publish waits for the next boot's pass, not for this import
    const later = await rows.enrol(slug);
    const v2 = await importer.importPack(hostAt('1.1.0', slug), { origin: 'seed', platformOwned: true });
    expect(v2.projectVersionId).not.toBe(v1.projectVersionId);
    expect(await rows.pinOf(first.id)).toBe(v1.projectVersionId);
    expect(await rows.pinOf(later.id)).toBeNull();
    expect(v2).not.toHaveProperty('pinnedFromNull');
    expect(describeFirstPublishPins(v2)).toBeNull();
  });

  it('the boot\'s directory import prints the pin line after the project\'s own line, and no line for a project that pinned nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learnsdlc-null-pin-'));
    try {
      for (const slug of ['dir-first', 'dir-nothing']) {
        const source = hostAt('1.0.0', slug);
        for (const name of source.walkForDigest()) {
          fs.mkdirSync(path.dirname(path.join(root, slug, name)), { recursive: true });
          fs.writeFileSync(path.join(root, slug, name), source.bytesOf(name)!);
        }
      }
      const waiting = await rows.enrol('dir-first');
      await rows.enrol('dir-first');
      const logged: string[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
        logged.push(String(message));
      });

      const results = await importer.importContentDirectory(root, { origin: 'seed', platformOwned: true });
      const first = results.find((result) => result.slug === 'dir-first')!;
      const nothing = results.find((result) => result.slug === 'dir-nothing')!;
      expect(await rows.pinOf(waiting.id)).toBe(first.projectVersionId);
      const pinLine = "null pin: pinned 2 enrolment(s) waiting on this project's first version";
      expect(logged.indexOf(pinLine)).toBe(logged.indexOf(describeImport(first)) + 1);
      expect(logged.filter((line) => line.startsWith('null pin:'))).toEqual([pinLine]);
      expect(logged.indexOf(describeImport(nothing))).toBeGreaterThan(-1);
    } finally {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the publish door\'s later publish pins nothing and its audit row carries no count', async () => {
    const fork = await teacherProject('door-later');
    const head = await publish(fork);
    const draft = await service.createDraftVersion(TEACHER, fork.projectId, { fromVersionId: head.versionId });
    const later = await rows.enrol(fork.slug);
    await service.publish(TEACHER, fork.projectId, draft.versionId, { version: '1.1.0' });
    expect(await rows.pinOf(later.id)).toBeNull();
    const audits = await auditFor(fork.projectId);
    const second = audits.find((row) => row.action === '1.1.0');
    expect(second?.detail).not.toHaveProperty('pinnedFromNull');
    expect(second?.detail).not.toHaveProperty('pinnedPhaseMismatch');
  });
});

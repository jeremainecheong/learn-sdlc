// The harness is story-export.spec.ts's world (`openForkWorld`: an in-memory
// database with TaskTrackr seeded), with shelf-task, a pack whose Requirements
// is still of the 2.x markdown kind, beside it. A draft of that kind can reach
// the database three ways: a copy of a published markdown version, the
// next draft opened from one, and a draft stored before uploads converted.
// Each door converts it with the legacy adapter, so the room never meets one.
import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { MemoryPackSource } from '../content/memory-pack-source';
import { layoutFromManifest } from '../content/legacy-layout';
import { ProjectImporterService } from '../content/importer.service';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { SettingEntity } from '../db/entities';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { STORY_DRAFTS_DONE_KEY, DraftConversionService } from './draft-conversion.service';
import { openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { importOlderPack, storeOlderPhases } from '../../test/older-written-rows';
import { entriesOf } from '../../test/fixtures/upload-packs/archive';
import { REQUIREMENTS_OLDER_FORMAT_REFUSAL } from '@learnsdlc/shared';
import { memoryDataSource } from '../../test/support/memory-db';

const caller = { id: 'teacher-legacy', role: 'INSTRUCTOR' as const, cohort: 'default' };
const LEGACY_DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'shelf-task');
const LEGACY_PHASE = 'phases/01-requirements/phase.json';
const BACKLOG = '# Shelf backlog\n\n## SH-1 Browse the shelf\nAs a member, I want to see every book in shelf order, so that I can find one without asking.\n';

/** shelf-task with a read-only provided-stories.md beside the learner's file, as a 2.x pack shipped it. */
const legacySource = (name: string) =>
  new MemoryPackSource(
    entriesOf(LEGACY_DIR)
      .map((entry) => {
        if (entry.name !== LEGACY_PHASE) return { name: entry.name, bytes: entry.data };
        const phase = JSON.parse(entry.data.toString('utf8'));
        phase.files.push({ path: 'requirements/provided-stories.md', source: 'files/provided-stories.md', editable: false, language: 'markdown' });
        return { name: entry.name, bytes: Buffer.from(JSON.stringify(phase, null, 2)) };
      })
      .concat([{ name: 'phases/01-requirements/files/provided-stories.md', bytes: Buffer.from(BACKLOG) }]),
    name,
  );
/**
 * shelf-task stays in the older, pointer layout on purpose, and the loader reads only the folder layout,
 * so the importer is handed the pack converted once, as the upload door converts an older archive. The older source
 * itself still says which phases an older import stored in the older kind.
 */
const converted = (older: MemoryPackSource) => layoutFromManifest(older).source;

describe('a Requirements draft of the 2.x markdown kind is converted at every door a draft is written', () => {
  let world: ForkWorld;
  let importer: ProjectImporterService;
  let legacyVersionId = '';

  const requirementsOf = async (versionId: string) => {
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'requirements' });
    const tasks = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    const files = await world.dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: versionId, ownerId: phase.id });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    const compiled = version.compiled!.content.phases.find((one) => one.key === 'requirements')!;
    return { phase, tasks, paths: files.map((file) => file.path).sort(), compiled };
  };

  /** A teacher's draft as it was stored before uploads converted: its Requirements rows in the older kind. */
  const storedLegacyDraft = async (title: string) => {
    const source = legacySource('stored');
    const stored = await importer.importTeacherDraft(converted(source), { ownerId: caller.id, title });
    await storeOlderPhases(world.dataSource, stored.versionId, source);
    return stored;
  };

  const expectConverted = async (versionId: string) => {
    const { phase, tasks, paths, compiled } = await requirementsOf(versionId);
    expect(phase.artifactKind).toBe('story');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].checks.kind).toBe('story');
    expect(tasks[0].artefactPath).toBeNull();
    expect(tasks[0].checks.kind === 'story' && tasks[0].checks.providedStories.map((story) => story.id)).toEqual(['SH-1']);
    expect(tasks[0].checks.kind === 'story' && tasks[0].checks.learnerStory.id).toBe('SH-5');
    expect(paths).toEqual(['requirements/story.json']);
    expect(compiled.checks.kind).toBe('story');
    expect(compiled.artifactKind).toBe('story');
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
    importer = new ProjectImporterService(world.content, world.dataSource);
    // a published platform pack of the old kind, stored as an older import stored it (boot imports never converted)
    const published = legacySource('published');
    const imported = await importOlderPack(world.content, world.dataSource, published, () => importer.importPack(converted(published), { origin: 'seed', platformOwned: true }));
    legacyVersionId = imported.projectVersionId;
    await world.registry.load();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('the published source stays markdown: only the draft written from it changes', async () => {
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: legacyVersionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('markdown');
  });

  it('a copy of a published markdown version is a story draft', async () => {
    const made = await world.service.createProject(caller, { title: 'Legacy copy', slug: 'legacy-copy', fromVersionId: legacyVersionId });
    await expectConverted(made.draftVersionId);
    const view = await world.service.listTasks(caller, made.project.id, made.draftVersionId, 'requirements');
    expect(view.tasks[0].story?.learnerStory.id).toBe('SH-5');
  });

  it('a draft stored before the story kind is converted by the one-time pass, which then finds nothing more', async () => {
    const stored = await storedLegacyDraft('Stored legacy');
    expect((await requirementsOf(stored.versionId)).tasks[0].checks.kind).toBe('markdown');
    const first = await world.service.convertLegacyRequirementsDrafts();
    expect(first.converted).toEqual([stored.versionId]);
    expect(first.refused).toEqual([]);
    expect(first.notes).toEqual([expect.stringMatching(/^Requirements converted from markdown: 1 provided stories, learner story SH-5/)]);
    await expectConverted(stored.versionId);
    expect(await world.service.convertLegacyRequirementsDrafts()).toEqual({ converted: [], refused: [], notes: [] });
  });

  it('a markdown draft is refused at publish; the next draft opened from a published markdown version is a story draft', async () => {
    const stored = await storedLegacyDraft('Published legacy');
    await expect(world.service.publish(caller, stored.projectId, stored.versionId, { version: '1.0.0' })).rejects.toThrow(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
    expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: stored.versionId })).status).toBe('draft');
    // A version published in the markdown format: written as published directly, since publish refuses it.
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: stored.versionId }, { status: 'published', version: '1.0.0', publishedAt: new Date().toISOString() } as never);
    const opened = await world.service.createDraftVersion(caller, stored.projectId, { fromVersionId: stored.versionId } as never);
    await expectConverted(opened.versionId);
  });

  it('the boot runs the pass once, and adds the drafts to the migration\'s receipt beside the workspaces', async () => {
    await world.dataSource.getRepository(SettingEntity).save({ key: STORY_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ counts: { 'kept-record': 2 } }) });
    const stored = await storedLegacyDraft('Converted at boot');
    const boot = new DraftConversionService(world.dataSource, world.service);
    expect(await boot.run('story')).toEqual({ converted: 1, refused: 0 });
    await expectConverted(stored.versionId);
    const receipt = JSON.parse((await world.dataSource.getRepository(SettingEntity).findOneByOrFail({ key: STORY_MIGRATION_RECEIPT_KEY })).value);
    expect(receipt.counts).toEqual({ 'kept-record': 2 });
    expect(receipt.drafts).toMatchObject({ converted: [stored.versionId], refused: [] });
    expect(await world.dataSource.getRepository(SettingEntity).findOneBy({ key: STORY_DRAFTS_DONE_KEY })).not.toBeNull();
    await storedLegacyDraft('Stored after the pass');
    expect(await boot.run('story')).toBeNull();
  });

  it('a draft the adapter cannot convert is left as it is and listed with the reason', async () => {
    // Self-contained: whatever an earlier case left stored is converted first,
    // so this pass sees the one draft made here and nothing else.
    await world.service.convertLegacyRequirementsDrafts();
    const stored = await storedLegacyDraft('Unconvertible');
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: stored.versionId, key: 'requirements' });
    // a second written task beside the story: a story phase cannot hold one
    const [task] = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    await world.dataSource.getRepository(ProjectTaskEntity).save({ ...task, id: undefined, taskKey: 'notes', order: 2, checks: { ...task.checks, targets: ['requirements/notes.md'] } as never });
    const out = await world.service.convertLegacyRequirementsDrafts();
    expect(out.converted).toEqual([]);
    expect(out.refused).toEqual([{ versionId: stored.versionId, reason: 'the Requirements phase holds another written task beside the story, and a story phase cannot' }]);
    expect((await requirementsOf(stored.versionId)).tasks.map((one) => one.checks.kind)).toEqual(['markdown', 'markdown']);
    // Left in the older format, it cannot be published: the refusal says how to convert it.
    await expect(world.service.publish(caller, stored.projectId, stored.versionId, { version: '1.0.0' })).rejects.toThrow(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
  });

  it('an edit to a markdown Requirements task: a story body converts it', async () => {
    const stored = await storedLegacyDraft('Edited legacy');
    expect((await requirementsOf(stored.versionId)).tasks[0].checks.kind).toBe('markdown');
    await world.service.updateTask(caller, stored.projectId, stored.versionId, 'requirements', 'main', {
      story: { providedStories: [], learnerStory: { id: 'SH-5', hints: {} }, floor: { minCriteria: 2, requiredTags: ['happy'], minExclusions: 1, requireSentence: true } },
    } as never);
    expect((await requirementsOf(stored.versionId)).tasks[0].checks.kind).toBe('story');
  });

  it('a draft that fails for another reason is rolled back and listed, and the pass goes on', async () => {
    const broken = await storedLegacyDraft('Never finished');
    await world.dataSource.getRepository(ProjectVersionEntity).update({ id: broken.versionId }, { compiled: null });
    const fine = await storedLegacyDraft('Fine');
    const out = await world.service.convertLegacyRequirementsDrafts();
    expect(out.refused).toContainEqual({ versionId: broken.versionId, reason: expect.stringContaining('holds no compiled snapshot') });
    expect(out.converted).toContain(fine.versionId);
    expect((await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: (await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: broken.versionId, key: 'requirements' })).id }))[0].checks.kind).toBe('markdown');
  });
});

describe('the boot\'s draft pass on a store with nothing to do', () => {
  it('writes nothing: no receipt, no marker', async () => {
    Logger.overrideLogger(false);
    const { DataSource } = await import('typeorm');
    const { ALL_ENTITIES } = await import('../db/entities');
    const db = await memoryDataSource();
    try {
      const authoring = { convertLegacyRequirementsDrafts: async () => ({ converted: [], refused: [], notes: [] }) };
      const boot = new DraftConversionService(db, authoring as never);
      expect(await boot.run('story')).toEqual({ converted: 0, refused: 0 });
      expect(await db.manager.count(SettingEntity)).toBe(0);
    } finally {
      await db.destroy();
    }
  });
});

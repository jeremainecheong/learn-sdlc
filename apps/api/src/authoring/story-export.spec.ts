// The harness is export.service.spec.ts's world (`openForkWorld`: an in-memory
// database with the platform pack seeded), with the shelf upload fixture
// imported as a teacher's draft. Its Requirements phase is a story phase, so
// the export writes the story block, and the archive comes back through the
// real upload door (`UploadService` over the real importer).
import 'reflect-metadata';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import { EMPTY_STORY, REQUIREMENTS_OLDER_FORMAT_REFUSAL, STORY_JSON, plainTextOf, serialiseStory } from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { layoutFromManifest, OLDER_LAYOUT_WARNING } from '../content/legacy-layout';
import { ProjectImporterService } from '../content/importer.service';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectVersionEntity } from '../content/project.entities';
import { readZip, zipLimits } from '../content/zip-reader';
import { openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { storeOlderPhases } from '../../test/older-written-rows';
import { entriesOf, writeZip } from '../../test/fixtures/upload-packs/archive';
import { SHELF_DIR } from '../../test/fixtures/upload-packs/markers';
import { ExportService } from './export.service';
import { UploadService } from './upload.service';


/**
 * The door's notes for an archive in the older layout: it was read
 * once into the folder layout, and each brief that held markdown kept as
 * plain text. shelf-task stays in the older layout with markdown briefs, so
 * these are the only notes an upload of it adds beside its conversion's; an
 * export writes the folder layout with every text plain, so its
 * re-upload adds none.
 */

const caller = { id: 'teacher-story-exp', email: 'teacher@story-export.test', role: 'INSTRUCTOR' as const, cohort: 'default' };
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs');
const STARTER_DIR = path.join(FIXTURES, 'starter');
const LEGACY_DIR = path.join(FIXTURES, 'shelf-task');
const LEGACY_PHASE = 'phases/01-requirements/phase.json';
/** A backlog of the old kind: SH-1 written in full, SH-2 with no "so that". */
const LEGACY_BACKLOG = [
  '# Shelf backlog',
  '',
  '## SH-1 Browse the shelf',
  'As a member, I want to see every book in shelf order, so that I can find one without asking.',
  '',
  '## SH-2 Lend a book',
  'As a librarian, I want to record who has borrowed a book.',
  '',
].join('\n');

/** shelf-task, a pack of the old markdown kind, with a read-only provided-stories.md beside the learner's file. */
function legacyEntries(): { name: string; data: Buffer }[] {
  return entriesOf(LEGACY_DIR).map((entry) => {
    if (entry.name !== LEGACY_PHASE) return entry;
    const phase = JSON.parse(entry.data.toString('utf8'));
    phase.files.push({ path: 'requirements/provided-stories.md', source: 'files/provided-stories.md', editable: false, language: 'markdown' });
    return { name: entry.name, data: Buffer.from(JSON.stringify(phase, null, 2)) };
  }).concat([{ name: 'phases/01-requirements/files/provided-stories.md', data: Buffer.from(LEGACY_BACKLOG) }]);
}

/** Each entry's name under the archive's pack root, with its bytes. */
function entriesUnderRoot(archive: Buffer): Map<string, Buffer> {
  const entries = readZip(archive, zipLimits(config.importMaxBytes));
  const root = packRootOf(entries);
  const prefix = root ? `${root}/` : '';
  return new Map(entries.filter((e) => e.name.startsWith(prefix)).map((e) => [e.name.slice(prefix.length), e.bytes]));
}
const zipEntryNames = (archive: Buffer): string[] => [...entriesUnderRoot(archive).keys()];
const zipEntryText = (archive: Buffer, name: string): string => {
  const bytes = entriesUnderRoot(archive).get(name);
  if (!bytes) throw new Error(`the archive holds no ${name}`);
  return bytes.toString('utf8');
};
/** A pack directory zipped, with `extra` entries added. */
const zipWith = (extra: Record<string, string>, dir: string): Buffer =>
  writeZip([...entriesOf(dir), ...Object.entries(extra).map(([name, text]) => ({ name, data: Buffer.from(text) }))]);

describe('a story phase through export and upload', () => {
  let world: ForkWorld;
  let exportService: ExportService;
  let uploadService: UploadService;
  let projectId = '';
  let versionId = '';
  const upload = (title: string, archive: Buffer) =>
    uploadService.upload(caller, { title, archiveBase64: archive.toString('base64') });
  const requirementsTask = async (pid: string, vid: string) =>
    (await world.service.listTasks(caller, pid, vid, 'requirements')).tasks[0];

  beforeAll(async () => {
    world = await openForkWorld();
    const importer = new ProjectImporterService(world.content, world.dataSource);
    exportService = new ExportService(world.dataSource, world.content);
    uploadService = new UploadService(importer, world.content, world.dataSource, 8 * 1024 * 1024);
    const made = await importer.importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: caller.id, title: 'Shelf story' });
    projectId = made.projectId;
    versionId = made.versionId;
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('exports a story phase without task.md or markdown files, and re-uploads to the same checks', async () => {
    const { archive } = await exportService.export(caller, projectId, versionId);
    const names = zipEntryNames(archive);
    expect(names).not.toContain('phases/01-requirements/task.md');
    expect(names.filter((n) => n.startsWith('phases/01-requirements/files/'))).toEqual([]);
    const phaseJson = JSON.parse(zipEntryText(archive, 'phases/01-requirements/phase.json'));
    expect(phaseJson.checks.kind).toBe('story');
    expect(typeof phaseJson.taskPanel).toBe('string');
    expect(phaseJson.taskFile).toBeUndefined();
    // the folder layout names no file: the seeded record is left out and the loader seeds it again
    expect('files' in phaseJson).toBe(false);
    const again = await upload('Again', archive);
    expect(again.warnings).toBeUndefined();
    const task = await requirementsTask(again.projectId, again.versionId);
    expect(task.story?.floor).toEqual(phaseJson.checks.floor);
    expect(task.story?.providedStories).toEqual(phaseJson.checks.providedStories);
    expect(task.story?.learnerStory.id).toBe(phaseJson.checks.learnerStory.id);
  });

  it.each(['phases/01-requirements/reference-stories.md', 'phases/02-design/reference-stories.md'])('refuses reference-stories.md (%s), whatever the phase folder is called', async (at) => {
    const refused = await upload('Old', zipWith({ [at]: '## RS-1 x' }, STARTER_DIR)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getResponse()).toMatchObject({
      code: 'NOT_A_PACK',
      detail: "reference-stories.md is no longer read. Type the stakeholder's facts in the editor.",
    });
  });

  it.each([
    ['a story-kind Design phase', 'phases/02-design/phase.json', (phase: Record<string, unknown>) => ({ ...phase, checks: { kind: 'story' } }), 'Only the Requirements phase can use the story kind.'],
    ['a record at another path', 'phases/01-requirements/phase.json', (phase: Record<string, unknown>) => ({ ...phase, checks: { ...(phase.checks as object), record: 'requirements/mine.json' } }), 'The story record is always requirements/story.json.'],
    ['a provided story id over the cap', 'phases/01-requirements/phase.json', (phase: Record<string, unknown>) => {
      const checks = phase.checks as { providedStories: Record<string, unknown>[] };
      return { ...phase, checks: { ...checks, providedStories: [{ ...checks.providedStories[0], id: 'X'.repeat(17) }, ...checks.providedStories.slice(1)] } };
    }, 'A provided story id is longer than 16 characters.'],
  ])('refuses %s at the upload door, NOT_A_PACK with the fixed sentence in detail', async (_n, name, edit, sentence) => {
    const entries = entriesOf(STARTER_DIR).map((entry) =>
      entry.name === name ? { name, data: Buffer.from(JSON.stringify(edit(JSON.parse(entry.data.toString('utf8'))), null, 2)) } : entry,
    );
    const refused = await upload('Refused story', writeZip(entries)).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    expect((refused as HttpException).getResponse()).toMatchObject({ code: 'NOT_A_PACK', detail: expect.stringContaining(sentence.replace(/\.$/, '')) });
  });

  it('exports a record that is not the seed under files/, and the upload keeps it byte for byte', async () => {
    const record = serialiseStory({ ...EMPTY_STORY, id: 'SH-5', title: 'Free books by one author', persona: 'member' });
    // the starting record mounted editable at its workspace path under files/
    const entries = entriesOf(SHELF_DIR);
    entries.push({ name: `phases/01-requirements/files/${STORY_JSON}`, data: Buffer.from(record) });
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const made = await importer.importTeacherDraft(new MemoryPackSource(entries.map((e) => ({ name: e.name, bytes: e.data })), 'edited'), {
      ownerId: caller.id,
      title: 'Shelf with an edited record',
    });
    const { archive } = await exportService.export(caller, made.projectId, made.versionId);
    expect(zipEntryText(archive, `phases/01-requirements/files/${STORY_JSON}`)).toBe(record);
    const again = await upload('Edited again', archive);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId });
    const requirements = version.compiled!.content.phases.find((one) => one.key === 'requirements')!;
    expect(requirements.files.find((file) => file.path === STORY_JSON)?.content).toBe(record);
  });

  it('exports whole a teacher draft whose Requirements phase is still markdown (made before the story kind), with its markdown files and its brief inline', async () => {
    // A draft stored before uploads converted: its Requirements rows in the older kind, as an older import stored them.
    // The older archive is imported converted to the folder layout the loader reads, then its older phase is written back.
    const source = new DirectoryPackSource(LEGACY_DIR);
    const made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(layoutFromManifest(source).source, {
      ownerId: caller.id,
      title: 'Shelf before the story kind',
    });
    await storeOlderPhases(world.dataSource, made.versionId, source);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('markdown');
    const out = await exportService.export(caller, made.projectId, made.versionId);
    expect(out.withheld).toEqual([]);
    const names = zipEntryNames(out.archive);
    // the brief is the phase's taskPanel, written plain, never a task.md
    expect(names).not.toContain('phases/01-requirements/task.md');
    expect(names).toContain('phases/01-requirements/files/requirements/my-story.md');
    const phaseJson = JSON.parse(zipEntryText(out.archive, 'phases/01-requirements/phase.json'));
    expect(phaseJson.checks.kind).toBe('markdown');
    // the work task's brief, as the editor last saved it
    expect(phaseJson.taskPanel).toBe(plainTextOf(version.compiled!.phases.find((one) => one.key === 'requirements')!.tasks[0].brief));
  });

  it('uploads the starter, whose interview is its own interview.json', async () => {
    const made = await upload('Starter story', zipWith({}, STARTER_DIR));
    const task = await requirementsTask(made.projectId, made.versionId);
    expect(task.story?.learnerStory.id).toBe('SH-5');
    const brief = await world.service.readInterview(caller, made.projectId, made.versionId);
    expect(JSON.stringify(brief)).toContain('Head Librarian');
  });

  it('converts an uploaded Requirements phase of the old markdown kind, and names the stories to correct in a warning', async () => {
    const made = await upload('Legacy shelf', writeZip(legacyEntries()));
    // shelf-task stays in the older layout on purpose (the door's conversion is what this reads), so the door says
    // it read the archive once, then the Requirements conversion's own line, then that its markdown brief was kept plain
    expect(made.warnings).toEqual([
      OLDER_LAYOUT_WARNING,
      'Requirements converted from markdown: 2 provided stories, learner story SH-5, default floor; 1 rule targets dropped; default persona, capability or benefit filled for SH-2',
      "Requirements' brief had markdown in it. It was kept as plain text, every word in place; read it in the editor.",
    ]);
    const task = await requirementsTask(made.projectId, made.versionId);
    expect(task.story?.providedStories.map((s) => s.id)).toEqual(['SH-1', 'SH-2']);
    expect(task.story?.floor).toEqual({ minCriteria: 2, requiredTags: ['happy', 'boundary'], minExclusions: 1, requireSentence: true });
  });

  it('the boot import (importPack) refuses a markdown Requirements phase by its older-format sentence: boot never converts', async () => {
    // shelf-task is still of the old markdown kind; TaskTrackr has been a story
    // phase since 3.0.0, so the guard needs a pack that would convert if boot did.
    // Boot reads the folder layout only, so it is handed shelf-task converted to it, its Requirements still markdown.
    await expect(
      new ProjectImporterService(world.content, world.dataSource).importPack(layoutFromManifest(new DirectoryPackSource(LEGACY_DIR)).source, { origin: 'seed', platformOwned: true }),
    ).rejects.toThrow(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
    // and the seeded TaskTrackr is a story phase because its pack says so, not because boot converted it
    const seeded = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: world.seedVersionId });
    expect(seeded.compiled!.content.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('story');
  });

  it('converts only when asked: the platform loader refuses the old kind by its older-format sentence', () => {
    // the older archive converted once to the folder layout, the only layout the loader reads; its Requirements keeps the older kind
    const source = () => layoutFromManifest(new MemoryPackSource(legacyEntries().map((e) => ({ name: e.name, bytes: e.data })), 'legacy')).source;
    expect(() => new ContentService().loadProject(source())).toThrow(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
    const warnings: string[] = [];
    const converted = new ContentService().loadProject(source(), { convertLegacyRequirements: true, warnings });
    const phase = converted.phases.find((p) => p.key === 'requirements')!;
    expect(phase.checks.kind).toBe('story');
    expect(phase.artifactKind).toBe('story');
    expect(phase.files.map((f) => f.path)).toEqual([STORY_JSON]);
    expect(warnings).toHaveLength(1);
  });
});

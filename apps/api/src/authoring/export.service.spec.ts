import 'reflect-metadata';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, In } from 'typeorm';
import { ConflictException, ForbiddenException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { DRAFT_FIRST_VERSION, INHERITED_TASK_KEY, SEALED_FILE_ROLES, UPLOAD_REFUSAL_DETAIL_MAX, compareMountPaths, plainTextOf } from '@learnsdlc/shared';
import { config } from '../config';
import { AuditEventEntity } from '../db/entities';
import { blobShaFor, canonicalJson } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { DirectoryPackSource } from '../content/pack-source';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { readZip, zipLimits, type ArchiveEntry } from '../content/zip-reader';
import { ROOM_STORY, S1_TEACHER, copyTaskTrackr, openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { ALL_SHELF_MARKERS, SHELF_DIR, SHELF_MARKERS } from '../../test/fixtures/upload-packs/markers';
import { HOST_PHASE, hostPack, hostQuizBody } from '../../test/written-phase-pack';
import { storeTaskTypeEdit } from '../../test/stored-task-edit';
import { sealedRunRowPath } from './draft';
import { EXPORT_REFUSALS, ExportService } from './export.service';
import { SealedRoleService } from './sealed-roles';
import { layoutFromManifest } from '../content/legacy-layout';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * A version back to the on-disk layout.
 *
 * This spec instantiates `ExportService` directly over a better-sqlite3
 * :memory: database holding ALL_ENTITIES (`importer.spec.ts`'s
 * fresh-database pattern); there is no HTTP layer, no PG and no port here.
 *
 * The shelf upload fixture (`apps/api/test/fixtures/upload-packs/shelf`) is
 * read, never written.
 */

const TEACHER = { id: 'teacher-exp-a', role: 'INSTRUCTOR' as const, cohort: 'default' };
const OTHER = { id: 'teacher-exp-b', role: 'INSTRUCTOR' as const, cohort: 'default' };
const ADMIN = { id: 'admin-exp', role: 'ADMIN' as const, cohort: 'default' };
const TITLE = 'Shelf for export';

/** Where each shelf-fixture marker's role lives in the exported layout. */
const MARKER_DIRECTORY: Record<keyof typeof SHELF_MARKERS, string> = {
  hidden: 'hidden_tests',
  solution: 'solution',
  reference: 'reference',
  impl: 'impl',
  mutant: 'mutants',
  drill: 'drill',
};

function entriesOf(archive: Buffer): ArchiveEntry[] {
  return readZip(archive, zipLimits(config.importMaxBytes));
}

/** The archive as the upload reads it: the reader, the pack root, the in-memory source. */
function packOf(archive: Buffer, name = 'export'): MemoryPackSource {
  const entries = entriesOf(archive);
  return new MemoryPackSource(entries, name, packRootOf(entries));
}

/** The shelf fixture's bytes in memory, one phase.json edited and entries added (the fixture's folder is never edited). */
function shelfVariant(phaseAt: string, edit: (phase: any) => void, extra: ArchiveEntry[] = []): MemoryPackSource {
  const entries: ArchiveEntry[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const at = rel ? `${rel}/${name}` : name;
      if (fs.statSync(full).isDirectory()) walk(full, at);
      else entries.push({ name: at, bytes: fs.readFileSync(full) });
    }
  };
  walk(SHELF_DIR, '');
  const phase = JSON.parse(entries.find((one) => one.name === phaseAt)!.bytes.toString('utf-8'));
  edit(phase);
  const out = entries.map((one) => (one.name === phaseAt ? { name: one.name, bytes: Buffer.from(JSON.stringify(phase, null, 2)) } : one));
  return new MemoryPackSource([...out, ...extra], 'variant');
}

async function exportedRows(dataSource: DataSource): Promise<AuditEventEntity[]> {
  return dataSource.getRepository(AuditEventEntity).find({ where: { event: 'project.exported' } });
}

/** A teacher's text as the upload door stores it, and so as the export writes it: trimmed, plain, then trimmed again. */
const stored = (text: string): string => plainTextOf(text.trim()).trim();

/** A rubric with its sentences as the door stores them. */
function plainRubric(rubric: { criteria: { title: string; description?: string }[] }): unknown {
  return { ...rubric, criteria: rubric.criteria.map((one) => ({ ...one, title: stored(one.title), ...(typeof one.description === 'string' ? { description: stored(one.description) } : {}) })) };
}

/**
 * A compiled snapshot as the folder layout round-trips it: each phase's
 * mounts in path order, each task's owned paths in path
 * order, and every text a teacher writes trimmed and through `plainTextOf`
 * (`stored`), which the export writes and the upload stores.
 */
function asRoundTripped(compiled: any): any {
  for (const phase of compiled.content.phases) {
    phase.files.sort((a: { path: string }, b: { path: string }) => compareMountPaths(a.path, b.path));
    phase.taskPanel = stored(phase.taskPanel);
    phase.intro = stored(phase.intro);
    phase.objectives = phase.objectives.map(stored);
    phase.rubric = plainRubric(phase.rubric);
    const checks = phase.checks;
    if (checks.kind === 'story') {
      for (const story of checks.providedStories) {
        for (const member of ['title', 'persona', 'capability', 'benefit']) story[member] = stored(story[member]);
        for (const one of story.criteria ?? []) for (const member of ['given', 'when', 'then']) one[member] = stored(one[member]);
      }
      for (const key of Object.keys(checks.learnerStory.hints)) if (typeof checks.learnerStory.hints[key] === 'string') checks.learnerStory.hints[key] = stored(checks.learnerStory.hints[key]);
    }
    if (checks.kind === 'design') for (const story of checks.stories) for (const member of ['title', 'line']) story[member] = stored(story[member]);
    if (checks.kind === 'code' && checks.ticket) {
      checks.ticket.title = stored(checks.ticket.title);
      checks.ticket.summary = stored(checks.ticket.summary);
      for (const one of checks.ticket.acceptance) one.line = stored(one.line);
    }
  }
  for (const phase of compiled.phases) {
    for (const task of phase.tasks) {
      task.owns.sort(compareMountPaths);
      task.title = stored(task.title);
      task.brief = stored(task.brief);
      task.objectives = task.objectives.map(stored);
      task.rubric = plainRubric(task.rubric);
    }
  }
  return compiled;
}

/**
 * A version as the round trip compares it: the compiled snapshot with the
 * project's own names (slug, title) normalised (the slug is minted per
 * project, never read from the archive) and read as the folder layout
 * round-trips it (`asRoundTripped`), the manifest, and every row as
 * (phase, path, role, blobSha, editable).
 */
async function shapeOf(dataSource: DataSource, versionId: string): Promise<{ compiled: unknown; manifest: unknown; rows: string[] }> {
  const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
  const phases = await dataSource.getRepository(ProjectPhaseEntity).find({ where: { projectVersionId: versionId } });
  const keyOf = new Map(phases.map((phase) => [phase.id, phase.key as string]));
  const rows = await dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: versionId } });
  const compiled = JSON.parse(canonicalJson(version.compiled)) as { slug: string; content: { slug: string; title: string } };
  compiled.slug = 'SLUG';
  compiled.content.slug = 'SLUG';
  compiled.content.title = 'TITLE';
  return {
    compiled: asRoundTripped(compiled),
    manifest: JSON.parse(canonicalJson(version.manifest)),
    rows: rows.map((row) => [keyOf.get(row.ownerId) ?? '', row.path, row.role, row.blobSha, row.editable].join(' ')).sort(),
  };
}

describe('ExportService: a version back to the authoring layout', () => {
  let world: ForkWorld;
  let shelf: { projectId: string; versionId: string; slug: string };
  const importer = (): ProjectImporterService => new ProjectImporterService(world.content, world.dataSource);
  const exporter = (): ExportService => new ExportService(world.dataSource, world.content);

  beforeAll(async () => {
    world = await openForkWorld();
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: TITLE });
    shelf = { projectId: made.projectId, versionId: made.versionId, slug: made.slug };
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('› export → readZip → MemoryPackSource → importTeacherDraft round-trips the Shelf pack', async () => {
    const out = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);
    expect(out.withheld).toEqual([]);

    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: TITLE });
    expect(again.report.blocking).toEqual([]);
    expect(await shapeOf(world.dataSource, again.versionId)).toEqual(await shapeOf(world.dataSource, shelf.versionId));
  });

  it('› export is a fixed point: export(import(export(v))) is byte-identical to export(v)', async () => {
    const first = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);
    // the same version exported twice is the same bytes (sorted entries, a fixed stamp)
    expect((await exporter().export(TEACHER, shelf.projectId, shelf.versionId)).archive.equals(first.archive)).toBe(true);

    // a fresh database, so the same title mints the same slug the archive names
    const fresh = await memoryDataSource();
    try {
      const imported = await new ProjectImporterService(new ContentService(), fresh).importTeacherDraft(packOf(first.archive), {
        ownerId: TEACHER.id,
        title: TITLE,
      });
      expect(imported.slug).toBe(shelf.slug);
      const second = await new ExportService(fresh, new ContentService()).export(TEACHER, imported.projectId, imported.versionId);
      expect(second.filename).toBe(first.filename);
      expect(second.sha256).toBe(first.sha256);
      expect(second.archive.equals(first.archive)).toBe(true);
    } finally {
      await fresh.destroy();
    }
  });

  // Pack-digest equality with the shelf fixture's directory is NOT required:
  // the rows keep no byte of a file no phase mounts nor an author's `source`
  // paths, and the JSON is re-serialised.
  // What is required is the semantic round trip (the re-upload loads and
  // compiles to the same task list, run shapes and sealed bytes) which the
  // round trip above, the fixed point and the task-edit case below prove.

  // phase.json's `task` block carries a task's title, brief and objectives,
  // so the retitle exports and comes back, and the 409 is only for what the
  // block cannot carry (what it hands in, below).
  it("› a task retitled in the editor exports in phase.json's task block and re-imports to the same task list; an edit the layout cannot carry is refused by the read-back's drift (409), never silently dropped", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a retitled task' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const design = (await repo.findOneByOrFail({ id: made.versionId })).compiled!.content.phases.find((phase) => phase.key === 'design')!;
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'design', INHERITED_TASK_KEY, { title: 'EXP retitled design task' } as never);
    // and a code task the editor's executable arm holds, retitled too
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'EXP retitled code task' } as never);
    expect(
      (await repo.findOneByOrFail({ id: made.versionId })).compiled!.phases.filter((phase) => phase.tasks.some((task) => task.taskKey === INHERITED_TASK_KEY)).map((phase) => phase.key),
    ).toEqual(expect.arrayContaining(['design', 'implementation']));

    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const phaseJson = (folder: string): Record<string, unknown> =>
      JSON.parse(entriesOf(out.archive).find((entry) => entry.name.endsWith(`/phases/${folder}/phase.json`))!.bytes.toString('utf-8'));
    expect(phaseJson('02-design').task).toEqual({ title: 'EXP retitled design task' });
    expect(phaseJson('03-implementation').task).toEqual({ title: 'EXP retitled code task' });
    for (const folder of ['01-requirements', '04-testing', '05-deployment', '06-maintenance']) expect({ folder, task: phaseJson(folder).task }).toEqual({ folder, task: undefined });

    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf with a retitled task' });
    const tasksOf = async (versionId: string): Promise<unknown> => {
      const compiled = (await repo.findOneByOrFail({ id: versionId })).compiled!;
      return JSON.parse(
        canonicalJson(
          asRoundTripped(JSON.parse(JSON.stringify(compiled))).phases.map((phase: { key: string; tasks: { taskKey: string }[] }) => ({
            key: phase.key,
            tasks: phase.tasks.map((task) => ({ ...task, taskKey: task.taskKey === INHERITED_TASK_KEY ? '' : task.taskKey })),
          })),
        ),
      );
    };
    expect(await tasksOf(again.versionId)).toEqual(await tasksOf(made.versionId));

    // what the task hands in is no member of the layout: the read-back compiles the phase to its own task, so
    // the export is refused by the drift it would carry, naming the phase, and writes no row.
    // A design task hands in only its design, so the edit is made on the host's
    // story phase (`written-phase-pack.ts`, Shelf's Requirements, its taskPanel
    // inline), uploaded as the teacher's own.
    const hosted = await importer().importTeacherDraft(layoutFromManifest(hostPack({ slug: 'exp-hosted' })).source, { ownerId: TEACHER.id, title: 'Story phase with an edited task' });
    const storyTask = async () =>
      (await repo.findOneByOrFail({ id: hosted.versionId })).compiled!.phases.find((phase) => phase.key === HOST_PHASE)!.tasks[0];
    // No editor save moves a story task's type any more, so the edit is the stored one an older editor could leave.
    const handsIn = 'document' as const;
    await storeTaskTypeEdit(world.dataSource, hosted.versionId, HOST_PHASE, handsIn);
    expect((await storyTask()).artefactType).toBe(handsIn);
    const before = (await exportedRows(world.dataSource)).length;
    await expect(exporter().export(TEACHER, hosted.projectId, hosted.versionId)).rejects.toBeInstanceOf(ConflictException);
    await expect(exporter().export(TEACHER, hosted.projectId, hosted.versionId)).rejects.toThrow(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift('Requirements')}.`);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
    // the shelf's Design, whose retitled task exported above, is the design phase the edit could not be made on
    expect(design.checks.kind).toBe('design');
  });

  it("› an untouched version's phase.json holds no task block, and a block the upload would refuse is refused at export by the importer's detail (409), with no row", async () => {
    const plain = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);
    const phaseFiles = entriesOf(plain.archive).filter((entry) => entry.name.endsWith('/phase.json'));
    expect(phaseFiles).toHaveLength(6);
    for (const entry of phaseFiles) expect({ name: entry.name, task: 'task' in JSON.parse(entry.bytes.toString('utf-8')) }).toEqual({ name: entry.name, task: false });

    // a held title past the editor's cap (as no editor save could store): the block the export
    // would write is one the import refuses, so the read-back refuses it by the importer's detail
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a long task title' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: made.versionId })).compiled));
    compiled.phases.find((phase: { key: string }) => phase.key === 'design').tasks[0].title = `FMT-${'T'.repeat(200)}`;
    await repo.update({ id: made.versionId }, { compiled });

    const before = (await exportedRows(world.dataSource)).length;
    const said = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      () => '',
      (error: Error) => `${error.constructor.name}: ${error.message}`,
    );
    expect(said).toBe(`ConflictException: ${EXPORT_REFUSALS.unloadable} phases/02-design's phase.json task block: A title is at most 160 characters, and this one is 204.`);
    expect(said).not.toContain('FMT-TTT');
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it("› a phase whose one task is an authored task of its own is refused by the read-back's drift (409), and writes no row", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with an authored task' });
    // the phase's own story task removed by hand (no door removes it), and a story task of the teacher's key brought back
    const requirements = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: made.versionId, key: 'requirements' });
    await world.dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: requirements.id, taskKey: INHERITED_TASK_KEY });
    await world.service.addTask(TEACHER, made.projectId, made.versionId, 'requirements', ROOM_STORY);
    const tasks = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).compiled!.phases.find(
      (phase) => phase.key === 'requirements',
    )!.tasks;
    expect(tasks.map((task) => task.taskKey)).toEqual([ROOM_STORY.taskKey]);

    const before = (await exportedRows(world.dataSource)).length;
    await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toBeInstanceOf(ConflictException);
    // the layout writes the phase's work task under the key the loader gives a phase's task, so an authored
    // task's own key would come back as the phase's: the drift names the phase
    await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toThrow(`${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift('Requirements')}.`);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it('› another teacher → 404, ADMIN → 403, the platform project → 403, and none writes a row', async () => {
    const before = (await exportedRows(world.dataSource)).length;
    await expect(exporter().export(OTHER, shelf.projectId, shelf.versionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(exporter().export(ADMIN, shelf.projectId, shelf.versionId)).rejects.toBeInstanceOf(ForbiddenException);

    const platform = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ platformOwned: true });
    await expect(exporter().export(TEACHER, platform.id, world.seedVersionId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(exporter().export(ADMIN, platform.id, world.seedVersionId)).rejects.toBeInstanceOf(ForbiddenException);

    // a version of another project, named under the caller's own, is not there
    await expect(exporter().export(TEACHER, shelf.projectId, world.seedVersionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(exporter().export(TEACHER, 'not-a-project', shelf.versionId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(exporter().export(TEACHER, shelf.projectId, 'not-a-version')).rejects.toBeInstanceOf(NotFoundException);

    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it("› an export never includes a file of another project's blobs: a copy's inherited sealed rows are withheld", async () => {
    const fork = await copyTaskTrackr(world, 'exp-copy');
    const out = await exporter().export(S1_TEACHER, fork.projectId, fork.versionId);

    const rows = await world.dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: fork.versionId } });
    const open = new Set(rows.filter((row) => row.role === 'workspace' || row.role === 'warmup').map((row) => row.blobSha));
    const sealed = rows.filter((row) => SEALED_FILE_ROLES.includes(row.role) && !open.has(row.blobSha));
    expect(sealed.length).toBeGreaterThan(0);

    // every inherited sealed row is listed by its view, never by its bytes
    const withheld = new Set(out.withheld.map((view) => view.sha256));
    for (const row of sealed) expect(withheld.has(row.blobSha)).toBe(true);
    for (const view of out.withheld) expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);

    // byte-grep: no inherited sealed blob is anywhere in the archive: no entry
    // is one at any size, and none of 48 bytes or more is inside any byte of it
    const blobs = await world.dataSource
      .getRepository(ContentBlobEntity)
      .find({ where: { sha: In([...new Set(sealed.map((row) => row.blobSha))]) } });
    expect(blobs.length).toBeGreaterThan(0);
    const entries = entriesOf(out.archive);
    const entryShas = new Set(entries.map((entry) => blobShaFor(entry.bytes.toString('utf-8'))));
    for (const blob of blobs) expect(entryShas.has(blob.sha)).toBe(false);
    for (const blob of blobs.filter((one) => one.size >= 48)) {
      expect(out.archive.includes(Buffer.from(blob.bytes, 'utf-8'))).toBe(false);
    }
    // and no withheld path is an entry
    const root = packRootOf(entries);
    const names = new Set(entries.map((entry) => entry.name));
    for (const view of out.withheld) expect(names.has(`${root}/${view.path}`)).toBe(false);

    // byte-identical blobs in a project the caller made are theirs: another
    // teacher's own upload of the same pack exports whole
    const theirs = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: OTHER.id, title: 'Shelf of their own' });
    const own = await exporter().export(OTHER, theirs.projectId, theirs.versionId);
    expect(own.withheld).toEqual([]);
    for (const marker of ALL_SHELF_MARKERS) expect(own.archive.includes(Buffer.from(marker))).toBe(true);
  });

  it("› a copy's mutant the owner added a file to goes whole or not at all: withheld, files and meta", async () => {
    const fork = await copyTaskTrackr(world, 'exp-mixed');
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId });
    const testing = version.compiled!.content.phases.find((phase) => phase.key === 'testing')!;
    const checks = testing.checks as { runs: { id: string; implFiles: Record<string, string> }[]; mutants: { name: string; run: string; files: Record<string, string> }[] };
    const mutant = checks.mutants[0];
    const other = Object.keys(checks.runs.find((run) => run.id === mutant.run)!.implFiles).find((at) => !(at in mutant.files))!;
    expect(other).toBeDefined();
    const written = `# EXP-OWNER-MUTANT-3K\n${'x = 1\n'.repeat(4)}`;
    await new SealedRoleService(world.dataSource, importer()).write(
      S1_TEACHER, fork.projectId, fork.versionId, 'testing', INHERITED_TASK_KEY, 'mutant', `${mutant.name}/${other}`, written,
    );

    const out = await exporter().export(S1_TEACHER, fork.projectId, fork.versionId);
    const entries = entriesOf(out.archive);
    expect(entries.filter((entry) => entry.name.includes(`/phases/04-testing/mutants/${mutant.name}/`))).toEqual([]);
    expect(out.archive.includes(Buffer.from('EXP-OWNER-MUTANT-3K'))).toBe(false);
    const paths = out.withheld.map((view) => view.path);
    expect(paths).toContain(`phases/04-testing/mutants/${mutant.name}/${other}`);
    for (const at of Object.keys(mutant.files)) expect(paths).toContain(`phases/04-testing/mutants/${mutant.name}/${at}`);
  });

  it('› sealed files the owner wrote are included, and every marker appears only under its sealed path', async () => {
    const out = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);
    const entries = entriesOf(out.archive);
    for (const [role, marker] of Object.entries(SHELF_MARKERS) as [keyof typeof SHELF_MARKERS, string][]) {
      const holders = entries.filter((entry) => entry.bytes.includes(Buffer.from(marker))).map((entry) => entry.name);
      expect(holders.length).toBeGreaterThan(0);
      for (const name of holders) {
        expect(name).toMatch(new RegExp(`^[^/]+/phases/[0-9]{2}-[a-z]+/${MARKER_DIRECTORY[role]}/`));
      }
    }
  });

  it('› a sealed file the owner wrote through the sealed-role door after the last compile is in the archive, where the compile puts it', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a new hidden test' });
    const written = 'import unittest\n\nclass ExtraHidden(unittest.TestCase):\n    def test_marker(self):\n        self.assertTrue("EXP-OWNER-SEALED-7Q")\n';
    await new SealedRoleService(world.dataSource, importer()).write(
      TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, 'hidden', 'tests/test_extra_hidden.py', written,
    );
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const holders = entriesOf(out.archive).filter((entry) => entry.bytes.toString('utf-8') === written).map((entry) => entry.name);
    expect(holders).toEqual([`${made.slug}/phases/03-implementation/hidden_tests/api/tests/test_extra_hidden.py`]);
    expect(out.withheld).toEqual([]);
    // and the run that grades it collects it on the way back in
    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf with a new hidden test' });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId });
    const implementation = version.compiled!.content.phases.find((phase) => phase.key === 'implementation')!;
    const api = (implementation.checks as { runs: { id: string; hiddenTestFiles: Record<string, string> }[] }).runs.find((run) => run.id === 'api')!;
    expect(api.hiddenTestFiles['tests/test_extra_hidden.py']).toBe(written);
  });

  /**
   * The shelf fixture with a second
   * python run in Maintenance (`api-more`, an in-memory variant), whose
   * own bytes at `tests/test_hidden_order.py` (a path run `api` holds too)
   * are written through the sealed-role door with `runId: 'api-more'`, so they live in a
   * run-keyed row (`sealedRunRowPath`). Each run exports its own bytes, and a
   * copy withholds each inherited file by its own run's digest and size.
   */
  describe('two python runs holding one hidden path', () => {
    const AT = 'tests/test_hidden_order.py';
    const RUN_TWO = `"""EXP2-RUN-TWO-4QX"""\nimport unittest\n\n\nclass RunTwo(unittest.TestCase):\n    def test_run_two(self):\n        self.assertTrue("run two")\n`;
    const MORE = 'import unittest\n\n\nclass More(unittest.TestCase):\n    def test_more(self):\n        self.assertTrue(True)\n';

    /**
     * The shelf fixture's bytes with a second python run in Maintenance, in
     * memory: the run declared in phase.json, its visible test mounted locked
     * under readonly/, its hidden suite under hidden_tests/api-more/.
     */
    function twoRunShelf(): MemoryPackSource {
      return shelfVariant(
        'phases/06-maintenance/phase.json',
        (phase) => {
          phase.checks.runs.push({
            id: 'api-more', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'More API tests',
            visibleTests: ['tests/test_shelf_order_more.py'], supportFiles: ['tests/conftest.py'],
          });
        },
        [
          { name: 'phases/06-maintenance/readonly/tests/test_shelf_order_more.py', bytes: Buffer.from('def test_more_visible():\n    assert True\n') },
          { name: 'phases/06-maintenance/hidden_tests/api-more/tests/test_hidden_more.py', bytes: Buffer.from(MORE) },
        ],
      );
    }
    const hiddenOf = async (versionId: string): Promise<Record<string, Record<string, string>>> => {
      const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
      const maintenance = version.compiled!.content.phases.find((phase) => phase.key === 'maintenance')!;
      return Object.fromEntries((maintenance.checks as { runs: { id: string; hiddenTestFiles: Record<string, string> }[] }).runs.map((run) => [run.id, run.hiddenTestFiles]));
    };
    const bytesAt = (archive: Buffer, name: string): string | undefined =>
      entriesOf(archive).find((entry) => entry.name.endsWith(`/${name}`))?.bytes.toString('utf-8');

    it("› the owner's own draft: each run exports its own bytes, and the re-upload grades each run by them", async () => {
      const made = await importer().importTeacherDraft(twoRunShelf(), { ownerId: TEACHER.id, title: 'Shelf two runs for export' });
      const original = (await hiddenOf(made.versionId)).api[AT];
      expect(original).toBeDefined();
      await new SealedRoleService(world.dataSource, importer()).write(
        TEACHER, made.projectId, made.versionId, 'maintenance', INHERITED_TASK_KEY, 'hidden', AT, RUN_TWO, 'api-more',
      );
      const out = await exporter().export(TEACHER, made.projectId, made.versionId);
      expect(out.withheld).toEqual([]);
      expect(bytesAt(out.archive, `phases/06-maintenance/hidden_tests/api/${AT}`)).toBe(original);
      expect(bytesAt(out.archive, `phases/06-maintenance/hidden_tests/api-more/${AT}`)).toBe(RUN_TWO);
      const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf two runs for export' });
      const back = await hiddenOf(again.versionId);
      expect(back.api[AT]).toBe(original);
      expect(back['api-more'][AT]).toBe(RUN_TWO);
    });

    it("› a copy: the copier's run-two row is exported, and each inherited file is withheld by its own run's sha and size", async () => {
      const theirs = await importer().importTeacherDraft(twoRunShelf(), { ownerId: OTHER.id, title: 'Shelf two runs of theirs' });
      // published by the row (deep validation has its own spec), so it can be copied
      await world.dataSource.getRepository(ProjectVersionEntity).update({ id: theirs.versionId }, { status: 'published' });
      const original = (await hiddenOf(theirs.versionId)).api[AT];
      const copy = await world.service.createProject(ADMIN, { title: 'Copy of two runs', slug: 'exp2-two-runs-copy', fromVersionId: theirs.versionId });
      const copied = { projectId: copy.project.id, versionId: copy.draftVersionId };
      await new SealedRoleService(world.dataSource, importer()).write(
        ADMIN, copied.projectId, copied.versionId, 'maintenance', INHERITED_TASK_KEY, 'hidden', AT, RUN_TWO, 'api-more',
      );

      const out = await exporter().export(ADMIN, copied.projectId, copied.versionId);
      // the copier's own bytes are theirs to export
      expect(bytesAt(out.archive, `phases/06-maintenance/hidden_tests/api-more/${AT}`)).toBe(RUN_TWO);
      // the inherited files are not, each listed by its own run's digest and size
      const byPath = new Map(out.withheld.map((view) => [view.path, view]));
      expect(byPath.get(`phases/06-maintenance/hidden_tests/api/${AT}`)).toEqual({
        path: `phases/06-maintenance/hidden_tests/api/${AT}`,
        sha256: blobShaFor(original),
        bytes: Buffer.byteLength(original, 'utf-8'),
      });
      expect(byPath.get('phases/06-maintenance/hidden_tests/api-more/tests/test_hidden_more.py')).toEqual({
        path: 'phases/06-maintenance/hidden_tests/api-more/tests/test_hidden_more.py',
        sha256: blobShaFor(MORE),
        bytes: Buffer.byteLength(MORE, 'utf-8'),
      });
      expect(byPath.has(`phases/06-maintenance/hidden_tests/api-more/${AT}`)).toBe(false);
      expect(out.archive.includes(Buffer.from(original))).toBe(false);
    });

    it("› a testing phase whose run holds its own copy of an implementation file is refused by sentence (409), never exported with the phase's copy", async () => {
      // The sealed-role door keeps a tests task's runs on one copy of each file;
      // this guards a version whose rows say otherwise: run `api`'s own row
      // (a run-keyed path) holding other bytes at a path the phase holds once.
      const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a run of its own' });
      const files = world.dataSource.getRepository(ProjectFileEntity);
      const plain = await files.findOneByOrFail({ projectVersionId: made.versionId, path: 'reference/api/main.py' });
      const own = '# EXP2-RUN-OWN-MAIN-8L\nprint("its own")\n';
      await world.dataSource.getRepository(ContentBlobEntity).save({ sha: blobShaFor(own), bytes: own, size: Buffer.byteLength(own, 'utf-8') });
      const { id: _id, ...row } = plain;
      await files.save({ ...row, path: sealedRunRowPath('reference/api/main.py', 'api'), blobSha: blobShaFor(own) });

      const before = (await exportedRows(world.dataSource)).length;
      await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toBeInstanceOf(ConflictException);
      await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toThrow(/run "api" holds its own copy of "api\/main\.py"/);
      expect((await exportedRows(world.dataSource)).length).toBe(before);
    });
  });

  it('› a new reference test the owner wrote to a tests phase exports, and loads back into the suite', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a new reference test' });
    const written = 'from tests.conftest import *  # noqa\n\ndef test_more_reference():\n    assert "EXP-OWNER-REFERENCE-5V"\n';
    await new SealedRoleService(world.dataSource, importer()).write(
      TEACHER, made.projectId, made.versionId, 'testing', INHERITED_TASK_KEY, 'hidden', 'tests/test_more_reference.py', written,
    );
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    expect(out.withheld).toEqual([]);
    const holders = entriesOf(out.archive).filter((entry) => entry.bytes.toString('utf-8') === written).map((entry) => entry.name);
    expect(holders).toEqual([`${made.slug}/phases/04-testing/reference/tests/test_more_reference.py`]);
    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf with a new reference test' });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId });
    const testing = version.compiled!.content.phases.find((phase) => phase.key === 'testing')!;
    expect((testing.checks as { referenceTestFiles: Record<string, string> }).referenceTestFiles['tests/test_more_reference.py']).toBe(written);
  });

  it('› a draft the upload would refuse is refused at export by its sentence (409), and writes no row', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a secret' });
    // a locked file with a secret-shaped name, as a draft could come to hold
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const version = await repo.findOneByOrFail({ id: made.versionId });
    const compiled = JSON.parse(JSON.stringify(version.compiled));
    compiled.content.phases[0].files.push({ path: 'requirements/config.env', content: 'SHELF_MODE=demo\n', editable: false, language: 'plaintext' });
    await repo.update({ id: made.versionId }, { compiled });

    const before = (await exportedRows(world.dataSource)).length;
    await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toBeInstanceOf(ConflictException);
    await expect(exporter().export(TEACHER, made.projectId, made.versionId)).rejects.toThrow(/looks like a secret/);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it("› an export that withholds files still asks the upload's checks that need no whole archive, and refuses by sentence (409)", async () => {
    const fork = await copyTaskTrackr(world, 'exp2-withheld-secret');
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: fork.versionId })).compiled));
    compiled.content.phases[0].files.push({ path: 'requirements/config.env', content: 'MODE=demo\n', editable: false, language: 'plaintext' });
    await repo.update({ id: fork.versionId }, { compiled });

    const before = (await exportedRows(world.dataSource)).length;
    await expect(exporter().export(S1_TEACHER, fork.projectId, fork.versionId)).rejects.toBeInstanceOf(ConflictException);
    await expect(exporter().export(S1_TEACHER, fork.projectId, fork.versionId)).rejects.toThrow(/looks like a secret/);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it('› the warm-up is never exported (an upload never carries one), so no warmup/ folder and no warmup key', async () => {
    const fork = await copyTaskTrackr(world, 'exp2-no-warmup');
    expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: fork.versionId })).compiled!.content.warmup).toBeTruthy();
    const out = await exporter().export(S1_TEACHER, fork.projectId, fork.versionId);
    const entries = entriesOf(out.archive);
    const root = packRootOf(entries);
    expect(entries.filter((entry) => entry.name.startsWith(`${root}/warmup/`))).toEqual([]);
    const meta = JSON.parse(entries.find((entry) => entry.name === `${root}/project.json`)!.bytes.toString('utf-8'));
    expect('warmup' in meta).toBe(false);
  });

  it(`› a refusal's findings are capped at UPLOAD_REFUSAL_DETAIL_MAX (${UPLOAD_REFUSAL_DETAIL_MAX}) characters, the first findings and "And N more"`, async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with many secrets' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: made.versionId })).compiled));
    for (let at = 0; at < 12; at += 1) {
      compiled.content.phases[0].files.push({ path: `requirements/settings-${at}.env`, content: `MODE_${at}=demo\n`, editable: false, language: 'plaintext' });
    }
    await repo.update({ id: made.versionId }, { compiled });

    const said = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(said.startsWith(EXPORT_REFUSALS.unloadable)).toBe(true);
    const detail = said.slice(EXPORT_REFUSALS.unloadable.length + 1);
    expect(detail.length).toBeLessThanOrEqual(UPLOAD_REFUSAL_DETAIL_MAX);
    expect(detail).toMatch(/looks like a secret/);
    expect(detail).toMatch(/And \d+ more\.$/);
  });

  it("› a loader refusal is said in the upload's own words (loaderSentence), without the read-back's source label", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with an unreadable intro' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: made.versionId })).compiled));
    compiled.content.phases.find((phase: { key: string }) => phase.key === 'design').intro = '';
    await repo.update({ id: made.versionId }, { compiled });

    const said = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(said.startsWith(EXPORT_REFUSALS.unloadable)).toBe(true);
    expect(said).toMatch(/intro/);
    expect(said).not.toMatch(/(^|[\s(])(upload:)?export\//);
    expect(said.length).toBeLessThanOrEqual(EXPORT_REFUSALS.unloadable.length + 1 + UPLOAD_REFUSAL_DETAIL_MAX);
  });

  it("› a version with a preview exports its scripts where the previewing phase mounts them (no canonical/), and the upload reads it back", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a preview' });
    // the preview block a draft can hold (the editor's manifest), set on the snapshot the export reads
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const version = await repo.findOneByOrFail({ id: made.versionId });
    const compiled = JSON.parse(JSON.stringify(version.compiled));
    // The read-back asks the upload door's post-loader argv rule
    // (`checkPackRuns(rawPackManifestOf(loaded))`: a shipped script is mounted locked and never
    // editable), so a preview run from api/shelf.py, which 03 and 06 mount editable, is a 409
    // (the ARGV_SCRIPT case below), and this one runs a script no
    // phase mounts editable: api/serve.py, locked in 03 (the implementation phase ships it, as a preview needs) and 04 with
    // different bytes. The folder layout writes each phase's own copy under its readonly/ folder, and the
    // preview runs the mounts every previewing phase holds, so no canonical/ copy is needed.
    // Held here, so a change that made the locked copies equal fails this precondition.
    type Mounted = { key: string; files: { path: string; content: string; editable: boolean; language?: string }[] };
    const phases = compiled.content.phases as Mounted[];
    expect(phases.flatMap((phase) => phase.files).some((file) => file.path === 'api/serve.py')).toBe(false);
    phases.find((phase) => phase.key === 'implementation')!.files.push({ path: 'api/serve.py', content: 'print("serve, implementation copy")\n', editable: false, language: 'python' });
    phases.find((phase) => phase.key === 'testing')!.files.push({ path: 'api/serve.py', content: 'print("serve, testing copy")\n', editable: false, language: 'python' });
    const lockedCopies = phases.flatMap((phase) => phase.files.filter((file) => file.path === 'api/serve.py' && !file.editable).map((file) => file.content));
    expect(lockedCopies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lockedCopies).size).toBe(lockedCopies.length);
    expect(phases.flatMap((phase) => phase.files).filter((file) => file.path === 'api/serve.py' && file.editable)).toEqual([]);
    compiled.content.preview = { service: { command: ['python3', 'api/serve.py'], portEnv: 'SHELF_PORT', health: '/api/health' }, web: { root: 'web', html: 'web/index.html' }, env: {} };
    compiled.content.phases.find((phase: { key: string }) => phase.key === 'implementation').canPreview = true;
    await repo.update({ id: made.versionId }, { compiled });

    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const names = entriesOf(out.archive).map((entry) => entry.name);
    expect(names).toContain(`${made.slug}/phases/03-implementation/readonly/api/serve.py`);
    expect(names.filter((name) => name.startsWith(`${made.slug}/canonical/`))).toEqual([]);
    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf with a preview' });
    const back = await repo.findOneByOrFail({ id: again.versionId });
    expect(back.compiled!.content.preview?.service.command).toEqual(['python3', 'api/serve.py']);
  });

  it('› the archive re-reads under zipLimits(importMaxBytes) with no refusal, and a version over the cap is refused by sentence', async () => {
    const out = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);
    expect(() => entriesOf(out.archive)).not.toThrow();
    expect(entriesOf(out.archive)).toHaveLength(out.entries);
    expect(out.archive.length).toBeLessThanOrEqual(config.importMaxBytes);
    expect(out.sha256).toBe(createHash('sha256').update(out.archive).digest('hex'));
    expect(out.filename).toBe(`${shelf.slug}-${DRAFT_FIRST_VERSION}.zip`);

    const before = (await exportedRows(world.dataSource)).length;
    const small = new ExportService(world.dataSource, world.content, 4096);
    await expect(small.export(TEACHER, shelf.projectId, shelf.versionId)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(small.export(TEACHER, shelf.projectId, shelf.versionId)).rejects.toThrow(/an upload accepts/);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });

  it('› a concept quiz beside a phase\'s work task travels as quizzes/<task key>.json, so a phase holding a quiz and a work task is exported', async () => {
    // a concept quiz beside the copy's story task: the folder layout holds it as a file of its own
    const fork = await copyTaskTrackr(world, 'exp-two-tasks');
    await world.service.addTask(S1_TEACHER, fork.projectId, fork.versionId, 'requirements', hostQuizBody('concepts'));
    const before = (await exportedRows(world.dataSource)).length;
    const out = await exporter().export(S1_TEACHER, fork.projectId, fork.versionId);
    const root = packRootOf(entriesOf(out.archive));
    const quiz = JSON.parse(entriesOf(out.archive).find((entry) => entry.name === `${root}/phases/01-requirements/quizzes/concepts.json`)!.bytes.toString('utf-8'));
    expect(quiz).toMatchObject({ title: 'Concept check: concepts', order: 2, required: true });
    expect((await exportedRows(world.dataSource)).length).toBe(before + 1);
    expect('tasks' in EXPORT_REFUSALS).toBe(false);
  });

  it('› exactly one project.exported row, holding no sealed bytes or digest, and no other write', async () => {
    const counts = async (): Promise<number[]> =>
      Promise.all([ProjectEntity, ProjectVersionEntity, ProjectFileEntity, ContentBlobEntity].map((entity) => world.dataSource.getRepository(entity).count()));
    const before = await exportedRows(world.dataSource);
    const held = await counts();

    const out = await exporter().export(TEACHER, shelf.projectId, shelf.versionId);

    const after = await exportedRows(world.dataSource);
    expect(after).toHaveLength(before.length + 1);
    expect(await counts()).toEqual(held);
    const row = after.find((one) => !before.some((earlier) => earlier.id === one.id)) as AuditEventEntity;
    expect(row.actorUserId).toBe(TEACHER.id);
    expect(row.targetId).toBe(shelf.projectId);
    expect(row.detail).toMatchObject({ versionId: shelf.versionId, entries: out.entries });

    const said = JSON.stringify(row);
    for (const marker of ALL_SHELF_MARKERS) expect(said).not.toContain(marker);
    const sealed = await world.dataSource
      .getRepository(ProjectFileEntity)
      .find({ where: { projectVersionId: shelf.versionId, role: In(SEALED_FILE_ROLES) } });
    expect(sealed.length).toBeGreaterThan(0);
    for (const one of sealed) expect(said).not.toContain(one.blobSha);
    expect(said).not.toContain(out.sha256);
  });
  // A draft whose last edit failed validation may be exported: export is a read
  // of the draft. A failed compile leaves the stored task list at the last one
  // that compiled, so the draft's own task rows are what the archive must say:
  // an edit the archive carries is in it, and one it cannot is refused by name.
  it("› a draft whose last edit failed validation is the draft: a retitle made while it fails is carried, and the edit that failed (a task made optional) is refused by the read-back's drift, naming the phase (409), never dropped in silence", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf that fails validation' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const design = (await repo.findOneByOrFail({ id: made.versionId })).compiled!.content.phases.find((phase) => phase.key === 'design')!;
    // the door stores it; fast validation reports the defect and the compile row fails
    await world.service.setTaskRequired(TEACHER, made.projectId, made.versionId, 'design', INHERITED_TASK_KEY, { required: false } as never);
    // the latest edit, stored while the draft still fails
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'EXP3 retitled while failing' } as never);
    const stored = (await repo.findOneByOrFail({ id: made.versionId })) as ProjectVersionEntity & { validation: { report: { checks: { id: string; status: string }[]; blocking: string[] } } };
    expect(stored.validation.report.checks.find((check) => check.id === 'version-compiles')?.status).toBe('failed');
    expect(stored.validation.report.blocking.some((line) => line.startsWith('Design has no required task'))).toBe(true);
    // the stored task list is the last one that compiled: neither edit is in it
    expect(stored.compiled!.phases.find((phase) => phase.key === 'design')!.tasks.map((task) => task.required)).toEqual([true]);
    expect(stored.compiled!.phases.find((phase) => phase.key === 'implementation')!.tasks.map((task) => task.title)).toEqual(['Implementation']);

    const before = (await exportedRows(world.dataSource)).length;
    const said = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      (out) => `200 ${out.entries}`,
      (error: Error) => `${error.constructor.name}: ${error.message}`,
    );
    expect(said).toBe(`ConflictException: ${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift(design.title)}.`);
    expect((await exportedRows(world.dataSource)).length).toBe(before);

    // the edit that failed undone (the compile moves again): the retitle is carried, and comes back
    await world.service.setTaskRequired(TEACHER, made.projectId, made.versionId, 'design', INHERITED_TASK_KEY, { required: true } as never);
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const implementation = JSON.parse(entriesOf(out.archive).find((entry) => entry.name.endsWith('/phases/03-implementation/phase.json'))!.bytes.toString('utf-8'));
    expect(implementation.task).toEqual({ title: 'EXP3 retitled while failing' });
  });

  // With the compile row failed, the archive is written from the
  // draft's task rows, not the stale list: a carried edit is in the block, and the
  // read-back holds the archive to the rows' task list.
  it('› with the compile failed and every stored edit one the archive carries, the export answers the rows (a stale title is never exported)', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a stale compile' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    // a retitle through the door (compiles), then the stored report says the
    // compile failed and the stored task list is put back to the one before it:
    // the state a failed compile leaves, with only a carried edit in the rows
    const clean = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: made.versionId })).compiled));
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'EXP3 title the rows hold' } as never);
    const version = await repo.findOneByOrFail({ id: made.versionId });
    const validation = JSON.parse(JSON.stringify(version.validation)) as { report: { checks: { id: string; status: string }[] } };
    validation.report.checks.find((check) => check.id === 'version-compiles')!.status = 'failed';
    await repo.update({ id: made.versionId }, { compiled: { ...version.compiled!, phases: clean.phases }, validation: validation as never });
    expect((await repo.findOneByOrFail({ id: made.versionId })).compiled!.phases.find((phase) => phase.key === 'implementation')!.tasks[0].title).toBe('Implementation');

    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const implementation = JSON.parse(entriesOf(out.archive).find((entry) => entry.name.endsWith('/phases/03-implementation/phase.json'))!.bytes.toString('utf-8'));
    expect(implementation.task).toEqual({ title: 'EXP3 title the rows hold' });
    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf with a stale compile again' });
    expect((await repo.findOneByOrFail({ id: again.versionId })).compiled!.phases.find((phase) => phase.key === 'implementation')!.tasks[0].title).toBe('EXP3 title the rows hold');
  });

  // A phase whose rows hold no task compiles to the
  // phase's own sole task (`compilePack`: no authored list -> `soleTaskFor`),
  // which is exactly what the layout writes, so it is exported as that task,
  // never refused and never as the stale list's older task.
  it('› with the compile failed and a phase holding no task row, the archive writes the task that phase compiles to (no block), and it comes back as that task', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with no task row' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    // a retitle through the door (it compiles, so the stored list holds it),
    // then the rows lose the phase's task and the stored compile row fails
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'EXP3 stale title' } as never);
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: made.versionId, key: 'implementation' });
    await world.dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id });
    const version = await repo.findOneByOrFail({ id: made.versionId });
    const validation = JSON.parse(JSON.stringify(version.validation)) as { report: { checks: { id: string; status: string }[] } };
    validation.report.checks.find((check) => check.id === 'version-compiles')!.status = 'failed';
    await repo.update({ id: made.versionId }, { validation: validation as never });
    expect(version.compiled!.phases.find((one) => one.key === 'implementation')!.tasks[0].title).toBe('EXP3 stale title');

    const out = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      (one) => one,
      (error: Error) => `${error.constructor.name}: ${error.message}`,
    );
    expect(typeof out === 'string' ? out : 'an archive').toBe('an archive');
    const archive = (out as { archive: Buffer }).archive;
    const implementation = JSON.parse(entriesOf(archive).find((entry) => entry.name.endsWith('/phases/03-implementation/phase.json'))!.bytes.toString('utf-8'));
    expect('task' in implementation).toBe(false);
    const again = await importer().importTeacherDraft(packOf(archive), { ownerId: TEACHER.id, title: 'Shelf with no task row again' });
    expect((await repo.findOneByOrFail({ id: again.versionId })).compiled!.phases.find((one) => one.key === 'implementation')!.tasks.map((task) => task.title)).toEqual(['Implementation']);
    expect('noTask' in EXPORT_REFUSALS).toBe(false);
  });

  // The read-back asks the upload door's post-loader
  // run-shape rule too (`checkPackRuns(rawPackManifestOf(loaded))`: a shipped
  // script is a file some phase mounts locked and no phase mounts editable),
  // so an archive the upload refuses with ARGV_SCRIPT is never exported.
  it("› a preview whose script a phase mounts editable is refused at export by the upload's own argv rule (409), and writes no row", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with an editable preview' });
    const repo = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = JSON.parse(JSON.stringify((await repo.findOneByOrFail({ id: made.versionId })).compiled));
    type Mounted = { key: string; files: { path: string; editable: boolean }[] };
    expect((compiled.content.phases as Mounted[]).some((one) => one.files.some((file) => file.path === 'api/shelf.py' && file.editable))).toBe(true);
    compiled.content.preview = { service: { command: ['python3', 'api/shelf.py'], portEnv: 'SHELF_PORT', health: '/api/health' }, web: { root: 'web', html: 'web/index.html' }, env: {} };
    compiled.content.phases.find((one: { key: string }) => one.key === 'implementation').canPreview = true;
    await repo.update({ id: made.versionId }, { compiled });

    const before = (await exportedRows(world.dataSource)).length;
    const said = await exporter().export(TEACHER, made.projectId, made.versionId).then(
      () => '200',
      (error: Error) => `${error.constructor.name}: ${error.message}`,
    );
    expect(said.startsWith(`ConflictException: ${EXPORT_REFUSALS.unloadable} `)).toBe(true);
    expect(said).toMatch(/project\.preview\.service\.command does not run a \.py file this pack ships/);
    expect((await exportedRows(world.dataSource)).length).toBe(before);
  });
});

/* ======================================================================== *
 * phase.json's task block carries the                                      *
 * sign-off mark, so a marked task exports and comes back marked.           *
 * ======================================================================== */
describe('ExportService: the sign-off mark rides the task block', () => {
  let world: ForkWorld;
  const importer = (): ProjectImporterService => new ProjectImporterService(world.content, world.dataSource);
  const exporter = (): ExportService => new ExportService(world.dataSource, world.content);
  const phaseJsonOf = (archive: Buffer, folder: string): Record<string, unknown> =>
    JSON.parse(entriesOf(archive).find((entry) => entry.name.endsWith(`/phases/${folder}/phase.json`))!.bytes.toString('utf-8'));

  beforeAll(async () => {
    world = await openForkWorld();
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it("› a sole task marked for sign-off exports 200 with phase.json carrying \"task\":{\"signOff\":true}, and re-imports marked", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf marked for sign-off' });
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'requirements', INHERITED_TASK_KEY, { signOff: true } as never);
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    expect(phaseJsonOf(out.archive, '01-requirements').task).toEqual({ signOff: true });
    for (const folder of ['02-design', '03-implementation', '04-testing', '05-deployment', '06-maintenance']) {
      expect({ folder, task: phaseJsonOf(out.archive, folder).task }).toEqual({ folder, task: undefined });
    }
    expect(entriesOf(out.archive).find((entry) => entry.name.endsWith('/phases/01-requirements/phase.json'))!.bytes.toString('utf-8')).toContain('"task": {\n    "signOff": true\n  }');
    const again = await importer().importTeacherDraft(packOf(out.archive), { ownerId: TEACHER.id, title: 'Shelf marked again' });
    const compiled = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId })).compiled!;
    expect(compiled.phases.map((phase) => [phase.key, phase.tasks[0].signOff])).toEqual([
      ['requirements', true], ['design', false], ['implementation', false], ['testing', false], ['deployment', false], ['maintenance', false],
    ]);
  });

  it('› a title and the mark ride one block, in the order the block writes them', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf marked and retitled' });
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'Shelve the books', signOff: true } as never);
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    expect(Object.entries(phaseJsonOf(out.archive, '03-implementation').task as object)).toEqual([['title', 'Shelve the books'], ['signOff', true]]);
  });

  it("› the block carries a title and the mark only: a task's brief and objectives are the phase's own taskPanel and objectives, written plain", async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf with a rewritten brief' });
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { brief: 'Shelve the books by **author**.', objectives: ['Order by author'] } as never);
    const out = await exporter().export(TEACHER, made.projectId, made.versionId);
    const implementation = phaseJsonOf(out.archive, '03-implementation');
    expect(implementation.task).toBeUndefined();
    expect(implementation.taskPanel).toBe('Shelve the books by author.');
    expect(implementation.objectives).toEqual(['Order by author']);
    expect('taskEdited' in EXPORT_REFUSALS).toBe(false);
  });

  it('GUARD › an unmarked version exports byte-identical to an export without the mark (no block, the same bytes twice), and a mark taken off again exports as untouched', async () => {
    const plain = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf never marked' });
    const first = await exporter().export(TEACHER, plain.projectId, plain.versionId);
    for (const entry of entriesOf(first.archive).filter((one) => one.name.endsWith('/phase.json'))) {
      expect({ name: entry.name, task: 'task' in JSON.parse(entry.bytes.toString('utf-8')) }).toEqual({ name: entry.name, task: false });
    }
    const toggled = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: 'Shelf marked then unmarked' });
    await world.service.updateTask(TEACHER, toggled.projectId, toggled.versionId, 'design', INHERITED_TASK_KEY, { signOff: true } as never);
    await world.service.updateTask(TEACHER, toggled.projectId, toggled.versionId, 'design', INHERITED_TASK_KEY, { signOff: false } as never);
    const back = await exporter().export(TEACHER, toggled.projectId, toggled.versionId);
    expect(phaseJsonOf(back.archive, '02-design').task).toBeUndefined();
  });
});

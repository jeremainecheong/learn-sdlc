// The harness is design-task.spec.ts's (a TaskTrackr imported into an in-memory database, a teacher's copy),
// with its `phaseRow` and `insertRow` helpers keyed by phase. The pack imported is `recordPack()` (TaskTrackr with
// its Deployment and Maintenance in the record shape, as record-task.spec.ts imports it), so the copy's rows carry
// the records and `writeOlder` has a record row to take out. The older Deployment and Maintenance are written by
// hand onto the copy's rows from the frozen fixtures, never taken from a fresh copy: a fresh copy is converted
// at copy and TaskTrackr is 5.0.0 or later, so it is never older (as `design-task.spec.ts` does for Design).
import 'reflect-metadata';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, sortedMounts, type PhaseKey } from '@learnsdlc/shared';
import { blobShaFor } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import type { CodeChecks, ConfigChecks } from '../content/content.types';
import { ProjectImporterService } from '../content/importer.service';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ContentBlobEntity, ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { applicationDigest } from '../content/reference-content';
import { olderTaskTrackrPack as olderPointerPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { recordPack } from '../../test/record-pack';
import { AuthoringService } from './authoring.service';
import { TASKTRACKR_400_MAINTENANCE, convertLegacyChangeRows } from './legacy-change';
import { TASKTRACKR_400_DEPLOYMENT, convertLegacyRunbookRows } from './legacy-runbook';
import { compilePack, isQuizTask } from '../content/pack-compiler';
import { executableDigestKey } from './provenance';
import { referenceMissingNote } from './legacy-rows';
import { ExportService } from './export.service';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { readZip, zipLimits } from '../content/zip-reader';
import { config } from '../config';
import { memoryDataSource } from '../../test/support/memory-db';

const caller = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };

/**
 * TaskTrackr 4.0.0 as the frozen fixtures hold it, in the older, pointer layout, converted once as the
 * upload door converts an older archive: the loader reads only the folder layout.
 */
const olderTaskTrackrPack = (edit?: (name: string, text: string) => string) => layoutFromManifest(olderPointerPack(edit)).source;

const BESIDE = {
  deployment: 'A second work task sits beside the older Deployment task, and a Deployment phase with a runbook holds one.',
  maintenance: 'A second work task sits beside the older Maintenance task, and a Maintenance phase with a change request holds one.',
} as const;

const FIXTURES = path.join(__dirname, '../../test/fixtures');
const OLDER = {
  deployment: { dir: path.join(FIXTURES, 'legacy-deployment'), markdown: 'RUNBOOK.md', record: RUNBOOK_JSON },
  maintenance: { dir: path.join(FIXTURES, 'legacy-maintenance'), markdown: 'CHANGELOG.md', record: CHANGE_REQUEST_JSON },
} as const;
type OlderKey = keyof typeof OLDER;
const specOf = (key: OlderKey) => JSON.parse(readFileSync(path.join(OLDER[key].dir, 'phase.json'), 'utf8'));

let dataSource: DataSource;
let service: AuthoringService;
let importer: ProjectImporterService;
let importedVersionId = '';

const phaseRow = (vid: string, key: PhaseKey) =>
  dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: vid, key });
const insertRow = async (vid: string, phaseId: string, at: string, bytes: string, editable: boolean) => {
  const sha = blobShaFor(bytes);
  await dataSource.createQueryBuilder().insert().into(ContentBlobEntity)
    .values({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') }).orIgnore().execute();
  await dataSource.getRepository(ProjectFileEntity).insert({
    projectVersionId: vid, ownerKind: 'phase', ownerId: phaseId, path: at, role: 'workspace', editable,
    language: at.endsWith('.json') ? 'json' : 'markdown', blobSha: sha,
  });
};
const copy = async (slug: string) => {
  const made = await service.createProject(caller, { title: slug, slug, fromVersionId: importedVersionId });
  return { pid: made.project.id, vid: made.draftVersionId };
};

beforeAll(async () => {
  Logger.overrideLogger(false);
  dataSource = await memoryDataSource();
  const content = new ContentService();
  importer = new ProjectImporterService(content, dataSource);
  const registry = new ProjectRegistryService(content, dataSource, {
    importedContent: [],
  } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
  const imported = await importer.importPack(recordPack(), { origin: 'seed', platformOwned: true });
  await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
  await registry.load();
  service = new AuthoringService(dataSource, importer, registry);
  importedVersionId = imported.projectVersionId;
});

afterAll(async () => {
  if (dataSource?.isInitialized) await dataSource.destroy();
});

/**
 * TaskTrackr 4.0.0's Deployment or Maintenance written onto a copy's rows: the record checks taken out (and,
 * for Deployment, the fixture's six runbook rules put back beside the file rules), the fixture's rubric, the
 * brief from its task.md, and the record row replaced by the markdown file.
 */
const writeOlder = async (vid: string, key: OlderKey) => {
  const phase = await phaseRow(vid, key);
  const tasks = dataSource.getRepository(ProjectTaskEntity);
  const task = await tasks.findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
  const spec = specOf(key);
  let checks: unknown;
  if (key === 'deployment') {
    const { runbook: _runbook, ...rest } = task.checks as ConfigChecks;
    checks = { ...rest, rules: [...rest.rules.filter((r) => !r.id.startsWith('runbook-')), ...spec.checks.rules.filter((r: { id: string }) => r.id.startsWith('runbook-'))] };
  } else {
    const { ticket: _ticket, change: _change, ...rest } = task.checks as CodeChecks;
    checks = rest;
  }
  await tasks.update({ id: task.id }, { checks: checks as ProjectTaskEntity['checks'], rubric: spec.rubric, brief: readFileSync(path.join(OLDER[key].dir, spec.taskFile), 'utf8') });
  await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, path: OLDER[key].record });
  await insertRow(vid, phase.id, OLDER[key].markdown, readFileSync(path.join(OLDER[key].dir, 'files', OLDER[key].markdown), 'utf8'), true);
};
/** A second work task beside the older one: the main task's row again under another key, still in the older shape. */
const addSecondTask = async (vid: string, key: OlderKey) => {
  const tasks = dataSource.getRepository(ProjectTaskEntity);
  const { id: _id, ...main } = await tasks.findOneByOrFail({ projectPhaseId: (await phaseRow(vid, key)).id, taskKey: 'main' });
  await tasks.insert({ ...main, taskKey: 'second', order: main.order + 1 });
};
const rowPaths = async (vid: string, key: OlderKey) =>
  (await dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: vid, ownerKind: 'phase', ownerId: (await phaseRow(vid, key)).id })).map((row) => row.path);
const mainTask = async (pid: string, vid: string, key: OlderKey) =>
  (await service.readDraft(caller, pid, vid)).phases.find((p) => p.key === key)!.tasks.find((t) => t.taskKey === 'main')!;

describe('an older Deployment on a draft', () => {
  it('shows the converted view, the rubric the first save will store, and stores nothing', async () => {
    const { pid, vid } = await copy('older-deploy-view');
    await writeOlder(vid, 'deployment');
    const task = await mainTask(pid, vid, 'deployment');
    expect(task.recordOlderFormat).toBe(true);
    expect(task.runbook!.floor).toEqual({ minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: true });
    // the Files-and-checks card shows the converted checks: the ten file rules, the smoke run and the drill
    expect(task.config!.fileRules).toHaveLength(10);
    expect(task.config!.drill!.fault).toBe('web-points-at-localhost');
    expect(await rowPaths(vid, 'deployment')).toContain('RUNBOOK.md');
    expect(await rowPaths(vid, 'deployment')).not.toContain(RUNBOOK_JSON);
    await service.updateTask(caller, pid, vid, 'deployment', 'main', { runbook: { floor: task.runbook!.floor } });
    expect((await mainTask(pid, vid, 'deployment')).rubric).toEqual(task.rubric);
  });
  it('converts at the first runbook save', async () => {
    const { pid, vid } = await copy('older-deploy-save');
    await writeOlder(vid, 'deployment');
    const floor = { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true };
    await service.updateTask(caller, pid, vid, 'deployment', 'main', { runbook: { floor } });
    expect(await rowPaths(vid, 'deployment')).not.toContain('RUNBOOK.md');
    expect(await rowPaths(vid, 'deployment')).toContain(RUNBOOK_JSON);
    const task = await mainTask(pid, vid, 'deployment');
    expect(task.runbook!.floor).toEqual(floor);
    expect(task.recordOlderFormat).toBeUndefined();
  });
  it('refuses a draft that mounts another markdown file, in the view and at the first save, and changes nothing', async () => {
    const { pid, vid } = await copy('older-deploy-stray');
    await writeOlder(vid, 'deployment');
    await insertRow(vid, (await phaseRow(vid, 'deployment')).id, 'docs/ops.md', '# ops\n', false);
    expect((await mainTask(pid, vid, 'deployment')).recordConversionRefused).toBe('A Deployment phase mounts no markdown file: docs/ops.md.');
    await expect(service.updateTask(caller, pid, vid, 'deployment', 'main', { runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true } } }))
      .rejects.toMatchObject({ message: 'This Deployment task cannot be converted: A Deployment phase mounts no markdown file: docs/ops.md.' });
    expect(await rowPaths(vid, 'deployment')).toContain('RUNBOOK.md');
  });
  it('refuses a second work task beside the older one, in the view and at the first save, and changes nothing', async () => {
    const { pid, vid } = await copy('older-deploy-beside');
    await writeOlder(vid, 'deployment');
    await addSecondTask(vid, 'deployment');
    const shown = await mainTask(pid, vid, 'deployment');
    expect(shown.recordConversionRefused).toBe(BESIDE.deployment);
    expect(shown.recordOlderFormat).toBeUndefined();
    await expect(service.updateTask(caller, pid, vid, 'deployment', 'main', { runbook: { floor: { minEnvironment: 1, minHealth: 1, minRollback: 1, minData: 0, requireIncident: true } } }))
      .rejects.toMatchObject({ message: `This Deployment task cannot be converted: ${BESIDE.deployment}` });
    expect(await rowPaths(vid, 'deployment')).toContain('RUNBOOK.md');
    expect(await rowPaths(vid, 'deployment')).not.toContain(RUNBOOK_JSON);
    const main = await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: (await phaseRow(vid, 'deployment')).id, taskKey: 'main' });
    expect((main.checks as ConfigChecks).runbook).toBeUndefined();
    expect(main.rubric).toEqual(specOf('deployment').rubric);
  });
  it('shows a published older copy as it was published: no converted view and its stored rubric', async () => {
    const { pid, vid } = await copy('older-deploy-published');
    await writeOlder(vid, 'deployment');
    await dataSource.getRepository(ProjectVersionEntity).update({ id: vid }, { status: 'published' });
    const task = await mainTask(pid, vid, 'deployment');
    expect(task.recordOlderFormat).toBeUndefined();
    expect(task.recordConversionRefused).toBeUndefined();
    expect(task.runbook).toBeUndefined();
    expect(task.config).toBeUndefined();
    expect(task.rubric).toEqual(specOf('deployment').rubric);
  });
});

describe('a conversion called with no task named', () => {
  it('converts the phase\'s one older task, and refuses when two older work tasks sit in the phase', async () => {
    const { vid } = await copy('older-no-task');
    await writeOlder(vid, 'deployment');
    expect(await convertLegacyRunbookRows(dataSource.manager, vid)).toMatchObject({ converted: true });
    expect(await rowPaths(vid, 'deployment')).toContain(RUNBOOK_JSON);
    expect(await rowPaths(vid, 'deployment')).not.toContain('RUNBOOK.md');
    await writeOlder(vid, 'maintenance');
    await addSecondTask(vid, 'maintenance');
    expect(await convertLegacyChangeRows(dataSource.manager, vid)).toEqual({ converted: false, reason: BESIDE.maintenance });
    expect(await rowPaths(vid, 'maintenance')).toContain('CHANGELOG.md');
    expect(await rowPaths(vid, 'maintenance')).not.toContain(CHANGE_REQUEST_JSON);
  });
});

describe('the task\'s artefact path at the conversion', () => {
  it('keeps an older task\'s artefact path when it names a row the conversion keeps', async () => {
    // `named` (legacy-rows.ts): the path goes only with a markdown file the conversion leaves; a kept row stays the task's
    const { vid } = await copy('older-deploy-kept-path');
    await writeOlder(vid, 'deployment');
    const kept = (await rowPaths(vid, 'deployment')).find((at) => !at.endsWith('.md'));
    expect(kept).toBeDefined();
    const tasks = dataSource.getRepository(ProjectTaskEntity);
    const phase = await phaseRow(vid, 'deployment');
    await tasks.update({ projectPhaseId: phase.id, taskKey: 'main' }, { artefactPath: kept! });
    const outcome = await dataSource.transaction((manager) => convertLegacyRunbookRows(manager, vid));
    expect(outcome).toMatchObject({ converted: true });
    expect(await rowPaths(vid, 'deployment')).toContain(kept);
    expect(await rowPaths(vid, 'deployment')).not.toContain('RUNBOOK.md');
    expect((await tasks.findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' })).artefactPath).toBe(kept);
  });
  it('clears it when it names the markdown file the conversion leaves', async () => {
    const { vid } = await copy('older-deploy-left-path');
    await writeOlder(vid, 'deployment');
    const tasks = dataSource.getRepository(ProjectTaskEntity);
    const phase = await phaseRow(vid, 'deployment');
    await tasks.update({ projectPhaseId: phase.id, taskKey: 'main' }, { artefactPath: 'RUNBOOK.md' });
    expect(await dataSource.transaction((manager) => convertLegacyRunbookRows(manager, vid))).toMatchObject({ converted: true });
    expect((await tasks.findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' })).artefactPath).toBeNull();
  });
});

describe('an older Maintenance on a draft', () => {
  it('shows the converted view and stores nothing', async () => {
    const { pid, vid } = await copy('older-maint-view');
    await writeOlder(vid, 'maintenance');
    const task = await mainTask(pid, vid, 'maintenance');
    expect(task.recordOlderFormat).toBe(true);
    expect(task.change).toMatchObject({ ticket: { id: 'CR-2', title: 'Comments on a task' }, contract: true });
    expect(await rowPaths(vid, 'maintenance')).toContain('CHANGELOG.md');
  });
  it('converts at the first save that carries the rubric alone, before anything reads the task', async () => {
    const { pid, vid } = await copy('older-maint-save');
    await writeOlder(vid, 'maintenance');
    const shown = await mainTask(pid, vid, 'maintenance');
    await service.updateTask(caller, pid, vid, 'maintenance', 'main', { rubric: shown.rubric });
    expect(await rowPaths(vid, 'maintenance')).not.toContain('CHANGELOG.md');
    expect(await rowPaths(vid, 'maintenance')).toContain(CHANGE_REQUEST_JSON);
    expect((await mainTask(pid, vid, 'maintenance')).change!.ticket.id).toBe('CR-2');
  });
  it('refuses a draft that mounts another markdown file, in the view and at the first save, and changes nothing', async () => {
    const { pid, vid } = await copy('older-maint-stray');
    await writeOlder(vid, 'maintenance');
    await insertRow(vid, (await phaseRow(vid, 'maintenance')).id, 'NOTES.md', 'x\n', true);
    expect((await mainTask(pid, vid, 'maintenance')).recordConversionRefused).toBe('A Maintenance phase mounts no markdown file: NOTES.md.');
    await expect(service.updateTask(caller, pid, vid, 'maintenance', 'main', { change: { contract: true, floor: { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true } } }))
      .rejects.toMatchObject({ message: 'This Maintenance task cannot be converted: A Maintenance phase mounts no markdown file: NOTES.md.' });
    expect(await rowPaths(vid, 'maintenance')).toContain('CHANGELOG.md');
  });
});

describe('TaskTrackr 4.0.0, frozen', () => {
  it('loads the older pack with no flags, and its Deployment and Maintenance carry the two frozen digests', () => {
    const project = new ContentService().loadProject(olderTaskTrackrPack());
    for (const [key, frozen] of [['deployment', TASKTRACKR_400_DEPLOYMENT], ['maintenance', TASKTRACKR_400_MAINTENANCE]] as const) {
      const phase = project.phases.find((p) => p.key === key)!;
      expect({ executableDigestKey: executableDigestKey(phase), applicationDigest: applicationDigest(phase) }).toEqual(frozen);
    }
  });
});

describe('a copy of TaskTrackr 4.0.0, converted at copy', () => {
  it('compiles to 4.0.0\'s frozen digests before, and to 5.0.0\'s two phases after', async () => {
    const older = compilePack(new ContentService().loadProject(olderTaskTrackrPack()));
    for (const [key, frozen] of [['deployment', TASKTRACKR_400_DEPLOYMENT], ['maintenance', TASKTRACKR_400_MAINTENANCE]] as const) {
      const phase = older.content.phases.find((p) => p.key === key)!;
      // the digests the copy conversion compares, computed over the phase a draft compiles to, against the frozen 4.0.0 constants
      expect({ executableDigestKey: executableDigestKey(phase), applicationDigest: applicationDigest(phase) }).toEqual(frozen);
    }
    // A published version of a second platform project holding that snapshot. It is imported through the importer
    // under its own slug, so its phase, task and file rows are written beside the snapshot, as a copy reads them; a
    // version stored by hand with no rows would copy no file.
    const stored = await storePublishedVersion('tasktrackr-400');
    const source = (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: stored })).compiled!.content;
    for (const key of ['deployment', 'maintenance'] as const) {
      const phase = source.phases.find((p) => p.key === key)!;
      expect(executableDigestKey(phase)).toBe(executableDigestKey(older.content.phases.find((p) => p.key === key)!));
      expect(applicationDigest(phase)).toBe(applicationDigest(older.content.phases.find((p) => p.key === key)!));
    }
    const made = await service.createProject(caller, { title: 'Copy of 4.0.0', slug: 'copy-400', fromVersionId: stored });
    expect((await service.validate(caller, made.project.id, made.draftVersionId)).blocking).toEqual([]);
    const copied = (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.draftVersionId })).compiled!.content;
    const shipped = new ContentService();
    shipped.loadAll();
    for (const key of ['deployment', 'maintenance'] as const) {
      const mine = copied.phases.find((p) => p.key === key)!;
      const five = shipped.getPhase('tasktrackr', key);
      expect({ checks: mine.checks, files: mine.files, taskPanel: mine.taskPanel, objectives: mine.objectives, assistant: mine.assistant, rubric: mine.rubric })
        .toEqual({ checks: five.checks, files: five.files, taskPanel: five.taskPanel, objectives: five.objectives, assistant: five.assistant, rubric: five.rubric });
    }
  });

  it('puts a removed Deployment and Maintenance of the copy back as the copy converts them: 5.0.0\'s two phases exactly', async () => {
    const stored = await storePublishedVersion('tasktrackr-400-putback');
    const made = await service.createProject(caller, { title: 'Put back 4.0.0', slug: 'copy-400-putback', fromVersionId: stored });
    const [pid, vid] = [made.project.id, made.draftVersionId];
    for (const key of ['deployment', 'maintenance'] as const) await service.removePhase(caller, pid, vid, key);
    for (const key of ['deployment', 'maintenance'] as const) await service.restorePhase(caller, pid, vid, key);

    expect((await service.validate(caller, pid, vid)).blocking).toEqual([]);
    const back = (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: vid })).compiled!.content;
    const shipped = new ContentService();
    shipped.loadAll();
    for (const key of ['deployment', 'maintenance'] as const) {
      const mine = back.phases.find((p) => p.key === key)!;
      const five = shipped.getPhase('tasktrackr', key);
      expect({ checks: mine.checks, files: mine.files, taskPanel: mine.taskPanel, objectives: mine.objectives, assistant: mine.assistant, rubric: mine.rubric })
        .toEqual({ checks: five.checks, files: five.files, taskPanel: five.taskPanel, objectives: five.objectives, assistant: five.assistant, rubric: five.rubric });
    }
  });

  it('exports the converted copy whole: the archive re-uploads to 5.0.0\'s two phases, with no markdown file left', async () => {
    // The teacher's own published copy of 4.0.0 (theirs, so its export withholds nothing), copied again and converted.
    const pack = olderTaskTrackrPack((name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), slug: 'tasktrackr-400-theirs', title: 'TaskTrackr 4.0.0 of theirs' }, null, 2) : text));
    const theirs = await importer.importPack(pack, { origin: 'fork', platformOwned: false, ownerUserId: caller.id });
    const made = await service.createProject(caller, { title: 'Exported 4.0.0', slug: 'copy-400-export', fromVersionId: theirs.projectVersionId });
    const out = await new ExportService(dataSource, new ContentService()).export(caller, made.project.id, made.draftVersionId);
    expect(out.withheld).toEqual([]);
    const entries = readZip(out.archive, zipLimits(config.importMaxBytes));
    expect(entries.filter((entry) => /\/(RUNBOOK|CHANGELOG)\.md$/.test(entry.name))).toEqual([]);
    const again = await importer.importTeacherDraft(new MemoryPackSource(entries, 'export', packRootOf(entries)), { ownerId: caller.id, title: 'Exported 4.0.0 again' });
    expect(again.report.blocking).toEqual([]);
    const returned = (await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId })).compiled!.content;
    const five = new ContentService();
    five.loadAll();
    for (const key of ['deployment', 'maintenance'] as const) {
      const mine = returned.phases.find((p) => p.key === key)!;
      const shipped = five.getPhase('tasktrackr', key);
      // the export writes the folder layout, whose mounts read back in path order; the disk pack
      // keeps its authored order until TaskTrackr 6.0.0
      expect({ checks: mine.checks, files: mine.files, taskPanel: mine.taskPanel, objectives: mine.objectives, rubric: mine.rubric })
        .toEqual({ checks: shipped.checks, files: sortedMounts(shipped.files), taskPanel: shipped.taskPanel, objectives: shipped.objectives, rubric: shipped.rubric });
    }
  });

  it('keeps a task title the teacher renamed, which no digest reads, and still converts exactly', async () => {
    // A published 4.0.0 whose two work tasks a teacher renamed: a copy reads its tasks from the stored snapshot.
    const stored = await storePublishedVersion('tasktrackr-400-renamed');
    const versions = dataSource.getRepository(ProjectVersionEntity);
    const compiled = (await versions.findOneByOrFail({ id: stored })).compiled!;
    const renamed = compiled.phases.map((phase) => (phase.key === 'deployment' || phase.key === 'maintenance'
      ? { ...phase, tasks: phase.tasks.map((task) => (isQuizTask(task) ? task : { ...task, title: `Our own ${phase.key}` })) }
      : phase));
    await versions.update({ id: stored }, { compiled: { ...compiled, phases: renamed } });
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    const made = await service.createProject(caller, { title: 'Renamed 4.0.0', slug: 'copy-400-renamed', fromVersionId: stored });
    const notes = log.mock.calls.map(([line]) => String(line));
    log.mockRestore();
    // the note names the reference's current version, the TaskTrackr on disk
    expect(notes.filter((line) => line.endsWith("converted to TaskTrackr 6.0.0's."))).toHaveLength(2);
    const five = new ContentService();
    five.loadAll();
    const copied = (await versions.findOneByOrFail({ id: made.draftVersionId })).compiled!.content;
    for (const key of ['deployment', 'maintenance'] as const) {
      expect((await mainTask(made.project.id, made.draftVersionId, key)).title).toBe(`Our own ${key}`);
      expect(copied.phases.find((p) => p.key === key)!.checks).toEqual(five.getPhase('tasktrackr', key).checks);
    }
  });

  it('converts the generic way when the reference\'s published snapshot is missing, and says so in the note', async () => {
    const stored = await storePublishedVersion('tasktrackr-400-alone');
    const versions = dataSource.getRepository(ProjectVersionEntity);
    // The reference's one published version taken away for this copy, and put back after it.
    await versions.update({ id: importedVersionId }, { status: 'archived' });
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    let made: { project: { id: string }; draftVersionId: string };
    try {
      made = await service.createProject(caller, { title: 'Alone 4.0.0', slug: 'copy-400-alone', fromVersionId: stored });
    } finally {
      await versions.update({ id: importedVersionId }, { status: 'published' });
    }
    const notes = log.mock.calls.map(([line]) => String(line));
    log.mockRestore();
    // Both notes, each with the sentence: Maintenance's frozen check reads a draft that compiles once Deployment converted.
    expect(notes.filter((line) => line.includes('Deployment converted to the runbook record') && line.endsWith(referenceMissingNote('Deployment')))).toHaveLength(1);
    expect(notes.filter((line) => line.includes('Maintenance converted to the change request record') && line.endsWith(referenceMissingNote('Maintenance')))).toHaveLength(1);
    expect(notes.some((line) => line.includes("converted to TaskTrackr 6.0.0's"))).toBe(false);
    // The generic conversion mounted each record and dropped each markdown file, and the copy compiles.
    for (const key of ['deployment', 'maintenance'] as const) {
      expect(await rowPaths(made!.draftVersionId, key)).toContain(OLDER[key].record);
      expect(await rowPaths(made!.draftVersionId, key)).not.toContain(OLDER[key].markdown);
    }
    expect((await service.validate(caller, made!.project.id, made!.draftVersionId)).blocking).toEqual([]);
  });

  it('converts a copy whose briefs a teacher edited the generic way, and the copy compiles with each record as its written part', async () => {
    // A published 4.0.0 whose Deployment and Maintenance briefs a teacher edited: no longer the frozen phases.
    const stored = await storePublishedVersion('tasktrackr-400-edited');
    const versions = dataSource.getRepository(ProjectVersionEntity);
    const compiled = (await versions.findOneByOrFail({ id: stored })).compiled!;
    const edited = compiled.phases.map((phase) => (phase.key === 'deployment' || phase.key === 'maintenance'
      ? { ...phase, tasks: phase.tasks.map((task) => (isQuizTask(task) ? task : { ...task, brief: `${task.brief}\nOur own closing line.\n` })) }
      : phase));
    await versions.update({ id: stored }, { compiled: { ...compiled, phases: edited } });
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    const made = await service.createProject(caller, { title: 'Edited 4.0.0', slug: 'copy-400-edited', fromVersionId: stored });
    const notes = log.mock.calls.map(([line]) => String(line));
    log.mockRestore();
    expect(notes.filter((line) => line.includes('Deployment converted to the runbook record'))).toHaveLength(1);
    expect(notes.filter((line) => line.includes('Maintenance converted to the change request record'))).toHaveLength(1);
    expect(notes.some((line) => line.includes("converted to TaskTrackr 6.0.0's") || line.includes("reference's current"))).toBe(false);
    expect((await service.validate(caller, made.project.id, made.draftVersionId)).blocking).toEqual([]);
    const copied = (await versions.findOneByOrFail({ id: made.draftVersionId })).compiled!;
    for (const key of ['deployment', 'maintenance'] as const) {
      const row = await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: (await phaseRow(made.draftVersionId, key)).id, taskKey: 'main' });
      expect(row.artefactPath).toBeNull();
      expect(row.brief.endsWith('Our own closing line.\n')).toBe(true);
      const phase = copied.content.phases.find((p) => p.key === key)!;
      expect(phase.files.map((file) => file.path)).toContain(OLDER[key].record);
      expect(phase.files.map((file) => file.path)).not.toContain(OLDER[key].markdown);
      const task = copied.phases.find((p) => p.key === key)!.tasks.find((one) => !isQuizTask(one))!;
      expect(task.owns).toContain(OLDER[key].record);
    }
  });

  it.each(['deployment', 'maintenance'] as const)('says so in the note when the reference\'s current phase is missing for a copy of its older %s', async (key) => {
    // The conversion as the copy calls it, with the draft compiling to 4.0.0's frozen phase and no reference phase.
    const { vid } = await copy(`missing-${key}`);
    await writeOlder(vid, key);
    const frozen = compilePack(new ContentService().loadProject(olderTaskTrackrPack())).content.phases.find((p) => p.key === key)!;
    const convert = key === 'deployment' ? convertLegacyRunbookRows : convertLegacyChangeRows;
    const outcome = await dataSource.transaction((manager) => convert(manager, vid, undefined, undefined, async () => ({ draft: frozen, current: null })));
    const title = key === 'deployment' ? 'Deployment' : 'Maintenance';
    expect(outcome).toMatchObject({ converted: true });
    const note = outcome && 'note' in outcome ? outcome.note : '';
    expect(note.startsWith(`${title} converted to the ${key === 'deployment' ? 'runbook' : 'change request'} record: `)).toBe(true);
    expect(note.endsWith(`. ${referenceMissingNote(title)}`)).toBe(true);
    expect(await rowPaths(vid, key)).toContain(OLDER[key].record);
    expect(await rowPaths(vid, key)).not.toContain(OLDER[key].markdown);
  });
});

/** TaskTrackr 4.0.0 imported as a platform project of its own (`slug`), answering its published version id. */
async function storePublishedVersion(slug: string): Promise<string> {
  const pack = olderTaskTrackrPack((name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), slug, title: 'TaskTrackr 4.0.0' }, null, 2) : text));
  return (await importer.importPack(pack, { origin: 'seed', platformOwned: true })).projectVersionId;
}

// The harness is story-export.spec.ts's (`openForkWorld`: an in-memory database
// with the platform pack seeded), with the record pack (TaskTrackr whose
// Deployment carries a runbook and whose Maintenance carries a ticket and a
// change request) imported as a teacher's draft beside Shelf, so the export
// writes both records and the archive comes back through the real upload door
// (`UploadService` over the real importer).
import 'reflect-metadata';
import { compareMountPaths, languageOfPath } from '@learnsdlc/shared';
import { HttpException } from '@nestjs/common';
import {
  EMPTY_RUNBOOK,
  RUNBOOK_JSON,
  retiredWrittenPhaseAssignRefusal,
  retiredWrittenPhaseUploadRefusal,
  serialiseRunbook,
} from '@learnsdlc/shared';
import { config } from '../config';
import { ProjectImporterService } from '../content/importer.service';
import { layoutFromManifest } from '../content/legacy-layout';
import { packRootOf } from '../content/memory-pack-source';
import { ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { readZip, zipLimits } from '../content/zip-reader';
import { openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { recordPack } from '../../test/record-pack';
import { entriesOf, writeZip } from '../../test/fixtures/upload-packs/archive';
import { SHELF_DIR } from '../../test/fixtures/upload-packs/markers';
import { olderShelfPack } from '../../test/legacy-phase';
import { ExportService } from './export.service';
import { UploadService } from './upload.service';

const caller = { id: 'teacher-record-exp', email: 'teacher@record-export.test', role: 'INSTRUCTOR' as const, cohort: 'default' };

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

let world: ForkWorld;
let exportService: ExportService;
let uploadService: UploadService;
const upload = (title: string, archive: Buffer) =>
  uploadService.upload(caller, { title, archiveBase64: archive.toString('base64') });

beforeAll(async () => {
  world = await openForkWorld();
  const importer = new ProjectImporterService(world.content, world.dataSource);
  exportService = new ExportService(world.dataSource, world.content);
  uploadService = new UploadService(importer, world.content, world.dataSource, 8 * 1024 * 1024);
}, 120_000);
afterAll(async () => {
  await world?.close();
});

describe('the records through export and upload', () => {
  const tasksOf = async (pid: string, vid: string, key: 'deployment' | 'maintenance') => (await world.service.listTasks(caller, pid, vid, key)).tasks[0];
  // the record pack in memory, without TaskTrackr's warm-up folder, which a teacher's draft cannot hold
  const recordSource = () => recordPack({ drop: (name) => name.startsWith('warmup/') });
  const recordDraft = (title: string) => new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(recordSource(), { ownerId: caller.id, title });

  it('exports both records as checks, writes no task.md for either phase, and re-uploads to equal runbook, ticket and change', async () => {
    const made = await recordDraft('TaskTrackr with records');
    const { archive } = await exportService.export(caller, made.projectId, made.versionId);
    const names = zipEntryNames(archive);
    expect(names).not.toContain('phases/05-deployment/task.md');
    expect(names).not.toContain('phases/06-maintenance/task.md');
    const again = await upload('Records again', archive);
    for (const key of ['deployment', 'maintenance'] as const) {
      const was = await tasksOf(made.projectId, made.versionId, key);
      const now = await tasksOf(again.projectId, again.versionId, key);
      expect(now.runbook).toEqual(was.runbook);
      expect(now.change).toEqual(was.change);
    }
  });
  it('writes an edited starting runbook at its workspace path under files/, and leaves out one equal to the seeded empty record', async () => {
    // TaskTrackr mounts its runbook at files/deployment/runbook.json; the loader sorts every mount by path once it
    // has seeded, so an empty record is left out wherever it is mounted.
    const made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(recordSource(), { ownerId: caller.id, title: 'Starting runbooks' });
    const edited = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] });
    await world.service.replaceFile(caller, made.projectId, made.versionId, 'deployment', { path: RUNBOOK_JSON, content: edited });
    const withEdit = (await exportService.export(caller, made.projectId, made.versionId)).archive;
    // the folder layout names no file in phase.json: the mount is its path under files/
    expect('files' in JSON.parse(zipEntryText(withEdit, 'phases/05-deployment/phase.json'))).toBe(false);
    expect(zipEntryText(withEdit, `phases/05-deployment/files/${RUNBOOK_JSON}`)).toBe(edited);
    await world.service.replaceFile(caller, made.projectId, made.versionId, 'deployment', { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK) });
    const seeded = (await exportService.export(caller, made.projectId, made.versionId)).archive;
    expect(zipEntryNames(seeded).filter((name) => name.endsWith('runbook.json'))).toEqual([]);
  });
  it('exports whole a Shelf draft stored as the import stored it before the records (no runbook, no ticket, no change), read back with both records', async () => {
    // The draft import before the records loaded the pack with the Requirements and Design conversions alone,
    // so its Deployment and Maintenance rows hold the older shape (RUNBOOK.md mounted, task.md, no record).
    const load = world.content.loadProject.bind(world.content);
    const spy = jest.spyOn(world.content, 'loadProject').mockImplementation((source, options = {}) => {
      const { convertLegacyRunbook: _runbook, convertLegacyChange: _change, ...before } = options;
      return load(source, before);
    });
    let made: { projectId: string; versionId: string };
    try {
      // Shelf ships its records since TaskTrackr 5.0.0's task, so the draft is imported from its older shape, frozen,
      // converted once to the folder layout the loader reads (its Deployment and Maintenance stay older inside it).
      made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(layoutFromManifest(olderShelfPack()).source, { ownerId: caller.id, title: 'Shelf before the records' });
    } finally {
      spy.mockRestore();
    }
    const held = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).compiled!.content;
    const deployment = held.phases.find((one) => one.key === 'deployment')!;
    const maintenance = held.phases.find((one) => one.key === 'maintenance')!;
    expect(deployment.checks.kind === 'config' && deployment.checks.runbook).toBeFalsy();
    expect(maintenance.checks.kind === 'code' && (maintenance.checks.ticket || maintenance.checks.change)).toBeFalsy();
    const out = await exportService.export(caller, made.projectId, made.versionId);
    expect(out.withheld).toEqual([]);
    // its brief is the phase's taskPanel, never a task.md
    expect(zipEntryNames(out.archive)).not.toContain('phases/05-deployment/task.md');
    expect(typeof JSON.parse(zipEntryText(out.archive, 'phases/05-deployment/phase.json')).taskPanel).toBe('string');
    const again = await upload('Shelf with its records', out.archive);
    const runbook = await tasksOf(again.projectId, again.versionId, 'deployment');
    const change = await tasksOf(again.projectId, again.versionId, 'maintenance');
    expect(runbook.runbook).toBeTruthy();
    expect(change.change?.ticket).toBeTruthy();
  });
  it('leaves out an empty starting runbook at its path under files/, which the loader seeds again, and the archive comes back in path order', async () => {
    // the folder layout places a mount by its path alone: the empty record sits at files/deployment/runbook.json
    const made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(
      recordPack({ extra: { [`phases/05-deployment/files/${RUNBOOK_JSON}`]: serialiseRunbook(EMPTY_RUNBOOK) } }),
      { ownerId: caller.id, title: 'An empty runbook' },
    );
    const held = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).compiled!.content;
    const heldPaths = held.phases.find((one) => one.key === 'deployment')!.files.map((file) => file.path);
    expect(heldPaths).toContain(RUNBOOK_JSON);
    expect(heldPaths).toEqual([...heldPaths].sort(compareMountPaths));
    const { archive } = await exportService.export(caller, made.projectId, made.versionId);
    // the empty record is left out wherever it is mounted: the loader seeds it, then sorts every mount by path
    expect(zipEntryNames(archive).filter((name) => name.endsWith('runbook.json'))).toEqual([]);
    const again = await upload('An empty runbook first again', archive);
    const back = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId })).compiled!.content;
    // the folder layout's mount order is the path order
    expect(back.phases.find((one) => one.key === 'deployment')!.files.map((file) => file.path)).toEqual([...heldPaths].sort(compareMountPaths));
  });
  it('leaves out an empty starting runbook, which the loader seeds again as json, and the archive comes back with each language its path gives', async () => {
    // a folder-layout pack declares no language: each mount's is its path's, a record's json
    const made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(
      recordPack({ extra: { [`phases/05-deployment/files/${RUNBOOK_JSON}`]: serialiseRunbook(EMPTY_RUNBOOK) } }),
      { ownerId: caller.id, title: 'An empty runbook, its language by its path' },
    );
    const held = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId })).compiled!.content;
    const heldFiles = held.phases.find((one) => one.key === 'deployment')!.files.map((file) => [file.path, file.language]);
    expect(heldFiles).toContainEqual([RUNBOOK_JSON, 'json']);
    expect(heldFiles).toEqual(heldFiles.map(([at]) => [at, languageOfPath(at)]));
    const { archive } = await exportService.export(caller, made.projectId, made.versionId);
    // left out: a record is json, and the loader seeds it back as json at its path
    expect(zipEntryNames(archive).filter((name) => name.endsWith('runbook.json'))).toEqual([]);
    const again = await upload('An empty plaintext runbook last again', archive);
    const back = (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId })).compiled!.content;
    // path order, each language by its path; a folder-layout archive with every text plain carries no note
    expect(back.phases.find((one) => one.key === 'deployment')!.files.map((file) => [file.path, file.language])).toEqual(
      [...heldFiles].sort((a, b) => compareMountPaths(a[0], b[0])).map(([at]) => [at, languageOfPath(at)]),
    );
    expect(again.warnings).toBeUndefined();
  });
  it('refuses to export a version whose Testing holds a written phase in the older format, with the class door\'s sentence', async () => {
    const made = await recordDraft('An older Testing');
    const testing = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: made.versionId, key: 'testing' });
    const older = { kind: 'markdown', targets: ['notes.md'], rules: [] };
    await world.dataSource.getRepository(ProjectTaskEntity).update({ projectPhaseId: testing.id }, { checks: older as never });
    // and the stored snapshot, which is what the export reads: the phase and its sole task as an older import wrote them
    const versions = world.dataSource.getRepository(ProjectVersionEntity);
    const compiled = (await versions.findOneByOrFail({ id: made.versionId })).compiled!;
    const phase = compiled.content.phases.find((one) => one.key === 'testing')!;
    Object.assign(phase, { artifactKind: 'markdown', checks: older });
    compiled.phases.find((one) => one.key === 'testing')!.tasks = compiled.phases.find((one) => one.key === 'testing')!.tasks.map(({ checks: _slice, ...task }) => ({ ...task, checkKind: 'markdown' as never, gradedUnits: [] }));
    await versions.update({ id: made.versionId }, { compiled });
    await expect(exportService.export(caller, made.projectId, made.versionId)).rejects.toThrow(retiredWrittenPhaseAssignRefusal('Testing'));
  });
});

describe('the upload door refuses by name, NOT_A_PACK with the sentence in detail', () => {
  type Entry = { name: string; data: Buffer };
  const withPhase = (name: string, edit: (phase: any) => any) => (entries: Entry[]): Entry[] =>
    entries.map((e) => (e.name === name ? { name, data: Buffer.from(JSON.stringify(edit(JSON.parse(e.data.toString('utf8'))), null, 2)) } : e));
  const refusedWith = async (edit: (entries: Entry[]) => Entry[]) => {
    const refused = await upload('Refused', writeZip(edit(entriesOf(SHELF_DIR)))).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    return (refused as HttpException).getResponse();
  };
  it('a written phase in the older format under a retired key', async () => {
    const response = await refusedWith(withPhase('phases/04-testing/phase.json', (phase) => ({ ...phase, checks: { kind: 'markdown', targets: ['notes.md'], rules: [] } })));
    expect(response).toMatchObject({ code: 'NOT_A_PACK', detail: expect.stringContaining(retiredWrittenPhaseUploadRefusal('Testing').replace(/\.$/, '')) });
  });
  it('a Deployment that mounts another markdown file', async () => {
    // the folder layout mounts a file by where it sits: a read-only docs/ops.md
    const response = await refusedWith((entries) => [...entries, { name: 'phases/05-deployment/readonly/docs/ops.md', data: Buffer.from('# ops\n') }]);
    expect(response).toMatchObject({ code: 'NOT_A_PACK', detail: expect.stringContaining('A Deployment phase mounts no markdown file: docs/ops.md') });
  });
});

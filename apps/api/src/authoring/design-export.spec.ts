// The harness is story-export.spec.ts's: export.service.spec.ts's world
// (`openForkWorld`: an in-memory database with the platform pack seeded), the
// shelf upload fixture imported as a teacher's own draft (so nothing is
// withheld), its Design saved once through the editor with a design body, and
// the archive brought back through the real upload door (`UploadService` over
// the real importer).
import 'reflect-metadata';
import * as path from 'path';
import { HttpException } from '@nestjs/common';
import {
  API_CONTRACT_JSON,
  DEFAULT_DESIGN_FLOOR,
  DESIGN_JSON,
  DESIGN_OLDER_FORMAT_REFUSAL,
  EMPTY_DESIGN,
  SCREEN_CONTRACT_JSON,
  serialiseDesign,
} from '@learnsdlc/shared';
import { config } from '../config';
import { ContentService } from '../content/content.service';
import { layoutFromManifest, OLDER_LAYOUT_WARNING } from '../content/legacy-layout';
import { plainTextOf } from '@learnsdlc/shared';
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


// The door's notes: an archive in the older layout (shelf-design-task, the
// frozen older-shelf) is read once into the folder layout and its
// cases name each note they expect. The starter is in the folder layout with
// plain briefs and an export writes that layout with every text
// plain, so an upload of either asserts no warnings at all.

const caller = { id: 'teacher-design-exp', email: 'teacher@design-export.test', role: 'INSTRUCTOR' as const, cohort: 'default' };
const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs');
const STARTER_DIR = path.join(FIXTURES, 'starter');
const OLDER_DIR = path.join(FIXTURES, 'shelf-design-task');
/** Shelf as it shipped in the older layout, frozen before the Shelf family moved to the folder layout. */
const OLDER_SHELF = path.join(__dirname, '..', '..', 'test', 'fixtures', 'older-shelf');
const DESIGN_PHASE = 'phases/02-design/phase.json';

/** The editor's design body: both contracts on, the sequence diagram on, one story. */
const body = {
  design: {
    contracts: { api: true, screens: true },
    sequence: true,
    stories: [{ id: 'SH-1', title: 'Browse the shelf', line: 'As a member, I want to see every book in shelf order, so that I can find one without asking.' }],
    floor: { ...DEFAULT_DESIGN_FLOOR, minEntities: 1 },
  },
  rubric: {
    passThreshold: 70,
    criteria: [
      { key: 'contract', title: 'Contract', description: 'Every operation and every refusal is declared.', weight: 0.6 },
      { key: 'decisions', title: 'Decision', description: 'A decision with its reason.', weight: 0.4 },
    ],
  },
};

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
/** A pack directory's entries with its Design phase.json edited. */
const withDesignPhase = (dir: string, edit: (phase: Record<string, any>) => Record<string, any>) =>
  entriesOf(dir).map((entry) =>
    entry.name === DESIGN_PHASE ? { name: entry.name, data: Buffer.from(JSON.stringify(edit(JSON.parse(entry.data.toString('utf8'))), null, 2)) } : entry,
  );

describe('a design phase through export and upload', () => {
  let world: ForkWorld;
  let exportService: ExportService;
  let uploadService: UploadService;
  let projectId = '';
  let versionId = '';
  const upload = (title: string, archive: Buffer) =>
    uploadService.upload(caller, { title, archiveBase64: archive.toString('base64') });
  const designTask = async (pid: string, vid: string) => (await world.service.listTasks(caller, pid, vid, 'design')).tasks[0];
  const refusalOf = async (archive: Buffer): Promise<Record<string, unknown>> => {
    const refused = await upload('Refused design', archive).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(HttpException);
    return (refused as HttpException).getResponse() as Record<string, unknown>;
  };

  beforeAll(async () => {
    world = await openForkWorld();
    const importer = new ProjectImporterService(world.content, world.dataSource);
    exportService = new ExportService(world.dataSource, world.content);
    uploadService = new UploadService(importer, world.content, world.dataSource, 8 * 1024 * 1024);
    const made = await importer.importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: caller.id, title: 'Shelf design' });
    projectId = made.projectId;
    versionId = made.versionId;
    await world.service.updateTask(caller, projectId, versionId, 'design', 'main', body as never);
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('exports a design phase without task.md or markdown, and re-uploads to the same checks', async () => {
    const { archive, withheld } = await exportService.export(caller, projectId, versionId);
    expect(withheld).toEqual([]);
    const names = zipEntryNames(archive);
    expect(names).not.toContain('phases/02-design/task.md');
    expect(names.filter((n) => n.startsWith('phases/02-design/') && n.endsWith('.md'))).toEqual([]);
    // every document is still its seed, so none is written: the upload seeds them again
    expect(names.filter((n) => n.startsWith('phases/02-design/files/'))).toEqual([]);
    const phaseJson = JSON.parse(zipEntryText(archive, 'phases/02-design/phase.json'));
    expect(phaseJson.checks.kind).toBe('design');
    expect(phaseJson.checks).toMatchObject({ contracts: body.design.contracts, sequence: true, stories: body.design.stories, floor: body.design.floor });
    expect(typeof phaseJson.taskPanel).toBe('string');
    expect(phaseJson.taskFile).toBeUndefined();
    // the folder layout names no file: every seeded document is left out and the loader seeds it again
    expect('files' in phaseJson).toBe(false);
    const again = await upload('Again', archive);
    expect(again.warnings).toBeUndefined();
    const task = await designTask(again.projectId, again.versionId);
    expect(task.design).toEqual(phaseJson.checks);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId });
    const design = version.compiled!.content.phases.find((one) => one.key === 'design')!;
    expect(design.files.map((file) => file.path)).toEqual([DESIGN_JSON, API_CONTRACT_JSON, SCREEN_CONTRACT_JSON]);
    // the rubric and the brief come back as exported
    expect(design.rubric).toEqual(phaseJson.rubric);
    // the export writes the brief plain and trimmed, as the upload door stores it, so the door stores it as written
    expect(phaseJson.taskPanel).toBe(plainTextOf(phaseJson.taskPanel.trim()));
    expect(design.taskPanel).toBe(phaseJson.taskPanel);
  });

  it('exports the documents that are not their seeds under files/, and the upload keeps them byte for byte', async () => {
    const record = serialiseDesign({
      ...EMPTY_DESIGN,
      entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: ['knows who has it on loan'], satisfies: ['SH-1'] }],
    });
    const contract = '{\n  "operations": [{ "method": "GET", "path": "/api/books" }],\n  "errors": {}\n}\n';
    // each starting document mounted editable at its workspace path under files/
    const entries = entriesOf(SHELF_DIR);
    entries.push({ name: `phases/02-design/files/${DESIGN_JSON}`, data: Buffer.from(record) });
    entries.push({ name: `phases/02-design/files/${API_CONTRACT_JSON}`, data: Buffer.from(contract) });
    const importer = new ProjectImporterService(world.content, world.dataSource);
    const made = await importer.importTeacherDraft(new MemoryPackSource(entries.map((e) => ({ name: e.name, bytes: e.data })), 'edited'), {
      ownerId: caller.id,
      title: 'Shelf with a starting design',
    });
    const { archive } = await exportService.export(caller, made.projectId, made.versionId);
    expect(zipEntryText(archive, `phases/02-design/files/${DESIGN_JSON}`)).toBe(record);
    expect(zipEntryText(archive, `phases/02-design/files/${API_CONTRACT_JSON}`)).toBe(contract);
    const again = await upload('Starting design again', archive);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: again.versionId });
    const design = version.compiled!.content.phases.find((one) => one.key === 'design')!;
    expect(design.files.find((file) => file.path === DESIGN_JSON)?.content).toBe(record);
    expect(design.files.find((file) => file.path === API_CONTRACT_JSON)?.content).toBe(contract);
    // the screen contract is off in this pack: neither the archive nor the upload holds it
    expect(zipEntryNames(archive).some((name) => name.endsWith('screens.json'))).toBe(false);
    expect(design.files.map((file) => file.path)).not.toContain(SCREEN_CONTRACT_JSON);
  });

  it('converts an uploaded older Design and says so', async () => {
    const made = await upload('Older design', zipWith({}, OLDER_DIR));
    const task = await designTask(made.projectId, made.versionId);
    expect(task.checkKind).toBe('design');
    expect(task.design?.sequence).toBe(false);
    expect(task.design?.floor).toEqual(DEFAULT_DESIGN_FLOOR);
    expect((made.warnings ?? []).some((w: string) => w.startsWith('Design converted from markdown'))).toBe(true);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    const design = version.compiled!.content.phases.find((one) => one.key === 'design')!;
    expect(design.artifactKind).toBe('design');
    expect(design.files.map((file) => file.path)).toEqual([DESIGN_JSON]);
    // the brief file's words are kept inline, as a design phase keeps them
    expect(design.taskPanel).toContain('Design');
  });

  it('exports whole a teacher draft whose Design phase is still markdown (made before the design kind), read back converted', async () => {
    // A draft stored before uploads converted: its Requirements and Design rows in the older kind, as an older import stored them.
    // The older archive is imported converted to the folder layout the loader reads, then its older phases are written back.
    const source = new DirectoryPackSource(OLDER_DIR);
    const made = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(layoutFromManifest(source).source, { ownerId: caller.id, title: 'Shelf before the design kind' });
    await storeOlderPhases(world.dataSource, made.versionId, source);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'design')!.checks.kind).toBe('markdown');
    const out = await exportService.export(caller, made.projectId, made.versionId);
    expect(out.withheld).toEqual([]);
    expect(JSON.parse(zipEntryText(out.archive, 'phases/02-design/phase.json')).checks.kind).toBe('markdown');
  });

  it('converts an older Design whose rules hold a stray entry, and refuses one whose rubric is malformed by the loader\'s own sentence', async () => {
    const stray = await upload('Older design, stray rule', writeZip(withDesignPhase(OLDER_DIR, (phase) => ({ ...phase, checks: { ...phase.checks, rules: [null, ...phase.checks.rules] } }))));
    expect((await designTask(stray.projectId, stray.versionId)).checkKind).toBe('design');
    const versions = () => world.dataSource.getRepository(ProjectVersionEntity).count();
    const before = await versions();
    const response = await refusalOf(writeZip(withDesignPhase(OLDER_DIR, (phase) => ({ ...phase, rubric: { ...phase.rubric, criteria: [null] } }))));
    expect(response.code).toBe('NOT_A_PACK');
    expect(String(response.detail)).not.toMatch(/Cannot read|undefined|null/);
    // a criterion whose description is not text is refused with a sentence, never a type error
    const typed = await refusalOf(writeZip(withDesignPhase(OLDER_DIR, (phase) => ({
      ...phase, rubric: { ...phase.rubric, criteria: phase.rubric.criteria.map((c: object, i: number) => (i === 0 ? { ...c, description: 42 } : c)) },
    }))));
    expect(typed.code).toBe('NOT_A_PACK');
    expect(String(typed.detail)).toContain('rubric.criteria[0].description must be text');
    // neither refusal wrote a version
    expect(await versions()).toBe(before);
  });

  it('converts only when asked: the platform loader refuses an older Design by its older-format sentence', () => {
    // the older archive converted once to the folder layout, the only layout the loader reads; its phases keep their older kinds
    const source = () => layoutFromManifest(new MemoryPackSource(entriesOf(OLDER_DIR).map((e) => ({ name: e.name, bytes: e.data })), 'older')).source;
    // its Requirements is of the older kind too, and converts here, so the Design is what the load answers for
    expect(() => new ContentService().loadProject(source(), { convertLegacyRequirements: true })).toThrow(DESIGN_OLDER_FORMAT_REFUSAL);
    const warnings: string[] = [];
    const converted = new ContentService().loadProject(source(), { convertLegacyRequirements: true, convertLegacyDesign: true, warnings });
    const design = converted.phases.find((p) => p.key === 'design')!;
    expect(design.checks.kind).toBe('design');
    expect(design.artifactKind).toBe('design');
    // one note per converted phase: the Requirements', then the Design's
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toMatch(/^Design converted from markdown: 3 rules became criterion sentences, the API contract off, the screen contract off, the sequence diagram off/);
  });

  it('uploads the starter, whose Design is a design phase with the API contract on and the sequence diagram off', async () => {
    const made = await upload('Starter design', zipWith({}, STARTER_DIR));
    // the starter is in the folder layout with every brief plain, and its Deployment and Maintenance carry their
    // records: the door converts nothing and says nothing
    expect(made.warnings).toBeUndefined();
    const task = await designTask(made.projectId, made.versionId);
    expect(task.checkKind).toBe('design');
    expect(task.design?.contracts).toEqual({ api: true, screens: false });
    expect(task.design?.sequence).toBe(false);
    expect(task.design?.stories.map((s) => s.id)).toEqual(['SH-1', 'SH-2', 'SH-3']);
  });

  /* The design-pack door: each refusal is NOT_A_PACK with a fixed sentence in its detail. */

  const LONG_ID = `E${'7'.repeat(40)}`;
  const BODY_TEXT = 'a sentence only the file body holds, never the refusal';
  it.each([
    ['a design-kind Requirements phase', 'phases/01-requirements/phase.json', (phase: Record<string, any>) => ({ ...phase, artifactKind: 'design', checks: { kind: 'design' } }), {}, 'Only the Design phase can use the design kind.'],
    ['a record at another path', DESIGN_PHASE, (phase: Record<string, any>) => ({ ...phase, checks: { ...phase.checks, record: 'design/mine.json' } }), {}, 'The design record is always design/design.json.'],
    ['a story id over the cap', DESIGN_PHASE, (phase: Record<string, any>) => ({ ...phase, checks: { ...phase.checks, stories: [{ id: 'S'.repeat(17), title: 't', line: 'l' }] } }), {}, 'A story id is longer than 16 characters.'],
    // a mount is the file at its workspace path under files/, so these two edit no phase.json
    ['a mounted markdown file', DESIGN_PHASE, (phase: Record<string, any>) => phase, { 'phases/02-design/files/design/notes.md': '# notes' }, 'A Design phase mounts no markdown file: design/notes.md.'],
    ['a contract that is switched off but mounted', DESIGN_PHASE, (phase: Record<string, any>) => phase, { [`phases/02-design/files/${SCREEN_CONTRACT_JSON}`]: '{ "screens": [] }' }, `${SCREEN_CONTRACT_JSON} is mounted, but that contract is switched off.`],
  ])('refuses %s at the upload door, NOT_A_PACK with the fixed sentence in detail', async (_n, name, edit, extra, sentence) => {
    const entries = entriesOf(STARTER_DIR).map((entry) =>
      entry.name === name ? { name, data: Buffer.from(JSON.stringify(edit(JSON.parse(entry.data.toString('utf8'))), null, 2)) } : entry,
    );
    for (const [at, text] of Object.entries(extra)) entries.push({ name: at, data: Buffer.from(text) });
    const response = await refusalOf(writeZip(entries));
    expect(response).toMatchObject({ code: 'NOT_A_PACK', detail: expect.stringContaining(sentence.replace(/\.$/, '')) });
  });

  it('reads a Design brief kept in a file in an older archive inline, once, at the upload door', async () => {
    // the frozen older Shelf, its Design brief moved from taskPanel to a task.md the phase names
    const entries = entriesOf(OLDER_SHELF).map((entry) => {
      if (entry.name !== DESIGN_PHASE) return entry;
      const { taskPanel: _panel, ...phase } = JSON.parse(entry.data.toString('utf8'));
      return { name: DESIGN_PHASE, data: Buffer.from(JSON.stringify({ ...phase, taskFile: 'task.md' }, null, 2)) };
    });
    entries.push({ name: 'phases/02-design/task.md', data: Buffer.from('# Design\n\nRecord the design.\n') });
    const made = await upload('Design brief in a file', writeZip(entries));
    expect((made.warnings ?? [])[0]).toBe(OLDER_LAYOUT_WARNING);
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.versionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'design')!.taskPanel).toBe('Design\n\nRecord the design.');
  });

  it.each([
    ['an entity id over the cap', { ...EMPTY_DESIGN, entities: [{ id: LONG_ID, name: BODY_TEXT, kind: 'class', attributes: [], responsibilities: [], satisfies: [] }] }, 'entity 1 has an id longer than 16 characters'],
    ['a relation pointing at text that is no entity', {
      ...EMPTY_DESIGN,
      entities: [{ id: 'E1', name: 'Book', kind: 'class', attributes: [], responsibilities: [], satisfies: [] }],
      relations: [{ id: 'R1', from: 'E1', to: `${LONG_ID} ${BODY_TEXT}`, kind: 'association' }],
    }, 'relation R1 points at an id longer than 16 characters, which is not an entity'],
    // the door's own JSON sentence, never the parser's excerpt
    ['a record that is not JSON', `{ "notes": "${BODY_TEXT}"`, 'A JSON file the phase phases/02-design reads is not valid JSON'],
  ])('refuses a starting record with %s, quoting no more than 16 characters of an id and no byte of the body', async (_n, record, sentence) => {
    // the starting record mounted editable at its workspace path under files/
    const entries = entriesOf(STARTER_DIR);
    entries.push({ name: `phases/02-design/files/${DESIGN_JSON}`, data: Buffer.from(typeof record === 'string' ? record : JSON.stringify(record)) });
    const response = await refusalOf(writeZip(entries));
    expect(response).toMatchObject({ code: 'NOT_A_PACK', detail: expect.stringContaining(sentence) });
    const detail = String(response.detail);
    expect(detail).not.toContain(LONG_ID.slice(0, 17));
    expect(detail).not.toContain(BODY_TEXT);
  });
});

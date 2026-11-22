// The harness is story-task.spec.ts's: TaskTrackr imported into an in-memory
// database, then copied by a teacher, whose draft is what `updateTask` edits.
//
// Every Design phase that starts in the older (markdown) format is written by
// hand from entity rows (`writeMarkdownDesign`), never taken from a fresh copy:
// a copy is converted as it is made (once the copy conversion lands), so the
// older-format cases would otherwise stop being older-format.
import 'reflect-metadata';
import { readFileSync } from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import {
  DEFAULT_DESIGN_FLOOR,
  EMPTY_API_CONTRACT,
  EMPTY_DESIGN,
  serialiseDesign,
  validateDesignRecord,
} from '@learnsdlc/shared';
import { config } from '../config';
import { blobShaFor } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import { ProjectImporterService } from '../content/importer.service';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import {
  ContentBlobEntity,
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import { FIXTURE_QUIZ_NOTICE, fixtureQuizQuestions } from '../../test/quiz-fixture';
import { ReplaceFileDto, UpdateTaskDto } from './authoring.dto';
import { AuthoringService } from './authoring.service';
import { memoryDataSource } from '../../test/support/memory-db';

const caller = { id: 'teacher-1', role: 'INSTRUCTOR' as const, cohort: 'default' };

/** TaskTrackr 3.0.0's markdown Design, as files and phase.json (the adapter spec reads the same folder). */
const LEGACY = path.join(__dirname, '../../test/fixtures/legacy-design');
const LEGACY_PHASE = JSON.parse(readFileSync(path.join(LEGACY, 'phase.json'), 'utf8'));
const LEGACY_FILES: { path: string; source: string; editable: boolean }[] = [
  { path: 'requirements/provided-stories.md', source: 'provided-stories.md', editable: false },
  { path: 'design/architecture.md', source: 'architecture.md', editable: false },
  { path: 'design/my-design.md', source: 'my-design.md', editable: true },
  { path: 'design/design.json', source: 'design.json', editable: true },
  { path: 'shared/contract/api.json', source: 'api.json', editable: true },
  { path: 'shared/contract/screens.json', source: 'screens.json', editable: true },
];

const body = {
  design: { contracts: { api: true, screens: true }, sequence: true, stories: [{ id: 'SH-1', title: 'Browse the shelf', line: 'As a member, I want to browse.' }], floor: { ...DEFAULT_DESIGN_FLOOR, minEntities: 3 } },
  rubric: { passThreshold: 70, criteria: [{ key: 'model', title: 'Model', description: 'Entities serve the stories.', weight: 0.6 }, { key: 'contract', title: 'Contract', description: 'Every refusal is declared.', weight: 0.4 }] },
};

describe('a Design task through the editor', () => {
  let dataSource: DataSource;
  let service: AuthoringService;
  let importedVersionId = '';
  let projectId = '';
  let versionId = '';
  let projectId2 = '';
  let versionId2 = '';

  const phaseRow = (vid: string) =>
    dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: vid, key: 'design' });
  const designRows = async (vid: string) => {
    const phase = await phaseRow(vid);
    return dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, role: 'workspace' });
  };
  const designPaths = async (vid: string) => (await designRows(vid)).map((row) => row.path).sort();
  const bytesAt = async (vid: string, at: string) => {
    const row = (await designRows(vid)).find((one) => one.path === at)!;
    return (await dataSource.getRepository(ContentBlobEntity).findOneByOrFail({ sha: row.blobSha })).bytes;
  };
  const insertRow = async (vid: string, phaseId: string, at: string, bytes: string, editable: boolean) => {
    const sha = blobShaFor(bytes);
    await dataSource.createQueryBuilder().insert().into(ContentBlobEntity)
      .values({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') }).orIgnore().execute();
    await dataSource.getRepository(ProjectFileEntity).insert({
      projectVersionId: vid, ownerKind: 'phase', ownerId: phaseId, path: at, role: 'workspace', editable,
      language: at.endsWith('.json') ? 'json' : 'markdown', blobSha: sha,
    });
  };

  /**
   * The rubric the hand-written markdown task carries: TaskTrackr's own pack
   * criteria (the same keys, titles and weights 3.0.0 shipped), so the
   * wording the conversion compares with the pack reads as the pack's, never
   * as a teacher's.
   */
  let packRubric: unknown = null;

  /** The copy's Design phase, rewritten by hand into TaskTrackr 3.0.0's markdown task and its six files, under the pack's criteria. */
  const writeMarkdownDesign = async (vid: string) => {
    const phase = await phaseRow(vid);
    // the retired kind, as an older stored row holds it (no product type names it)
    await dataSource.getRepository(ProjectPhaseEntity).update({ id: phase.id }, { artifactKind: 'markdown' as never });
    await dataSource.getRepository(ProjectTaskEntity).update(
      { projectPhaseId: phase.id, taskKey: 'main' },
      { checks: LEGACY_PHASE.checks, rubric: packRubric as never, artefactType: 'design-doc', artefactPath: 'design/my-design.md' },
    );
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, role: 'workspace' });
    for (const one of LEGACY_FILES) {
      await insertRow(vid, phase.id, one.path, readFileSync(path.join(LEGACY, one.source), 'utf8'), one.editable);
    }
  };

  const copy = async (slug: string) => {
    const made = await service.createProject(caller, { title: slug, slug, fromVersionId: importedVersionId });
    return { pid: made.project.id, vid: made.draftVersionId };
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    dataSource = await memoryDataSource();
    const content = new ContentService();
    const importer = new ProjectImporterService(content, dataSource);
    const registry = new ProjectRegistryService(content, dataSource, {
      importedContent: [],
    } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    const imported = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), {
      origin: 'seed',
      platformOwned: true,
    });
    await dataSource.getRepository(ProjectEntity).update({ id: imported.projectId }, { isDefault: true });
    await registry.load();
    packRubric = content.getProject('tasktrackr').phases.find((one) => one.key === 'design')!.rubric;
    // the keys, titles and weights the legacy rules grade into are the pack's own
    expect((packRubric as { criteria: { key: string; title: string; weight: number }[] }).criteria.map(({ key, title, weight }) => ({ key, title, weight })))
      .toEqual(LEGACY_PHASE.rubric.criteria.map(({ key, title, weight }: { key: string; title: string; weight: number }) => ({ key, title, weight })));
    service = new AuthoringService(dataSource, importer, registry);
    importedVersionId = imported.projectVersionId;

    ({ pid: projectId, vid: versionId } = await copy('design-edit'));
    await writeMarkdownDesign(versionId);
    // the second copy is left in the older format for the cases that read it so
    ({ pid: projectId2, vid: versionId2 } = await copy('design-older'));
    await writeMarkdownDesign(versionId2);
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('converts the markdown Design on the first design save, and stores the floor, stories and weights', async () => {
    const view = await service.updateTask(caller, projectId, versionId, 'design', 'main', body as never);
    const task = view.phase.tasks.find((t) => t.checkKind === 'design')!;
    expect(task.design?.floor.minEntities).toBe(3);
    expect(task.design?.sequence).toBe(true);
    expect(task.design?.stories[0].id).toBe('SH-1');
    expect(task.rubric.criteria.map((c) => c.weight)).toEqual([0.6, 0.4]);
    expect(task.artefactPath).toBeNull();
    expect(task.artefactType).toBe('design-doc');
    expect(task.designOlderFormat).toBeUndefined();
    expect(await designPaths(versionId)).toEqual(['design/design.json', 'shared/contract/api.json', 'shared/contract/screens.json']);
    // the board's older record is folded as it converts
    expect(validateDesignRecord(await bytesAt(versionId, 'design/design.json')).design!.entities[0].name).toBe('Model');
    expect((await phaseRow(versionId)).artifactKind).toBe('design');
    // and the draft compiles to a design phase
    const report = await service.validate(caller, projectId, versionId);
    expect(report.blocking).toEqual([]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    const phase = version.compiled!.content.phases.find((one) => one.key === 'design')!;
    expect(phase.checks.kind === 'design' && phase.checks.floor.minEntities).toBe(3);
  });

  it('removes a contract row when its switch goes off, and seeds it again when it comes back on', async () => {
    await service.updateTask(caller, projectId, versionId, 'design', 'main', { ...body, design: { ...body.design, contracts: { api: true, screens: false } } } as never);
    expect(await designPaths(versionId)).toEqual(['design/design.json', 'shared/contract/api.json']);
    await service.updateTask(caller, projectId, versionId, 'design', 'main', body as never);
    expect(await designPaths(versionId)).toEqual(['design/design.json', 'shared/contract/api.json', 'shared/contract/screens.json']);
    expect(await bytesAt(versionId, 'shared/contract/screens.json')).toBe('{\n  "screens": []\n}\n');
  });

  it('takes the tail a story task takes: a rubric replaced whole, then reworded, the words and the sign-off mark', async () => {
    const { pid, vid } = await copy('design-tail');
    await writeMarkdownDesign(vid);
    const view = await service.updateTask(caller, pid, vid, 'design', 'main', {
      ...body,
      title: 'Design the shelf',
      criteria: [{ key: 'contract', title: 'Refusals', description: 'Every refusal is declared with its code.' }],
      signOff: true,
    } as never);
    const task = view.phase.tasks.find((t) => t.taskKey === 'main')!;
    expect(task.title).toBe('Design the shelf');
    expect(task.rubric.criteria.map((c) => [c.key, c.title, c.weight])).toEqual([['model', 'Model', 0.6], ['contract', 'Refusals', 0.4]]);
    expect(task.rubric.criteria[1].description).toBe('Every refusal is declared with its code.');
    expect(task.signOff).toBe(true);
  });

  it.each([
    ['13 stories', { design: { ...body.design, stories: Array.from({ length: 13 }, (_, i) => ({ id: `SH-${i}`, title: 't', line: 'l' })) } }, 'stories'],
    ['a floor out of range', { design: { ...body.design, floor: { ...DEFAULT_DESIGN_FLOOR, minDecisions: 11 } } }, 'minDecisions'],
    ['a sequence switch that is not boolean', { design: { ...body.design, sequence: 'on' } }, 'sequence'],
    ['a body with no sequence switch', { design: { contracts: body.design.contracts, stories: body.design.stories, floor: body.design.floor } }, 'sequence'],
    ['a story body', { story: { providedStories: [], learnerStory: { id: 'US-4', hints: {} }, floor: { minCriteria: 2, requiredTags: [], minExclusions: 1, requireSentence: true } } }, 'A story task belongs to the Requirements phase.'],
    ['weights off', { rubric: { passThreshold: 70, criteria: [{ key: 'a', title: 'A', description: 'd', weight: 0.7 }] } }, 'Weights must sum to 1'],
  ])('refuses %s', async (_n, extra, message) => {
    await expect(service.updateTask(caller, projectId, versionId, 'design', 'main', { ...body, ...extra } as never)).rejects.toThrow(message);
  });

  it('never lets rules or a word floor through the whitelist: no task body carries them', async () => {
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    const sent = plainToInstance(UpdateTaskDto, { rules: [{ id: 'r', label: 'l', criterion: 'model', pattern: 'x', required: true, failDetail: 'f' }], minWords: 50, minWordsCriterion: 'model' });
    expect((await validate(sent, strict)).map((e) => e.property).sort()).toEqual(['minWords', 'minWordsCriterion', 'rules']);
  });

  it('lets the design body through the whitelist, and holds its caps there too', async () => {
    const strict = { whitelist: true, forbidNonWhitelisted: true };
    expect(await validate(plainToInstance(UpdateTaskDto, body), strict)).toEqual([]);
    const { sequence: _gone, ...noSequence } = body.design;
    const bad = plainToInstance(UpdateTaskDto, { design: { ...noSequence, floor: { ...DEFAULT_DESIGN_FLOOR, minScreens: 21 } } });
    expect((await validate(bad, strict)).map((e) => e.property)).toEqual(['design']);
  });

  it('refuses a design body outside Design, and a second written task in a converted Design', async () => {
    // its own copy, converted here, so the case holds when it runs alone
    const { pid, vid } = await copy('design-second');
    await writeMarkdownDesign(vid);
    await service.updateTask(caller, pid, vid, 'design', 'main', body as never);
    await expect(service.updateTask(caller, pid, vid, 'requirements', 'main', body as never)).rejects.toThrow('A design task belongs to the Design phase.');
    await expect(service.addTask(caller, pid, vid, 'design', { taskKey: 'countersign', title: 'Heard', brief: 'Write what the member asked.', artefactType: 'document', rules: [] } as never))
      .rejects.toThrow('A Design phase holds one task. Edit its design in the builder.');
  });

  it('shows a markdown Design task already converted, marks it as the older format, and writes nothing', async () => {
    const draft = await service.readDraft(caller, projectId2, versionId2);
    const task = draft.phases.find((p) => p.key === 'design')!.tasks[0];
    expect(task.designOlderFormat).toBe(true);
    expect(task.design?.contracts).toEqual({ api: true, screens: true });
    expect(task.design?.sequence).toBe(false);
    expect(task.design?.stories).toEqual([]);
    expect(task.rubric.criteria.find((c) => c.key === 'screen_contract')!.description).toBe('The overdue screen names its component, its operation and its empty state.');
    // read only: the rows are still the older format
    const row = await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: (await phaseRow(versionId2)).id, taskKey: 'main' });
    expect(row.checks.kind).toBe('markdown');
    expect(await designPaths(versionId2)).toContain('design/my-design.md');
  });

  it('replaces the starting record through the files door, stored as validated, and refuses a bad document in the shared sentence', async () => {
    await service.replaceFile(caller, projectId, versionId, 'design', { path: 'design/design.json', content: '{"entities":[],"relations":[],"operations":[],"decisions":[],"extra":1}' });
    expect(await bytesAt(versionId, 'design/design.json')).toBe(serialiseDesign(EMPTY_DESIGN));
    await expect(service.replaceFile(caller, projectId, versionId, 'design', { path: 'shared/contract/api.json', content: '{}' }))
      .rejects.toThrow('The starting API contract is not valid: The API contract has no operations list.');
    await expect(service.replaceFile(caller, projectId, versionId, 'design', { path: 'design/design.json', content: '{"entities":1}' }))
      .rejects.toThrow('The starting design record is not valid:');
    await service.replaceFile(caller, projectId, versionId, 'design', { path: 'shared/contract/api.json', content: EMPTY_API_CONTRACT });
    expect(await bytesAt(versionId, 'shared/contract/api.json')).toBe(EMPTY_API_CONTRACT);
    // a markdown Design's documents are still the room's: the door opens only for a design task
    await expect(service.replaceFile(caller, projectId2, versionId2, 'design', { path: 'design/design.json', content: serialiseDesign(EMPTY_DESIGN) }))
      .rejects.toThrow('is the record the room builds');
  });

  it('resets a starting document to the bytes of the version the draft was opened from, folded when older', async () => {
    await service.replaceFile(caller, projectId, versionId, 'design', { path: 'design/design.json', content: '{"entities":[],"relations":[],"operations":[],"decisions":[],"notes":"mine"}' });
    await service.replaceFile(caller, projectId, versionId, 'design', { path: 'design/design.json', reset: 'source' } as never);
    const record = JSON.parse(await bytesAt(versionId, 'design/design.json'));
    expect(record.notes ?? '').not.toBe('mine');
    expect(record.operations.map((o: { id: string }) => o.id)).toEqual(['O1', 'O2', 'O3']);
    expect(record.entities[0]).toMatchObject({ name: 'Model', kind: 'class' });
    // the draft says where it was opened from, so the editor draws the reset only where there is one
    expect((await service.readDraft(caller, projectId, versionId)).forkedFromVersionId).toBe(importedVersionId);
  });

  it('refuses a reset on a draft opened from nothing, and a body with neither bytes nor a reset', async () => {
    const { pid, vid } = await copy('design-reset-none');
    await service.updateTask(caller, pid, vid, 'design', 'main', body as never);
    await expect(service.replaceFile(caller, pid, vid, 'design', { path: 'design/design.json' } as never)).rejects.toThrow('cannot be empty');
    await dataSource.getRepository(ProjectVersionEntity).update({ id: vid }, { forkedFromVersionId: null });
    await expect(service.replaceFile(caller, pid, vid, 'design', { path: 'design/design.json', reset: 'source' } as never))
      .rejects.toThrow('This draft was not opened from another version, so there is nothing to reset to.');
    expect((await service.readDraft(caller, pid, vid)).forkedFromVersionId).toBeNull();
  });

  it('takes a reset body without content at the DTO, and still holds the content cap', async () => {
    const errorsOf = async (plain: object) => validate(plainToInstance(ReplaceFileDto, plain));
    expect(await errorsOf({ path: 'design/design.json', reset: 'source' })).toEqual([]);
    expect((await errorsOf({ path: 'design/design.json' })).map((e) => e.property)).toEqual(['content']);
    expect((await errorsOf({ path: 'design/design.json', reset: 'pack' })).map((e) => e.property)).toEqual(['reset']);
  });

  it("keeps the teacher's own criterion wording in front of its rule sentences, in the view and through the conversion", async () => {
    const { pid, vid } = await copy('design-wording');
    await writeMarkdownDesign(vid);
    // reworded through the criteria door while the task is still markdown
    await service.updateTask(caller, pid, vid, 'design', 'main', { criteria: [{ key: 'traceability', title: 'Every story lands', description: 'Each story is named where it is served' }] } as never);
    const expected = 'Each story is named where it is served. US-2 lands somewhere in the design. US-3 lands somewhere in the design. US-4 lands somewhere in the design.';
    const shown = (await service.readDraft(caller, pid, vid)).phases.find((p) => p.key === 'design')!.tasks[0];
    expect(shown.designOlderFormat).toBe(true);
    expect(shown.rubric.criteria.find((c) => c.key === 'traceability')).toMatchObject({ title: 'Every story lands', description: expected });
    // the pack's own wording is not the teacher's: it becomes the rule sentences alone
    expect(shown.rubric.criteria.find((c) => c.key === 'data_model')!.description).toBe('The tasks entity carries a due date and a status. A task points at the list it belongs to. Tags and tasks are joined, not stored on the task.');
    const { rubric: _rubric, ...noRubric } = body;
    await service.updateTask(caller, pid, vid, 'design', 'main', noRubric as never);
    const row = await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: (await phaseRow(vid)).id, taskKey: 'main' });
    expect(row.checks.kind).toBe('design');
    expect(row.rubric.criteria.find((c) => c.key === 'traceability')).toMatchObject({ title: 'Every story lands', description: expected });
    expect(row.rubric.criteria.find((c) => c.key === 'data_model')!.description).toBe(shown.rubric.criteria.find((c) => c.key === 'data_model')!.description);
  });

  it('refuses the conversion of a markdown Design holding a second written task, and changes nothing', async () => {
    const { pid, vid } = await copy('design-two');
    await writeMarkdownDesign(vid);
    const phase = await phaseRow(vid);
    const main = await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ projectPhaseId: phase.id, taskKey: 'main' });
    await dataSource.getRepository(ProjectTaskEntity).insert({ ...main, id: undefined, taskKey: 'notes', order: 2, artefactPath: 'design/notes.md' });
    await expect(service.updateTask(caller, pid, vid, 'design', 'main', body as never))
      .rejects.toThrow('This Design task cannot be converted: the Design phase holds another written task beside the design, and a design phase cannot.');
    expect((await dataSource.getRepository(ProjectTaskEntity).findOneByOrFail({ id: main.id })).checks.kind).toBe('markdown');
  });

  it('converts a read-only mounted contract into an editable one, since the design task grades it', async () => {
    const { pid, vid } = await copy('design-readonly');
    await writeMarkdownDesign(vid);
    const phase = await phaseRow(vid);
    await dataSource.getRepository(ProjectFileEntity).update({ projectVersionId: vid, ownerId: phase.id, path: 'shared/contract/screens.json' }, { editable: false });
    await service.updateTask(caller, pid, vid, 'design', 'main', body as never);
    const rows = await designRows(vid);
    expect(rows.map((row) => [row.path, row.editable, row.language]).sort()).toEqual([
      ['design/design.json', true, 'json'],
      ['shared/contract/api.json', true, 'json'],
      ['shared/contract/screens.json', true, 'json'],
    ]);
    expect(await bytesAt(vid, 'shared/contract/screens.json')).toBe(readFileSync(path.join(LEGACY, 'screens.json'), 'utf8'));
  });

  it('leaves a kept row with no language as it was: the conversion compares with the bytes it read, where none reads as markdown', async () => {
    const { pid, vid } = await copy('design-null-language');
    await writeMarkdownDesign(vid);
    const phase = await phaseRow(vid);
    await insertRow(vid, phase.id, 'design/glossary.txt', 'Shelf: the list of books a member holds.\n', false);
    await dataSource.getRepository(ProjectFileEntity).update({ projectVersionId: vid, ownerId: phase.id, path: 'design/glossary.txt' }, { language: null as never });
    const before = (await designRows(vid)).find((row) => row.path === 'design/glossary.txt')!;
    await service.updateTask(caller, pid, vid, 'design', 'main', body as never);
    const after = (await designRows(vid)).find((row) => row.path === 'design/glossary.txt')!;
    expect(after.language).toBeNull();
    expect([after.blobSha, after.editable]).toEqual([before.blobSha, before.editable]);
  });

  it('keeps the design checks on the phase with a concept quiz beside the design task', async () => {
    const { pid, vid } = await copy('design-quiz');
    await writeMarkdownDesign(vid);
    await service.updateTask(caller, pid, vid, 'design', 'main', body as never);
    await service.addTask(caller, pid, vid, 'design', {
      taskKey: 'concepts', title: 'Design concepts', brief: FIXTURE_QUIZ_NOTICE, artefactType: 'quiz', required: false,
      quiz: { questions: fixtureQuizQuestions(5), criterion: 'design-concepts' },
    } as never);
    await service.updateTask(caller, pid, vid, 'design', 'main', { ...body, design: { ...body.design, floor: { ...DEFAULT_DESIGN_FLOOR, minEntities: 4 } } } as never);
    const report = await service.validate(caller, pid, vid);
    expect(report.blocking).toEqual([]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: vid });
    const phase = version.compiled!.content.phases.find((one) => one.key === 'design')!;
    expect(phase.checks.kind).toBe('design');
    expect(phase.checks.kind === 'design' && phase.checks.floor.minEntities).toBe(4);
    expect(phase.rubric.criteria.map((one) => one.key)).toEqual(['model', 'contract']);
    const tasks = version.compiled!.phases.find((one) => one.key === 'design')!.tasks;
    expect(tasks.find((one) => one.taskKey === 'concepts')!.checkKind).toBe('quiz');
    expect(tasks.find((one) => one.taskKey === 'main')!.checkKind).toBe('design');
  });

  it('refuses at compile a switched-off contract that is still mounted, and seeds a missing record', async () => {
    const { pid, vid } = await copy('design-compile');
    await writeMarkdownDesign(vid);
    await service.updateTask(caller, pid, vid, 'design', 'main', { ...body, design: { ...body.design, contracts: { api: true, screens: false } } } as never);
    const phase = await phaseRow(vid);
    // written by hand: no door mounts a contract that is off, or drops the record
    await insertRow(vid, phase.id, 'shared/contract/screens.json', '{\n  "screens": []\n}\n', true);
    const report = await service.validate(caller, pid, vid);
    expect(JSON.stringify(report.blocking)).toContain('shared/contract/screens.json is mounted, but that contract is switched off.');
    // the files door names the switch rather than calling the contract the room's record
    await expect(service.replaceFile(caller, pid, vid, 'design', { path: 'shared/contract/screens.json', content: '{\n  "screens": []\n}\n' }))
      .rejects.toThrow('The screen contract is switched off for this task; turn it on in step 3 or remove the file.');
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerId: phase.id, path: 'shared/contract/screens.json' });
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerId: phase.id, path: 'design/design.json' });
    expect((await service.validate(caller, pid, vid)).blocking).toEqual([]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: vid });
    const files = version.compiled!.content.phases.find((one) => one.key === 'design')!.files;
    expect(files.map((f) => f.path)).toEqual(['design/design.json', 'shared/contract/api.json']);
    expect(files[0].content).toBe(serialiseDesign(EMPTY_DESIGN));
  });

  it('names a switched-off API contract on the files door too', async () => {
    const { pid, vid } = await copy('design-api-off');
    await writeMarkdownDesign(vid);
    await service.updateTask(caller, pid, vid, 'design', 'main', { ...body, design: { ...body.design, contracts: { api: false, screens: true } } } as never);
    await insertRow(vid, (await phaseRow(vid)).id, 'shared/contract/api.json', EMPTY_API_CONTRACT, true);
    await expect(service.replaceFile(caller, pid, vid, 'design', { path: 'shared/contract/api.json', content: EMPTY_API_CONTRACT }))
      .rejects.toThrow('The API contract is switched off for this task; turn it on in step 3 or remove the file.');
  });

  it('adds a design task to a Design phase that holds none, with its record and its API contract', async () => {
    const { pid, vid } = await copy('design-add');
    const phase = await phaseRow(vid);
    // written by hand: no door empties a phase of its last task
    await dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id });
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, role: 'workspace' });
    const view = await service.addTask(caller, pid, vid, 'design', { taskKey: 'shelf', title: 'Design the shelf', brief: 'Model the shelf.' } as never);
    const task = view.phase.tasks.find((t) => t.taskKey === 'shelf')!;
    expect(task.checkKind).toBe('design');
    expect(task.artefactType).toBe('design-doc');
    expect(task.artefactPath).toBeNull();
    expect(task.design).toMatchObject({ contracts: { api: true, screens: false }, sequence: false, stories: [], floor: DEFAULT_DESIGN_FLOOR });
    expect(task.rubric.criteria).toEqual([{ key: 'design', title: 'The design', description: 'The design serves every story it lists, and every decision says why.', weight: 1 }]);
    expect(await designPaths(vid)).toEqual(['design/design.json', 'shared/contract/api.json']);
    expect(await bytesAt(vid, 'design/design.json')).toBe(serialiseDesign(EMPTY_DESIGN));
    expect(await bytesAt(vid, 'shared/contract/api.json')).toBe(EMPTY_API_CONTRACT);
    // the phase is a design phase, as a conversion leaves it, so the compile and the export carry that kind
    expect((await phaseRow(vid)).artifactKind).toBe('design');
    expect((await service.validate(caller, pid, vid)).blocking).toEqual([]);
    const version = await dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: vid });
    expect(version.compiled!.content.phases.find((one) => one.key === 'design')!.checks.kind).toBe('design');
    expect(version.compiled!.phases.find((one) => one.key === 'design')!.tasks.find((one) => one.taskKey === 'shelf')!.checkKind).toBe('design');
  });

  it.each([
    ['a quiz with no questions', 'quiz', 'A quiz task is scored by the questions you write, and this one carries none.'],
    ['a code task', 'code', 'A Design phase holds a design task, so its type is design-doc; a code task cannot be added there.'],
  ])('refuses %s as the design task of an empty Design phase, and adds nothing', async (_n, artefactType, message) => {
    const { pid, vid } = await copy(`design-add-${artefactType}`);
    const phase = await phaseRow(vid);
    await dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id });
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, role: 'workspace' });
    await expect(service.addTask(caller, pid, vid, 'design', { taskKey: 'shelf', title: 'Design the shelf', brief: 'Model the shelf.', artefactType } as never))
      .rejects.toThrow(message);
    expect(await dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id })).toEqual([]);
  });

  it('adds a design task given the document type, as design-doc', async () => {
    const { pid, vid } = await copy('design-add-document');
    const phase = await phaseRow(vid);
    await dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: phase.id });
    await dataSource.getRepository(ProjectFileEntity).delete({ projectVersionId: vid, ownerKind: 'phase', ownerId: phase.id, role: 'workspace' });
    const view = await service.addTask(caller, pid, vid, 'design', { taskKey: 'shelf', title: 'Design the shelf', brief: 'Model the shelf.', artefactType: 'document' } as never);
    const task = view.phase.tasks.find((t) => t.taskKey === 'shelf')!;
    expect([task.checkKind, task.artefactType]).toEqual(['design', 'design-doc']);
  });
});

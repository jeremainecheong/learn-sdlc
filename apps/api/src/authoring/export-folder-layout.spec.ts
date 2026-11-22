import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { In } from 'typeorm';
import {
  CHANGE_REQUEST_JSON,
  EMPTY_RUNBOOK,
  INHERITED_TASK_KEY,
  RUNBOOK_JSON,
  type QuizChecks,
  SEALED_FILE_ROLES,
  STORY_JSON,
  compareMountPaths,
  plainTextOf,
  serialiseRunbook,
  type PhaseKey,
} from '@learnsdlc/shared';
import { config } from '../config';
import { AuditEventEntity } from '../db/entities';
import { blobShaFor, canonicalJson } from '../content/blob.store';
import { ProjectImporterService } from '../content/importer.service';
import { LAYOUT_SENTENCES } from '../content/folder-layout';
import { layoutFromManifest } from '../content/legacy-layout';
import { MemoryPackSource, packRootOf } from '../content/memory-pack-source';
import { DirectoryPackSource, type PackSource } from '../content/pack-source';
import type { CompiledTask } from '../content/pack-compiler';
import { ContentBlobEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { readZip, zipLimits, type ArchiveEntry } from '../content/zip-reader';
import { copyTaskTrackr, openForkWorld, S1_TEACHER, type ForkWorld } from '../../test/tasktrackr-phase';
import { recordPack } from '../../test/record-pack';
import { hostQuizBody } from '../../test/written-phase-pack';
import { olderTaskTrackrPack } from '../../test/legacy-phase';
import { codeFolder, projectJson, storyFolder, designFolder, type PackFiles } from '../../test/fixtures/folder-packs';
import { entriesOf, writeZip, type ZipEntrySpec } from '../../test/fixtures/upload-packs/archive';
import { SHELF_DIR } from '../../test/fixtures/upload-packs/markers';
import { EXPORT_REFUSALS, ExportService, mountDrift } from './export.service';
import { QUIZ_OPTION_BLANK } from './quiz-rows';
import { UploadService } from './upload.service';

/**
 * Export writes the folder layout and every edit: one
 * `phases/<NN>-<key>/` folder per phase the version holds, `NN` its
 * place; every mount under `files/` or `readonly/` at its workspace path in
 * every phase that mounts it, and no `canonical/`; `phase.json` written from
 * the version's compiled work task, every text plain; each quiz as
 * `quizzes/<task key>.json`; and every archive read back through the upload
 * door's own pipeline, which must compile to the task list the version holds.
 *
 * The world is `openForkWorld`'s (an in-memory database with TaskTrackr
 * seeded as the platform's project), the export and the real upload door
 * over the real importer. Every fixture is read, never written.
 */

const TEACHER = { id: 'teacher-folder-export', email: 'teacher@folder-export.test', role: 'INSTRUCTOR' as const, cohort: 'default' };
const TASKTRACKR = path.join(config.contentDir, 'tasktrackr');

/** Each entry's name under the archive's pack root, with its bytes. */
function entriesUnderRoot(archive: Buffer): Map<string, Buffer> {
  const entries = readZip(archive, zipLimits(config.importMaxBytes));
  const root = packRootOf(entries);
  const prefix = root ? `${root}/` : '';
  return new Map(entries.filter((one) => one.name.startsWith(prefix)).map((one) => [one.name.slice(prefix.length), one.bytes]));
}
const namesOf = (archive: Buffer): string[] => [...entriesUnderRoot(archive).keys()];
const textAt = (archive: Buffer, name: string): string => {
  const bytes = entriesUnderRoot(archive).get(name);
  if (!bytes) throw new Error(`the archive holds no ${name}`);
  return bytes.toString('utf-8');
};
const jsonAt = (archive: Buffer, name: string): Record<string, any> => JSON.parse(textAt(archive, name));
/** The phase folders an archive holds, in name order. */
const phaseFolders = (archive: Buffer): string[] =>
  [...new Set(namesOf(archive).filter((name) => name.startsWith('phases/')).map((name) => name.split('/').slice(0, 2).join('/')))].sort();

const zipOf = (files: PackFiles): Buffer => writeZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf-8') })));

/**
 * TaskTrackr as a teacher's archive of it: `content/tasktrackr`, 6.0.0 in the
 * folder layout, leaving out `warmup/` (an upload holds no warm-up) and the
 * maintainers' `canonical/` (a folder-layout archive holds none), and
 * `project.json`'s `warmup` member should one be there.
 */
function tasktrackrEntries(): ZipEntrySpec[] {
  return entriesOf(TASKTRACKR)
    .filter((entry) => !entry.name.startsWith('warmup/') && !entry.name.startsWith('canonical/'))
    .map((entry) => {
      if (entry.name !== 'project.json') return entry;
      const { warmup: _warmup, ...meta } = JSON.parse(entry.data.toString('utf-8'));
      return { name: entry.name, data: Buffer.from(JSON.stringify(meta, null, 2)) };
    });
}

/** Shelf as it shipped in the older layout, its briefs markdown, frozen before the Shelf family moved to the folder layout. */
const OLDER_SHELF = path.resolve(__dirname, '../../test/fixtures/older-shelf');

/**
 * An older pack as an import stored it before texts were kept plain: its briefs markdown, no door
 * run over it. The loader reads only the folder layout, so the pack is
 * converted once (`layoutFromManifest`), which moves each brief into its
 * phase's taskPanel as written and keeps the markdown.
 */
const storedInOlderLayout = (older: PackSource): MemoryPackSource => layoutFromManifest(older).source;

/** A teacher's text as the upload door stores it, and so as the export writes it: trimmed, plain, then trimmed again. */
const stored = (text: string): string => plainTextOf(text.trim()).trim();

/** A quiz's paper as the round trip compares it: every question's stem, option texts, explanation and concept as the door stores them. */
function paperAsStored(paper: QuizChecks): QuizChecks {
  return {
    ...paper,
    questions: paper.questions.map((question) => ({
      ...question,
      stem: stored(question.stem),
      options: question.options.map((option) => ({ ...option, text: stored(option.text) })),
      explanation: stored(question.explanation),
      ...(typeof question.concept === 'string' ? { concept: stored(question.concept) } : {}),
    })),
  };
}

/**
 * A compiled task as the round trip compares it: the sole task's
 * key either way, its owned paths in path order, its texts as the door
 * stores them (`stored`); the checks are the archive's, read back by the loader.
 */
function comparable(task: CompiledTask): Record<string, unknown> {
  const { checks: _checks, ...rest } = task;
  return {
    ...rest,
    taskKey: task.taskKey === '' ? INHERITED_TASK_KEY : task.taskKey,
    owns: [...task.owns].sort(compareMountPaths),
    title: stored(task.title),
    brief: stored(task.brief),
    objectives: task.objectives.map(stored),
    rubric: { ...task.rubric, criteria: task.rubric.criteria.map((one) => ({ ...one, title: stored(one.title), description: stored(one.description ?? '') })) },
  };
}

describe('export writes the folder layout and every edit', () => {
  let world: ForkWorld;
  let exporter: ExportService;
  let door: UploadService;
  let titles = 0;
  const fresh = (label: string): string => `${label} ${(titles += 1)}`;
  const importer = (): ProjectImporterService => new ProjectImporterService(world.content, world.dataSource);
  const upload = (title: string, archive: Buffer) => door.upload(TEACHER, { title, archiveBase64: archive.toString('base64') });
  const versions = () => world.dataSource.getRepository(ProjectVersionEntity);
  const compiledOf = async (versionId: string) => (await versions().findOneByOrFail({ id: versionId })).compiled!;
  const publish = (versionId: string) => versions().update({ id: versionId }, { status: 'published' });
  const taskListOf = async (versionId: string) =>
    JSON.parse(canonicalJson((await compiledOf(versionId)).phases.map((phase) => ({ key: phase.key, tasks: phase.tasks.map(comparable) }))));
  const exportedRows = () => world.dataSource.getRepository(AuditEventEntity).count({ where: { event: 'project.exported' } });
  const said = (run: Promise<unknown>): Promise<string> => run.then(() => 'an archive', (error: Error) => `${error.constructor.name}: ${error.message}`);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
    exporter = new ExportService(world.dataSource, world.content);
    door = new UploadService(importer(), world.content, world.dataSource, 16 * 1024 * 1024);
  }, 120_000);
  afterAll(async () => {
    await world?.close();
  });

  it('exports a version with a quiz and with every builder edit, and reads it back with no taskDrift', async () => {
    const shelf = await upload(fresh('Shelf with every edit'), writeZip(entriesOf(SHELF_DIR)));
    const { projectId: pid, versionId: vid } = shelf;
    // a concept quiz beside Requirements' work task, its first question's texts written with markdown and a closing line break
    const quizBody = hostQuizBody('concepts');
    const [first, ...rest] = quizBody.quiz!.questions;
    const marked = {
      ...first,
      stem: `**${first.stem}**\n`,
      options: first.options.map((option, i) => (i === 0 ? { ...option, text: `*${option.text}*` } : option)),
      explanation: `${first.explanation}\n`,
      concept: '**fixture-concept-1** ',
    };
    await world.service.addTask(TEACHER, pid, vid, 'requirements', { ...quizBody, quiz: { ...quizBody.quiz!, questions: [marked, ...rest] } });
    // a Criteria edit on Implementation: its fixed criteria's sentences and weights
    const implementation = (await world.service.listTasks(TEACHER, pid, vid, 'implementation')).tasks[0];
    const criteria = implementation.rubric.criteria.map((one, i) => (i === 0 ? { ...one, title: 'Hidden checks', description: 'The suite you cannot see passes.' } : one));
    await world.service.updateTask(TEACHER, pid, vid, 'implementation', INHERITED_TASK_KEY, { rubric: { ...implementation.rubric, criteria } } as never);
    // a ticket edit on Maintenance: its title and summary, every acceptance line kept
    const maintenance = (await world.service.listTasks(TEACHER, pid, vid, 'maintenance')).tasks[0];
    const ticket = { ...maintenance.change!.ticket, title: 'Shelve the books by author', summary: 'Order the shelf by author, then title.' };
    await world.service.updateTask(TEACHER, pid, vid, 'maintenance', INHERITED_TASK_KEY, { ticket } as never);
    // a runbook floor edit on Deployment
    const deployment = (await world.service.listTasks(TEACHER, pid, vid, 'deployment')).tasks[0];
    const floor = { ...deployment.runbook!.floor, minRollback: deployment.runbook!.floor.minRollback + 1 };
    await world.service.updateTask(TEACHER, pid, vid, 'deployment', INHERITED_TASK_KEY, { runbook: { floor } } as never);

    const out = await exporter.export(TEACHER, pid, vid);
    expect(out.withheld).toEqual([]);
    expect(namesOf(out.archive)).toContain('phases/01-requirements/quizzes/concepts.json');
    expect(jsonAt(out.archive, 'phases/03-implementation/phase.json').rubric.criteria[0]).toMatchObject({ title: 'Hidden checks', description: 'The suite you cannot see passes.' });
    expect(jsonAt(out.archive, 'phases/06-maintenance/phase.json').checks.ticket).toEqual(ticket);
    expect(jsonAt(out.archive, 'phases/05-deployment/phase.json').checks.runbook.floor).toEqual(floor);

    const again = await upload(fresh('Shelf with every edit, again'), out.archive);
    expect(again.warnings).toBeUndefined();
    expect(await taskListOf(again.versionId)).toEqual(await taskListOf(vid));
    const back = await compiledOf(again.versionId);
    const checksOf = (key: PhaseKey) => back.content.phases.find((one) => one.key === key)!.checks as Record<string, any>;
    expect(checksOf('maintenance').ticket).toEqual(ticket);
    expect(checksOf('deployment').runbook.floor).toEqual(floor);
    // the quiz's paper comes back whole: its questions, options, answers, explanations and concepts as the door stores them, and every setting
    const paperOf = async (versionId: string) =>
      (await compiledOf(versionId)).phases.find((one) => one.key === 'requirements')!.tasks.find((one) => one.taskKey === 'concepts')!.checks as QuizChecks;
    const heldPaper = await paperOf(vid);
    const backPaper = await paperOf(again.versionId);
    expect(backPaper).toEqual(paperAsStored(heldPaper));
    expect(backPaper.questions.map((one) => one.correct)).toEqual(quizBody.quiz!.questions.map((one) => one.correct));
    expect(backPaper.questions[0]).toMatchObject({
      stem: stored(plainTextOf(marked.stem)),
      options: [{ id: 'a', text: plainTextOf(marked.options[0].text) }, marked.options[1]],
      explanation: first.explanation,
      concept: 'fixture-concept-1',
    });
    expect(backPaper).toMatchObject({ kind: 'quiz', drawn: 5, attempts: { max: 3, cooldownSeconds: null } });
    expect(backPaper.questions.length).toBe(6);
  });

  it('refuses an archive whose read-back holds a quiz paper other than the version holds', async () => {
    const shelf = await upload(fresh('Shelf quiz compared'), writeZip(entriesOf(SHELF_DIR)));
    await world.service.addTask(TEACHER, shelf.projectId, shelf.versionId, 'requirements', hostQuizBody('concepts'));
    type ReadBack = (entries: ArchiveEntry[], ...rest: unknown[]) => void;
    const proto = ExportService.prototype as unknown as { uploadReadBack: ReadBack };
    const original = proto.uploadReadBack;
    const between = async (edit: (quiz: Record<string, any>) => void): Promise<string> => {
      const spy = jest.spyOn(proto, 'uploadReadBack').mockImplementation(function (this: unknown, entries: ArchiveEntry[], ...rest: unknown[]) {
        const edited = entries.map((one) => {
          if (!one.name.endsWith('/phases/01-requirements/quizzes/concepts.json')) return one;
          const quiz = JSON.parse(one.bytes.toString('utf-8'));
          edit(quiz);
          return { ...one, bytes: Buffer.from(`${JSON.stringify(quiz, null, 2)}\n`) };
        });
        return original.call(this, edited, ...rest);
      });
      try {
        return await said(exporter.export(TEACHER, shelf.projectId, shelf.versionId));
      } finally {
        spy.mockRestore();
      }
    };
    const drift = `ConflictException: ${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift('Requirements')}.`;
    expect(await between((quiz) => (quiz.checks.drawn = 4))).toBe(drift);
    expect(await between((quiz) => (quiz.checks.questions[0].options[1].text = 'Another option'))).toBe(drift);
    expect(await between((quiz) => (quiz.checks.questions[0].correct = ['b']))).toBe(drift);
    expect(await between((quiz) => (quiz.checks.questions[0].explanation = 'Another explanation.'))).toBe(drift);
    expect(await between((quiz) => (quiz.checks.questions[0].concept = 'another-concept'))).toBe(drift);
    // untouched, the same version exports
    expect((await exporter.export(TEACHER, shelf.projectId, shelf.versionId)).withheld).toEqual([]);
  });

  it('writes one folder per phase, numbered by place, and no canonical/', async () => {
    const runs = [{ id: 'main', language: 'python', harness: 'pytest', hiddenHarness: 'unittest', label: 'Tests', visibleTests: ['tests/test_main.py'] }];
    const code = (folder: string): PackFiles => codeFolder(folder, (spec) => {
      spec.checks.runs = runs;
    });
    const three = await upload(fresh('Three phases'), zipOf({ ...projectJson(), ...storyFolder(), ...designFolder(), ...code('03-implementation') }));
    const out = await exporter.export(TEACHER, three.projectId, three.versionId);
    expect(phaseFolders(out.archive)).toEqual(['phases/01-requirements', 'phases/02-design', 'phases/03-implementation']);
    expect(namesOf(out.archive).filter((name) => name.startsWith('canonical/'))).toEqual([]);
    const meta = jsonAt(out.archive, 'project.json');
    expect('phases' in meta).toBe(false);
    expect('warmup' in meta).toBe(false);
    for (const folder of phaseFolders(out.archive)) {
      const spec = jsonAt(out.archive, `${folder}/phase.json`);
      // no file, folder or source names, and no key or order: the folder says both
      for (const member of ['key', 'order', 'files', 'taskFile', 'interview']) expect({ folder, member, held: member in spec }).toEqual({ folder, member, held: false });
      expect(JSON.stringify(spec.checks)).not.toMatch(/"(hiddenTestDir|solutionDir|referenceDir|implDir|mutantsDir|faultedFiles|implFiles)":\s*[{"]/);
    }

    // Implementation alone is the project's first phase, so its folder is 01
    const one = await upload(fresh('One phase'), zipOf({ ...projectJson(), ...code('01-implementation') }));
    expect(phaseFolders((await exporter.export(TEACHER, one.projectId, one.versionId)).archive)).toEqual(['phases/01-implementation']);
  });

  it('writes a file several phases mount once per phase', async () => {
    const shelf = await upload(fresh('Shelf mounts'), writeZip(entriesOf(SHELF_DIR)));
    const content = (await compiledOf(shelf.versionId)).content;
    const holders = new Map<string, number>();
    for (const phase of content.phases) for (const file of phase.files) holders.set(file.path, (holders.get(file.path) ?? 0) + 1);
    const shared = [...holders].filter(([, count]) => count >= 2).map(([at]) => at);
    expect(shared.length).toBeGreaterThan(0);
    const out = await exporter.export(TEACHER, shelf.projectId, shelf.versionId);
    const names = new Set(namesOf(out.archive));
    for (const at of shared) {
      content.phases.forEach((phase, i) => {
        const file = phase.files.find((one) => one.path === at);
        if (!file) return;
        const name = `phases/${String(i + 1).padStart(2, '0')}-${phase.key}/${file.editable ? 'files' : 'readonly'}/${at}`;
        expect({ name, held: names.has(name) }).toEqual({ name, held: true });
        expect(textAt(out.archive, name)).toBe(file.content);
      });
    }
    expect([...names].filter((name) => name.startsWith('canonical/'))).toEqual([]);
  });

  it('writes records at their workspace paths, and leaves out an empty record the loader seeds again', async () => {
    // TaskTrackr's records, read in memory without its warm-up folder, which a teacher's draft cannot hold
    const made = await importer().importTeacherDraft(recordPack({ drop: (name) => name.startsWith('warmup/') }), { ownerId: TEACHER.id, title: fresh('Records') });
    const edited = serialiseRunbook({ ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'API_URL', purpose: 'Where web sends /api.', kind: 'config' }] });
    await world.service.replaceFile(TEACHER, made.projectId, made.versionId, 'deployment', { path: RUNBOOK_JSON, content: edited });
    const withEdit = (await exporter.export(TEACHER, made.projectId, made.versionId)).archive;
    expect(textAt(withEdit, `phases/05-deployment/files/${RUNBOOK_JSON}`)).toBe(edited);
    const change = (await compiledOf(made.versionId)).content.phases.find((one) => one.key === 'maintenance')!.files.find((one) => one.path === CHANGE_REQUEST_JSON)!;
    expect(textAt(withEdit, `phases/06-maintenance/files/${CHANGE_REQUEST_JSON}`)).toBe(change.content);

    // the empty runbook, wherever it is mounted, is the one the loader seeds again
    await world.service.replaceFile(TEACHER, made.projectId, made.versionId, 'deployment', { path: RUNBOOK_JSON, content: serialiseRunbook(EMPTY_RUNBOOK) });
    const seeded = (await exporter.export(TEACHER, made.projectId, made.versionId)).archive;
    expect(namesOf(seeded).filter((name) => name.endsWith('runbook.json'))).toEqual([]);
    // and Shelf's untouched story record likewise
    const shelf = await upload(fresh('Shelf records'), writeZip(entriesOf(SHELF_DIR)));
    expect(namesOf((await exporter.export(TEACHER, shelf.projectId, shelf.versionId)).archive)).not.toContain(`phases/01-requirements/files/${STORY_JSON}`);
  });

  it('writes each quiz as quizzes/<task key>.json with its brief and its order', async () => {
    const shelf = await upload(fresh('Shelf quizzes'), writeZip(entriesOf(SHELF_DIR)));
    await world.service.addTask(TEACHER, shelf.projectId, shelf.versionId, 'design', { ...hostQuizBody('concepts-one'), brief: 'Answer the **five** questions.' });
    await world.service.addTask(TEACHER, shelf.projectId, shelf.versionId, 'design', hostQuizBody('concepts-two'));
    const held = (await compiledOf(shelf.versionId)).phases.find((one) => one.key === 'design')!.tasks;
    const out = await exporter.export(TEACHER, shelf.projectId, shelf.versionId);
    for (const key of ['concepts-one', 'concepts-two']) {
      const task = held.find((one) => one.taskKey === key)!;
      const quiz = jsonAt(out.archive, `phases/02-design/quizzes/${key}.json`);
      expect(Object.keys(quiz)).toEqual(['title', 'brief', 'order', 'objectives', 'required', 'checks']);
      expect(quiz).toMatchObject({ title: task.title, brief: stored(task.brief), order: task.order, objectives: task.objectives, required: true });
      expect(quiz.checks.kind).toBe('quiz');
      expect(quiz.checks.questions.map((one: { id: string }) => one.id)).toEqual((task.checks as { questions: { id: string }[] }).questions.map((one) => one.id));
    }
    expect(jsonAt(out.archive, 'phases/02-design/quizzes/concepts-one.json').brief).toBe('Answer the five questions.');
    // the work task is no quiz file, and the re-upload holds the quizzes at their places
    expect(namesOf(out.archive).filter((name) => name.startsWith('phases/02-design/quizzes/'))).toEqual(['phases/02-design/quizzes/concepts-one.json', 'phases/02-design/quizzes/concepts-two.json']);
    const again = await upload(fresh('Shelf quizzes, again'), out.archive);
    expect((await compiledOf(again.versionId)).phases.find((one) => one.key === 'design')!.tasks.map((one) => [one.taskKey || INHERITED_TASK_KEY, one.order])).toEqual(
      held.map((one) => [one.taskKey || INHERITED_TASK_KEY, one.order]),
    );
  });

  it('refuses, as the upload door would, a quiz stored before texts were kept plain whose option converts to nothing, with a 409 that names the quiz file', async () => {
    const shelf = await upload(fresh('Shelf with a markup option'), writeZip(entriesOf(SHELF_DIR)));
    await world.service.addTask(TEACHER, shelf.projectId, shelf.versionId, 'requirements', hostQuizBody('concepts'));
    // an option stored as only markup, as a door stored it before texts were kept plain
    const compiled = JSON.parse(JSON.stringify(await compiledOf(shelf.versionId)));
    const quiz = compiled.phases.find((one: { key: string }) => one.key === 'requirements').tasks.find((one: CompiledTask) => one.taskKey === 'concepts');
    quiz.checks.questions[0].options[1].text = '---';
    await versions().update({ id: shelf.versionId }, { compiled });

    const before = await exportedRows();
    expect(await said(exporter.export(TEACHER, shelf.projectId, shelf.versionId))).toBe(
      `ConflictException: ${EXPORT_REFUSALS.unloadable} ${LAYOUT_SENTENCES.notAQuiz('phases/01-requirements/quizzes/concepts.json', QUIZ_OPTION_BLANK)}`,
    );
    expect(await exportedRows()).toBe(before);
  });

  it('refuses a phase holding quizzes and no work task, naming it', async () => {
    const shelf = await upload(fresh('Shelf with quizzes only'), writeZip(entriesOf(SHELF_DIR)));
    await world.service.addTask(TEACHER, shelf.projectId, shelf.versionId, 'design', hostQuizBody('concepts'));
    // the work task gone from the stored task list, as no door leaves it
    const compiled = JSON.parse(JSON.stringify(await compiledOf(shelf.versionId)));
    const design = compiled.phases.find((one: { key: string }) => one.key === 'design');
    design.tasks = design.tasks.filter((one: CompiledTask) => one.checkKind === 'quiz');
    expect(design.tasks.length).toBe(1);
    await versions().update({ id: shelf.versionId }, { compiled });

    const before = await exportedRows();
    expect(await said(exporter.export(TEACHER, shelf.projectId, shelf.versionId))).toBe(`ConflictException: ${EXPORT_REFUSALS.noWorkTask('Design')}`);
    expect(EXPORT_REFUSALS.noWorkTask('Design')).toBe(
      "Design holds no work task, only quizzes, and a phase folder holds its work task. Put the phase's task back, or remove the phase, and export again.",
    );
    expect(await exportedRows()).toBe(before);
    // the pointer layout's one-task and edited-task refusals are gone: quizzes and every edit travel
    expect('tasks' in EXPORT_REFUSALS).toBe(false);
    expect('taskEdited' in EXPORT_REFUSALS).toBe(false);
  });

  it('withholds the sealed files of a copy the teacher does not own, and lists them', async () => {
    const fork = await copyTaskTrackr(world, 'folder-export-copy');
    const out = await exporter.export(S1_TEACHER, fork.projectId, fork.versionId);
    const rows = await world.dataSource.getRepository(ProjectFileEntity).find({ where: { projectVersionId: fork.versionId } });
    const open = new Set(rows.filter((row) => row.role === 'workspace' || row.role === 'warmup').map((row) => row.blobSha));
    const sealed = rows.filter((row) => SEALED_FILE_ROLES.includes(row.role) && !open.has(row.blobSha));
    expect(sealed.length).toBeGreaterThan(0);
    const withheld = new Set(out.withheld.map((view) => view.sha256));
    for (const row of sealed) expect(withheld.has(row.blobSha)).toBe(true);
    for (const view of out.withheld) {
      expect(Object.keys(view).sort()).toEqual(['bytes', 'path', 'sha256']);
      // each by the path it would have in the folder layout
      expect(view.path).toMatch(/^phases\/0[1-6]-[a-z]+\/(interview\.json|(hidden_tests|solution|reference|impl|mutants|smoke|drill)\/)/);
    }
    const names = new Set(namesOf(out.archive));
    for (const view of out.withheld) expect(names.has(view.path)).toBe(false);
    const blobs = await world.dataSource.getRepository(ContentBlobEntity).find({ where: { sha: In([...new Set(sealed.map((row) => row.blobSha))]) } });
    const entryShas = new Set([...entriesUnderRoot(out.archive).values()].map((bytes) => blobShaFor(bytes.toString('utf-8'))));
    for (const blob of blobs) expect(entryShas.has(blob.sha)).toBe(false);
    expect([...names].filter((name) => name.startsWith('canonical/') || name.startsWith('warmup/'))).toEqual([]);
  });

  it('an exported TaskTrackr version the teacher uploaded and then exports again compiles to the same tasks', async () => {
    // TaskTrackr 6.0.0 is in the folder layout: its archive leaves canonical/ and the warm-up out, and its
    // briefs are plain, so the door converts nothing and says nothing
    const first = await upload(fresh('TaskTrackr of my own'), writeZip(tasktrackrEntries()));
    expect(first.warnings).toBeUndefined();
    await publish(first.versionId);
    const out = await exporter.export(TEACHER, first.projectId, first.versionId);
    expect(out.withheld).toEqual([]);
    expect(namesOf(out.archive).filter((name) => name.startsWith('canonical/') || name.startsWith('warmup/'))).toEqual([]);
    expect(phaseFolders(out.archive)).toEqual(['phases/01-requirements', 'phases/02-design', 'phases/03-implementation', 'phases/04-testing', 'phases/05-deployment', 'phases/06-maintenance']);
    const again = await upload(fresh('TaskTrackr of my own, again'), out.archive);
    expect(again.warnings).toBeUndefined();
    expect(await taskListOf(again.versionId)).toEqual(await taskListOf(first.versionId));
  });

  it('refuses an archive whose read-back mounts a file with other bytes, or with another editability, than the version holds', async () => {
    const shelf = await upload(fresh('Shelf mounts compared'), writeZip(entriesOf(SHELF_DIR)));
    // Between the writer and the read-back: the archive's entries edited before the door's pipeline reads them.
    type ReadBack = (entries: ArchiveEntry[], ...rest: unknown[]) => void;
    const proto = ExportService.prototype as unknown as { uploadReadBack: ReadBack };
    const original = proto.uploadReadBack;
    const between = async (edit: (entries: ArchiveEntry[]) => ArchiveEntry[]): Promise<string> => {
      const spy = jest.spyOn(proto, 'uploadReadBack').mockImplementation(function (this: unknown, entries: ArchiveEntry[], ...rest: unknown[]) {
        return original.call(this, edit(entries), ...rest);
      });
      try {
        return await said(exporter.export(TEACHER, shelf.projectId, shelf.versionId));
      } finally {
        spy.mockRestore();
      }
    };
    const drift = `ConflictException: ${EXPORT_REFUSALS.unloadable} ${EXPORT_REFUSALS.taskDrift('Implementation')}.`;
    const at = (entries: ArchiveEntry[], tail: string): ArchiveEntry => {
      const found = entries.find((one) => one.name.endsWith(tail));
      if (!found) throw new Error(`the archive holds no ${tail}`);
      return found;
    };
    // a read-only mount whose bytes moved: no task fact holds them, only the mount compare
    expect(
      await between((entries) => {
        const target = at(entries, '/phases/03-implementation/readonly/web/src/main.ts');
        return entries.map((one) => (one === target ? { ...one, bytes: Buffer.concat([one.bytes, Buffer.from('// moved\n')]) } : one));
      }),
    ).toBe(drift);
    // a read-only mount read back editable (the work task's owned files move with it, so the task list's compare
    // refuses it first; the mount compare's editability arm is asked alone in the next case)
    expect(
      await between((entries) => {
        const target = at(entries, '/phases/03-implementation/readonly/web/src/ShelfPage.ts');
        return entries.map((one) => (one === target ? { ...one, name: one.name.replace('/readonly/', '/files/') } : one));
      }),
    ).toBe(drift);
    // untouched, the same version exports
    expect((await exporter.export(TEACHER, shelf.projectId, shelf.versionId)).withheld).toEqual([]);
  });

  it('the mount compare refuses a mount read back with another editability and nothing else moved', async () => {
    // Through an archive the task's owned files move with editability (a phase's work task owns its editable
    // mounts), so the case above is caught by the task list first. Here the mount compare is asked alone.
    const shelf = await upload(fresh('Shelf editability compared'), writeZip(entriesOf(SHELF_DIR)));
    const held = (await compiledOf(shelf.versionId)).content;
    const flipped = JSON.parse(JSON.stringify(held));
    const mount = flipped.phases.find((one: { key: string }) => one.key === 'deployment').files.find((one: { path: string }) => one.path === 'deploy/shelf.json');
    expect(mount.editable).toBe(false);
    expect(mountDrift(held, new Map(), JSON.parse(JSON.stringify(held)))).toBeNull();
    mount.editable = true;
    expect(mountDrift(held, new Map(), flipped)).toBe('Deployment');
  });

  it('a published, edited teacher version whose mounts are out of path order exports with no drift', async () => {
    const made = await importer().importTeacherDraft(new DirectoryPackSource(SHELF_DIR), { ownerId: TEACHER.id, title: fresh('Shelf out of order') });
    await world.service.updateTask(TEACHER, made.projectId, made.versionId, 'implementation', INHERITED_TASK_KEY, { title: 'Shelve the books' } as never);
    // The folder loader stores every phase's mounts in path order; a version stored before texts were kept plain holds them
    // in the order its pointer manifest listed them, so the stored mounts are written back reversed, as
    // such a version holds them.
    const stored = JSON.parse(JSON.stringify(await compiledOf(made.versionId)));
    for (const phase of stored.content.phases) phase.files.reverse();
    await versions().update({ id: made.versionId }, { compiled: stored });
    await publish(made.versionId);
    const held = (await compiledOf(made.versionId)).content.phases;
    const outOfOrder = held.filter((phase) => phase.files.map((one) => one.path).join('\n') !== [...phase.files.map((one) => one.path)].sort(compareMountPaths).join('\n'));
    expect(outOfOrder.length).toBeGreaterThan(0);

    const out = await exporter.export(TEACHER, made.projectId, made.versionId);
    expect(out.withheld).toEqual([]);
    const again = await upload(fresh('Shelf out of order, again'), out.archive);
    expect(await taskListOf(again.versionId)).toEqual(await taskListOf(made.versionId));
    const back = (await compiledOf(again.versionId)).content.phases;
    for (const phase of outOfOrder) {
      const paths = back.find((one) => one.key === phase.key)!.files.map((one) => one.path);
      expect(paths).toEqual([...paths].sort(compareMountPaths));
      expect([...paths].sort()).toEqual([...phase.files.map((one) => one.path)].sort());
    }
  });

  it('a TaskTrackr 5.0.0 copy published before texts were kept plain exports with no taskDrift, and its re-upload holds plainTextOf of each brief and objective', async () => {
    // The teacher's own TaskTrackr, stored as an import stored it before texts were kept plain (its briefs
    // markdown, no door ran), published, then copied and the copy published, its rows written as such a copy writes them.
    const own = await importer().importTeacherDraft(storedInOlderLayout(olderTaskTrackrPack()), { ownerId: TEACHER.id, title: fresh('TaskTrackr held whole') });
    await publish(own.versionId);
    const copy = await world.service.createProject(TEACHER, { title: fresh('TaskTrackr copied'), slug: 'folder-export-tt-copy', fromVersionId: own.versionId });
    const vid = copy.draftVersionId;
    // A quiz the editor added before texts were kept plain, written into the copy by row and snapshot with no door (a door today would
    // convert the copy's markdown at its first save): the quiz task and its row as the quiz door makes them, on a
    // scratch draft, then a quiz text as such a door stored it, markdown and all.
    const scratch = await upload(fresh('Quiz made elsewhere'), writeZip(entriesOf(SHELF_DIR)));
    await world.service.addTask(TEACHER, scratch.projectId, scratch.versionId, 'requirements', hostQuizBody('concepts'));
    const phaseOf = (versionId: string) => world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'requirements' });
    const taskRows = world.dataSource.getRepository(ProjectTaskEntity);
    const { id: _id, projectPhaseId: _phase, ...quizRow } = await taskRows.findOneByOrFail({ projectPhaseId: (await phaseOf(scratch.versionId)).id, taskKey: 'concepts' });
    const compiled = JSON.parse(JSON.stringify(await compiledOf(vid)));
    const requirements = compiled.phases.find((one: { key: string }) => one.key === 'requirements');
    const made = (await compiledOf(scratch.versionId)).phases.find((one) => one.key === 'requirements')!.tasks.find((one) => one.taskKey === 'concepts')!;
    const quiz = JSON.parse(JSON.stringify({ ...made, order: requirements.tasks.length + 1 }));
    quiz.title = 'Concept *check*';
    quiz.checks.questions[0].stem = `**${quiz.checks.questions[0].stem}**`;
    requirements.tasks.push(quiz);
    await taskRows.insert({ ...quizRow, projectPhaseId: (await phaseOf(vid)).id, order: quiz.order, title: quiz.title, checks: quiz.checks });
    await versions().update({ id: vid }, { compiled });
    await publish(vid);
    const before = canonicalJson((await versions().findOneByOrFail({ id: vid })).compiled);
    const heldPhases = (await compiledOf(vid)).content.phases;
    const markdown = heldPhases.filter((phase) => phase.taskPanel !== plainTextOf(phase.taskPanel)).map((phase) => phase.key);
    expect(markdown).toEqual(expect.arrayContaining(['requirements', 'implementation', 'testing']));

    const out = await exporter.export(TEACHER, copy.project.id, vid);
    expect(out.withheld).toEqual([]);
    for (const [i, phase] of heldPhases.entries()) {
      const spec = jsonAt(out.archive, `phases/${String(i + 1).padStart(2, '0')}-${phase.key}/phase.json`);
      expect({ key: phase.key, taskPanel: spec.taskPanel, objectives: spec.objectives }).toEqual({
        key: phase.key,
        taskPanel: stored(phase.taskPanel),
        objectives: phase.objectives.map(stored),
      });
    }
    const quizFile = jsonAt(out.archive, 'phases/01-requirements/quizzes/concepts.json');
    expect(quizFile.title).toBe('Concept check');
    expect(quizFile.checks.questions[0].stem).toBe(stored(quiz.checks.questions[0].stem));
    // the stored version's bytes are unchanged
    expect(canonicalJson((await versions().findOneByOrFail({ id: vid })).compiled)).toBe(before);

    const again = await upload(fresh('TaskTrackr copied, again'), out.archive);
    expect(again.warnings).toBeUndefined();
    expect(await taskListOf(again.versionId)).toEqual(await taskListOf(vid));
    const back = (await compiledOf(again.versionId)).content.phases;
    for (const phase of heldPhases) {
      const one = back.find((entry) => entry.key === phase.key)!;
      expect({ key: phase.key, taskPanel: one.taskPanel, objectives: one.objectives }).toEqual({
        key: phase.key,
        taskPanel: stored(phase.taskPanel),
        objectives: phase.objectives.map(stored),
      });
    }
  });

  it('a brief stored before texts were kept plain as "Intro\n\n---" exports as "Intro" and reads back with no taskDrift', async () => {
    const shelf = await upload(fresh('Shelf with a closing rule'), writeZip(entriesOf(SHELF_DIR)));
    // the brief and an objective as a door stored them before texts were kept plain: markdown whose conversion leaves a blank edge
    const compiled = JSON.parse(JSON.stringify(await compiledOf(shelf.versionId)));
    const phase = compiled.phases.find((one: { key: string }) => one.key === 'implementation');
    const work = phase.tasks.find((one: CompiledTask) => one.checkKind !== 'quiz');
    work.brief = 'Intro\n\n---';
    work.objectives = ['---\nName one edge'];
    compiled.content.phases.find((one: { key: string }) => one.key === 'implementation').taskPanel = 'Intro\n\n---';
    await versions().update({ id: shelf.versionId }, { compiled });

    const out = await exporter.export(TEACHER, shelf.projectId, shelf.versionId);
    const written = jsonAt(out.archive, 'phases/03-implementation/phase.json');
    expect(written.taskPanel).toBe('Intro');
    expect(written.objectives).toEqual(['Name one edge']);
    expect(stored('Intro\n\n---')).toBe('Intro');
    const again = await upload(fresh('Shelf with a closing rule, again'), out.archive);
    expect(again.warnings).toBeUndefined();
    expect((await taskListOf(again.versionId)).find((one: { key: string }) => one.key === 'implementation')).toEqual(
      (await taskListOf(shelf.versionId)).find((one: { key: string }) => one.key === 'implementation'),
    );
  });

  it('a Shelf upload stored before texts were kept plain exports with no taskDrift', async () => {
    // a Shelf draft written by importTeacherDraft over the older (pointer-layout) Shelf: its briefs markdown, as stored before texts were kept plain
    const made = await importer().importTeacherDraft(storedInOlderLayout(new DirectoryPackSource(OLDER_SHELF)), { ownerId: TEACHER.id, title: fresh('Shelf stored in the older layout') });
    await publish(made.versionId);
    const held = (await compiledOf(made.versionId)).content.phases;
    expect(held.some((phase) => phase.taskPanel !== plainTextOf(phase.taskPanel))).toBe(true);
    const before = await exportedRows();
    const out = await exporter.export(TEACHER, made.projectId, made.versionId);
    expect(await exportedRows()).toBe(before + 1);
    for (const [i, phase] of held.entries()) {
      expect(jsonAt(out.archive, `phases/${String(i + 1).padStart(2, '0')}-${phase.key}/phase.json`).taskPanel).toBe(stored(phase.taskPanel));
    }
    const again = await upload(fresh('Shelf stored in the older layout, again'), out.archive);
    expect(again.warnings).toBeUndefined();
    expect(await taskListOf(again.versionId)).toEqual(await taskListOf(made.versionId));
  });
});

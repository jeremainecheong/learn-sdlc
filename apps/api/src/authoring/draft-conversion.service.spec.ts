// The boot pass of the two record kinds: `DraftConversionService.run('runbook')` and `run('change')` convert a
// teacher's draft stored before the records once, write their done markers, and add the drafts to their receipts. The
// world is `openForkWorld` (TaskTrackr as it ships, a teacher's copy); the stored draft's Deployment or Maintenance
// is put back by hand into the older shape (the record checks taken out, the record row replaced by the markdown file
// TaskTrackr 4.0.0 mounted, from the frozen fixtures), as a draft stored before the records holds it.
// The plain-text pass has a world of its own, in the last describe.
import 'reflect-metadata';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, htmlCommentWarning, markdownKeptWarning, markupOnlyWarning, plainTextNotesOn, plainTextOf, type PhaseKey, type QuizChecks } from '@learnsdlc/shared';
import { config } from '../config';
import { blobShaFor } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import type { CodeChecks, ConfigChecks, PhaseContent } from '../content/content.types';
import type { CompiledTask } from '../content/pack-compiler';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectRegistryService } from '../content/project-registry.service';
import { ProjectImporterService } from '../content/importer.service';
import { applicationDigest } from '../content/reference-content';
import { ContentBlobEntity, ProjectEntity, ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, ReleaseRecordEntity, SettingEntity, UserEntity } from '../db/entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { composeReviewMessages } from '../assistant/openai.provider';
import type { ReviewInput } from '../assistant/provider.types';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { olderTaskTrackrPack as olderPointerPack } from '../../test/legacy-phase';
import { layoutFromManifest } from '../content/legacy-layout';
import { S1_TEACHER, copyTaskTrackr, draftSnapshot, openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { AuthoringService } from './authoring.service';
import { TASKTRACKR_400_MAINTENANCE } from './legacy-change';
import { TASKTRACKR_400_DEPLOYMENT } from './legacy-runbook';
import { executableDigestKey } from './provenance';
import { phaseScopeOf, taskScopeOf } from '../assistant/project-scope';
import { isReferenceExecutablePhase } from './deep-validation';
import { CHANGE_DRAFTS_DONE_KEY, DraftConversionService, PLAIN_TEXT_DRAFTS_DONE_KEY, PLAIN_TEXT_RECEIPT_KEY, RUNBOOK_DRAFTS_DONE_KEY } from './draft-conversion.service';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures');
const KINDS = {
  runbook: { key: 'deployment', fixture: 'legacy-deployment', markdown: 'RUNBOOK.md', record: RUNBOOK_JSON, done: RUNBOOK_DRAFTS_DONE_KEY, receipt: RUNBOOK_MIGRATION_RECEIPT_KEY },
  change: { key: 'maintenance', fixture: 'legacy-maintenance', markdown: 'CHANGELOG.md', record: CHANGE_REQUEST_JSON, done: CHANGE_DRAFTS_DONE_KEY, receipt: CHANGE_MIGRATION_RECEIPT_KEY },
} as const;
type Kind = keyof typeof KINDS;
/**
 * TaskTrackr 4.0.0 as the frozen fixtures hold it, in the older, pointer layout, converted once as the
 * upload door converts an older archive: the loader reads only the folder layout.
 */
const olderTaskTrackrPack = (edit?: (name: string, text: string) => string) => layoutFromManifest(olderPointerPack(edit)).source;

describe('the boot pass of the record kinds', () => {
  let world: ForkWorld;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  const phaseOf = (versionId: string, kind: Kind) =>
    world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: KINDS[kind].key });
  const mainOf = async (versionId: string, kind: Kind) =>
    (await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: (await phaseOf(versionId, kind)).id })).find((one) => one.checks.kind !== 'quiz')!;
  const pathsOf = async (versionId: string, kind: Kind) =>
    (await world.dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: versionId, ownerKind: 'phase', ownerId: (await phaseOf(versionId, kind)).id })).map((row) => row.path);

  /** A teacher's copy whose Deployment or Maintenance is put back into the older shape, as a draft stored before the records. */
  const storedOlderDraft = async (slug: string, kind: Kind) => {
    const fork = await copyTaskTrackr(world, slug);
    const { key, fixture, markdown, record } = KINDS[kind];
    const phase = await phaseOf(fork.versionId, kind);
    const task = await mainOf(fork.versionId, kind);
    const checks = kind === 'runbook'
      ? (({ runbook: _runbook, ...rest }: ConfigChecks) => rest)(task.checks as ConfigChecks)
      : (({ ticket: _ticket, change: _change, ...rest }: CodeChecks) => rest)(task.checks as CodeChecks);
    await world.dataSource.getRepository(ProjectTaskEntity).update({ id: task.id }, { checks: checks as never });
    const files = world.dataSource.getRepository(ProjectFileEntity);
    await files.delete({ projectVersionId: fork.versionId, ownerKind: 'phase', ownerId: phase.id, path: record });
    const bytes = readFileSync(path.join(FIXTURES, fixture, 'files', markdown), 'utf8');
    const sha = blobShaFor(bytes);
    await world.dataSource.createQueryBuilder().insert().into(ContentBlobEntity).values({ sha, bytes, size: Buffer.byteLength(bytes, 'utf-8') }).orIgnore().execute();
    await files.insert({ projectVersionId: fork.versionId, ownerKind: 'phase', ownerId: phase.id, path: markdown, role: 'workspace', editable: true, language: 'markdown', blobSha: sha });
    expect(key).toBe(phase.key);
    return fork;
  };

  it.each(['runbook', 'change'] as const)('run(%s) converts a stored older draft once, writes its marker, and adds the drafts to its receipt', async (kind) => {
    const stored = await storedOlderDraft(`stored-older-${kind}`, kind);
    expect(await pathsOf(stored.versionId, kind)).toContain(KINDS[kind].markdown);
    const service = new DraftConversionService(world.dataSource, world.service);
    const first = await service.run(kind);
    expect(first).not.toBeNull();
    expect(first!.converted).toBeGreaterThanOrEqual(1);
    const paths = await pathsOf(stored.versionId, kind);
    expect(paths).toContain(KINDS[kind].record);
    expect(paths).not.toContain(KINDS[kind].markdown);
    const checks = (await mainOf(stored.versionId, kind)).checks as { runbook?: unknown; change?: unknown };
    expect(kind === 'runbook' ? checks.runbook : checks.change).toBeDefined();
    // once: the marker is written, and the second run reads it and does nothing
    expect(await service.run(kind)).toBeNull();
    const settings = world.dataSource.getRepository(SettingEntity);
    expect(await settings.findOneBy({ key: KINDS[kind].done })).not.toBeNull();
    const receipt = JSON.parse((await settings.findOneByOrFail({ key: KINDS[kind].receipt })).value);
    expect(receipt.drafts.converted).toContain(stored.versionId);
  });

  /**
   * A teacher's draft stored before the records, written by the importer from the 4.0.0 pack (its rows and its
   * compiled snapshot as 4.0.0's), then held as the teacher's draft. `brief` rewrites each work task's brief as a
   * teacher's edit would. The earlier cases' passes ran, so their markers and receipts are cleared: this boot is the
   * first again.
   */
  const storedTaskTrackr400 = async (slug: string, brief: (was: string) => string = (was) => was) => {
    const made = await new ProjectImporterService(world.content, world.dataSource).importPack(
      olderTaskTrackrPack((name, text) => (name === 'project.json' ? JSON.stringify({ ...JSON.parse(text), slug, title: 'Stored 4.0.0' }, null, 2) : text)),
      { origin: 'fork', platformOwned: false, ownerUserId: S1_TEACHER.id },
    );
    await world.dataSource.getRepository(ProjectEntity).update({ id: made.projectId }, { ownerUserId: S1_TEACHER.id, platformOwned: false });
    const versions = world.dataSource.getRepository(ProjectVersionEntity);
    await versions.update({ id: made.projectVersionId }, { status: 'draft' });
    const fork = { projectId: made.projectId, versionId: made.projectVersionId };
    // The importer writes no row for a phase's sole task; a copy writes each compiled task as a row, as the copy did then.
    const compiled = (await versions.findOneByOrFail({ id: fork.versionId })).compiled!;
    for (const kind of ['runbook', 'change'] as const) {
      const phase = compiled.content.phases.find((one) => one.key === KINDS[kind].key)!;
      const tasks = compiled.phases.find((one) => one.key === phase.key)!.tasks;
      for (const [at, task] of tasks.entries()) {
        await world.dataSource.getRepository(ProjectTaskEntity).insert({
          projectPhaseId: (await phaseOf(fork.versionId, kind)).id, taskKey: task.taskKey || 'main', order: at + 1, required: task.required, signOff: task.signOff,
          artefactType: task.artefactType, artefactPath: task.artefactPath, title: task.title,
          brief: task.checkKind === 'quiz' ? task.brief : brief(task.brief), objectives: task.objectives,
          primaryPath: null, anchor: null, rubric: task.rubric, checks: (task.checks ?? phase.checks) as never,
        });
      }
    }
    const settings = world.dataSource.getRepository(SettingEntity);
    for (const kind of ['runbook', 'change'] as const) {
      await settings.delete({ key: KINDS[kind].done });
      await settings.delete({ key: KINDS[kind].receipt });
    }
    return { fork, versions, settings };
  };

  it('converts a stored draft holding both of TaskTrackr 4.0.0\'s record phases whole in the runbook pass, exactly, and the change pass finds nothing of it', async () => {
    const { fork, versions, settings } = await storedTaskTrackr400('stored-400');
    const before = await draftSnapshot(world, fork);
    for (const [key, frozen] of [['deployment', TASKTRACKR_400_DEPLOYMENT], ['maintenance', TASKTRACKR_400_MAINTENANCE]] as const) {
      const phase = before.content.phases.find((one) => one.key === key)!;
      expect({ executableDigestKey: executableDigestKey(phase), applicationDigest: applicationDigest(phase) }).toEqual(frozen);
    }
    const service = new DraftConversionService(world.dataSource, world.service);
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    expect(await service.run('runbook')).toEqual({ converted: 1, refused: 0 });
    // the note names the reference's current version, the TaskTrackr on disk
    expect(log.mock.calls.map(([line]) => String(line))).toContain("a stored draft: Deployment converted to TaskTrackr 6.0.0's. Maintenance converted to TaskTrackr 6.0.0's.");
    log.mockRestore();
    expect(JSON.parse((await settings.findOneByOrFail({ key: KINDS.runbook.receipt })).value).drafts).toMatchObject({ converted: [fork.versionId], refused: [] });

    // Both phases are the shipped TaskTrackr's (6.0.0), as the boot's compile stored them.
    const after = (await versions.findOneByOrFail({ id: fork.versionId })).compiled!.content;
    for (const key of ['deployment', 'maintenance'] as const) {
      const mine = after.phases.find((one) => one.key === key)!;
      const five = world.content.getPhase('tasktrackr', key);
      expect({ checks: mine.checks, files: mine.files, taskPanel: mine.taskPanel, objectives: mine.objectives, assistant: mine.assistant, rubric: mine.rubric })
        .toEqual({ checks: five.checks, files: five.files, taskPanel: five.taskPanel, objectives: five.objectives, assistant: five.assistant, rubric: five.rubric });
    }
    expect(await pathsOf(fork.versionId, 'runbook')).not.toContain('RUNBOOK.md');
    expect(await pathsOf(fork.versionId, 'change')).not.toContain('CHANGELOG.md');

    // The change pass then finds nothing of it.
    expect(await service.run('change')).toEqual({ converted: 0, refused: 0 });
    const change = await settings.findOneBy({ key: KINDS.change.receipt });
    expect(change ? JSON.parse(change.value).drafts.converted : []).not.toContain(fork.versionId);
  });

  it('converts a stored TaskTrackr 4.0.0 draft whose briefs a teacher edited the generic way, whole, and counts it converted, not refused', async () => {
    const { fork, versions, settings } = await storedTaskTrackr400('stored-400-edited', (was) => `${was}\nOur own closing line.\n`);
    const before = await draftSnapshot(world, fork);
    expect(executableDigestKey(before.content.phases.find((one) => one.key === 'deployment')!)).not.toBe(TASKTRACKR_400_DEPLOYMENT.executableDigestKey);
    expect(executableDigestKey(before.content.phases.find((one) => one.key === 'maintenance')!)).not.toBe(TASKTRACKR_400_MAINTENANCE.executableDigestKey);
    const service = new DraftConversionService(world.dataSource, world.service);
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    expect(await service.run('runbook')).toEqual({ converted: 1, refused: 0 });
    const lines = log.mock.calls.map(([line]) => String(line));
    log.mockRestore();
    const note = lines.filter((line) => line.startsWith('a stored draft: Deployment converted to the runbook record: '));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain(' Maintenance converted to the change request record: ');
    expect(note[0]).not.toContain("TaskTrackr 6.0.0's");
    expect(JSON.parse((await settings.findOneByOrFail({ key: KINDS.runbook.receipt })).value).drafts).toMatchObject({ converted: [fork.versionId], refused: [] });

    // The boot's compile stored the converted draft: each record mounted and owned, each markdown file and the path that named it gone.
    const after = (await versions.findOneByOrFail({ id: fork.versionId })).compiled!;
    for (const kind of ['runbook', 'change'] as const) {
      const { key, markdown, record } = KINDS[kind];
      expect(after.content.phases.find((one) => one.key === key)!.files.map((file) => file.path)).toEqual(expect.arrayContaining([record]));
      expect(after.content.phases.find((one) => one.key === key)!.files.map((file) => file.path)).not.toContain(markdown);
      const main = await mainOf(fork.versionId, kind);
      expect(main.artefactPath).toBeNull();
      expect(main.brief.endsWith('Our own closing line.\n')).toBe(true);
      expect(after.phases.find((one) => one.key === key)!.tasks.find((one) => one.checkKind !== 'quiz')!.owns).toContain(record);
    }

    // The change pass then finds nothing of it.
    expect(await service.run('change')).toEqual({ converted: 0, refused: 0 });
  });
});

/*
 * The plain-text pass: the texts a teacher wrote with markdown in a
 * draft are stored plain once, at boot (`run('plain-text')`) or at the draft's first save (a door through
 * `mutateDraft`, or one of the Phases card's three doors), and the draft keeps notes of what changed for the editor
 * to draw. TaskTrackr 6.0.0's own texts are plain, so an untouched copy holds nothing to convert and keeps
 * TaskTrackr's anchors, reviewer and provenance as they are. Its own world: each boot case
 * first converts what earlier cases left (`clean`) and then counts only the drafts it made.
 */
describe("the plain-text pass over teachers' drafts", () => {
  let world: ForkWorld;
  let copies = 0;
  const copy = () => copyTaskTrackr(world, `plain-text-draft-${(copies += 1)}`);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  const settings = () => world.dataSource.getRepository(SettingEntity);
  const versions = () => world.dataSource.getRepository(ProjectVersionEntity);
  const taskRows = () => world.dataSource.getRepository(ProjectTaskEntity);
  const phaseRow = (versionId: string, key: PhaseKey) => world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key });
  const taskRow = async (versionId: string, key: PhaseKey, taskKey = 'main') => taskRows().findOneByOrFail({ projectPhaseId: (await phaseRow(versionId, key)).id, taskKey });
  /** TaskTrackr's brief of a phase as it ships: 6.0.0's, plain. */
  const reference = (key: PhaseKey) => world.content.getPhase('tasktrackr', key).taskPanel;
  /** A brief a teacher wrote over the reference's, with markdown of their own. */
  const ownBrief = () => `${reference('implementation')}\nOur own **closing** line.\n`;
  /** Every phase and task row of a draft, as stored. */
  const rowsOf = async (versionId: string) => {
    const phases = await world.dataSource.getRepository(ProjectPhaseEntity).findBy({ projectVersionId: versionId });
    const tasks = await taskRows().findBy({ projectPhaseId: In(phases.map((one) => one.id)) });
    return JSON.stringify({ phases: phases.sort((a, b) => a.order - b.order), tasks: tasks.sort((a, b) => (a.id < b.id ? -1 : 1)) });
  };
  const compiledOf = async (versionId: string) => JSON.stringify((await versions().findOneByOrFail({ id: versionId })).compiled);
  const pass = () => new DraftConversionService(world.dataSource, world.service);
  /** The pass's marker and receipt cleared, and the story receipt with them, so the next run is a first boot again. */
  const freshBoot = async () => {
    await settings().delete({ key: In([PLAIN_TEXT_DRAFTS_DONE_KEY, PLAIN_TEXT_RECEIPT_KEY, STORY_MIGRATION_RECEIPT_KEY]) });
  };
  /** Every draft the earlier cases left holding a teacher's markdown converted, then a first boot again. */
  const clean = async () => {
    await freshBoot();
    await pass().run('plain-text');
    await freshBoot();
  };
  const receipt = async () => JSON.parse((await settings().findOneByOrFail({ key: PLAIN_TEXT_RECEIPT_KEY })).value);
  const conversionOf = async (versionId: string) => (await world.service.readDraft(S1_TEACHER, (await versions().findOneByOrFail({ id: versionId })).projectId, versionId)).plainTextConversion;
  /** What the editor shows of each phase's provenance, and the reviewer's scope for each task. */
  const identityOf = async (fork: { projectId: string; versionId: string }) => {
    const snapshot = await draftSnapshot(world, fork);
    const view = await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
    return JSON.stringify({
      provenance: view.phases.map((one) => one.provenance),
      scope: snapshot.content.phases.map((phase) => {
        const tasks = snapshot.phases.find((one) => one.key === phase.key)!.tasks;
        return tasks.map((task) => taskScopeOf(phase, task, tasks).kind);
      }),
      phaseScope: snapshot.content.phases.map((phase) => phaseScopeOf(phase, snapshot.phases.find((one) => one.key === phase.key)!.tasks).kind),
      deep: snapshot.content.phases.map((phase) => isReferenceExecutablePhase(phase, snapshot.phases.find((one) => one.key === phase.key)!.tasks)),
    });
  };
  const logged = async <T>(service: DraftConversionService, work: () => Promise<T>): Promise<{ out: T; lines: string[] }> => {
    const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
    try {
      const out = await work();
      return { out, lines: log.mock.calls.map(([line]) => String(line)) };
    } finally {
      log.mockRestore();
    }
  };
  /** A quiz on Testing whose stem, option and explanation are put back to markdown by hand, as a draft stored before texts were kept plain held them. */
  const markdownQuiz = async (at: { projectId: string; versionId: string }) => {
    await world.service.addTask(S1_TEACHER, at.projectId, at.versionId, 'testing', {
      taskKey: 'recap', title: 'Recap', brief: 'Read this first.', artefactType: 'quiz', required: false,
      quiz: { questions: ['q1', 'q2'].map((id) => ({ id, stem: `What does ${id} check?`, options: [{ id: 'a', text: 'The rule' }, { id: 'b', text: 'Nothing' }], correct: ['a'], explanation: 'Because.' })) },
    });
    const row = await taskRow(at.versionId, 'testing', 'recap');
    const checks = row.checks as unknown as QuizChecks;
    checks.questions[0] = { ...checks.questions[0], stem: 'What does **q1** check?', options: [{ id: 'a', text: 'The _overdue_ rule' }, checks.questions[0].options[1]], explanation: 'Because **the rule** says so.' };
    await taskRows().update({ id: row.id }, { checks: checks as never });
  };
  /** The Implementation brief and its first objective rewritten by the teacher with markdown, stored as a draft held them before texts were kept plain. */
  const markdownImplementation = async (versionId: string, brief = ownBrief()) => {
    const row = await taskRow(versionId, 'implementation');
    await taskRows().update({ id: row.id }, { brief, objectives: ['Use the **overdue** rule', ...row.objectives.slice(1)] });
  };

  it("leaves an untouched TaskTrackr 6.0.0 copy as it is, since its texts are plain already, and the copy reads reference in taskScopeOf, phaseScopeOf and deep validation", async () => {
    await clean();
    const at = await copy();
    // 6.0.0's briefs are plain: the conversion is a fixed point on each, so the copy holds no markdown
    for (const key of ['requirements', 'implementation', 'testing'] as const) {
      expect((await taskRow(at.versionId, key)).brief).toBe(reference(key));
      expect(plainTextOf(reference(key))).toBe(reference(key));
    }
    const before = await identityOf(at);
    expect(JSON.parse(before).scope).toEqual(expect.arrayContaining([['reference']]));
    expect(await pass().run('plain-text')).toEqual({ converted: 0, refused: 0 });
    for (const key of ['requirements', 'implementation', 'testing'] as const) expect((await taskRow(at.versionId, key)).brief).toBe(reference(key));
    expect(await settings().findOneBy({ key: PLAIN_TEXT_RECEIPT_KEY })).toBeNull();
    // the copy reads the reference: reviewer, mentor, deep validation and provenance alike
    expect(await identityOf(at)).toBe(before);
    const snapshot = await draftSnapshot(world, at);
    for (const key of ['requirements', 'implementation', 'testing'] as const) {
      const phase = snapshot.content.phases.find((one) => one.key === key)!;
      const tasks = snapshot.phases.find((one) => one.key === key)!.tasks;
      const work = tasks.filter((one) => one.checkKind !== 'quiz');
      expect(work[0].brief).toBe(reference(key));
      expect([key, taskScopeOf(phase, work[0], tasks).kind, phaseScopeOf(phase, tasks).kind]).toEqual([key, 'reference', 'reference']);
      if (key !== 'requirements') expect([key, isReferenceExecutablePhase(phase, tasks)]).toEqual([key, true]);
    }
  });

  it('a boot with nothing to convert writes nothing', async () => {
    await clean();
    const at = await copy();
    await pass().run('plain-text');
    await freshBoot();
    const before = await rowsOf(at.versionId);
    const compiled = await compiledOf(at.versionId);
    const notes = await conversionOf(at.versionId);
    expect(await pass().run('plain-text')).toEqual({ converted: 0, refused: 0 });
    expect(await rowsOf(at.versionId)).toBe(before);
    expect(await compiledOf(at.versionId)).toBe(compiled);
    expect(await settings().findOneBy({ key: PLAIN_TEXT_RECEIPT_KEY })).toBeNull();
    expect(await settings().findOneBy({ key: PLAIN_TEXT_DRAFTS_DONE_KEY })).toBeNull();
    expect(await conversionOf(at.versionId)).toEqual(notes);
  });

  it('converts a draft whose brief, objectives and quiz text held markdown, and writes plain-text.receipt by count', async () => {
    await clean();
    const at = await copy();
    await markdownQuiz(at);
    await markdownImplementation(at.versionId);
    const service = pass();
    const { out, lines } = await logged(service, () => service.run('plain-text'));
    expect(out).toEqual({ converted: 1, refused: 0 });
    expect(lines).toContain('plain-text drafts: converted 1 teacher draft(s) whose texts held markdown; refused 0; skipped 0 an earlier pass refused');

    const implementation = await taskRow(at.versionId, 'implementation');
    expect(implementation.brief).toBe(plainTextOf(ownBrief()));
    expect(implementation.brief).toContain('Our own closing line.');
    expect(implementation.objectives[0]).toBe('Use the overdue rule');
    const quiz = (await taskRow(at.versionId, 'testing', 'recap')).checks as unknown as QuizChecks;
    expect(quiz.questions[0]).toMatchObject({ stem: 'What does q1 check?', options: [{ id: 'a', text: 'The overdue rule' }, { id: 'b', text: 'Nothing' }], explanation: 'Because the rule says so.' });
    // the platform-copied briefs beside them are 6.0.0's plain words, left as they are
    for (const key of ['requirements', 'testing'] as const) expect((await taskRow(at.versionId, key)).brief).toBe(reference(key));
    // the compiled snapshot follows the rows
    const snapshot = (await versions().findOneByOrFail({ id: at.versionId })).compiled!;
    expect(snapshot.content.phases.find((one) => one.key === 'implementation')!.taskPanel).toBe(implementation.brief);

    const held = await receipt();
    expect(held).toMatchObject({ converted: [at.versionId], refused: [], skipped: [], counts: { drafts: 1, phases: 2, texts: 5, skipped: 0, tasktrackrCopies: 1 } });
    expect(typeof held.at).toBe('string');
    // ids and counts, never a word a teacher wrote
    expect(Object.keys(held).sort()).toEqual(['at', 'converted', 'counts', 'refused', 'skipped']);
    expect(JSON.stringify(held)).not.toMatch(/overdue|rule|closing|q1/);

    // the draft's notes, one per phase that changed, and the log says the boot's; the quiz's Add was the
    // copy's first save, which found 6.0.0's plain briefs and noted nothing
    const notes = [markdownKeptWarning('Implementation', ['brief', 'objectives']), markdownKeptWarning('Testing', ['quiz text'])];
    expect((await conversionOf(at.versionId))!.notes).toEqual(notes);
    expect(lines).toContain(`a stored draft: ${notes.join(' ')}`);
  });

  it("converts a quiz's concept label and a Design story's title and line too (every text member)", async () => {
    await clean();
    const at = await copy();
    await markdownQuiz(at);
    const recap = await taskRow(at.versionId, 'testing', 'recap');
    const quiz = recap.checks as unknown as QuizChecks;
    quiz.questions[1] = { ...quiz.questions[1], concept: 'The **overdue** rule' };
    await taskRows().update({ id: recap.id }, { checks: quiz as never });
    const design = await taskRow(at.versionId, 'design');
    const checks = design.checks as unknown as { stories: { id: string; title: string; line: string }[] };
    checks.stories[0] = { ...checks.stories[0], title: '**Overdue** report', line: 'As a _lead_ I see late tasks' };
    await taskRows().update({ id: design.id }, { checks: checks as never });
    await pass().run('plain-text');
    expect(((await taskRow(at.versionId, 'testing', 'recap')).checks as unknown as QuizChecks).questions[1].concept).toBe('The overdue rule');
    const stored = (await taskRow(at.versionId, 'design')).checks as unknown as typeof checks;
    expect(stored.stories[0]).toMatchObject({ title: 'Overdue report', line: 'As a lead I see late tasks' });
    expect(plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Design')).toEqual([markdownKeptWarning('Design', ['story lines'])]);
  });

  it('a second boot converts nothing (the done marker)', async () => {
    await clean();
    const at = await copy();
    await markdownImplementation(at.versionId);
    expect(await pass().run('plain-text')).toEqual({ converted: 1, refused: 0 });
    expect(await settings().findOneBy({ key: PLAIN_TEXT_DRAFTS_DONE_KEY })).not.toBeNull();
    // a draft that holds a teacher's markdown again after the pass ran waits for its first save
    await markdownImplementation(at.versionId);
    expect(await pass().run('plain-text')).toBeNull();
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe(ownBrief());
  });

  it('skips a draft an earlier pass refused, and says so in the receipt', async () => {
    await clean();
    const refused = await copy();
    const converted = await copy();
    for (const one of [refused, converted]) await markdownImplementation(one.versionId);
    await settings().save({ key: STORY_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ counts: {}, drafts: { at: 'then', converted: [], refused: [{ versionId: refused.versionId, reason: 'the story could not be read' }] } }) });
    const before = await rowsOf(refused.versionId);
    const service = pass();
    const { out, lines } = await logged(service, () => service.run('plain-text'));
    expect(out).toEqual({ converted: 1, refused: 0 });
    expect(lines).toContain('plain-text drafts: converted 1 teacher draft(s) whose texts held markdown; refused 0; skipped 1 an earlier pass refused');
    expect(await rowsOf(refused.versionId)).toBe(before);
    expect(await conversionOf(refused.versionId)).toBeUndefined();
    const held = await receipt();
    expect(held.skipped).toEqual([{ versionId: refused.versionId, reason: 'an earlier pass refused this draft' }]);
    expect(held.converted).toEqual([converted.versionId]);
  });

  it('the receipt counts skipped drafts and TaskTrackr copies', async () => {
    await clean();
    const refused = await copy();
    const one = await copy();
    const two = await copy();
    const untouched = await copy();
    for (const at of [refused, one, two]) await markdownImplementation(at.versionId);
    // a draft opened from no version, as an upload opens one, is not a TaskTrackr copy, and its markdown is all its own
    const own = await copy();
    await versions().update({ id: own.versionId }, { forkedFromVersionId: null });
    await markdownImplementation(own.versionId);
    await settings().save({ key: STORY_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ drafts: { converted: [], refused: [{ versionId: refused.versionId, reason: 'x' }] } }) });
    await pass().run('plain-text');
    const held = await receipt();
    // an untouched copy holds TaskTrackr 6.0.0's plain words, so it is neither converted nor counted
    expect([...held.converted].sort()).toEqual([one.versionId, two.versionId, own.versionId].sort());
    expect(held.counts).toMatchObject({ drafts: 3, skipped: 1, tasktrackrCopies: 2 });
    expect((await taskRow(untouched.versionId, 'requirements')).brief).toBe(reference('requirements'));
    expect((await taskRow(own.versionId, 'implementation')).brief).toBe(plainTextOf(ownBrief()));
  });

  it("counts a converted TaskTrackr copy, and the copy stays on the reference's application, provenance and reviewer", async () => {
    await clean();
    const at = await copy();
    await markdownQuiz(at);
    const before = await identityOf(at);
    await pass().run('plain-text');
    expect((await receipt()).counts).toMatchObject({ drafts: 1, tasktrackrCopies: 1 });
    expect(((await taskRow(at.versionId, 'testing', 'recap')).checks as unknown as QuizChecks).questions[0].stem).toBe('What does q1 check?');
    expect(await identityOf(at)).toBe(before);
    const view = await world.service.readDraft(S1_TEACHER, at.projectId, at.versionId);
    for (const key of ['implementation', 'testing'] as const) {
      expect((await taskRow(at.versionId, key)).brief).toBe(plainTextOf(reference(key)));
      expect(view.phases.find((one) => one.key === key)!.provenance!.application).not.toBeNull();
    }
  });

  it('runs after the four passes', async () => {
    const service = pass();
    const order: string[] = [];
    jest.spyOn(service, 'run').mockImplementation(async (kind) => {
      order.push(kind);
      return null;
    });
    await service.onApplicationBootstrap();
    expect(order).toEqual(['story', 'design', 'runbook', 'change', 'plain-text']);
  });

  it("a builder's first save converts every text of the draft before its own write", async () => {
    const at = await copy();
    await markdownQuiz(at);
    await markdownImplementation(at.versionId);
    await settings().delete({ key: `plain-text-conversion.${at.versionId}` });
    const answer = await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read the **design** first.' });
    expect((await phaseRow(at.versionId, 'design')).intro).toBe('Read the design first.');
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe(plainTextOf(ownBrief()));
    expect(((await taskRow(at.versionId, 'testing', 'recap')).checks as unknown as QuizChecks).questions[0].stem).toBe('What does q1 check?');
    const notes = [markdownKeptWarning('Implementation', ['brief', 'objectives']), markdownKeptWarning('Testing', ['quiz text'])];
    expect((await conversionOf(at.versionId))!.notes).toEqual(notes);
    expect(answer.plainTextConversion).toEqual({ notes });
    // the next save converts nothing more and says nothing more
    const next = await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read it.' });
    expect(next).not.toHaveProperty('plainTextConversion');
    expect((await conversionOf(at.versionId))!.notes).toEqual(notes);
  });

  it("an untouched TaskTrackr 6.0.0 copy's first save finds nothing to convert and says nothing, and its provenance and reviewer do not move", async () => {
    const at = await copy();
    const before = await identityOf(at);
    const answer = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'design', 'main', { title: (await taskRow(at.versionId, 'design')).title });
    // 6.0.0's platform-copied briefs are plain, so the save's conversion leaves them byte for byte
    for (const key of ['requirements', 'implementation', 'testing'] as const) expect((await taskRow(at.versionId, key)).brief).toBe(reference(key));
    expect(answer).not.toHaveProperty('plainTextConversion');
    expect(await conversionOf(at.versionId)).toBeUndefined();
    expect(await identityOf(at)).toBe(before);
  });

  it('a refused save converts nothing', async () => {
    const at = await copy();
    await markdownImplementation(at.versionId);
    const before = await rowsOf(at.versionId);
    await expect(world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: '   ' })).rejects.toThrow();
    expect(await rowsOf(at.versionId)).toBe(before);
    expect(await conversionOf(at.versionId)).toBeUndefined();
  });

  it("a draft conversion that meets an HTML comment says so once per phase in the draft's notes", async () => {
    await clean();
    const at = await copy();
    // the teacher's own markdown and a comment of theirs (6.0.0's own brief is plain)
    await markdownImplementation(at.versionId, `${ownBrief()}\n<!-- marked for the **next** term -->\n`);
    const row = await taskRow(at.versionId, 'implementation');
    await taskRows().update({ id: row.id }, { title: 'Fill the gaps <!-- a note -->' });
    await pass().run('plain-text');
    const notes = (await conversionOf(at.versionId))!.notes;
    expect(plainTextNotesOn(notes, 'Implementation')).toEqual([
      markdownKeptWarning('Implementation', ['brief', 'objectives']),
      htmlCommentWarning('Implementation', ['brief', 'task title']),
    ]);
    // the comment is kept as written, nothing inside it converted
    const stored = await taskRow(at.versionId, 'implementation');
    expect(stored.brief).toContain('<!-- marked for the **next** term -->');
    expect(stored.title).toBe('Fill the gaps <!-- a note -->');
  });

  it("a Put back converts a teacher's markdown it copies back, and a Remove takes the phase's notes with it", async () => {
    // the version this draft was opened from: a teacher's own, whose Implementation objective was written with markdown
    const source = await copy();
    const sourceTask = await taskRow(source.versionId, 'implementation');
    await taskRows().update({ id: sourceTask.id }, { objectives: ['Keep the **late** rows', ...sourceTask.objectives.slice(1)] });
    await draftSnapshot(world, source);
    await versions().update({ id: source.versionId }, { status: 'published' });
    const at = await copy();
    await versions().update({ id: at.versionId }, { forkedFromVersionId: source.versionId });
    // 6.0.0's own briefs are plain, so another phase's note comes from the teacher's own markdown: a Testing quiz
    // (its Add is a save, which finds nothing to convert yet)
    await markdownQuiz(at);
    await markdownImplementation(at.versionId);
    await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: (await phaseRow(at.versionId, 'design')).intro });
    expect(plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Implementation')).toEqual([markdownKeptWarning('Implementation', ['brief', 'objectives'])]);
    const others = (await conversionOf(at.versionId))!.notes.filter((note) => !plainTextNotesOn([note], 'Implementation').length);
    expect(others).toEqual([markdownKeptWarning('Testing', ['quiz text'])]);
    await world.service.removePhase(S1_TEACHER, at.projectId, at.versionId, 'implementation');
    // the Remove took the phase's notes with it, and kept every other phase's
    expect((await conversionOf(at.versionId))!.notes).toEqual(others);
    const view = await world.service.restorePhase(S1_TEACHER, at.projectId, at.versionId, 'implementation');
    // the source's objective came back and was stored plain; the platform-copied brief it brought back is 6.0.0's
    // plain words, so only the objectives are noted
    const restored = await taskRow(at.versionId, 'implementation');
    expect(restored.objectives[0]).toBe('Keep the late rows');
    expect(restored.brief).toBe(reference('implementation'));
    expect(plainTextNotesOn(view.plainTextConversion!.notes, 'Implementation')).toEqual([markdownKeptWarning('Implementation', ['objectives'])]);
    expect(view.plainTextConversion!.notes.filter((note) => !plainTextNotesOn([note], 'Implementation').length)).toEqual(others);
  });

  it('a Remove or an Add on a draft never saved converts the rest of the draft', async () => {
    const at = await copy();
    await markdownImplementation(at.versionId);
    await world.service.removePhase(S1_TEACHER, at.projectId, at.versionId, 'design');
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe(plainTextOf(ownBrief()));
    await markdownImplementation(at.versionId);
    // Add is the door for a phase the draft's source does not hold: a draft opened from no version, as an upload opens one
    await versions().update({ id: at.versionId }, { forkedFromVersionId: null });
    const view = await world.service.addPhase(S1_TEACHER, at.projectId, at.versionId, 'design');
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe(plainTextOf(ownBrief()));
    expect(plainTextNotesOn(view.plainTextConversion!.notes, 'Implementation')).toEqual([markdownKeptWarning('Implementation', ['brief', 'objectives'])]);
  });

  it('a stored text that held only markup is stored empty at boot, not refused, and its phase says so in the notes', async () => {
    await clean();
    const at = await copy();
    const row = await taskRow(at.versionId, 'implementation');
    await taskRows().update({ id: row.id }, { brief: '---' });
    expect(await pass().run('plain-text')).toEqual({ converted: 1, refused: 0 });
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe('');
    expect(await receipt()).toMatchObject({ converted: [at.versionId], refused: [], counts: { drafts: 1 } });
    // after the phase's markdown note, the sentence that tells the teacher to fill it in
    expect(plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Implementation')).toEqual([
      markdownKeptWarning('Implementation', ['brief']),
      markupOnlyWarning('Implementation', ['brief']),
    ]);
  });

  it("a first save of another phase stores a text that held only markup empty, not refused, and notes it on that text's phase", async () => {
    const at = await copy();
    const row = await taskRow(at.versionId, 'implementation');
    await taskRows().update({ id: row.id }, { brief: '#' });
    const answer = await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read the design first.' });
    expect((await phaseRow(at.versionId, 'design')).intro).toBe('Read the design first.');
    expect((await taskRow(at.versionId, 'implementation')).brief).toBe('');
    const notes = [markdownKeptWarning('Implementation', ['brief']), markupOnlyWarning('Implementation', ['brief'])];
    expect(plainTextNotesOn(answer.plainTextConversion!.notes, 'Implementation')).toEqual(notes);
    expect(plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Implementation')).toEqual(notes);
  });

  it("drops a phase's markup-only note once a door's write leaves none of the members it names empty", async () => {
    const at = await copy();
    // 6.0.0's own briefs are plain, so the other phases' notes come from the teacher's own markdown on both sides of
    // Implementation: a Requirements brief and a Testing quiz (the quiz's Add is a save, which finds nothing to convert)
    await markdownQuiz(at);
    const requirements = await taskRow(at.versionId, 'requirements');
    await taskRows().update({ id: requirements.id }, { brief: `${reference('requirements')}\nOur **own** line.\n` });
    const row = await taskRow(at.versionId, 'implementation');
    await taskRows().update({ id: row.id }, { brief: '#', objectives: ['---'] });
    await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read the design first.' });
    const implementationNotes = async () => plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Implementation');
    const kept = markdownKeptWarning('Implementation', ['brief', 'objectives']);
    const markupOnly = markupOnlyWarning('Implementation', ['brief', 'objectives']);
    expect(await implementationNotes()).toEqual([kept, markupOnly]);
    const others = (await conversionOf(at.versionId))!.notes.filter((note) => !plainTextNotesOn([note], 'Implementation').length);
    expect(others).toEqual([markdownKeptWarning('Requirements', ['brief']), markdownKeptWarning('Testing', ['quiz text'])]);
    // a save that leaves both members empty keeps the note, and says nothing new
    const same = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { title: 'Build the lending API' });
    expect(same).not.toHaveProperty('plainTextConversion');
    expect(await implementationNotes()).toEqual([kept, markupOnly]);
    // the brief filled in while the objectives stay empty: the note names one member still empty, so it stays as written
    const half = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { brief: 'Build the lending API.' });
    expect(half).not.toHaveProperty('plainTextConversion');
    expect(await implementationNotes()).toEqual([kept, markupOnly]);
    // the objectives filled in too: the note goes, the markdown note and the other phases' notes stay
    const answer = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { objectives: ['Lend a book'] });
    expect(await implementationNotes()).toEqual([kept]);
    expect((await conversionOf(at.versionId))!.notes).toEqual([...others.slice(0, 1), kept, ...others.slice(1)]);
    expect(answer.plainTextConversion).toEqual({ notes: (await conversionOf(at.versionId))!.notes });
  });

  it("leaves a published version alone: its rows, its compiled snapshot, its learner's read and an AI request built from it do not move", async () => {
    await clean();
    const at = await copy();
    const slug = `plain-text-draft-${copies}`;
    // the teacher's own markdown beside TaskTrackr's, published without a save, as a version published before texts were kept plain holds it
    const design = await phaseRow(at.versionId, 'design');
    await world.dataSource.getRepository(ProjectPhaseEntity).update({ id: design.id }, { intro: 'Read the **design** first.' });
    await world.service.publish(S1_TEACHER, at.projectId, at.versionId, { version: '1.0.0' });
    const next = await world.service.createDraftVersion(S1_TEACHER, at.projectId, { fromVersionId: at.versionId });
    expect(await compiledOf(at.versionId)).toContain('Read the **design** first.');

    const workflow = new WorkflowService(
      world.dataSource.getRepository(EnrollmentEntity),
      world.dataSource.getRepository(PhaseStateEntity),
      world.dataSource.getRepository(ReleaseRecordEntity),
      world.content,
      { latestFor: async () => null } as unknown as FeedbackService,
      world.dataSource,
    );
    const users = world.dataSource.getRepository(UserEntity);
    const learner = await users.save(users.create({ email: `${slug}-learner@learnsdlc.test`, passwordHash: 'x', displayName: 'Learner', role: 'LEARNER' }));
    await workflow.enroll(learner.id, slug);
    const states = world.dataSource.getRepository(PhaseStateEntity);
    const opened = async (key: PhaseKey) => {
      const state = await states.findOneByOrFail({ userId: learner.id, phaseKey: key });
      if (state.status === 'locked') await states.update({ id: state.id }, { status: 'in_progress' });
      return state.id;
    };
    const reads = async () =>
      JSON.stringify(await Promise.all((['design', 'implementation'] as const).map(async (key) => workflow.phaseDetail(learner.id, await opened(key)))));
    /** The rubric review an Implementation submission of the published version sends. */
    const review = async () => {
      const snapshot = (await versions().findOneByOrFail({ id: at.versionId })).compiled!;
      const phase = snapshot.content.phases.find((one) => one.key === 'implementation')!;
      const tasks = snapshot.phases.find((one) => one.key === 'implementation')!.tasks;
      const input = {
        criteria: tasks[0].rubric.criteria.map((one) => ({ key: one.key, title: one.title, weight: one.weight, score: 0, evidence: [] })),
        checks: [],
        overall: 0,
        hints: 0,
        ranBeforeSubmit: false,
        task: tasks[0],
        phaseTasks: tasks,
      } as unknown as ReviewInput;
      return JSON.stringify(composeReviewMessages(phase, input));
    };
    await reads();
    const before = { rows: await rowsOf(at.versionId), compiled: await compiledOf(at.versionId), learner: await reads(), review: await review() };

    expect(await pass().run('plain-text')).toEqual({ converted: 1, refused: 0 });
    expect((await receipt()).converted).toEqual([next.versionId]);
    expect((await phaseRow(next.versionId, 'design')).intro).toBe('Read the design first.');
    // the draft holds markdown again and its first save converts it
    await markdownImplementation(next.versionId);
    const answer = await world.service.updatePhase(S1_TEACHER, at.projectId, next.versionId, 'design', { intro: 'Read it.' });
    expect(answer.plainTextConversion).toBeDefined();
    expect((await taskRow(next.versionId, 'implementation')).brief).toBe(plainTextOf(ownBrief()));

    expect(await rowsOf(at.versionId)).toBe(before.rows);
    expect(await compiledOf(at.versionId)).toBe(before.compiled);
    expect(await reads()).toBe(before.learner);
    expect(await review()).toBe(before.review);
    expect((await versions().findOneByOrFail({ id: at.versionId })).status).toBe('published');
  });

  it("drops a phase's HTML-comment note once a door's write leaves none of its texts holding a comment", async () => {
    const at = await copy();
    // 6.0.0's own briefs are plain, so the other phases' notes come from the teacher's own markdown on both sides of
    // Implementation: a Requirements brief and a Testing quiz (the quiz's Add is a save, which finds nothing to convert)
    await markdownQuiz(at);
    const requirements = await taskRow(at.versionId, 'requirements');
    await taskRows().update({ id: requirements.id }, { brief: `${reference('requirements')}\nOur **own** line.\n` });
    // the teacher's own markdown and a comment of theirs
    await markdownImplementation(at.versionId, `${ownBrief()}\n<!-- marked for the **next** term -->\n`);
    await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read the design first.' });
    const implementationNotes = async () => plainTextNotesOn((await conversionOf(at.versionId))!.notes, 'Implementation');
    const kept = markdownKeptWarning('Implementation', ['brief', 'objectives']);
    expect(await implementationNotes()).toEqual([kept, htmlCommentWarning('Implementation', ['brief'])]);
    const others = (await conversionOf(at.versionId))!.notes.filter((note) => !plainTextNotesOn([note], 'Implementation').length);
    // one note on each side of Implementation, so the order check below holds
    expect(others).toEqual([markdownKeptWarning('Requirements', ['brief']), markdownKeptWarning('Testing', ['quiz text'])]);
    // a save that keeps the comment keeps the note, and says nothing new
    const same = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { title: 'Build the lending API' });
    expect(same).not.toHaveProperty('plainTextConversion');
    expect(await implementationNotes()).toEqual([kept, htmlCommentWarning('Implementation', ['brief'])]);
    // the teacher deletes the comment: its note goes, the markdown note and the other phases' notes stay
    const answer = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { brief: plainTextOf(ownBrief()) });
    expect(await implementationNotes()).toEqual([kept]);
    expect((await conversionOf(at.versionId))!.notes).toEqual([...others.slice(0, 1), kept, ...others.slice(1)]);
    expect(answer.plainTextConversion).toEqual({ notes: (await conversionOf(at.versionId))!.notes });
  });

  it("a save that drops the draft's last note answers plainTextConversion { notes: [] } and deletes the row", async () => {
    const at = await copy();
    // the first save finds 6.0.0's plain texts and converts nothing; then the draft's one note is a comment note no
    // stored text still bears out
    await world.service.updatePhase(S1_TEACHER, at.projectId, at.versionId, 'design', { intro: 'Read the design first.' });
    await settings().save({ key: `plain-text-conversion.${at.versionId}`, value: JSON.stringify({ notes: [htmlCommentWarning('Implementation', ['brief'])] }) });
    expect((await conversionOf(at.versionId))!.notes).toEqual([htmlCommentWarning('Implementation', ['brief'])]);
    const answer = await world.service.updateTask(S1_TEACHER, at.projectId, at.versionId, 'implementation', 'main', { title: 'Build the lending API' });
    expect(answer.plainTextConversion).toEqual({ notes: [] });
    expect(await settings().findOneBy({ key: `plain-text-conversion.${at.versionId}` })).toBeNull();
    expect(await conversionOf(at.versionId)).toBeUndefined();
  });

  it('reads a notes row that holds no note as none, so the draft view carries no plainTextConversion', async () => {
    const at = await copy();
    await settings().save({ key: `plain-text-conversion.${at.versionId}`, value: JSON.stringify({ notes: [] }) });
    const view = await world.service.readDraft(S1_TEACHER, at.projectId, at.versionId);
    expect(view).not.toHaveProperty('plainTextConversion');
  });
});

/*
 * The reference anchors' plain-text twins after a restart. A store written
 * before texts were kept plain holds TaskTrackr 5.0.0 published, its briefs markdown, and a teacher's untouched copy of it; the boot's
 * plain-text pass converts the copy. The process that converted it read the published versions on the way (`persist`),
 * so the copy reads `reference` there. A later process starts with no twin but the disk pack's, which is 6.0.0's now,
 * so the boot itself has to read the published versions' twins before any draft save. The store is a file, and the
 * later process is a fresh module registry over it: every module-level memo (the twins, provenance's keys, the disk
 * pack) starts empty, as after a restart.
 */
describe('the reference twins after a restart', () => {
  const olderTaskTrackrPack500 = () => layoutFromManifest(olderPointerPack()).source;
  let folder = '';
  let file = '';
  let fork = { projectId: '', versionId: '' };

  /** What the editor and the AI read of each phase of a draft's stored compile: no save, so nothing remembers on the way. */
  type Readers = {
    taskScopeOf: typeof taskScopeOf;
    phaseScopeOf: typeof phaseScopeOf;
    isReferenceExecutablePhase: typeof isReferenceExecutablePhase;
  };
  const identityFrom = async (
    readers: Readers,
    service: Pick<AuthoringService, 'readDraft'>,
    compiled: { content: { phases: PhaseContent[] }; phases: { key: string; tasks: CompiledTask[] }[] },
  ) => {
    const view = await service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
    const keys = ['requirements', 'design', 'implementation', 'testing'] as const;
    return keys.map((key) => {
      const phase = compiled.content.phases.find((one) => one.key === key)!;
      const tasks = compiled.phases.find((one) => one.key === key)!.tasks;
      const work = tasks.filter((one) => one.checkKind !== 'quiz');
      return {
        key,
        scope: readers.taskScopeOf(phase, work[0], tasks).kind,
        phaseScope: readers.phaseScopeOf(phase, tasks).kind,
        deep: readers.isReferenceExecutablePhase(phase, tasks),
        provenance: view.phases.find((one) => one.key === key)!.provenance,
      };
    });
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    folder = mkdtempSync(path.join(tmpdir(), 'twins-'));
    file = path.join(folder, 'store.sqlite');
  });

  afterAll(() => {
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it("a converted copy of TaskTrackr 5.0.0 reads reference in a fresh process from the boot on, with no draft save first, and the boot's step touches no row", async () => {
    // The first process that keeps texts plain: a store written before that, then the boot's plain-text pass.
    const first = await new DataSource({ type: 'better-sqlite3', database: file, entities: ALL_ENTITIES, synchronize: true }).initialize();
    const content = new ContentService();
    const importer = new ProjectImporterService(content, first);
    const older = await importer.importPack(olderTaskTrackrPack500(), { origin: 'seed', platformOwned: true });
    const shipped = await importer.importPack(new DirectoryPackSource(path.join(config.contentDir, 'tasktrackr')), { origin: 'seed', platformOwned: true });
    expect([older.version, shipped.version]).toEqual(['5.0.0', '6.0.0']);
    await first.getRepository(ProjectEntity).update({ id: shipped.projectId }, { isDefault: true });
    const registry = new ProjectRegistryService(content, first, { importedContent: [] } as unknown as ConstructorParameters<typeof ProjectRegistryService>[2]);
    await registry.load();
    const service = new AuthoringService(first, importer, registry);
    const made = await service.createProject(S1_TEACHER, { title: 'Copy of 5.0.0', slug: 'twins-500-copy', fromVersionId: older.projectVersionId });
    fork = { projectId: made.project.id, versionId: made.draftVersionId };
    const tasks = first.getRepository(ProjectTaskEntity);
    const phaseRows = first.getRepository(ProjectPhaseEntity);
    const briefOf = async (key: PhaseKey) =>
      (await tasks.findBy({ projectPhaseId: (await phaseRows.findOneByOrFail({ projectVersionId: fork.versionId, key })).id })).find((one) => one.checks.kind !== 'quiz')!.brief;
    // the copy holds 5.0.0's markdown briefs, as an untouched copy in a store written before texts were kept plain does
    const markdown: PhaseKey[] = [];
    for (const key of ['requirements', 'design', 'implementation', 'testing'] as const) if ((await briefOf(key)) !== plainTextOf(await briefOf(key))) markdown.push(key);
    expect(markdown).toEqual(['requirements', 'implementation', 'testing']);

    const boot = new DraftConversionService(first, service);
    await boot.onApplicationBootstrap();
    const receipt = JSON.parse((await first.getRepository(SettingEntity).findOneByOrFail({ key: PLAIN_TEXT_RECEIPT_KEY })).value);
    expect(receipt.converted).toEqual([fork.versionId]);
    expect(receipt.counts).toMatchObject({ drafts: 1, tasktrackrCopies: 1 });
    for (const key of ['requirements', 'implementation', 'testing'] as const) expect(await briefOf(key)).toBe(plainTextOf(await briefOf(key)));
    const notes = (await service.readDraft(S1_TEACHER, fork.projectId, fork.versionId)).plainTextConversion!.notes;
    for (const title of ['Requirements', 'Implementation', 'Testing']) expect([title, plainTextNotesOn(notes, title).length]).toEqual([title, 1]);
    const storedCompiled = async (ds: DataSource, entity: typeof ProjectVersionEntity) =>
      JSON.parse(JSON.stringify((await ds.getRepository(entity).findOneByOrFail({ id: fork.versionId })).compiled));
    // this process read the published versions while it converted, so the copy reads the reference here
    const converted = await identityFrom({ taskScopeOf, phaseScopeOf, isReferenceExecutablePhase }, service, await storedCompiled(first, ProjectVersionEntity));
    expect(converted.filter(({ key }) => key !== 'design').map(({ key, scope, phaseScope, deep }) => [key, scope, phaseScope, deep])).toEqual([
      ['requirements', 'reference', 'reference', false],
      ['implementation', 'reference', 'reference', true],
      ['testing', 'reference', 'reference', true],
    ]);
    for (const one of converted.filter(({ key }) => key === 'implementation' || key === 'testing')) expect([one.key, one.provenance!.application]).not.toEqual([one.key, null]);
    await first.destroy();

    // A restart: a fresh module registry over the same store, typeorm the one the store's driver was loaded by.
    type Fresh = {
      typeorm: typeof import('typeorm');
      entities: typeof import('../db/entities');
      projects: typeof import('../content/project.entities');
      content: typeof import('../content/content.service');
      importer: typeof import('../content/importer.service');
      registry: typeof import('../content/project-registry.service');
      authoring: typeof import('./authoring.service');
      conversion: typeof import('./draft-conversion.service');
      scope: typeof import('../assistant/project-scope');
      deep: typeof import('./deep-validation');
    };
    let fresh: Fresh | undefined;
    const typeorm = jest.requireActual('typeorm') as typeof import('typeorm');
    jest.isolateModules(() => {
      jest.doMock('typeorm', () => typeorm);
      (require('@nestjs/common') as typeof import('@nestjs/common')).Logger.overrideLogger(false);
      fresh = {
        typeorm,
        entities: require('../db/entities'),
        projects: require('../content/project.entities'),
        content: require('../content/content.service'),
        importer: require('../content/importer.service'),
        registry: require('../content/project-registry.service'),
        authoring: require('./authoring.service'),
        conversion: require('./draft-conversion.service'),
        scope: require('../assistant/project-scope'),
        deep: require('./deep-validation'),
      };
    });
    jest.dontMock('typeorm');
    const later = fresh!;
    expect(later.scope.taskScopeOf).not.toBe(taskScopeOf);
    const second = await new later.typeorm.DataSource({ type: 'better-sqlite3', database: file, entities: later.entities.ALL_ENTITIES, synchronize: false }).initialize();
    try {
      const laterContent = new later.content.ContentService();
      const laterImporter = new later.importer.ProjectImporterService(laterContent, second);
      const laterRegistry = new later.registry.ProjectRegistryService(laterContent, second, { importedContent: [] } as never);
      await laterRegistry.load();
      const laterService = new later.authoring.AuthoringService(second, laterImporter, laterRegistry);
      const readers: Readers = { taskScopeOf: later.scope.taskScopeOf, phaseScopeOf: later.scope.phaseScopeOf, isReferenceExecutablePhase: later.deep.isReferenceExecutablePhase };
      const compiled = await storedCompiled(second, later.projects.ProjectVersionEntity);
      /** Every row the boot could write, as stored. */
      const rows = async () => {
        const all: Record<string, unknown> = {};
        for (const table of ['projects', 'project_versions', 'project_phases', 'project_tasks', 'project_files', 'settings']) all[table] = await second.query(`SELECT * FROM ${table} ORDER BY 1`);
        return JSON.stringify(all);
      };
      const before = await rows();

      const laterBoot = new later.conversion.DraftConversionService(second, laterService);
      const log = jest.spyOn((laterBoot as unknown as { logger: Logger }).logger, 'log');
      await laterBoot.onApplicationBootstrap();
      const lines = log.mock.calls.map(([line]) => String(line));
      log.mockRestore();
      // the boot's step alone reads the published versions: the copy reads the reference everywhere it did
      expect(await identityFrom(readers, laterService, compiled)).toEqual(converted);
      expect(await rows()).toBe(before);
      // said once, by count: two published versions of the reference project, no id and no word of a brief
      expect(lines.filter((line) => line.startsWith('reference twins:'))).toEqual(['reference twins: read 2 published reference version(s) for their plain-text twins']);
      // and once is enough: a second run reads the same and writes nothing
      expect(await laterService.rememberReferenceTwins()).toBe(2);
      expect(await identityFrom(readers, laterService, compiled)).toEqual(converted);
      expect(await rows()).toBe(before);
    } finally {
      await second.destroy();
    }
  }, 180_000);
});

// The harness is legacy-requirements.spec.ts's world (`openForkWorld`: an
// in-memory database with TaskTrackr seeded), with shelf-design-task, a pack
// whose Requirements and Design are both of the older kind, beside it. A
// teacher's draft stored before the design kind holds a markdown Design; the
// stored-draft pass converts it (`convertLegacyDesignRows`, through the walker
// the Requirements pass shares), or lists it with the reason it cannot.
import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import {
  CHANGE_OLDER_FORMAT_REFUSAL, DESIGN_OLDER_FORMAT_REFUSAL, REQUIREMENTS_OLDER_FORMAT_REFUSAL, RUNBOOK_OLDER_FORMAT_REFUSAL, retiredWrittenPhaseUploadRefusal, type PhaseKey,
} from '@learnsdlc/shared';
import { DirectoryPackSource } from '../content/pack-source';
import { ProjectImporterService } from '../content/importer.service';
import { ProjectFileEntity, ProjectPhaseEntity, ProjectTaskEntity, ProjectVersionEntity } from '../content/project.entities';
import { SettingEntity } from '../db/entities';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import { openForkWorld, type ForkWorld } from '../../test/tasktrackr-phase';
import { DESIGN_DRAFTS_DONE_KEY, DraftConversionService } from './draft-conversion.service';
import { MIDDLE_PHASE, hostPackThreePhase } from '../../test/written-phase-pack';
import { fixtureQuizQuestions } from '../../test/quiz-fixture';
import { importOlderPack, storeOlderPhases } from '../../test/older-written-rows';
import { layoutFromManifest } from '../content/legacy-layout';

const caller = { id: 'teacher-legacy-design', role: 'INSTRUCTOR' as const, cohort: 'default' };
const DIR = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'shelf-design-task');
/**
 * shelf-design-task stays in the older, pointer layout on purpose, and the loader reads only the folder
 * layout, so the importer is handed the pack converted once, as the upload door converts an older archive. The
 * older source itself still says which phases an older import stored in the older kind.
 */
const converted = (older: DirectoryPackSource) => layoutFromManifest(older).source;
const SECOND_WRITTEN_TASK = 'the Design phase holds another written task beside the design, and a design phase cannot';

describe('a Design draft of the older kind, stored before the design kind, is converted by the stored-draft pass', () => {
  let world: ForkWorld;
  let importer: ProjectImporterService;
  let legacyVersionId = '';

  const designOf = async (versionId: string) => {
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'design' });
    const tasks = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    const files = await world.dataSource.getRepository(ProjectFileEntity).findBy({ projectVersionId: versionId, ownerId: phase.id });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId });
    return { phase, tasks, paths: files.map((f) => f.path).sort(), compiled: version.compiled!.content.phases.find((one) => one.key === 'design')! };
  };

  const expectConverted = async (versionId: string) => {
    const { phase, tasks, paths, compiled } = await designOf(versionId);
    expect(phase.artifactKind).toBe('design');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].checks.kind).toBe('design');
    expect(tasks[0].artefactPath).toBeNull();
    expect(paths).toEqual(['design/design.json']);
    expect(compiled.checks.kind).toBe('design');
    expect(compiled.artifactKind).toBe('design');
  };

  /**
   * A teacher's draft as it was stored before the design kind: its Design rows
   * in the older kind, its Requirements already converted by the story pass
   * (which runs first) unless `both` keeps it older too.
   */
  const storedLegacyDraft = async (title: string, both = false) => {
    const source = new DirectoryPackSource(DIR);
    const stored = await importer.importTeacherDraft(converted(source), { ownerId: caller.id, title });
    await storeOlderPhases(world.dataSource, stored.versionId, source, both ? ['requirements', 'design'] : ['design']);
    return stored;
  };

  /** A second written task beside the stored draft's markdown Design task: a design phase cannot hold one. */
  const addSecondWrittenTask = async (versionId: string) => {
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: versionId, key: 'design' });
    const [task] = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    await world.dataSource
      .getRepository(ProjectTaskEntity)
      .save({ ...task, id: undefined, taskKey: 'notes', order: 2, checks: { ...task.checks, targets: ['design/notes.md'] } as never });
  };

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
    importer = new ProjectImporterService(world.content, world.dataSource);
    // a published platform pack of the older kind, stored as an older import stored it (boot imports never converted)
    const published = new DirectoryPackSource(DIR);
    legacyVersionId = (await importOlderPack(world.content, world.dataSource, published, () => importer.importPack(converted(published), { origin: 'seed', platformOwned: true }))).projectVersionId;
    await world.registry.load();
  }, 120_000);

  afterAll(async () => {
    await world?.close();
  });

  it('the published source stays markdown: only the draft written from it changes', async () => {
    expect((await designOf(legacyVersionId)).compiled.checks.kind).toBe('markdown');
  });

  it('a draft stored before the design kind is converted by the one-time pass, which then finds nothing more', async () => {
    const stored = await storedLegacyDraft('Stored legacy design');
    expect((await designOf(stored.versionId)).tasks[0].checks.kind).toBe('markdown');
    const first = await world.service.convertLegacyDesignDrafts();
    expect(first.converted).toContain(stored.versionId);
    expect(first.refused).toEqual([]);
    expect(first.notes).toHaveLength(first.converted.length);
    expect(first.notes).toEqual(first.converted.map(() => expect.stringMatching(/^Design converted from markdown: \d+ rules? became criterion sentences?, the API contract (on|off), /)));
    await expectConverted(stored.versionId);
    expect(await world.service.convertLegacyDesignDrafts()).toEqual({ converted: [], refused: [], notes: [] });
  });

  it('the pass converts a stored draft with a quiz beside its Design task, and keeps the quiz', async () => {
    const stored = await storedLegacyDraft('Stored legacy design with a quiz');
    const { phase, tasks } = await designOf(stored.versionId);
    const [task] = tasks;
    await world.dataSource.getRepository(ProjectTaskEntity).save({
      ...task, id: undefined, taskKey: 'concepts', order: 2, required: false, artefactType: 'quiz', artefactPath: null,
      checks: { kind: 'quiz', questions: fixtureQuizQuestions(5), criterion: 'concepts' } as never, rubric: { passThreshold: 70, criteria: [{ key: 'concepts', title: 'Concepts', weight: 1, description: 'The quiz.' }] } as never,
    });
    expect(await world.dataSource.getRepository(ProjectTaskEntity).countBy({ projectPhaseId: phase.id })).toBe(2);
    const pass = await world.service.convertLegacyDesignDrafts();
    expect(pass.converted).toContain(stored.versionId);
    const after = await designOf(stored.versionId);
    expect(after.tasks.map((one) => [one.taskKey, one.checks.kind]).sort()).toEqual([['concepts', 'quiz'], [task.taskKey, 'design']].sort());
    expect(after.compiled.artifactKind).toBe('design');
  });

  it('the pass keeps a teacher\'s own wording of an inherited criterion on a draft forked from a draft', async () => {
    // a fork chain: the platform pack, a draft copied from it, and a draft copied from that one
    const middle = await storedLegacyDraft('Stored legacy design, the middle draft');
    const stored = await storedLegacyDraft('Stored legacy design, reworded');
    const versions = world.dataSource.getRepository(ProjectVersionEntity);
    await versions.update({ id: middle.versionId }, { forkedFromVersionId: legacyVersionId } as never);
    await versions.update({ id: stored.versionId }, { forkedFromVersionId: middle.versionId } as never);
    const { tasks } = await designOf(stored.versionId);
    const [task] = tasks;
    const wording = 'Every story is named where the design serves it';
    const criteria = (task.rubric.criteria as { key: string; description?: string }[]).map((c, i) => (i === 0 ? { ...c, description: wording } : c));
    await world.dataSource.getRepository(ProjectTaskEntity).update({ id: task.id }, { rubric: { ...task.rubric, criteria } as never });
    const pass = await world.service.convertLegacyDesignDrafts();
    expect(pass.converted).toContain(stored.versionId);
    const after = await designOf(stored.versionId);
    const first = (after.tasks[0].rubric.criteria as { key: string; description?: string }[]).find((c) => c.key === criteria[0].key)!;
    expect(first.description!.startsWith(`${wording}.`)).toBe(true);
    expect(pass.notes.find((note) => note.includes("the teacher's own wording of"))).toBeDefined();
  });

  it('a draft the pass cannot convert is left as it is, listed with the reason, and refused at publish', async () => {
    // Whatever an earlier case left stored is converted first, so this pass
    // converts nothing; an earlier case's draft of two written tasks is refused beside this one.
    await world.service.convertLegacyDesignDrafts();
    // its Requirements already converted by the story pass, so what is left over is the Design alone
    const stored = await storedLegacyDraft('Unconvertible design');
    await addSecondWrittenTask(stored.versionId);
    const out = await world.service.convertLegacyDesignDrafts();
    expect(out.converted).toEqual([]);
    expect(out.refused).toContainEqual({ versionId: stored.versionId, reason: SECOND_WRITTEN_TASK });
    expect(out.refused.map((one) => one.reason)).toEqual(out.refused.map(() => SECOND_WRITTEN_TASK));
    expect((await designOf(stored.versionId)).tasks.map((one) => one.checks.kind)).toEqual(['markdown', 'markdown']);
    // Left in the older format, it cannot be published: the refusal says how to convert it.
    await expect(world.service.publish(caller, stored.projectId, stored.versionId, { version: '1.0.0' })).rejects.toThrow(DESIGN_OLDER_FORMAT_REFUSAL);
  });

  it('publish refuses a draft whose Design is still markdown, with the fixed sentence', async () => {
    // a draft whose Design task was put back to markdown by hand, as an older store holds one
    const made = await world.service.createProject(caller, { title: 'Refused design', slug: 'refused-design', fromVersionId: legacyVersionId });
    const { tasks } = await designOf(made.draftVersionId);
    await world.dataSource
      .getRepository(ProjectTaskEntity)
      .update({ id: tasks[0].id }, { checks: { kind: 'markdown', targets: ['design/my-design.md'], rules: [] } as never });
    await expect(world.service.publish(caller, made.project.id, made.draftVersionId, { version: '1.0.0' })).rejects.toThrow(DESIGN_OLDER_FORMAT_REFUSAL);
    expect((await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: made.draftVersionId })).status).toBe('draft');
  });

  it('a draft converted from a markdown Design publishes, and its version grades the design kind', async () => {
    const stored = await storedLegacyDraft('Converted then published');
    expect((await world.service.convertLegacyDesignDrafts()).converted).toContain(stored.versionId);
    await world.service.publish(caller, stored.projectId, stored.versionId, { version: '1.0.0' });
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: stored.versionId });
    expect([version.status, version.version]).toEqual(['published', '1.0.0']);
    await expectConverted(stored.versionId);
    // the published version grades its Design by the design kind: one task, its record the graded unit
    const tasks = version.compiled!.phases.find((one) => one.key === 'design')!.tasks;
    expect(tasks.map((task) => [task.checkKind, task.gradedUnits])).toEqual([['design', [{ kind: 'record', id: 'design/design.json' }]]]);
  });

  it('publish names Requirements first when both phases are still markdown', async () => {
    const stored = await storedLegacyDraft('Both older', true);
    await expect(world.service.publish(caller, stored.projectId, stored.versionId, { version: '1.0.0' })).rejects.toThrow(REQUIREMENTS_OLDER_FORMAT_REFUSAL);
  });

  it('a copy of a published older version is a design draft', async () => {
    const made = await world.service.createProject(caller, { title: 'Legacy design copy', slug: 'legacy-design-copy', fromVersionId: legacyVersionId });
    await expectConverted(made.draftVersionId);
    // the draft view says what the conversion removed, the reference documents among them
    const view = await world.service.readDraft(caller, made.project.id, made.draftVersionId);
    expect(view.designConversion?.note).toMatch(/^Design converted from markdown: /);
    expect(view.designConversion?.removed.length).toBeGreaterThan(0);
    expect(view.designConversion?.removed.every((one) => one.endsWith('.md'))).toBe(true);
  });

  it('the next draft opened from an older version published in the markdown Design format is a design draft', async () => {
    const stored = await storedLegacyDraft('Published legacy design');
    // A version published in the markdown format: written as published directly, since publish refuses it.
    await world.dataSource
      .getRepository(ProjectVersionEntity)
      .update({ id: stored.versionId }, { status: 'published', version: '1.0.0', publishedAt: new Date().toISOString() } as never);
    const opened = await world.service.createDraftVersion(caller, stored.projectId, { fromVersionId: stored.versionId } as never);
    await expectConverted(opened.versionId);
  });

  it('a second written task beside the Design keeps the next draft markdown, and the copy says so', async () => {
    const stored = await storedLegacyDraft('Two written design tasks');
    await addSecondWrittenTask(stored.versionId);
    await world.dataSource
      .getRepository(ProjectVersionEntity)
      .update({ id: stored.versionId }, { status: 'published', version: '1.0.0', publishedAt: new Date().toISOString() } as never);
    const warn = jest.spyOn((world.service as unknown as { logger: Logger }).logger, 'warn');
    try {
      const opened = await world.service.createDraftVersion(caller, stored.projectId, { fromVersionId: stored.versionId } as never);
      expect((await designOf(opened.versionId)).tasks.map((one) => one.checks.kind)).toEqual(['markdown', 'markdown']);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`keeps its markdown Design: ${SECOND_WRITTEN_TASK}$`)));
    } finally {
      warn.mockRestore();
    }
  });

  it('a draft holding both older phases is converted whole by the first pass, and the second finds nothing', async () => {
    // The pass converts every other older phase of the draft before it compiles, as the copy does, so the
    // Requirements pass converts the Design too and its one note carries both conversions.
    const stored = await storedLegacyDraft('Both older, converted whole', true);
    const first = await world.service.convertLegacyRequirementsDrafts();
    expect(first.converted).toContain(stored.versionId);
    // one note, each conversion a sentence of its own
    expect(first.notes[first.converted.indexOf(stored.versionId)]).toMatch(/^Requirements converted from markdown: [^]*\. Design converted from markdown: /);
    expect(first.refused.map((one) => one.versionId)).not.toContain(stored.versionId);
    await expectConverted(stored.versionId);
    const requirements = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: stored.versionId, key: 'requirements' });
    const [task] = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: requirements.id });
    expect(task.checks.kind).toBe('story');
    const version = await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: stored.versionId });
    expect(version.compiled!.content.phases.find((one) => one.key === 'requirements')!.checks.kind).toBe('story');
    expect(version.compiled!.phases.find((one) => one.key === 'design')!.tasks.map((one) => one.checkKind)).toEqual(['design']);
    const second = await world.service.convertLegacyDesignDrafts();
    expect(second.converted).not.toContain(stored.versionId);
    expect(second.refused.map((one) => one.versionId)).not.toContain(stored.versionId);
  });

  it('a draft holding both older phases whose Design cannot convert is refused whole, naming the Design first', async () => {
    // The Design's refusal writes nothing and the compile decides: the draft does not compile with its Design
    // still older, so the Requirements conversion rolls back with it and both phases stay older.
    const stored = await storedLegacyDraft('Both older, Design stuck', true);
    await addSecondWrittenTask(stored.versionId);
    const out = await world.service.convertLegacyRequirementsDrafts();
    expect(out.converted).not.toContain(stored.versionId);
    const mine = out.refused.find((one) => one.versionId === stored.versionId);
    expect(mine?.reason.startsWith(`its Design keeps the older format (${SECOND_WRITTEN_TASK}); the converted draft does not compile: `)).toBe(true);
    const requirements = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: stored.versionId, key: 'requirements' });
    const [task] = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: requirements.id });
    expect(task.checks.kind).toBe('markdown');
    expect((await designOf(stored.versionId)).tasks.map((one) => one.checks.kind)).toEqual(['markdown', 'markdown']);
  });

  it('the boot pass converts stored older Design drafts once, writes its marker, and adds the drafts to the Design receipt', async () => {
    const stored = await storedLegacyDraft('Converted at boot');
    const service = new DraftConversionService(world.dataSource, world.service);
    const first = await service.run('design');
    expect(first).not.toBeNull();
    expect(first!.converted).toBeGreaterThanOrEqual(1);
    await expectConverted(stored.versionId);
    expect(await service.run('design')).toBeNull();
    const settings = world.dataSource.getRepository(SettingEntity);
    expect(await settings.findOneBy({ key: DESIGN_DRAFTS_DONE_KEY })).not.toBeNull();
    const receipt = JSON.parse((await settings.findOneByOrFail({ key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
    expect(receipt.drafts.converted).toContain(stored.versionId);
  });

  /** A copy of the shipped TaskTrackr whose `key` task's checks are put back by hand, as an older store holds them. */
  const copyWithOlder = async (slug: string, key: PhaseKey, older: (checks: Record<string, unknown>) => object) => {
    const made = await world.service.createProject(caller, { title: slug, slug, fromVersionId: world.seedVersionId });
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: made.draftVersionId, key });
    const [task] = (await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id })).filter((one) => one.checks.kind !== 'quiz');
    await world.dataSource.getRepository(ProjectTaskEntity).update({ id: task.id }, { checks: older(task.checks as unknown as Record<string, unknown>) as never });
    return { ...made, phase };
  };
  const status = async (versionId: string) => (await world.dataSource.getRepository(ProjectVersionEntity).findOneByOrFail({ id: versionId })).status;

  it('publish refuses a draft whose Deployment or Maintenance is in the older format, with its fixed sentence', async () => {
    const deployment = await copyWithOlder('older-deployment-publish', 'deployment', ({ runbook: _runbook, ...checks }) => checks);
    await expect(world.service.publish(caller, deployment.project.id, deployment.draftVersionId, { version: '1.0.0' })).rejects.toThrow(RUNBOOK_OLDER_FORMAT_REFUSAL);
    expect(await status(deployment.draftVersionId)).toBe('draft');
    const maintenance = await copyWithOlder('older-maintenance-publish', 'maintenance', ({ ticket: _ticket, change: _change, ...checks }) => checks);
    await expect(world.service.publish(caller, maintenance.project.id, maintenance.draftVersionId, { version: '1.0.0' })).rejects.toThrow(CHANGE_OLDER_FORMAT_REFUSAL);
    expect(await status(maintenance.draftVersionId)).toBe('draft');
  });

  it('publish refuses a draft holding a markdown task under a retired key, naming the phase', async () => {
    const written = await copyWithOlder('retired-testing-publish', 'testing', () => ({ kind: 'markdown', targets: ['tests/notes.md'], rules: [] }));
    await expect(world.service.publish(caller, written.project.id, written.draftVersionId, { version: '1.0.0' })).rejects.toThrow(retiredWrittenPhaseUploadRefusal(written.phase.title));
    expect(await status(written.draftVersionId)).toBe('draft');
  });

  it('a copy of TaskTrackr as it ships publishes', async () => {
    const made = await world.service.createProject(caller, { title: 'Shipped copy', slug: 'shipped-copy-publish', fromVersionId: world.seedVersionId });
    await world.service.publish(caller, made.project.id, made.draftVersionId, { version: '1.0.0' });
    expect(await status(made.draftVersionId)).toBe('published');
  });

  it('leaves a structured Design as it is on the three-phase host', async () => {
    // the host's middle phase is Shelf's Design, already of the design kind: nothing to convert, nothing to refuse
    const stored = await importer.importTeacherDraft(layoutFromManifest(hostPackThreePhase({ slug: 'legacy-design-host' })).source, { ownerId: caller.id, title: 'Three-phase host' });
    const out = await world.service.convertLegacyDesignDrafts();
    expect(out.converted).not.toContain(stored.versionId);
    expect(out.refused.map((one) => one.versionId)).not.toContain(stored.versionId);
    const phase = await world.dataSource.getRepository(ProjectPhaseEntity).findOneByOrFail({ projectVersionId: stored.versionId, key: MIDDLE_PHASE });
    const [task] = await world.dataSource.getRepository(ProjectTaskEntity).findBy({ projectPhaseId: phase.id });
    expect(task.checks.kind).toBe('design');
  });
});

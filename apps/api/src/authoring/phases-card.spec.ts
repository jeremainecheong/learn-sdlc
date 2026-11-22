import 'reflect-metadata';
import * as path from 'path';
import { HttpException, Logger } from '@nestjs/common';
import {
  NO_PHASE_TO_PUBLISH,
  PHASE_ORDER,
  PUBLISHED_PHASES_FIXED,
  addByUploadRefusal,
  alreadyHeldRefusal,
  cannotPutBackRefusal,
  keepOnePhaseRefusal,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
  unknownPhaseRefusal,
  type DraftVersionView,
  type PhaseKey,
} from '@learnsdlc/shared';
import { AuditEventEntity, EnrollmentEntity, PhaseStateEntity, ReleaseRecordEntity, SettingEntity, UserEntity } from '../db/entities';
import { sealedFilesOf } from '../content/blob.store';
import type { CompiledSnapshot } from '../content/pack-compiler';
import { DirectoryPackSource } from '../content/pack-source';
import { layoutFromManifest } from '../content/legacy-layout';
import { ProjectImporterService } from '../content/importer.service';
import {
  ProjectEntity,
  ProjectFileEntity,
  ProjectPhaseEntity,
  ProjectTaskEntity,
  ProjectVersionEntity,
} from '../content/project.entities';
import type { FeedbackService } from '../feedback/feedback.service';
import { WorkflowService } from '../workflow/workflow.service';
import { S1_TEACHER, copyTaskTrackr, openForkWorld, type Fork, type ForkWorld } from '../../test/tasktrackr-phase';
import { storeOlderPhases } from '../../test/older-written-rows';
import { executableContentDigest } from './deep-validation';
import { designConversionKey } from './legacy-design';
import { addFromSourceRefusal } from './phase-defaults';
import * as sealedRoles from './sealed-roles';
import { COMPILE_CHECK_ID, deepReceiptIsCurrent } from './validation';

/**
 * The Phases card's three doors and publish's subset rules
 * (5.2), on the authoring service over an in-memory store with TaskTrackr
 * imported as the platform pack: Remove, Put back and Add, each on a draft the
 * teacher owns, each answering the draft view and refusing in the card's own
 * sentences.
 */
const SHELF_DESIGN_TASK = path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'shelf-design-task');
const OTHER_TEACHER = { id: 'teacher-phases-other', role: 'INSTRUCTOR' as const, cohort: 'default' };
const ADMIN = { id: 'admin-phases', role: 'ADMIN' as const, cohort: 'default' };
type Caller = typeof S1_TEACHER | typeof OTHER_TEACHER | typeof ADMIN;

describe('the Phases card: remove, put back and add a phase', () => {
  let world: ForkWorld;
  let importer: ProjectImporterService;
  let workflow: WorkflowService;
  /** A teacher's 1.0.0 published without Design and Maintenance, and the draft 1.0.1 opened from it. */
  let lean: { projectId: string; publishedId: string; draftId: string };

  const versions = () => world.dataSource.getRepository(ProjectVersionEntity);
  const snapshotOf = async (versionId: string) => (await versions().findOneByOrFail({ id: versionId })).compiled as CompiledSnapshot;
  const phaseRows = async (versionId: string) =>
    (await world.dataSource.getRepository(ProjectPhaseEntity).findBy({ projectVersionId: versionId })).sort((a, b) => a.order - b.order);
  const keysOf = (view: DraftVersionView) => view.phases.map((one) => one.key);
  /** The Phases card's rows, which every answer of this API carries. */
  const setOf = (view: DraftVersionView) => {
    expect(view.phaseSet).toBeDefined();
    return view.phaseSet ?? [];
  };
  const rowOf = (view: DraftVersionView, key: PhaseKey) => setOf(view).find((one) => one.key === key);
  const remove = (fork: Fork, key: string) => world.service.removePhase(S1_TEACHER, fork.projectId, fork.versionId, key);
  const restore = (fork: Fork, key: string) => world.service.restorePhase(S1_TEACHER, fork.projectId, fork.versionId, key);
  const add = (fork: Fork, key: string) => world.service.addPhase(S1_TEACHER, fork.projectId, fork.versionId, key);
  /** The three doors, each called as `caller`. */
  const doors: Record<'removed' | 'restored' | 'added', (caller: Caller, fork: Fork, key: string) => Promise<DraftVersionView>> = {
    removed: (caller, fork, key) => world.service.removePhase(caller, fork.projectId, fork.versionId, key),
    restored: (caller, fork, key) => world.service.restorePhase(caller, fork.projectId, fork.versionId, key),
    added: (caller, fork, key) => world.service.addPhase(caller, fork.projectId, fork.versionId, key),
  };
  const fileCount = (versionId: string) => world.dataSource.getRepository(ProjectFileEntity).countBy({ projectVersionId: versionId });
  /** The project's `project.phase` audit rows, by change (rows written in one test share a createdAt to the millisecond). */
  const phaseAudits = async (projectId: string) =>
    (await world.dataSource.getRepository(AuditEventEntity).find({ where: { targetId: projectId, event: 'project.phase' as never } }))
      .map((row) => ({ actorUserId: row.actorUserId, action: row.action, detail: row.detail }))
      .sort((a, b) => String((a.detail as { change?: string })?.change).localeCompare(String((b.detail as { change?: string })?.change)));
  /** Everything a door writes: the phase rows, the snapshot, the file rows and the audit rows. */
  const stateOf = async (fork: Fork) =>
    JSON.stringify({
      rows: (await phaseRows(fork.versionId)).map((one) => [one.key, one.order]),
      compiled: (await versions().findOneByOrFail({ id: fork.versionId })).compiled,
      validation: (await versions().findOneByOrFail({ id: fork.versionId })).validation,
      files: await fileCount(fork.versionId),
      audits: await world.dataSource.getRepository(AuditEventEntity).countBy({ targetId: fork.projectId }),
    });

  /** The status and sentence a door refused with. */
  const refusal = async (pending: Promise<unknown>): Promise<{ status: number; message: string }> => {
    try {
      await pending;
    } catch (error) {
      if (error instanceof HttpException) return { status: error.getStatus(), message: error.message };
      throw error;
    }
    throw new Error('the door did not refuse');
  };

  /**
   * A teacher's upload of shelf-design-task: Requirements and Design, opened from no version. The fixture stays in
   * the older, pointer layout on purpose, so it is converted once, as the upload door converts an older archive.
   */
  const uploaded = async (title: string): Promise<Fork> => {
    const made = await importer.importTeacherDraft(layoutFromManifest(new DirectoryPackSource(SHELF_DESIGN_TASK)).source, { ownerId: S1_TEACHER.id, title });
    return { projectId: made.projectId, versionId: made.versionId };
  };

  /** A passed deep receipt made against the version's executable bytes as they stand. */
  const stampDeepReceipt = async (versionId: string) => {
    const row = await versions().findOneByOrFail({ id: versionId });
    const validation = { ...(row.validation ?? { findings: [], tier: 'fast', when: new Date().toISOString() }) };
    (validation as Record<string, unknown>).deep = { status: 'passed', contentDigest: executableContentDigest(row) };
    await versions().update({ id: versionId }, { validation } as never);
    expect(deepReceiptIsCurrent(await versions().findOneByOrFail({ id: versionId }))).toBe(true);
  };
  const deepCurrent = async (versionId: string) => deepReceiptIsCurrent(await versions().findOneByOrFail({ id: versionId }));

  beforeAll(async () => {
    Logger.overrideLogger(false);
    world = await openForkWorld();
    importer = new ProjectImporterService(world.content, world.dataSource);
    workflow = new WorkflowService(
      world.dataSource.getRepository(EnrollmentEntity),
      world.dataSource.getRepository(PhaseStateEntity),
      world.dataSource.getRepository(ReleaseRecordEntity),
      world.content,
      { latestFor: async () => null } as unknown as FeedbackService,
      world.dataSource,
    );
    const copy = await copyTaskTrackr(world, 'phases-card-lean');
    await remove(copy, 'design');
    await remove(copy, 'maintenance');
    await world.service.publish(S1_TEACHER, copy.projectId, copy.versionId, { version: '1.0.0' });
    const draft = await world.service.createDraftVersion(S1_TEACHER, copy.projectId, { fromVersionId: copy.versionId });
    lean = { projectId: copy.projectId, publishedId: copy.versionId, draftId: draft.versionId };
  }, 240_000);

  afterAll(async () => {
    await world?.close();
  });

  it('removes Testing from a copy: its rows leave the draft, the phases renumber 1 to 5, and the compile holds five', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-remove');
    const testing = (await phaseRows(fork.versionId)).find((one) => one.key === 'testing')!;
    expect(await world.dataSource.getRepository(ProjectFileEntity).countBy({ ownerId: testing.id })).toBeGreaterThan(0);

    const view = await remove(fork, 'testing');

    const five = PHASE_ORDER.filter((key) => key !== 'testing');
    expect(keysOf(view)).toEqual(five);
    expect((await phaseRows(fork.versionId)).map((one) => [one.key, one.order])).toEqual(five.map((key, at) => [key, at + 1]));
    expect(await world.dataSource.getRepository(ProjectTaskEntity).countBy({ projectPhaseId: testing.id })).toBe(0);
    expect(await world.dataSource.getRepository(ProjectFileEntity).countBy({ ownerId: testing.id })).toBe(0);
    const snapshot = await snapshotOf(fork.versionId);
    expect(snapshot.content.phases.map((one) => [one.key, one.order])).toEqual(five.map((key, at) => [key, at + 1]));
    expect(snapshot.phases.map((one) => one.key)).toEqual(five);
    expect(rowOf(view, 'testing')).toMatchObject({ state: 'removed', canPutBack: true, canAdd: false, canRemove: false });
  });

  it('refuses to remove the last phase, naming it', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-last');
    for (const key of ['design', 'implementation', 'testing', 'deployment', 'maintenance']) await remove(fork, key);
    const view = await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
    expect(keysOf(view)).toEqual(['requirements']);
    expect(rowOf(view, 'requirements')?.canRemove).toBe(false);

    expect(await refusal(remove(fork, 'requirements'))).toEqual({ status: 409, message: keepOnePhaseRefusal('requirements') });
    expect(keysOf(await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId))).toEqual(['requirements']);
  });

  it('puts Testing back from the source version: the compile holds its tasks, files and sealed files again, at order 4', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-restore');
    const source = (await snapshotOf(world.seedVersionId)).content.phases.find((one) => one.key === 'testing')!;
    const filesBefore = await fileCount(fork.versionId);
    await remove(fork, 'testing');

    const view = await restore(fork, 'testing');

    // Put back copies that phase's file rows and no other (and Remove took every role of them)
    expect(await fileCount(fork.versionId)).toBe(filesBefore);

    expect(keysOf(view)).toEqual([...PHASE_ORDER]);
    const snapshot = await snapshotOf(fork.versionId);
    const testing = snapshot.content.phases.find((one) => one.key === 'testing')!;
    expect(testing.order).toBe(4);
    expect(testing.checks).toEqual(source.checks);
    expect(testing.files.map((one) => one.path).sort()).toEqual(source.files.map((one) => one.path).sort());
    const sealedKeys = (phase: typeof source) => Object.fromEntries(Object.entries(sealedFilesOf(phase)).map(([role, files]) => [role, Object.keys(files ?? {}).sort()]));
    expect(sealedKeys(testing)).toEqual(sealedKeys(source));
    expect(snapshot.phases.find((one) => one.key === 'testing')?.tasks.length).toBeGreaterThan(0);
    expect((await phaseRows(fork.versionId)).map((one) => [one.key, one.order])).toEqual(PHASE_ORDER.map((key, at) => [key, at + 1]));
    expect(rowOf(view, 'testing')).toMatchObject({ state: 'held', removeSource: 'held', canRemove: true });
  });

  it('refuses to put back a phase the source never held, and one the draft holds', async () => {
    const draft = { projectId: lean.projectId, versionId: lean.draftId };
    expect(await refusal(restore(draft, 'maintenance'))).toEqual({ status: 409, message: cannotPutBackRefusal('maintenance', { hasSource: true }) });
    expect(await refusal(restore(draft, 'design'))).toEqual({ status: 409, message: cannotPutBackRefusal('design', { hasSource: true }) });
    expect(await refusal(restore(draft, 'testing'))).toEqual({ status: 409, message: alreadyHeldRefusal('testing') });
    // a draft opened from no version has nothing to put back from
    const upload = await uploaded('Phases card, nothing to put back');
    await remove(upload, 'design');
    expect(await refusal(restore(upload, 'design'))).toEqual({ status: 409, message: cannotPutBackRefusal('design', { hasSource: false }) });
  });

  it('adds Requirements to an uploaded draft that has none, compiling with the base snapshot it writes', async () => {
    const upload = await uploaded('Phases card, add Requirements');
    const removed = await remove(upload, 'requirements');
    expect(keysOf(removed)).toEqual(['design']);
    expect(rowOf(removed, 'requirements')).toMatchObject({ state: 'absent', canAdd: true, canPutBack: false, why: null });

    const view = await add(upload, 'requirements');

    expect(keysOf(view)).toEqual(['requirements', 'design']);
    const snapshot = await snapshotOf(upload.versionId);
    const requirements = snapshot.content.phases.find((one) => one.key === 'requirements')!;
    expect(requirements.order).toBe(1);
    expect(requirements.checks.kind).toBe('story');
    expect(requirements.files.map((one) => one.path)).toContain('requirements/story.json');
    expect(requirements.rubric.criteria.map((one) => one.key)).toEqual(['story']);
    expect(view.validation?.checks.find((one) => one.id === COMPILE_CHECK_ID)?.status).toBe('passed');
    const task = view.phases.find((one) => one.key === 'requirements')!.tasks;
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ title: 'The story' });
  });

  it("after a Remove, the draft's readiness line and its preview list the phases the draft holds", async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-readiness');
    await remove(fork, 'testing');
    const five = PHASE_ORDER.filter((key) => key !== 'testing');

    const view = await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
    const reported = new Set(view.validation!.checks.map((one) => one.phaseKey).filter((key): key is PhaseKey => key !== null));
    expect(PHASE_ORDER.filter((key) => reported.has(key))).toEqual(five);
    const preview = await world.service.learnerPreview(S1_TEACHER, fork.projectId, fork.versionId);
    expect(preview.phases.map((one) => one.key)).toEqual(five);
  });

  it('publishes a copy with Testing removed, and a learner enrols on its five phases', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-enrol');
    await remove(fork, 'testing');
    await world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' });
    const learner = await world.dataSource.getRepository(UserEntity).save(
      world.dataSource.getRepository(UserEntity).create({ email: 'phases-card-learner@learnsdlc.test', passwordHash: 'x', displayName: 'Learner', role: 'LEARNER' }),
    );

    const board = await workflow.enroll(learner.id, 'phases-card-enrol');

    const five = PHASE_ORDER.filter((key) => key !== 'testing');
    expect(board.phases.map((one) => [one.key, one.order])).toEqual(five.map((key, at) => [key, at + 1]));
    expect(board.phases[0].status).toBe('in_progress');
    expect(board.phases.slice(1).every((one) => one.status === 'locked')).toBe(true);
    expect(board.currentPhaseOrder).toBe(1);
  });

  it('refuses to add an application phase, naming the upload', async () => {
    const upload = await uploaded('Phases card, add Implementation');
    expect(await refusal(add(upload, 'implementation'))).toEqual({ status: 409, message: addByUploadRefusal('implementation') });
    const view = await world.service.readDraft(S1_TEACHER, upload.projectId, upload.versionId);
    expect(rowOf(view, 'implementation')).toMatchObject({ state: 'absent', canAdd: false, why: addByUploadRefusal('implementation') });
    // a held phase, and a written phase the source holds (the card offers Put back there)
    expect(await refusal(add(upload, 'design'))).toEqual({ status: 409, message: alreadyHeldRefusal('design') });
    const fork = await copyTaskTrackr(world, 'phases-card-add-held');
    await remove(fork, 'requirements');
    expect(await refusal(add(fork, 'requirements'))).toEqual({ status: 409, message: addFromSourceRefusal('requirements') });
    expect(addFromSourceRefusal('requirements')).toBe('Requirements is in the version this draft was opened from. Put it back to bring its stories and its task.');
    expect(addFromSourceRefusal('design')).toBe('Design is in the version this draft was opened from. Put it back to bring its design and its task.');
  });

  it('answers a published version with PUBLISHED_PHASES_FIXED, and an unknown key with unknownPhaseRefusal', async () => {
    const published = { projectId: lean.projectId, versionId: lean.publishedId };
    for (const door of [remove, restore, add]) {
      expect(await refusal(door(published, 'testing'))).toEqual({ status: 409, message: PUBLISHED_PHASES_FIXED });
      expect(await refusal(door(published, 'review'))).toEqual({ status: 404, message: unknownPhaseRefusal('review') });
    }
    // the key is echoed clipped to 64 code units
    const long = `${'x'.repeat(70)}`;
    const draft = { projectId: lean.projectId, versionId: lean.draftId };
    const clipped = await refusal(remove(draft, long));
    expect(clipped).toEqual({ status: 404, message: unknownPhaseRefusal('x'.repeat(64)) });
    expect(clipped.message).not.toContain('x'.repeat(65));
    // a phase the draft does not hold, in requirePhase's words
    expect(await refusal(remove(draft, 'design'))).toEqual({ status: 404, message: 'this project has no design phase' });
  });

  it("words the Remove confirm by the phase's source", async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-confirm');
    const copy = await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId);
    expect(rowOf(copy, 'testing')?.removeSource).toBe('held');

    const upload = await uploaded('Phases card, confirm');
    const fromUpload = await world.service.readDraft(S1_TEACHER, upload.projectId, upload.versionId);
    expect(rowOf(fromUpload, 'design')?.removeSource).toBe('no-source');

    const draft = { projectId: lean.projectId, versionId: lean.draftId };
    const before = await world.service.readDraft(S1_TEACHER, draft.projectId, draft.versionId);
    expect(rowOf(before, 'design')).toMatchObject({ state: 'absent', canAdd: true, canPutBack: false });
    const added = await add(draft, 'design');
    expect(keysOf(added)).toEqual(['requirements', 'design', 'implementation', 'testing', 'deployment']);
    expect(rowOf(added, 'design')).toMatchObject({ state: 'held', removeSource: 'not-held' });
    expect(rowOf(added, 'maintenance')).toMatchObject({ state: 'absent', canAdd: false, why: addByUploadRefusal('maintenance') });
    expect(setOf(added).map((one) => one.key)).toEqual([...PHASE_ORDER]);
    // the held phases carry no why, and only a held phase carries a removeSource
    expect(setOf(added).filter((one) => one.state !== 'held').every((one) => one.removeSource === undefined)).toBe(true);
    await remove(draft, 'design');
  });

  it('makes the deep receipt stale on a remove, a put back and an add', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-deep');
    await stampDeepReceipt(fork.versionId);
    await remove(fork, 'requirements');
    expect(await deepCurrent(fork.versionId)).toBe(false);
    await stampDeepReceipt(fork.versionId);
    await restore(fork, 'requirements');
    expect(await deepCurrent(fork.versionId)).toBe(false);

    // Add, on a draft whose executable bytes the add does not touch
    const upload = await uploaded('Phases card, deep receipt');
    await remove(upload, 'requirements');
    await stampDeepReceipt(upload.versionId);
    await add(upload, 'requirements');
    expect(await deepCurrent(upload.versionId)).toBe(false);
  });

  it('refuses to publish a draft with no phase', async () => {
    const upload = await uploaded('Phases card, nothing to publish');
    const held = await phaseRows(upload.versionId);
    for (const row of held) {
      await world.dataSource.getRepository(ProjectTaskEntity).delete({ projectPhaseId: row.id });
      await world.dataSource.getRepository(ProjectFileEntity).delete({ ownerId: row.id });
      await world.dataSource.getRepository(ProjectPhaseEntity).delete({ id: row.id });
    }
    expect(await refusal(world.service.publish(S1_TEACHER, upload.projectId, upload.versionId, { version: '1.0.0' }))).toEqual({
      status: 400,
      message: NO_PHASE_TO_PUBLISH,
    });
    expect((await versions().findOneByOrFail({ id: upload.versionId })).status).toBe('draft');
  });

  it('a task save on a phase another tab removed answers 404 and writes nothing', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-stale-tab');
    await remove(fork, 'testing');
    const before = JSON.stringify((await versions().findOneByOrFail({ id: fork.versionId })).compiled);

    expect(await refusal(world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'testing', 'main', { title: 'A stale tab' }))).toEqual({
      status: 404,
      message: 'this project has no testing phase',
    });
    expect(JSON.stringify((await versions().findOneByOrFail({ id: fork.versionId })).compiled)).toBe(before);
  });

  it('takes the version row lock first, after the owner check and before it reads the draft', async () => {
    // A no-op on sqlite (`lockVersionRow` answers null there), so the order of the calls is what this pins: a
    // second door or a deep run's swap on PostgreSQL waits on the row, then this door reads the draft as it stands.
    const fork = await copyTaskTrackr(world, 'phases-card-lock');
    const upload = await uploaded('Phases card, lock');
    await remove(upload, 'requirements');
    const internals = world.service as unknown as Record<'requireOwnedProject' | 'load', (...args: unknown[]) => unknown>;
    const owned = jest.spyOn(internals, 'requireOwnedProject');
    const load = jest.spyOn(internals, 'load');
    const lock = jest.spyOn(sealedRoles, 'lockVersionRow');
    try {
      const cases = [
        [doors.removed, fork, 'testing'],
        [doors.restored, fork, 'testing'],
        [doors.added, upload, 'requirements'],
      ] as const;
      for (const [door, target, key] of cases) {
        for (const spy of [owned, load, lock]) spy.mockClear();
        await door(S1_TEACHER, target, key);
        // the manager is left out of the comparison: printing one reads getters that throw on sqlite
        expect(lock.mock.calls[0].slice(1)).toEqual([target.versionId, 'pessimistic_write']);
        expect(owned.mock.invocationCallOrder[0]).toBeLessThan(lock.mock.invocationCallOrder[0]);
        expect(lock.mock.invocationCallOrder[0]).toBeLessThan(load.mock.invocationCallOrder[0]);
      }
    } finally {
      for (const spy of [owned, load, lock]) spy.mockRestore();
    }
  });

  it('every other draft writer takes the version row lock first too, so a door racing an ordinary save waits rather than deadlocks', async () => {
    // On PostgreSQL a door locks the version row and then rewrites rows, and a save that wrote rows first and the
    // version row last could wait on it in the other order. The seam here is the order of the calls: every writer
    // of a draft's rows asks `lockVersionRow` for the row first, after the owner check and before it reads the draft.
    // A no-op on sqlite; the PostgreSQL race itself is `phases-card-race.postgres.spec.ts`'s.
    const fork = await copyTaskTrackr(world, 'phases-card-writers-lock');
    const internals = world.service as unknown as Record<'requireOwnedProject' | 'load' | 'convertDraftTexts' | 'convertLegacyRows', (...args: unknown[]) => unknown>;
    const owned = jest.spyOn(internals, 'requireOwnedProject');
    const load = jest.spyOn(internals, 'load');
    const convert = jest.spyOn(internals, 'convertDraftTexts');
    const legacy = jest.spyOn(internals, 'convertLegacyRows');
    const lock = jest.spyOn(sealedRoles, 'lockVersionRow');
    try {
      const writers: [string, () => Promise<unknown>][] = [
        ['a task save', () => world.service.updateTask(S1_TEACHER, fork.projectId, fork.versionId, 'implementation', 'main', { title: 'Build the lending API' })],
        ['an intro save', () => world.service.updatePhase(S1_TEACHER, fork.projectId, fork.versionId, 'design', { intro: 'Read the design first.' })],
        ['a validation', () => world.service.validate(S1_TEACHER, fork.projectId, fork.versionId)],
        ['a tagline save', () => world.service.updateMeta(S1_TEACHER, fork.projectId, { tagline: 'Lend and return books.' })],
        ['a publish', () => world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' })],
      ];
      for (const [name, write] of writers) {
        for (const spy of [owned, load, lock]) spy.mockClear();
        await write();
        expect({ name, lock: lock.mock.calls[0]?.slice(1) }).toEqual({ name, lock: [fork.versionId, 'pessimistic_write'] });
        expect({ name, ownedFirst: owned.mock.invocationCallOrder[0] < lock.mock.invocationCallOrder[0] }).toEqual({ name, ownedFirst: true });
        if (load.mock.calls.length) {
          expect({ name, lockedFirst: lock.mock.invocationCallOrder[0] < load.mock.invocationCallOrder[0] }).toEqual({ name, lockedFirst: true });
        }
      }
      // the boot's plain-text pass locks each draft before it converts it
      const next = await world.service.createDraftVersion(S1_TEACHER, fork.projectId, { fromVersionId: fork.versionId });
      for (const spy of [lock, convert]) spy.mockClear();
      await world.service.convertMarkdownTextDrafts();
      const at = lock.mock.calls.findIndex((call) => call[1] === next.versionId);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lock.mock.calls[at][2]).toBe('pessimistic_write');
      const converted = convert.mock.calls.findIndex((call) => call[1] === next.versionId);
      expect(lock.mock.invocationCallOrder[at]).toBeLessThan(convert.mock.invocationCallOrder[converted]);
      // and a record pass locks each draft before it converts its older rows: a teacher's draft whose Design is
      // still of the older, markdown kind, as a draft stored before the design kind holds it (legacy-design.spec)
      const older = new DirectoryPackSource(path.join(__dirname, '..', '..', 'test', 'fixtures', 'upload-packs', 'shelf-design-task'));
      const stored = await new ProjectImporterService(world.content, world.dataSource).importTeacherDraft(layoutFromManifest(older).source, { ownerId: S1_TEACHER.id, title: 'Writers lock a stored older Design' });
      await storeOlderPhases(world.dataSource, stored.versionId, older, ['design']);
      for (const spy of [lock, legacy]) spy.mockClear();
      expect((await world.service.convertLegacyDesignDrafts()).converted).toContain(stored.versionId);
      const locked = lock.mock.calls.findIndex((call) => call[1] === stored.versionId);
      expect(locked).toBeGreaterThanOrEqual(0);
      expect(lock.mock.calls[locked][2]).toBe('pessimistic_write');
      const rewritten = legacy.mock.calls.findIndex((call) => call[1] === stored.versionId);
      expect(rewritten).toBeGreaterThanOrEqual(0);
      expect(lock.mock.invocationCallOrder[locked]).toBeLessThan(legacy.mock.invocationCallOrder[rewritten]);
    } finally {
      for (const spy of [owned, load, convert, legacy, lock]) spy.mockRestore();
    }
  });

  it("refuses every door on another teacher's draft, as an admin, and on the platform's own version, and writes nothing", async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-not-yours');
    await remove(fork, 'testing');
    const seedRow = await versions().findOneByOrFail({ id: world.seedVersionId });
    const seed = await world.dataSource.getRepository(ProjectEntity).findOneByOrFail({ id: seedRow.projectId });
    const platform = { projectId: seed.id, versionId: world.seedVersionId };
    const mine = await stateOf(fork);
    const theirs = await stateOf(platform);

    for (const door of Object.values(doors)) {
      for (const key of ['testing', 'design']) {
        // invisible to another teacher, by the written policy (a 404 tells nobody the project exists)
        expect(await refusal(door(OTHER_TEACHER, fork, key))).toEqual({ status: 404, message: 'no project with that id in your library' });
        expect(await refusal(door(ADMIN, fork, key))).toEqual({ status: 403, message: projectNotYoursRefusal() });
        expect(await refusal(door(S1_TEACHER, platform, key))).toEqual({ status: 403, message: platformProjectCopyOnlyRefusal(seed.title) });
      }
    }
    expect(await stateOf(fork)).toBe(mine);
    expect(await stateOf(platform)).toBe(theirs);
  });

  it('writes one project.phase audit row per door, naming the key and the change, and none for a refused door', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-audit');
    await remove(fork, 'testing');
    await restore(fork, 'testing');
    expect(await phaseAudits(fork.projectId)).toEqual([
      { actorUserId: S1_TEACHER.id, action: 'testing', detail: { versionId: fork.versionId, phaseKey: 'testing', change: 'removed' } },
      { actorUserId: S1_TEACHER.id, action: 'testing', detail: { versionId: fork.versionId, phaseKey: 'testing', change: 'restored' } },
    ]);
    const upload = await uploaded('Phases card, audit');
    await remove(upload, 'requirements');
    await add(upload, 'requirements');
    expect(await phaseAudits(upload.projectId)).toEqual([
      { actorUserId: S1_TEACHER.id, action: 'requirements', detail: { versionId: upload.versionId, phaseKey: 'requirements', change: 'added' } },
      { actorUserId: S1_TEACHER.id, action: 'requirements', detail: { versionId: upload.versionId, phaseKey: 'requirements', change: 'removed' } },
    ]);

    // refused doors leave no row
    await refusal(remove(fork, 'review'));
    await refusal(restore(fork, 'testing'));
    await refusal(add(fork, 'implementation'));
    await refusal(doors.removed(ADMIN, fork, 'testing'));
    expect(await phaseAudits(fork.projectId)).toHaveLength(2);
  });

  it("refuses to publish a draft whose phase rows are out of LearnSDLC's order (fail-closed), and it stays a draft", async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-unordered');
    for (const key of ['requirements', 'design', 'deployment', 'maintenance']) await remove(fork, key);
    const [implementation, testing] = await phaseRows(fork.versionId);
    expect([implementation.key, testing.key]).toEqual(['implementation', 'testing']);
    const phases = world.dataSource.getRepository(ProjectPhaseEntity);
    await phases.update({ id: implementation.id }, { order: 1000 });
    await phases.update({ id: testing.id }, { order: 1 });
    await phases.update({ id: implementation.id }, { order: 2 });

    expect(await refusal(world.service.publish(S1_TEACHER, fork.projectId, fork.versionId, { version: '1.0.0' }))).toEqual({
      status: 409,
      message: "A project keeps LearnSDLC's order, and Implementation comes before Testing.",
    });
    expect((await versions().findOneByOrFail({ id: fork.versionId })).status).toBe('draft');
  });

  it('adds Design to an uploaded draft that has none: it compiles, mounts design/design.json, and carries the design rubric and its task', async () => {
    const upload = await uploaded('Phases card, add Design');
    const removed = await remove(upload, 'design');
    expect(rowOf(removed, 'design')).toMatchObject({ state: 'absent', canAdd: true, why: null });

    const view = await add(upload, 'design');

    expect(keysOf(view)).toEqual(['requirements', 'design']);
    const design = (await snapshotOf(upload.versionId)).content.phases.find((one) => one.key === 'design')!;
    expect(design.order).toBe(2);
    expect(design.checks.kind).toBe('design');
    expect(design.files.map((one) => one.path)).toContain('design/design.json');
    expect(design.rubric.criteria.map((one) => one.key)).toEqual(['design']);
    expect(view.validation?.checks.find((one) => one.id === COMPILE_CHECK_ID)?.status).toBe('passed');
    const tasks = view.phases.find((one) => one.key === 'design')!.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'The design' });
  });

  it('offers the doors only to the teacher who can edit the draft, never to an admin reading it', async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-admin');
    await remove(fork, 'testing');
    const draft = { projectId: lean.projectId, versionId: lean.draftId };
    for (const one of [fork, draft]) {
      const owner = await world.service.readDraft(S1_TEACHER, one.projectId, one.versionId);
      const admin = await world.service.readDraft(ADMIN, one.projectId, one.versionId);
      expect([owner.editable, admin.editable]).toEqual([true, false]);
      expect(setOf(owner).some((row) => row.canRemove || row.canPutBack || row.canAdd)).toBe(true);
      expect(setOf(admin).map((row) => [row.key, row.state])).toEqual(setOf(owner).map((row) => [row.key, row.state]));
      expect(setOf(admin).filter((row) => row.canRemove || row.canPutBack || row.canAdd)).toEqual([]);
    }
    expect(rowOf(await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId), 'testing')?.canPutBack).toBe(true);
    expect(rowOf(await world.service.readDraft(S1_TEACHER, draft.projectId, draft.versionId), 'design')?.canAdd).toBe(true);
  });

  it("clears the older-format Design note when Design is removed, so a Design added after says nothing of a conversion", async () => {
    const fork = await copyTaskTrackr(world, 'phases-card-design-note');
    const settings = world.dataSource.getRepository(SettingEntity);
    const note = { note: 'The Design was converted from the older format.', removed: ['design/NOTES.md'] };
    await settings.save(settings.create({ key: designConversionKey(fork.versionId), value: JSON.stringify(note) }));
    expect((await world.service.readDraft(S1_TEACHER, fork.projectId, fork.versionId)).designConversion).toEqual(note);

    const view = await remove(fork, 'design');

    expect(view.designConversion).toBeUndefined();
    expect(await settings.findOneBy({ key: designConversionKey(fork.versionId) })).toBeNull();
  });
});

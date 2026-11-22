import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  CHANGE_REQUEST_JSON,
  DEFAULT_CHANGE_FLOOR,
  DEFAULT_RUNBOOK_FLOOR,
  EMPTY_CHANGE_REQUEST,
  EMPTY_DESIGN,
  EMPTY_RUNBOOK,
  RUNBOOK_JSON,
  STORY_JSON,
  serialiseChangeRequest,
  serialiseDesign,
  serialiseRunbook,
  validateChangeRequestRecord,
  validateDesignRecord,
  validateRunbookRecord,
  type DrillState,
  type PhaseKey,
  type Runbook,
} from '@learnsdlc/shared';
import { RECORD_TICKET } from '../../test/record-pack';
import {
  AuditEventEntity,
  CohortEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  SettingEntity,
  SubmissionEntity,
  UserEntity,
} from '../db/entities';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { TASKTRACKR_RUNBOOK_TEMPLATE } from '../migrations/runbook-records/tasktrackr-runbook-template';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
import { TASKTRACKR_CHANGELOG_TEMPLATE } from '../migrations/change-records/tasktrackr-changelog-template';
import { RECEIPT_RUNS } from './receipts';
import { RETIRED_WRITTEN_OUTCOME, STORY_REPIN_DONE_KEY, StoryRepinService, phaseSetSentence, retiredWrittenReason } from './story-repin.service';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The boot's re-pin: an enrolment on a published version whose Requirements
 * or Design is still markdown, of any project whose published head grades that
 * phase's structured kind (a story, a design record), moves to that head, with
 * each such phase's workspace converted in the same transaction and one audit
 * row each, only when the phases it does not convert compile to the same
 * digests as the head's (the other five for one phase, the other four for
 * both); otherwise it is counted as stranded and left alone. The versions are written here as rows holding only
 * what the re-pin reads, so the spec does not depend on which TaskTrackr the
 * content directory ships.
 *
 * Every store here is built by schema sync with no story-records migration receipt: the
 * migration never ran, which is exactly the store the re-pin must not leave
 * with a learner on 3.0.0 and their story still in `my-story.md`.
 */
const OWN = 'requirements/my-story.md';
const STORY_MD = '# US-4 Overdue report\n\nAs a lead, I want a report, so that I chase it.\n\n- AC-1 Given a task due yesterday, when I open the report, then it is listed\n';
const OLD_STAMP = '2026-10-01T09:00:00.000Z';

/** `design` stands for the other five phases: a different value is a version whose other phases differ. */
const compiledWith = (kind: 'markdown' | 'story', design = 'the 2.0.1 design') => ({
  content: {
    phases: [
      { key: 'requirements', checks: kind === 'story' ? { kind, learnerStory: { id: 'US-4', hints: {} } } : { kind } },
      { key: 'design', intro: design, checks: { kind: 'markdown' } },
    ],
  },
});

describe('StoryRepinService', () => {
  let db: DataSource;
  let service: StoryRepinService;
  const ids = { admin: '', learner: '', other: '', v201: '', v300: '', v200: '', teacherV: '', teacher: '' };

  const version = async (projectId: string, semver: string, kind: 'markdown' | 'story', status: ProjectVersionEntity['status'] = 'published', design?: string) =>
    (
      await db.manager.save(
        db.manager.create(ProjectVersionEntity, {
          projectId, version: semver, status, manifest: {} as never, compiled: compiledWith(kind, design) as never,
          publishedAt: status === 'draft' ? null : new Date(Date.now() - 60_000).toISOString(),
        }),
      )
    ).id;
  const enrol = (userId: string, projectSlug: string, projectVersionId: string | null) =>
    db.manager.save(db.manager.create(EnrollmentEntity, { userId, projectSlug, projectVersionId, packVersion: null }));
  const user = async (email: string, role: 'ADMIN' | 'LEARNER') =>
    (await db.manager.save(db.manager.create(UserEntity, { email, passwordHash: 'x', displayName: email, role }))).id;
  /** The enrolment's Requirements phase state, holding the given workspace. */
  const requirements = async (enrolment: EnrollmentEntity, workspace: Record<string, string> | null) =>
    db.manager.save(
      db.manager.create(PhaseStateEntity, {
        enrollmentId: enrolment.id,
        userId: enrolment.userId,
        phaseKey: 'requirements',
        phaseOrder: 1,
        workspace,
        workspaceUpdatedAt: workspace ? OLD_STAMP : null,
      }),
    );
  const stateOf = (id: string) => db.manager.findOneByOrFail(PhaseStateEntity, { id });
  const pinOf = async (id: string) => (await db.manager.findOneByOrFail(EnrollmentEntity, { id })).projectVersionId;
  const marker = () => db.manager.findOneBy(SettingEntity, { key: STORY_REPIN_DONE_KEY });
  const cohort = async (name: string) =>
    (await db.manager.save(db.manager.create(CohortEntity, { name, joinCode: name.toUpperCase().padEnd(8, 'X').slice(0, 8), ownerUserId: ids.admin }))).id;
  const assignment = (cohortId: string, projectVersionId: string, state = 'active') =>
    db.manager.save(
      db.manager.create(CohortProjectAssignmentEntity, { cohortId, projectVersionId, assignedByUserId: ids.admin, state, reason: 'the class works TaskTrackr' }),
    );

  beforeEach(async () => {
    Logger.overrideLogger(false);
    db = await memoryDataSource();
    ids.admin = await user('admin@repin.test', 'ADMIN');
    ids.learner = await user('learner@repin.test', 'LEARNER');
    ids.other = await user('other@repin.test', 'LEARNER');
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const teacher = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'library-desk', title: 'Library', platformOwned: false, origin: 'upload' }));
    ids.v200 = await version(tasktrackr.id, '2.0.0', 'markdown', 'archived');
    ids.v201 = await version(tasktrackr.id, '2.0.1', 'markdown');
    ids.v300 = await version(tasktrackr.id, '3.0.0', 'story');
    ids.teacherV = await version(teacher.id, '1.0.0', 'markdown', 'published', 'the library design');
    ids.teacher = teacher.id;
    service = new StoryRepinService(db);
  });

  afterEach(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  it('moves a 2.0.1 pin to 3.0.0, stamps packVersion, writes one audit row, and runs once', async () => {
    const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
    expect(await service.run()).toMatchObject({ moved: 1, heads: { tasktrackr: ids.v300 } });

    const after = await db.manager.findOneByOrFail(EnrollmentEntity, { id: pinned.id });
    expect(after.projectVersionId).toBe(ids.v300);
    expect(after.packVersion).toBe('3.0.0');
    const audit = await db.manager.find(AuditEventEntity);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      event: 'enrolment.repin',
      actorUserId: ids.admin,
      subjectUserId: ids.learner,
      targetId: pinned.id,
      detail: { from: '2.0.1', to: '3.0.0', reason: 'requirements story model', fromVersionId: ids.v201, toVersionId: ids.v300 },
    });
    expect(await marker()).not.toBeNull();

    expect(await service.run()).toBeNull();
    expect(await db.manager.count(AuditEventEntity)).toBe(1);
  });

  describe('the workspace moves with the pin (a store the story-records migration never ran on)', () => {
    it('converts a moved learner\'s markdown story to the record, stamps it afresh, and only then moves the pin', async () => {
      expect(await db.manager.findOneBy(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).toBeNull();
      const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
      const state = await requirements(pinned, { [OWN]: STORY_MD, 'requirements/notes.txt': 'kept' });

      expect(await service.run()).toMatchObject({ moved: 1, converted: 1, refused: 0, skippedInFlight: 0 });
      expect(await pinOf(pinned.id)).toBe(ids.v300);
      const after = await stateOf(state.id);
      expect(after.workspace?.[OWN]).toBeUndefined();
      expect(after.workspace?.['requirements/notes.txt']).toBe('kept');
      expect(JSON.parse(after.workspace?.[STORY_JSON] as string)).toMatchObject({ id: 'US-4', title: 'Overdue report', persona: 'lead' });
      expect(Date.parse(after.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
      const [audit] = await db.manager.find(AuditEventEntity);
      expect(audit.detail).toMatchObject({ conversion: { requirements: 'parsed-markdown' } });
    });

    it('converts a TaskTrackr learner with a null pin in place: their head is the story version already', async () => {
      const unpinned = await enrol(ids.other, 'tasktrackr', null);
      const state = await requirements(unpinned, { [OWN]: STORY_MD });
      expect(await service.run()).toMatchObject({ moved: 0, converted: 1 });
      expect(await pinOf(unpinned.id)).toBeNull();
      expect((await stateOf(state.id)).workspace?.[OWN]).toBeUndefined();
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
    });

    it('never moves a learner whose story it could not convert, counts them, and leaves the marker unset', async () => {
      const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
      const workspace = { [OWN]: STORY_MD, [STORY_JSON]: '{ broken' };
      const state = await requirements(pinned, workspace);
      expect(await service.run()).toMatchObject({ moved: 0, converted: 0, refused: 1 });
      expect(await pinOf(pinned.id)).toBe(ids.v201);
      expect((await stateOf(state.id)).workspace).toEqual(workspace);
      expect(await marker()).toBeNull();
    });

    it('leaves a pin on an archived 2.x version alone, neither converted nor moved, and counts it', async () => {
      const archived = await enrol(ids.learner, 'tasktrackr', ids.v200);
      const state = await requirements(archived, { [OWN]: STORY_MD });
      expect(await service.run()).toMatchObject({ moved: 0, converted: 0, leftOnArchived: 1 });
      expect(await pinOf(archived.id)).toBe(ids.v200);
      expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
    });

    it('is idempotent: a second run is a no-op once the marker is set, and changes no workspace', async () => {
      const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      await service.run();
      const once = await stateOf(state.id);
      expect(await service.run()).toBeNull();
      expect(await stateOf(state.id)).toEqual(once);
      expect(await db.manager.count(AuditEventEntity)).toBe(1);
    });

    it('records what it did beside the migration\'s receipt, under `repin`', async () => {
      const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
      await requirements(pinned, { [OWN]: STORY_MD });
      await service.run();
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin).toMatchObject({ moved: 1, converted: 1, assignmentsMoved: 0, skippedInFlight: 0, refused: 0, leftOnArchived: 0, strandedOtherPhasesDiffer: 0 });
      expect(receipt.repin.runs).toHaveLength(1);
      expect(receipt.repin.runs[0]).toMatchObject({ moved: 1, conversions: { 'parsed-markdown': 1 }, refusals: [] });
    });

    it('keeps running totals and one entry per run in the receipt, and a refusal never overwrites the refused count', async () => {
      const broken = await enrol(ids.learner, 'tasktrackr', ids.v201);
      await requirements(broken, { [OWN]: STORY_MD, [STORY_JSON]: '{ broken' });
      const fine = await enrol(ids.other, 'tasktrackr', ids.v201);
      await requirements(fine, { [OWN]: STORY_MD });
      expect(await service.run()).toMatchObject({ moved: 1, refused: 1 });
      // The second run (the marker is unset: one is still refused) moves nothing more.
      expect(await service.run()).toMatchObject({ moved: 0, refused: 1 });
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin).toMatchObject({ moved: 1, converted: 1, refused: 1 });
      expect(receipt.repin.runs.map((run: { moved: number }) => run.moved)).toEqual([1, 0]);
      expect(receipt.repin.runs[0].refusals).toEqual([{ stateId: expect.any(String), reason: expect.any(String) }]);
    });
  });

  it('keeps at most 50 runs in a receipt, the oldest dropped, while the totals count every run', async () => {
    const old = Array.from({ length: RECEIPT_RUNS }, (_, i) => ({ at: `2026-10-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, moved: 0, n: i }));
    await db.manager.save(db.manager.create(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ repin: { moved: 3, converted: 3, runs: old } }) }));
    const broken = await enrol(ids.learner, 'tasktrackr', ids.v201);
    await requirements(broken, { [OWN]: STORY_MD, [STORY_JSON]: '{ broken' });
    await service.run();
    const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
    expect(receipt.repin.runs).toHaveLength(RECEIPT_RUNS);
    expect(receipt.repin.runs[0].n).toBe(1);
    expect(receipt.repin.runs.at(-1).refused).toBe(1);
    expect(receipt.repin.moved).toBe(3);
  });

  describe('a Requirements submission in flight across the boot', () => {
    it('skips the learner, counts them, leaves the marker unset, and moves them on a later run once it has settled', async () => {
      const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      const submission = await db.manager.save(
        db.manager.create(SubmissionEntity, { phaseStateId: state.id, userId: ids.learner, status: 'queued', workspaceSnapshot: { [OWN]: STORY_MD } }),
      );
      const free = await enrol(ids.other, 'tasktrackr', ids.v201);

      expect(await service.run()).toMatchObject({ moved: 1, skippedInFlight: 1 });
      expect(await pinOf(pinned.id)).toBe(ids.v201);
      expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
      expect(await pinOf(free.id)).toBe(ids.v300);
      expect(await marker()).toBeNull();
      // the learner's submission is never failed or touched
      expect(await db.manager.findOneByOrFail(SubmissionEntity, { id: submission.id })).toMatchObject({ status: 'queued' });

      await db.manager.update(SubmissionEntity, { id: submission.id }, { status: 'running' });
      expect(await service.run()).toMatchObject({ moved: 0, skippedInFlight: 1 });

      await db.manager.update(SubmissionEntity, { id: submission.id }, { status: 'completed' });
      expect(await service.run()).toMatchObject({ moved: 1, converted: 1, skippedInFlight: 0 });
      expect(await pinOf(pinned.id)).toBe(ids.v300);
      expect(await marker()).not.toBeNull();
    });
  });

  describe('every project, and only when the other five phases are unchanged', () => {
    it("moves and converts a teacher's learner when the head is a story and the other phases compile the same", async () => {
      const head = await version(ids.teacher, '1.1.0', 'story', 'published', 'the library design');
      const pinned = await enrol(ids.learner, 'library-desk', ids.teacherV);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      expect(await service.run()).toMatchObject({ moved: 1, converted: 1, strandedOtherPhasesDiffer: 0, heads: { 'library-desk': head } });
      expect(await pinOf(pinned.id)).toBe(head);
      expect((await stateOf(state.id)).workspace?.[STORY_JSON]).toBeDefined();
      const [audit] = await db.manager.find(AuditEventEntity);
      expect(audit).toMatchObject({ event: 'enrolment.repin', action: 'library-desk', detail: { from: '1.0.0', to: '1.1.0', fromVersionId: ids.teacherV, toVersionId: head } });
    });

    it("counts a teacher's learner as stranded, and leaves them untouched, when another phase differs", async () => {
      await version(ids.teacher, '1.1.0', 'story', 'published', 'a rewritten design');
      const pinned = await enrol(ids.learner, 'library-desk', ids.teacherV);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
      expect(await service.run()).toMatchObject({ moved: 0, converted: 0, strandedOtherPhasesDiffer: 1 });
      expect(await pinOf(pinned.id)).toBe(ids.teacherV);
      expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
      expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain('1 stranded because another phase differs from the head');
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin).toMatchObject({ strandedOtherPhasesDiffer: 1 });
    });

    it('counts a TaskTrackr 1.0.0- or 2.0.0-style pin (other phases differ) as stranded, and never moves it', async () => {
      const tasktrackrId = (await db.manager.findOneByOrFail(ProjectEntity, { slug: 'tasktrackr' })).id;
      const older = await version(tasktrackrId, '1.0.0', 'markdown', 'published', 'the 1.0.0 design');
      const pinned = await enrol(ids.learner, 'tasktrackr', older);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      const moving = await enrol(ids.other, 'tasktrackr', ids.v201);
      expect(await service.run()).toMatchObject({ moved: 1, strandedOtherPhasesDiffer: 1 });
      expect(await pinOf(pinned.id)).toBe(older);
      expect(await pinOf(moving.id)).toBe(ids.v300);
      expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
    });

    it('after the marker is set, runs again only once a version is published later, and then moves that project\'s learners', async () => {
      await enrol(ids.other, 'tasktrackr', ids.v201);
      await service.run();
      expect(await marker()).not.toBeNull();
      const pinned = await enrol(ids.learner, 'library-desk', ids.teacherV);
      expect(await service.run()).toBeNull();
      const head = await version(ids.teacher, '1.1.0', 'story', 'published', 'the library design');
      await db.manager.update(ProjectVersionEntity, { id: head }, { publishedAt: new Date(Date.now() + 60_000).toISOString() });
      expect(await service.run()).toMatchObject({ moved: 1 });
      expect(await pinOf(pinned.id)).toBe(head);
    });

    it('a row whose move fails is refused and counted, and the run goes on with the rest', async () => {
      const failing = await enrol(ids.learner, 'tasktrackr', ids.v201);
      const fine = await enrol(ids.other, 'tasktrackr', ids.v201);
      const update = EntityManager.prototype.update;
      const spy = jest.spyOn(EntityManager.prototype, 'update').mockImplementation(function (this: EntityManager, target: unknown, criteria: unknown, patch: unknown) {
        if (target === EnrollmentEntity && (criteria as { id?: string }).id === failing.id) return Promise.reject(new Error('write failed'));
        return (update as (...a: unknown[]) => Promise<never>).call(this, target, criteria, patch);
      } as never);
      try {
        expect(await service.run()).toMatchObject({ moved: 1, refused: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(await pinOf(failing.id)).toBe(ids.v201);
      expect(await pinOf(fine.id)).toBe(ids.v300);
      expect(await db.manager.count(AuditEventEntity)).toBe(1);
      expect(await marker()).toBeNull();
    });
  });

  describe('a class assigned a TaskTrackr version whose Requirements is markdown', () => {
    it('moves the active assignment to the head with an audit row, and leaves history and other projects alone', async () => {
      const moving = await cohort('alpha');
      const teacherClass = await cohort('bravo');
      const old = await assignment(moving, ids.v200, 'superseded');
      const active = await assignment(moving, ids.v201);
      const teacherRow = await assignment(teacherClass, ids.teacherV);

      expect(await service.run()).toMatchObject({ moved: 0, assignmentsMoved: 1 });

      const rows = await db.manager.find(CohortProjectAssignmentEntity, { where: { cohortId: moving } });
      expect(rows.find((row) => row.id === active.id)?.state).toBe('superseded');
      expect(rows.find((row) => row.id === old.id)?.state).toBe('superseded');
      const now = rows.filter((row) => row.state === 'active');
      expect(now).toHaveLength(1);
      expect(now[0]).toMatchObject({ projectVersionId: ids.v300, assignedByUserId: ids.admin });
      expect(now[0].reason.length).toBeGreaterThanOrEqual(10);
      expect(await db.manager.findOneByOrFail(CohortProjectAssignmentEntity, { id: teacherRow.id })).toMatchObject({ state: 'active', projectVersionId: ids.teacherV });

      const audit = await db.manager.find(AuditEventEntity);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        event: 'cohort.project.repin',
        actorUserId: ids.admin,
        subjectUserId: ids.admin,
        targetId: moving,
        action: 'tasktrackr',
        detail: { from: '2.0.1', to: '3.0.0', reason: 'requirements story model', fromVersionId: ids.v201, toVersionId: ids.v300 },
      });
      expect(await marker()).not.toBeNull();
    });
  });

  it('leaves alone a pin already on the story head, a null pin with no markdown, and a teacher\'s project whose head is still markdown', async () => {
    const onHead = await enrol(ids.learner, 'tasktrackr', ids.v300);
    const unpinned = await enrol(ids.other, 'tasktrackr', null);
    const teacher = await enrol(ids.admin, 'library-desk', ids.teacherV);
    await requirements(teacher, { [OWN]: STORY_MD });
    expect(await service.run()).toMatchObject({ moved: 0, converted: 0, strandedOtherPhasesDiffer: 0, heads: { tasktrackr: ids.v300 } });
    for (const [row, pin] of [[onHead, ids.v300], [unpinned, null], [teacher, ids.teacherV]] as const) {
      expect(await pinOf(row.id)).toBe(pin);
    }
    expect(await db.manager.count(AuditEventEntity)).toBe(0);
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { enrollmentId: teacher.id })).workspace).toEqual({ [OWN]: STORY_MD });
  });

  it('moves nothing and marks nothing done while no story head is published, so a later boot still moves', async () => {
    await db.manager.update(ProjectVersionEntity, { id: ids.v300 }, { status: 'draft' });
    await enrol(ids.learner, 'tasktrackr', ids.v201);
    expect(await service.run()).toBeNull();
    expect(await marker()).toBeNull();
    await db.manager.update(ProjectVersionEntity, { id: ids.v300 }, { status: 'published' });
    expect(await service.run()).toMatchObject({ moved: 1, heads: { tasktrackr: ids.v300 } });
  });

  it('with no admin to name as the actor, moves nothing and leaves the marker unset, but still converts in place (no actor needed)', async () => {
    await db.manager.update(UserEntity, { id: ids.admin }, { role: 'INSTRUCTOR' });
    const pinned = await enrol(ids.learner, 'tasktrackr', ids.v201);
    const state = await requirements(pinned, { [OWN]: STORY_MD });
    const unpinned = await enrol(ids.other, 'tasktrackr', null);
    const inPlace = await requirements(unpinned, { [OWN]: STORY_MD });
    expect(await service.run()).toMatchObject({ moved: 0, converted: 1, waitingForAdmin: 1 });
    expect(await pinOf(pinned.id)).toBe(ids.v201);
    expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
    expect((await stateOf(inPlace.id)).workspace?.[OWN]).toBeUndefined();
    expect(await db.manager.count(AuditEventEntity)).toBe(0);
    expect(await marker()).toBeNull();
  });

  it('with nothing to move it writes nothing at all, not even its marker, and says so on every boot', async () => {
    expect(await service.run()).toMatchObject({ moved: 0, heads: { tasktrackr: ids.v300 } });
    expect(await db.manager.count(SettingEntity)).toBe(0);
    expect(await service.run()).toMatchObject({ moved: 0, heads: { tasktrackr: ids.v300 } });
  });

  describe('Requirements and Design together', () => {
    const BOARD = JSON.stringify({ fields: [{ name: 'id', type: 'integer', required: true, note: 'db' }], operations: [{ name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'today', returns: 'Task[]', errors: '' }], decisions: [] });
    const PAGE = 'design/my-design.md';
    /** Three phases stand for six: Requirements and Design by kind, Implementation by its content. */
    const snapshot = (req: 'markdown' | 'story', design: 'markdown' | 'design', impl = 'the implementation') => ({ content: { phases: [
      { key: 'requirements', checks: req === 'story' ? { kind: 'story', learnerStory: { id: 'US-4', hints: {} } } : { kind: 'markdown' } },
      { key: 'design', checks: design === 'design' ? { kind: 'design', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: {} } : { kind: 'markdown' }, files: [] },
      { key: 'implementation', intro: impl, checks: { kind: 'code' } },
    ] } });
    const at = async (semver: string, compiled: object, status: ProjectVersionEntity['status'] = 'published') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: shelfId, version: semver, status, manifest: {} as never, compiled: compiled as never,
        publishedAt: new Date(Date.now() - 60_000).toISOString() }))).id;
    const designState = (enrolment: EnrollmentEntity, workspace: Record<string, string>, phaseKey: PhaseKey = 'design') =>
      db.manager.save(db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: enrolment.userId, phaseKey, phaseOrder: 2, workspace, workspaceUpdatedAt: OLD_STAMP }));
    let shelfId = '';
    let v1 = '', v2 = '', v2b = '', v3 = '';
    beforeEach(async () => {
      shelfId = (await db.manager.save(db.manager.create(ProjectEntity, { slug: 'shelf-two', title: 'Shelf', platformOwned: true, origin: 'seed' }))).id;
      v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      v2 = await at('2.0.0', snapshot('story', 'markdown'));
      v2b = await at('2.1.0', snapshot('story', 'markdown', 'another implementation'));
      v3 = await at('3.0.0', snapshot('story', 'design'));
    });

    it('a 2.0.1 pin converts both phases and moves, with one audit row naming both', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v1);
      await requirements(pinned, { [OWN]: STORY_MD });
      const design = await designState(pinned, { [PAGE]: '# Design\n\nMine.\n', 'design/design.json': BOARD });
      const result = await service.run();
      expect(result!.moved).toBe(1);
      expect(result!.strandedOtherPhasesDiffer).toBe(0);
      expect(result!.convertedByPhase).toEqual({ requirements: 1, design: 1, deployment: 0, maintenance: 0 });
      expect(await pinOf(pinned.id)).toBe(v3);
      const after = (await stateOf(design.id)).workspace as Record<string, string>;
      expect(Object.keys(after)).not.toContain(PAGE);
      expect(validateDesignRecord(after['design/design.json']).error).toBeNull();
      const audits = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].detail).toMatchObject({ reason: 'requirements story model; design record model', conversion: { requirements: 'parsed-markdown', design: 'folded' } });
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin.runs.at(-1).folded).toEqual([{ stateId: design.id, reason: '1 field became the attributes of the entity Model' }]);
      expect(receipt.repin).toMatchObject({ moved: 1, converted: 1, heads: { 'shelf-two': v3 } });
      const stories = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(stories.repin).toMatchObject({ moved: 1, converted: 1 });
      expect(stories.repin.runs.at(-1)).not.toHaveProperty('folded');
    });

    it('a 3.0.0 pin converts Design only and moves', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2);
      await designState(pinned, { 'design/design.json': BOARD });
      const result = await service.run();
      expect(result!.moved).toBe(1);
      expect(result!.convertedByPhase).toEqual({ requirements: 0, design: 1, deployment: 0, maintenance: 0 });
      expect(await pinOf(pinned.id)).toBe(v3);
      const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audit.detail).toMatchObject({ reason: 'design record model', conversion: { design: 'folded' } });
    });

    it("a teacher's version: its task target and its editable mount are kept in notes by name, its read-only mount removed", async () => {
      const own = snapshot('story', 'markdown') as { content: { phases: { key: string; files?: unknown[] }[] } };
      own.content.phases[1].files = [
        { path: 'design/architecture.md', content: '# Architecture\n', editable: true, language: 'markdown' },
        { path: 'requirements/provided-stories.md', content: '# Stories\n', editable: false, language: 'markdown' },
      ];
      const v21 = await at('2.2.0', { ...own, phases: [{ key: 'design', tasks: [{ taskKey: 't2', artefactPath: 'design/my-design-t2.md', owns: ['design/my-design-t2.md'] }] }] });
      const pinned = await enrol(ids.learner, 'shelf-two', v21);
      const design = await designState(pinned, {
        'design/my-design-t2.md': 'Tasks group by list.',
        'design/architecture.md': '# Architecture\nOne Flask app.',
        'requirements/provided-stories.md': '# Stories\n',
      });
      const result = await service.run();
      expect(result!.moved).toBe(1);
      expect(await pinOf(pinned.id)).toBe(v3);
      const after = (await stateOf(design.id)).workspace as Record<string, string>;
      expect(Object.keys(after)).toEqual(['design/design.json']);
      expect(validateDesignRecord(after['design/design.json']).design!.notes).toBe(
        'Kept from design/my-design-t2.md:\nTasks group by list.\n\nKept from design/architecture.md:\n# Architecture\nOne Flask app.',
      );
    });

    it('a pin whose other phases differ from the head is stranded, and nothing is converted', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2b);
      const design = await designState(pinned, { 'design/design.json': BOARD });
      const result = await service.run();
      expect(result!.strandedOtherPhasesDiffer).toBe(1);
      expect(await pinOf(pinned.id)).toBe(v2b);
      expect((await stateOf(design.id)).workspace).toEqual({ 'design/design.json': BOARD });
    });

    it('a refused conversion does not move the pin', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2);
      await designState(pinned, { [PAGE]: 'x '.repeat(2100), 'design/design.json': BOARD });
      const result = await service.run();
      expect(result!.refused).toBe(1);
      expect(result!.moved).toBe(0);
      expect(await pinOf(pinned.id)).toBe(v2);
      expect(await marker()).toBeNull();
    });

    it('a fold that would cut words refuses the move, leaves the pin, and lists the state in the Design receipt', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2);
      const long = JSON.stringify({ fields: [], entities: Array.from({ length: 21 }, (_, i) => ({ id: `E${i + 1}`, name: `N${i + 1}` })) });
      const design = await designState(pinned, { 'design/design.json': long });
      const result = await service.run();
      expect(result!.refused).toBe(1);
      expect(await pinOf(pinned.id)).toBe(v2);
      expect((await stateOf(design.id)).workspace).toEqual({ 'design/design.json': long });
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin.runs.at(-1).refusals).toEqual([{ stateId: design.id, reason: expect.stringContaining('1 entity left out') }]);
    });

    it('a learner already on the design head with a leftover design page is converted in place, with no audit row', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v3);
      const design = await designState(pinned, { [PAGE]: '<!-- template -->\n', 'design/design.json': BOARD });
      const result = await service.run();
      expect(result!.moved).toBe(0);
      expect(result!.convertedByPhase.design).toBe(1);
      expect(Object.keys((await stateOf(design.id)).workspace as object)).toEqual(['design/design.json']);
      expect(await db.manager.count(AuditEventEntity, { where: { event: 'enrolment.repin' } })).toBe(0);
    });

    it('a learner whose version grades a story Requirements and a markdown Design keeps the design page (grading integrity)', async () => {
      // stranded on 2.1.0: its Requirements is converted in place (it grades the story), its Design is not (it grades markdown)
      const stranded = await enrol(ids.learner, 'shelf-two', v2b);
      const story = await requirements(stranded, { [OWN]: STORY_MD });
      const page = { [PAGE]: '# Design\n\nMine.\n', 'design/design.json': BOARD };
      const kept = await designState(stranded, page);
      // a null pin on TaskTrackr follows 3.0.0, whose Design is still markdown
      const unpinned = await enrol(ids.other, 'tasktrackr', null);
      const followed = await designState(unpinned, page);
      const result = await service.run();
      expect(result!.convertedByPhase).toEqual({ requirements: 1, design: 0, deployment: 0, maintenance: 0 });
      expect((await stateOf(story.id)).workspace?.[OWN]).toBeUndefined();
      expect((await stateOf(kept.id)).workspace).toEqual(page);
      expect((await stateOf(followed.id)).workspace).toEqual(page);
    });

    it('never sweeps a phase under another key, whatever its workspace holds', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v3);
      const other = await designState(pinned, { [PAGE]: '# Design\n\nMine.\n', 'design/design.json': BOARD }, 'implementation');
      expect(await service.run()).toMatchObject({ moved: 0, converted: 0, refused: 0 });
      expect((await stateOf(other.id)).workspace).toEqual({ [PAGE]: '# Design\n\nMine.\n', 'design/design.json': BOARD });
    });

    it('a null-pin learner whose Design holds only an older-shaped record is converted in place, and the fold is listed', async () => {
      const unpinned = await enrol(ids.learner, 'shelf-two', null);
      const design = await designState(unpinned, { 'design/design.json': BOARD });
      // a record already in the new shape is left as it is
      const current = await designState(await enrol(ids.other, 'shelf-two', null), { 'design/design.json': serialiseDesign(EMPTY_DESIGN) });
      const result = await service.run();
      expect(result!.moved).toBe(0);
      expect(result!.convertedByPhase.design).toBe(1);
      expect(validateDesignRecord((await stateOf(design.id)).workspace!['design/design.json']).error).toBeNull();
      expect(JSON.parse((await stateOf(design.id)).workspace!['design/design.json'])).not.toHaveProperty('fields');
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin.runs.at(-1).folded).toEqual([{ stateId: design.id, reason: '1 field became the attributes of the entity Model' }]);
      expect((await stateOf(current.id)).workspaceUpdatedAt).toBe(OLD_STAMP);
    });

    it('skips a learner with a Design submission in flight, and moves them once it has settled', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2);
      const design = await designState(pinned, { 'design/design.json': BOARD });
      const submission = await db.manager.save(
        db.manager.create(SubmissionEntity, { phaseStateId: design.id, userId: ids.learner, status: 'running', workspaceSnapshot: { 'design/design.json': BOARD } }),
      );
      expect(await service.run()).toMatchObject({ moved: 0, skippedInFlight: 1 });
      expect(await pinOf(pinned.id)).toBe(v2);
      expect((await stateOf(design.id)).workspace).toEqual({ 'design/design.json': BOARD });
      expect(await marker()).toBeNull();
      await db.manager.update(SubmissionEntity, { id: submission.id }, { status: 'completed' });
      expect(await service.run()).toMatchObject({ moved: 1, skippedInFlight: 0 });
      expect(await pinOf(pinned.id)).toBe(v3);
    });

    it('a 2.0.1 pin whose Design refuses converts neither phase, stays, and both receipts say so', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v1);
      const story = await requirements(pinned, { [OWN]: STORY_MD });
      const refused = { 'design/design.json': JSON.stringify({ fields: [], entities: Array.from({ length: 21 }, (_, i) => ({ id: `E${i + 1}`, name: `N${i + 1}` })) }) };
      const design = await designState(pinned, refused);
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, refused: 1, convertedByPhase: { requirements: 0, design: 0, deployment: 0, maintenance: 0 } });
      expect(await pinOf(pinned.id)).toBe(v1);
      expect((await stateOf(story.id)).workspace).toEqual({ [OWN]: STORY_MD });
      expect((await stateOf(design.id)).workspace).toEqual(refused);
      const designs = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
      expect(designs.repin.refused).toBe(1);
      expect(designs.repin.runs.at(-1).refusals).toEqual([{ stateId: design.id, reason: expect.stringContaining('1 entity left out') }]);
      const stories = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(stories.repin.refused).toBe(1);
      expect(stories.repin.runs.at(-1).refusals).toEqual([{ stateId: story.id, reason: 'not moved: the Design workspace in the same move could not be converted, so this one was left as it was' }]);
    });

    it('a second run is a no-op', async () => {
      const pinned = await enrol(ids.learner, 'shelf-two', v2);
      await designState(pinned, { 'design/design.json': BOARD });
      expect((await service.run())!.moved).toBe(1);
      expect(await service.run()).toBeNull();
    });
  });

  describe('Deployment and Maintenance with the other two', () => {
    const RUNBOOK_MD = '## Environment\n\n- TASKTRACKR_DB: where the database lives\n\n## Rollback\n\n- docker compose down\n';
    const CHANGELOG_MD = '# Changelog\n\n## 2.1.0 Comments\n\n### Added\n- Comments on a task.\n';
    const runbookChecks = { kind: 'config', runbook: { record: RUNBOOK_JSON, floor: DEFAULT_RUNBOOK_FLOOR } };
    const changeChecks = { kind: 'code', ticket: RECORD_TICKET, change: { record: CHANGE_REQUEST_JSON, contract: true, floor: DEFAULT_CHANGE_FLOOR } };
    /** The head's starting runbook: one environment item, so a seeded record shows it kept. */
    const HEAD_RUNBOOK: Runbook = { ...EMPTY_RUNBOOK, environment: [{ id: 'E1', name: 'SHELF_DB', purpose: 'where the shelf database lives', kind: 'config' }] };
    /**
     * Five phases stand for six: each structured phase by its form, Implementation by its content.
     * `templates` are an older version's own RUNBOOK.md and CHANGELOG.md mounts (TaskTrackr 4.0.0's by default).
     */
    const snapshot = (req: 'markdown' | 'story', design: 'markdown' | 'design', records: boolean, impl = 'the implementation',
      templates = { runbook: TASKTRACKR_RUNBOOK_TEMPLATE, changelog: TASKTRACKR_CHANGELOG_TEMPLATE }) => ({ content: { phases: [
      { key: 'requirements', order: 1, checks: req === 'story' ? { kind: 'story', learnerStory: { id: 'US-4', hints: {} } } : { kind: 'markdown' } },
      { key: 'design', order: 2, checks: design === 'design' ? { kind: 'design', contracts: { api: false, screens: false }, sequence: false, stories: [], floor: {} } : { kind: 'markdown' }, files: [] },
      { key: 'implementation', order: 3, intro: impl, checks: { kind: 'code' } },
      { key: 'deployment', order: 5, checks: records ? runbookChecks : { kind: 'config' },
        files: records ? [{ path: RUNBOOK_JSON, content: serialiseRunbook(HEAD_RUNBOOK), editable: true }] : [{ path: 'RUNBOOK.md', content: templates.runbook, editable: true }] },
      { key: 'maintenance', order: 6, checks: records ? changeChecks : { kind: 'code' },
        files: records ? [{ path: CHANGE_REQUEST_JSON, content: serialiseChangeRequest(EMPTY_CHANGE_REQUEST), editable: true }] : [{ path: 'CHANGELOG.md', content: templates.changelog, editable: true }] },
    ] } });
    const at = async (semver: string, compiled: object, status: ProjectVersionEntity['status'] = 'published') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: shelfId, version: semver, status, manifest: {} as never, compiled: compiled as never,
        publishedAt: new Date(Date.now() - 60_000).toISOString() }))).id;
    const state = (enrolment: EnrollmentEntity, phaseKey: PhaseKey, workspace: Record<string, string>, drill: DrillState | null = null) =>
      db.manager.save(db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: enrolment.userId, phaseKey, phaseOrder: phaseKey === 'deployment' ? 5 : 6, workspace, drill, workspaceUpdatedAt: OLD_STAMP }));
    const receiptOf = async (key: string) => JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key })).value);
    const DRILL: DrillState = { fault: 'api-url', pagedAt: OLD_STAMP, runbookBefore: null, healthRanAt: null, healthExit: null, fixAppliedAt: OLD_STAMP, resolvedAt: OLD_STAMP,
      incident: { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' } };
    let shelfId = '';
    let v201 = '', v300 = '', v400 = '', v400b = '', v500 = '';
    beforeEach(async () => {
      shelfId = (await db.manager.save(db.manager.create(ProjectEntity, { slug: 'shelf-four', title: 'Shelf', platformOwned: true, origin: 'seed' }))).id;
      v201 = await at('2.0.1', snapshot('markdown', 'markdown', false));
      v300 = await at('3.0.0', snapshot('story', 'markdown', false));
      v400 = await at('4.0.0', snapshot('story', 'design', false));
      v400b = await at('4.1.0', snapshot('story', 'design', false, 'another implementation'));
      v500 = await at('5.0.0', snapshot('story', 'design', true));
    });

    it('a 4.0.0 pin converts Deployment and Maintenance in one savepoint and moves, with one audit row naming both', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD, 'docker-compose.yml': 'services: {}\n' }, DRILL);
      const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': CHANGELOG_MD });
      const result = await service.run();
      expect(result).toMatchObject({ moved: 1, strandedOtherPhasesDiffer: 0, convertedByPhase: { requirements: 0, design: 0, deployment: 1, maintenance: 1 } });
      expect(await pinOf(pinned.id)).toBe(v500);
      const runbookAfter = (await stateOf(deployment.id)).workspace as Record<string, string>;
      // sorted: 'deployment/runbook.json' comes before 'docker-compose.yml'
      expect(Object.keys(runbookAfter).sort()).toEqual([RUNBOOK_JSON, 'docker-compose.yml']);
      expect(validateRunbookRecord(runbookAfter[RUNBOOK_JSON]).runbook).toMatchObject({ environment: [{ id: 'E1', name: 'TASKTRACKR_DB' }], incident: DRILL.incident });
      const changeAfter = (await stateOf(maintenance.id)).workspace as Record<string, string>;
      expect(validateChangeRequestRecord(changeAfter[CHANGE_REQUEST_JSON], null).change!.release.version).toBe('2.1.0');
      const audits = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audits).toHaveLength(1);
      expect(audits[0].detail).toMatchObject({ reason: 'deployment runbook document; maintenance change document', conversion: { deployment: 'converted', maintenance: 'converted' } });
      for (const key of [RUNBOOK_MIGRATION_RECEIPT_KEY, CHANGE_MIGRATION_RECEIPT_KEY]) {
        const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key })).value);
        expect(receipt.repin.runs.at(-1).conversions).toMatchObject({ converted: 1 });
      }
    });
    it('a 3.0.0 pin converts Design, Deployment and Maintenance; a 2.0.1 pin converts all four', async () => {
      const three = await enrol(ids.learner, 'shelf-four', v300);
      await state(three, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD });
      const two = await enrol(ids.other, 'shelf-four', v201);
      await requirements(two, { [OWN]: STORY_MD });
      await state(two, 'maintenance', { 'CHANGELOG.md': CHANGELOG_MD });
      const result = await service.run();
      expect(result!.moved).toBe(2);
      expect(await pinOf(three.id)).toBe(v500);
      expect(await pinOf(two.id)).toBe(v500);
      const reasons = (await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } })).map((row) => (row.detail as { reason: string }).reason).sort();
      expect(reasons).toEqual([
        'design record model; deployment runbook document; maintenance change document',
        'requirements story model; design record model; deployment runbook document; maintenance change document',
      ]);
    });
    it('a refused runbook conversion moves nothing and converts neither phase', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const huge = { 'RUNBOOK.md': `## Deploying\n\n${'A line of the learner\'s own.\n'.repeat(90)}` };
      const deployment = await state(pinned, 'deployment', huge);
      const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': CHANGELOG_MD });
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, refused: 1, convertedByPhase: { deployment: 0, maintenance: 0 } });
      expect(await pinOf(pinned.id)).toBe(v400);
      expect((await stateOf(deployment.id)).workspace).toEqual(huge);
      expect((await stateOf(maintenance.id)).workspace).toEqual({ 'CHANGELOG.md': CHANGELOG_MD });
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
      expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).refusals).toEqual([
        { stateId: deployment.id, reason: 'the words in RUNBOOK.md would not fit in the runbook record, so it was not changed' },
      ]);
      expect((await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).refusals).toEqual([
        { stateId: maintenance.id, reason: 'not moved: the Deployment workspace in the same move could not be converted, so this one was left as it was' },
      ]);
    });
    it('a refused change request conversion moves nothing and converts neither phase, with its reason', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const huge = { 'CHANGELOG.md': `${CHANGELOG_MD}\n## 2.0.0 Tasks\n\n${'A line of the learner\'s own.\n'.repeat(90)}` };
      const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD }, DRILL);
      const maintenance = await state(pinned, 'maintenance', huge);
      const before = { deployment: await stateOf(deployment.id), maintenance: await stateOf(maintenance.id) };
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, refused: 1, convertedByPhase: { deployment: 0, maintenance: 0 } });
      expect(await pinOf(pinned.id)).toBe(v400);
      expect(await stateOf(deployment.id)).toEqual(before.deployment);
      expect(await stateOf(maintenance.id)).toEqual(before.maintenance);
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
      expect((await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).refusals).toEqual([
        { stateId: maintenance.id, reason: 'the words in CHANGELOG.md would not fit in the change request record, so it was not changed' },
      ]);
      expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).refusals).toEqual([
        { stateId: deployment.id, reason: 'not moved: the Maintenance workspace in the same move could not be converted, so this one was left as it was' },
      ]);
    });
    it('a move with no older file in either phase leaves both workspaces untouched, stamps and all', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const deployment = await state(pinned, 'deployment', { 'docker-compose.yml': 'services: {}\n' });
      const maintenance = await state(pinned, 'maintenance', { 'api/app.py': 'print(1)\n' });
      const before = { deployment: await stateOf(deployment.id), maintenance: await stateOf(maintenance.id) };
      const result = await service.run();
      expect(result).toMatchObject({ moved: 1, convertedByPhase: { requirements: 0, design: 0, deployment: 0, maintenance: 0 } });
      expect(await pinOf(pinned.id)).toBe(v500);
      expect(await stateOf(deployment.id)).toEqual(before.deployment);
      expect(await stateOf(maintenance.id)).toEqual(before.maintenance);
      const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audit.detail).toMatchObject({ conversion: { deployment: 'untouched', maintenance: 'untouched' } });
    });
    it('a second run that is asked again converts nothing and leaves both converted rows byte for byte', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD }, DRILL);
      const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': CHANGELOG_MD });
      expect((await service.run())!.convertedByPhase).toMatchObject({ deployment: 1, maintenance: 1 });
      const once = { deployment: await stateOf(deployment.id), maintenance: await stateOf(maintenance.id) };
      // The done marker would short-circuit the run: dropped, so the in-place pass asks both states again under 5.0.0.
      await db.manager.delete(SettingEntity, { key: STORY_REPIN_DONE_KEY });
      const again = await service.run();
      expect(again).toMatchObject({ moved: 0, converted: 0, refused: 0, convertedByPhase: { requirements: 0, design: 0, deployment: 0, maintenance: 0 } });
      expect(await stateOf(deployment.id)).toEqual(once.deployment);
      expect(await stateOf(maintenance.id)).toEqual(once.maintenance);
      expect(await db.manager.count(AuditEventEntity)).toBe(1);
    });
    it('seeds at boot a Deployment with no RUNBOOK.md whose drill holds an incident, under the head that grades the runbook, once', async () => {
      const unpinned = await enrol(ids.learner, 'shelf-four', null);
      const deployment = await state(unpinned, 'deployment', {}, DRILL);
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, converted: 1, convertedByPhase: { requirements: 0, design: 0, deployment: 1, maintenance: 0 } });
      const after = await stateOf(deployment.id);
      expect(Object.keys(after.workspace as object)).toEqual([RUNBOOK_JSON]);
      expect(validateRunbookRecord((after.workspace as Record<string, string>)[RUNBOOK_JSON]).runbook).toEqual({ ...HEAD_RUNBOOK, incident: DRILL.incident });
      expect(Date.parse(after.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
      expect(after.drill).toEqual(DRILL);
      expect(await pinOf(unpinned.id)).toBeNull();
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
      expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).conversions).toEqual({ seeded: 1 });
      await db.manager.delete(SettingEntity, { key: STORY_REPIN_DONE_KEY });
      expect((await service.run())!.convertedByPhase).toEqual({ requirements: 0, design: 0, deployment: 0, maintenance: 0 });
      expect(await stateOf(deployment.id)).toEqual(after);
      expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs).toHaveLength(1);
    });
    describe('a move whose older file holds only its version\'s template drops it in the same savepoint', () => {
      /** A pack's own templates (not TaskTrackr's), as probe T's teacher project: the later in-place pass would read them under TaskTrackr's frozen one. */
      const SHELF_RUNBOOK = '# Shelf runbook\n\nWritten for the person on call who has never seen this code.\n\n## Environment\n\n- SHELF_DB: TODO(learner)\n\n## Health\n\n- TODO(learner)\n\n## Rollback\n\n- TODO(learner)\n';
      const SHELF_CHANGELOG = '# Changelog\n\nThe Shelf releases, newest first.\n\n## 1.1.0 Loans\n\n### Added\n- TODO(learner)\n';
      let v420 = '';
      beforeEach(async () => {
        v420 = await at('4.2.0', snapshot('story', 'design', false, 'the implementation', { runbook: SHELF_RUNBOOK, changelog: SHELF_CHANGELOG }));
      });
      it('Deployment: a template-only RUNBOOK.md is removed, nothing else is, and the head\'s starting record serves the room', async () => {
        const pinned = await enrol(ids.learner, 'shelf-four', v420);
        const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': SHELF_RUNBOOK, 'docker-compose.yml': 'services: {}\n' });
        const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': CHANGELOG_MD });
        const result = await service.run();
        expect(result).toMatchObject({ moved: 1, refused: 0, convertedByPhase: { deployment: 1, maintenance: 1 } });
        expect(await pinOf(pinned.id)).toBe(v500);
        const after = await stateOf(deployment.id);
        // no record is written: the head's starting runbook is what the room shows a workspace with none
        expect(after.workspace).toEqual({ 'docker-compose.yml': 'services: {}\n' });
        expect(Date.parse(after.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
        expect(after.drill).toBeNull();
        expect(Object.keys((await stateOf(maintenance.id)).workspace as object)).toEqual([CHANGE_REQUEST_JSON]);
        const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
        expect(audit.detail).toMatchObject({ conversion: { deployment: 'template-dropped', maintenance: 'converted' } });
        expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).conversions).toEqual({ 'template-dropped': 1 });
        // which state lost which file is in the receipt, not only the count
        expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).dropped).toEqual([
          { stateId: deployment.id, reason: 'RUNBOOK.md held only the version\'s template and was removed' },
        ]);
      });
      it('Maintenance: a template-only CHANGELOG.md is removed the same way', async () => {
        const pinned = await enrol(ids.learner, 'shelf-four', v420);
        const deployment = await state(pinned, 'deployment', { 'docker-compose.yml': 'services: {}\n' });
        const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': SHELF_CHANGELOG, 'api/app.py': 'print(1)\n' });
        const before = await stateOf(deployment.id);
        const result = await service.run();
        expect(result).toMatchObject({ moved: 1, refused: 0, convertedByPhase: { deployment: 0, maintenance: 1 } });
        expect(await stateOf(deployment.id)).toEqual(before);
        expect((await stateOf(maintenance.id)).workspace).toEqual({ 'api/app.py': 'print(1)\n' });
        const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
        expect(audit.detail).toMatchObject({ conversion: { deployment: 'untouched', maintenance: 'template-dropped' } });
        expect((await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY)).repin.runs.at(-1).conversions).toEqual({ 'template-dropped': 1 });
      });
      it('a later in-place run leaves such a state untouched: the pack\'s template lines never become the learner\'s record', async () => {
        const pinned = await enrol(ids.learner, 'shelf-four', v420);
        const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': SHELF_RUNBOOK });
        const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': SHELF_CHANGELOG });
        expect((await service.run())!.moved).toBe(1);
        const once = { deployment: await stateOf(deployment.id), maintenance: await stateOf(maintenance.id) };
        await db.manager.delete(SettingEntity, { key: STORY_REPIN_DONE_KEY });
        expect((await service.run())!.convertedByPhase).toEqual({ requirements: 0, design: 0, deployment: 0, maintenance: 0 });
        expect(await stateOf(deployment.id)).toEqual(once.deployment);
        expect(await stateOf(maintenance.id)).toEqual(once.maintenance);
        expect(once.deployment.workspace).toEqual({});
        expect(once.maintenance.workspace).toEqual({});
      });
      it('a file that is not exactly its version\'s template is never dropped, even when it holds no word of the learner\'s', async () => {
        const pinned = await enrol(ids.learner, 'shelf-four', v420);
        // one template line deleted: no learner word, so the conversion is untouched, but the file is not the template
        const trimmed = { 'RUNBOOK.md': SHELF_RUNBOOK.replace('## Rollback\n\n- TODO(learner)\n', '## Rollback\n') };
        const deployment = await state(pinned, 'deployment', trimmed);
        const before = await stateOf(deployment.id);
        expect(await service.run()).toMatchObject({ moved: 1, convertedByPhase: { deployment: 0 } });
        expect(await stateOf(deployment.id)).toEqual(before);
        const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
        expect(audit.detail).toMatchObject({ conversion: { deployment: 'untouched' } });
      });
      it('Maintenance: a CHANGELOG.md that is not exactly its version\'s template is never dropped either', async () => {
        const pinned = await enrol(ids.learner, 'shelf-four', v420);
        // one template line deleted: no learner word, but the file is not the template
        const maintenance = await state(pinned, 'maintenance', { 'CHANGELOG.md': SHELF_CHANGELOG.replace('The Shelf releases, newest first.\n\n', '') });
        const before = await stateOf(maintenance.id);
        expect(await service.run()).toMatchObject({ moved: 1, convertedByPhase: { maintenance: 0 } });
        expect(await stateOf(maintenance.id)).toEqual(before);
        const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
        expect(audit.detail).toMatchObject({ conversion: { maintenance: 'untouched' } });
      });
    });
    it('a malformed drill incident is treated as none and never throws, in place or on a move', async () => {
      const unpinned = await enrol(ids.learner, 'shelf-four', null);
      const inPlace = await state(unpinned, 'deployment', {}, { ...DRILL, incident: 'not an incident' } as never);
      const pinned = await enrol(ids.other, 'shelf-four', v400);
      const moving = await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD }, { ...DRILL, incident: { rootCause: null, fix: null, actionItem: null } } as never);
      const before = await stateOf(inPlace.id);
      const result = await service.run();
      expect(result).toMatchObject({ moved: 1, refused: 0, convertedByPhase: { deployment: 1 } });
      expect(await stateOf(inPlace.id)).toEqual(before);
      const record = validateRunbookRecord(((await stateOf(moving.id)).workspace as Record<string, string>)[RUNBOOK_JSON]).runbook!;
      expect(record.environment).toMatchObject([{ name: 'TASKTRACKR_DB' }]);
      expect(record.incident).toMatchObject({ rootCause: '', fix: '', actionItem: '' });
      expect((await stateOf(moving.id)).drill).toMatchObject({ incident: { rootCause: null } });
    });
    it('does not seed a Deployment whose workspace is NULL, on a move or in place, and counts it untouched', async () => {
      // A 4.0.0 state whose drill was resolved and whose workspace an instructor then reset: the deployment-and-maintenance records migration skips it, and so does the re-pin.
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      const moving = await state(pinned, 'deployment', null as never, DRILL);
      const unpinned = await enrol(ids.other, 'shelf-four', null);
      const inPlace = await state(unpinned, 'deployment', null as never, DRILL);
      const before = { moving: await stateOf(moving.id), inPlace: await stateOf(inPlace.id) };
      const result = await service.run();
      expect(result).toMatchObject({ moved: 1, refused: 0, converted: 0, convertedByPhase: { deployment: 0 } });
      expect(await pinOf(pinned.id)).toBe(v500);
      expect(await stateOf(moving.id)).toEqual(before.moving);
      expect(await stateOf(inPlace.id)).toEqual(before.inPlace);
      expect(before.moving.workspace).toBeNull();
      const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audit.detail).toMatchObject({ conversion: { deployment: 'untouched' } });
    });
    it('a 4.x pin whose Implementation differs from the head is stranded and nothing converts', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400b);
      const deployment = await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD });
      const result = await service.run();
      expect(result!.strandedOtherPhasesDiffer).toBe(1);
      expect((await stateOf(deployment.id)).workspace).toEqual({ 'RUNBOOK.md': RUNBOOK_MD });
    });
    it('the in-place pass converts a leftover RUNBOOK.md only under a version that grades the runbook', async () => {
      const onHead = await enrol(ids.learner, 'shelf-four', v500);
      const current = await state(onHead, 'deployment', { [RUNBOOK_JSON]: serialiseRunbook(EMPTY_RUNBOOK), 'RUNBOOK.md': RUNBOOK_MD });
      const archivedId = await at('4.0.1', snapshot('story', 'design', false), 'archived');
      const left = await enrol(ids.other, 'shelf-four', archivedId);
      const kept = await state(left, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD });
      const result = await service.run();
      expect(result!.convertedByPhase.deployment).toBe(1);
      expect(Object.keys((await stateOf(current.id)).workspace as object)).toEqual([RUNBOOK_JSON]);
      expect(result!.leftOnArchived).toBe(1);
      expect((await stateOf(kept.id)).workspace).toEqual({ 'RUNBOOK.md': RUNBOOK_MD });
    });
    it('a class assigned 4.0.0 moves to the head with the record phrases', async () => {
      const cohortId = await cohort('delta');
      await assignment(cohortId, v400);
      await service.run();
      const active = await db.manager.findOneByOrFail(CohortProjectAssignmentEntity, { cohortId, state: 'active' });
      expect(active.projectVersionId).toBe(v500);
      expect(active.reason).toBe('Moved by the platform to the Shelf version whose Deployment is a runbook record and whose Maintenance is a change request record');
    });
    it('a second run is a no-op', async () => {
      const pinned = await enrol(ids.learner, 'shelf-four', v400);
      await state(pinned, 'deployment', { 'RUNBOOK.md': RUNBOOK_MD });
      expect((await service.run())!.moved).toBe(1);
      expect(await service.run()).toBeNull();
    });
  });

  describe('a retired written phase: moved off once the head holds none, never converted', () => {
    const TESTING_MD = '# Test plan\n\n- The overdue report lists a task due yesterday.\n';
    /** Four phases stand for six: Requirements by its form, Implementation and Testing by their kind, Design by its content. */
    const snapshot = (req: 'markdown' | 'story', testing: 'markdown' | 'code', implementation: 'markdown' | 'code' = 'code', design = 'the design') => ({ content: { phases: [
      { key: 'requirements', order: 1, checks: req === 'story' ? { kind: 'story', learnerStory: { id: 'US-4', hints: {} } } : { kind: 'markdown' } },
      { key: 'design', order: 2, intro: design, checks: { kind: 'markdown' } },
      { key: 'implementation', order: 3, checks: { kind: implementation } },
      { key: 'testing', order: 4, checks: { kind: testing } },
    ] } });
    let projectId = '';
    const at = async (semver: string, compiled: object, status: ProjectVersionEntity['status'] = 'published') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId, version: semver, status, manifest: {} as never, compiled: compiled as never,
        publishedAt: new Date(Date.now() - 60_000).toISOString() }))).id;
    const testing = (enrolment: EnrollmentEntity, workspace: Record<string, string>) =>
      db.manager.save(db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: enrolment.userId, phaseKey: 'testing', phaseOrder: 4, workspace, workspaceUpdatedAt: OLD_STAMP }));
    beforeEach(async () => {
      projectId = (await db.manager.save(db.manager.create(ProjectEntity, { slug: 'written-pack', title: 'Written', platformOwned: false, origin: 'upload' }))).id;
    });

    it('moves a pin off a written Testing to a head with none, keeps the written files byte for byte, and says so in the audit row and on the boot line', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      const v2 = await at('1.1.0', snapshot('markdown', 'code'));
      const pinned = await enrol(ids.learner, 'written-pack', v1);
      const written = await testing(pinned, { 'docs/test-plan.md': TESTING_MD });
      const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, movedOffRetired: 1, converted: 0, strandedOtherPhasesDiffer: 0, refused: 0 });
      expect(await pinOf(pinned.id)).toBe(v2);
      const after = await stateOf(written.id);
      expect(after.workspace).toEqual({ 'docs/test-plan.md': TESTING_MD });
      expect(after.workspaceUpdatedAt).toBe(OLD_STAMP);
      const audits = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actorUserId: ids.admin, subjectUserId: ids.learner, action: 'written-pack' });
      expect(audits[0].detail).toMatchObject({ from: '1.0.0', to: '1.1.0', reason: retiredWrittenReason('testing'), conversion: { testing: RETIRED_WRITTEN_OUTCOME } });
      expect(retiredWrittenReason('testing')).toBe('retired written testing phase, its files kept unconverted');
      expect(log.mock.calls.at(-1)![0]).toContain('moved 1 enrolment(s) off a version holding a written phase LearnSDLC no longer grades, to a head that holds none, their written files kept unconverted');
      expect(await marker()).not.toBeNull();
    });

    it('is idempotent: a second run is a no-op and the workspace is untouched', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      await at('1.1.0', snapshot('markdown', 'code'));
      const pinned = await enrol(ids.learner, 'written-pack', v1);
      const written = await testing(pinned, { 'docs/test-plan.md': TESTING_MD });
      expect((await service.run())!.movedOffRetired).toBe(1);
      expect(await service.run()).toBeNull();
      expect((await stateOf(written.id)).workspace).toEqual({ 'docs/test-plan.md': TESTING_MD });
      expect(await db.manager.count(AuditEventEntity, { where: { event: 'enrolment.repin' } })).toBe(1);
    });

    it('frees nobody while the head still holds a retired written phase', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown', 'markdown'));
      await at('1.1.0', snapshot('markdown', 'code', 'markdown'));
      const pinned = await enrol(ids.learner, 'written-pack', v1);
      await service.run();
      expect(await pinOf(pinned.id)).toBe(v1);
      expect(await db.manager.count(AuditEventEntity, { where: { event: 'enrolment.repin' } })).toBe(0);
    });

    it('counts a pin whose other phases differ from the head as stranded and leaves an archived pin alone', async () => {
      const differs = await at('1.0.0', snapshot('markdown', 'markdown', 'code', 'an older design'));
      const archived = await at('1.0.1', snapshot('markdown', 'markdown'), 'archived');
      await at('1.1.0', snapshot('markdown', 'code'));
      const stranded = await enrol(ids.learner, 'written-pack', differs);
      const left = await enrol(ids.other, 'written-pack', archived);
      const result = await service.run();
      expect(result).toMatchObject({ movedOffRetired: 0, strandedOtherPhasesDiffer: 1, leftOnArchived: 1 });
      expect(await pinOf(stranded.id)).toBe(differs);
      expect(await pinOf(left.id)).toBe(archived);
    });

    it('beside a structured conversion: one move, counted in both, with one audit row naming both', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      const v2 = await at('2.0.0', snapshot('story', 'code'));
      const pinned = await enrol(ids.learner, 'written-pack', v1);
      await requirements(pinned, { [OWN]: STORY_MD });
      const written = await testing(pinned, { 'docs/test-plan.md': TESTING_MD });
      const result = await service.run();
      expect(result).toMatchObject({ moved: 1, movedOffRetired: 1, convertedByPhase: { requirements: 1 } });
      expect(await pinOf(pinned.id)).toBe(v2);
      expect((await stateOf(written.id)).workspace).toEqual({ 'docs/test-plan.md': TESTING_MD });
      const [audit] = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audit.detail).toMatchObject({ reason: `requirements story model; ${retiredWrittenReason('testing')}`, conversion: { requirements: 'parsed-markdown', testing: RETIRED_WRITTEN_OUTCOME } });
    });

    it('moves a class assigned a version with a written Testing to the head, with the phrase', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      const v2 = await at('1.1.0', snapshot('markdown', 'code'));
      const cohortId = await cohort('echo');
      await assignment(cohortId, v1);
      expect((await service.run())!.assignmentsMoved).toBe(1);
      const active = await db.manager.findOneByOrFail(CohortProjectAssignmentEntity, { cohortId, state: 'active' });
      expect(active.projectVersionId).toBe(v2);
      expect(active.reason).toBe('Moved by the platform to the Written version whose Testing is no longer a written phase');
    });

    it('asks the in-flight check of a retired-only move, and waits for an admin account', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      await at('1.1.0', snapshot('markdown', 'code'));
      const busy = await enrol(ids.learner, 'written-pack', v1);
      const written = await testing(busy, { 'docs/test-plan.md': TESTING_MD });
      await db.manager.save(db.manager.create(SubmissionEntity, { phaseStateId: written.id, userId: ids.learner, status: 'queued', workspaceSnapshot: { 'docs/test-plan.md': TESTING_MD } }));
      const free = await enrol(ids.other, 'written-pack', v1);
      await db.manager.update(UserEntity, { id: ids.admin }, { role: 'INSTRUCTOR' });
      expect(await service.run()).toMatchObject({ movedOffRetired: 0, skippedInFlight: 1, waitingForAdmin: 1 });
      expect(await pinOf(busy.id)).toBe(v1);
      expect(await pinOf(free.id)).toBe(v1);
      expect(await marker()).toBeNull();
    });

    it('records why a retired-only move whose transaction failed was refused', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      const v2 = await at('1.1.0', snapshot('markdown', 'code'));
      const failing = await enrol(ids.learner, 'written-pack', v1);
      const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
      const update = EntityManager.prototype.update;
      const spy = jest.spyOn(EntityManager.prototype, 'update').mockImplementation(function (this: EntityManager, target: unknown, criteria: unknown, patch: unknown) {
        if (target === EnrollmentEntity && (criteria as { id?: string }).id === failing.id) return Promise.reject(new Error('write failed'));
        return (update as (...a: unknown[]) => Promise<never>).call(this, target, criteria, patch);
      } as never);
      try {
        expect(await service.run()).toMatchObject({ movedOffRetired: 0, refused: 1 });
      } finally {
        spy.mockRestore();
      }
      expect(await pinOf(failing.id)).toBe(v1);
      const audits = await db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: ids.admin, subjectUserId: ids.learner, targetId: failing.id, action: 'written-pack', reason: 'the move off the retired written phase failed, so nothing moved',
      });
      expect(audits[0].detail).toMatchObject({
        from: '1.0.0', to: '1.1.0', fromVersionId: v1, toVersionId: v2, refused: true, reason: 'the move off the retired written phase failed, so nothing moved',
      });
      expect(log.mock.calls.at(-1)![0]).toContain('1 refused (1 because the move off the retired written phase failed, so nothing moved)');
      expect(await marker()).toBeNull();
    });

    it('names a head that frees learners off a retired phase in heads', async () => {
      const v1 = await at('1.0.0', snapshot('markdown', 'markdown'));
      const v2 = await at('1.1.0', snapshot('markdown', 'code'));
      await enrol(ids.learner, 'written-pack', v1);
      expect((await service.run())!.heads).toEqual({ tasktrackr: ids.v300, 'written-pack': v2 });
    });
  });

  describe('the phase-set guard: no move between versions whose sets of phases differ', () => {
    const MAINTENANCE_SENTENCE =
      'This learner\'s version holds Maintenance and the new one does not, so the learner stays on their version, with their work. Learners who start now get the new one.';
    /** Each phase by its key and kind, in the order given; Requirements grades the story, so the project's head is a structured one. */
    const snapshot = (phases: [PhaseKey, string][]) => ({ content: { phases: phases.map(([key, kind], i) => ({
      key, order: i + 1, intro: `the ${key}`,
      checks: key === 'requirements' && kind === 'story' ? { kind, learnerStory: { id: 'US-4', hints: {} } } : { kind },
    })) } });
    const THREE: [PhaseKey, string][] = [['requirements', 'story'], ['design', 'markdown'], ['implementation', 'code']];
    /** The three above and a written Maintenance last: a retired written phase. */
    const WITH_MAINTENANCE: [PhaseKey, string][] = [...THREE, ['maintenance', 'markdown']];
    let projectId = '';
    const at = async (semver: string, compiled: object, publishedAt = new Date(Date.now() - 60_000).toISOString()) =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId, version: semver, status: 'published', manifest: {} as never, compiled: compiled as never, publishedAt }))).id;
    /** A later publish, so a run after the done marker asks again. */
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const stranded = () => db.manager.find(AuditEventEntity, { where: { event: 'enrolment.repin.stranded' }, order: { createdAt: 'ASC' } });
    beforeEach(async () => {
      projectId = (await db.manager.save(db.manager.create(ProjectEntity, { slug: 'strand-pack', title: 'Strand', platformOwned: false, origin: 'upload' }))).id;
    });

    it('phaseSetSentence names the first differing phase in LearnSDLC\'s order, either way, and nothing for the same set', () => {
      expect(phaseSetSentence(['requirements', 'maintenance', 'testing'], ['requirements'])).toBe(
        'This learner\'s version holds Testing and the new one does not, so the learner stays on their version, with their work. Learners who start now get the new one.',
      );
      expect(phaseSetSentence(['requirements', 'design'], ['design', 'requirements', 'testing', 'implementation'])).toBe(
        'This learner\'s version does not hold Implementation and the new one does, so the learner stays on their version, with their work. Learners who start now get the new one.',
      );
      expect(phaseSetSentence(['design', 'requirements'], ['requirements', 'design'])).toBeNull();
    });

    it('strands a pin whose retired written Maintenance is its last phase when the head drops Maintenance, and counts it apart', async () => {
      const v1 = await at('1.0.0', snapshot(WITH_MAINTENANCE));
      const v2 = await at('1.1.0', snapshot(THREE));
      const pinned = await enrol(ids.learner, 'strand-pack', v1);
      const result = await service.run();
      expect(result).toMatchObject({ moved: 0, movedOffRetired: 0, strandedPhaseSetDiffers: 1, strandedOtherPhasesDiffer: 0 });
      expect(await pinOf(pinned.id)).toBe(v1);
      expect(await db.manager.count(AuditEventEntity, { where: { event: 'enrolment.repin' } })).toBe(0);
      const rows = await stranded();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: ids.admin, subjectUserId: ids.learner, targetId: pinned.id, action: 'strand-pack', reason: MAINTENANCE_SENTENCE,
        detail: { from: '1.0.0', to: '1.1.0', fromVersionId: v1, toVersionId: v2, differs: 'maintenance' },
      });
    });

    it('strands an archived pin whose set of phases differs from the head\'s, rather than leaving it as archived', async () => {
      const v1 = await at('1.0.0', snapshot(WITH_MAINTENANCE));
      await db.manager.update(ProjectVersionEntity, { id: v1 }, { status: 'archived' });
      const v2 = await at('1.1.0', snapshot(THREE));
      const pinned = await enrol(ids.learner, 'strand-pack', v1);
      expect(await service.run()).toMatchObject({ moved: 0, strandedPhaseSetDiffers: 1, leftOnArchived: 0 });
      expect(await pinOf(pinned.id)).toBe(v1);
      const rows = await stranded();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetId: pinned.id, detail: { fromVersionId: v1, toVersionId: v2, differs: 'maintenance' } });
    });

    it('writes the strand\'s audit row once per pin and head', async () => {
      await at('1.0.0', snapshot(WITH_MAINTENANCE)).then((v1) => enrol(ids.learner, 'strand-pack', v1));
      const v2 = await at('1.1.0', snapshot(THREE));
      await service.run();
      expect(await stranded()).toHaveLength(1);
      expect(await marker()).not.toBeNull();
      // The same head published again: the run asks again, finds the strand again, and writes no second row.
      await db.manager.update(ProjectVersionEntity, { id: v2 }, { publishedAt: later(1) });
      expect(await service.run()).toMatchObject({ strandedPhaseSetDiffers: 1 });
      expect(await stranded()).toHaveLength(1);
    });

    it('a third boot after a second head writes one row for it, once', async () => {
      const pinned = await at('1.0.0', snapshot(WITH_MAINTENANCE)).then((v1) => enrol(ids.learner, 'strand-pack', v1));
      const a = await at('1.1.0', snapshot(THREE));
      await service.run();
      const b = await at('1.2.0', snapshot(THREE), later(1));
      expect(await service.run()).toMatchObject({ strandedPhaseSetDiffers: 1 });
      await db.manager.update(ProjectVersionEntity, { id: b }, { publishedAt: later(2) });
      await service.run();
      const rows = await stranded();
      // Sorted: the two rows can share a createdAt second on SQLite, and then their order is the random ids'.
      expect(rows.map((row) => (row.detail as { toVersionId: string }).toVersionId).sort()).toEqual([a, b].sort());
      expect(rows.every((row) => row.targetId === pinned.id)).toBe(true);
    });

    it('holds the done marker unset while a strand\'s row waits for an admin, and writes the row on the first run that has one', async () => {
      const v1 = await at('1.0.0', snapshot(WITH_MAINTENANCE));
      await at('1.1.0', snapshot(THREE));
      const pinned = await enrol(ids.learner, 'strand-pack', v1);
      // Something the run changes with no actor (an in-place conversion), so only the waiting row holds the marker back.
      const unpinned = await enrol(ids.other, 'strand-pack', null);
      await requirements(unpinned, { [OWN]: STORY_MD });
      await db.manager.update(UserEntity, { id: ids.admin }, { role: 'INSTRUCTOR' });
      expect(await service.run()).toMatchObject({ converted: 1, strandedPhaseSetDiffers: 1, waitingForAdmin: 0 });
      expect(await stranded()).toHaveLength(0);
      expect(await marker()).toBeNull();
      await db.manager.update(UserEntity, { id: ids.admin }, { role: 'ADMIN' });
      expect(await service.run()).toMatchObject({ strandedPhaseSetDiffers: 1 });
      expect(await stranded()).toHaveLength(1);
      expect((await stranded())[0].targetId).toBe(pinned.id);
      expect(await marker()).not.toBeNull();
    });

    it('never strands a pin the re-pin would not consider', async () => {
      // A non-head version whose set of phases differs from the head's, holding no older-format phase and no retired written one.
      const v1 = await at('1.0.0', snapshot([...THREE, ['testing', 'code']]));
      await at('1.1.0', snapshot(THREE));
      const pinned = await enrol(ids.learner, 'strand-pack', v1);
      expect(await service.run()).toMatchObject({ moved: 0, strandedPhaseSetDiffers: 0, strandedOtherPhasesDiffer: 0 });
      expect(await pinOf(pinned.id)).toBe(v1);
      expect(await db.manager.count(AuditEventEntity)).toBe(0);
    });

    it('says the strand on the boot line', async () => {
      await at('1.0.0', snapshot(WITH_MAINTENANCE)).then((v1) => enrol(ids.learner, 'strand-pack', v1));
      await at('1.1.0', snapshot(THREE));
      const log = jest.spyOn((service as unknown as { logger: Logger }).logger, 'log');
      await service.run();
      expect(log.mock.calls.at(-1)![0]).toContain('1 stranded because the head holds a different set of phases, 0 stranded because another phase differs from the head');
    });

    it('strands a pin with a converted phase too, and counts it in that phase\'s receipt', async () => {
      // Requirements in the older form beside the written Maintenance: the move would convert it, and the sets still differ.
      const v1 = await at('1.0.0', snapshot([['requirements', 'markdown'], ...THREE.slice(1), ['maintenance', 'markdown']]));
      await at('1.1.0', snapshot(THREE));
      const pinned = await enrol(ids.learner, 'strand-pack', v1);
      const state = await requirements(pinned, { [OWN]: STORY_MD });
      expect(await service.run()).toMatchObject({ moved: 0, converted: 0, strandedPhaseSetDiffers: 1 });
      expect(await pinOf(pinned.id)).toBe(v1);
      expect((await stateOf(state.id)).workspace).toEqual({ [OWN]: STORY_MD });
      const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
      expect(receipt.repin).toMatchObject({ strandedPhaseSetDiffers: 1, strandedOtherPhasesDiffer: 0 });
      expect(receipt.repin.runs.at(-1)).toMatchObject({ strandedPhaseSetDiffers: 1 });
    });
  });
});

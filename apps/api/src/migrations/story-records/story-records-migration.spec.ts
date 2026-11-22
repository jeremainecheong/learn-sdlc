import 'reflect-metadata';
import * as path from 'path';
import { ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { STORY_JSON } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, ReleaseRecordEntity, SettingEntity, UserEntity } from '../../db/entities';
import { WorkflowService } from '../../workflow/workflow.service';
import { ProjectEntity, ProjectVersionEntity } from '../../content/project.entities';
import { S1StoryRecordsFromMarkdown1790100000000 } from '../1790100000000-S1-StoryRecordsFromMarkdown';
import { STORY_MIGRATION_RECEIPT_KEY } from './story-records';

/**
 * The migration on the local-first store, every migration applied. It
 * converts a Requirements workspace if and only if the learner's version (the
 * pin, or the project's published head for a null pin) grades the story
 * record, which is the set the boot re-pin also converts
 * (`seed/story-repin.service.ts`): a TaskTrackr learner still pinned to a
 * markdown version is converted by the re-pin in the same transaction that
 * moves them, never here. A learner whose version still grades the markdown
 * keeps the file it grades, and the receipt says why for every skip.
 */
const OWN = 'requirements/my-story.md';
const STORY_MD = '# US-4 \u00b7 Overdue report\n\nAs a lead, I want a report, so that I chase it.\n\n- **US-4/AC-1** — Given a task due yesterday, when I open the report, then it is listed.\n';
const VALID = JSON.stringify({ id: 'US-4', title: 'Kept', persona: 'p', capability: 'c', benefit: 'b', criteria: [], scopeExclusions: [], notes: '', renderHash: 'x' });
/** The stamp a tab that loaded the workspace before the migration still holds. */
const OLD_STAMP = '2026-10-01T09:00:00.000Z';

describe('S1 story records from markdown (sqlite)', () => {
  let db: DataSource;
  const states: Record<string, string> = {};

  const compiled = (kind: 'markdown' | 'story', storyId = 'US-4') => ({
    content: { phases: [{ key: 'requirements', checks: kind === 'story' ? { kind, learnerStory: { id: storyId, hints: {} } } : { kind } }] },
  });
  const workspaceOf = async (key: string) =>
    (await db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] })).workspace as Record<string, string>;
  const receiptOf = async () => JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: [path.join(__dirname, '..', '*.{ts,js}')],
      migrationsTableName: 'learnsdlc_migrations',
    }).initialize();
    const applied = await db.runMigrations({ transaction: 'all' });
    // S2 (Design) follows it; this case runs S1 again by hand on the rows below
    expect(applied.map((m) => m.name)).toContain('S1StoryRecordsFromMarkdown1790100000000');

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s1.test', passwordHash: 'x', displayName: 'L' }));
    const project = (slug: string, platformOwned = false) =>
      db.manager.save(db.manager.create(ProjectEntity, { slug, title: slug, platformOwned, origin: platformOwned ? 'seed' : 'upload' }));
    const tasktrackr = await project('tasktrackr', true);
    const teacher = await project('desk');
    const storyProject = await project('shelf');
    const brokenProject = await project('broken');
    const v = async (projectId: string, version: string, snapshot: object) =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId, version, status: 'published', manifest: {} as never, compiled: snapshot as never }))).id;
    const v201 = await v(tasktrackr.id, '2.0.1', compiled('markdown'));
    const v300 = await v(tasktrackr.id, '3.0.0', compiled('story'));
    const teacherV = await v(teacher.id, '1.0.0', compiled('markdown'));
    const storyV = await v(storyProject.id, '1.0.0', compiled('story', 'SH-5'));
    const brokenV = await v(brokenProject.id, '1.0.0', compiled('story'));
    await db.query(`UPDATE "project_versions" SET "compiled" = '{ not json' WHERE "id" = ?`, [brokenV]);

    let order = 0;
    const state = async (key: string, slug: string, pin: string | null, workspace: Record<string, string> | null, phaseKey = 'requirements') => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: slug, projectVersionId: pin }));
      const row = await db.manager.save(
        db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: user.id, phaseKey: phaseKey as never, phaseOrder: 1, workspace, workspaceUpdatedAt: OLD_STAMP }),
      );
      states[key] = row.id;
    };
    await state('parsed', 'tasktrackr', v300, { [OWN]: STORY_MD });
    await state('kept', 'tasktrackr', null, { [OWN]: STORY_MD, [STORY_JSON]: VALID });
    await state('template', 'tasktrackr', v300, { [OWN]: '# US-4 *(draft, complete this)*\n\n<!-- write here -->\n\n- Given ..., when ..., then ...\n' });
    await state('fallback', 'tasktrackr', v300, { [OWN]: 'hello there' });
    await state('refused', 'tasktrackr', v300, { [OWN]: STORY_MD, [STORY_JSON]: '{ broken' });
    await state('untouched', 'tasktrackr', v300, { 'requirements/notes.txt': 'n' });
    await state('story-version', 'shelf', storyV, { [OWN]: STORY_MD });
    await state('tasktrackr-markdown', 'tasktrackr', v201, { [OWN]: STORY_MD });
    await state('teacher-markdown', 'desk', teacherV, { [OWN]: STORY_MD });
    await state('teacher-unpinned', 'desk', null, { [OWN]: STORY_MD });
    await state('unreadable', 'broken', brokenV, { [OWN]: STORY_MD });
    await state('design', 'tasktrackr', v300, { [OWN]: 'not requirements' }, 'design');
    await state('empty', 'tasktrackr', v300, null);

    await new S1StoryRecordsFromMarkdown1790100000000().up(db.createQueryRunner());
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  it('converts learners whose version grades the story record, and drops the markdown', async () => {
    for (const key of ['parsed', 'kept', 'template', 'fallback', 'story-version']) {
      const workspace = await workspaceOf(key);
      expect([key, workspace[OWN]]).toEqual([key, undefined]);
    }
    expect(JSON.parse((await workspaceOf('parsed'))[STORY_JSON])).toMatchObject({ id: 'US-4', title: 'Overdue report' });
    expect(JSON.parse((await workspaceOf('kept'))[STORY_JSON]).title).toBe('Kept');
    // the phase's own fixed id, not the heading's
    expect(JSON.parse((await workspaceOf('story-version'))[STORY_JSON]).id).toBe('SH-5');
  });

  it('leaves alone a TaskTrackr learner still pinned to a markdown version: the re-pin converts them as it moves them', async () => {
    expect(await workspaceOf('tasktrackr-markdown')).toEqual({ [OWN]: STORY_MD });
  });

  it('leaves a refused workspace, a teacher\'s markdown project, another phase and an empty workspace exactly as they were', async () => {
    expect(await workspaceOf('refused')).toEqual({ [OWN]: STORY_MD, [STORY_JSON]: '{ broken' });
    expect(await workspaceOf('teacher-markdown')).toEqual({ [OWN]: STORY_MD });
    expect(await workspaceOf('teacher-unpinned')).toEqual({ [OWN]: STORY_MD });
    expect(await workspaceOf('unreadable')).toEqual({ [OWN]: STORY_MD });
    expect(await workspaceOf('design')).toEqual({ [OWN]: 'not requirements' });
    expect(await workspaceOf('untouched')).toEqual({ 'requirements/notes.txt': 'n' });
    expect(await workspaceOf('empty')).toBeNull();
  });

  it('stamps a converted workspace afresh, so a tab still holding the old stamp cannot save over the record', async () => {
    const converted = await db.manager.findOneByOrFail(PhaseStateEntity, { id: states.parsed });
    expect(converted.workspaceUpdatedAt).not.toBe(OLD_STAMP);
    expect(Date.parse(converted.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
    expect(new Date(converted.workspaceUpdatedAt as string).toISOString()).toBe(converted.workspaceUpdatedAt);
    // a row the migration did not write keeps its stamp
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: states['teacher-markdown'] })).workspaceUpdatedAt).toBe(OLD_STAMP);

    // The room's own save: the stale tab quotes the stamp it loaded and is refused.
    const workflow = new WorkflowService(
      db.getRepository(EnrollmentEntity),
      db.getRepository(PhaseStateEntity),
      db.getRepository(ReleaseRecordEntity),
      {} as never,
      {} as never,
      db,
    );
    jest.spyOn(workflow, 'loadOwnedState').mockImplementation(async () => ({
      state: await db.manager.findOneByOrFail(PhaseStateEntity, { id: states.parsed }),
      phase: { files: [{ path: STORY_JSON, editable: true }], checks: { kind: 'markdown' } },
    }) as never);
    const stale = workflow.saveWorkspace(converted.userId, states.parsed, { [STORY_JSON]: '{}' }, OLD_STAMP);
    await expect(stale).rejects.toBeInstanceOf(ConflictException);
    await expect(stale).rejects.toMatchObject({ response: { error: 'workspace_changed' } });
    expect((await workspaceOf('parsed'))[STORY_JSON]).not.toBe('{}');
  });

  it('writes the receipt: one count per outcome, the fallback ids, and each refusal and skip with its own sentence', async () => {
    const receipt = await receiptOf();
    expect(receipt.counts).toEqual({
      'kept-record': 1,
      'parsed-markdown': 2,
      'empty-template': 1,
      fallback: 1,
      untouched: 1,
      refused: 1,
      skipped: 4,
    });
    expect(receipt.fallbackStateIds).toEqual([states.fallback]);
    expect(receipt.refused).toEqual([{ stateId: states.refused, reason: 'the story record is not valid JSON, so neither file was changed' }]);
    const reasons = Object.fromEntries((receipt.skipped as { stateId: string; reason: string }[]).map((one) => [one.stateId, one.reason]));
    expect(reasons).toEqual({
      [states['tasktrackr-markdown']]: "the learner's version still grades the markdown story",
      [states['teacher-markdown']]: "the learner's version still grades the markdown story",
      [states['teacher-unpinned']]: "the learner follows the project's published head, which still grades the markdown story",
      [states.unreadable]: "the learner's version has no compiled snapshot that can be read",
    });
    expect(receipt.editedMarkdown).toBe(1);
    expect(typeof receipt.at).toBe('string');
  });

  it('running it again changes nothing it already converted, and merges into the receipt, keeping the boot\'s sections', async () => {
    const before = await workspaceOf('parsed');
    const receipt = await receiptOf();
    const drafts = { at: 'then', converted: ['a draft'], refused: [] };
    await db.manager.save(db.manager.create(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ ...receipt, drafts }) }));
    await new S1StoryRecordsFromMarkdown1790100000000().up(db.createQueryRunner());
    expect(await workspaceOf('parsed')).toEqual(before);
    expect(await db.manager.countBy(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).toBe(1);
    const again = await receiptOf();
    expect(again.drafts).toEqual(drafts);
    expect(again.counts.untouched).toBe(6);
  });
});

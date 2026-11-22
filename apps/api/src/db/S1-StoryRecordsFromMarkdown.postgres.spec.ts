import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { STORY_JSON } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SettingEntity, UserEntity } from './entities';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { STORY_MIGRATION_RECEIPT_KEY } from '../migrations/story-records/story-records';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';

/**
 * Migration 34, `S1-StoryRecordsFromMarkdown`, against a real PostgreSQL
 * server in a schema of its own: the 33 migrations before it run on an empty
 * schema, the rows it reads are written, and then it runs through
 * `runMigrations` as a deployment runs it. What only a real server can say:
 * the `simple-json` workspace and snapshot columns read and write back as the
 * sqlite spec beside the migration (`story-records-migration.spec.ts`) says,
 * the receipt lands in `settings`, it adds no table (no DDL), and the schema
 * builder has nothing pending afterwards. Self-skips without
 * `POSTGRES_TEST_CONFIG`, as every `.postgres.spec.ts` here does.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rs_s1';
const S1_STAMP = '1790100000000';
const OWN = 'requirements/my-story.md';
const STORY_MD = '# US-4 Overdue report\n\nAs a lead, I want a report, so that I chase it.\n\n- AC-1 Given a task due yesterday, when I open the report, then it is listed.\n';

describePg('S1 story records from markdown (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  const states: Record<string, string> = {};

  const compiled = (kind: 'markdown' | 'story') => ({
    content: { phases: [{ key: 'requirements', checks: kind === 'story' ? { kind, learnerStory: { id: 'US-4', hints: {} } } : { kind } }] },
  });
  const workspaceOf = async (key: string) =>
    (await db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] })).workspace as Record<string, string>;
  const tables = async () =>
    Number((await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]))[0].n);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const before = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore(S1_STAMP), ALL_ENTITIES)).initialize();
    expect(await before.runMigrations({ transaction: 'all' })).toHaveLength(33);
    await before.destroy();
    // up to S1 and no further: S2 (Design) has its own spec beside this one
    db = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore('1790200000000'), ALL_ENTITIES)).initialize();

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s1-pg.test', passwordHash: 'x', displayName: 'L' }));
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const version = async (semver: string, kind: 'markdown' | 'story') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: tasktrackr.id, version: semver, status: 'published', manifest: {} as never, compiled: compiled(kind) as never }))).id;
    const v201 = await version('2.0.1', 'markdown');
    const v300 = await version('3.0.0', 'story');
    let order = 0;
    const state = async (key: string, pin: string | null, workspace: Record<string, string>) => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: 'tasktrackr', projectVersionId: pin }));
      states[key] = (
        await db.manager.save(
          db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: user.id, phaseKey: 'requirements', phaseOrder: 1, workspace, workspaceUpdatedAt: '2026-10-01T09:00:00.000Z' }),
        )
      ).id;
    };
    await state('story', v300, { [OWN]: STORY_MD, 'requirements/notes.txt': 'kept' });
    await state('unpinned', null, { [OWN]: STORY_MD });
    await state('markdown', v201, { [OWN]: STORY_MD });

    const tablesBefore = await tables();
    const applied = await db.runMigrations({ transaction: 'all' });
    expect(applied.map((one) => one.name)).toEqual(['S1StoryRecordsFromMarkdown1790100000000']);
    expect(await tables()).toBe(tablesBefore);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('converts a learner on the story version and a null pin, and leaves a learner on a markdown version for the re-pin', async () => {
    const story = await workspaceOf('story');
    expect(story[OWN]).toBeUndefined();
    expect(story['requirements/notes.txt']).toBe('kept');
    expect(JSON.parse(story[STORY_JSON])).toMatchObject({ id: 'US-4', title: 'Overdue report', persona: 'lead' });
    expect((await workspaceOf('unpinned'))[OWN]).toBeUndefined();
    expect(await workspaceOf('markdown')).toEqual({ [OWN]: STORY_MD });
  });

  it('writes its receipt to settings, and leaves the schema builder nothing to do', async () => {
    const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: STORY_MIGRATION_RECEIPT_KEY })).value);
    expect(receipt.counts).toMatchObject({ 'parsed-markdown': 2, skipped: 1 });
    expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });
});

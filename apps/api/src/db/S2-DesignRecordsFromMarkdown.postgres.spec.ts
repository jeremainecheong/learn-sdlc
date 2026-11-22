import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DESIGN_JSON } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SettingEntity, UserEntity } from './entities';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { DESIGN_MIGRATION_RECEIPT_KEY } from '../migrations/design-records/design-records';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';

/**
 * Migration 35, `S2-DesignRecordsFromMarkdown`, against a real PostgreSQL
 * server in a schema of its own: the 34 migrations before it run on an empty
 * schema, the rows it reads are written, and then it runs through
 * `runMigrations` as a deployment runs it. What only a real server can say:
 * the `simple-json` workspace and snapshot columns read and write back as the
 * sqlite spec beside the migration (`design-records-migration.spec.ts`) says,
 * the receipt lands in `settings`, it adds no table (no DDL), and the schema
 * builder has nothing pending afterwards. Self-skips without
 * `POSTGRES_TEST_CONFIG`, as every `.postgres.spec.ts` here does; the fixture
 * needs `uuid-ossp` installed on the server beforehand and will not install it.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rs_s2';
const S2_STAMP = '1790200000000';
const MD = 'design/my-design.md';
const LEGACY = JSON.stringify({
  fields: [{ name: 'id', type: 'integer', required: true, note: 'db' }],
  operations: [{ name: 'getOverdue(today)', satisfies: 'US-4', inputs: 'today', returns: 'Task[]', boundary: 'due today is not overdue', errors: '' }],
  decisions: [],
});

describePg('S2 design records from markdown (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  const states: Record<string, string> = {};

  const compiled = (kind: 'markdown' | 'design') => ({ content: { phases: [{ key: 'design', checks: { kind } }] } });
  const workspaceOf = async (key: string) =>
    (await db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] })).workspace as Record<string, string>;
  const tables = async () =>
    Number((await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]))[0].n);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const before = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore(S2_STAMP), ALL_ENTITIES)).initialize();
    expect(await before.runMigrations({ transaction: 'all' })).toHaveLength(34);
    await before.destroy();
    // every migration up to S2 and none after it, so `runMigrations` below applies exactly S2
    db = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore('1790300000000'), ALL_ENTITIES)).initialize();

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s2-pg.test', passwordHash: 'x', displayName: 'L' }));
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const version = async (semver: string, kind: 'markdown' | 'design') =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: tasktrackr.id, version: semver, status: 'published', manifest: {} as never, compiled: compiled(kind) as never }))).id;
    const v300 = await version('3.0.0', 'markdown');
    const v400 = await version('4.0.0', 'design');
    let order = 0;
    const state = async (key: string, pin: string | null, workspace: Record<string, string>) => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: 'tasktrackr', projectVersionId: pin }));
      states[key] = (
        await db.manager.save(
          db.manager.create(PhaseStateEntity, { enrollmentId: enrolment.id, userId: user.id, phaseKey: 'design', phaseOrder: 2, workspace, workspaceUpdatedAt: '2026-10-01T09:00:00.000Z' }),
        )
      ).id;
    };
    await state('design', v400, { [MD]: 'board only', [DESIGN_JSON]: LEGACY, 'design/notes.txt': 'kept' });
    await state('unpinned', null, { [MD]: 'Tasks belong to one list.\n' });
    await state('markdown', v300, { [MD]: 'my own design' });

    const tablesBefore = await tables();
    const applied = await db.runMigrations({ transaction: 'all' });
    expect(applied.map((one) => one.name)).toEqual(['S2DesignRecordsFromMarkdown1790200000000']);
    expect(await tables()).toBe(tablesBefore);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('converts a learner on the design version and a null pin, and leaves a learner on a markdown version for the re-pin', async () => {
    const design = await workspaceOf('design');
    expect(design[MD]).toBeUndefined();
    expect(design['design/notes.txt']).toBe('kept');
    expect(JSON.parse(design[DESIGN_JSON]).entities[0]).toMatchObject({ name: 'Model', kind: 'class' });
    expect((await workspaceOf('unpinned'))[MD]).toBeUndefined();
    expect(await workspaceOf('markdown')).toEqual({ [MD]: 'my own design' });
  });

  it('writes its receipt to settings, and leaves the schema builder nothing to do', async () => {
    const receipt = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: DESIGN_MIGRATION_RECEIPT_KEY })).value);
    expect(receipt.counts).toMatchObject({ folded: 1, seeded: 1, skipped: 1 });
    expect(receipt.folded[0].stateId).toBe(states.design);
    expect(receipt.skipped[0].stateId).toBe(states.markdown);
    expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });
});

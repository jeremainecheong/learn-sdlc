import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import {
  dropScratchSchema,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { populatedProof } from '../../test/populated-migration-proof';

/**
 * The H5 and H9 migrations' populated proof on PostgreSQL 16, in a schema
 * of its own: 27 base migrations → legacy rows in the pre-project-model shape
 * (one completed project) → H1–H4 → rows of that era (TaskTrackr 2.0.1, a teacher's
 * project, a class assignment, pinned enrolments, a null pin on the teacher's
 * slug) → H5 + H9 in ONE transaction → both `down()`s → forward again.
 *
 * Never a copy of a shared validation database (it holds no null-pin row) and
 * never a hosted environment. Self-skips without `POSTGRES_TEST_CONFIG`.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'populated_migration';

describePg('the H5 and H9 migrations on a populated PostgreSQL schema', () => {
  let admin: DataSource;
  const schema = scratchSchema(PREFIX);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
  });

  afterAll(async () => {
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('keeps 32 tables, alters submissions (schema) and enrollments (data) only, and reverses', async () => {
    const { evidence } = await populatedProof(
      async (migrations, entities = []) => {
        const db = await new DataSource(postgresOptions(url!, schema, migrations, entities)).initialize();
        expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
        return db;
      },
      ALL_ENTITIES,
      'postgres',
    );
    expect(evidence.tableCount).toEqual({ legacyBase27: 22, beforeH5AndH9: 32, afterUp: 32, afterDown: 32 });
    expect(evidence.schemaChangedTables).toEqual(['submissions']);
    expect(evidence.dataChangedTables).toEqual(['enrollments']);
    const version = (await admin.query('SHOW server_version'))[0].server_version as string;
    expect(version).toMatch(/^16\./);
  });
});

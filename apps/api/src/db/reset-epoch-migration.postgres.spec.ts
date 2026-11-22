import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import {
  H5_STAMP,
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { h5Case } from '../../test/reset-epoch-migration-cases';

/**
 * H5 against a real PostgreSQL 16 server, in a schema of its own: `SET
 * lock_timeout` first (H3/H4's shape), one `ALTER TABLE … ADD COLUMN` with no
 * default (metadata-only, no rewrite), the in-flight guard's normalised
 * predicate unchanged, zero pending schema-builder queries, and a clean
 * `down()`. Self-skips without `POSTGRES_TEST_CONFIG`.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rb_h5';

describePg('H5 adds the nullable submissions epoch (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    db = await new DataSource(
      postgresOptions(url!, schema, migrationFilesBefore(H5_STAMP), ALL_ENTITIES),
    ).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    expect(await db.runMigrations({ transaction: 'all' })).toHaveLength(31);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  h5Case(() => db, 'postgres');
});

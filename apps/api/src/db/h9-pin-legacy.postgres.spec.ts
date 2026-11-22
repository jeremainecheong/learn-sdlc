import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { H5SubmissionResetEpoch1789800000000 } from '../migrations/1789800000000-H5-SubmissionResetEpoch';
import {
  H5_STAMP,
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';
import { h9Cases } from '../../test/pin-backfill-migration-cases';

/**
 * The H9 migration against a real PostgreSQL 16 server, in a schema of its
 * own. This half matters: `projects.id` is `uuid` while
 * `project_versions.projectId` and `enrollments.projectVersionId` are
 * `character varying`, and Postgres has no `uuid = character varying`
 * operator. A statement that compares them directly raises here and passes
 * on sqlite, so a sqlite-only test would ship a release that rolls back.
 *
 * It self-skips without `POSTGRES_TEST_CONFIG`, refuses any target but the
 * loopback cluster's scratch databases, never creates an extension, and drops
 * only the schema it generated.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rb_h9';

describePg('H9 pins legacy null-pin enrolments (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);

  beforeAll(async () => {
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    db = await new DataSource(
      postgresOptions(url!, schema, [...migrationFilesBefore(H5_STAMP), H5SubmissionResetEpoch1789800000000]),
    ).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    expect(await db.runMigrations({ transaction: 'all' })).toHaveLength(32);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  h9Cases(() => db, 'postgres');

  it('proves the cast is load-bearing: the uncast join raises on Postgres', async () => {
    const q = db.createQueryRunner();
    await q.connect();
    await q.startTransaction();
    try {
      await expect(
        q.query(
          `UPDATE "enrollments" SET "projectVersionId" = (SELECT v."id" FROM "project_versions" v ` +
            `JOIN "projects" p ON p."id" = v."projectId" WHERE p."slug" = 'tasktrackr' ` +
            `AND v."version" = '2.0.1' AND v."status" = 'published') WHERE "projectVersionId" IS NULL`,
        ),
      ).rejects.toThrow(/operator does not exist: uuid = character varying/);
    } finally {
      await q.rollbackTransaction();
      await q.release();
    }
  });
});

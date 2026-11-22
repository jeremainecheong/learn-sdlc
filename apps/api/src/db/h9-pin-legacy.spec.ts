import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { H5SubmissionResetEpoch1789800000000 } from '../migrations/1789800000000-H5-SubmissionResetEpoch';
import { H5_STAMP, migrationFilesBefore, sqliteOptions } from '../../test/migration-history-fixture';
import { h9Cases } from '../../test/pin-backfill-migration-cases';

/**
 * H9 on the local-first store: H9 pins legacy null TaskTrackr enrolments to
 * 2.0.1 by explicit semver, leaves every other row alone, and is a no-op where
 * there is nothing to pin. The database is at base + H5, the state H9 runs in.
 * The Postgres half (`h9-pin-legacy.postgres.spec.ts`) is the one that matters
 * most: sqlite has no uuid type, so the cast H9 needs cannot fail here.
 */
describe('H9 pins legacy null-pin enrolments (sqlite)', () => {
  let dir = '';
  let db: DataSource;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-h9-'));
    db = await new DataSource(
      sqliteOptions(path.join(dir, 'h9.sqlite'), [...migrationFilesBefore(H5_STAMP), H5SubmissionResetEpoch1789800000000]),
    ).initialize();
    expect(await db.runMigrations({ transaction: 'all' })).toHaveLength(32);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  h9Cases(() => db, 'sqlite');
});

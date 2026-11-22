import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import { H5_STAMP, migrationFilesBefore, sqliteOptions } from '../../test/migration-history-fixture';
import { h5Case } from '../../test/reset-epoch-migration-cases';

/**
 * H5 on the local-first store: `submissions.resetEpoch integer NULL`, added
 * with raw `ADD COLUMN` so sqlite keeps the partial in-flight guard's `WHERE`
 * (no table rebuild), with zero pending schema-builder queries after it, and a
 * `down()` that leaves the table as it found it.
 */
describe('H5 adds the nullable submissions epoch (sqlite)', () => {
  let dir = '';
  let db: DataSource;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-h5-'));
    db = await new DataSource(
      sqliteOptions(path.join(dir, 'h5.sqlite'), migrationFilesBefore(H5_STAMP), ALL_ENTITIES),
    ).initialize();
    expect(await db.runMigrations({ transaction: 'all' })).toHaveLength(31);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  h5Case(() => db, 'sqlite');
});

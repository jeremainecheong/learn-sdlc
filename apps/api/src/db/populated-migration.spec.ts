import 'reflect-metadata';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './entities';
import { sqliteOptions } from '../../test/migration-history-fixture';
import { populatedProof } from '../../test/populated-migration-proof';

/**
 * The H5 and H9 migrations' populated proof on the local-first store: a
 * file built the way a deployed host is (27 base migrations, legacy rows, H1–H4, the
 * rows of that era), then H5 + H9 in one transaction, then both `down()`s, then
 * forward again. The assertions live in `test/populated-migration-proof.ts` so
 * the Postgres twin asserts the same things.
 */
describe('the H5 and H9 migrations on a populated sqlite file', () => {
  let dir = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'populated-migration-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps 32 tables, alters submissions (schema) and enrollments (data) only, and reverses', async () => {
    const file = path.join(dir, 'populated.sqlite');
    const { evidence } = await populatedProof(
      (migrations, entities = []) => new DataSource(sqliteOptions(file, migrations, entities)).initialize(),
      ALL_ENTITIES,
      'sqlite',
    );
    expect(evidence.tableCount).toEqual({ legacyBase27: 22, beforeH5AndH9: 32, afterUp: 32, afterDown: 32 });
    expect(evidence.schemaChangedTables).toEqual(['submissions']);
    expect(evidence.dataChangedTables).toEqual(['enrollments']);
  });
});

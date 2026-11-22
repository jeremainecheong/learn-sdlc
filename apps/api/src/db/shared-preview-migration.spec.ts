import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES, PreviewSessionEntity } from './entities';
import { SharedPreviewSessions1789510000000 } from '../migrations/1789510000000-SharedPreviewSessions';

describe('shared preview migration against retained coursework', () => {
  let db: DataSource;
  const migration = new SharedPreviewSessions1789510000000();

  beforeEach(async () => {
    const directory = path.join(__dirname, '../migrations');
    db = await new DataSource({
      type: 'better-sqlite3', database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: fs.readdirSync(directory).filter(name => name.endsWith('.ts') && !name.includes('SharedPreviewSessions')).map(name => path.join(directory, name)),
      migrationsRun: true, synchronize: false,
    }).initialize();
    await db.query(`INSERT INTO users ("id", "email", "passwordHash", "displayName") VALUES ('preserved-owner', 'migration@example.test', 'unusable-test-hash', 'Migration learner')`);
  });
  afterEach(async () => { if (db?.isInitialized) await db.destroy(); });

  it('adds shared ownership without changing existing rows and matches the entity schema', async () => {
    const before = await db.query('SELECT * FROM users');
    const runner = db.createQueryRunner();
    try {
      await migration.up(runner);
      expect(await db.query('SELECT * FROM users')).toEqual(before);
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map(query => query.query)).toEqual([]);
      const repo = db.getRepository(PreviewSessionEntity);
      const session = {
        id: 'a'.repeat(24), userId: 'preserved-owner', phaseStateId: 'phase', tokenVersion: 0,
        runnerId: null, capabilityHash: 'b'.repeat(64), status: 'starting' as const,
        state: { bundleOk: false, message: null, stopReason: null, startedAt: 1, readyAt: null, expiresAt: 600001, lastSeenAt: 1, bytesServed: 0, forgetAt: null, buildMs: 0, launchDeadline: 600001 },
      };
      await repo.save(repo.create(session));
      await expect(repo.save(repo.create({ ...session, id: 'c'.repeat(24) }))).rejects.toThrow();
      expect(await repo.count()).toBe(1);
      await expect(migration.down(runner)).rejects.toThrow('Drain previews');
      expect(await repo.count()).toBe(1);
      expect(await db.query('SELECT * FROM users')).toEqual(before);
    } finally { await runner.release(); }
  });

  it('can reverse an empty additive table without touching coursework', async () => {
    const before = await db.query('SELECT * FROM users');
    const runner = db.createQueryRunner();
    try {
      await migration.up(runner);
      await migration.down(runner);
      expect(await runner.hasTable('preview_sessions')).toBe(false);
      expect(await db.query('SELECT * FROM users')).toEqual(before);
    } finally { await runner.release(); }
  });
});

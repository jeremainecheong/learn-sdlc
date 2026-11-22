import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { readdirSync } from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, PreviewSessionEntity, SubmissionEntity, UserEntity } from './entities';
import { SharedPreviewSessions1789510000000 } from '../migrations/1789510000000-SharedPreviewSessions';
import { describePostgres, postgresTarget } from '../../test/support/postgres';

describePostgres('additive shared-preview migration on an isolated actual PostgreSQL schema', () => {
  let admin: DataSource;
  let db: DataSource;
  let schema: string;
  let retained: Record<string, unknown[]>;
  let userId: string;
  let phaseStateId: string;
  const migration = new SharedPreviewSessions1789510000000();
  const snapshot = async () => {
    const out: Record<string, unknown[]> = {};
    for (const table of ['users', 'enrollments', 'phase_states', 'submissions']) {
      out[table] = await db.query(`SELECT row_to_json(t)::text AS row FROM "${schema}"."${table}" t ORDER BY id`);
    }
    return out;
  };

  beforeAll(async () => {
    const url = new URL(postgresTarget()!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5494') throw new Error('isolated migration target refused');
    schema = `gap_security_migration_${randomUUID().replace(/-/g, '')}`;
    admin = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    // Historical migrations use the already-installed UUID extension. This
    // fixture refuses to introduce a shared extension or modify public tables.
    expect(await admin.query("SELECT 1 FROM pg_extension WHERE extname='uuid-ossp'")).toHaveLength(1);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const directory = path.join(__dirname, '../migrations');
    db = await new DataSource({
      type: 'postgres', url: url.toString(), schema,
      extra: { options: `-c search_path=${schema},public`, statement_timeout: 15000 },
      entities: ALL_ENTITIES, synchronize: false,
      migrations: readdirSync(directory).filter(name => name.endsWith('.ts') && !name.includes('SharedPreviewSessions')).map(name => path.join(directory, name)),
    }).initialize();
    expect((await db.query('SELECT current_schema() AS name'))[0].name).toBe(schema);
    await db.runMigrations();
    const user = await db.getRepository(UserEntity).save({ email: 'migration-owned@example.invalid', displayName: 'Owned migration fixture', passwordHash: 'unusable' });
    userId = user.id;
    const enrollment = await db.getRepository(EnrollmentEntity).save({ userId, projectSlug: 'tasktrackr', packVersion: '2.0.1' });
    const phase = await db.getRepository(PhaseStateEntity).save({ userId, enrollmentId: enrollment.id, phaseKey: 'requirements', phaseOrder: 1,
      status: 'passed', bestScore: 90, attempts: 2, workspace: { 'requirements/story.md': 'Retained actual migration fixture' } });
    phaseStateId = phase.id;
    await db.getRepository(SubmissionEntity).save({ userId, phaseStateId, status: 'completed', score: 90, passed: true });
    retained = await snapshot();
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      if (!/^gap_security_migration_[0-9a-f]{32}$/.test(schema)) throw new Error('migration cleanup namespace refused');
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      expect(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).toEqual([]);
      await admin.destroy();
    }
  });

  it('preserves retained coursework, exactly matches current entities, and refuses reversal until ownership is empty', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await migration.up(runner);
      expect(await snapshot()).toEqual(retained);
      expect((await db.driver.createSchemaBuilder().log()).upQueries.map(query => query.query)).toEqual([]);
      const repo = db.getRepository(PreviewSessionEntity);
      const row = repo.create({ id: 'a'.repeat(24), userId, phaseStateId, tokenVersion: 0, runnerId: null,
        capabilityHash: 'b'.repeat(64), status: 'stopped', cleanupPending: true,
        state: { bundleOk: false, message: null, stopReason: 'learner', startedAt: 1, readyAt: null, expiresAt: 2,
          lastSeenAt: 1, bytesServed: 0, forgetAt: 2, buildMs: 0, launchDeadline: 2 } });
      await repo.save(row);
      await expect(repo.save(repo.create({ ...row, id: 'c'.repeat(24) }))).rejects.toThrow();
      await expect(migration.down(runner)).rejects.toThrow('Drain previews');
      expect(await repo.count()).toBe(1);
      expect(await snapshot()).toEqual(retained);
      await repo.clear(); // exclusively this fixture's explicitly retained row
      await migration.down(runner);
      expect(await runner.hasTable('preview_sessions')).toBe(false);
      expect(await snapshot()).toEqual(retained);
    } finally { await runner.release(); }
  });
});

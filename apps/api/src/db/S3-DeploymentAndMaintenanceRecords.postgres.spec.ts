import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, type DrillState } from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SettingEntity, UserEntity } from './entities';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from '../migrations/runbook-records/runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../migrations/change-records/change-records';
import { TASKTRACKR_RUNBOOK_TEMPLATE } from '../migrations/runbook-records/tasktrackr-runbook-template';
import { TASKTRACKR_CHANGELOG_TEMPLATE } from '../migrations/change-records/tasktrackr-changelog-template';
import {
  dropScratchSchema,
  migrationFilesBefore,
  openScratchSchema,
  postgresOptions,
  scratchSchema,
} from '../../test/migration-history-fixture';
import { isolatedPostgresUrl } from '../../test/support/postgres';

/**
 * Migration 36, `S3-DeploymentAndMaintenanceRecords`, against a real
 * PostgreSQL server in a schema of its own: the 35 migrations before it run
 * on an empty schema, the rows it reads are written, and then it runs through
 * `runMigrations` as a deployment runs it. What only a real server can say:
 * the `simple-json` workspace, drill and snapshot columns read and write back
 * as the sqlite spec beside the conversions
 * (`runbook-records/runbook-records-migration.spec.ts`) says, both receipts
 * land in `settings`, it adds no table (no DDL), and the schema builder has
 * nothing pending afterwards. Self-skips without `POSTGRES_TEST_CONFIG`, as
 * every `.postgres.spec.ts` here does; the fixture needs `uuid-ossp` installed
 * on the server beforehand and will not install it.
 */
const url = isolatedPostgresUrl();
const describePg = url ? describe : describe.skip;
const PREFIX = 'rs_s3';
const S3_STAMP = '1790300000000';
const RUNBOOK = 'RUNBOOK.md';
const CHANGELOG = 'CHANGELOG.md';
const FILLED_RUNBOOK = TASKTRACKR_RUNBOOK_TEMPLATE.replace('## Health check', '- TASKTRACKR_DB: where the database lives\n\n## Health check');
const FILLED_CHANGELOG = TASKTRACKR_CHANGELOG_TEMPLATE.replace('## 2.1.0', '## 2.1.0\n\n### Added\n- Comments on a task.');
const INCIDENT = { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' };
/** The sqlite spec's resolved drill: the migration reads its incident and never writes the column. */
const DRILL: DrillState = {
  fault: 'api-url', pagedAt: '2026-10-02T09:00:00.000Z', runbookBefore: null, healthRanAt: '2026-10-02T09:10:00.000Z', healthExit: 0,
  fixAppliedAt: '2026-10-02T09:05:00.000Z', resolvedAt: '2026-10-02T09:12:00.000Z', incident: INCIDENT,
};

describePg('S3 Deployment and Maintenance records (PostgreSQL)', () => {
  let admin: DataSource;
  let db: DataSource;
  const schema = scratchSchema(PREFIX);
  const states: Record<string, string> = {};

  const compiled = (records: boolean) => ({
    content: {
      phases: [
        { key: 'deployment', checks: records ? { kind: 'config', runbook: { record: RUNBOOK_JSON } } : { kind: 'config' } },
        { key: 'maintenance', checks: records ? { kind: 'code', change: { record: CHANGE_REQUEST_JSON } } : { kind: 'code' } },
      ],
    },
  });
  const workspaceOf = async (key: string) =>
    (await db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] })).workspace as Record<string, string>;
  const tables = async () =>
    Number((await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [schema]))[0].n);

  beforeAll(async () => {
    Logger.overrideLogger(false);
    admin = await new DataSource({ type: 'postgres', url: url! }).initialize();
    await openScratchSchema(admin, schema);
    const before = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore(S3_STAMP), ALL_ENTITIES)).initialize();
    expect(await before.runMigrations({ transaction: 'all' })).toHaveLength(35);
    await before.destroy();
    db = await new DataSource(postgresOptions(url!, schema, migrationFilesBefore('9999999999999'), ALL_ENTITIES)).initialize();

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s3-pg.test', passwordHash: 'x', displayName: 'L' }));
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const version = async (semver: string, records: boolean) =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: tasktrackr.id, version: semver, status: 'published', manifest: {} as never, compiled: compiled(records) as never }))).id;
    const v400 = await version('4.0.0', false);
    const v500 = await version('5.0.0', true);
    let order = 0;
    const state = async (key: string, pin: string | null, phaseKey: 'deployment' | 'maintenance', workspace: Record<string, string>, drill: DrillState | null = null) => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: 'tasktrackr', projectVersionId: pin }));
      states[key] = (
        await db.manager.save(
          db.manager.create(PhaseStateEntity, {
            enrollmentId: enrolment.id, userId: user.id, phaseKey, phaseOrder: phaseKey === 'deployment' ? 5 : 6, workspace, drill, workspaceUpdatedAt: '2026-10-01T09:00:00.000Z',
          }),
        )
      ).id;
    };
    await state('pinned', v500, 'deployment', { [RUNBOOK]: FILLED_RUNBOOK, 'docker-compose.yml': 'kept' }, DRILL);
    await state('unpinned', null, 'maintenance', { [CHANGELOG]: FILLED_CHANGELOG });
    await state('older', v400, 'deployment', { [RUNBOOK]: 'my own runbook' });

    const tablesBefore = await tables();
    const applied = await db.runMigrations({ transaction: 'all' });
    // S8 (two nullable columns, agent_turns and agent_proposals) is pending beside S3 on this file.
    expect(applied.map((one) => one.name)).toEqual(['S3DeploymentAndMaintenanceRecords1790300000000', 'S8ProposalFeedback1793430000000']);
    expect(await tables()).toBe(tablesBefore);
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await dropScratchSchema(admin, schema, PREFIX);
      await admin.destroy();
    }
  });

  it('converts a learner on the record-grading version and a null pin, and leaves a learner on an older version for the re-pin', async () => {
    const pinned = await workspaceOf('pinned');
    expect(Object.keys(pinned).sort()).toEqual([RUNBOOK_JSON, 'docker-compose.yml']);
    expect(pinned['docker-compose.yml']).toBe('kept');
    expect(JSON.parse(pinned[RUNBOOK_JSON]).environment[0]).toMatchObject({ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'where the database lives' });
    // the drill column reads back as written: its incident is in the record, and the column itself is unchanged
    expect(JSON.parse(pinned[RUNBOOK_JSON]).incident).toEqual(INCIDENT);
    expect((await db.manager.findOneByOrFail(PhaseStateEntity, { id: states.pinned })).drill).toEqual(DRILL);
    const unpinned = await workspaceOf('unpinned');
    expect(Object.keys(unpinned)).toEqual([CHANGE_REQUEST_JSON]);
    expect(JSON.parse(unpinned[CHANGE_REQUEST_JSON]).release.changes).toEqual([{ id: 'L1', line: 'Added: Comments on a task.', covers: [] }]);
    expect(await workspaceOf('older')).toEqual({ [RUNBOOK]: 'my own runbook' });
  });

  it('writes both receipts to settings, and leaves the schema builder nothing to do', async () => {
    const runbook = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: RUNBOOK_MIGRATION_RECEIPT_KEY })).value);
    expect(runbook.counts).toMatchObject({ converted: 1, skipped: 1 });
    expect(runbook.incidentsCopied).toBe(1);
    expect(runbook.converted[0].stateId).toBe(states.pinned);
    expect(runbook.skipped).toEqual([{ stateId: states.older, reason: "this state's version does not grade the runbook document" }]);
    const change = JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key: CHANGE_MIGRATION_RECEIPT_KEY })).value);
    expect(change.counts).toMatchObject({ converted: 1, skipped: 0 });
    expect(change.converted[0].stateId).toBe(states.unpinned);
    expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual([]);
  });
});

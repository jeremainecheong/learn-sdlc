import 'reflect-metadata';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CHANGE_REQUEST_JSON, EMPTY_CHANGE_REQUEST, EMPTY_RUNBOOK, RUNBOOK_JSON, serialiseChangeRequest, serialiseRunbook,
  validateChangeRequestRecord, validateRunbookRecord, type DrillState,
} from '@learnsdlc/shared';
import { ALL_ENTITIES, EnrollmentEntity, PhaseStateEntity, SettingEntity, UserEntity } from '../../db/entities';
import { ProjectEntity, ProjectVersionEntity } from '../../content/project.entities';
import { S3DeploymentAndMaintenanceRecords1790300000000 } from '../1790300000000-S3-DeploymentAndMaintenanceRecords';
import { RUNBOOK_MIGRATION_RECEIPT_KEY } from './runbook-records';
import { CHANGE_MIGRATION_RECEIPT_KEY } from '../change-records/change-records';
import { TASKTRACKR_RUNBOOK_TEMPLATE as RT } from './tasktrackr-runbook-template';
import { TASKTRACKR_CHANGELOG_TEMPLATE as CT } from '../change-records/tasktrackr-changelog-template';

/**
 * Migration S3 on the local-first store, every migration applied. It converts
 * a Deployment or Maintenance workspace if and only if the learner's version
 * (the pin, or the project's published head for a null pin) grades that
 * phase's record, the set the boot re-pin's in-place pass also converts: a
 * learner still on a version that grades the older form is converted by the
 * re-pin, never here. One state per case: a full, a half-written,
 * a template-only and an overflowing RUNBOOK.md and CHANGELOG.md, the
 * no-RUNBOOK.md drill row, and a Deployment and a Maintenance on the older
 * version. A refused row is left exactly as it was, and each receipt names
 * every converted, refused and skipped state with its reason.
 */
const RB = 'RUNBOOK.md';
const CL = 'CHANGELOG.md';
const OLD_STAMP = '2026-10-01T09:00:00.000Z';
const byId = (list: { stateId: string; reason: string }[]) => Object.fromEntries(list.map((one) => [one.stateId, one.reason]));

const INCIDENT = { rootCause: 'API_URL named localhost', fix: 'http://api:8000', actionItem: 'Lint compose in CI' };
const DRILL: DrillState = {
  fault: 'api-url', pagedAt: '2026-10-02T09:00:00.000Z', runbookBefore: null, healthRanAt: '2026-10-02T09:10:00.000Z', healthExit: 0,
  fixAppliedAt: '2026-10-02T09:05:00.000Z', resolvedAt: '2026-10-02T09:12:00.000Z', incident: INCIDENT,
};
/** Every section filled: two variables, a health check, a rollback step, a data line and the incident's root cause. */
const FULL_RUNBOOK = RT
  .replace('## Health check', '- TASKTRACKR_DB: where the database lives\n- API_URL: where web finds the api\n\n## Health check')
  .replace('## Rollback', '- python3 api/main.py --selfcheck\n\n## Rollback')
  .replace('## Data', '- docker compose down, then up with the previous tag\n\n## Data')
  .replace('## Incident', '- The tasktrackr-data volume holds the database file\n\n## Incident')
  .replace('- Root cause:', '- Root cause: API_URL named localhost');
/** Two sections filled, the rest the template's. */
const HALF_RUNBOOK = RT
  .replace('## Health check', '- TASKTRACKR_DB: where the database lives\n\n## Health check')
  .replace('## Data', '- docker compose down, then up with the previous tag\n\n## Data');
const HUGE_RUNBOOK = RT.replace('## Deploying\n', `## Deploying\n\n${"Keep this line of the learner's.\n".repeat(80)}`);
/** Several entries: the newest is the release, a learner line under 2.0.0 and an older entry go to notes. */
const FULL_CHANGELOG = CT
  .replace('## 2.1.0', '## 2.1.0 Comments on tasks\n\n### Added\n- Comments on a task.\n- comment_count on every task.\n\n### Changed\n- GET /api/tasks carries comment_count.')
  .replace('### Notes\n', '### Notes\n- Seeded data is optional.\n')
  .concat('\n## 1.0.0\n\n- The first prototype.\n');
const HALF_CHANGELOG = CT.replace('## 2.1.0', '## 2.1.0\n\n- Comments on a task.');
const HUGE_CHANGELOG = CT.replace('# Changelog\n', `# Changelog\n\n${'A line the learner wrote above the entries.\n'.repeat(60)}`);

const STARTING_RUNBOOK = serialiseRunbook({
  ...EMPTY_RUNBOOK,
  environment: [{ id: 'E1', name: 'TASKTRACKR_DB', purpose: '', kind: 'config' }, { id: 'E2', name: 'API_URL', purpose: '', kind: 'config' }],
});
const STARTING_CHANGE = serialiseChangeRequest({ ...EMPTY_CHANGE_REQUEST, release: { ...EMPTY_CHANGE_REQUEST.release, version: '2.1.0' } });

describe('S3 Deployment and Maintenance records (sqlite)', () => {
  let db: DataSource;
  const states: Record<string, string> = {};

  /** 4.0.0 grades the older forms and mounts the two markdown files; 5.0.0 grades the records and mounts their starting records. */
  const compiled = (records: boolean) => ({
    content: {
      phases: [
        records
          ? { key: 'deployment', checks: { kind: 'config', runbook: { record: RUNBOOK_JSON } }, files: [{ path: RUNBOOK_JSON, content: STARTING_RUNBOOK, editable: true }] }
          : { key: 'deployment', checks: { kind: 'config' }, files: [{ path: RB, content: RT, editable: true }] },
        records
          ? { key: 'maintenance', checks: { kind: 'code', change: { record: CHANGE_REQUEST_JSON } }, files: [{ path: CHANGE_REQUEST_JSON, content: STARTING_CHANGE, editable: true }] }
          : { key: 'maintenance', checks: { kind: 'code' }, files: [{ path: CL, content: CT, editable: true }] },
      ],
    },
  });
  const rowOf = (key: string) => db.manager.findOneByOrFail(PhaseStateEntity, { id: states[key] });
  const workspaceOf = async (key: string) => (await rowOf(key)).workspace as Record<string, string>;
  const receiptOf = async (key: string) => JSON.parse((await db.manager.findOneByOrFail(SettingEntity, { key })).value);
  const runbookOf = async (key: string) => validateRunbookRecord((await workspaceOf(key))[RUNBOOK_JSON]).runbook!;
  const changeOf = async (key: string) => validateChangeRequestRecord((await workspaceOf(key))[CHANGE_REQUEST_JSON], null).change!;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      migrations: [path.join(__dirname, '..', '*.{ts,js}')],
      migrationsTableName: 'learnsdlc_migrations',
    }).initialize();
    const applied = await db.runMigrations({ transaction: 'all' });
    // S8 (the proposal feedback columns) is the newest migration; S3 is applied before it.
    expect(applied.map((one) => one.name)).toContain('S3DeploymentAndMaintenanceRecords1790300000000');
    expect(applied[applied.length - 1].name).toBe('S8ProposalFeedback1793430000000');

    const user = await db.manager.save(db.manager.create(UserEntity, { email: 'l@s3.test', passwordHash: 'x', displayName: 'L' }));
    const tasktrackr = await db.manager.save(db.manager.create(ProjectEntity, { slug: 'tasktrackr', title: 'TaskTrackr', platformOwned: true, origin: 'seed' }));
    const v = async (version: string, records: boolean) =>
      (await db.manager.save(db.manager.create(ProjectVersionEntity, { projectId: tasktrackr.id, version, status: 'published', manifest: {} as never, compiled: compiled(records) as never }))).id;
    const v400 = await v('4.0.0', false);
    const v500 = await v('5.0.0', true);

    let order = 0;
    const state = async (key: string, pin: string | null, phaseKey: 'deployment' | 'maintenance', workspace: Record<string, string>, drill: DrillState | null = null) => {
      const enrolment = await db.manager.save(db.manager.create(EnrollmentEntity, { userId: `${user.id}-${(order += 1)}`, projectSlug: 'tasktrackr', projectVersionId: pin }));
      const row = await db.manager.save(
        db.manager.create(PhaseStateEntity, {
          enrollmentId: enrolment.id, userId: user.id, phaseKey, phaseOrder: phaseKey === 'deployment' ? 5 : 6, workspace, drill, workspaceUpdatedAt: OLD_STAMP,
        }),
      );
      states[key] = row.id;
    };
    await state('dep-full', v500, 'deployment', { [RB]: FULL_RUNBOOK, 'docker-compose.yml': 'services: {}\n' }, DRILL);
    await state('dep-half', v500, 'deployment', { [RB]: HALF_RUNBOOK });
    await state('dep-template', v500, 'deployment', { [RB]: RT });
    await state('dep-overflow', v500, 'deployment', { [RB]: HUGE_RUNBOOK });
    await state('dep-drill-only', null, 'deployment', { 'docker-compose.yml': 'services: {}\n' }, DRILL);
    await state('mnt-full', v500, 'maintenance', { [CL]: FULL_CHANGELOG, 'api/repository/comments.py': 'x' });
    await state('mnt-half', null, 'maintenance', { [CL]: HALF_CHANGELOG });
    await state('mnt-template', v500, 'maintenance', { [CL]: CT });
    await state('mnt-overflow', v500, 'maintenance', { [CL]: HUGE_CHANGELOG });
    await state('dep-older', v400, 'deployment', { [RB]: FULL_RUNBOOK }, DRILL);
    await state('mnt-older', v400, 'maintenance', { [CL]: FULL_CHANGELOG });

    await new S3DeploymentAndMaintenanceRecords1790300000000().up(db.createQueryRunner());
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  it('converts a full RUNBOOK.md: every list filled, the drill\'s incident in the record, the learner\'s incident line in notes, the rest of the workspace kept', async () => {
    const row = await rowOf('dep-full');
    expect(Object.keys(row.workspace as Record<string, string>).sort()).toEqual([RUNBOOK_JSON, 'docker-compose.yml']);
    expect((row.workspace as Record<string, string>)['docker-compose.yml']).toBe('services: {}\n');
    const runbook = await runbookOf('dep-full');
    expect(runbook.environment).toEqual([
      { id: 'E1', name: 'TASKTRACKR_DB', purpose: 'where the database lives', kind: 'config' },
      { id: 'E2', name: 'API_URL', purpose: 'where web finds the api', kind: 'config' },
    ]);
    expect(runbook.health).toEqual([{ id: 'H1', name: '', how: 'python3 api/main.py --selfcheck', expected: '' }]);
    expect(runbook.rollback).toEqual([{ id: 'R1', step: 'docker compose down, then up with the previous tag', verify: '' }]);
    expect(runbook.data).toEqual([{ id: 'D1', what: 'The tasktrackr-data volume holds the database file', how: '', where: '' }]);
    expect(runbook.incident).toEqual(INCIDENT);
    expect(runbook.notes).toBe('Kept from RUNBOOK.md, Incident:\nRoot cause: API_URL named localhost');
    // the drill column is never touched; the stamp is fresh
    expect(row.drill).toEqual(DRILL);
    expect(Date.parse(row.workspaceUpdatedAt as string)).toBeGreaterThan(Date.parse(OLD_STAMP));
  });

  it('converts a half-written RUNBOOK.md, its empty sections empty', async () => {
    expect(Object.keys(await workspaceOf('dep-half'))).toEqual([RUNBOOK_JSON]);
    const runbook = await runbookOf('dep-half');
    expect(runbook.environment).toEqual([{ id: 'E1', name: 'TASKTRACKR_DB', purpose: 'where the database lives', kind: 'config' }]);
    expect(runbook.health).toEqual([]);
    expect(runbook.rollback).toEqual([{ id: 'R1', step: 'docker compose down, then up with the previous tag', verify: '' }]);
    expect(runbook.data).toEqual([]);
    expect(runbook.incident).toEqual({ rootCause: '', fix: '', actionItem: '' });
    expect(runbook.notes).toBeUndefined();
  });

  it('seeds the no-RUNBOOK.md row whose drill holds an incident with the head\'s starting record and the incident', async () => {
    const workspace = await workspaceOf('dep-drill-only');
    expect(Object.keys(workspace).sort()).toEqual([RUNBOOK_JSON, 'docker-compose.yml']);
    expect(await runbookOf('dep-drill-only')).toEqual({ ...validateRunbookRecord(STARTING_RUNBOOK).runbook, incident: INCIDENT });
  });

  it('converts a full CHANGELOG.md: the newest entry is the release, the older entries\' learner lines are in notes', async () => {
    expect(Object.keys(await workspaceOf('mnt-full')).sort()).toEqual(['api/repository/comments.py', CHANGE_REQUEST_JSON]);
    // the whole record: the starting record's impact, contract and tests as they were, the release and notes the file's
    expect(await changeOf('mnt-full')).toEqual({
      ...validateChangeRequestRecord(STARTING_CHANGE, null).change,
      release: {
        version: '2.1.0',
        summary: 'Comments on tasks',
        changes: [
          { id: 'L1', line: 'Added: Comments on a task.', covers: [] },
          { id: 'L2', line: 'Added: comment_count on every task.', covers: [] },
          { id: 'L3', line: 'Changed: GET /api/tasks carries comment_count.', covers: [] },
        ],
        rollback: '',
      },
      notes: 'Kept from CHANGELOG.md:\n2.0.0: Notes: Seeded data is optional.\n1.0.0: The first prototype.',
    });
  });

  it('converts a half-written CHANGELOG.md on a null pin that follows the head', async () => {
    expect(Object.keys(await workspaceOf('mnt-half'))).toEqual([CHANGE_REQUEST_JSON]);
    const change = await changeOf('mnt-half');
    expect(change).toEqual({
      ...validateChangeRequestRecord(STARTING_CHANGE, null).change,
      release: { version: '2.1.0', summary: '', changes: [{ id: 'L1', line: 'Comments on a task.', covers: [] }], rollback: '' },
    });
    expect(change.notes).toBeUndefined();
  });

  it('leaves the template-only, the overflowing and the older-version rows exactly as they were', async () => {
    expect(await workspaceOf('dep-template')).toEqual({ [RB]: RT });
    expect(await workspaceOf('dep-overflow')).toEqual({ [RB]: HUGE_RUNBOOK });
    expect(await workspaceOf('mnt-template')).toEqual({ [CL]: CT });
    expect(await workspaceOf('mnt-overflow')).toEqual({ [CL]: HUGE_CHANGELOG });
    expect(await workspaceOf('dep-older')).toEqual({ [RB]: FULL_RUNBOOK });
    expect(await workspaceOf('mnt-older')).toEqual({ [CL]: FULL_CHANGELOG });
    for (const key of ['dep-template', 'dep-overflow', 'mnt-template', 'mnt-overflow', 'dep-older', 'mnt-older']) expect((await rowOf(key)).workspaceUpdatedAt).toBe(OLD_STAMP);
    expect((await rowOf('dep-older')).drill).toEqual(DRILL);
  });

  it('writes the runbook receipt: one count per outcome, each converted, refused and skipped state by id with its reason', async () => {
    const receipt = await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY);
    expect(receipt.counts).toEqual({ 'kept-record': 0, converted: 2, seeded: 1, untouched: 1, refused: 1, skipped: 1 });
    expect(byId(receipt.converted)).toEqual({
      [states['dep-full']]: 'RUNBOOK.md moved into the record (environment 2, health 1, rollback 1, data 1, 1 group(s) in notes)',
      [states['dep-half']]: 'RUNBOOK.md moved into the record (environment 1, health 0, rollback 1, data 0)',
    });
    expect(receipt.refused).toEqual([{ stateId: states['dep-overflow'], reason: 'the words in RUNBOOK.md would not fit in the runbook record, so it was not changed' }]);
    expect(receipt.skipped).toEqual([{ stateId: states['dep-older'], reason: "this state's version does not grade the runbook document" }]);
    expect(receipt.notesKept).toBe(1);
    expect(receipt.incidentsCopied).toBe(2);
    expect(typeof receipt.at).toBe('string');
    // the first run is the harness's own runMigrations, on an empty store; this one converted
    expect(receipt.runs).toHaveLength(2);
    expect(receipt.runs[0].counts).toEqual({ 'kept-record': 0, converted: 0, seeded: 0, untouched: 0, refused: 0, skipped: 0 });
    expect(receipt.runs[1]).toEqual({ at: receipt.at, counts: receipt.counts });
    // counts and sentences only: no learner's word is in the receipt
    expect(JSON.stringify(receipt)).not.toMatch(/localhost|TASKTRACKR_DB|selfcheck/);
  });

  it('writes the change request receipt the same way, with no incidents', async () => {
    const receipt = await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY);
    expect(receipt.counts).toEqual({ 'kept-record': 0, converted: 2, seeded: 0, untouched: 1, refused: 1, skipped: 1 });
    expect(byId(receipt.converted)).toEqual({
      [states['mnt-full']]: 'CHANGELOG.md moved into the record (release lines 3, 1 group(s) in notes)',
      [states['mnt-half']]: 'CHANGELOG.md moved into the record (release lines 1)',
    });
    expect(receipt.refused).toEqual([{ stateId: states['mnt-overflow'], reason: 'the words in CHANGELOG.md would not fit in the change request record, so it was not changed' }]);
    expect(receipt.skipped).toEqual([{ stateId: states['mnt-older'], reason: "this state's version does not grade the change request document" }]);
    expect(receipt.notesKept).toBe(1);
    expect(receipt).not.toHaveProperty('incidentsCopied');
    expect(receipt.runs).toHaveLength(2);
    expect(JSON.stringify(receipt)).not.toMatch(/comment_count|prototype|Seeded/);
  });

  it('running it again converts nothing (the seeded row included), keeps each receipt\'s sections and the boot\'s, and adds the run', async () => {
    const keys = Object.keys(states);
    const before = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await workspaceOf(key)] as const)));
    const runbook = await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY);
    const change = await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY);
    const boot = { drafts: { at: 'then', converted: ['v1'], refused: [] }, repin: { runs: [{ at: 'then', conversions: 1 }] } };
    await db.manager.save(db.manager.create(SettingEntity, { key: RUNBOOK_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ ...runbook, ...boot }) }));
    await db.manager.save(db.manager.create(SettingEntity, { key: CHANGE_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ ...change, ...boot }) }));
    await new S3DeploymentAndMaintenanceRecords1790300000000().up(db.createQueryRunner());
    const after = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await workspaceOf(key)] as const)));
    expect(after).toEqual(before);
    for (const [key, first] of [[RUNBOOK_MIGRATION_RECEIPT_KEY, runbook], [CHANGE_MIGRATION_RECEIPT_KEY, change]] as const) {
      expect(await db.manager.countBy(SettingEntity, { key })).toBe(1);
      const { runs, ...sections } = await receiptOf(key);
      const { runs: firstRuns, ...firstSections } = first;
      // a run that converts nothing leaves the converting run's sections as they were, and only adds itself to runs
      expect(sections).toEqual({ ...firstSections, ...boot });
      expect(runs).toHaveLength(3);
      expect(runs.slice(0, 2)).toEqual(firstRuns);
    }
    expect((await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY)).runs[2].counts).toEqual({ 'kept-record': 0, converted: 0, seeded: 0, untouched: 4, refused: 1, skipped: 1 });
    expect((await receiptOf(CHANGE_MIGRATION_RECEIPT_KEY)).runs[2].counts).toEqual({ 'kept-record': 0, converted: 0, seeded: 0, untouched: 3, refused: 1, skipped: 1 });
  });

  it('a refusal fixed by hand leaves the list, and the runs are kept to the latest 50', async () => {
    await db.manager.update(PhaseStateEntity, { id: states['dep-overflow'] }, { workspace: { [RUNBOOK_JSON]: STARTING_RUNBOOK } as never });
    const receipt = await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY);
    const old = Array.from({ length: 60 }, (_, i) => ({ at: `old-${i}`, counts: {} }));
    await db.manager.save(db.manager.create(SettingEntity, { key: RUNBOOK_MIGRATION_RECEIPT_KEY, value: JSON.stringify({ ...receipt, runs: old }) }));
    await new S3DeploymentAndMaintenanceRecords1790300000000().up(db.createQueryRunner());
    const again = await receiptOf(RUNBOOK_MIGRATION_RECEIPT_KEY);
    expect(again.refused).toEqual([]);
    expect(again.runs).toHaveLength(50);
    expect(again.runs[0].at).toBe('old-11');
    expect(again.runs[49].counts).toEqual({ 'kept-record': 0, converted: 0, seeded: 0, untouched: 5, refused: 0, skipped: 1 });
  });
});

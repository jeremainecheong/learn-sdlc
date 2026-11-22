import { mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import { DataSource, QueryRunner } from 'typeorm';
import { H5SubmissionResetEpoch1789800000000 } from '../src/migrations/1789800000000-H5-SubmissionResetEpoch';
import { H9PinLegacyEnrolments1789800100000 } from '../src/migrations/1789800100000-H9-PinLegacyEnrolments';
import {
  DatabaseSnapshot,
  H1_STAMP,
  H5_STAMP,
  OPERATOR_VALUES,
  TASKTRACKR,
  dataChangedTables,
  migrationFilesBefore,
  pendingOfThisEra,
  schemaChangedTables,
  seedLegacy,
  seedPinnedProjects,
  snapshot,
} from './migration-history-fixture';

/**
 * The populated proof of H5 + H9, one body for both dialects.
 *
 * `open(migrations, entities)` returns an initialised DataSource over the SAME
 * database each time (a file on sqlite, a scratch schema on Postgres), holding
 * the given migration list, so the history can be cut where the host's was:
 * 27 → legacy rows → H1–H4 → boot-import rows → H5 + H9 in one transaction → down.
 */
export type Opener = (migrations: (string | Function)[], entities?: Function[]) => Promise<DataSource>;

export interface PopulatedProofResult {
  before: DatabaseSnapshot;
  after: DatabaseSnapshot;
  afterDown: DatabaseSnapshot;
  evidence: Record<string, unknown>;
}

/** Run `fn` on a runner of its own and always hand the connection back. */
async function using<T>(db: DataSource, fn: (q: QueryRunner) => Promise<T>): Promise<T> {
  const q = db.createQueryRunner();
  try {
    return await fn(q);
  } finally {
    await q.release();
  }
}

const H5_AND_H9 = [H5SubmissionResetEpoch1789800000000, H9PinLegacyEnrolments1789800100000];

export async function populatedProof(open: Opener, entities: Function[], dialect: string): Promise<PopulatedProofResult> {
  const base27 = migrationFilesBefore(H1_STAMP);
  const base31 = migrationFilesBefore(H5_STAMP);
  expect(base27).toHaveLength(27);
  expect(base31).toHaveLength(31);

  // Every DataSource this proof opens is closed on the way out, pass or fail:
  // a pool left open on a failure keeps the runner alive and hides the report.
  let db: DataSource | undefined;
  let q: QueryRunner | undefined;
  try {
    return await prove();
  } finally {
    if (q && !q.isReleased) await q.release();
    if (db?.isInitialized) await db.destroy();
  }

  async function prove(): Promise<PopulatedProofResult> {
    // 1–2. The 27 base migrations, then the legacy rows (no pin).
    db = await open(base27);
    await db.runMigrations({ transaction: 'all' });
    const legacyTables = (await using(db, snapshot)).tables.length;
    const legacy = await using(db, seedLegacy);
    await db.destroy();

    // 3–4. H1–H4, then the rows the boot import and teachers write.
    db = await open(base31);
    const ra = await db.runMigrations({ transaction: 'all' });
    expect(ra.map((m) => m.name)).toEqual([
      'H1ProjectModel1789600000000',
      'H2CohortAssignmentAndEnrolmentPin1789600100000',
      'H3TaskStates1789600200000',
      'H4QuizAttempts1789700000000',
    ]);
    const pinned = await using(db, (q) => seedPinnedProjects(q, legacy));
    await db.destroy();

    // 5. H5 + H9, pending together, in the one transaction they run in on deploy.
    db = await open([...base31, ...H5_AND_H9], entities);
    q = db.createQueryRunner();
    const before = await snapshot(q);
    const pendingBefore = pendingOfThisEra((await db.driver.createSchemaBuilder().log()).upQueries.map((u) => u.query));
    const applied = await db.runMigrations({ transaction: 'all' });
    expect(applied.map((m) => m.name)).toEqual([
      'H5SubmissionResetEpoch1789800000000',
      'H9PinLegacyEnrolments1789800100000',
    ]);
    const after = await snapshot(q);
    const pendingAfter = pendingOfThisEra((await db.driver.createSchemaBuilder().log()).upQueries.map((u) => u.query));

    // The table count holds at 32, and it is the same 32.
    expect(before.tables).toHaveLength(OPERATOR_VALUES.expectedTableCount);
    expect(after.tables).toEqual(before.tables);

    // Schema: only `submissions` moves, by exactly one nullable integer column
    // with no default, and every index on it (the in-flight guard included) is
    // byte-identical.
    expect(schemaChangedTables(before, after)).toEqual(['submissions']);
    const added = after.columns.submissions.filter((c) => !before.columns.submissions.includes(c));
    expect(added).toEqual(['resetEpoch|integer|YES|']);
    for (const table of before.tables) expect(after.indexes[table]).toEqual(before.indexes[table]);
    expect(Object.keys(before.indexes.submissions)).toContain('UQ_submissions_in_flight');

    // Data: only `enrollments` moves (and the ledger gains two rows). Every
    // existing submission reads NULL = "the current run".
    expect(dataChangedTables(before, after).sort()).toEqual(['enrollments', 'learnsdlc_migrations']);
    expect(after.rows.submissions.every((row) => row.resetEpoch === null)).toBe(true);
    for (const table of before.tables) {
      if (table !== 'learnsdlc_migrations') expect(after.counts[table]).toBe(before.counts[table]);
    }
    expect(after.counts.learnsdlc_migrations).toBe(before.counts.learnsdlc_migrations + 2);

    // The pins: exactly the three legacy TaskTrackr rows, to 2.0.1 by id.
    const pinOf = (s: DatabaseSnapshot, id: string) => s.rows.enrollments.find((row) => row.id === id)?.projectVersionId;
    const legacyIds = [legacy.completed.enrollment, legacy.midway.enrollment, legacy.fresh.enrollment];
    for (const id of legacyIds) {
      expect(pinOf(before, id)).toBeNull();
      expect(pinOf(after, id)).toBe(pinned.tasktrackr201);
    }
    expect(pinOf(after, pinned.pinnedTasktrackr)).toBe(pinned.tasktrackr201);
    expect(pinOf(after, pinned.pinnedTeacher)).toBe(pinned.teacher100);
    expect(pinOf(after, pinned.nullTeacher)).toBeNull();
    // Nothing but the pin moved on any enrolment; the completed project is still completed.
    const withoutPin = (s: DatabaseSnapshot) =>
      s.rows.enrollments.map(({ projectVersionId: _pin, ...rest }) => rest);
    expect(withoutPin(after)).toEqual(withoutPin(before));
    const completed = after.rows.enrollments.find((row) => row.id === legacy.completed.enrollment)!;
    expect([Boolean(completed.completed), completed.completedAt, completed.currentPhaseOrder]).toEqual([
      true,
      '2026-09-16T08:18:00.000Z',
      6,
    ]);

    // Schema-builder parity with the entity's declared column.
    expect(pendingBefore.some((sql) => sql.includes('resetEpoch'))).toBe(true);
    expect(pendingAfter).toEqual([]);

    // down(): H9 first (a documented no-op: the pins stay), then H5.
    await db.undoLastMigration({ transaction: 'all' });
    const afterH9Down = await snapshot(q);
    expect(afterH9Down.rows.enrollments).toEqual(after.rows.enrollments);
    await db.undoLastMigration({ transaction: 'all' });
    const afterDown = await snapshot(q);
    expect(afterDown.tables).toEqual(before.tables);
    expect(afterDown.columns).toEqual(before.columns);
    expect(afterDown.indexes).toEqual(before.indexes);
    expect(afterDown.counts).toEqual(before.counts);
    expect(afterDown.rows.submissions).toEqual(before.rows.submissions);
    expect(afterDown.rows.enrollments).toEqual(after.rows.enrollments);

    // Forward again: H5 re-adds the column, H9 finds nothing left to pin.
    const again = await db.runMigrations({ transaction: 'all' });
    expect(again).toHaveLength(2);
    const reapplied = await snapshot(q);
    expect(reapplied.rows.enrollments).toEqual(after.rows.enrollments);
    expect(reapplied.columns).toEqual(after.columns);
    await q.release();
    await db.destroy();

    const evidence = {
      proof: 'H5 and H9 migrations',
      dialect,
      migrations: {
        base: base31.length,
        applied: applied.map((m) => m.name),
        appliedInOneTransaction: true,
        afterH5AndH9: base31.length + H5_AND_H9.length,
      },
      tableCount: {
        legacyBase27: legacyTables,
        beforeH5AndH9: before.tables.length,
        afterUp: after.tables.length,
        afterDown: afterDown.tables.length,
      },
      schemaChangedTables: schemaChangedTables(before, after),
      dataChangedTables: dataChangedTables(before, after).filter((t) => t !== 'learnsdlc_migrations'),
      rowCounts: { before: before.counts, afterUp: after.counts, afterDown: afterDown.counts },
      enrolments: {
        total: after.counts.enrollments,
        pinnedByH9: legacyIds.length,
        pinnedTo: `${TASKTRACKR} 2.0.1 (explicit semver, published)`,
        nullPinOtherSlugLeft: after.rows.enrollments.filter((r) => r.projectVersionId === null).length,
        completedCourseStillCompleted: true,
      },
      submissions: {
        total: after.counts.submissions,
        resetEpochNull: after.rows.submissions.filter((r) => r.resetEpoch === null).length,
      },
      schemaBuilderPendingAfterH5: pendingAfter.length,
      downOrder: ['H9 (documented no-op; pins retained)', 'H5 (drops resetEpoch)'],
      operatorValues: OPERATOR_VALUES,
    };
    const dir = process.env.MIGRATION_EVIDENCE_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `populated-proof-${dialect}.json`), JSON.stringify(evidence, null, 2) + '\n', {
        mode: 0o600,
      });
    }
    return { before, after, afterDown, evidence };
  }
}

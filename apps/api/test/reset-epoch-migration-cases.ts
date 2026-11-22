import { randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import { H5SubmissionResetEpoch1789800000000 } from '../src/migrations/1789800000000-H5-SubmissionResetEpoch';
import { columnSignature, indexDefinitions, insertRow, pendingOfThisEra, tableRows } from './migration-history-fixture';

/**
 * H5 (`submissions.resetEpoch`), the narrow proof, for both dialects. The
 * database is at base (31 migrations) with rows in
 * `submissions`, including an in-flight one; the entity set declares the
 * column, so the schema builder wants it before H5 and wants nothing after.
 *
 * One case, in order, because each step's "before" is the previous step's
 * "after": up → rows and guard intact → the column behaves → down → up again.
 */
export function h5Case(database: () => DataSource, dialect: 'sqlite' | 'postgres'): void {
  const h5 = new H5SubmissionResetEpoch1789800000000();

  // The later schema migrations' tables are set aside by name (`LATER_SCHEMA_TABLES`).
  const pending = async (): Promise<string[]> =>
    pendingOfThisEra((await database().driver.createSchemaBuilder().log()).upQueries.map((u) => u.query));

  const recorded = async (runner: QueryRunner, fn: () => Promise<void>): Promise<string[]> => {
    const issued: string[] = [];
    const query = runner.query.bind(runner);
    const spy = jest.spyOn(runner, 'query').mockImplementation(((sql: string, parameters?: unknown[]) => {
      issued.push(sql);
      return query(sql, parameters);
    }) as never);
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return issued;
  };

  const submission = (phaseStateId: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    phaseStateId,
    userId: 'learner-1',
    status,
    taskKey: 'main',
    ...extra,
  });

  it('adds one nullable integer column with no default, touches nothing else, and reverses', async () => {
    const q = database().createQueryRunner();
    await q.connect();
    try {
      await insertRow(q, 'submissions', submission('ps-1', 'done', { passed: true, score: 90 }));
      await insertRow(q, 'submissions', submission('ps-1', 'done', { passed: false, score: 40 }));
      await insertRow(q, 'submissions', submission('ps-2', 'queued'));

      const columnsBefore = await columnSignature(q, 'submissions');
      const indexesBefore = await indexDefinitions(q, 'submissions');
      const rowsBefore = await tableRows(q, 'submissions');
      expect(Object.keys(indexesBefore)).toContain('UQ_submissions_in_flight');
      expect((await pending()).some((sql) => sql.includes('resetEpoch'))).toBe(true);

      // up: one ALTER on `submissions`, after `lock_timeout` on Postgres.
      const issued = await recorded(q, () => h5.up(q));
      expect(issued).toEqual([
        ...(dialect === 'postgres' ? [`SET lock_timeout = '3s'`] : []),
        `ALTER TABLE "submissions" ADD COLUMN "resetEpoch" integer`,
      ]);

      const columnsAfter = await columnSignature(q, 'submissions');
      expect(columnsAfter.slice(0, columnsBefore.length)).toEqual(columnsBefore);
      expect(columnsAfter.slice(columnsBefore.length)).toEqual(['resetEpoch|integer|YES|']);
      // sqlite added the column without a rebuild: the partial in-flight guard
      // keeps its WHERE, byte for byte, as does every other index.
      expect(await indexDefinitions(q, 'submissions')).toEqual(indexesBefore);
      expect(indexesBefore.UQ_submissions_in_flight).toMatch(/WHERE/);

      // Every pre-H5 row reads NULL ("the current run"); nothing else moved.
      const rowsAfter = await tableRows(q, 'submissions');
      expect(rowsAfter.map(({ resetEpoch, ...rest }) => [resetEpoch, rest])).toEqual(
        rowsBefore.map((row) => [null, row]),
      );
      expect(await pending()).toEqual([]);

      // A writer that does not know the column (an older API in a rollback window) gets
      // NULL; a writer that does stores its epoch.
      const legacyWriter = submission('ps-3', 'done');
      const newWriter = submission('ps-4', 'done', { resetEpoch: 2 });
      await insertRow(q, 'submissions', legacyWriter);
      await insertRow(q, 'submissions', newWriter);
      const read = Object.fromEntries(
        (await tableRows(q, 'submissions')).map((row) => [row.id as string, row.resetEpoch]),
      );
      expect([read[legacyWriter.id], read[newWriter.id]]).toEqual([null, 2]);

      // The guard still guards: a second in-flight revision of the same task is refused.
      await expect(insertRow(q, 'submissions', submission('ps-2', 'running'))).rejects.toThrow(/unique|UNIQUE/);

      // down: the column goes, every index stays, the builder wants it again.
      const downIssued = await recorded(q, () => h5.down(q));
      expect(downIssued).toEqual([
        ...(dialect === 'postgres' ? [`SET lock_timeout = '3s'`] : []),
        `ALTER TABLE "submissions" DROP COLUMN "resetEpoch"`,
      ]);
      expect(await columnSignature(q, 'submissions')).toEqual(columnsBefore);
      expect(await indexDefinitions(q, 'submissions')).toEqual(indexesBefore);
      expect((await pending()).some((sql) => sql.includes('resetEpoch'))).toBe(true);

      // And forward again, on the same populated table.
      await h5.up(q);
      expect(await columnSignature(q, 'submissions')).toEqual(columnsAfter);
      expect(await pending()).toEqual([]);
    } finally {
      await q.release();
    }
  });
}

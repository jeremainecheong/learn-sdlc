import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { SubmissionEntity } from '../db/entities';
import { newestSubmissionsPerPhaseState } from './queries';
import { newestSubmissionsPerTask } from './newest-per-task';
import { memoryDataSource } from '../../test/support/memory-db';

/**
 * The newest revision per `(phase state, task)`, decided in SQL.
 *
 * Two readers need it; the class map's rule tally, which has to ask the report
 * of the task that owns each rule, and the regrade, whose candidate is one
 * learner per task. Both read it and neither writes it, which is why it is a
 * module of its own and lands before either of them.
 *
 * The sibling `newestSubmissionsPerPhaseState` keeps its name, its query and
 * its three callers; on a board of sole-task phases the two answer the same
 * rows, which is the second test here.
 */
describe('newestSubmissionsPerTask', () => {
  let dataSource: DataSource;
  const manager = () => dataSource.manager;

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    // `submissions.taskKey` is added by migration H3 and declared on the
    // entity, so the schema sync has already made it and this adds nothing.
    // Where it is missing, this builds the post-migration shape itself, in the
    // one statement H3 issues for sqlite; a constant NOT NULL default, which
    // rewrites no row.
    const columns: { name: string }[] = await manager().query('PRAGMA table_info(submissions)');
    if (!columns.some((column) => column.name === 'taskKey')) {
      await manager().query('ALTER TABLE "submissions" ADD COLUMN "taskKey" varchar NOT NULL DEFAULT \'\'');
    }
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await manager().query('DELETE FROM "submissions"');
  });

  /** One revision, with the two columns this module groups by set by hand. */
  async function revision(fields: {
    phaseStateId: string;
    userId: string;
    taskKey: string;
    at: string;
  }): Promise<string> {
    const row = await manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: fields.phaseStateId,
        userId: fields.userId,
        status: 'completed',
        score: 80,
        passed: true,
      }),
    );
    // `createdAt` is a @CreateDateColumn, so the instant is written here rather
    // than handed to `save`: the order is the point of both tests.
    await manager().query('UPDATE "submissions" SET "taskKey" = ?, "createdAt" = ? WHERE "id" = ?', [
      fields.taskKey,
      fields.at,
      row.id,
    ]);
    return row.id;
  }

  it('one row per (phase state, task), newest first', async () => {
    const ids: Record<string, string> = {};
    for (const [at, taskKey, name] of [
      ['2026-09-01 09:00:00.000', 'story', 'story-1'],
      ['2026-09-01 10:00:00.000', 'story', 'story-2'],
      ['2026-09-01 11:00:00.000', 'story', 'story-3'],
      ['2026-09-01 09:30:00.000', 'scope', 'scope-1'],
      ['2026-09-01 10:30:00.000', 'scope', 'scope-2'],
      ['2026-09-01 11:30:00.000', 'scope', 'scope-3'],
    ] as const) {
      ids[name] = await revision({ phaseStateId: 'ps-1', userId: 'u-1', taskKey, at });
    }
    // A second phase state, so the grouping is over the pair and not over one
    // of its halves.
    ids['other'] = await revision({
      phaseStateId: 'ps-2',
      userId: 'u-1',
      taskKey: 'story',
      at: '2026-09-01 08:00:00.000',
    });

    const rows = await newestSubmissionsPerTask(manager(), ['ps-1', 'ps-2']);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [row.phaseStateId, row.taskKey, row.id])).toEqual([
      ['ps-1', 'scope', ids['scope-3']],
      ['ps-1', 'story', ids['story-3']],
      ['ps-2', 'story', ids['other']],
    ]);
    for (const row of rows) expect(row.userId).toBe('u-1');
  });

  it('grouping by (phaseStateId, taskKey) is grouping by phaseStateId on a sole-task board', async () => {
    // Every revision of a sole-task phase carries the empty key, which is
    // H3's default and the only key a sole-task submit writes. So the narrowed
    // grouping selects exactly the rows the phase-wide one selects, not
    // approximately, identically.
    await revision({ phaseStateId: 'ps-1', userId: 'u-1', taskKey: '', at: '2026-09-01 09:00:00.000' });
    const newest1 = await revision({
      phaseStateId: 'ps-1',
      userId: 'u-1',
      taskKey: '',
      at: '2026-09-01 12:00:00.000',
    });
    const newest2 = await revision({
      phaseStateId: 'ps-2',
      userId: 'u-2',
      taskKey: '',
      at: '2026-09-01 07:00:00.000',
    });

    const perTask = await newestSubmissionsPerTask(manager(), ['ps-1', 'ps-2']);
    const perPhase = await newestSubmissionsPerPhaseState(manager(), ['ps-1', 'ps-2']);
    // The sibling declares no order of its own, so it is read in this one's.
    const ordered = perPhase
      .slice()
      .sort((a, b) => a.phaseStateId.localeCompare(b.phaseStateId));

    expect(perTask).toHaveLength(ordered.length);
    expect(perTask.map((row) => row.taskKey)).toEqual(['', '']);
    expect(perTask.map((row) => [row.phaseStateId, row.userId, row.id])).toEqual(
      ordered.map((row) => [row.phaseStateId, row.userId, row.id]),
    );
    expect(perTask.map((row) => row.id)).toEqual([newest1, newest2]);
    // The instants come back in the driver's own shape on both sides, and it
    // is the same shape, so a caller normalising one normalises the other.
    expect(perTask.map((row) => String(row.createdAt))).toEqual(
      ordered.map((row) => String(row.createdAt)),
    );
  });

  it('asks the database nothing when there is nothing to ask', async () => {
    await expect(newestSubmissionsPerTask(manager(), [])).resolves.toEqual([]);
  });

  it('a tie in the second is broken by the greatest id, as every other reader breaks it', async () => {
    // sqlite stores `createdAt` to the second and two submissions inside one
    // second are ordinary. Picking differently here would show a console a
    // different attempt from the one the learner is looking at.
    const first = await revision({
      phaseStateId: 'ps-1',
      userId: 'u-1',
      taskKey: 'story',
      at: '2026-09-01 09:00:00.000',
    });
    const second = await revision({
      phaseStateId: 'ps-1',
      userId: 'u-1',
      taskKey: 'story',
      at: '2026-09-01 09:00:00.000',
    });
    const rows = await newestSubmissionsPerTask(manager(), ['ps-1']);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe([first, second].sort().at(-1));
  });
});

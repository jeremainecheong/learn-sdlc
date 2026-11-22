import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { memoryDataSource } from '../../test/support/memory-db';
import { ContentService } from '../content/content.service';
import { soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import { ALL_ENTITIES, PhaseStateEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { strictlyReviewed } from '../../test/strict-evidence-fixture';
import { taskHasStrictEvidence } from './strict-gate';

/**
 * The strict gate's evidence must be of the CURRENT run of an authored task.
 *
 * A teacher's `task-reopen`, then the learner's reset, then failing work, then
 * a teacher's phase-wide Pass writes the task row `passed` again with no new
 * revision behind it. Without an epoch conjunct the gate, and the solution
 * door, which asks the same predicate: would accept the discarded run's
 * strict pass. On a non-quiz authored task the candidates are the revisions
 * whose `resetEpoch` is NULL (the current run: every reset stamps a task's NULL
 * rows with the ending run's number) or equals the row's `resetCount`.
 */
describe('taskHasStrictEvidence reads the current run only', () => {
  let dataSource: DataSource;
  let content: ContentService;
  let task: CompiledTask;
  let sole: CompiledTask;
  const manager = () => dataSource.manager;
  const USER = 'learner-epoch';

  beforeAll(async () => {
    dataSource = await memoryDataSource();
    content = new ContentService();
    content.loadAll();
    sole = soleTaskFor(content.getPhase('tasktrackr', 'implementation'));
    // An authored, non-quiz task of a teacher's list: the sole task's rubric
    // and checks under a key of its own.
    task = { ...sole, taskKey: 'a', title: 'Task A' };
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  let target: PhaseStateEntity;
  beforeEach(async () => {
    for (const entity of ALL_ENTITIES) await manager().clear(entity);
    target = await manager().save(
      manager().create(PhaseStateEntity, {
        enrollmentId: 'enrolment-epoch',
        userId: USER,
        phaseKey: 'implementation',
        phaseOrder: 3,
        status: 'passed',
        attempts: 1,
      }),
    );
  });

  /** The task row as a teacher's Pass leaves it after `resetCount` resets. */
  const row = (resetCount: number) =>
    manager().save(
      manager().create(TaskStateEntity, {
        phaseStateId: target.id,
        userId: USER,
        taskKey: task.taskKey,
        status: 'passed',
        resetCount,
      }),
    );

  /** A strictly reviewed pass of `taskKey`, carrying `resetEpoch`. */
  const strictPass = (resetEpoch: number | null, taskKey = task.taskKey) =>
    manager().save(
      manager().create(SubmissionEntity, {
        phaseStateId: target.id,
        userId: USER,
        taskKey,
        status: 'completed',
        passed: true,
        score: 90,
        workspaceSnapshot: {},
        contextSnapshot: { links: [], ranBeforeSubmit: true, drill: null },
        report: strictlyReviewed(task.rubric),
        resetEpoch,
      } as Partial<SubmissionEntity>),
    );

  const ask = (t: CompiledTask = task, isSole = false) =>
    taskHasStrictEvidence(manager(), { id: target.id }, t, isSole, USER);

  it('(a) a pre-reset strict pass does not satisfy a teacher Pass after the reset', async () => {
    await row(1);
    await strictPass(0);
    await expect(ask()).resolves.toBe(false);
  });

  it('a post-reset strict pass does', async () => {
    await row(1);
    await strictPass(0);
    await strictPass(1);
    await expect(ask()).resolves.toBe(true);
  });

  it('(b) a NULL-epoch strict pass with no reset still counts (guard)', async () => {
    await row(0);
    await strictPass(null);
    await expect(ask()).resolves.toBe(true);
  });

  it('NULL reads as the current run whatever the count (the reset stamps first)', async () => {
    await row(2);
    await strictPass(null);
    await expect(ask()).resolves.toBe(true);
  });

  it('a sole-task (TaskTrackr) phase is untouched: no row, NULL epoch, the pass counts (guard)', async () => {
    await strictPass(null, sole.taskKey);
    await expect(ask(sole, true)).resolves.toBe(true);
  });
});

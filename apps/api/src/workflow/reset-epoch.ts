import { IsNull, type EntityManager } from 'typeorm';
import { SubmissionEntity, type TaskStateEntity } from '../db/entities';

/**
 * Close the run a reset is about to end.
 *
 * `submissions.resetEpoch` is NULL for "the current run" (migration H5). Every
 * revision written before H5, including every revision of a task a teacher
 * reset before then: carries NULL whichever run it belonged to, so without this a
 * NULL strict pass from a run that has ended would still count after the next
 * reset (the strict gate, the solution door and `verdictIsOfAnotherRun` all
 * read NULL as current).
 *
 * So every reset that moves a non-quiz, non-sole task row from k to k+1 calls
 * this FIRST, on the reset's own transaction and under its enrolment lock:
 *
 *   UPDATE submissions SET "resetEpoch" = k
 *    WHERE "phaseStateId" = ? AND "taskKey" = ? AND "userId" = ? AND "resetEpoch" IS NULL
 *
 * It uses no clock, and it is exact because every reset is already refused
 * while the task is being marked (nothing of the ending run can land NULL
 * after it). No submission is deleted and no other column moves. A quiz keeps
 * its paper rule and a sole task (TaskTrackr) has no row, so neither caller
 * reaches here for them.
 *
 * Returns how many revisions were stamped.
 */
export async function stampEndingRun(
  manager: EntityManager,
  row: Pick<TaskStateEntity, 'phaseStateId' | 'taskKey' | 'userId' | 'resetCount'>,
): Promise<number> {
  const result = await manager.update(
    SubmissionEntity,
    {
      phaseStateId: row.phaseStateId,
      taskKey: row.taskKey,
      userId: row.userId,
      resetEpoch: IsNull(),
    },
    { resetEpoch: row.resetCount },
  );
  return result.affected ?? 0;
}

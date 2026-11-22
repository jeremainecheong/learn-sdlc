import type { EntityManager } from 'typeorm';
import { rowLock } from './atomic';
import { EnrollmentEntity } from './entities';

/**
 * The enrolment row every writer of a learner's phase and task roll-up locks
 * before it writes, so two writers for one learner (a grading job, an
 * advance, a reset, a teacher's override or sign-off) take turns rather than
 * each computing a roll-up from rows the other is changing. Every writer must
 * take this same lock on this same row, which is why it is written once.
 */
export interface EnrollmentKey {
  id: string;
  userId: string;
}

/**
 * Reads the learner's enrolment and, on PostgreSQL, holds its write lock for
 * the rest of the transaction. Fails when the row is not the learner's. For a
 * writer that needs the row back, or that must fail on sqlite too when the
 * enrolment is gone.
 */
export function heldEnrollment(manager: EntityManager, key: EnrollmentKey): Promise<EnrollmentEntity> {
  return manager.findOneOrFail(EnrollmentEntity, {
    where: { id: key.id, userId: key.userId },
    ...rowLock(manager),
  });
}

/**
 * Takes the enrolment's write lock on PostgreSQL and does nothing on sqlite,
 * where `atomic` already makes writers serial.
 */
export async function lockEnrollment(manager: EntityManager, key: EnrollmentKey): Promise<void> {
  if (manager.connection.options.type !== 'postgres') return;
  await heldEnrollment(manager, key);
}

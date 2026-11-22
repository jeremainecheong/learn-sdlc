import { BadRequestException } from '@nestjs/common';
import { IsNull, type EntityManager } from 'typeorm';
import type { AcceptedScreenCopy } from '@learnsdlc/shared';
import type { ContentService } from '../content/content.service';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH, screenCopyFromSnapshot, validScreenCopy } from '../content/screen-copy';
import { EnrollmentEntity, PhaseStateEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { isQuizTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { strictTaskEvidencePassed } from '../feedback/strict-evidence';
import { isReferenceTaskAnchor } from '../assistant/project-scope';

/** A draft, imported verdict without evidence, or a newer pass cannot become historical authority. */
export async function acceptedDesignScreenCopy(
  manager: EntityManager, content: ContentService, enrollment: EnrollmentEntity, before?: Date,
): Promise<AcceptedScreenCopy | null> {
  const design = await manager.findOneBy(PhaseStateEntity, { enrollmentId: enrollment.id, userId: enrollment.userId, phaseKey: 'design' });
  if (!design) return null;
  // The Design phase the retained evidence
  // is judged against is the one this enrolment is pinned to, because that is
  // the rubric the pass was given under, and `getTasksForEnrollment` answers
  // from the very same resolution, so the phase and its tasks are one
  // version's.
  //
  // The owner is looked up on SCREEN_CONTRACT_PATH, the
  // editable file the design phase declares and `screenCopyFromSnapshot`
  // parses, never on SCREEN_COPY_PATH, which is the read-only overlay the
  // *later* phases mount and which no task's `owns` can contain, because `owns`
  // is built from `editablePathsOf`.
  //
  // **A `filter`, and never a `find`.** The compiler deliberately allows
  // two tasks sharing an owned path, and `design` is a `markdown` phase whose
  // `screens.json` is editable, so two tasks really can claim it, and `find`
  // would silently take the lower-order one. What that copy becomes is not a
  // report field: `requireAcceptedDesignScreenCopy` freezes it at design →
  // implementation advance and `withScreenCopy` injects it read-only into four
  // later phases, where it is graded. The compile rule
  // `screen-contract-belongs-to-one-task` refuses a version with two owners at
  // publish; the throw below asserts what that rule guarantees and is
  // unreachable on a published version.
  const tasks = content.getTasksForEnrollment(enrollment, 'design');
  const owners = tasks.filter(task => task.owns.includes(SCREEN_CONTRACT_PATH));
  if (owners.length === 0) return null; // this design phase declares no screen contract
  if (owners.length > 1) throw new Error(`the Design phase's tasks "${owners[0].taskKey}" and "${owners[1].taskKey}" both own "${SCREEN_CONTRACT_PATH}" — the accepted screen copy is read from one task's passing submission and carried into four later phases, so exactly one task may own it.`);
  const owner = owners[0];
  const base = { phaseStateId: design.id, userId: enrollment.userId, taskKey: owner.taskKey, status: 'completed' as const, passed: true };
  // The copy is the CURRENT run's, read with the strict gate's own conjunct
  // (strict-gate.ts): a revision whose `resetEpoch` is NULL (the current run;
  // every reset first stamps the ending run's NULL rows) or equals the owner
  // row's `resetCount`. Without it a reset owner task whose new strict pass
  // holds no overdue row would fall through to a pass of the run the reset
  // discarded, and that copy would be frozen into four graded phases.
  //
  // On the advance path (no `before`) always. On the historical cutoff read
  // (`resolveScreenCopy`, `before` = Implementation's unlock) only when the
  // owner's last reset came before that cutoff: then the run current at the
  // cutoff is the row's current run, so the lazy read answers exactly what
  // the advance answered (an advance that mounted the baseline is not undone
  // by the first read re-deriving a discarded run's copy). A reset after the
  // cutoff, or none recorded, keeps the historical reading unchanged. A sole
  // task (TaskTrackr) or a quiz owner issues no new read.
  let current: TaskStateEntity | null = null;
  if (!soleTaskList(tasks) && !isQuizTask(owner)) {
    const row = await manager.findOne(TaskStateEntity, { where: { phaseStateId: design.id, taskKey: owner.taskKey } });
    const resetAt = row?.resetAt ? Date.parse(row.resetAt) : NaN;
    if (row && (!before || (Number.isFinite(resetAt) && resetAt <= before.getTime()))) current = row;
  }
  const candidates = await manager.find(SubmissionEntity, {
    where: current ? [{ ...base, resetEpoch: IsNull() }, { ...base, resetEpoch: current.resetCount }] : base,
    order: { createdAt: 'DESC', id: 'DESC' },
  });
  for (const submission of candidates) {
    if (before && new Date(submission.createdAt).getTime() > before.getTime()) continue;
    const report = submission.report;
    if (!submission.workspaceSnapshot || !submission.contextSnapshot || report?.assessmentMode !== 'strict_binary' || report.passed !== true) continue;
    try {
      if (!strictTaskEvidencePassed(owner, report, report.aiReview)) continue;
    } catch { continue; } // Malformed persisted evidence is never an accepted source.
    const copy = screenCopyFromSnapshot(submission.workspaceSnapshot, submission.id, design.id);
    if (copy) return copy;
  }
  return null;
}

/**
 * Call inside the advancement transaction. The accepted source is retained, never the latest draft.
 *
 * Only the throw is keyed. `acceptedDesignScreenCopy` above does not look at
 * the anchor, so a learner whose owner's passing submission holds a
 * copy carries it whoever wrote the task. With no copy, the advance is refused
 * only when the phase's single owner is the reference's own task **by its
 * anchor alone** (`isReferenceTaskAnchor`): TaskTrackr, and a copy whose
 * Design task nobody edited, keep the refusal. Any other owner, or none,
 * answers null and the pack's baseline copy mounts: the
 * one way a teacher can rewrite or remove the Design task without leaving
 * their learners unable to leave Design.
 */
export async function requireAcceptedDesignScreenCopy(
  manager: EntityManager, content: ContentService, enrollment: EnrollmentEntity,
): Promise<AcceptedScreenCopy | null> {
  const copy = await acceptedDesignScreenCopy(manager, content, enrollment);
  if (copy) return copy;
  // The same pinned task list `acceptedDesignScreenCopy` read (memo keys
  // are object identity, so the anchor sees the objects the rest of the
  // resolution saw), and the phase they are that version's tasks of.
  const owners = content.getTasksForEnrollment(enrollment, 'design').filter(task => task.owns.includes(SCREEN_CONTRACT_PATH));
  if (owners.length === 1 && isReferenceTaskAnchor(content.getPhaseForEnrollment(enrollment, 'design'), owners[0])) {
    throw new BadRequestException('The passing Design submission must retain an overdue screen title and empty-state sentence. Save and resubmit the screen contract before advancing.');
  }
  return null;
}

/**
 * Existing unlocked work is pinned once using the initial Implementation unlock
 * as the historical cutoff. A missing cutoff/source retains the explicit pack
 * baseline; it must never borrow a later Design revision and rewrite history.
 */
export async function resolveScreenCopy(
  manager: EntityManager, content: ContentService, enrollment: EnrollmentEntity, state: PhaseStateEntity,
  // Whether this call may retain what it resolved. Every learner action on
  // their own room may; a read made on their behalf by somebody else may not,
  // because both writes below carry the learner's own `userId` and
  // `ViewAsService`'s six reads are documented as read-only. The answer is the
  // same answer either way, only the retaining is skipped, and the learner's
  // own next read retains it. See `WorkflowService.loadOwnedState`.
  pin = true,
): Promise<AcceptedScreenCopy | null> {
  // Whether this room carries the accepted
  // copy at all is a property of the version the learner holds.
  if (!content.getPhaseForEnrollment(enrollment, state.phaseKey).files.some(file => file.path === SCREEN_COPY_PATH)) return null;
  if (state.acceptedScreenCopy != null) {
    if (!validScreenCopy(state.acceptedScreenCopy)) throw new Error('The retained Design screen copy is invalid.');
    return state.acceptedScreenCopy;
  }
  if (state.status === 'locked') return null;
  const implementation = state.phaseKey === 'implementation' ? state : await manager.findOneBy(PhaseStateEntity, {
    enrollmentId: enrollment.id, userId: enrollment.userId, phaseKey: 'implementation',
  });
  let copy = implementation?.acceptedScreenCopy ?? null;
  if (copy && !validScreenCopy(copy)) throw new Error('The retained Design screen copy is invalid.');
  if (!copy) {
    const cutoff = implementation?.unlockedAt;
    if (!cutoff || !Number.isFinite(Date.parse(cutoff))) return null;
    copy = await acceptedDesignScreenCopy(manager, content, enrollment, new Date(cutoff));
  }
  if (!copy) return null;
  // The resolved copy, retained by nobody: the cutoff this was derived from is
  // `implementation.unlockedAt`, which a read cannot move, so recomputing it on
  // the learner's own next read answers the same thing and retains it then.
  if (!pin) return copy;
  // Pin the earliest runtime phase as well, so every later phase shares one
  // source even when the first request after an upgrade opens Maintenance.
  if (implementation && implementation.id !== state.id) {
    await manager.update(PhaseStateEntity, { id: implementation.id, userId: state.userId, acceptedScreenCopy: IsNull() }, { acceptedScreenCopy: copy });
    const held = await manager.findOneByOrFail(PhaseStateEntity, { id: implementation.id, userId: state.userId });
    copy = held.acceptedScreenCopy;
    if (!validScreenCopy(copy)) throw new Error('The retained Design screen copy is invalid.');
  }
  await manager.update(PhaseStateEntity, { id: state.id, userId: state.userId, acceptedScreenCopy: IsNull() }, { acceptedScreenCopy: copy });
  const held = await manager.findOneByOrFail(PhaseStateEntity, { id: state.id, userId: state.userId });
  if (!validScreenCopy(held.acceptedScreenCopy)) throw new Error('The retained Design screen copy is invalid.');
  state.acceptedScreenCopy = held.acceptedScreenCopy;
  state.updatedAt = held.updatedAt;
  return held.acceptedScreenCopy;
}

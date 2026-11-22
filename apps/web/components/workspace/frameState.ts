import type { PhaseDetail } from '@learnsdlc/shared';
import { learnerState, type LearnerState } from './gate-state';
import { awaitingSignOff } from './signoff-status';
import { chooseTask } from './TaskPanel';

/** What `frameState` reads of a phase: the frame's own `phase` prop. */
export type FramePhase = Pick<PhaseDetail, 'id' | 'key' | 'title'> & Partial<Pick<PhaseDetail, 'status' | 'tasks' | 'lastSubmission' | 'evidenceNeeded' | 'notReachedYet'>>;

/**
 * Where a phase stands, in the workspace header's words: the same
 * reading the workspace makes when it opens with no task asked for, from the
 * detail the page holds (its task list and its newest revision), and "Review
 * passed" where Continue is open, as the workspace header says it. Nothing
 * where the page holds no status.
 */
export function frameState(phase: FramePhase): LearnerState | null {
 if (!phase.status) return null;
 const task = chooseTask(phase.tasks, null);
 const last = phase.lastSubmission ?? null;
 const verdict = last && (!last.taskKey || !task || last.taskKey === task.key) ? last : null;
 const state = learnerState(phase.id, { status: phase.status, key: phase.key, evidenceNeeded: phase.evidenceNeeded, notReachedYet: phase.notReachedYet }, { awaiting: awaitingSignOff(phase, task?.key, last), verdict, task });
 return state === 'ready' ? 'reviewPassed' : state;
}


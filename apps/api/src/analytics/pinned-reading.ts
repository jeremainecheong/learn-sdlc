import {
  checklistPercentOf,
  masteryPercentOf,
  overallChecklistPercent,
  type ChecklistCounts,
} from '@learnsdlc/shared';
import type { ContentService } from '../content/content.service';
import type { ProjectContent } from '../content/content.types';
import { isQuizTask, type CompiledTask } from '../content/pack-compiler';
import type { EnrollmentEntity, PhaseStateEntity, TaskStateEntity } from '../db/entities';
import { NO_PHASE_ROW, taskCountsOf, taskViews } from '../workflow/task-view';

/**
 * Both percentages (checklist and mastery) for one scope; a single phase, or
 * a whole pinned version.
 *
 * `masteryPercent` is `null` and never `0` where there is no quiz or none has
 * been attempted, which is the gradebook's own rule about a blank: the two are
 * different facts and a tile that drew `0%` would report a failure nobody had.
 */
export interface Percentages {
  checklistPercent: number;
  masteryPercent: number | null;
}

/**
 * The two percentages for one enrolment, read off the **pinned version's**
 * tasks.
 *
 * `byState` is keyed by `phase_states.id` and holds an entry only for a version
 * phase this board actually has a row for; a row whose key the pinned version
 * no longer declares gets no entry, because the checklist is the version's list
 * and that phase is not on it.
 *
 * `overall` is taken over **every phase the version declares**, held row or not.
 * That is the whole difference from `progressPercent`, which is passed phases
 * over the rows the enrolment holds: the two denominators are different
 * questions that usually have the same answer, and where they part it is this
 * one that is right.
 */
export interface PinnedReading {
  byState: Map<string, Percentages>;
  overall: Percentages;
}

/**
 * The two percentages for one enrolment, over its **pinned** version's tasks.
 *
 * No query of its own: the task list is resolved in
 * memory through `getTasksForEnrollment`, exactly as `workflow.pinnedTasks`
 * resolves it for the board, and the rows arrive from the single
 * `taskStatesByPhaseState` read the caller has already made for everyone.
 *
 * **Null where the version cannot be read**: a database can carry an
 * enrolment on a pack the catalogue no longer ships, or on a snapshot this
 * build declines to grade, and neither may 404 a console or blank a
 * dashboard. The analytics service's `phaseAnalytics` degrades to the row's
 * own key for the same reason. An
 * unreadable version has no checklist to be a percentage of, so the fields are
 * **absent** rather than `0`; the same distinction `masteryPercent` makes
 * between a blank and a zero, for the same reason.
 *
 * The counting itself is `taskViews` + `taskCountsOf`, the pair the learner's
 * own board is drawn from, rather than a second reading of the rows here.
 * That is what makes the checklist percentage equal the progress percentage
 * on a board of sole-task phases: a sole task's status is the
 * **phase row's** and an authored task's is its own row's, and a file that
 * counted only rows would report six untouched tasks over a finished
 * TaskTrackr project.
 */
export function pinnedReading(
  content: ContentService,
  enrollment: EnrollmentEntity,
  states: PhaseStateEntity[],
  taskRows: ReadonlyMap<string, TaskStateEntity[]>,
): PinnedReading | null {
  let project: ProjectContent;
  try {
    project = content.getForEnrollment(enrollment);
  } catch {
    return null;
  }
  const rowFor = new Map(states.map((state) => [state.phaseKey, state]));
  const byState = new Map<string, Percentages>();
  const counts: ChecklistCounts[] = [];
  const quizScores: (number | null)[] = [];
  for (const phase of project.phases) {
    let tasks: CompiledTask[];
    try {
      tasks = content.getTasksForEnrollment(enrollment, phase.key);
    } catch {
      // A snapshot whose task list and whose phase list disagree about what
      // the version holds. It declares no task here, so it declares nothing
      // required here, and the phase drops out of both sums.
      continue;
    }
    const state = rowFor.get(phase.key);
    const views = taskViews({
      phase,
      tasks,
      state: state ?? NO_PHASE_ROW,
      rows: state ? taskRows.get(state.id) ?? [] : [],
      // Nothing below reads a brief, an objective list, a path or a rubric,
      // and a class of fifty would carry six of each per learner.
      view: 'summary',
    });
    const phaseCounts = taskCountsOf(views);
    // `taskViews` maps the task list one for one and in order, so the view at
    // a task's index is that task's. Pairing by key instead would be wrong for
    // a sole task, whose key is the empty string.
    const phaseScores = tasks.flatMap((task, at) =>
      isQuizTask(task) ? [views[at].bestScore] : [],
    );
    counts.push(phaseCounts);
    quizScores.push(...phaseScores);
    if (state) {
      byState.set(state.id, {
        checklistPercent: checklistPercentOf(phaseCounts),
        masteryPercent: masteryPercentOf(phaseScores),
      });
    }
  }
  return {
    byState,
    overall: {
      checklistPercent: overallChecklistPercent(counts),
      masteryPercent: masteryPercentOf(quizScores),
    },
  };
}

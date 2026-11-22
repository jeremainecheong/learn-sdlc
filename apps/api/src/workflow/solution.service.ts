import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import type { PhaseStatus, SolutionFileView, SolutionView } from '@learnsdlc/shared';
import { SOLUTION_LOCKED_MESSAGE } from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import type { CompiledTask } from '../content/pack-compiler';
import { soleTaskList } from '../content/task-units';
import { PhaseStateEntity, SubmissionEntity, TaskStateEntity } from '../db/entities';
import { InjectRepository } from '../db/inject';
import { recordAudit } from '../audit/audit';
import { referenceFiles } from './solution.reference';
import { taskHasStrictEvidence } from './strict-gate';
import { taskForRequest } from '../feedback/task-resolution';
import { WorkflowService } from './workflow.service';

/**
 * The three columns the door reads, whichever row carries them.
 *
 * A sole task's state **is** the phase state, so the sole arm below reads
 * `phase_states`. An authored task has its own row, and a row that has never
 * been written is a task that has not passed: the same direction a doubt
 * falls everywhere else in the task grain.
 */
interface SolutionGate {
  status: PhaseStatus;
  passedAt: string | null;
  readAt: string | null;
  bestScore: number | null;
}

/**
 * The reference solution, after the gate.
 *
 * A phase that has passed has nothing left to protect: the score is recorded,
 * the hidden suite has run, and the one thing a learner still wants is the
 * answer the suite was written against, beside what they actually merged. So
 * the pack's own files come back with the learner's own copy of each path, and
 * the browser diffs the two with the very function the pull request draws its
 * diff with.
 *
 * Three rules make this safe to ship without an instructor switch:
 *
 * 1. **The gate is the only key.** `passedAt` and `status === 'passed'` both,
 *    because an override that marks a phase passed sets the status while
 *    `passedAt` is the honest stamp, and either being absent is a closed door.
 *    And the strict gate's own evidence too:
 *    `taskHasStrictEvidence`, the predicate `advance` asks, because a
 *    teacher's Pass or Sign off writes both columns with no reviewed revision
 *    behind them, and the answer must not open before the review it answers.
 * 2. **Nothing is offered before it opens.** The phase detail carries
 *    `solution.available` so the rooms can draw a door, and the door only
 *    exists on a passed phase. There is no greyed control: a visible locked
 *    door is an invitation to look for the key.
 * 3. **The first reading is on the record.** One stamp on the row the gate was
 *    read from, one `solution.read` audit row, both written once. A reload is
 *    the same reading, and a table with a row per page view is a table nobody
 *    reads.
 *
 * Three of the six phases have no answer to show, and say so rather than
 * pretending: requirements and design are the learner's own writing, and
 * deployment ships no model configuration.
 *
 * **The door is the task's.** All three rules above are asked of one task: its gate, its stamp, its
 * numbers, its own newest merged revision, and the refusal for a sibling a
 * learner has not passed is `SOLUTION_LOCKED_MESSAGE`, because the fact it
 * states is the same: *this* work has not passed.
 *
 * **What a written task's open door contains is nothing.**
 * `referenceFiles` answers `{ available: false, reason: 'prose' }` for
 * `markdown` whatever the gate said, and only written phases are split into
 * several tasks. The gate, the route, the stamp and the view are per task all
 * the same, so the *files* follow for any kind that has them.
 */
@Injectable()
export class SolutionService {
  private readonly logger = new Logger(SolutionService.name);

  constructor(
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(SubmissionEntity) private readonly submissions: Repository<SubmissionEntity>,
    private readonly workflow: WorkflowService,
    private readonly content: ContentService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The task rows, from the one DataSource this service already holds.
   *
   * A getter rather than a sixth constructor argument, for the reason
   * `WorkflowService.taskStates` gives: this service is built by hand in
   * several specs, and a required parameter would have made this step an edit
   * to every one of them. `getRepository` is cached per manager, so this is a
   * map read and every caller gets one object.
   */
  private get taskStates(): Repository<TaskStateEntity> {
    return this.dataSource.getRepository(TaskStateEntity);
  }

  /**
   * The pack's answer to one task of one phase, with the learner's merged
   * files beside it.
   *
   * Refuses in `loadOwnedState`'s own words for a phase that is not the
   * caller's or is locked, in one sentence of its own for a task whose gate is
   * not in, with `unknown task` for a key the pinned version does not declare,
   * and (on the kept phase-level route) by naming the tasks rather than
   * picking one.
   *
   * `taskKey` is **optional and never defaulted to `SOLE_TASK_KEY`**: see
   * `taskForRequest`. Undefined means *the phase's only task*, which on a
   * teacher-authored phase is the one keyed `main`; a string means that task.
   */
  async read(userId: string, phaseStateId: string, taskKey?: string): Promise<SolutionView> {
    const { state, phase, enrollment } = await this.workflow.loadOwnedState(userId, phaseStateId);
    const tasks = this.content.getTasksForEnrollment(enrollment, state.phaseKey);
    const task = taskForRequest(tasks, taskKey);
    const sole = soleTaskList(tasks);
    const gate = await this.gateFor(state, tasks, task);
    if (gate.passedAt === null || gate.status !== 'passed') {
      throw new ForbiddenException(SOLUTION_LOCKED_MESSAGE);
    }
    // The board is not the whole key. A teacher's Pass or
    // Sign off writes it `passed` with no revision behind it, and the strict
    // gate still wants the learner's own reviewed pass, so an answer opened
    // here on the board alone could be read, submitted, and turned into the
    // very pass the gate was waiting for. The door opens on the gate's own
    // evidence, asked by the gate's own predicate, and on nothing less.
    if (!(await taskHasStrictEvidence(this.dataSource.manager, state, task, sole, userId))) {
      throw new ForbiddenException(SOLUTION_LOCKED_MESSAGE);
    }

    const answer = referenceFiles(phase, task);
    const files: SolutionFileView[] = [];
    if (answer.available) {
      const mine = await this.mergedFiles(state, task);
      const languages = new Map(
        this.content.workspaceFiles(phase, state.workspace).map((f) => [f.path, f.language]),
      );
      for (const [path, theirs] of answer.files) {
        files.push({
          path,
          theirs,
          yours: mine[path] ?? null,
          language: languages.get(path) ?? 'text',
        });
      }
    }

    // The stamp and the row, once, and only where there was something to read.
    // `update()` and not `save()`: a whole-row save from this path would post
    // this request's stale copy of `workspace` over an autosave that landed
    // while it was in flight, and reading an answer is not a reason to
    // touch a learner's files at all. The same rule holds for the task row:
    // `attempts` and `bestScore` are written in SQL beside it.
    if (answer.available && !gate.readAt) {
      const at = new Date().toISOString();
      if (sole) {
        await this.phaseStates.update(state.id, { solutionReadAt: at });
        state.solutionReadAt = at;
      } else {
        await this.taskStates.update(
          { phaseStateId: state.id, taskKey: task.taskKey },
          { solutionReadAt: at },
        );
      }
      gate.readAt = at;
      await recordAudit(this.dataSource.manager, {
        event: 'solution.read',
        actorUserId: userId,
        subjectUserId: userId,
        targetId: state.id,
        // Still the phase key: the audit's `action` is where a reader looks
        // for *which room*, and the task is one field further in.
        action: state.phaseKey,
        reason: null,
        detail: {
          phaseKey: state.phaseKey,
          phaseTitle: phase.title,
          taskKey: task.taskKey,
          files: files.length,
        },
      });
      this.logger.log(
        `solution.read user=${userId} phase=${state.phaseKey} task=${task.taskKey} files=${files.length}`,
      );
    }

    return {
      phaseStateId: state.id,
      phaseKey: state.phaseKey,
      phaseTitle: phase.title,
      taskKey: task.taskKey,
      taskTitle: task.title,
      available: answer.available,
      unavailableReason: answer.reason,
      files,
      // All three read the row the gate was read from. Left as the
      // phase's, a passed task on a phase that has not yet opened would answer
      // `passedAt: null` and the phase's score beside an open door, a view
      // contradicting the gate that just let the reader through. For a sole
      // task the row **is** the phase state, field for field.
      bestScore: gate.bestScore,
      passedAt: gate.passedAt,
      readAt: gate.readAt,
      // Facts about the phase, and the view says so.
      packVersion: enrollment.packVersion ?? null,
    };
  }

  /** The two columns that open the door, and the two the view reports. */
  private async gateFor(
    state: PhaseStateEntity,
    tasks: readonly CompiledTask[],
    task: CompiledTask,
  ): Promise<SolutionGate> {
    if (soleTaskList(tasks)) {
      return {
        status: state.status,
        passedAt: state.passedAt,
        readAt: state.solutionReadAt ?? null,
        bestScore: state.bestScore ?? null,
      };
    }
    const row = await this.taskStates.findOne({
      where: { phaseStateId: state.id, taskKey: task.taskKey },
    });
    // A required key with no row is a failing key (the standing inversion this
    // block is built on) and so is an optional one: nobody has passed work
    // there is no record of.
    if (!row) return { status: 'in_progress', passedAt: null, readAt: null, bestScore: null };
    return {
      status: row.status,
      passedAt: row.passedAt,
      readAt: row.solutionReadAt,
      bestScore: row.bestScore,
    };
  }

  /**
   * The learner's own files as **this task** was merged.
   *
   * The revision the task was merged on is the newest submission of that task
   * that passed, and retention keeps every one of those, so its
   * `workspaceSnapshot` is normally the durable copy. When it is not: an old
   * enrolment whose snapshot was nulled before that rule existed: the current
   * workspace is the honest second best, and when neither has the path the view
   * says the copy is gone rather than pretending the learner wrote nothing.
   *
   * The `taskKey` narrow is the identical query on a sole-task phase: the
   * compiled sole task's own key is `''`, which is what every revision of such
   * a phase carries.
   */
  private async mergedFiles(
    state: PhaseStateEntity,
    task: CompiledTask,
  ): Promise<Record<string, string>> {
    const merged = await this.submissions.findOne({
      where: { phaseStateId: state.id, taskKey: task.taskKey, passed: true },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return merged?.workspaceSnapshot ?? state.workspace ?? {};
  }
}

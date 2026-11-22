import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, EntityTarget, In, MoreThanOrEqual, ObjectLiteral, Repository } from 'typeorm';
import type {
  ClassMapNode,
  ClassMapPhase,
  ClassMapView,
  ClassQueueItem,
  InstructorLearnerRow,
  InstructorOverview,
  LearnerAnalytics,
  LecturePoint,
  PhaseAnalytics,
  PhaseKey,
} from '@learnsdlc/shared';
import { AssistantService } from '../assistant/assistant.service';
import { usageDayStart } from '../assistant/guardrails';
import { ContentService } from '../content/content.service';
import { ProjectContent } from '../content/content.types';
import {
  AssistantMessageEntity,
  EnrollmentEntity,
  ExecutionRunEntity,
  PhaseStateEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { InjectRepository } from '../db/inject';
import { difficultyTier, RELIANCE_FLAG_THRESHOLD, relianceIndex } from '../feedback/checkers';
import { InstructorCaller, cohortNamesById, learnerScope } from '../instructor/cohort-scope';
import {
  NodeSpec,
  ProbeReport,
  buildNodeSpecs,
  nodeStatus,
  ownedRuleReport,
  ruleOwners,
} from './class-map';
import { newestSubmissionsPerTask } from './newest-per-task';
import { pinnedReading, type Percentages, type PinnedReading } from './pinned-reading';
import { phasesToCount, statesOnBoard } from '../workflow/states-on-board';
import { DAY_MS, isoOrNull } from '../db/timestamps';
import {
  hintsByPhaseState,
  newestSubmissionsPerPhaseState,
  taskStatesByPhaseState,
} from './queries';
import { IDLE_DAYS, STUCK_ATTEMPTS, integrityReasons } from './signals';

const QUEUE_LIMIT = 50;
const LECTURE_POINTS = 3;

/**
 * MAX(createdAt) leaves the driver's hands as a Date on Postgres and as a UTC
 * datetime string on sqlite. Read as local time, the sqlite form drifts by the
 * server's offset, which is enough to move a learner in and out of the idle
 * window; the T and the Z put it back where it was written.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string' || !value) return null;
  const text = /^\d{4}-\d{2}-\d{2} /.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * The middle score, or the mean of the middle two. Null when nobody has one:
 * an empty phase reads as a blank, never as a zero.
 */
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/** The project most of these enrolments are on, ignoring any the catalogue lost. */
function commonestSlug(enrollments: EnrollmentEntity[], known: string[]): string | null {
  const counts = new Map<string, number>();
  for (const enrollment of enrollments) {
    if (!known.includes(enrollment.projectSlug)) continue;
    counts.set(enrollment.projectSlug, (counts.get(enrollment.projectSlug) ?? 0) + 1);
  }
  let best: string | null = null;
  let top = 0;
  for (const [slug, count] of counts) {
    if (count > top || (count === top && best !== null && slug < best)) {
      best = slug;
      top = count;
    }
  }
  return best;
}

/**
 * The artefacts most of the class has wrong; what a lecture can fix in one
 * pass. Sorted by how many learners are red, never by how bad the score is:
 * one learner failing badly is a conversation, twelve failing the same check
 * is a slide.
 */
function lecturePoints(phases: ClassMapPhase[]): LecturePoint[] {
  return phases
    .flatMap((phase) => phase.nodes)
    .filter((node) => node.red > 0)
    .sort((a, b) => b.red - a.red || a.id.localeCompare(b.id))
    .slice(0, LECTURE_POINTS)
    .map((node) => ({
      title: node.label,
      // The count is already the bold half of the line the console prints, so
      // the sentence after it says what is still standing rather than saying
      // the same number twice.
      detail: `${node.green} of ${node.red + node.green + node.missing} have it green${
        node.missing > 0 ? `, and ${node.missing} have not reached it yet` : ''
      }.`,
      phaseKey: node.phase,
      count: node.red,
    }));
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/**
 * Progress and AI-usage analytics: per-phase progress, rubric scores and the
 * AI-reliance index, for learners and for the instructor console.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(EnrollmentEntity) private readonly enrollments: Repository<EnrollmentEntity>,
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(AssistantMessageEntity)
    private readonly messages: Repository<AssistantMessageEntity>,
    private readonly content: ContentService,
    private readonly assistant: AssistantService,
  ) {}

  /**
   * An enrolment's states as its board draws them, and how many phases its
   * "n of m" and its progress count: the pinned version's
   * (`statesOnBoard`, `phasesToCount`), as the learner's board and the
   * teacher's views read them. A version this build cannot read leaves the
   * states as stored and counts them, as `phaseAnalytics` keeps such a row on
   * the console rather than 404 the class.
   */
  private boardOf(enrollment: EnrollmentEntity, states: PhaseStateEntity[]): { states: PhaseStateEntity[]; total: number } {
    let project: ProjectContent;
    try {
      project = this.content.getForEnrollment(enrollment);
    } catch {
      return { states, total: states.length };
    }
    const held = statesOnBoard(enrollment, project, states);
    return { states: held, total: phasesToCount(enrollment, project, held) };
  }

  private phaseAnalytics(
    states: PhaseStateEntity[],
    projectSlug: string,
    hints: Map<string, number>,
    /** `pinnedReading().byState`, or null where there is none. */
    percentages: ReadonlyMap<string, Percentages> | null = null,
  ): PhaseAnalytics[] {
    // A database can hold an enrolment on a pack the catalogue no longer
    // ships (a 2.0.0 upgrade over a 1.0.0 database resets enrolments rather
    // than migrating them) and one stale row must not 404 the
    // whole class the moment an instructor opens the console. The phase's own
    // row still carries its key, its order, its status and its scores; only
    // the pack's title is lost, and the key stands in for it exactly as it
    // does for a phase the pack renamed. `commonestSlug` ignores the same
    // enrolments on the learner's side of this file.
    const project = this.content.listProjects().some((p) => p.slug === projectSlug)
      ? this.content.getProject(projectSlug)
      : null;
    return states.map((state) => {
      const phase = project?.phases.find((p) => p.key === state.phaseKey);
      const phaseHints = hints.get(state.id) ?? 0;
      return {
        key: state.phaseKey,
        order: state.phaseOrder,
        title: phase?.title ?? state.phaseKey,
        status: state.status,
        bestScore: state.bestScore,
        attempts: state.attempts,
        hints: phaseHints,
        relianceIndex: relianceIndex(phaseHints, state.attempts),
        // Absent, not zero, where the version could not be read: see
        // `pinnedReading`. Spread last so the two fields are appended to the
        // shape rather than woven into it.
        ...(percentages?.get(state.id) ?? {}),
      };
    });
  }

  /**
   * A learner's analytics for one project.
   *
   * The slug is not optional by accident. `findOne({ where: { userId } })` is
   * unambiguous only while a learner can be enrolled in exactly one project;
   * with project selection, it returns whichever row the database yields first
   * and the dashboard silently shows another project's scores. Callers must
   * say which.
   */
  async forLearner(userId: string, projectSlug?: string): Promise<LearnerAnalytics> {
    const enrollment = projectSlug
      ? await this.enrollments.findOne({ where: { userId, projectSlug } })
      : // No slug given: the oldest enrolment, chosen explicitly rather than
        // left to the database's row order.
        await this.enrollments.findOne({ where: { userId }, order: { startedAt: 'ASC' } });
    let phases: PhaseAnalytics[] = [];
    let reading: PinnedReading | null = null;
    let total = 0;
    if (enrollment) {
      const board = this.boardOf(
        enrollment,
        await this.phaseStates.find({
          where: { enrollmentId: enrollment.id },
          order: { phaseOrder: 'ASC' },
        }),
      );
      const states = board.states;
      total = board.total;
      const hints = await hintsByPhaseState(this.messages.manager, states.map((s) => s.id));
      const taskRows = await taskStatesByPhaseState(
        this.phaseStates.manager,
        states.map((s) => s.id),
      );
      reading = pinnedReading(this.content, enrollment, states, taskRows);
      phases = this.phaseAnalytics(states, enrollment.projectSlug, hints, reading?.byState ?? null);
    }
    const passed = phases.filter((p) => p.status === 'passed').length;
    const scored = phases.filter((p) => p.bestScore !== null);
    const averageScore = scored.length
      ? Math.round(scored.reduce((s, p) => s + (p.bestScore || 0), 0) / scored.length)
      : null;
    const passedPhases = phases.filter((p) => p.status === 'passed');
    const overallReliance = passedPhases.length
      ? Math.round(passedPhases.reduce((s, p) => s + p.relianceIndex, 0) / passedPhases.length)
      : 0;
    return {
      projectSlug: enrollment?.projectSlug ?? projectSlug ?? '',
      progressPercent: total ? Math.round((passed / total) * 100) : 0,
      phasesPassed: passed,
      totalPhases: total,
      averageScore,
      totalHints: phases.reduce((s, p) => s + p.hints, 0),
      tokensToday: await this.assistant.tokensToday(userId),
      difficultyTier: difficultyTier(averageScore, overallReliance, passed),
      relianceIndex: overallReliance,
      // The pinned version's checklist and this learner's
      // quiz mastery. `progressPercent` and `averageScore` above are unchanged
      // and gain no summand; a required quiz already moved the phase's score
      // once, through the roll-up's mean over the required keys.
      ...(reading ? reading.overall : {}),
      phases,
    };
  }

  /**
   * Scoped to the caller's classes (cohort-scope.ts).
   *
   * Without that scope, any instructor on a public deployment could read the
   * name, email address and progress of every learner at every institution
   * using the platform. An admin still sees everyone, which is the point of
   * the role.
   *
   * A fixed number of queries whatever the class size (the scope, learners,
   * enrolments, phase states, hints, today's tokens, and the task rows) then
   * everything is joined in memory. The earlier shape asked the database about
   * each learner in turn, and a class of forty cost several hundred round trips
   * per page load.
   *
   * The two quiz-era percentages cost exactly one of those reads
   * (`taskStatesByPhaseState`, keyed on every phase state in the class at once)
   * and the pinned task list each row's percentages are counted over is
   * resolved in memory, costing none. The suite records the number, so a per
   * learner read added here is a red spec rather than a slow console.
   */
  async instructorOverview(requesterId: string, projectSlug?: string): Promise<InstructorOverview> {
    const requester = await this.users.findOne({ where: { id: requesterId } });
    if (!requester) throw new NotFoundException('account not found');
    // An unknown slug is a 404, not an empty class that looks like nobody started.
    if (projectSlug) this.content.getProject(projectSlug);

    const learners = await this.users.find({
      where: await learnerScope(this.users.manager, requester),
    });
    const learnerIds = learners.map((l) => l.id);
    const enrollments = learnerIds.length
      ? await this.enrollments.find({
          where: { userId: In(learnerIds), ...(projectSlug ? { projectSlug } : {}) },
          order: { startedAt: 'ASC' },
        })
      : [];
    const states = enrollments.length
      ? await this.phaseStates.find({
          where: { enrollmentId: In(enrollments.map((e) => e.id)) },
          order: { phaseOrder: 'ASC' },
        })
      : [];
    const hints = await hintsByPhaseState(this.messages.manager, states.map((s) => s.id));
    // The one read the two percentages cost, for the whole class at once.
    const taskRows = await taskStatesByPhaseState(
      this.phaseStates.manager,
      states.map((s) => s.id),
    );
    const tokensToday = await this.tokensTodayByUser(learnerIds);
    const cohortNames = await cohortNamesById(this.users.manager, learners.map((l) => l.cohort));

    const statesByEnrollment = groupBy(states, (s) => s.enrollmentId);
    const enrollmentsByUser = groupBy(enrollments, (e) => e.userId);

    const rows: InstructorLearnerRow[] = [];
    for (const learner of learners) {
      const tokens = tokensToday.get(learner.id) ?? 0;
      const cohortName = cohortNames.get(learner.cohort) ?? null;
      const mine = enrollmentsByUser.get(learner.id) ?? [];
      // Someone who joined the class and never started still belongs on the
      // roll call; otherwise a fresh class reads as "no learners yet".
      if (mine.length === 0) {
        rows.push(this.learnerRow(learner, cohortName, null, [], tokens, null));
        continue;
      }
      for (const enrollment of mine) {
        const board = this.boardOf(enrollment, statesByEnrollment.get(enrollment.id) ?? []);
        const reading = pinnedReading(this.content, enrollment, board.states, taskRows);
        const phases = this.phaseAnalytics(
          board.states,
          enrollment.projectSlug,
          hints,
          reading?.byState ?? null,
        );
        rows.push(this.learnerRow(learner, cohortName, enrollment, phases, tokens, reading, board.total));
      }
    }
    rows.sort(
      (a, b) =>
        b.progressPercent - a.progressPercent ||
        a.displayName.localeCompare(b.displayName) ||
        (a.projectSlug ?? '').localeCompare(b.projectSlug ?? ''),
    );
    return {
      learners: rows,
      cohortSize: learners.length,
      averageProgress: rows.length
        ? Math.round(rows.reduce((s, r) => s + r.progressPercent, 0) / rows.length)
        : 0,
      averageReliance: rows.length
        ? Math.round(rows.reduce((s, r) => s + r.relianceIndex, 0) / rows.length)
        : 0,
      aiProvider: await this.assistant.recentProviderName(),
    };
  }

  /* ------------------------------ class map ------------------------------ */

  /**
   * One project, one class, drawn as the artefacts rather than the people:
   * how many learners are green, red or not there yet on every gate the
   * content pack sets, who needs a look, and the three artefacts worth
   * spending the next lecture on.
   *
   * A fixed number of queries whatever the class size, like the overview: the
   * scope, learners, enrolments, phase states, hints, two passes over
   * submissions and two activity roll-ups, then everything is joined here.
   */
  async classMap(caller: InstructorCaller, projectSlug?: string): Promise<ClassMapView> {
    // An unknown slug is a 404 before any of the work: an empty map reads as a
    // class that never started rather than as a typo.
    const named = projectSlug ? this.content.getProject(projectSlug) : null;
    const manager = this.users.manager;

    const learners = await this.users.find({ where: await learnerScope(manager, caller) });
    const found = learners.length
      ? await this.enrollments.find({
          where: {
            userId: In(learners.map((l) => l.id)),
            ...(named ? { projectSlug: named.slug } : {}),
          },
          order: { startedAt: 'ASC' },
        })
      : [];
    // Naming no project means the one the class is actually on, not whichever
    // the catalogue happens to list first.
    const project =
      named ??
      this.content.getProject(
        commonestSlug(found, this.content.listProjects().map((p) => p.slug)) ??
          this.content.listProjects()[0].slug,
      );
    const enrollments = named ? found : found.filter((e) => e.projectSlug === project.slug);
    // One enrolment per learner on the map; the oldest wins if a retry ever
    // left a second one behind, so the counts cannot double-count anybody.
    const enrollmentByUser = new Map<string, EnrollmentEntity>();
    for (const enrollment of enrollments) {
      if (!enrollmentByUser.has(enrollment.userId)) enrollmentByUser.set(enrollment.userId, enrollment);
    }
    const roll = learners.filter((learner) => enrollmentByUser.has(learner.id));
    const enrollmentIds = [...enrollmentByUser.values()].map((e) => e.id);

    const states = enrollmentIds.length
      ? await this.phaseStates.find({
          where: { enrollmentId: In(enrollmentIds) },
          order: { phaseOrder: 'ASC' },
        })
      : [];
    const hints = await hintsByPhaseState(manager, states.map((s) => s.id));
    const { byPhaseState: latest, lastByUser } = await this.latestSubmissions(
      manager,
      states.map((s) => s.id),
    );
    const lastActivity = await this.lastActivityByUser(manager, roll.map((l) => l.id), lastByUser);
    // The newest revision **per task**, for
    // the phase states that hold more than one task's rows. Everything else on
    // this map still reads one revision per phase state.
    const ruleReports = await this.ruleReportsPerState(manager, states.map((s) => s.id));

    const specs = buildNodeSpecs(project);
    const specsByPhase = groupBy(specs, (spec) => spec.phase);
    const tally = new Map<string, { green: number; red: number; missing: number }>(
      specs.map((spec) => [spec.id, { green: 0, red: 0, missing: 0 }]),
    );
    const stateByUserPhase = new Map<string, PhaseStateEntity>(
      states.map((state) => [`${state.userId}:${state.phaseKey}`, state]),
    );
    // The rule→owner index is per pinned version and per phase, never per
    // learner: a class is on a handful of versions and every learner on one of
    // them asks the same question.
    const owners = new Map<string, ReadonlyMap<string, string>>();
    for (const learner of roll) {
      const enrollment = enrollmentByUser.get(learner.id);
      for (const phase of project.phases) {
        const state = stateByUserPhase.get(`${learner.id}:${phase.key}`);
        const report = (state && latest.get(state.id)?.report) || null;
        // On a phase state carrying more
        // than one task's rows, a rule node is tallied from the report of the
        // task that owns the rule. Read against the phase's newest revision
        // every sibling-owned rule would tally `missing` for every learner, and
        // `lecturePoints` is computed from that tally.
        const perTask = state && enrollment ? ruleReports.get(state.id) : undefined;
        const owned = perTask
          ? ownedRuleReport(this.ruleOwnersFor(owners, enrollment!, phase), perTask)
          : null;
        for (const spec of specsByPhase.get(phase.key) ?? []) {
          // The `function`, `mutant` and `drill` probes are unreachable on a
          // written phase, so they keep reading the phase's newest revision;
          // they need the same per-task merge if those kinds ever become
          // allowed on a written phase.
          const seen: ProbeReport | null = spec.probe.kind === 'rules' && owned ? owned : report;
          tally.get(spec.id)![nodeStatus(spec, seen)] += 1;
        }
      }
    }

    const statesByPhase = groupBy(states, (state) => state.phaseKey);
    const phases: ClassMapPhase[] = project.phases.map((phase) =>
      this.classMapPhase(phase, statesByPhase.get(phase.key) ?? [], hints, latest, specsByPhase, tally),
    );

    return {
      projectSlug: project.slug,
      totalLearners: roll.length,
      phases,
      queue: this.classQueue(
        project,
        roll,
        enrollmentByUser,
        groupBy(states, (state) => state.userId),
        latest,
        lastActivity,
      ),
      lecturePoints: lecturePoints(phases),
    };
  }

  private classMapPhase(
    phase: ProjectContent['phases'][number],
    rows: PhaseStateEntity[],
    hints: Map<string, number>,
    latest: Map<string, SubmissionEntity>,
    specsByPhase: Map<string, NodeSpec[]>,
    tally: Map<string, { green: number; red: number; missing: number }>,
  ): ClassMapPhase {
    const counts = { locked: 0, in_progress: 0, submitted: 0, passed: 0 };
    let scoreTotal = 0;
    let scored = 0;
    let attempts = 0;
    let asked = 0;
    let flagged = 0;
    // Kept for the median: a class of twenty with one abandoned attempt has a
    // mean the console would have to apologise for, and the middle learner is
    // the one an instructor is actually asking about.
    const scores: number[] = [];
    for (const state of rows) {
      counts[state.status] += 1;
      if (state.bestScore !== null) {
        scoreTotal += state.bestScore;
        scored += 1;
        // The median is the console's headline number and it is read as "what
        // a learner who got through this gate scored", so only passed rows go
        // in: a phase nobody has passed prints nothing rather than the middle
        // of a column of failures.
        if (state.status === 'passed') scores.push(state.bestScore);
      }
      attempts += state.attempts;
      asked += hints.get(state.id) ?? 0;
      if (integrityReasons(latest.get(state.id)?.report).length) flagged += 1;
    }
    const nodes: ClassMapNode[] = (specsByPhase.get(phase.key) ?? []).map((spec) => ({
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      phase: spec.phase,
      ...tally.get(spec.id)!,
    }));
    return {
      key: phase.key,
      order: phase.order,
      title: phase.title,
      counts,
      averageScore: scored ? Math.round(scoreTotal / scored) : null,
      medianScore: median(scores),
      averageAttempts: rows.length ? round1(attempts / rows.length) : 0,
      averageHints: rows.length ? round1(asked / rows.length) : 0,
      flagged,
      nodes,
    };
  }

  /**
   * Who needs a look, one row per learner: the most urgent signal wins, so
   * the queue stays a list of people to talk to rather than a second copy of
   * the map. Integrity first, then a learner stuck at a gate, then a
   * submission made without a run, then a class member who has gone quiet.
   */
  private classQueue(
    project: ProjectContent,
    roll: UserEntity[],
    enrollmentByUser: Map<string, EnrollmentEntity>,
    statesByUser: Map<string, PhaseStateEntity[]>,
    latest: Map<string, SubmissionEntity>,
    lastActivity: Map<string, Date>,
  ): ClassQueueItem[] {
    const now = Date.now();
    const thresholds = new Map<PhaseKey, number>(
      project.phases.map((phase) => [phase.key, phase.rubric.passThreshold]),
    );
    // Which phases the pack can actually run. A
    // markdown artefact has no Run button at all, so `ranBeforeSubmit` is
    // false for everybody on it and the signal below would be the whole class.
    const runnable = new Map<PhaseKey, boolean>(
      project.phases.map((phase) => [phase.key, phase.canRun]),
    );
    const ranked: { priority: number; order: number; item: ClassQueueItem }[] = [];

    for (const learner of roll) {
      const states = [...(statesByUser.get(learner.id) ?? [])].sort(
        (a, b) => a.phaseOrder - b.phaseOrder,
      );
      let best: { priority: number; order: number; item: ClassQueueItem } | null = null;
      const consider = (
        priority: number,
        state: PhaseStateEntity,
        reason: string,
        since: string | null,
      ): void => {
        if (best && best.priority <= priority) return;
        best = {
          priority,
          order: state.phaseOrder,
          item: {
            userId: learner.id,
            displayName: learner.displayName,
            email: learner.email,
            phaseKey: state.phaseKey,
            reason,
            since,
            attempts: state.attempts,
            bestScore: state.bestScore,
          },
        };
      };

      for (const state of states) {
        const submission = latest.get(state.id) ?? null;
        const since = isoOrNull(submission?.createdAt) ?? state.unlockedAt;
        const flags = integrityReasons(submission?.report);
        if (flags.length) {
          consider(0, state, `integrity flag on the latest submission: ${flags.join(', ')}`, since);
        }
        const gate = thresholds.get(state.phaseKey) ?? 0;
        if (
          state.status !== 'passed' &&
          state.attempts >= STUCK_ATTEMPTS &&
          (state.bestScore ?? 0) < gate
        ) {
          consider(
            1,
            state,
            `${state.attempts} attempts, best ${state.bestScore ?? 0} against a gate of ${gate}`,
            since,
          );
        }
        // ranBeforeSubmit is set by any run and cleared by a reset (an
        // instructor's, or a learner's start-over or retry), so a submitted
        // phase without it is a learner who has never used the fast feedback
        // loop; on a phase that has one. Every verdict writes `submitted` or
        // `passed`, so a phase back `in_progress` has had no submission since
        // its reset, and there is nothing yet submitted without a run.
        if (
          state.attempts >= 1 &&
          !state.ranBeforeSubmit &&
          state.status !== 'in_progress' &&
          runnable.get(state.phaseKey)
        ) {
          consider(2, state, 'submitted without running the tests first', since);
        }
      }

      const enrollment = enrollmentByUser.get(learner.id);
      const touched = lastActivity.get(learner.id) ?? toDate(enrollment?.startedAt);
      if (enrollment && !enrollment.completed && touched) {
        const days = Math.floor((now - touched.getTime()) / DAY_MS);
        const current =
          [...states].reverse().find((s) => s.status === 'in_progress' || s.status === 'submitted') ??
          states[0];
        if (days >= IDLE_DAYS && current) {
          consider(3, current, `no activity for ${days} days`, touched.toISOString());
        }
      }
      if (best) ranked.push(best);
    }

    ranked.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.order - b.order ||
        a.item.displayName.localeCompare(b.item.displayName),
    );
    return ranked.slice(0, QUEUE_LIMIT).map((entry) => entry.item);
  }

  /**
   * The newest submission per phase state, in two queries: an aggregate that
   * decides which id is newest for each phase state, then one that loads only
   * those rows, since the report column is the heavy part and a term's worth
   * of attempts is not.
   *
   * `lastByUser` (when each learner last submitted anything) falls out of
   * the same aggregate. A learner's last submission is the newest of their own
   * phase states' newest, because every submission belongs to exactly one
   * phase state and every phase state to one learner, so the maximum over the
   * per-phase-state maxima is the maximum over the rows themselves, with no
   * need to watch every row go past.
   */
  private async latestSubmissions(
    manager: EntityManager,
    phaseStateIds: string[],
  ): Promise<{ byPhaseState: Map<string, SubmissionEntity>; lastByUser: Map<string, Date> }> {
    const byPhaseState = new Map<string, SubmissionEntity>();
    const lastByUser = new Map<string, Date>();
    if (!phaseStateIds.length) return { byPhaseState, lastByUser };

    const newest = await newestSubmissionsPerPhaseState(manager, phaseStateIds);
    for (const row of newest) {
      const at = toDate(row.createdAt);
      const seen = lastByUser.get(row.userId);
      if (at && (!seen || at > seen)) lastByUser.set(row.userId, at);
    }
    if (!newest.length) return { byPhaseState, lastByUser };

    // Named columns, never the whole row: the class map and the CSV export
    // both fan out over every learner in scope, and `workspaceSnapshot` is a
    // full copy of a learner's files that no caller here reads.
    const rows = await manager.find(SubmissionEntity, {
      where: { id: In(newest.map((row) => row.id)) },
      select: ['id', 'phaseStateId', 'userId', 'status', 'score', 'passed', 'report', 'error', 'createdAt'],
    });
    for (const row of rows) {
      byPhaseState.set(row.phaseStateId, row);
    }
    return { byPhaseState, lastByUser };
  }

  /**
   * The newest revision **per task**, for the phase states that hold more than
   * one task's rows.
   *
   * Two queries, and neither is issued on a board that has never seen an
   * authored split: the first asks `task_states` which phase states carry two
   * or more keys, and on a project of sole-task phases (which is every phase
   * of the shipped pack) it comes back empty and nothing else runs. That is
   * what keeps the map's cost, and the rows it reads, unchanged there: the
   * suite asserts both, by comparing one class's query count with nine
   * learners' and by re-running every `submissions` read to count its rows.
   *
   * A phase state with **one** task's rows is deliberately not here either: its
   * newest revision per task *is* its newest revision, so the phase-wide read
   * already has the right answer and a second pass would cost a query to
   * confirm it. That is the mainline for a teacher-authored project, where
   * every phase holds one task keyed `main`.
   */
  private async ruleReportsPerState(
    manager: EntityManager,
    phaseStateIds: string[],
  ): Promise<Map<string, Map<string, ProbeReport | null>>> {
    const out = new Map<string, Map<string, ProbeReport | null>>();
    if (!phaseStateIds.length) return out;
    const rows = await manager.find(TaskStateEntity, {
      where: { phaseStateId: In(phaseStateIds) },
      select: ['phaseStateId', 'taskKey'],
    });
    const keysPerState = new Map<string, number>();
    for (const row of rows) {
      keysPerState.set(row.phaseStateId, (keysPerState.get(row.phaseStateId) ?? 0) + 1);
    }
    const split = [...keysPerState.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    if (!split.length) return out;

    const newest = await newestSubmissionsPerTask(manager, split);
    if (!newest.length) return out;
    // The report column is the heavy part, exactly as it is for the sibling
    // read above, so the rows are loaded by name and by named columns.
    const loaded = await manager.find(SubmissionEntity, {
      where: { id: In(newest.map((row) => row.id)) },
      select: ['id', 'phaseStateId', 'taskKey', 'report'],
    });
    for (const id of split) out.set(id, new Map<string, ProbeReport | null>());
    for (const row of loaded) {
      out.get(row.phaseStateId)?.set(row.taskKey, row.report ?? null);
    }
    return out;
  }

  /**
   * Which task owns each rule of one phase of one pinned version, memoised.
   *
   * The pin decides the answer, so the pin is the key: two learners held back
   * on an older version share one index, and a learner on the head shares the
   * head's. A pin this deployment cannot resolve a task list for answers no
   * owners at all, which reads `missing`; the honest answer for a phase whose
   * tasks this build cannot name.
   */
  private ruleOwnersFor(
    memo: Map<string, ReadonlyMap<string, string>>,
    enrollment: EnrollmentEntity,
    phase: ProjectContent['phases'][number],
  ): ReadonlyMap<string, string> {
    const key = `${enrollment.projectSlug}\u0000${enrollment.projectVersionId ?? ''}\u0000${phase.key}`;
    const held = memo.get(key);
    if (held) return held;
    let owners: ReadonlyMap<string, string>;
    try {
      owners = ruleOwners(phase, this.content.getTasksForEnrollment(enrollment, phase.key));
    } catch {
      owners = new Map<string, string>();
    }
    memo.set(key, owners);
    return owners;
  }

  /** The most recent thing a learner did: a submission, a run or a mentor question. */
  private async lastActivityByUser(
    manager: EntityManager,
    userIds: string[],
    lastSubmitted: Map<string, Date>,
  ): Promise<Map<string, Date>> {
    const latest = new Map<string, Date>(lastSubmitted);
    for (const entity of [ExecutionRunEntity, AssistantMessageEntity]) {
      for (const [userId, at] of await this.maxCreatedAtByUser(manager, entity, userIds)) {
        const seen = latest.get(userId);
        if (!seen || at > seen) latest.set(userId, at);
      }
    }
    return latest;
  }

  private async maxCreatedAtByUser(
    manager: EntityManager,
    target: EntityTarget<ObjectLiteral>,
    userIds: string[],
  ): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (!userIds.length) return out;
    const rows = await manager
      .createQueryBuilder(target, 'row')
      .select('row.userId', 'userId')
      .addSelect('MAX(row.createdAt)', 'last')
      .where('row.userId IN (:...ids)', { ids: userIds })
      .groupBy('row.userId')
      .getRawMany<{ userId: string; last: unknown }>();
    for (const row of rows) {
      const at = toDate(row.last);
      if (at) out.set(row.userId, at);
    }
    return out;
  }

  private learnerRow(
    learner: UserEntity,
    cohortName: string | null,
    enrollment: EnrollmentEntity | null,
    phases: PhaseAnalytics[],
    tokensToday: number,
    /** `pinnedReading()`, or null where the version could not be read. */
    reading: PinnedReading | null,
    /** The phases its progress counts (`boardOf`); the phases on the board when not given. */
    total: number = phases.length,
  ): InstructorLearnerRow {
    const passed = phases.filter((p) => p.status === 'passed').length;
    const scored = phases.filter((p) => p.bestScore !== null);
    const averageScore = scored.length
      ? Math.round(scored.reduce((s, p) => s + (p.bestScore || 0), 0) / scored.length)
      : null;
    const reliance = phases.length
      ? Math.round(phases.reduce((s, p) => s + p.relianceIndex, 0) / phases.length)
      : 0;
    return {
      userId: learner.id,
      displayName: learner.displayName,
      email: learner.email,
      cohort: learner.cohort,
      cohortName,
      projectSlug: enrollment?.projectSlug ?? null,
      progressPercent: total ? Math.round((passed / total) * 100) : 0,
      phasesPassed: passed,
      averageScore,
      totalHints: phases.reduce((s, p) => s + p.hints, 0),
      relianceIndex: reliance,
      tokensToday,
      completed: enrollment?.completed ?? false,
      integrityFlag: reliance >= RELIANCE_FLAG_THRESHOLD,
      difficultyTier: difficultyTier(averageScore, reliance, passed),
      // The same two numbers the learner's own dashboard draws, from the same
      // definition in `packages/shared`; a class table and a dashboard that
      // computed them apart would disagree about one learner within a term.
      ...(reading ? reading.overall : {}),
    };
  }

  /**
   * The same budget day as AssistantService.tokensToday, for a whole class at
   * once: local midnight in `AI_USAGE_TIMEZONE`, not UTC, or the
   * console's column and the learner's own meter disagree for the seven hours
   * between the two midnights.
   */
  private async tokensTodayByUser(
    userIds: string[],
    now: Date = new Date(),
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    if (!userIds.length) return totals;
    const dayStart = usageDayStart(now);
    const rows = await this.messages.find({
      where: { userId: In(userIds), createdAt: MoreThanOrEqual(dayStart) },
      select: ['userId', 'tokensIn', 'tokensOut'],
    });
    for (const row of rows) {
      totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.tokensIn + row.tokensOut);
    }
    return totals;
  }
}

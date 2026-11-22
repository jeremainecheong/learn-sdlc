import { SCREEN_COPY_PATH, withScreenCopy } from '../content/screen-copy';
import { resolveScreenCopy, requireAcceptedDesignScreenCopy } from './accepted-screen-copy';
import { phaseDetailStory } from './phase-detail-story';
import { phaseDetailDesign } from './phase-detail-design';
import { phaseDetailChange, phaseDetailRunbook } from './phase-detail-records';
import { learnerChecksText, learnerRubric, learnerText } from './learner-text';
import { storyPrefixesOf } from './story-prefixes';
import { drillWithIncident } from './drill-incident';
import { olderFormatRoomSentence } from '../content/phase-grading';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull, Repository } from 'typeorm';
import type {
  DrillState,
  EnrollmentView,
  PhaseDetail,
  PhaseEvidenceGap,
  PhaseLink,
  PhaseProvenanceView,
  PhaseSummary,
  PhaseTaskCounts,
  PhaseTaskView,
  ProjectMeta,
  ProjectMapData,
  ReleaseRecordView,
  Runbook,
  RunClockSaved,
  TaskResetPlanView,
  TaskResetResult,
} from '@learnsdlc/shared';
import {
  buildProjectMap,
  DRILL_TIMELINE_EVENTS,
  firstPhaseOf,
  nextPhaseOf,
  placeOf,
  RUN_CLOCK_MESSAGE,
  RUN_CLOCK_PATTERN,
  RUNBOOK_JSON,
  RUNBOOK_RESOLVE_CONFLICT,
  RUNBOOK_CAPS,
  RUNBOOK_RESOLVE_INVALID,
  RUNNER_UNAVAILABLE_MESSAGE,
  runbookSaveRefusal,
  serialiseRunbook,
  validateRunbookRecord,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { hasRecord } from '../content/checks-validation';
import type { EnrollmentPin } from '../content/content.service';
import { config } from '../config';
import { UNATTACHED_COHORT } from '../instructor/cohort-scope';
import { referenceFiles } from './solution.reference';
// The class schedule as plain functions rather than an injected service, so the
// card a learner reads and the gate the route enforces read the same code
// without this file taking a dependency on the console.
import {
  NO_SCHEDULE,
  ScheduleMap,
  effectivePhaseStatus,
  opensAtMessage,
  scheduleForLearner,
  scheduledShut,
} from '../instructor/schedule.service';
import { DrillSpec, PhaseContent, ProjectContent } from '../content/content.types';
import { previewUnsupported } from '../execution/sandbox.service';
import { soleTaskList } from '../content/task-units';
import { soleNonQuizTask, type CompiledTask } from '../content/pack-compiler';
import { phaseProvenance, referenceNameFrom } from '../authoring/provenance';
import { taskCountsOf, taskViews } from './task-view';
import {
  analyseReset,
  isRetry,
  pendingProposal,
  planView,
  refusalException,
  resetRefusal,
  retryFactsOf,
  writeReset,
} from './learner-reset';
import { newestSubmissionsPerTask } from '../analytics/newest-per-task';
import {
  CohortEntity,
  CohortProjectAssignmentEntity,
  EnrollmentEntity,
  PhaseStateEntity,
  ProjectEntity,
  ProjectVersionEntity,
  ReleaseRecordEntity,
  SubmissionEntity,
  TaskStateEntity,
  UserEntity,
} from '../db/entities';
import { InjectRepository } from '../db/inject';
import { atomic } from '../db/atomic';
import { isUniqueViolation } from '../db/unique-violation';
import { errorName } from '../observability/error-name';
import {
  LINKS_MAX,
  LINK_SOURCE_MESSAGE,
  LINK_SOURCE_PATTERN,
  LINK_TARGET_MESSAGE,
  LINK_TARGET_PATTERN,
} from '../dto';
import { adoptOrphanRevisions } from '../feedback/legacy-revisions';
import {
  FeedbackService,
  RunnerUnavailableError,
  SmokeCheckResult,
} from '../feedback/feedback.service';
import { unknownTask } from '../feedback/task-resolution';
import { phaseRollup } from '../feedback/checkers';
// The per-task gate lives in `strict-gate.ts`, so `advance` and the room's
// `evidenceNeeded` ask one predicate.
import {
  evidenceNeededAhead,
  evidenceNeededAt,
  passKindOf,
  requiredTasksWithoutEvidence,
  taskHasStrictEvidence,
  type CreditTask,
  type PassFacts,
  type PassKind,
} from './strict-gate';
import { refuseInvalidStoryRecord } from './story-record-guard';
import { refuseInvalidDesignDocument } from './design-record-guard';
import { refuseInvalidRecord } from './record-guard';
import { heldEnrollment, lockEnrollment } from '../db/enrollment-lock';
import { failureLine, operationsFromDesign, stampedAt, summaryFiles, summaryIntro } from './workflow-helpers';
import { normalisedIso } from '../db/timestamps';

/**
 * One phase of `EnrollmentView.phases` as this API writes it: the shared
 * summary plus `passKind` on a passed phase (`reviewed`, or `credit` for a
 * teacher's Mark as passed or sign-off with no reviewed pass behind it).
 * Optional: absent on any phase that is not passed. Typed here, not in the
 * shared package.
 */
export type EnrolledPhaseSummary = PhaseSummary & {
  passKind?: PassKind;
  /**
   * On a credit only: the required tasks the gate still wants, and which of
   * them wait only on the teacher's countersignature.
   */
  creditTasks?: CreditTask[];
};

/** The learner's board as this API writes it, its phases carrying `passKind`. */
export type EnrollmentViewWithPassKind = EnrollmentView & { phases: EnrolledPhaseSummary[] };

/** What `PUT /phases/:id/links` accepts; `at` is normalised server-side. */
export interface PhaseLinkInput {
  from: string;
  to: string;
  kind: PhaseLink['kind'];
  at?: string;
}

/** The run clock refuses a year outside this range. */
const RUN_CLOCK_MIN_YEAR = 1970;
const RUN_CLOCK_MAX_YEAR = 2100;

/** The resolve's refusal when no health check on the drill has gone from red to green. */
const NO_RED_TO_GREEN =
  'the container starts, but no health check on this drill has gone from failing to passing. Run the health check against your own files, then resolve.';

/**
 * True while the drill has no proof that anything was ever broken.
 *
 * `pagedExit` is the exit of the smoke run against the pack's faulted copy at
 * the moment the learner was paged, the drill's own red. The panel calls that
 * run a health check ("The health check fails on the faulted copy") and draws
 * it as failed without asking; recording it is what lets `drillResolve`
 * require a check that was red before it was green without ever touching the
 * learner's Dockerfile. A stored drill without the field is read as red: the
 * pack's faulted copy is declared to fail, and the run happened.
 */
function sawNoFailure(drill: DrillState): boolean {
  return drill.pagedExit === 0 && drill.healthExit !== 1;
}

/**
 * True for the error `FeedbackService.runSmokeCheck` throws when the sandbox
 * could not be reached at all (the runner's `unavailable` outcome, which
 * `runSandbox` turns into a throw so no scorer reads it as a verdict).
 */
function isRunnerDown(err: unknown): boolean {
  return err instanceof RunnerUnavailableError;
}

/**
 * What a learner is told when they ask to start a project that is not theirs.
 *
 * One sentence for every wrong slug: another teacher's project, a pack this
 * deployment does not hold, a name typed by hand, so that the refusal says
 * what to do next and nothing about what else exists. It names no slug for the
 * same reason: the project a learner has been given is on the screen they came
 * from, and a refusal is not a catalogue.
 *
 * Every clause has to be true for everybody who can be refused, and the step it
 * names has to be one they can take. So it does not promise the class's
 * project: a learner kept on a teacher's project their class was moved off
 * keeps it, and it does not send anybody to onboarding, which nobody
 * past it can open again. The dashboard is open to every signed-in learner,
 * and it opens (or offers to start) the project the server resolves for them.
 *
 * It is also what an INSTRUCTOR is told when they name a project
 * that is neither the platform's, their own, nor one a class of theirs was
 * given: the same sentence, so staff cannot use it to find out which projects
 * other teachers have written either.
 */
export const NOT_YOUR_PROJECT =
  'Nothing was started, because that project is not one this account can start; your dashboard opens the project that is yours.';

/** And when this deployment has published nothing at all to start. */
export const NO_PROJECT_YET =
  'There is no project to start here yet. Whoever set this site up still has to publish one.';

/**
 * As much of the caller as the resolution order asks about.
 *
 * Both facts come off the `AuthUser` the guard resolved from the users row at
 * request time, so a controller hands its `user` straight over and nothing
 * re-reads the row. It is a structural type rather than `AuthUser` so that this
 * file takes no dependency on the auth layer for two columns.
 */
export interface LearnerIdentity {
  id: string;
  /**
   * `users.cohort`: a class id, or `'default'`, which is the absence of one.
   *
   * Optional for the one caller that holds a user id and nothing else: the
   * warm-up, whose four routes are keyed on a learner rather than on a request,
   * and read from the users row when it is absent, which costs a query only
   * on the path that could not hand one over, and only when the learner's own
   * enrolment has not already answered.
   */
  cohort?: string;
  /**
   * `users.role`, where the caller has it to hand (every controller does).
   * Staff previewing a project are not set aside by `standing`; read from
   * the users row when absent, and only on the path that could set a row aside.
   */
  role?: string;
}

/**
 * The SDLC workflow engine: per-learner phase state machine with
 * artefact capture and gating. A phase unlocks only when the previous one is
 * passed on retained, strict evidence (`advance`). The reflection that closed
 * the Kolb do-then-reflect cycle is optional: `advance` does not read it, and
 * `/reflect` holds a reflection somebody wrote to its 20-character floor
 * (`ReflectDto`).
 */
@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
  /** Class assignments already warned about, so a broken row is one line. */
  private readonly warnedAssignments = new Set<string>();

  constructor(
    @InjectRepository(EnrollmentEntity) private readonly enrollments: Repository<EnrollmentEntity>,
    @InjectRepository(PhaseStateEntity) private readonly phaseStates: Repository<PhaseStateEntity>,
    @InjectRepository(ReleaseRecordEntity) private readonly releases: Repository<ReleaseRecordEntity>,
    private readonly content: ContentService,
    private readonly feedback: FeedbackService,
    private readonly dataSource: DataSource,
  ) {}

  projectMeta(slug: string): ProjectMeta {
    return this.metaOf(this.content.getProject(slug));
  }

  /**
   * One version's meta. `projectMeta` above answers the published head, which
   * is right for a request that names a project; a learner's catalogue answers
   * the version each entry would give them (`metaForPin`).
   */
  private metaOf(project: ProjectContent): ProjectMeta {
    return {
      slug: project.slug,
      title: project.title,
      tagline: project.tagline,
      description: project.description,
      language: project.language,
      phaseTitles: project.phases.map((p) => ({ key: p.key, order: p.order, title: p.title })),
      // Whether this pack ships a warm-up, so Home can decide
      // whether to draw the card without asking a second route.
      hasWarmup: !!project.warmup,
    };
  }

  listProjects(): ProjectMeta[] {
    return this.content.listProjects().map((p) => this.projectMeta(p.slug));
  }

  /**
   * The catalogue a learner is shown: the project the server resolves for
   * them, first, then any other project they hold an enrolment in.
   *
   * {@link listProjects} is every published project, whoever wrote it: a
   * teacher's title, tagline, description and phase titles included, and a
   * teacher's project reaches only learners of a class it is assigned to. The
   * resolved project leads, so a page that takes the first entry takes the
   * learner's own. Staff keep the whole catalogue, at the controller.
   */
  async catalogueForLearner(learner: LearnerIdentity): Promise<ProjectMeta[]> {
    const held = await this.enrollments.find({
      where: { userId: learner.id },
      select: { id: true, projectSlug: true, projectVersionId: true, startedAt: true },
      order: { startedAt: 'ASC' },
    });
    // One resolution over the rows just read: the pin the first entry is, and
    // the rows set aside for the class's project, which the entries
    // below say so about, the learner is told once, from these two facts.
    const { pin, forClass } = await this.resolveFrom(learner, held);
    const asideSlugs = new Set(forClass.map((row) => row.projectSlug));
    const servable = new Set(this.content.listProjects().map((project) => project.slug));
    // Each entry is described as the version it would give this learner: the
    // resolved pin for the first (the class's held version, before they have
    // started) and the learner's own row for every project in their record.
    // Described from the head instead, a class kept on an older version would
    // read the newer one's title and phases on the Start card, and then be
    // pinned (correctly) to a version whose phases differ from what the card
    // said.
    const pins = new Map<string, EnrollmentPin>();
    if (pin) pins.set(pin.projectSlug, pin);
    for (const row of held) {
      if (!pins.has(row.projectSlug)) {
        pins.set(row.projectSlug, { projectSlug: row.projectSlug, projectVersionId: row.projectVersionId });
      }
    }
    return [...pins.values()]
      .filter((one) => servable.has(one.projectSlug))
      .map((one) => {
        const meta = this.metaForPin(one);
        return asideSlugs.has(one.projectSlug) ? { ...meta, setAside: true as const } : meta;
      });
  }

  /**
   * The meta of the version a pin resolves to. A version this build refuses to
   * serve is described by the head's meta, rather than taking the whole
   * catalogue down with it: the room that pin opens says why.
   */
  private metaForPin(pin: EnrollmentPin): ProjectMeta {
    try {
      return this.metaOf(this.content.getForEnrollment(pin));
    } catch {
      return this.projectMeta(pin.projectSlug);
    }
  }

  /**
   * One project's meta for a learner, and the same 404 as a slug nobody
   * published for any project outside their catalogue, so the route is not a
   * way to find out which projects exist.
   */
  async projectMetaForLearner(learner: LearnerIdentity, slug: string): Promise<ProjectMeta> {
    const mine = (await this.catalogueForLearner(learner)).find((meta) => meta.slug === slug);
    if (!mine) throw new NotFoundException(`unknown project: ${slug}`);
    return mine;
  }

  /**
   * Enrol the learner who is asking, into the project that is theirs.
   *
   * {@link enroll} below takes a slug and writes it, which is right for the
   * seed, the specs and anything else that already knows the answer. It was
   * also what `POST /api/v1/enrollments` did with a slug typed by the browser,
   * and that is a different thing entirely: the browser is the one party in
   * this exchange that does not know which project a learner was given. A
   * shared lab machine proved it: one learner signed out, the next registered
   * with no class, and the tab still held the first learner's slug, so the new
   * account was pinned to a teacher's project nobody had assigned it.
   *
   * So the slug the request carries is a **claim**, and the answer is
   * {@link projectVersionForLearner}'s: their own enrolment, else their class's
   * active assignment, else the project this deployment starts everybody on.
   * A claim that matches is honoured; anything else is refused, and the
   * refusal is one sentence whether the slug names another teacher's project,
   * a project nobody published or nothing at all: it is not a way to find out
   * which projects exist.
   *
   * **Why no allowance for "other platform projects".** The product rule
   * names one project for a learner in no class: the default. A second
   * platform-owned pack, published but not flagged and not assigned to anybody,
   * is not a project any learner has been given, and an allowance for it would
   * be a rule nothing in this deployment exercises guarding the one route that
   * writes an enrolment pin. Staff do not come through here: the controller
   * sends them to {@link enrollAsStaff}, named slug or none, so
   * previewing one of their own projects before assigning it is unaffected.
   *
   * The version written is the version resolved. Keeping only the slug and
   * letting {@link enroll} read the class's assignment a second time would let
   * a teacher moving the class between the two reads put the learner on the
   * old project at its head (a version nobody assigned) and step 1 would
   * answer it for the rest of the term. The resolution already is `startingPin`'s answer
   * wherever the two agree: the class's assignment at its version, the head of
   * the default, or the learner's own row at its own pin.
   */
  /**
   * `POST /enrollments` naming a slug, for a member of staff.
   *
   * Staff start a project to walk it, not to be taught it, so the learner's
   * resolution is not theirs. But "any published slug" would let one teacher
   * read another teacher's unassigned project (title, briefs, phases, files)
   * through an enrolment, which the authoring side has never allowed
   * (`AuthoringService.requireVisibleProject`: the platform's projects and your
   * own). So an INSTRUCTOR may start exactly what they could already see or
   * hand out:
   *
   * - a platform-owned project (published, or `enroll` answers its own 404,
   *   which tells nobody anything, every instructor's library lists them);
   * - a project they own;
   * - a project assigned to a class they own (`cohorts.ownerUserId`), active
   *   or superseded: a class moved on keeps its started learners on the
   *   project they started, and their teacher may still need to walk it.
   *
   * and a project they already hold a row in, which is a retry of a start
   * they already made and reveals nothing new. Anything else is refused in
   * the learner's one sentence: a slug nobody published included, so the
   * refusal is not a way to learn which projects exist. ADMIN is unrestricted,
   * 404 and all. View-as does not come through here: it never enrols.
   *
   * **Naming nothing meets the same rule.** The dashboard's Start sends `{}`,
   * and the learner's resolution taken unchecked, whose step 2 is the project
   * of the class in `users.cohort`: would start an instructor an admin had
   * seated in another teacher's class on that class's project, which this
   * method refuses them by name. So the resolution's answer is held to the same three doors: the
   * default is the platform's, and a class of their own gives them its project.
   */
  async enrollAsStaff(caller: LearnerIdentity, named?: string): Promise<EnrollmentView> {
    if (!named) {
      const pin = await this.projectVersionForLearner(caller);
      if (!pin) throw new BadRequestException(NO_PROJECT_YET);
      if (caller.role !== 'ADMIN' && !(await this.staffMayStart(caller.id, pin.projectSlug))) {
        throw new ForbiddenException(NOT_YOUR_PROJECT);
      }
      return this.enrollAt(caller.id, pin);
    }
    if (caller.role !== 'ADMIN' && !(await this.staffMayStart(caller.id, named))) {
      throw new ForbiddenException(NOT_YOUR_PROJECT);
    }
    return this.enroll(caller.id, named);
  }

  /** The three staff doors, and the retry, for one slug. */
  private async staffMayStart(userId: string, projectSlug: string): Promise<boolean> {
    return (await this.staffStartable(userId, [projectSlug])).has(projectSlug);
  }

  /**
   * Which of these slugs an INSTRUCTOR may start, and therefore read: a
   * project they already hold a row in (a retry, revealing nothing new), a
   * platform-owned project, their own, or one assigned (active or superseded)
   * to a class they own. A slug no project row carries is in none of them.
   *
   * One rule for three doors: the enrolment ({@link enrollAsStaff}), the
   * project's meta by slug and the staff catalogue, and
   * one implementation, batched so the catalogue is at most five indexed reads
   * whatever the number of projects, and the enrolment door asks no more than
   * it did.
   */
  private async staffStartable(userId: string, slugs: readonly string[]): Promise<Set<string>> {
    const yes = new Set<string>();
    if (slugs.length === 0) return yes;
    const held = await this.enrollments.find({
      where: { userId, projectSlug: In([...slugs]) },
      select: { id: true, projectSlug: true },
    });
    for (const row of held) yes.add(row.projectSlug);
    const rest = slugs.filter((slug) => !yes.has(slug));
    if (rest.length === 0) return yes;
    const projects = await this.dataSource.getRepository(ProjectEntity).find({
      where: { slug: In(rest) },
      select: { id: true, slug: true, platformOwned: true, ownerUserId: true },
    });
    const undecided: ProjectEntity[] = [];
    for (const project of projects) {
      if (project.platformOwned || project.ownerUserId === userId) yes.add(project.slug);
      else undecided.push(project);
    }
    if (undecided.length === 0) return yes;
    const owned = await this.dataSource
      .getRepository(CohortEntity)
      .find({ where: { ownerUserId: userId }, select: { id: true } });
    if (owned.length === 0) return yes;
    const assigned = await this.dataSource.getRepository(CohortProjectAssignmentEntity).find({
      where: { cohortId: In(owned.map((cohort) => cohort.id)) },
      select: { id: true, projectVersionId: true },
    });
    if (assigned.length === 0) return yes;
    const versions = await this.dataSource.getRepository(ProjectVersionEntity).find({
      where: {
        id: In([...new Set(assigned.map((row) => row.projectVersionId))]),
        projectId: In(undecided.map((project) => project.id)),
      },
      select: { id: true, projectId: true },
    });
    const given = new Set(versions.map((version) => version.projectId));
    for (const project of undecided) if (given.has(project.id)) yes.add(project.slug);
    return yes;
  }

  /**
   * `GET /projects/:slug` for a member of staff.
   *
   * The enrolment door is shut on another teacher's unassigned project, and
   * this one must be too: an instructor naming its slug would otherwise be
   * answered with its title, tagline, description and phase titles, what
   * `AuthoringService.requireVisibleProject` never shows them. So an
   * INSTRUCTOR is answered through {@link staffStartable}, and anything outside
   * it is the 404 a slug nobody published gets, word for word
   * (`ContentService.getProject`), so the refusal is not a way to learn which
   * projects exist. An ADMIN reads every project.
   */
  async projectMetaForStaff(caller: LearnerIdentity, slug: string): Promise<ProjectMeta> {
    if (caller.role !== 'ADMIN' && !(await this.staffMayStart(caller.id, slug))) {
      throw new NotFoundException(`unknown project: ${slug}`);
    }
    return this.projectMeta(slug);
  }

  /**
   * `GET /projects` for a member of staff: the published catalogue, in content
   * order, narrowed for an INSTRUCTOR to the projects they may start, the same fields the slug route would refuse, so the
   * list is not a second way to read them. An ADMIN keeps the whole catalogue.
   *
   * Its one browser reader is the shell's `fetchProject`, which takes a named
   * slug only when the catalogue knows it and otherwise asks the server's own
   * resolution, whose answer `enrollAsStaff` holds to this same rule.
   */
  async catalogueForStaff(caller: LearnerIdentity): Promise<ProjectMeta[]> {
    const all = this.listProjects();
    if (caller.role === 'ADMIN') return all;
    const mine = await this.staffStartable(caller.id, all.map((meta) => meta.slug));
    return all.filter((meta) => mine.has(meta.slug));
  }

  async enrollAsLearner(learner: LearnerIdentity, named?: string): Promise<EnrollmentView> {
    const pin = await this.projectVersionForLearner(learner);
    if (!pin) throw new BadRequestException(NO_PROJECT_YET);
    if (named && named !== pin.projectSlug) throw new ForbiddenException(NOT_YOUR_PROJECT);
    return this.enrollAt(learner.id, pin);
  }

  /**
   * Enrol a learner on a project.
   *
   * An enrolment and its phase states, one for each phase its version holds,
   * are one fact, not separate writes: a board with holes in it is not a
   * partial enrolment, it is a learner who cannot reach a phase further on.
   * So they are written in one transaction, the database refuses a second
   * enrolment for the same learner and project outright
   * (`UQ_enrollments_user_project`), and an enrolment that somehow lost rows:
   * an older deployment's crash, a restore: is repaired here rather than met
   * with a refusal the learner can do nothing about.
   */
  async enroll(userId: string, projectSlug: string): Promise<EnrollmentView> {
    // The one enrolment-scoped site where the version is being *chosen* rather
    // than resolved: a learner starting now starts on the version their class
    // was put on, or on what is published now where no class put them
    // anywhere. An enrolment that already exists is resolved through its own
    // pin, because re-enrolling is a retry and not a migrate.
    //
    // The pin and the board come from the same call, so the row's version, its
    // `packVersion` and the phases written under it are one version's and not
    // two. `getForEnrollment` keeps `getProject`'s 404 for a slug this
    // deployment does not hold.
    return this.enrollAt(userId, await this.startingPin(userId, projectSlug));
  }

  /** {@link enroll}, at a pin already chosen: by `startingPin` or by the resolution. */
  private async enrollAt(userId: string, pin: EnrollmentPin): Promise<EnrollmentView> {
    const projectSlug = pin.projectSlug;
    const project = this.content.getForEnrollment(pin);
    const existing = await this.enrollments.findOne({ where: { userId, projectSlug } });
    if (existing) {
      // A retry after a lost response returns the same board, repairing any
      // missing phase states before returning it.
      const repaired = await this.fillMissingPhaseStates(
        existing,
        this.content.getForEnrollment(existing),
      );
      if (repaired) this.logger.warn(
        `enrolment ${existing.id} was missing ${repaired} phase state(s); filled them in rather than refusing`,
      );
      return this.enrollmentView(existing);
    }

    let enrollment: EnrollmentEntity;
    try {
      enrollment = await this.writeEnrollment(userId, project, pin.projectVersionId);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The guard above is a read-then-write, so a double-tapped Start, two
      // tabs or a retried request all get past it and all insert. The index
      // settles it; the loser wanted an enrolment for this learner and project
      // and there is one, so it is handed the winner's rather than an error.
      const winner = await this.enrollments.findOne({ where: { userId, projectSlug } });
      if (!winner) throw err;
      this.logger.log(
        `enrolment for ${userId} on ${projectSlug} was written concurrently; keeping the first`,
      );
      await this.fillMissingPhaseStates(winner, this.content.getForEnrollment(winner));
      enrollment = winner;
    }
    return this.enrollmentView(enrollment);
  }

  /**
   * The version a learner pressing Start on this project starts on.
   *
   * Their class's active assignment where it names *this* project, and the
   * published head otherwise: a class assigned some other project does not
   * decide this one's version, and neither does an assignment this deployment
   * cannot resolve (`assignedToClass` warns once and answers null).
   *
   * This is the write half of `assignment.assign`'s promise that "new
   * enrolments take it; pinned ones do not move". Stamping the head here
   * instead would hand a class deliberately held on a superseded version the
   * newer content the moment anybody pressed Start, and, because
   * `resolveForLearner` answers a learner's own enrolment before it looks at
   * the class: would go on answering with it for the rest of the term.
   *
   * One indexed read of `users` and one of `cohort_project_assignments`, on an
   * action a learner takes once per project.
   */
  private async startingPin(userId: string, projectSlug: string): Promise<EnrollmentPin> {
    const assigned = await this.assignedToClass(await this.cohortOf(userId));
    if (assigned && assigned.projectSlug === projectSlug) return assigned;
    return this.headPin(projectSlug);
  }

  /** The enrolment and its whole board, or neither. */
  private writeEnrollment(
    userId: string,
    project: ProjectContent,
    projectVersionId: string | null,
  ): Promise<EnrollmentEntity> {
    return this.serialiseEnrolment(() =>
      atomic(this.dataSource, async (manager) => {
        const enrollment = await manager.save(
          manager.create(EnrollmentEntity, {
            userId,
            projectSlug: project.slug,
            // The stored order of the project's first phase, whichever subset
            // of the six it is: 1 for every version the draft compiler and
            // publish number 1 to n, and the first stored order for one whose
            // orders do not start at 1, so `newPhaseState` opens exactly that
            // phase. 1 for a version that holds no phase.
            currentPhaseOrder: firstPhaseOf(project)?.order ?? 1,
            // The pack this board was cut from. Every later load compares
            // it against the pack on disk and repairs the board when they differ.
            packVersion: project.version,
            // The pin itself, stamped from the head at this moment. It is what
            // makes "a change never alters an in-flight attempt" a fact about
            // the row rather than a hope about the deployment. A later publish
            // never moves it. Null only where this deployment holds no version
            // rows for the project (a directory load, and every spec that takes
            // one); a deployment that holds them pins a stored null row at the
            // next boot, before the import (`seed/null-pin.ts`), and a
            // project's first publish pins the null rows waiting on it.
            //
            // `startingPin` chose it, out of the class's assignment where
            // there is one and the published head where there is not, and the
            // `project` above was resolved from that same pin, so the row's
            // version, its `packVersion` and its phase states are one
            // version's. The class panel is the first writer of
            // `cohort_project_assignments`, and this is the stamp that keeps a
            // class held on a superseded version there.
            projectVersionId,
          }),
        );
        const states = await manager.save(
          project.phases.map((phase) =>
            manager.create(PhaseStateEntity, this.newPhaseState(enrollment, phase)),
          ),
        );
        // The first of the three task-row creators. One row per
        // compiled task of every phase whose list is not the synthesised sole
        // task, for the imported project that is no phases, no rows and no
        // extra statements. The list comes from the pin this
        // enrolment is being written with, so the row's version, its
        // `packVersion`, its phase states and its task keys are one version's.
        const pin: EnrollmentPin = { projectSlug: project.slug, projectVersionId };
        for (const state of states) {
          const tasks = this.content.getTasksForEnrollment(pin, state.phaseKey);
          if (soleTaskList(tasks)) continue;
          await manager.save(
            tasks.map((task) =>
              manager.create(TaskStateEntity, this.newTaskState(enrollment, state, tasks, task)),
            ),
          );
          // Provably a no-op on a board this statement has just created (there
          // is no history to adopt yet) and called anyway, because no creator
          // may be the one that does not adopt. One narrow indexed
          // UPDATE over zero rows.
          await adoptOrphanRevisions(manager, state.id, tasks);
        }
        return enrollment;
      }),
    );
  }

  /**
   * One enrolment write at a time in this process.
   *
   * better-sqlite3 hands TypeORM a single connection ("sqlite do not support
   * multiple connections thus query runners", `AbstractSqliteQueryRunner`), so
   * two overlapping `dataSource.transaction` calls do not queue behind each
   * other, they collide: the second `BEGIN` raises "cannot start a transaction
   * within a transaction", and its rollback then ends the first one's
   * transaction underneath it, so both learners lose. A class of thirty
   * pressing Start together is exactly that shape, which makes the queue part
   * of the transaction rather than an optimisation. Postgres would not need
   * it, and pays a millisecond or two on an action a learner takes once per
   * project. Across processes it is the unique index that settles the race,
   * never this.
   */
  private enrolQueue: Promise<unknown> = Promise.resolve();

  /** Shares the SQLite connection queue for every atomic learning mutation. */
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return atomic(this.dataSource, work);
  }

  private serialiseEnrolment<T>(work: () => Promise<T>): Promise<T> {
    const next = this.enrolQueue.then(work, work);
    // The chain carries no rejection forward: one learner's failed enrolment
    // must not fail everyone queued behind them.
    this.enrolQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * A phase state as enrolment makes it. Unlocked up to where the enrolment
   * has reached and locked after, which is `phase 1 open, the rest shut` for a
   * new enrolment and the honest answer for a repaired one: a row that had to
   * be rebuilt cannot claim a pass nobody can evidence, but it must not lock a
   * phase the learner has already walked through either.
   */
  private newPhaseState(enrollment: EnrollmentEntity, phase: PhaseContent) {
    const reached = phase.order <= enrollment.currentPhaseOrder;
    return {
      enrollmentId: enrollment.id,
      userId: enrollment.userId,
      phaseKey: phase.key,
      phaseOrder: phase.order,
      status: (reached ? 'in_progress' : 'locked') as PhaseStateEntity['status'],
      unlockedAt: reached ? new Date().toISOString() : null,
    };
  }

  /**
   * A task row as a creator makes it: the key, the learner, and nothing else,
   * **except** on the one shape where the phase row already names this task's
   * own history.
   *
   * `status` is left at the column's own `in_progress` and **not** copied from
   * the phase state. A row seeded `locked` could never pass: `nextPhaseStatus`
   * makes `locked` sticky on a task row exactly as it does on a phase, and a
   * row seeded `passed` out of an `in_progress` or `submitted` phase would
   * claim a pass nothing has evidence for, which is the inversion the
   * roll-up's quantifier exists to prevent. A missing row and a fresh row are
   * both *failing* keys, which is the direction a doubt must fall.
   *
   * **The one exception is the other half of the board's adoption, and it is not
   * a loosening.** The adoption in `adoptOrphanRevisions` gives a revision
   * handed in before tasks were keyed the key its phase's one task declares,
   * because *a phase with exactly one task has exactly one owner for its
   * history*. That sentence is about the row too: a learner who passed a
   * teacher-authored phase **before** tasks were keyed has
   * `phase_states.status = 'passed'` and no `task_states` row at all, and a row
   * repaired in at `in_progress` makes `strictPass`' row conjunct in `advance`
   * (`if (row?.status !== 'passed') return false;`) false for ever, the
   * learner is refused the merge they had already earned, the tile stays
   * green, and the project-completion arm quantifies the same predicate over
   * every phase the version holds, so `completedAt` is unreachable too. The
   * adoption alone does not reach it: `strictPass` asks for the evidenced
   * revision **and** the row.
   *
   * So the seed is bounded to exactly the shape whose answer is unambiguous,
   * by three conjuncts and no more:
   *
   * - **the phase reads `passed`**, never `locked` (sticky, and could never
   *   pass), never `in_progress` or `submitted` (nothing to inherit);
   * - **this is the pinned list's one non-quiz task**, two or more and the
   *   phase's pass is the roll-up of a *set*, so it names no single owner and
   *   *a missing row is a failing row* is the whole of the answer;
   * - **that task is required**, provable from the first conjunct, because the
   *   compiler refuses a phase with no required task, and written anyway: the
   *   same belt and braces as `phaseRollup`'s `requiredKeys.size > 0`, and in
   *   the same direction.
   *
   * It cannot manufacture a pass a teacher has withdrawn: `task-reopen` and
   * `task-reset` write the **phase** row down to `in_progress` when the task is
   * required (`instructor.service.ts`, the per-task levers), so a reopened
   * phase never reads `passed` here. It cannot manufacture one at enrolment
   * either: `newPhaseState` writes `in_progress` or `locked` and never
   * `passed`, so on `writeEnrollment`'s path the branch is provably dead and
   * lives here only so that the two creators cannot answer differently.
   */
  private newTaskState(
    enrollment: EnrollmentEntity,
    state: Pick<PhaseStateEntity, 'id' | 'status' | 'passedAt' | 'bestScore'>,
    tasks: readonly CompiledTask[],
    task: CompiledTask,
  ) {
    const row = {
      phaseStateId: state.id,
      // Carried on the row rather than joined for, exactly as `phase_states`
      // carries it: the export and the erasure walk a `userId` column.
      userId: enrollment.userId,
      taskKey: task.taskKey,
    };
    // The phase's **sole non-quiz task** and never `soleTaskList`: the two are
    // different questions and this is the adoption's one, written the same way
    // it is written there. A creator is never reached on a *synthesised* sole
    // task (no row exists there), so the list here is authored, and one
    // authored task is the mainline rather than a corner.
    //
    // Not `tasks.length !== 1`: this branch exists *"only so that the two
    // creators cannot answer differently"*, and `carriedTaskPass`, the other
    // one, counts non-quiz tasks. A quiz added
    // beside the artefact task would otherwise stop the carry here while the
    // sibling still made it, which is the one thing this branch is for.
    if (soleNonQuizTask(tasks)?.taskKey !== task.taskKey) return row;
    if (state.status !== 'passed' || !task.required) return row;
    return {
      ...row,
      status: 'passed' as PhaseStateEntity['status'],
      passedAt: state.passedAt,
      bestScore: state.bestScore,
    };
  }

  /**
   * The task rows, from the one DataSource this service already holds.
   *
   * A getter rather than a seventh constructor argument: `WorkflowService` is
   * built by hand in eighteen specs, and a required parameter would have made
   * this step an edit to every one of them. `getRepository` is cached per
   * manager, so this is a map read and every caller gets one object.
   */
  private get taskStates(): Repository<TaskStateEntity> {
    return this.dataSource.getRepository(TaskStateEntity);
  }

  /**
   * This enrolment's **pinned** task list for every phase of the project it
   * resolves, and whether any of those lists is authored.
   *
   * One resolution for the whole board, from the accessor the roll-up's
   * quantifier, `strictPass`, the repair and the door all read, never the
   * head's list, which answers what the project declares *now*.
   *
   * `authored` is what lets every task query below be skipped outright. For a
   * project of sole-task phases: the imported default, on every phase, for
   * every learner: the answer is false and no read of `task_states` is ever
   * issued: sole tasks have no rows, so looking for them is a tax on the
   * learner who has none.
   */
  private pinnedTasks(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
  ): { byPhase: Map<string, CompiledTask[]>; authored: boolean } {
    const byPhase = new Map<string, CompiledTask[]>();
    let authored = false;
    for (const phase of project.phases) {
      const tasks = this.content.getTasksForEnrollment(enrollment, phase.key);
      byPhase.set(phase.key, [...tasks]);
      if (!soleTaskList(tasks)) authored = true;
    }
    return { byPhase, authored };
  }

  /**
   * Every `task_states` row of these phase states, grouped by phase state.
   *
   * One read for the whole board rather than one per phase, and the rows
   * themselves rather than a grouped `MAX(updatedAt)` beside a second read for
   * the statuses: the counts and the stamp are two questions about the same
   * rows, and asking them separately is two answers that can disagree.
   */
  private async taskRowsFor(stateIds: string[]): Promise<Map<string, TaskStateEntity[]>> {
    const grouped = new Map<string, TaskStateEntity[]>();
    if (!stateIds.length) return grouped;
    const rows = await this.taskStates.find({
      where: { phaseStateId: In(stateIds) },
      order: { taskKey: 'ASC' },
    });
    for (const row of rows) {
      const held = grouped.get(row.phaseStateId) ?? [];
      held.push(row);
      grouped.set(row.phaseStateId, held);
    }
    return grouped;
  }

  /**
   * One phase's task list and the two summary fields derived from it.
   *
   * `taskViews` is the one place a task's numbers are decided: the phase row
   * for a sole task, its own row for an authored one, and an unstarted task for
   * a required key with no row: a missing row is a failing key, said at the
   * surface a learner reads it on. Nothing here re-derives any of that; it
   * hands the builder what it needs and counts what it answered.
   *
   * `tasksUpdatedAt` is the newest write to any of this phase's task rows, and
   * it is null where there are none. A client decides whether a cached phase
   * detail may be reused by comparing the summary's fields, and on a split
   * phase an **optional** task can be submitted, graded and recorded while the
   * phase's status, score and attempt count all stand still, so without this
   * field every surface in the block would draw from a cache that cannot see a
   * task move.
   */
  private taskGrain(
    phase: PhaseContent | undefined,
    state: PhaseStateEntity,
    tasks: readonly CompiledTask[] | undefined,
    rows: readonly TaskStateEntity[],
    view: 'summary' | 'full',
    lastSubmissionIds?: ReadonlyMap<string, string | null>,
  ): { views: PhaseTaskView[]; counts?: PhaseTaskCounts; tasksUpdatedAt: string | null } {
    // A phase key this enrolment holds that the project does not declare:
    // `phaseSummary` already shows that row by its key rather than refusing it,
    // and a task list is one more thing there is no content to build.
    if (!phase || !tasks) return { views: [], tasksUpdatedAt: null };
    const views = taskViews({ phase, tasks, state, rows, view, lastSubmissionIds });
    let tasksUpdatedAt: string | null = null;
    for (const row of rows) {
      const at = normalisedIso(row.updatedAt);
      if (at && (!tasksUpdatedAt || at > tasksUpdatedAt)) tasksUpdatedAt = at;
    }
    return { views, counts: taskCountsOf(views), tasksUpdatedAt };
  }

  /**
   * Give an enrolment the phase states the project says it should have, and
   * answer with how many were missing. Row by row and outside a transaction on
   * purpose: each row is independent, `UQ_phase_states_enrollment_order` makes
   * every insert idempotent, and a repair that only got halfway is simply
   * repaired again on the next call.
   */
  private async fillMissingPhaseStates(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
  ): Promise<number> {
    const held = await this.phaseStates.find({
      where: { enrollmentId: enrollment.id },
      select: { id: true, phaseOrder: true },
    });
    const orders = new Set(held.map((state) => state.phaseOrder));
    const missing = project.phases.filter((phase) => !orders.has(phase.order));
    let written = 0;
    for (const phase of missing) {
      try {
        await this.phaseStates.save(this.phaseStates.create(this.newPhaseState(enrollment, phase)));
        written += 1;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // someone else repaired it first
      }
    }
    return written;
  }

  /**
   * Give an enrolment the task rows the **version it is pinned to** says it
   * should have, and answer with how many were missing.
   *
   * The same shape as `fillMissingPhaseStates` above, for the same reason: each
   * row is independent, `UQ_task_states_key` makes every insert idempotent, and
   * a repair that only got halfway is simply repaired again on the next call.
   *
   * **The wanted set comes from the pin, never from the head.** The head's list
   * answers what the project declares *now*; this enrolment may be
   * pinned to a superseded version, and composing the head accessor with a
   * pinned board is two keyed structures that can disagree in both directions:
   * an enrolment pinned to a split version whose head has been flattened would
   * get no rows at all, and one pinned to a flat version whose head has been
   * split would get rows keyed for tasks its own version does not declare,
   * rows the gate will never read and the panel would draw.
   *
   * **And it costs a sole-task board nothing.** `repairBoard` runs from
   * `reconcileToPack` on every write-path enrolment read, so a per-read SELECT
   * looking for rows that never exist for a sole task would be a tax on every learner of the
   * imported project. The wanted set is built from the content first and the
   * function **returns before touching the database** when it is empty, which
   * for TaskTrackr is every phase, every time.
   */
  private async fillMissingTaskStates(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
  ): Promise<number> {
    const wanted = new Map<string, CompiledTask[]>();
    for (const phase of project.phases) {
      const tasks = this.content.getTasksForEnrollment(enrollment, phase.key);
      if (soleTaskList(tasks)) continue;
      wanted.set(phase.key, tasks);
    }
    if (wanted.size === 0) return 0;

    const board = await this.phaseStates.find({
      where: { enrollmentId: enrollment.id },
      // The three roll-up columns come back beside the key because a row this
      // repair writes for a **one-task** phase inherits that phase's own pass
      // (`newTaskState`): a learner who passed a teacher-authored phase before
      // tasks were keyed has no `task_states` row, and a row repaired in at
      // `in_progress` would refuse `strictPass` for ever.
      // Three columns on a read the repair already makes, and none of them
      // reaches a phase holding two or more tasks.
      select: { id: true, phaseKey: true, status: true, passedAt: true, bestScore: true },
    });
    // A phase the project removed is left exactly where it is, and so are its
    // rows: the learner did that work.
    const mine = board.filter((state) => wanted.has(state.phaseKey));
    if (mine.length === 0) return 0;

    const held = await this.taskStates.find({
      where: { phaseStateId: In(mine.map((state) => state.id)) },
      select: { id: true, phaseStateId: true, taskKey: true },
    });
    // Keyed by phase state and then by task, so the pair needs no separator:
    // a task key is a teacher's string, and a joined key is one ambiguity
    // away from skipping a row that is not there.
    const present = new Map<string, Set<string>>();
    for (const row of held) {
      const keys = present.get(row.phaseStateId) ?? new Set<string>();
      keys.add(row.taskKey);
      present.set(row.phaseStateId, keys);
    }
    let written = 0;
    for (const state of mine) {
      for (const task of wanted.get(state.phaseKey) as CompiledTask[]) {
        if (present.get(state.id)?.has(task.taskKey)) continue;
        try {
          await this.taskStates.save(
            this.taskStates.create(
              this.newTaskState(enrollment, state, wanted.get(state.phaseKey) as CompiledTask[], task),
            ),
          );
          written += 1;
        } catch (err) {
          if (!isUniqueViolation(err)) throw err; // someone else repaired it first
        }
      }
    }

    // At the end of the body and **not** inside the insert branch: the
    // adoption's trigger is the state of the board, so a pass that inserted
    // nothing still adopts a revision that completed since the last one.
    for (const state of mine) {
      await adoptOrphanRevisions(
        this.dataSource.manager,
        state.id,
        wanted.get(state.phaseKey) as CompiledTask[],
      );
    }
    return written;
  }

  /**
   * Give an enrolment the board the project it resolves says it should have.
   *
   * Phase states are written in exactly two places: `writeEnrollment` for a new
   * enrolment, and `fillMissingPhaseStates` from here for one that lost rows
   * afterwards. Both names matter: a later grain of learner state has the same
   * two creators to satisfy, and a board with a hole in it is not a partial
   * enrolment, it is a learner who cannot reach phase 4. A project that gains a
   * phase between one class and the next, a crash between the enrolment insert
   * and its rows, and a restore that landed one without the other all produce
   * the same hole.
   *
   * The condition is a statement about the **board**, not about a version
   * string. `enrollment.packVersion === project.version` would not do: that
   * string is written by `writeEnrollment` out of the very version the read
   * then compares it against, so it is permanently true for every enrolment
   * made against the project it is loaded with, and the repair would be
   * reachable only in the term where a version happened to move. Under the
   * pin the resolved version is immutable for the life of the enrolment, so the
   * comparison would be true for ever and this would be dead code. One small
   * indexed read of the enrolment's own orders instead: the same read the
   * repair needs anyway, so the whole-board check costs the repair's first
   * query and nothing else.
   *
   * A phase the project *removed* is left exactly where it is. The learner did
   * that work, it has a score and a reflection against it, and `phaseSummary`
   * shows a row whose key the project does not name, by its key.
   */
  private async repairBoard(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
  ): Promise<void> {
    const added = await this.fillMissingPhaseStates(enrollment, project);
    if (added) {
      this.logger.warn(
        `enrolment ${enrollment.id} was missing ${added} phase state(s) for ${project.slug} ${project.version}; filled them in rather than refusing`,
      );
    }
    // The second grain, after the first: a task row hangs off a
    // phase state, so the board has to be whole before its rows can be. It
    // costs a sole-task board no query at all.
    const rows = await this.fillMissingTaskStates(enrollment, project);
    if (rows) {
      this.logger.warn(
        `enrolment ${enrollment.id} was missing ${rows} task state(s) for ${project.slug} ${project.version}; filled them in rather than refusing`,
      );
    }
  }

  /**
   * Record which version an enrolment that has no pin is being read against.
   *
   * `packVersion` is the only record such a row has of the rules it started
   * under, and this is its one writer after enrol time. A **pinned** enrolment
   * is left alone: the pin already names its version, and the stamp names the
   * version that graded the work, which is the version it is pinned to and not
   * whatever is published now. Refreshing it on a read would put the head's
   * string on an attempt the head did not grade, which is the opposite of the
   * reason the column exists.
   */
  private async stampPack(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
  ): Promise<void> {
    if (enrollment.projectVersionId) return;
    if (enrollment.packVersion === project.version) return;
    await this.enrollments.update(enrollment.id, { packVersion: project.version });
    enrollment.packVersion = project.version;
  }

  /**
   * What a read that describes the whole board does before describing it: the
   * board first, then the stamp. `phaseSummaries` and `enrollmentView` call it
   * here; the room does the same pair a step apart, `stampPack` on the way
   * through `loadOwnedState` and `repairBoard` in `phaseDetail`, so all three
   * requests a learner's own client makes on the way in repair the board.
   *
   * `advance` deliberately does not repair. A missing *next* room there is
   * refused by name rather than invented by the request that is about to move
   * the learner into it, and the refusal already tells them to reload, which is
   * one of the reads above and repairs it.
   *
   * `write: false` is the read that must not write, and it suppresses the
   * stamp as well as the repair. The caller is an instructor reading a
   * learner's coursework: the repair's row and the stamp both carry the
   * learner's own id, and `ViewAsService`'s six reads are documented as
   * read-only, so a read made on a learner's behalf has to leave their
   * enrolment and their board exactly as it found them, which is what
   * `ViewAsService`'s "provably read-only" has to mean to be worth saying.
   * Suppressing the repair alone would not do it: an enrolment with a null
   * pin is the one shape `stampPack` writes for. The board is not left broken either way: the learner's own
   * next read still repairs it.
   *
   * The whole-board reads want the *other* half of this, and take it on
   * `phaseDetail` rather than here (`repair: false, write: true`) because
   * their fan-out would otherwise re-ask the repair's question once per open
   * room for a board this same request has already made whole.
   */
  private async reconcileToPack(
    enrollment: EnrollmentEntity,
    project: ProjectContent,
    write = true,
  ): Promise<void> {
    if (!write) return;
    await this.repairBoard(enrollment, project);
    await this.stampPack(enrollment, project);
  }

  async myEnrollment(
    userId: string,
    projectSlug: string,
    // Whether this read may touch the learner's rows at all. See
    // `reconcileToPack`: false is `ViewAsService.enrollment` and nothing else.
    write = true,
  ): Promise<EnrollmentView | null> {
    const enrollment = await this.enrollments.findOne({ where: { userId, projectSlug } });
    return enrollment ? this.enrollmentView(enrollment, write) : null;
  }

  /* -------------------------- the server-side default ----------------------- */

  /**
   * Which project a learner is in when the request names none.
   *
   * Four steps, in this order:
   *
   *   1. the learner's own enrolment, when they hold exactly one that their
   *      membership still reaches (`standing`: a teacher's project only
   *      while the learner is in a class it was assigned to; a platform or
   *      default project only while their class is not actively assigned a
   *      different one, and while they hold no teacher's row that
   *      class gave them, which it yields to), **at the version pinned on
   *      it**, not at the head;
   *   2. the active assignment of the class in `users.cohort`, at the version
   *      the class was assigned, never the head;
   *   3. the `DEFAULT_PROJECT` slug an operator named, at its newest published
   *      version, when this deployment holds that project;
   *   4. the `projects` row the importer flagged, at its newest published
   *      version.
   *
   * **Step 1 comes first, and that is the whole point.** Resolving the class's
   * *active* assignment first would hand a learner with a term of work a
   * first-run screen the day their class is moved: `myEnrollment` and `phaseSummaries` both look up
   * `{userId, projectSlug}`, so resolving a project the learner holds no
   * enrolment in answers `null` and `[]`. An existing enrolment is a fact about
   * the learner; an assignment is a fact about the class, and the learner's own
   * work outranks it. A reassignment therefore changes what **new** enrolments
   * get, and moving a learner who is already working is a separate, audited
   * migrate. The one exception: a class given a project of its own sets
   * aside a started platform or default row, so its learners can start the
   * class's, which moves no row either: it writes a second one, at the
   * class's version, when the learner presses Start.
   *
   * **"Exactly one" in step 1 is deliberate.** The shell keeps a learner to one
   * active enrolment, so two rows are a retry or a migration in
   * progress; `find` carries no ordering a learner should be resolved by, and
   * guessing between them is how somebody with a term of work lands on the
   * wrong project. The plural case waits for the class's assignment.
   *
   * **No step reads the content directory.** `config.defaultProject` answers
   * the first `project.json` that `readdirSync` returns whenever
   * `DEFAULT_PROJECT` is unset: a fact about a directory, not an answer to
   * "which project is this learner in", so the three learner routes never pass
   * it when a request names no project. Step 3 reads `config.namedProject`, which is the operator's
   * choice and nothing else, and step 4 reads the flag the importer set.
   *
   * `null` is the honest answer for a deployment that has imported nothing:
   * the pair below turn it into "this learner has no enrolment", which is what
   * a request answers for a learner who has not started, and the warm-up meets
   * `getProject`'s refusal for an empty slug. A booted
   * instance cannot be in that state: `ProjectRegistryService` refuses to
   * start when no published version holds a snapshot, and the import flags a
   * default, so it is reachable only by a spec that installs content by hand.
   */
  async projectVersionForLearner(learner: LearnerIdentity): Promise<EnrollmentPin | null> {
    return (await this.resolveForLearner(learner)).pin;
  }

  /**
   * The resolution, and the enrolment row it read on the way when step 1
   * answered, so the pair below spend one query where `myEnrollment` would
   * make the same indexed read a second time.
   */
  private async resolveForLearner(
    learner: LearnerIdentity,
  ): Promise<{ pin: EnrollmentPin | null; enrollment: EnrollmentEntity | null }> {
    const { pin, enrollment } = await this.resolveFrom(
      learner,
      await this.enrollments.find({ where: { userId: learner.id } }),
    );
    return { pin, enrollment };
  }

  /**
   * The resolution over rows a caller already read: every row the learner
   * holds, whatever columns it selected beyond `projectSlug` and the pin, and
   * the rows set aside for the class's project on the way, which the
   * catalogue and the teacher's roster say so about.
   */
  private async resolveFrom(
    learner: LearnerIdentity,
    rows: EnrollmentEntity[],
  ): Promise<{ pin: EnrollmentPin | null; enrollment: EnrollmentEntity | null; forClass: EnrollmentEntity[] }> {
    // 1. The learner's own enrolment: of the ones their membership still
    // reaches (`standing`), when that is exactly one.
    const { reached: held, forClass, assigned: known } = await this.standing(learner, rows);
    if (held.length === 1) {
      const own = held[0];
      return {
        pin: { projectSlug: own.projectSlug, projectVersionId: own.projectVersionId },
        enrollment: own,
        forClass,
      };
    }

    // 2. The class's active assignment: already read by `standing` when it
    // had a platform row to weigh against it, and read here otherwise.
    const assigned =
      known !== undefined
        ? known
        : await this.assignedToClass(learner.cohort ?? (await this.cohortOf(learner.id)));
    if (assigned) return { pin: assigned, enrollment: null, forClass };

    // 3. The slug an operator named. Synchronous and file-free (`config.ts`),
    // and skipped when this deployment holds no such project: a variable left
    // pointing at a pack that is not imported is a misconfiguration, and
    // answering step 4 is more use to a learner than answering a slug nothing
    // can resolve.
    const named = config.namedProject;
    if (named && this.content.listProjects().some((project) => project.slug === named)) {
      return { pin: this.headPin(named), enrollment: null, forClass };
    }

    // 4. The project the importer flagged, and, like step 3, only when this
    // deployment holds it. The flag is a `projects` row and the catalogue is
    // the set of published versions that carry a compiled snapshot, so a
    // flagged project can stop being servable without the flag moving: an
    // owner leaving archives every version of theirs, and a published row with
    // no snapshot is skipped by name. Answering it anyway hands the warm-up a
    // pin the registry has nothing for, and a learner opening their first page
    // is told `unknown project` instead of being sent somewhere that exists.
    //
    // `ensureDefaultProject` heals two flagged rows to one in a transaction, so
    // the ordering here is only the tie-break for a database that was written
    // round it.
    const flagged = await this.dataSource
      .getRepository(ProjectEntity)
      .find({ where: { isDefault: true }, order: { createdAt: 'ASC' } });
    const catalogue = this.content.listProjects();
    const servable = flagged.find((row) =>
      catalogue.some((project) => project.slug === row.slug),
    );
    if (servable) return { pin: this.headPin(servable.slug), enrollment: null, forClass };

    return { pin: null, enrollment: null, forClass };
  }

  /**
   * The enrolments a learner holds that their membership still reaches.
   *
   * The product rule is that a teacher's project reaches only learners of a
   * class it is assigned to, and that a learner in no class gets the default.
   * If step 1 answered any single row, a learner who LEFT their class, or moved
   * to another, would keep the teacher's project for good, and be refused the
   * project their membership now gives them, because the claim check asks this
   * same resolution.
   *
   * So a row is set aside here, and only here, when its project is a teacher's
   * (neither the platform's nor the flagged default) and has never been
   * assigned to the class the learner is in now. "Never", not "not now": a
   * class the teacher moved keeps its started learners where they are, active
   * assignment or superseded. A legacy row with no `projects` row, or anything
   * this deployment holds no ownership for, is never set aside. A platform or
   * default row is set aside by one thing only: the learner's class being
   * actively assigned a different project (`standing` below).
   *
   * Setting a row aside moves nothing and deletes nothing: the row, its pin and
   * its submissions stay in the learner's record, and the resolution goes on to
   * the class's project or the default, which the learner can then start.
   */
  /**
   * Whether a route that takes a project by name may answer this learner about
   * it: a project they hold an enrolment in (their own record), or one the
   * reach rule lets reach them, anything but another teacher's project that
   * was never assigned to their class. A slug this deployment does not hold
   * passes here and meets the route's own 404, so the two refusals read alike.
   */
  async reachesLearner(learner: LearnerIdentity, projectSlug: string): Promise<boolean> {
    if (await this.enrollments.exists({ where: { userId: learner.id, projectSlug } })) return true;
    const standIn = this.enrollments.create({ userId: learner.id, projectSlug });
    // The set-aside rule decides which project a learner is *in*, not what may be read: a
    // platform project set aside for the class's still reaches them, as every
    // platform project reaches everybody.
    const { reached, forClass } = await this.standing(learner, [standIn]);
    return reached.length === 1 || forClass.length === 1;
  }

  /**
   * The two rules that set a held enrolment aside.
   *
   * **The first rule.** A teacher's project: neither the
   * platform's, nor the flagged default, nor the slug an operator named: is set
   * aside when it was never assigned to the class the learner is in now.
   *
   * **The second rule.** When the learner's class
   * has an ACTIVE assignment to a different project, a row on a DEFAULT or
   * PLATFORM project is set aside too, so the learner can start the class's
   * project: the teacher's class works the teacher's project, and a learner who
   * joined late, or whose class was given a project after they started the
   * platform's, is not refused it for a term with no lever. A teacher's row is
   * never set aside by it: a class moved from one teacher's project to another
   * keeps its started learners where they are, which is the first
   * rule's "ever assigned". And a platform row never takes a teacher's row
   * over: when the one teacher's row the class gave a learner is still reached,
   * a platform or default row they also hold yields to it, even once the class
   * is moved onto that platform project (the late joiner).
   *
   * It asks for a class project that can actually be started: an assignment
   * this deployment resolves to a project row, at a version it will serve, so a
   * broken assignment never takes a learner's working board away and hands them
   * a Start that fails. And it asks only of learners: staff previewing keep
   * what they started, exactly as under the first rule.
   *
   * Set aside moves nothing and deletes nothing, under either rule: the row,
   * its pin and its submissions stay in the learner's record and answer every
   * route that names the project. `forClass` is the second rule's rows, which
   * the learner's catalogue and the teacher's roster mark; `assigned` is the
   * class's assignment when this read it (`undefined` when it did not), so the
   * resolution's step 2 does not read it twice.
   *
   * One read of `projects` for any learner; the user row only when the caller
   * did not hand over the class and role; the class's assignment only for a
   * learner in a class holding a platform row, and the class's history only for
   * one holding a teacher's.
   */
  private async standing(
    learner: LearnerIdentity,
    held: EnrollmentEntity[],
  ): Promise<{ reached: EnrollmentEntity[]; forClass: EnrollmentEntity[]; assigned?: EnrollmentPin | null }> {
    if (held.length === 0) return { reached: held, forClass: [] };
    const owners = await this.dataSource.getRepository(ProjectEntity).find({
      where: { slug: In([...new Set(held.map((row) => row.projectSlug))]) },
      select: { id: true, slug: true, platformOwned: true, isDefault: true },
    });
    const named = config.namedProject;
    const teachers = (project: ProjectEntity) =>
      !project.platformOwned && !project.isDefault && project.slug !== named;
    const guarded = new Map(
      owners.filter(teachers).map((project) => [project.slug, project.id]),
    );
    // A row with no `projects` row is in neither set: a legacy row, or one
    // this deployment holds no ownership for, is never set aside.
    const yielding = new Set(owners.filter((project) => !teachers(project)).map((project) => project.slug));
    if (guarded.size === 0 && yielding.size === 0) return { reached: held, forClass: [] };

    // Staff are not taught by the resolution: an instructor walking their own
    // project before they assign it, or an admin looking at a pack, keeps the
    // board they started, exactly as `POST /enrollments` lets them start it.
    let { cohort, role } = learner;
    if (cohort === undefined || role === undefined) {
      const row = await this.dataSource
        .getRepository(UserEntity)
        .findOne({ where: { id: learner.id }, select: { id: true, cohort: true, role: true } });
      cohort ??= row?.cohort ?? UNATTACHED_COHORT;
      role ??= row?.role ?? 'LEARNER';
    }
    if (role !== 'LEARNER') return { reached: held, forClass: [] };
    const inClass = !!cohort && cohort !== UNATTACHED_COHORT;

    const given = new Set<string>();
    if (guarded.size > 0 && inClass) {
      const assignments = await this.dataSource
        .getRepository(CohortProjectAssignmentEntity)
        .find({ where: { cohortId: cohort }, select: { id: true, projectVersionId: true } });
      if (assignments.length > 0) {
        const versions = await this.dataSource.getRepository(ProjectVersionEntity).find({
          where: { id: In([...new Set(assignments.map((row) => row.projectVersionId))]) },
          select: { id: true, projectId: true },
        });
        for (const version of versions) given.add(version.projectId);
      }
    }

    let assigned: EnrollmentPin | null | undefined;
    let forClass: EnrollmentEntity[] = [];
    if (yielding.size > 0 && inClass) {
      assigned = await this.assignedToClass(cohort as string);
      if (assigned && this.startable(assigned)) {
        const theClass = assigned.projectSlug;
        forClass = held.filter((row) => yielding.has(row.projectSlug) && row.projectSlug !== theClass);
      }
    }
    const aside = new Set(forClass);
    let reached = held.filter((row) => {
      if (aside.has(row)) return false;
      const projectId = guarded.get(row.projectSlug);
      return projectId === undefined || given.has(projectId);
    });
    // The late joiner. A learner who started
    // a platform project alone, joined a class and started the teacher's
    // project it was given holds both rows. When the class then moves to that
    // platform project, the platform row stops being set aside by the rule
    // above, and two reached rows would fall to step 2: moving this learner
    // off the teacher's project they worked all term while a classmate who
    // holds only the teacher's row stays on it. So a platform or default row
    // yields to the one teacher's row this class gave the learner, exactly as
    // it yields to the class's project: marked, kept whole, readable by name.
    // Two teacher rows are left to step 2, as any plural case is.
    const taught = reached.filter((row) => guarded.has(row.projectSlug));
    if (taught.length === 1) {
      const yielded = reached.filter((row) => yielding.has(row.projectSlug));
      if (yielded.length > 0) {
        forClass = [...forClass, ...yielded];
        reached = reached.filter((row) => !yielding.has(row.projectSlug));
      }
    }
    return { reached, forClass, assigned };
  }

  /** Whether a pin names a version this deployment will serve, so a Start on it can succeed. */
  private startable(pin: EnrollmentPin): boolean {
    try {
      this.content.getForEnrollment(pin);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * For the teacher's roster: of the rows a learner holds, which project
   * they are working now, the one the resolution answers, `null` when it
   * answers a project they have not started, and which rows are set aside for
   * their class's project. `learner` carries the users row's class, so this is
   * the learner's own resolution and not the caller's.
   */
  async rosterStanding(
    learner: { id: string; cohort: string },
    rows: EnrollmentEntity[],
  ): Promise<{ current: string | null; setAside: Set<string> }> {
    const { pin, forClass } = await this.resolveFrom({ ...learner, role: 'LEARNER' }, rows);
    const current = pin && rows.some((row) => row.projectSlug === pin.projectSlug) ? pin.projectSlug : null;
    return { current, setAside: new Set(forClass.map((row) => row.id)) };
  }

  /**
   * The class's project, at the version the class was assigned.
   *
   * `cohort_project_assignments` is written by the class panel and read
   * here; `UQ_cohort_project_assignment_active` keeps at most one active row
   * per class, so the ordering is a tie-break and not a policy.
   *
   * A row naming a version this deployment cannot resolve hands the question
   * to the next step rather than answering with it, and says so once: the
   * class is still a class, and its learners still need somewhere to go.
   */
  private async assignedToClass(cohort: string): Promise<EnrollmentPin | null> {
    // `'default'` is not a class, it is the absence of one (`cohort-scope.ts`),
    // and no assignment is ever written against it.
    if (!cohort || cohort === UNATTACHED_COHORT) return null;
    const assignment = await this.dataSource
      .getRepository(CohortProjectAssignmentEntity)
      .findOne({ where: { cohortId: cohort, state: 'active' }, order: { createdAt: 'DESC' } });
    if (!assignment) return null;

    const version = await this.dataSource
      .getRepository(ProjectVersionEntity)
      // Two columns, not the row: this sits on `GET /enrollments/mine` and on
      // the two phase batches, and `compiled` is the whole compiled pack as
      // `simple-json`, a megabyte of text and a parsed object graph per row,
      // to read one foreign key.
      .findOne({ where: { id: assignment.projectVersionId }, select: ['id', 'projectId'] });
    const project = version
      ? await this.dataSource.getRepository(ProjectEntity).findOne({ where: { id: version.projectId } })
      : null;
    if (!project) {
      this.warnAssignment(
        assignment.id,
        `class ${cohort} is assigned the project version ${assignment.projectVersionId}, which this ` +
          'deployment holds no project row for; its learners resolve the deployment default instead',
      );
      return null;
    }
    return { projectSlug: project.slug, projectVersionId: assignment.projectVersionId };
  }

  /** The class a learner is in, for a caller that had only their id. */
  private async cohortOf(userId: string): Promise<string> {
    const row = await this.dataSource
      .getRepository(UserEntity)
      .findOne({ where: { id: userId }, select: { id: true, cohort: true } });
    return row?.cohort ?? UNATTACHED_COHORT;
  }

  /** A project at its newest published version, for a learner who holds no row of their own. */
  private headPin(projectSlug: string): EnrollmentPin {
    return { projectSlug, projectVersionId: this.content.headVersionIdFor(projectSlug) };
  }

  /** One line per broken assignment, not one per request. */
  private warnAssignment(assignmentId: string, message: string): void {
    if (this.warnedAssignments.has(assignmentId)) return;
    this.warnedAssignments.add(assignmentId);
    this.logger.warn(message);
  }

  /**
   * `GET /enrollments/mine` for a request that names no project.
   *
   * The enrolment row the resolution already read is used where there is one,
   * so this costs exactly what `myEnrollment` costs: one indexed read of
   * `enrollments`, then the board. `repair` is left at its default, because
   * this is the learner's own read of their own board and repairing it is what
   * that read does.
   */
  async myEnrollmentForLearner(learner: LearnerIdentity): Promise<EnrollmentView | null> {
    const { pin, enrollment } = await this.resolveForLearner(learner);
    if (enrollment) return this.enrollmentView(enrollment);
    if (!pin) return null;
    return this.myEnrollment(learner.id, pin.projectSlug);
  }

  /** `GET /phases/summaries` (and the records batch built on it) for the same request. */
  async phaseSummariesForLearner(learner: LearnerIdentity): Promise<PhaseDetail[]> {
    const { pin } = await this.resolveForLearner(learner);
    return pin ? this.phaseSummaries(learner.id, pin.projectSlug) : [];
  }

  /**
   * Every open phase of one enrolment, in the summary view, in one call.
   *
   * The shell needs all of them to draw the sidebar, Home's journey and the
   * palette; fetched one at a time they would be six requests of the thirteen
   * it takes to draw any signed-in page, and thirty learners landing on Home
   * would mean 390 requests. The work is the same; the round trips are not.
   */
  async phaseSummaries(userId: string, projectSlug: string): Promise<PhaseDetail[]> {
    const enrollment = await this.enrollments.findOne({ where: { userId, projectSlug } });
    if (!enrollment) return [];
    const project = this.content.getForEnrollment(enrollment);
    await this.reconcileToPack(enrollment, project);
    const states = await this.phaseStates.find({
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: 'ASC' },
    });
    // The same set the shell asked for one by one: a locked phase has nothing
    // an editor can open on, so it is not fetched and is not sent.
    const open = states.filter((s) => s.status !== 'locked');
    // Together, not one after another: six serial builds would make the batch
    // slower than six parallel requests, which is the opposite of the
    // point. Each one still catches its own rejection, so a phase that cannot
    // be built is missing from the answer rather than failing it: the same
    // contract six separate requests would have.
    // `repair: false` because the board was made whole four lines up and
    // `states` was read after it: a second repair per open room is the same
    // indexed read four more times for a request that already did it.
    const built = await Promise.all(
      open.map((state) =>
        this.phaseDetail(userId, state.id, 'summary', false).catch((err) => {
          this.logger.warn(`phase state ${state.id}: its summary was left out of the batch: ${errorName(err)}`);
          return null;
        }),
      ),
    );
    return built.filter((d): d is PhaseDetail => d !== null);
  }

  async enrollmentView(
    enrollment: EnrollmentEntity,
    write = true,
  ): Promise<EnrollmentViewWithPassKind> {
    const project = this.content.getForEnrollment(enrollment);
    // Before the board is read, not after: a row added here belongs in the
    // answer this call is about to give.
    await this.reconcileToPack(enrollment, project, write);
    const states = await this.phaseStates.find({
      where: { enrollmentId: enrollment.id },
      order: { phaseOrder: 'ASC' },
    });
    // One read of the class's dates for the whole board, rather than one per
    // phase: six rows at most, and a class with no dates costs no query at all.
    const dates = await this.scheduleFor(enrollment);
    // The same discipline one grain down. The pinned lists are
    // resolved in memory, and the rows are read once for the whole board,
    // or not at all, for a project whose every phase holds a sole task.
    const { byPhase, authored } = this.pinnedTasks(enrollment, project);
    const rows = authored
      ? await this.taskRowsFor(states.map((s) => s.id))
      : new Map<string, TaskStateEntity[]>();
    // The board's phases. A passed phase says whether its pass is reviewed
    // or a teacher's credit alone, wherever it stands: the gate's own
    // predicate (`passKindOf`), asked of the status the summary draws, so a
    // phase the class has not opened yet asks nothing. Words only: the gate,
    // the counts and the grade book read nothing from it. Asked one phase at a
    // time rather than all at once, so a long board does not hold one pool
    // connection per phase, and handed the task rows this read already holds,
    // so the countersignature question reads nothing more.
    const phases: EnrolledPhaseSummary[] = [];
    for (const s of states.filter((s) => !enrollment.projectVersionId || project.phases.some((p) => p.key === s.phaseKey))) {
      const summary: EnrolledPhaseSummary = this.phaseSummary(
        s,
        project.phases,
        dates,
        // The summary view: the counts and the stamp, never the task list.
        // `EnrollmentView.phases` is what the shell compares a held detail
        // against, and a list of tasks per phase on every dashboard load is
        // the payload the summary shape exists to keep small.
        this.taskGrain(
          project.phases.find((p) => p.key === s.phaseKey),
          s,
          byPhase.get(s.phaseKey),
          rows.get(s.id) ?? [],
          'summary',
        ),
        // The pinned base phase and its pinned tasks.
        this.provenanceOf(project.phases.find((p) => p.key === s.phaseKey), byPhase.get(s.phaseKey)),
      );
      const facts =
        summary.status === 'passed'
          ? await this.passKindFor(enrollment, s, project, authored ? (rows.get(s.id) ?? []) : undefined)
          : undefined;
      phases.push(facts ? { ...summary, ...facts } : summary);
    }
    return {
      id: enrollment.id,
      projectSlug: enrollment.projectSlug,
      projectTitle: project.title,
      currentPhaseOrder: enrollment.currentPhaseOrder,
      completed: enrollment.completed,
      startedAt:
        enrollment.startedAt instanceof Date
          ? enrollment.startedAt.toISOString()
          : String(enrollment.startedAt),
      completedAt: enrollment.completedAt,
      // A pinned board draws only the states whose key its version holds: a
      // row pinned at its project's first publish may keep a state for a phase
      // that version lacks (`pinNullRowsAtFirstPublish`), kept in the store and
      // never drawn or counted. A null pin keeps every state: it follows the head, and a phase a newer head
      // dropped stays on its board by its key, with the learner's work.
      // A fault pin, one naming no version installed here, is served the
      // head, so its board reads as the head's, as `advance` and completion do.
      phases,
      releases: await this.releasesFor(enrollment.id),
      // The learner's dossier prints this as provenance; without it the
      // document would say "Not recorded" about a fact the row holds.
      packVersion: enrollment.packVersion ?? null,
      // The pin itself, as the shared type declares it: the published
      // version this board resolves from, or null for a legacy row that
      // follows the head. Read only; a view never writes a pin.
      projectVersionId: enrollment.projectVersionId ?? null,
      // The project row's own `isDefault`, never a slug:
      // the lessons are the reference project's material, and a client reads
      // absent as false.
      projectIsDefault: await this.projectIsDefault(enrollment.projectSlug),
    };
  }

  /** Whether this slug's project row is the platform default. */
  private async projectIsDefault(slug: string): Promise<boolean> {
    const row = await this.dataSource.getRepository(ProjectEntity).findOne({
      where: { slug },
      select: { id: true, isDefault: true },
    });
    return row?.isDefault === true;
  }

  /**
   * The class's dates for this enrolment's project, or nothing.
   *
   * Every phase view and the gate itself read this one call, which is what
   * stops a card saying "opens on Tuesday" while the route still accepts
   * Monday's submission (the failure mode the whole item exists to avoid).
   */
  private scheduleFor(enrollment: EnrollmentEntity): Promise<ScheduleMap> {
    return scheduleForLearner(
      this.dataSource.manager,
      enrollment.userId,
      enrollment.projectSlug,
    );
  }

  /** One record per merged phase, oldest first. */
  private async releasesFor(enrollmentId: string): Promise<ReleaseRecordView[]> {
    const rows = await this.releases.find({
      where: { enrollmentId },
      order: { phaseOrder: 'ASC', createdAt: 'ASC' },
    });
    return rows.map((row) => ({
      id: row.id,
      enrollmentId: row.enrollmentId,
      phaseKey: row.phaseKey,
      phaseOrder: row.phaseOrder,
      version: row.version,
      score: row.score,
      notes: row.notes,
      createdAt: normalisedIso(row.createdAt) || String(row.createdAt),
    }));
  }

  /**
   * The learner's row for one phase. The phase content is looked up rather
   * than assumed: content packs are edited between classes, and a phase key
   * this enrolment holds may not be in the project. Every learner
   * enrolled on the pack reads this on the dashboard, so a `!` here is the
   * difference between one stale row shown by its key and thirty 500s. The
   * instructor's view of the same row already reads this way.
   */
  private phaseSummary(
    state: PhaseStateEntity,
    phases: PhaseContent[],
    dates: ScheduleMap = NO_SCHEDULE,
    // The task grain, built by `taskGrain`
    // above from the pinned list and this phase's rows. Defaulted so the
    // eighteen specs that build this service by hand keep calling it with
    // three arguments, and so a payload that has no task grain says so with a
    // null rather than by leaving the field off and making a client guess.
    grain: { counts?: PhaseTaskCounts; tasksUpdatedAt: string | null } = {
      tasksUpdatedAt: null,
    },
    // The phase's provenance, from `provenanceOf`.
    // Defaulted for the same specs; absent draws neither field below.
    provenance: PhaseProvenanceView | null = null,
  ): PhaseSummary {
    const phase = phases.find((p) => p.key === state.phaseKey);
    const scheduled = dates.get(state.phaseKey);
    return {
      id: state.id,
      key: state.phaseKey,
      order: state.phaseOrder,
      title: phase?.title ?? state.phaseKey,
      ...(grain.counts ? { taskCounts: grain.counts } : {}),
      tasksUpdatedAt: grain.tasksUpdatedAt,
      // A phase the class has not opened yet reads locked whatever
      // the row says, and `requireUnlocked` refuses it on the same helper. The
      // row is never rewritten, so moving the date moves the answer at once.
      status: effectivePhaseStatus(state.status, scheduled?.opensAt),
      bestScore: state.bestScore,
      attempts: state.attempts,
      reflection: state.reflection,
      passedAt: state.passedAt,
      opensAt: scheduled?.opensAt ?? null,
      dueAt: scheduled?.dueAt ?? null,
      // The roll-up, and the intro's opening at most
      // PHASE_SUMMARY_INTRO_MAX characters, because a summary rides every
      // EnrollmentView. The whole intro is PhaseDetail's.
      ...(provenance ? { scenario: provenance.rollup } : {}),
      ...(provenance && phase ? { intro: summaryIntro(learnerText(phase.intro ?? '')) } : {}),
    };
  }

  /**
   * One phase's provenance, computed on
   * the pinned **base** phase: `content.getForEnrollment(enrollment).phases`,
   * the registry's own object, never the phase `withScreenCopy` laid a
   * learner's accepted copy over, and that version's pinned tasks. A phase
   * the resolver cannot read carries none (absent reads as an older build).
   */
  private provenanceOf(phase: PhaseContent | undefined, tasks: readonly CompiledTask[] | undefined): PhaseProvenanceView | null {
    if (!phase || !tasks) return null;
    try {
      return phaseProvenance(phase, tasks, referenceNameFrom(this.content));
    } catch {
      return null;
    }
  }

  /**
   * The gate, enforced at the one place every learner-facing phase action
   * loads its state. Before this lived here, run and submit reached the
   * sandbox and the grader on a phase whose previous gate had never been
   * passed: the controllers call straight through to those services, so a
   * check that only some workflow methods remembered to make was no gate.
   */
  requireUnlocked(state: PhaseStateEntity, opensAt?: string | null): void {
    if (state.status === 'locked') {
      throw new ForbiddenException('phase is locked — pass the previous gate first');
    }
    // The second clause: a release date holds a phase shut whatever
    // the learner has passed. It reads `scheduledShut`, the same function
    // `phaseSummary` draws the locked card from, so the card and the gate
    // cannot disagree, and it says when, because a refusal with no date is
    // the version of this a learner can do nothing with.
    if (opensAt && scheduledShut(opensAt)) throw new ForbiddenException(opensAtMessage(opensAt));
  }

  async loadOwnedState(
    userId: string,
    phaseStateId: string,
    // Whether this call may write to the learner's row at all. Every action a
    // learner takes on their own room may; a read made on their behalf by
    // somebody else may not, and `ViewAsService`'s six reads are the callers
    // that say so. See `reconcileToPack`.
    write = true,
  ): Promise<{ state: PhaseStateEntity; phase: PhaseContent; enrollment: EnrollmentEntity }> {
    const state = await this.phaseStates.findOne({ where: { id: phaseStateId } });
    if (!state) throw new NotFoundException('phase not found');
    if (state.userId !== userId) throw new ForbiddenException('not your phase');
    const enrollment = await this.enrollments.findOneByOrFail({ id: state.enrollmentId });
    // The enrolment is read before the gate now, because the gate needs the
    // class's dates and those hang off the enrolment's project.
    this.requireUnlocked(state, (await this.scheduleFor(enrollment)).get(state.phaseKey)?.opensAt);
    // The stamp a submission is recorded against is the version that actually
    // graded it, so it is refreshed on the way into every phase action. The
    // board itself is repaired by the reads that describe it: `phaseDetail`
    // below is the request the room loads with, so a learner who works from the
    // workspace all lab still need not visit the dashboard for the repair, and
    // `advance` keeps its refusal rather than building the room it is about to
    // move them into.
    if (write) await this.stampPack(enrollment, this.content.getForEnrollment(enrollment));
    const base = this.content.getPhaseForEnrollment(enrollment, state.phaseKey);
    // The same flag, for the same reason: `resolveScreenCopy` retains the
    // accepted Design copy on this row and on the Implementation row, and
    // Implementation, Testing, Deployment and Maintenance all declare the file
    // that makes it run. A read made on somebody else's behalf resolves the
    // copy (the instructor sees the room the learner sees) and retains
    // nothing.
    const copy = await resolveScreenCopy(
      this.phaseStates.manager, this.content, enrollment, state, write,
    );
    const phase = withScreenCopy(base, copy);
    return { state, phase, enrollment };
  }

  /**
   * `updatedAt` is any write to the row; `workspaceUpdatedAt` is the learner's
   * own last save. The status bar shows the second one, because a drill
   * step or a grading moves the first.
   *
   */
  async phaseDetail(
    userId: string,
    phaseStateId: string,
    // Which of the two views to answer with. See
    // PhaseDetail.view, and `summaryFiles` for what a summary leaves out.
    view: 'summary' | 'full' = 'full',
    // Whether this read may put back a row the board lost. See
    // `reconcileToPack`: true for the learner's own room load, false for the
    // dashboard's fan-out, which has repaired already, and for an instructor
    // reading someone else's coursework.
    repair = true,
    // Whether it may write to the learner's rows at all: the stamp and the
    // retained screen copy. The two flags are not one flag: the dashboard's
    // fan-out is the learner's own request and keeps both of those, and only
    // declines to re-ask the repair's question once per open room. False is
    // `ViewAsService.phase` and nothing else.
    write = true,
  ): Promise<PhaseDetail> {
    const { state, phase, enrollment } = await this.loadOwnedState(userId, phaseStateId, write);
    const project = this.content.getForEnrollment(enrollment);
    // The room is the one request every learner makes on the way in, whether
    // they came past the dashboard or opened the workspace straight from a
    // bookmark, so it is where a board that lost a row is put back. It changes
    // nothing about the phase being answered (this call is about one room)
    // and it is what makes `advance`'s "reload the course to recover it" true.
    if (repair) await this.repairBoard(enrollment, project);
    const files = this.content.workspaceFiles(phase, state.workspace);
    const summary = view === 'summary';
    // One resolution of the pinned list, one read of this phase's
    // task rows, and both the phase-level door and the task list built from
    // them. A sole-task phase reads no row and issues no query, which is
    // why this is `soleTaskList` and not `tasks.length`.
    const tasks = this.content.getTasksForEnrollment(enrollment, state.phaseKey);
    const sole = soleTaskList(tasks);
    const rows = sole ? [] : (await this.taskRowsFor([state.id])).get(state.id) ?? [];
    // The newest revision of each task, on the full view only: the room shows
    // a task's own last verdict, and the dashboard's fan-out draws a tile. One
    // grouped read on a teacher project's room load, none on a sole-task one.
    const newest =
      sole || summary
        ? undefined
        : new Map(
            (await newestSubmissionsPerTask(this.dataSource.manager, [state.id])).map((row) => [
              row.taskKey,
              row.id,
            ]),
          );
    const grain = this.taskGrain(
      project.phases.find((p) => p.key === state.phaseKey),
      state,
      tasks,
      rows,
      view,
      newest,
    );
    const solution = await this.solutionMeta(state, phase, tasks, rows);
    // A pass ahead of the phase the learner stands on
    // (a teacher's Unlock early and Pass) is one `advance` refuses until they
    // reach it, so the room is told rather than drawing a Continue. The same
    // three facts `advance` reads; no query.
    const notReachedYet =
      state.status === 'passed' && !enrollment.completed && state.phaseOrder > enrollment.currentPhaseOrder;
    // On such a phase, `evidenceNeeded` names what the gate will still want
    // once the learner reaches it: nothing where their own
    // reviewed pass is in, the task where only the board reads passed, so
    // the room never promises a Continue that reaching the phase will not
    // open. Asked by the gate's own predicate, and only on an ahead pass.
    const evidenceNeeded = notReachedYet
      ? await this.evidenceNeededAheadFor(enrollment, state, project)
      : await this.evidenceNeededFor(enrollment, state, project);
    // On the pinned base, never on `phase`,
    // which carries the learner's accepted screen copy.
    const basePhase = project.phases.find((p) => p.key === state.phaseKey);
    const provenance = this.provenanceOf(basePhase, tasks);
    // The story, design and ticket lines as a learner reads them, converted once for every builder below.
    const learnerChecks = learnerChecksText(phase.checks);
    return {
      ...this.phaseSummary(state, project.phases, await this.scheduleFor(enrollment), grain, provenance),
      ...(provenance ? { provenance } : {}),
      // The stakeholder the interview is with: a name and a role, never a fact.
      stakeholder: basePhase?.interview ? { name: basePhase.interview.persona.name, role: basePhase.interview.persona.role } : null,
      // This phase's tasks, in order, on
      // **both** views. The summary's copy omits the four heavy fields, which
      // is the whole difference between them.
      tasks: grain.views,
      projectSlug: enrollment.projectSlug,
      acceptedScreenCopy: state.acceptedScreenCopy ?? null,
      // Every text a learner reads of the version, plain, its HTML comments not shown: the intro, the brief,
      // the story, design and ticket lines, the objectives and the rubric's sentences, each through `learnerText`.
      intro: learnerText(phase.intro),
      // The phase's place in its own project and the project's phase count, so no client computes them.
      place: placeOf(project, phase.key),
      count: project.phases.length,
      // The Testing room's criterion harvest offers the version's own story ids and no other id-shaped line.
      ...(phase.key === 'testing' ? { storyPrefixes: storyPrefixesOf(project) } : {}),
      // The brief, plain text: a version that holds markdown is shown through `plainTextOf`, its HTML
      // comments removed; the stored bytes, the compiled snapshot and every AI request are untouched. The
      // summary leaves it out, so a learner landing on Home is not sent 11 KB of it.
      taskPanel: summary ? '' : learnerText(phase.taskPanel),
      story: phaseDetailStory(learnerChecks),
      design: phaseDetailDesign(learnerChecks),
      runbook: phaseDetailRunbook(phase.checks),
      change: phaseDetailChange(learnerChecks),
      objectives: phase.objectives.map(learnerText),
      artifactKind: phase.artifactKind,
      files: summary ? summaryFiles(files) : files,
      view,
      rubric: learnerRubric(phase.rubric),
      canRun: phase.canRun,
      runLabel: phase.runLabel,
      lastSubmission: await this.feedback.latestFor(state.id),
      updatedAt: normalisedIso(state.updatedAt),
      workspaceUpdatedAt: state.workspaceUpdatedAt ?? null,
      links: state.links || [],
      drill: drillWithIncident(state.drill, state.workspace, phase),
      // The panel and the status bar read the clock from the phase
      // it is a property of, so neither needs a second request for it.
      runClock: state.runClock ?? null,
      // Whether this phase can run the learner's own
      // application, and why this deployment cannot if it cannot. Both on the
      // phase because the Preview tab has to say something the moment it is
      // drawn (a second request would draw an empty panel first) and the
      // pack has to declare a preview block for a phase's canPreview to mean
      // anything, which the loader has already checked at boot.
      canPreview: phase.canPreview && !!project.preview,
      previewUnsupported: previewUnsupported(),
      // The door to the pack's own answer, and whether it has been
      // opened. Derived here because the phase detail is the one payload every
      // room already holds, and it rides the summary view too: three fields,
      // and the phases card needs the door without the workspace's files.
      solution,
      // What `advance` will say, where it would refuse.
      // Absent otherwise, so the payload of a phase passed on its own evidence
      // (every TaskTrackr pass) is the one it always was.
      ...(evidenceNeeded ? { evidenceNeeded } : {}),
      ...(notReachedYet ? { notReachedYet: true as const } : {}),
    };
  }

  /**
   * The required tasks `advance` would refuse this phase over, named for the
   * room, or `undefined` when it would not.
   *
   * A teacher's Sign off or phase-wide Pass writes the board `passed` without
   * a revision behind it, and the room drew "Phase evidence accepted" and
   * Continue over a gate that then refused. The design is that a
   * countersignature is the second half of a pass and never the first
   * (`taskRollup`, `countersignatureNote`, `strictPass`'s evidence conjunct),
   * so the gate is right and the room was not told. `evidenceNeededAt` is the
   * gate's own predicate asked on the terms `advance` asks it: over the
   * version this enrolment is pinned to, `advance`'s own two sources, and on
   * the last phase over every phase as its completion arm does, and costs no
   * query on a room mid-phase, a phase moved past or a finished project.
   */
  private evidenceNeededFor(
    enrollment: EnrollmentEntity,
    state: PhaseStateEntity,
    project: ProjectContent,
  ): Promise<PhaseEvidenceGap[] | undefined> {
    return evidenceNeededAt(this.dataSource.manager, enrollment, state, {
      phases: project.phases,
      tasksFor: (phaseKey) => this.content.getTasksForEnrollment(enrollment, phaseKey),
    });
  }

  /** {@link passKindOf}, over the same two sources as the two around it. */
  private passKindFor(
    enrollment: EnrollmentEntity,
    state: PhaseStateEntity,
    project: ProjectContent,
    taskRows?: readonly TaskStateEntity[],
  ): Promise<PassFacts | undefined> {
    return passKindOf(
      this.dataSource.manager,
      state,
      {
        phases: project.phases,
        tasksFor: (phaseKey) => this.content.getTasksForEnrollment(enrollment, phaseKey),
      },
      taskRows,
    );
  }

  /** {@link evidenceNeededAhead}, over the same two sources as the one above. */
  private evidenceNeededAheadFor(
    enrollment: EnrollmentEntity,
    state: PhaseStateEntity,
    project: ProjectContent,
  ): Promise<PhaseEvidenceGap[] | undefined> {
    return evidenceNeededAhead(this.dataSource.manager, enrollment, state, {
      phases: project.phases,
      tasksFor: (phaseKey) => this.content.getTasksForEnrollment(enrollment, phaseKey),
    });
  }

  /**
   * The phase-level door, which is one task's or nobody's.
   *
   * Three answers, and the middle one is the mainline.
   *
   * **A sole-task phase** answers the phase's own door, read off the phase row:
   * a sole task's state is the phase's. No task row is read for it. A phase
   * whose board reads passed, and whose pack has an answer, also asks
   * the strict gate's evidence: one narrow read of the passing revisions' ids,
   * then their reports a bounded batch at a time, newest first, stopping at
   * the first strict pass (`taskHasStrictEvidence`). A phase that is not
   * passed, or has no answer, still costs no query at all.
   *
   * **A phase with one authored task**: every phase of every teacher-authored
   * project: answers that task's door, and its `readAt` comes from that task's
   * row, because that is where `SolutionService` stamps it. Reading the phase's
   * own column here would leave this field a reader with no writer.
   *
   * **A split phase** advertises no phase-level door: *"keeps meaning the sole
   * task"* is not a defined value when there is no sole task, so the room reads
   * `PhaseDetail.tasks[].solution` instead and a learner is never offered a
   * door that belongs to nobody.
   *
   * **The sole NON-QUIZ task, because the alternative bites a learner who did
   * nothing wrong.** A count test would make any quiz beside a `code` or
   * `tests` task withdraw the **phase's** answer door, and
   * `PhaseTaskView.solution`, the per-task field the docstring above
   * points a split phase at, has no reader anywhere in `apps/web`. Every
   * learner surface for the door is phase-level: the phase card's *Read the
   * reference solution* and its read line, the change, pull-request and matrix
   * rooms, the journal and the dossier. So a learner who had **passed** an
   * implementation phase would lose the button, the read line, the journal
   * event and the dossier field the moment a teacher added an optional quiz
   * beside their code task: nothing refusing, nothing failing, a button
   * simply not drawn.
   * A quiz can own no reference solution, because it owns no file, so the door
   * follows the task that does. Two executable tasks still answer
   * `available: false`, which is the shape the paragraph above was written
   * for.
   *
   * It takes the rows rather than reading one of its own: `phaseDetail` has
   * already read this phase state's task rows for the task list beside this
   * field, and two reads of one table in one payload are two answers that can
   * disagree about when a door was first opened.
   *
   * **`awaitingReview`.** `SolutionService.read` opens on
   * the strict gate's evidence as well as the board, so a door whose task
   * reads passed with no reviewed pass behind it: a teacher's Pass or Sign
   * off: is shut, and the rooms, which draw the door on `status === 'passed'`
   * and `available`, are told so here rather than offering a door the route
   * refuses. Asked only where the board reads passed and there is an answer
   * to protect, by the same predicate the route asks; a pass the review
   * accepted (every TaskTrackr pass) adds no key.
   */
  private async solutionMeta(
    state: PhaseStateEntity,
    phase: PhaseContent,
    tasks: readonly CompiledTask[],
    rows: readonly TaskStateEntity[],
  ): Promise<PhaseDetail['solution']> {
    const sole = soleNonQuizTask(tasks);
    if (!sole) return { available: false, files: 0, readAt: null };
    const answer = referenceFiles(phase, sole);
    const onPhase = soleTaskList(tasks);
    const row = onPhase ? undefined : rows.find((one) => one.taskKey === sole.taskKey);
    const readAt = onPhase ? state.solutionReadAt ?? null : row?.solutionReadAt ?? null;
    const meta = { available: answer.available, files: answer.files.length, readAt };
    // The board half of the door, read off the row the door reads.
    const boardPassed = onPhase
      ? state.status === 'passed' && !!state.passedAt
      : row?.status === 'passed' && !!row.passedAt;
    if (!answer.available || !boardPassed) return meta;
    const evidenced = await taskHasStrictEvidence(this.dataSource.manager, state, sole, onPhase, state.userId);
    return evidenced ? meta : { ...meta, awaitingReview: true };
  }

  /**
   * The learner's project map, built here rather than in the browser.
   *
   * The map is a pure function of the enrolment and the phase details. Built in
   * the shell, it would mean downloading every open phase's whole workspace,
   * locked reference application included, on the way to Home. For a learner
   * three phases into TaskTrackr that is 133 KB of files to draw 26 KB of
   * graph, and the landing budget (e2e/render-cost.spec.ts) is 60 KB. The
   * files are here already, so the derivation happens here and the wire carries
   * the answer.
   *
   * It is the same `buildProjectMap` the web app calls, from
   * `@learnsdlc/shared`, so the served map and a locally built one are the same
   * graph node for node. `compact` folds given stories and per-function tests
   * into blocks (what Home's card draws) and `showLocked` adds the "opens in
   * phase N" placeholders; both are the caller's, because the two shapes differ
   * in which nodes exist and neither can be derived from the other.
   *
   * Locked phases are left out for the same reason `fetchProject` leaves them
   * out: `phaseDetail` refuses them, and a phase nobody has opened has no work
   * on it to draw.
   */
  async projectMap(
    userId: string,
    projectSlug: string,
    opts: { compact?: boolean; showLocked?: boolean } = {},
  ): Promise<ProjectMapData> {
    const enrollment = await this.myEnrollment(userId, projectSlug);
    if (!enrollment) return { nodes: [], edges: [] };
    const open = enrollment.phases.filter((p) => p.status !== 'locked');
    const details: Record<string, PhaseDetail> = {};
    for (const phase of open) {
      details[phase.id] = await this.phaseDetail(userId, phase.id);
    }
    return buildProjectMap(enrollment, details, {
      compact: opts.compact === true,
      showLocked: opts.showLocked !== false,
    });
  }

  async saveWorkspace(
    userId: string,
    phaseStateId: string,
    files: Record<string, string>,
    baseVersion?: string | null,
  ): Promise<{ version: string; workspace: Record<string, string> }> {
    const { state, phase } = await this.loadOwnedState(userId, phaseStateId);
    // Two tabs on one account, both on api/repository/tasks.py: without a
    // version the second write would land silently over the first and both
    // tabs would say "Saved". A tab that quotes the stamp it loaded is told
    // when the row has moved on instead; a caller that quotes nothing (the
    // keepalive save on the way out, the draft replay on the next load) is
    // written unconditionally, so nothing that cannot ask is refused.
    const stored = state.workspaceUpdatedAt ?? '';
    // The public detail represents an untouched workspace as null. A client
    // echoing that value is explicitly claiming the initial revision, not
    // omitting concurrency protection. Older omitted versions stay compatible.
    if (baseVersion !== undefined && (baseVersion ?? '') !== stored) {
      throw new ConflictException({
        error: 'workspace_changed',
        message:
          'This workspace was saved somewhere else after you opened it. Nothing here was written over it.',
        version: stored,
        // The stored copy of the paths this save was about, so the tab can
        // show what it would have overwritten rather than guessing.
        files: Object.fromEntries(
          Object.keys(files).map((path) => [path, (state.workspace || {})[path] ?? '']),
        ),
      });
    }
    const editable = new Set(phase.files.filter((f) => f.editable).map((f) => f.path));
    const workspace = { ...(state.workspace || {}) };
    for (const [path, content] of Object.entries(files)) {
      if (!editable.has(path)) {
        throw new BadRequestException(`file is not editable: ${path}`);
      }
      if (typeof content !== 'string' || content.length > 200_000) {
        throw new BadRequestException(`invalid content for ${path}`);
      }
      const held = (state.workspace || {})[path] ?? phase.files.find((f) => f.path === path)?.content;
      workspace[path] = refuseInvalidRecord(path, refuseInvalidDesignDocument(path, refuseInvalidStoryRecord(path, content, phase.checks), phase.checks), phase.checks, held);
    }
    // Only the columns this route owns. `save(state)` writes back every column
    // that differs from the row, and this entity was read before the request
    // did its work: a grading that landed in between would be reverted by the
    // next keystroke, taking the pass, the score, the attempt count and the
    // pass timestamp with it. The autosave fires every 700 ms, so that window
    // is open all the time the learner is typing.
    //
    // `workspaceUpdatedAt` has four writers, each with this formula and a
    // compare-and-swap on the stamp it read: this save, the learner's own task
    // reset (`resetTask`), an Agentic apply (`AgenticService.apply`) and the
    // drill's resolve (`drillResolve`), which writes the runbook's incident.
    // The instructor's workspace and phase resets also move it, by the same
    // formula and without a compare-and-swap: they clear the files whatever
    // landed, and the moved stamp refuses any write that read the row before.
    // It is what the IDE calls "Saved at", so every other write to this row
    // (the drill's page and health check, `saveLinks`, `markRan`, the run
    // clock, the grading job) has to leave it alone, which a narrow update does.
    const version = new Date(Math.max(Date.now(), (Date.parse(stored) || 0) + 1)).toISOString();
    const saved = await this.phaseStates.update({ id: state.id, workspaceUpdatedAt: stored || IsNull() }, {
      workspace,
      workspaceUpdatedAt: version,
    });
    if (!saved.affected) throw new ConflictException({ error: 'workspace_changed', message: 'Another save arrived at the same time. Refresh and reconcile your changes; nothing was overwritten.' });
    return { version, workspace };
  }

  /**
   * `GET /phases/:id/tasks/:taskKey/reset`, what "Start this task over" would
   * do, so the confirm names it before the learner presses anything. Writes nothing (a missing task row is read as the
   * fresh one the reset would mint). The refusal, when there is one, is the
   * sentence the reset itself would answer with. On a task that has passed
   * (or a sole-task phase that has, through `GET /phases/:id/reset`) the plan
   * is a retry's and carries `retry`: what it keeps, in the API's sentences.
   */
  async planTaskReset(userId: string, phaseStateId: string, taskKey: string): Promise<TaskResetPlanView> {
    const { state, phase, enrollment } = await this.loadOwnedState(userId, phaseStateId);
    const manager = this.dataSource.manager;
    const tasks = this.content.getTasksForEnrollment(enrollment, phase.key);
    const task = tasks.find((one) => one.taskKey === taskKey);
    const rows = soleTaskList(tasks)
      ? []
      : await manager.find(TaskStateEntity, { where: { phaseStateId: state.id } });
    const project = this.content.getForEnrollment(enrollment);
    const analysis = task
      ? analyseReset(phase, tasks, task, rows, this.seededPathsOf(project, phase.key))
      : null;
    const row = rows.find((one) => one.taskKey === taskKey) ?? null;
    const refusal = await resetRefusal(manager, state, tasks, task, taskKey, row, analysis);
    return planView(
      analysis,
      await pendingProposal(manager, state),
      refusal,
      retryFactsOf(state, tasks, task, row, enrollment),
    );
  }

  /**
   * `POST /phases/:id/tasks/:taskKey/reset`, the learner
   * starts one task of an authored list over.
   *
   * One transaction under the enrolment lock (every writer of this board takes
   * it first). The refusals, in order, each one sentence and nothing written
   * before the last: the phase is locked; a sole-task list (TaskTrackr) that has not passed; an
   * unknown key (the pinned list's); a quiz (`resetCount` is its
   * attempt epoch, so a learner reset would hand attempts back); the task
   * awaits a teacher's sign-off; a revision of it is
   * being marked; a Run of the phase is going, when the task owns the phase's
   * execution; the tab's `baseVersion` is stale (409 `workspace_changed`, the
   * body a stale save gets).
   *
   * Then the writes in `writeReset`: the pre-reset bytes into `task_resets`
   * (pruned by `RetentionService.pruneResetCopies`), one narrow
   * compare-and-swap of the phase row stamped with `saveWorkspace`'s formula,
   * the task's NULL-epoch revisions stamped with the run that ends, and the
   * task row's count. No submission is deleted, and no attempt
   * count, status or score moves.
   *
   * On a task that has passed it is a RETRY (`isRetry`): allowed on a sole-task
   * phase too (its one task is the phase), refused only in the retry's words
   * while something is in flight or a teacher review is pending, and the one
   * status that moves is the task's (and the phase row's, when the task is
   * required or sole and the phase had passed) back to `in_progress`. The pass
   * date, the scores, the attempts, a signature, the releases, the enrolment's
   * place and completion, and every later phase are not written.
   */
  async resetTask(
    userId: string,
    phaseStateId: string,
    taskKey: string,
    baseVersion: string | null,
  ): Promise<TaskResetResult> {
    const { state, phase, enrollment } = await this.loadOwnedState(userId, phaseStateId);
    const tasks = this.content.getTasksForEnrollment(enrollment, phase.key);
    const project = this.content.getForEnrollment(enrollment);
    const seededPaths = this.seededPathsOf(project, phase.key);
    return atomic(this.dataSource, async (manager) => {
      await lockEnrollment(manager, { id: enrollment.id, userId });
      const held = await manager.findOneByOrFail(PhaseStateEntity, { id: state.id, userId });
      const task = tasks.find((one) => one.taskKey === taskKey);
      // The grader's idiom: mint the row if the board never got one, so the
      // count this reset raises is a real row's.
      if (task && !soleTaskList(tasks) && held.status !== 'locked') {
        await manager
          .createQueryBuilder()
          .insert()
          .into(TaskStateEntity)
          .values({ phaseStateId: held.id, taskKey, userId: held.userId })
          .orIgnore()
          .execute();
      }
      const rows = soleTaskList(tasks)
        ? []
        : await manager.find(TaskStateEntity, { where: { phaseStateId: held.id } });
      const row = rows.find((one) => one.taskKey === taskKey) ?? null;
      const analysis = task ? analyseReset(phase, tasks, task, rows, seededPaths) : null;
      const refusal = await resetRefusal(manager, held, tasks, task, taskKey, row, analysis);
      if (refusal) throw refusalException(refusal);
      // `resetRefusal` has already thrown this for a key the version does not
      // declare, so the task and its analysis are always here.
      if (!task || !analysis) throw unknownTask(taskKey);
      const stored = held.workspaceUpdatedAt ?? '';
      if ((baseVersion ?? '') !== stored) {
        throw new ConflictException({
          error: 'workspace_changed',
          message:
            'This workspace was saved somewhere else after you opened it. Nothing here was written over it.',
          version: stored,
          files: Object.fromEntries(
            [...analysis.restores, ...analysis.reseeds].map((path) => [
              path,
              (held.workspace || {})[path] ?? '',
            ]),
          ),
        });
      }

      const deleted = [...analysis.restores, ...analysis.reseeds];
      const workspace = { ...(held.workspace || {}) };
      const taken: Record<string, string> = {};
      for (const path of deleted) {
        if (typeof workspace[path] === 'string') taken[path] = workspace[path];
        delete workspace[path];
      }
      if (analysis.reseeds.length) {
        const seeded = await this.seededBytesFor(enrollment, { phaseKey: held.phaseKey, workspace }, project);
        for (const path of analysis.reseeds) {
          if (typeof seeded[path] === 'string') workspace[path] = seeded[path];
        }
      }
      const retry = isRetry(held, tasks, row)
        ? { phaseBack: soleTaskList(tasks) || (task.required && held.status === 'passed') }
        : null;
      const version = await writeReset(manager, held, row, analysis, workspace, taken, new Date(), retry);
      if (!version) {
        throw new ConflictException({
          error: 'workspace_changed',
          message: 'Another save arrived at the same time. Refresh and reconcile your changes; nothing was overwritten.',
        });
      }
      const after = await manager.findOneByOrFail(PhaseStateEntity, { id: held.id });
      const afterRows = await manager.find(TaskStateEntity, { where: { phaseStateId: held.id } });
      const view = taskViews({ phase, tasks, state: after, rows: afterRows, view: 'full' }).find(
        (one) => one.key === taskKey,
      )!;
      return { version, workspace, task: view };
    });
  }

  /**
   * Pin the day the sandbox calls today for this phase, or clear it.
   *
   * The third member of the narrow-write family beside `saveWorkspace` and
   * `reflect`, and for the same reason: the entity was read before this request
   * did its work, and `save(state)` would post a stale `workspace` back over the
   * autosave that landed while the learner was reaching for the control.
   *
   * Testing only. A clock on a phase whose check is not a suite would be a
   * setting that changes nothing, which is worse than a refusal that says why.
   * It is a parameter of the next run, not an event: it spends no attempt,
   * clears no `ranBeforeSubmit`, and invalidates no verdict.
   */
  async setRunClock(
    userId: string,
    phaseStateId: string,
    date: string | null | undefined,
  ): Promise<RunClockSaved> {
    const { state, phase } = await this.loadOwnedState(userId, phaseStateId);
    if (phase.checks.kind !== 'tests') {
      throw new BadRequestException('the run clock belongs to the testing phase');
    }
    const runClock = this.validRunClock(date);
    await this.phaseStates.update(state.id, { runClock });
    state.runClock = runClock;
    return { saved: true, runClock };
  }

  /**
   * The date, or null for the machine's clock.
   *
   * The pattern is checked here as well as in the DTO because this is the last
   * gate before the column, and the column is what the runner is handed. A year
   * outside 1970..2100 is refused with the same sentence: a clock set by
   * mistyping a year is a confusing suite rather than a security problem, and
   * one sentence is all a learner needs to fix it.
   */
  private validRunClock(date: string | null | undefined): string | null {
    if (date === null || date === undefined || date === '') return null;
    const bad = new BadRequestException(RUN_CLOCK_MESSAGE);
    if (typeof date !== 'string' || !RUN_CLOCK_PATTERN.test(date)) throw bad;
    const at = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) throw bad;
    const year = Number(date.slice(0, 4));
    if (year < RUN_CLOCK_MIN_YEAR || year > RUN_CLOCK_MAX_YEAR) throw bad;
    return date;
  }

  async reflect(userId: string, phaseStateId: string, reflection: string): Promise<void> {
    const { state } = await this.loadOwnedState(userId, phaseStateId);
    // Narrow for the same reason as saveWorkspace, and the other way round
    // too: the reflection box and the editor are on screen together, so a
    // whole-row write from either one posts a stale copy of the other.
    await this.phaseStates.update(state.id, { reflection: reflection.trim() });
  }

  /**
   * Advance only on retained, strict evidence. Reflections remain optional.
   */
  async advance(userId: string, phaseStateId: string): Promise<EnrollmentView> {
    const { state, enrollment } = await this.loadOwnedState(userId, phaseStateId);
    const project = this.content.getForEnrollment(enrollment);
    await this.transaction(async manager => {
      const held = await heldEnrollment(manager, { id: enrollment.id, userId });
      const states = await manager.find(PhaseStateEntity, { where: { enrollmentId: held.id }, order: { phaseOrder: 'ASC' } });
      const current = states.find(p => p.id === state.id)!;
      if (held.currentPhaseOrder > current.phaseOrder) return; // retried advance
      // The fifth writer of a phase's status.
      //
      // Two verdicts for the last two required tasks can each write their own
      // row and then read the task set without seeing the other's commit: the
      // phase is left `submitted` with every required task `passed`, and no
      // later verdict corrects it, a countersignature happens once. So the
      // roll-up is recomputed from the rows here and **persisted**, because a
      // heal that moved only `strictPass`'s own copy would leave the map, the
      // tile, the door and the completion assertion reading a phase that never
      // opened, for ever.
      //
      // It is before the precondition on purpose, and it is safe because of
      // two properties that are asserted rather than relied on
      // (`workflow.service.spec.ts`, "advance on a phase of many tasks"):
      // it is inside `this.transaction`, so a `BadRequestException` below rolls
      // it back with everything else; and `strictPass` re-reads the task rows
      // **after** this write, so a lost race ends at the strict-evidence gate
      // rather than in a phase this call opened on a stale read.
      //
      // `Object.assign` and not a re-read, so the precondition's test and
      // `strictPass`'s own are two tests of one value. It holds the same
      // pessimistic **enrolment** lock the other four roll-up writers take
      // (`advance` took it at the top of this transaction) so the five are
      // serialised on one row.
      const currentTasks = this.content.getTasksForEnrollment(held, current.phaseKey);
      // The reader's rule: a heal has no meaning for a phase whose status IS
      // its sole task's status, so a sole-task board reads no task row and
      // writes none.
      if (!soleTaskList(currentTasks)) {
        const roll = phaseRollup(
          current,
          currentTasks,
          await manager.find(TaskStateEntity, { where: { phaseStateId: current.id } }),
          { passed: current.status === 'passed', overall: current.bestScore ?? 0 },
          new Date().toISOString(),
        );
        if (roll.status !== current.status || roll.passedAt !== current.passedAt) {
          // The narrow `{ id }` predicate, never a whole-row `save`.
          await manager.update(PhaseStateEntity, { id: current.id }, roll);
          Object.assign(current, roll);
        }
      }
      // Two refusals, each in its own true words: a phase ahead of the one the
      // learner stands on (a teacher's Unlock early and Pass) may well read
      // passed, and "must pass" would tell them something false about it. The gate is the same two conditions. A phase
      // behind them never reaches this line (the retried advance above), so
      // this one is always a phase ahead; and it promises nothing about what
      // reaching it opens, because over a board-only Pass the strict gate
      // still wants a reviewed pass there.
      if (held.currentPhaseOrder !== current.phaseOrder) throw new BadRequestException('This phase is ahead of the one you are on, so it cannot be continued from yet. Finish the phase you are on first.');
      if (current.status !== 'passed') throw new BadRequestException('This phase must pass before advancing.');
      const strictPass = async (target: PhaseStateEntity): Promise<boolean> => {
        const phase = project.phases.find(p => p.key === target.phaseKey);
        if (!phase || target.status !== 'passed') return false;
        // The gate is asked of every REQUIRED task of
        // the version this enrolment is pinned to, and of nothing else. An
        // optional task is shown, attempted and scored, and moves no gate.
        const tasks = this.content.getTasksForEnrollment(held, target.phaseKey);
        // A required set that somehow came back empty reads shut, the same
        // conjunct and the same direction as `phaseRollup`'s `requiredKeys.size
        // > 0`: the compiler refuses a phase with no required task, so this is
        // belt and braces rather than a case anyone can author.
        if (!tasks.some(task => task.required)) return false;
        // The per-task question (evidence, the row, the countersignature) is
        // `requiredTasksWithoutEvidence`, shared with the room's
        // `evidenceNeeded` so the room gets this gate's own answer and not a
        // second reading of it. Asked on this transaction's manager, after the
        // heal above.
        return (await requiredTasksWithoutEvidence(manager, target, tasks, userId)).length === 0;
      };
      if (!await strictPass(current)) throw new BadRequestException('Submit this phase for a strict evidence review before advancing. Earlier feedback remains in your history.');
      const nextPhase = nextPhaseOf(project, current.phaseKey);
      const next = nextPhase && states.find(p => p.phaseKey === nextPhase.key);
      if (nextPhase && !next) throw new ConflictException('The next phase record is missing. Reload the course to recover it.');
      if (!nextPhase) {
        // The project's last phase: complete when every phase this version holds passes the strict gate.
        const complete = await Promise.all(project.phases.map(async phase => {
          const target = states.find(p => p.phaseKey === phase.key);
          return !!target && await strictPass(target);
        }));
        if (project.phases.length === 0 || complete.some(passed => !passed)) throw new BadRequestException('Course completion requires a strict, evidenced Pass in every phase.');
      }
      // The release is named by the phase's place, v1 to vn: the
      // stored order for every contiguous version, and 1 to n for one whose
      // stored orders are not.
      await manager.createQueryBuilder().insert().into(ReleaseRecordEntity).values({ enrollmentId: held.id, userId, phaseStateId: current.id, phaseKey: current.phaseKey, phaseOrder: current.phaseOrder, version: `v${placeOf(project, current.phaseKey)}`, score: current.bestScore, notes: current.reflection?.trim() || null }).orIgnore().execute();
      if (next) {
        if (next.status === 'locked') {
          await this.seedCarriedArtefacts(held, next, project);
          const acceptedScreenCopy = nextPhase.files.some(file => file.path === SCREEN_COPY_PATH)
            ? current.phaseKey === 'design'
              ? await requireAcceptedDesignScreenCopy(manager, this.content, held)
              : await resolveScreenCopy(manager, this.content, held, current)
            : null;
          await manager.update(PhaseStateEntity, { id: next.id, status: 'locked' }, { status: 'in_progress', unlockedAt: new Date().toISOString(), workspace: next.workspace, acceptedScreenCopy });
        }
        await manager.update(EnrollmentEntity, held.id, { currentPhaseOrder: next.phaseOrder });
      } else {
        await manager.update(EnrollmentEntity, held.id, { completed: true, completedAt: held.completedAt ?? new Date().toISOString() });
      }
    });
    // Submissions remain evidence: pruning their source after advancing would lose the portfolio.
    return this.enrollmentView(await this.enrollments.findOneByOrFail({ id: enrollment.id }));
  }

  /**
   * Work carried across the gate. Maintenance opens on a change request
   * against the system the learner designed, so its `design/contracts.json`
   * starts as the operations they wrote in `design/design.json` rather than an
   * empty list: amending a contract is the exercise, retyping it is not.
   * Everything here is best-effort: a phase that declares no such file, a
   * learner who never filled the design record, or an unparseable edit all
   * leave the scaffold exactly as the content pack shipped it.
   */
  private async seedCarriedArtefacts(
    enrollment: EnrollmentEntity,
    next: PhaseStateEntity,
    project: ProjectContent,
  ): Promise<void> {
    // The bytes come from `seededBytesFor`, which the learner's task reset
    // also reads.
    const seeded = await this.seededBytesFor(enrollment, next, project);
    if (!Object.keys(seeded).length) return;
    next.workspace = { ...(next.workspace || {}), ...seeded };
  }

  /** The paths the server seeds on a phase of this project (see `seededBytesFor`). */
  private seededPathsOf(project: ProjectContent, phaseKey: string): Set<string> {
    if (phaseKey !== 'maintenance') return new Set();
    const phase = project.phases.find((p) => p.key === phaseKey);
    const target = phase?.files.find((f) => f.editable && /(^|\/)contracts\.json$/i.test(f.path));
    return new Set(target ? [target.path] : []);
  }

  /**
   * What the server would seed into this phase's workspace now, by path, and
   * nothing when it would seed nothing. Pure of `phaseState`: it reads the
   * workspace it is given and writes none (`advance`'s seed and the learner's
   * reset of a seeded path read this one function).
   */
  private async seededBytesFor(
    enrollment: EnrollmentEntity,
    phaseState: Pick<PhaseStateEntity, 'phaseKey' | 'workspace'>,
    project: ProjectContent,
  ): Promise<Record<string, string>> {
    if (phaseState.phaseKey !== 'maintenance') return {};
    const phase = project.phases.find((p) => p.key === phaseState.phaseKey);
    const target = phase?.files.find((f) => f.editable && /(^|\/)contracts\.json$/i.test(f.path));
    if (!target) return {};

    // Never overwrite work: only a workspace that has not been written here.
    const held = phaseState.workspace ? phaseState.workspace[target.path] : undefined;
    if (typeof held === 'string' && held.trim() && held.trim() !== (target.content || '').trim()) {
      return {};
    }

    const sourcePath = this.content
      .designFilesFor(project)
      .find((path) => /(^|\/)design\.json$/i.test(path));
    if (!sourcePath) return {};
    const design = await this.phaseStates.findOne({
      where: { enrollmentId: enrollment.id, phaseKey: 'design' },
    });
    const operations = operationsFromDesign(design?.workspace ? design.workspace[sourcePath] : null);
    if (!operations.length) return {};

    return { [target.path]: `${JSON.stringify({ operations }, null, 2)}\n` };
  }

  /**
   * Replace the phase's link set. A link is a claim: this test proves that
   * criterion, so the set is stored whole rather than merged: removing a link
   * has to be as easy as making one, or a learner cannot retract a claim.
   */
  async saveLinks(
    userId: string,
    phaseStateId: string,
    links: PhaseLinkInput[],
  ): Promise<PhaseLink[]> {
    const { state } = await this.loadOwnedState(userId, phaseStateId);
    if (!Array.isArray(links)) throw new BadRequestException('links must be a list');
    if (links.length > LINKS_MAX) {
      throw new BadRequestException(
        `a phase holds at most ${LINKS_MAX} links — remove some before adding more`,
      );
    }

    const seen = new Set<string>();
    const clean: PhaseLink[] = [];
    for (const link of links) {
      const from = String(link.from ?? '').trim();
      const to = String(link.to ?? '').trim();
      if (!from || !to) continue;
      if (link.kind !== 'verifies' && link.kind !== 'covers') continue;
      // Ids, not prose: the DTO says so and every reader of this column
      // believes it, so the rule holds here whatever route the set came by.
      if (!LINK_TARGET_PATTERN.test(to)) throw new BadRequestException(LINK_TARGET_MESSAGE);
      if (!LINK_SOURCE_PATTERN.test(from)) throw new BadRequestException(LINK_SOURCE_MESSAGE);
      const key = `${link.kind}\u0000${from}\u0000${to}`;
      if (seen.has(key)) continue; // the same claim twice is one claim
      seen.add(key);
      clean.push({ from, to, kind: link.kind, at: stampedAt(link.at) });
    }

    // A partial update, not save(state): save() writes back every column that
    // differs from the row, and this entity was loaded before the request did
    // its work. The autosave debounce writes `workspace` from every keystroke,
    // so a save() here would post a stale copy of the learner's files over the
    // one they are typing into. Only the column this route owns goes back.
    await this.phaseStates.update(state.id, { links: clean });
    return clean;
  }

  /* --------------------------------- drill -------------------------------- */

  /**
   * The drill is the deployment phase's incident: the content pack declares a
   * faulted copy of the container, and only a phase that declares one can be
   * paged. Every drill route loads through here, so a phase without a drill
   * answers the same way whichever route was called.
   */
  private requireDrill(phase: PhaseContent): DrillSpec {
    const spec = this.content.drillSpec(phase);
    if (!spec) {
      throw new BadRequestException(`the ${phase.key} phase has no incident drill`);
    }
    return spec;
  }

  /** The learner's runbook as it stands, whatever the pack chose to call it. */
  private runbookOf(phase: PhaseContent, state: PhaseStateEntity): string | null {
    const files = this.content.executionFiles(phase, state.workspace);
    const path = Object.keys(files).find((p) => /(^|\/)runbook\.md$/i.test(p));
    return path ? files[path] : null;
  }

  /**
   * One drill write at a time per phase state, over the drill as the row holds
   * it now rather than as the request read it.
   *
   * All three drill routes read `drill`, run a sandbox check that takes
   * seconds, and then write the column back. The health check and the resolve
   * are two buttons on one panel, so the overlap is the normal case rather
   * than a race a class of thirty has to be unlucky to hit, and a second
   * whole-column write would post a copy of the drill from before the first
   * one, silently dropping either the health reading or the incident record. The mutation
   * runs against a fresh read inside the critical section, so whichever lands
   * second merges onto the other instead of replacing it.
   *
   * The section holds a read and a narrow update, never the sandbox run, so a
   * health check does not queue behind another learner's resolve.
   */
  private drillLocks = new Map<string, Promise<unknown>>();

  /** Runs `op` after every drill write already queued on this phase state, one at a time. */
  private drillLocked<T>(phaseStateId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.drillLocks.get(phaseStateId) ?? Promise.resolve();
    const next = previous.then(op, op);
    // The chain carries no rejection forward, and the map does not grow: the
    // entry is dropped once nothing is queued behind it.
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.drillLocks.set(phaseStateId, settled);
    void settled.then(() => {
      if (this.drillLocks.get(phaseStateId) === settled) this.drillLocks.delete(phaseStateId);
    });
    return next;
  }

  private drillWrite<T>(
    phaseStateId: string,
    mutate: (held: DrillState | null) => { drill: DrillState; result: T },
  ): Promise<T> {
    return this.drillLocked(phaseStateId, () => this.applyDrillWrite(phaseStateId, mutate));
  }

  private async applyDrillWrite<T>(
    phaseStateId: string,
    mutate: (held: DrillState | null) => { drill: DrillState; result: T },
  ): Promise<T> {
    const fresh = await this.phaseStates.findOne({
      where: { id: phaseStateId },
      select: { id: true, drill: true },
    });
    const { drill, result } = mutate((fresh?.drill as DrillState | null) ?? null);
    // Only the drill column. The autosave writes `workspace` every 700 ms and
    // a grading writes the score; see saveLinks for why save(state) cannot be
    // used on a route that awaits a sandbox run first.
    await this.phaseStates.update(phaseStateId, { drill });
    return result;
  }

  /**
   * The smoke run every drill route makes, with the outage separated from the
   * verdict. `runSmokeCheck` throws when the sandbox could not be reached at
   * all, and that is not an answer about the learner's container: recorded as
   * a failing health check it would both accuse them of breaking something
   * they did not and manufacture the red half of the red-then-green rule. So
   * the routes answer 503, write nothing, and say the runner is the problem.
   */
  private async drillSmoke(
    phase: PhaseContent,
    files: Record<string, string>,
  ): Promise<SmokeCheckResult> {
    try {
      return await this.feedback.runSmokeCheck(phase, files);
    } catch (err) {
      if (!isRunnerDown(err)) throw err;
      throw new ServiceUnavailableException(RUNNER_UNAVAILABLE_MESSAGE);
    }
  }

  /**
   * Page the learner. The smoke check runs against the faulted copy of their
   * container, so the stderr they read is the failure they were paged for and
   * not something they typed. Nothing about the faulted copy is stored: it is
   * the content pack's, and it is laid over their files again on every run.
   * Paging twice re-runs the check and keeps the drill already in progress:
   * a reloaded page must not erase an incident record half written.
   *
   * What that run said is kept, though (`pagedExit`): it is the check that was
   * red, and `drillResolve` will not close an incident without one.
   */
  async drillStart(
    userId: string,
    phaseStateId: string,
  ): Promise<DrillState & { beforeStderr: string }> {
    const { state, phase } = await this.loadOwnedState(userId, phaseStateId);
    const spec = this.requireDrill(phase);
    const faulted = this.content.faultedExecutionFiles(phase, state.workspace);
    if (!faulted) throw new BadRequestException(`the ${phase.key} phase has no incident drill`);

    const before = await this.drillSmoke(phase, faulted);
    const pagedExit = before.ok ? 0 : 1;
    // A phase with a runbook record keeps no markdown copy: the record is the runbook.
    const runbookBefore = hasRecord(phase.checks) ? null : this.runbookOf(phase, state);
    const drill = await this.drillWrite<DrillState>(state.id, (held) => {
      const next: DrillState = held
        ? { ...held, pagedExit }
        : {
            fault: spec.fault,
            pagedAt: new Date().toISOString(),
            runbookBefore,
            pagedExit,
            healthRanAt: null,
            healthExit: null,
            fixAppliedAt: null,
            resolvedAt: null,
            incident: null,
          };
      return { drill: next, result: next };
    });
    // stdout as well as stderr, and stderr still first. `ops/selfcheck.py` refuses politely: it prints its
    // one sentence on **stdout** and exits 1. So for a learner whose container
    // already starts (the ordinary case, and the one the pack's own task asks
    // them to be in before they page themselves) `stderr` is empty and the
    // drill panel they are paged with would have nothing in it at all: nothing to
    // diagnose, and nothing to write the incident record from. Inert for a
    // smoke run that does write to stderr, because stderr is still read first.
    return { ...drillWithIncident(drill, state.workspace, phase), beforeStderr: before.stderr || before.stdout || before.problem || '' };
  }

  /**
   * The health check: the same smoke run, against whatever the learner has
   * saved now. The result is stored because "did you check before you claimed
   * it was fixed?" is part of what the phase teaches.
   */
  async drillHealth(
    userId: string,
    phaseStateId: string,
  ): Promise<{ exit: number; stdout: string; stderr: string; startedBy: string }> {
    const { state, phase } = await this.loadOwnedState(userId, phaseStateId);
    this.requireDrill(phase);
    if (!state.drill) {
      throw new BadRequestException('start the drill before running a health check');
    }

    const smoke = await this.drillSmoke(
      phase,
      this.content.executionFiles(phase, state.workspace),
    );
    const exit = smoke.ok ? 0 : 1;
    const now = new Date().toISOString();
    await this.drillWrite(state.id, (held) => {
      const drill = held ?? (state.drill as DrillState);
      return {
        drill: {
          ...drill,
          healthRanAt: now,
          healthExit: exit,
          // The fix is dated from the first green check that followed a red
          // one, not from the write-up: a check that was green from the start
          // proves the container runs, not that anything was repaired.
          fixAppliedAt: drill.fixAppliedAt || (exit === 0 && !sawNoFailure(drill) ? now : null),
        },
        result: undefined,
      };
    });
    // The command comes from the learner's own ENTRYPOINT, and the panel puts
    // it above the output: a container's stdout is only a health verdict if
    // you can see what was run to get it.
    return {
      exit,
      stdout: smoke.stdout,
      stderr: smoke.stderr || smoke.problem || '',
      startedBy: smoke.argv.join(' '),
    };
  }

  /**
   * Close the incident. The write-up is only accepted once the container
   * actually starts again: an incident record that says "fixed" over a broken
   * container is the habit this phase exists to break.
   *
   * And only once a check has gone from red to green on this drill (decision
   * 3). The pack tells the learner to start the drill with their build check
   * already green, so "the container starts" is true before they read a word
   * of the incident: without this, a learner who finished the phase first
   * could close INCIDENT-1 straight off the page, having proved nothing. The
   * red is the paged run against the faulted copy; the green is a health check
   * against their own files. Their Dockerfile is never touched to arrange it.
   */
  async drillResolve(
    userId: string,
    phaseStateId: string,
    incident: { rootCause: string; fix: string; actionItem: string },
  ): Promise<DrillState & { workspaceUpdatedAt: string | null }> {
    const { state, phase } = await this.loadOwnedState(userId, phaseStateId);
    this.requireDrill(phase);
    // A Deployment its pinned version holds in the older format is not
    // resolved: 409 with the room's own sentence, before the smoke run or any
    // write, as its submit, run and regrade answer.
    const older = olderFormatRoomSentence(phase);
    if (older) throw new ConflictException(older);
    if (!state.drill) throw new BadRequestException('start the drill before resolving it');
    // Read before the sandbox: an invalid stored runbook is refused without a smoke run.
    const runbook = hasRecord(phase.checks) ? this.resolvableRunbook(phase, state) : null;

    const smoke = await this.drillSmoke(
      phase,
      this.content.executionFiles(phase, state.workspace),
    );
    if (!smoke.ok) {
      const detail =
        smoke.problem || failureLine(smoke.stderr) || 'the container still does not start';
      throw new ConflictException(
        `the smoke check still fails — ${detail}. Fix the container and run the health check, then resolve.`,
      );
    }

    const now = new Date().toISOString();
    if (runbook) {
      return this.drillLocked(state.id, () => this.resolveIntoRecord(state, phase, runbook, incident, now));
    }
    // A drill phase with no runbook that is not an older Deployment (a config
    // phase under another key) keeps the write it had: the incident on the
    // stored drill, and no save stamp moved.
    const drill = await this.drillWrite<DrillState>(state.id, (held) => {
      const drill = held ?? (state.drill as DrillState);
      if (!drill.fixAppliedAt) throw new ConflictException(NO_RED_TO_GREEN);
      const next: DrillState = {
        ...drill,
        resolvedAt: now,
        incident: {
          rootCause: incident.rootCause.trim(),
          fix: incident.fix.trim(),
          actionItem: incident.actionItem.trim(),
        },
      };
      return { drill: next, result: next };
    });
    return { ...drill, workspaceUpdatedAt: state.workspaceUpdatedAt ?? null };
  }

  /**
   * The runbook a resolve writes the incident into, as the request read it:
   * the workspace's record, or the version's starting one when the learner
   * never saved it. One that does not validate is refused with the fixed
   * sentence. Nothing can change it unseen before the write: every write to
   * `workspace` (a save, a task reset, an Agentic apply, an instructor's
   * workspace or phase reset) moves `workspaceUpdatedAt`, which the resolve's
   * UPDATE quotes.
   */
  private resolvableRunbook(phase: PhaseContent, state: PhaseStateEntity): Runbook {
    const text = (state.workspace ?? {})[RUNBOOK_JSON] ?? phase.files.find((f) => f.path === RUNBOOK_JSON)?.content ?? '';
    const runbook = validateRunbookRecord(text).runbook;
    if (!runbook) throw new BadRequestException(RUNBOOK_RESOLVE_INVALID);
    return runbook;
  }

  /**
   * The resolve of a phase with a runbook: the record's incident and
   * its three timeline lines, and `drill.resolvedAt`, in one UPDATE of both
   * columns guarded by the `workspaceUpdatedAt` read at the start of this
   * request, with a new stamp as `saveWorkspace` writes one. The stored
   * drill's `incident` key is never written. The record is validated as it
   * will be stored, so its one incident writer never stores bytes its reader
   * refuses: a write-up it cannot hold is refused with the save's sentence. A
   * save that landed while the smoke check ran wins: 409 with the fixed
   * sentence, nothing written. Runs inside the drill lock, so a health check
   * cannot interleave.
   */
  private async resolveIntoRecord(
    state: PhaseStateEntity,
    phase: PhaseContent,
    runbook: Runbook,
    incident: { rootCause: string; fix: string; actionItem: string },
    now: string,
  ): Promise<DrillState & { workspaceUpdatedAt: string }> {
    const fresh = await this.phaseStates.findOne({ where: { id: state.id }, select: { id: true, drill: true } });
    const drill = (fresh?.drill ?? state.drill) as DrillState;
    if (!drill.fixAppliedAt) throw new ConflictException(NO_RED_TO_GREEN);
    const workspace = { ...(state.workspace ?? {}) };
    const timeline = [
      { at: drill.pagedAt, event: DRILL_TIMELINE_EVENTS.paged },
      { at: drill.fixAppliedAt, event: DRILL_TIMELINE_EVENTS.fixed },
      { at: now, event: DRILL_TIMELINE_EVENTS.closed },
    ].map((one) => ({ at: one.at.slice(0, RUNBOOK_CAPS.timelineAt), event: one.event }));
    workspace[RUNBOOK_JSON] = serialiseRunbook({
      ...runbook,
      incident: { rootCause: incident.rootCause.trim(), fix: incident.fix.trim(), actionItem: incident.actionItem.trim(), timeline },
    });
    const stored = validateRunbookRecord(workspace[RUNBOOK_JSON]);
    if (stored.error) throw new BadRequestException(runbookSaveRefusal(stored.error));
    const next: DrillState = { ...drill, resolvedAt: now };
    const stamp = state.workspaceUpdatedAt ?? null;
    const version = new Date(Math.max(Date.now(), (Date.parse(stamp ?? '') || 0) + 1)).toISOString();
    const write = this.phaseStates
      .createQueryBuilder()
      .update(PhaseStateEntity)
      .set({ drill: next, workspace, workspaceUpdatedAt: version })
      .where('id = :id', { id: state.id });
    if (stamp) write.andWhere('"workspaceUpdatedAt" = :stamp', { stamp });
    else write.andWhere('"workspaceUpdatedAt" IS NULL');
    const saved = await write.execute();
    if (!saved.affected) throw new ConflictException(RUNBOOK_RESOLVE_CONFLICT);
    return { ...drillWithIncident(next, workspace, phase), workspaceUpdatedAt: version };
  }

  async markRan(phaseStateId: string): Promise<void> {
    await this.phaseStates.update(phaseStateId, { ranBeforeSubmit: true });
  }
}

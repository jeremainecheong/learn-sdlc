import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import type {
  CohortPhaseSchedule,
  CohortScheduleView,
  PhaseKey,
  PhaseStatus,
} from '@learnsdlc/shared';
import { ContentService } from '../content/content.service';
import { CohortEntity, CohortPhaseScheduleEntity, EnrollmentEntity, UserEntity } from '../db/entities';
import { recordAudit } from '../audit/audit';
import { InstructorCaller, UNATTACHED_COHORT } from './cohort-scope';
import { CohortScheduleDto } from './instructor.dto';
import { DISPLAY_LOCALE } from '../config/locale';

/** One phase's dates, as everything downstream of the table reads them. */
export interface PhaseDates {
  opensAt: string | null;
  dueAt: string | null;
}

/**
 * A class's dates for one project, keyed by phase. An empty map is a class
 * with no dates, which is the honest starting state and the only state a
 * deployment that never opens this panel will ever have.
 */
export type ScheduleMap = Map<PhaseKey, PhaseDates>;

/** Shared, and never written to: a class with no dates has nothing to say. */
export const NO_SCHEDULE: ScheduleMap = new Map();

/**
 * Whether the class has yet to open this phase.
 *
 * The stored instant is an ISO string in UTC, so this is a comparison of two
 * instants and nothing about anybody's timezone. A phase with no open date is
 * never shut by the schedule; the gate the learner already has is the only
 * one there is.
 */
export function scheduledShut(opensAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!opensAt) return false;
  const at = Date.parse(opensAt);
  // An unreadable date opens the phase rather than shutting it: a typo in the
  // table must not be able to lock a class out of its coursework.
  return Number.isNaN(at) ? false : now < at;
}

/**
 * The status a learner is actually in, with the class's dates applied.
 *
 * This is the one function the phase card, the stepper and the gate all read,
 * which is what stops the card saying "locked" while the route still accepts a
 * submission. It overlays rather than writes: nothing about the row changes
 * when the date passes, so moving the date moves the answer immediately.
 */
export function effectivePhaseStatus(
  status: PhaseStatus,
  opensAt: string | null | undefined,
  now: number = Date.now(),
): PhaseStatus {
  return scheduledShut(opensAt, now) ? 'locked' : status;
}

/**
 * Whether a submission was made after the class's due date.
 *
 * Derived, never stored: nothing is written on the submission, so moving a
 * deadline immediately moves what counts as late and a class with no dates has
 * no lateness at all. A due date never blocks anything; this is a fact about
 * a submission, not a policy about it.
 */
export function isLate(
  createdAt: Date | string | null | undefined,
  dueAt: string | null | undefined,
): boolean {
  if (!dueAt || createdAt == null) return false;
  const due = Date.parse(dueAt);
  const made = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
  return Number.isNaN(due) || Number.isNaN(made) ? false : made > due;
}

/**
 * An instant as a person reads it: "9 September at 09:00".
 *
 * The zone is the machine's, because in the local-first shape the instructor's
 * browser and the API are the same laptop (docs/production-runbook.md §3a), so
 * printing the stored instant in the machine's zone is exact rather than a
 * guess. The zone can be named for a test that must not depend on where it runs.
 */
export function describeInstant(iso: string, timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const options: Intl.DateTimeFormatOptions = timeZone ? { timeZone } : {};
  const day = at.toLocaleDateString(DISPLAY_LOCALE, { ...options, day: 'numeric', month: 'long' });
  const time = at.toLocaleTimeString(DISPLAY_LOCALE, {
    ...options,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${day} at ${time}`;
}

/** What a learner is told when the class has not opened the phase yet. */
export function opensAtMessage(opensAt: string, timeZone?: string): string {
  return `This phase opens on ${describeInstant(opensAt, timeZone)}.`;
}

/** The zone the dates are printed in: this machine's, named so nobody has to guess. */
export function machineTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The class's dates for one project, keyed by phase.
 *
 * A module function rather than a method because three services need it
 * (the learner's board, the gate and the instructor console) and none of them
 * should have to take a dependency on the panel's controller-facing service to
 * read two dates. The unattached cohort is not a class (`cohort-scope.ts`), so
 * it never has dates and is answered without a query.
 */
export async function scheduleForCohort(
  manager: EntityManager,
  cohortId: string | null | undefined,
  projectSlug: string,
): Promise<ScheduleMap> {
  if (!cohortId || cohortId === UNATTACHED_COHORT) return NO_SCHEDULE;
  const rows = await manager.find(CohortPhaseScheduleEntity, { where: { cohortId, projectSlug } });
  if (!rows.length) return NO_SCHEDULE;
  return new Map(rows.map((row) => [row.phaseKey, { opensAt: row.opensAt, dueAt: row.dueAt }]));
}

/**
 * The dates that apply to one learner: their class's, for the project they are
 * enrolled on. One primary-key lookup for the cohort, and no second query at
 * all for a learner who has not joined a class.
 */
export async function scheduleForLearner(
  manager: EntityManager,
  userId: string,
  projectSlug: string,
): Promise<ScheduleMap> {
  const learner = await manager.findOne(UserEntity, {
    where: { id: userId },
    select: ['id', 'cohort'],
  });
  return scheduleForCohort(manager, learner?.cohort, projectSlug);
}

/**
 * When a class opens a phase, and when its work is due.
 *
 * Two dates per phase per class, and nothing else. A release date holds a
 * phase shut until it arrives; a due date does not hold anything, it marks
 * work late. Neither is copied onto a learner's row, so an instructor moving a
 * date changes what every learner sees on their next request and never has to
 * be reconciled with anything.
 */
@Injectable()
export class ScheduleService {
  private readonly logger = new Logger(ScheduleService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly content: ContentService,
  ) {}

  /* ------------------------------- routes ------------------------------- */

  async getSchedule(
    caller: InstructorCaller,
    cohortId: string,
    projectSlug?: string,
  ): Promise<CohortScheduleView> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);
    // Fail loudly on a typo'd slug: an empty table looks like a class with no
    // dates, which is the one answer nobody could tell from a mistake. With no
    // slug at all the first pack in the catalogue is the answer, which is the
    // one a single-project deployment wants and never a wrong guess, because
    // the view says which project it is describing.
    const project = this.content.getProject(projectSlug ?? this.content.listProjects()[0].slug);
    const dates = await scheduleForCohort(manager, cohortId, project.slug);
    return this.view(cohortId, project.slug, this.phaseRows(project.slug, dates));
  }

  /**
   * Replace this class's dates for one project.
   *
   * A save is the whole table, not a patch: the panel sends six rows and a
   * blank cell means "no date", so a phase the instructor cleared has to lose
   * its row rather than keep the value the request did not mention. Rows the
   * request does not name are left alone, because a save is scoped to the
   * project it names.
   */
  async saveSchedule(
    caller: InstructorCaller,
    cohortId: string,
    dto: CohortScheduleDto,
  ): Promise<CohortScheduleView> {
    const manager = this.dataSource.manager;
    await this.requireOwnedCohort(manager, caller, cohortId);
    const project = this.content.getProject(dto.projectSlug);
    const known = new Set(project.phases.map((phase) => phase.key));

    const wanted = new Map<PhaseKey, PhaseDates>();
    for (const row of dto.phases) {
      if (!known.has(row.phaseKey)) {
        throw new BadRequestException(`${project.slug} has no ${row.phaseKey} phase`);
      }
      const opensAt = normaliseInstant(row.opensAt);
      const dueAt = normaliseInstant(row.dueAt);
      if (opensAt && dueAt && Date.parse(dueAt) < Date.parse(opensAt)) {
        throw new BadRequestException('A phase cannot be due before it opens.');
      }
      wanted.set(row.phaseKey, { opensAt, dueAt });
    }

    const existing = await manager.find(CohortPhaseScheduleEntity, {
      where: { cohortId, projectSlug: project.slug, phaseKey: In([...wanted.keys()]) },
    });
    const byKey = new Map(existing.map((row) => [row.phaseKey, row]));
    const empty: string[] = [];
    for (const [phaseKey, dates] of wanted) {
      const row = byKey.get(phaseKey);
      if (!dates.opensAt && !dates.dueAt) {
        // A cleared row is the absence of a date, not a row holding two nulls:
        // one shape for "nothing is scheduled" is one shape to read.
        if (row) empty.push(row.id);
        continue;
      }
      if (row) {
        await manager.update(CohortPhaseScheduleEntity, { id: row.id }, dates);
      } else {
        await manager.save(
          manager.create(CohortPhaseScheduleEntity, {
            cohortId,
            projectSlug: project.slug,
            phaseKey,
            ...dates,
          }),
        );
      }
    }
    if (empty.length) await manager.delete(CohortPhaseScheduleEntity, { id: In(empty) });

    const dates = await scheduleForCohort(manager, cohortId, project.slug);
    const phases = this.phaseRows(project.slug, dates);
    this.logger.log({
      event: 'cohort.schedule',
      actorId: caller.id,
      cohortId,
      projectSlug: project.slug,
      set: phases.filter((row) => row.opensAt || row.dueAt).length,
    });
    await recordAudit(manager, {
      event: 'cohort.schedule',
      actorUserId: caller.id,
      subjectUserId: caller.id,
      targetId: cohortId,
      action: project.slug,
      detail: { projectSlug: project.slug, phases },
    });
    return this.view(cohortId, project.slug, phases);
  }

  /* ------------------------------- guards ------------------------------- */

  /**
   * The class has to be the caller's. A 404 rather than a 403, the rule every
   * instructor route here follows: guessing ids must tell a second instructor
   * nothing about which classes exist.
   */
  private async requireOwnedCohort(
    manager: EntityManager,
    caller: InstructorCaller,
    cohortId: string,
  ): Promise<CohortEntity> {
    const cohort =
      cohortId && cohortId !== UNATTACHED_COHORT
        ? await manager.findOne(CohortEntity, { where: { id: cohortId } })
        : null;
    const mine =
      cohort &&
      (caller.role === 'ADMIN' ||
        cohort.ownerUserId === caller.id ||
        caller.cohort === cohort.id);
    if (!mine) throw new NotFoundException('no class with that id in your classes');
    return cohort;
  }

  /* ------------------------------- shaping ------------------------------ */

  /** One row per phase the pack declares, in pack order, dated or not. */
  private phaseRows(projectSlug: string, dates: ScheduleMap): CohortPhaseSchedule[] {
    return this.content.getProject(projectSlug).phases.map((phase) => ({
      phaseKey: phase.key,
      opensAt: dates.get(phase.key)?.opensAt ?? null,
      dueAt: dates.get(phase.key)?.dueAt ?? null,
    }));
  }

  private view(
    cohortId: string,
    projectSlug: string,
    phases: CohortPhaseSchedule[],
  ): CohortScheduleView {
    return { cohortId, projectSlug, phases, timezone: machineTimezone() };
  }
}

/**
 * A date from the panel, stored as a UTC instant.
 *
 * `<input type="datetime-local">` sends a local wall time with no zone, and the
 * browser has already turned it into an instant by the time it reaches the
 * DTO; this normalises whatever arrives to the one spelling everything else
 * compares against. An empty string is a cleared cell, which is a null.
 */
function normaliseInstant(value: string | null | undefined): string | null {
  if (value == null || value === '') return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new BadRequestException('that is not a date this can store');
  return at.toISOString();
}

/** A class and a project name one schedule; neither alone does. */
export const scheduleKey = (cohort: string, projectSlug: string): string =>
  `${cohort}\u0000${projectSlug}`;

/**
 * The dates every class in this export has set, keyed by cohort then phase.
 * Only the classes and projects that actually appear are read, so an export
 * of one project does not ask about the other.
 */
export async function schedulesFor(
  manager: EntityManager,
  learners: UserEntity[],
  enrollments: EnrollmentEntity[],
): Promise<Map<string, ScheduleMap>> {
  const cohorts = [...new Set(learners.map((learner) => learner.cohort))];
  const slugs = [
    ...new Set(enrollments.map((enrollment) => enrollment.projectSlug)),
  ];
  const out = new Map<string, ScheduleMap>();
  for (const cohort of cohorts) {
    for (const slug of slugs) {
      // Keyed by class *and* project: two reference packs declare the same
      // six phase keys, so a class doing both would otherwise read one
      // project's deadlines against the other's work.
      out.set(
        scheduleKey(cohort, slug),
        await scheduleForCohort(manager, cohort, slug),
      );
    }
  }
  return out;
}

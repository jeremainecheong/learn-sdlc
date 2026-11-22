import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OVERRIDE_REASON_MIN, PHASE_ORDER, PHASE_OVERRIDE_ACTIONS, TASK_KEY_MAX_LENGTH } from '@learnsdlc/shared';
import type { PhaseKey, PhaseOverrideAction, RegradeScope } from '@learnsdlc/shared';
import { AUDIT_MAX_LIMIT } from '../audit/audit';

// 'reset-phase' is the fourth lever; the one that starts a phase over rather
// than nudging its gate. It goes through the same DTO, and so through the
// same reason rule, as the other three, and so do the three per-task levers
// of teacher-authored projects.
// The list is re-exported from the shared contract rather than written out a
// second time; a literal here and a union there is two answers to one
// question, and the union is the one the service switches on.
export { PHASE_OVERRIDE_ACTIONS };

/** A project slug in an instructor query or body: at most this many characters. */
export const SLUG_MAX_LENGTH = 80;

/** A class or account id in an instructor or admin query or body: at most this many characters. */
export const ID_MAX_LENGTH = 80;

/** The reason a teacher gives for an override, a regrade or a sign-off: at most this many characters. */
export const REASON_MAX_LENGTH = 1000;

export class PhaseOverrideDto {
  @IsIn(PHASE_OVERRIDE_ACTIONS)
  action!: PhaseOverrideAction;

  /**
   * Every override lands in the audit log with this text, so it is required
   * rather than optional: an unexplained pass is what an appeal cannot answer.
   */
  @IsString()
  @MinLength(OVERRIDE_REASON_MIN, {
    message: `give a reason of at least ${OVERRIDE_REASON_MIN} characters — it is recorded with the override`,
  })
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;

  /**
   * Which task of the phase a per-task
   * lever is about.
   *
   * Optional, because the four phase levers name none, and shape-checked
   * rather than trusted: the service answers a key the pinned version does not
   * declare with the loader's own 404, and a lever applied to a guess is how a
   * teacher's countersignature lands on somebody else's work. The length is the
   * compiler's own bound on a task key (`TASK_KEY_MAX_LENGTH`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(TASK_KEY_MAX_LENGTH)
  taskKey?: string;
}

export class ExportQuery {
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  project?: string;

  /**
   * One class of the caller's. Optional: absent, the file covers every class
   * in the caller's scope; a class
   * outside it answers 404, as every other instructor read does.
   */
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX_LENGTH)
  cohort?: string;
}

/** The class map is per project: two classes on two projects share no artefacts. */
export class ClassMapQuery {
  @IsOptional()
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  project?: string;
}

/**
 * The most learners one class read answers. A
 * class larger than this is walked by its id cursor, a page a request, so the
 * read is bounded however large a class grows.
 */
export const CLASS_LEARNERS_PAGE = 50;

/**
 * `GET /instructor/learners`, the teacher home's
 * one read of a class. Every field is optional: no `cohort` reads every
 * learner the caller's scope holds; `after` is the last id of the page before;
 * `limit` is at most `CLASS_LEARNERS_PAGE` (50), which is also the default.
 */
export class ClassLearnersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cohort?: string;

  @IsOptional()
  @IsUUID()
  after?: string;

  /** Query strings arrive as text, so the number is asked for by name. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CLASS_LEARNERS_PAGE)
  limit?: number;
}

export class AuditQuery {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  learnerId?: string;

  /**
   * Query strings arrive as text and the global pipe transforms without
   * implicit conversion, so the number has to be asked for by name.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_LIMIT)
  limit?: number;

  /**
   * Where the last page stopped, as the token that page handed back
   * (`auditCursor`). Opaque to the console; a stale or unreadable one is the
   * start of the trail rather than a 400, which is why there is no format
   * check beyond a length.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/* ------------------------- instructor tooling ---------------------------- */

/**
 * Who a regrade covers. `stale-pack` is the everyday case (the learners whose
 * newest verdict came from a pack older than the one on disk) and `everyone`
 * is the escape hatch for a fix that did not change the version.
 */
export const REGRADE_SCOPES: RegradeScope[] = ['stale-pack', 'everyone'];

export class RegradeStartDto {
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  projectSlug!: string;

  @IsIn(PHASE_ORDER)
  phaseKey!: PhaseKey;

  @IsIn(REGRADE_SCOPES)
  scope!: RegradeScope;

  /**
   * Optional: a single learner, from their detail page. Shape-checked here as
   * well as in the service, so a malformed id never reaches a query.
   */
  @IsOptional()
  @IsUUID()
  userId?: string;

  /**
   * The same minimum an override's reason has, for the same reason: a class of
   * verdicts that changed with no explanation is what an appeal cannot answer.
   */
  @IsString()
  @MinLength(OVERRIDE_REASON_MIN, {
    message: `give a reason of at least ${OVERRIDE_REASON_MIN} characters — it is recorded with the regrade`,
  })
  @MaxLength(REASON_MAX_LENGTH)
  reason!: string;
}

export class SchedulePhaseDto {
  @IsIn(PHASE_ORDER)
  phaseKey!: PhaseKey;

  /**
   * Null is a value here, not an omission: it clears the date. `@IsOptional`
   * covers both, which is what the panel needs; a blank cell and an untouched
   * cell mean the same thing to an instructor.
   */
  @IsOptional()
  @IsISO8601()
  opensAt?: string | null;

  @IsOptional()
  @IsISO8601()
  dueAt?: string | null;
}

export class CohortScheduleDto {
  @IsString()
  @MaxLength(SLUG_MAX_LENGTH)
  projectSlug!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SchedulePhaseDto)
  @ArrayMaxSize(12)
  phases!: SchedulePhaseDto[];
}

/** `?project=`, the same shape the CSV export takes. */
export class GradebookQuery extends ExportQuery {}

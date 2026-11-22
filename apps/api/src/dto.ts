import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateNested,
  buildMessage,
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
// The form and the validator read one constant for each limit, so the counter
// the learner sees and the length the API accepts cannot drift.
import {
  COMMIT_MESSAGE_MAX,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  DRILL_ANSWER_MAX,
  DRILL_ANSWER_MIN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROFILE_BIO_MAX,
  PROFILE_GOALS_MAX,
  RUN_CLOCK_MESSAGE,
  RUN_CLOCK_PATTERN,
} from '@learnsdlc/shared';
import { isCommonPassword } from './auth/common-passwords';

/**
 * NIST SP 800-63B §5.1.1.2: screen new secrets against known-breached lists
 * and drop the composition rules people reach for instead. Demanding a
 * capital and a symbol does not make a guess harder: it herds everyone onto
 * the same few shapes, which is what the wordlists are full of.
 */
@ValidatorConstraint({ name: 'isNotCommonPassword', async: false })
class IsNotCommonPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    // A non-string is @IsString's complaint to make, not ours.
    return typeof value !== 'string' || !isCommonPassword(value);
  }

  defaultMessage(): string {
    return 'that password appears in public breach lists and would be guessed in seconds — try three unrelated words instead';
  }
}

/** Shared by every DTO that accepts a new password: registration, change, reset, admin set. */
export function IsNotCommonPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isNotCommonPassword',
      target: object.constructor,
      propertyName,
      options,
      validator: IsNotCommonPasswordConstraint,
    });
  };
}

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  password: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(DISPLAY_NAME_MIN)
  @MaxLength(DISPLAY_NAME_MAX)
  displayName: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  // No blocklist here on purpose: an account created before the rule exists
  // still has to get in to change its password, and the answer to a wrong
  // password is always the same 401 regardless of what was guessed.
  @IsString()
  @MinLength(1)
  password: string;
}

export class EnrollDto {
  /**
   * Optional, because the server is the one that knows the answer.
   *
   * A learner may say which project they are starting, and
   * `WorkflowService.enrollAsLearner` checks that claim against the project
   * they have actually been given. A request that says nothing is the same
   * request with the claim left out, and it is the one the browser sends: a
   * required slug would be whatever the tab remembered, including the
   * previous account's, on a shared machine.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  projectSlug?: string;
}

export class WorkspaceDto {
  @IsObject()
  files: Record<string, string>;

  /**
   * The `workspaceUpdatedAt` the sending tab last saw.
   *
   * Optional, and absent means "write it" unconditionally: the last-gasp
   * save on the way out has no version to quote and must never be refused.
   * When it is present and the row has moved on, the save is a 409 and the
   * tab is told, instead of both tabs reading "Saved" over one file.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  baseVersion?: string;
}

export class ReflectDto {
  @IsString()
  @MinLength(20, { message: 'a reflection needs at least 20 characters of real thought' })
  @MaxLength(4000)
  reflection: string;
}

/**
 * The message that rides with one submission. A commit subject:
 * one line, and short enough that it has to say the one thing that changed.
 *
 * Optional, because the fast loop must never be gated on prose: a revision
 * with no message is recorded as one. That is also what keeps every existing
 * caller working: `ValidationPipe` runs with `forbidNonWhitelisted: false`, so
 * a POST with no body at all arrives as `{}` and passes.
 */
export class SubmitDto {
  @IsOptional()
  @IsString()
  @MaxLength(COMMIT_MESSAGE_MAX, {
    message: `a commit message is one line of at most ${COMMIT_MESSAGE_MAX} characters`,
  })
  @Matches(/^[^\n\r]*$/, {
    message: `a commit message is one line of at most ${COMMIT_MESSAGE_MAX} characters`,
  })
  message?: string;
}

/**
 * `PUT /phases/:id/clock` pins the day the sandbox calls today, or clears it.
 * An absent or null date is the machine's clock, which is what clearing the
 * field means.
 */
export class ClockDto {
  @IsOptional()
  @Matches(RUN_CLOCK_PATTERN, { message: RUN_CLOCK_MESSAGE })
  date?: string | null;
}

export class ChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  phaseStateId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}



/** Deletion confirmation: the caller must echo their own email address. */
export class ConfirmDeleteDto {
  @IsEmail()
  email!: string;
}

/** Rename yourself. */
export class UpdateProfileDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  baseVersion?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  avatar?: number;

  @IsOptional()
  @IsString()
  @MaxLength(PROFILE_BIO_MAX)
  bio?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROFILE_GOALS_MAX)
  goals?: string;

  @IsOptional()
  @IsBoolean()
  onboardingCompleted?: boolean;

  /**
   * Trimmed before the length rule counts, not after. AccountService trims what
   * it stores, so without this "  " is two characters to the pipe, passes
   * @MinLength(DISPLAY_NAME_MIN), and lands as a blank name on the learner's
   * own row and on the instructor's list.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(DISPLAY_NAME_MIN)
  @MaxLength(DISPLAY_NAME_MAX)
  displayName!: string;
}

/**
 * Change your password. The new one goes through the same rules registration
 * uses (length and the breached-password blocklist) because a password set
 * here is exactly as exposed as one set at sign-up.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  currentPassword!: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  newPassword!: string;
}

/* ------------------------------ phase links ------------------------------ */

/** Both ends of a link are ids the learner picked from a list, never prose. */
const LINK_ID_MAX = 200;

/**
 * The shape of each end, enforced by the DTO and again by `saveLinks`, since
 * every page that draws the map, the journal, the dossier and the export
 * treats both as ids rather than as text somebody typed.
 *
 * `to` is a criterion id (`US-1/AC-2`, `AC-3`, a rubric key): one token of
 * letters, digits and the punctuation ids are written with. `from` names a
 * test, and a front-end test is named by the sentence inside `test('…')`, so
 * it is one line with no angle bracket and no control character, never
 * markup, never a second line.
 */
export const LINK_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
export const LINK_SOURCE_PATTERN = /^[^<>\p{Cc}]+$/u;
export const LINK_TARGET_MESSAGE = 'a link points at a criterion by its id, never by prose';
export const LINK_SOURCE_MESSAGE = 'a link starts from a test by its name, never by prose';

/** The learner's link set is replaced whole, so the cap is on the whole set. */
export const LINKS_MAX = 200;

/**
 * One learner-made link: a test (or other node) and the criterion it proves.
 * `at` is accepted so a client can replay a set it already holds, but the
 * service stamps its own timestamp when the value is missing or unparseable:
 * a link's age is evidence, and evidence the client writes is not evidence.
 */
export class PhaseLinkDto {
  @IsString()
  @MinLength(1)
  @MaxLength(LINK_ID_MAX)
  @Matches(LINK_SOURCE_PATTERN, { message: LINK_SOURCE_MESSAGE })
  from!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(LINK_ID_MAX)
  @Matches(LINK_TARGET_PATTERN, { message: LINK_TARGET_MESSAGE })
  to!: string;

  @IsIn(['verifies', 'covers'])
  kind!: 'verifies' | 'covers';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  at?: string;
}

/** `PUT /phases/:id/links` replaces the phase's link set. */
export class LinksDto {
  @IsArray()
  @ArrayMaxSize(LINKS_MAX, {
    message: `a phase holds at most ${LINKS_MAX} links — remove some before adding more`,
  })
  @ValidateNested({ each: true })
  @Type(() => PhaseLinkDto)
  links!: PhaseLinkDto[];
}

/* --------------------------------- drill --------------------------------- */

/**
 * At most `cap` UTF-16 code units: the length the runbook record's validator
 * reads. `@MaxLength` counts characters, so an emoji counts once there and
 * twice in the record, and a write-up it accepts could be one the record
 * refuses. Same message as `@MaxLength`.
 */
function MaxCodeUnits(cap: number, options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxCodeUnits',
      constraints: [cap],
      validator: {
        validate: (value: unknown) => typeof value !== 'string' || value.length <= cap,
        defaultMessage: buildMessage((each) => `${each}$property must be shorter than or equal to $constraint1 characters`, options),
      },
    },
    options,
  );
}

/**
 * INCIDENT-1's three answers. Twenty characters is the same floor a reflection
 * has: enough to say something, short enough that a real answer clears it.
 */
export class DrillIncidentDto {
  @IsString()
  @MinLength(DRILL_ANSWER_MIN, { message: `say what the root cause was, in at least ${DRILL_ANSWER_MIN} characters` })
  @MaxCodeUnits(DRILL_ANSWER_MAX)
  rootCause!: string;

  @IsString()
  @MinLength(DRILL_ANSWER_MIN, { message: `say what the fix was, in at least ${DRILL_ANSWER_MIN} characters` })
  @MaxCodeUnits(DRILL_ANSWER_MAX)
  fix!: string;

  @IsString()
  @MinLength(DRILL_ANSWER_MIN, { message: `name one action item, in at least ${DRILL_ANSWER_MIN} characters` })
  @MaxCodeUnits(DRILL_ANSWER_MAX)
  actionItem!: string;
}

/** `POST /phases/:id/drill/resolve` closes the drill. */
export class DrillResolveDto {
  @IsObject()
  @ValidateNested()
  @Type(() => DrillIncidentDto)
  incident!: DrillIncidentDto;
}

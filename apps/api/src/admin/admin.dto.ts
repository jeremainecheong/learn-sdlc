import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type Role } from '@learnsdlc/shared';
import { IsNotCommonPassword } from '../dto';
import { ID_MAX_LENGTH } from '../instructor/instructor.dto';

const ROLES: readonly Role[] = ['LEARNER', 'INSTRUCTOR', 'ADMIN'];

export class LookupUserQuery {
  @IsEmail()
  email!: string;
}

/** Every field optional: the console sends only what changed. */
export class UpdateUserDto {
  @IsOptional()
  @IsIn(ROLES as Role[])
  role?: Role;

  /** A cohort id, or 'default' to take the learner out of every class. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ID_MAX_LENGTH)
  cohort?: string;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

/**
 * Who a class is being moved to. An id rather than an address, because the
 * console already has the row it is looking at and an address typed twice is
 * an address typed wrong once.
 */
export class ReassignCohortOwnerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(ID_MAX_LENGTH)
  ownerUserId!: string;
}

/**
 * A password an admin sets is handed to the learner and typed at a login
 * form like any other, so it gets no exemption from the breach-list screen
 * registration applies.
 */
export class AdminSetPasswordDto {
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  password!: string;
}

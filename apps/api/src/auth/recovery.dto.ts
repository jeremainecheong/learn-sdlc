import { IsEmail, IsString, MaxLength, MinLength, ValidateIf, Matches } from 'class-validator';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@learnsdlc/shared';
import { IsNotCommonPassword } from '../dto';

export class ForgotDto {
  @IsEmail()
  email!: string;
}

/** A password set by an emailed link is refused on exactly the terms one set at sign-up is. */
export class ResetDto {
  @ValidateIf(o => o.email === undefined && o.code === undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  token?: string;

  @ValidateIf(o => o.email !== undefined || o.code !== undefined)
  @IsEmail() @MaxLength(254)
  email?: string;

  @ValidateIf(o => o.email !== undefined || o.code !== undefined)
  @IsString() @MinLength(1) @MaxLength(64) @Matches(/^\S+$/)
  code?: string;

  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH, { message: `password must be at least ${PASSWORD_MIN_LENGTH} characters` })
  @MaxLength(PASSWORD_MAX_LENGTH)
  @IsNotCommonPassword()
  password!: string;
}

export class VerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  token!: string;
}

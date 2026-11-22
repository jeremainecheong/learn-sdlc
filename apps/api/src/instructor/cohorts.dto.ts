import { IsString, MaxLength, MinLength } from 'class-validator';
import { CLASS_NAME_MAX, CLASS_NAME_MIN } from '@learnsdlc/shared';

export class CreateCohortDto {
  @IsString()
  @MinLength(CLASS_NAME_MIN)
  @MaxLength(CLASS_NAME_MAX)
  name!: string;
}

export class JoinCohortDto {
  /** Generous limit: people paste codes with the dashes and spaces they were shown. */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code!: string;
}

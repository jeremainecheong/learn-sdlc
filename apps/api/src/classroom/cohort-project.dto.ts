import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ASSIGNMENT_REASON_MAX, ASSIGNMENT_REASON_MIN } from '@learnsdlc/shared';
import { ASSIGNMENT_REASON_MESSAGE } from './cohort-project.service';

/**
 * What a class is being put on, and why.
 *
 * The version is shape-checked here as well as in the service, so a malformed
 * id never reaches a query; Postgres raises on one and that surfaces as a 500
 * where a 404 is the truth. The reason carries the same minimum every
 * instructor override already asks for, from the same shared constant, because
 * a class whose project changed with no explanation is what an appeal cannot
 * answer.
 */
export class AssignProjectDto {
  @IsUUID()
  projectVersionId!: string;

  @IsString()
  @MinLength(ASSIGNMENT_REASON_MIN, { message: ASSIGNMENT_REASON_MESSAGE })
  @MaxLength(ASSIGNMENT_REASON_MAX)
  reason!: string;
}

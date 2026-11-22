import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * These live here rather than in the shared `dto.ts`: a DTO used by exactly
 * one controller belongs beside that controller.
 */
export class InstructorNoteDto {
  @IsString()
  @MinLength(2, { message: 'a note needs at least 2 characters' })
  @MaxLength(400)
  text!: string;

  /** The phase the note is about, so the learner's row opens the right room. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  phaseStateId?: string;
}

export class NotificationListQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

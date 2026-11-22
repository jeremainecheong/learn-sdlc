import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  INSTRUCTOR_NOTE_MAX,
  INSTRUCTOR_NOTE_MIN,
  PHASE_ORDER,
  STUCK_ANSWER_MAX,
  STUCK_ANSWER_MIN,
} from '@learnsdlc/shared';
import { SLUG_MAX_LENGTH } from './instructor.dto';
import type { InstructorNoteKind, PhaseKey } from '@learnsdlc/shared';

/**
 * The two kinds of note. A mentor note is quoted to the class; a
 * lecture point is a line for the next session and never reaches a model.
 */
export const NOTE_KINDS: InstructorNoteKind[] = ['mentor', 'lecture'];

/**
 * These live here rather than in the shared `dto.ts` on purpose: a DTO used
 * by exactly one controller has no business in the shared file.
 */
export class WriteNoteDto {
  @IsIn(NOTE_KINDS) kind!: InstructorNoteKind;

  @IsString() @MaxLength(64) cohortId!: string;

  /** Absent or null means every phase. */
  @IsOptional() @IsIn(PHASE_ORDER) phaseKey?: PhaseKey | null;

  /** Absent or null means every project. */
  @IsOptional() @IsString() @MaxLength(SLUG_MAX_LENGTH) projectSlug?: string | null;

  @IsString()
  @MinLength(INSTRUCTOR_NOTE_MIN, {
    message: `a note the class can act on needs at least ${INSTRUCTOR_NOTE_MIN} characters`,
  })
  @MaxLength(INSTRUCTOR_NOTE_MAX)
  text!: string;

  /** `"<phaseKey>:<title>"` when a derived lecture point was pinned (the class page's lecture board sends it). */
  @IsOptional() @IsString() @MaxLength(200) sourceId?: string | null;

  /** Lecture points only: ticked off, or put back. */
  @IsOptional() @IsBoolean() done?: boolean;
}

/** Every field optional: an edit changes one thing at a time. */
export class PatchNoteDto {
  @IsOptional() @IsIn(NOTE_KINDS) kind?: InstructorNoteKind;

  @IsOptional() @IsString() @MaxLength(64) cohortId?: string;

  @IsOptional() @IsIn(PHASE_ORDER) phaseKey?: PhaseKey | null;

  @IsOptional() @IsString() @MaxLength(SLUG_MAX_LENGTH) projectSlug?: string | null;

  @IsOptional() @IsString() @MinLength(INSTRUCTOR_NOTE_MIN) @MaxLength(INSTRUCTOR_NOTE_MAX) text?: string;

  @IsOptional() @IsString() @MaxLength(200) sourceId?: string | null;

  @IsOptional() @IsBoolean() done?: boolean;
}

export class NotesQuery {
  @IsOptional() @IsString() @MaxLength(64) cohortId?: string;

  @IsOptional() @IsIn(NOTE_KINDS) kind?: InstructorNoteKind;

  @IsOptional() @IsIn(PHASE_ORDER) phaseKey?: PhaseKey;
}

/** The instructor's stuck list: one class, optionally one project. */
export class StuckQuery {
  @IsOptional() @IsString() @MaxLength(64) cohortId?: string;

  @IsOptional() @IsString() @MaxLength(SLUG_MAX_LENGTH) project?: string;

  /** `open` is not-yet-cleared, the console's default; `all` includes cleared. */
  @IsOptional() @IsIn(['open', 'all']) state?: 'open' | 'all';
}

export class AnswerStuckDto {
  @IsString()
  @MinLength(STUCK_ANSWER_MIN, {
    message: `an answer shorter than ${STUCK_ANSWER_MIN} characters will not help anybody`,
  })
  @MaxLength(STUCK_ANSWER_MAX)
  answer!: string;
}

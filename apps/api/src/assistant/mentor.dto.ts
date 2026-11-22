import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { STUCK_QUESTION_MAX, STUCK_QUESTION_MIN, STUCK_TRIED_MAX } from '@learnsdlc/shared';

/** The longest question a learner may ask the customer; the interview prompt carries no more of it. */
export const INTERVIEW_QUESTION_MAX_CHARS = 500;

/**
 * The learner side of the mentor's interview and stuck rooms. These live
 * beside the controller that uses them rather than in the shared `dto.ts`.
 */
export class InterviewAskDto {
  @IsString()
  @MinLength(3, { message: 'ask the customer a question — at least 3 characters' })
  @MaxLength(INTERVIEW_QUESTION_MAX_CHARS)
  question!: string;
}

export class RaiseStuckDto {
  @IsString()
  @MinLength(STUCK_QUESTION_MIN, { message: 'say what you are stuck on — at least 10 characters' })
  @MaxLength(STUCK_QUESTION_MAX)
  question!: string;

  /** Blank is allowed: not everybody has tried something yet. */
  @IsOptional() @IsString() @MaxLength(STUCK_TRIED_MAX) tried?: string;
}

/**
 * Which failing test to explain, and which result it failed in.
 *
 * `source` is not cosmetic: a run and a submission carry different suites, a
 * run is the visible one the learner started, a submission is both, and a test
 * name is only unique inside one of them. Without `sourceId` the newest
 * completed result of that kind is used, which is what every button on the page
 * is looking at.
 *
 * `step` exists because a full-stack phase is graded over two runs, pytest
 * over the API and the DOM harness over the front end, merged into one result
 * with a `step` on every case. The same case name can appear in both halves, so
 * the button sends the one it drew.
 */
export class ExplainTestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  testName!: string;

  @IsIn(['run', 'submission'])
  source!: 'run' | 'submission';

  @IsOptional() @IsUUID() sourceId?: string;

  @IsOptional() @IsString() @MaxLength(80) step?: string;
}

export class LessonMentorDto {
  @IsString() @MinLength(1) @MaxLength(2000) message!: string;
}

import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { TEACHER_FEEDBACK_MAX, TEACHER_FEEDBACK_MIN } from '@learnsdlc/shared';
import type { TeacherFeedbackAction } from './submission-feedback.entity';

export class SubmissionTeacherFeedbackDto {
  @IsUUID() requestId!: string;
  @IsIn(['comment', 'acknowledge', 'request_revision'])
  action!: TeacherFeedbackAction;
  @IsString() @MinLength(TEACHER_FEEDBACK_MIN) @MaxLength(TEACHER_FEEDBACK_MAX) text!: string;
}

export class SubmissionHistoryQuery {
  @IsOptional() @IsString() @Matches(/^[a-z0-9-]{1,80}$/) project?: string;
  @IsOptional() @IsUUID() after?: string;
  @IsOptional() @IsUUID() phaseId?: string;
}

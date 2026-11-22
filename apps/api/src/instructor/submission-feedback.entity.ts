import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type TeacherFeedbackAction =
  | 'comment'
  | 'acknowledge'
  | 'request_revision';

/** Immutable teacher follow-up on one submitted revision, independent of its verdict. */
@Entity('submission_teacher_feedback')
@Index('IDX_submission_teacher_feedback_submission', [
  'submissionId',
  'createdAt',
])
@Index(
  'UQ_submission_teacher_feedback_request',
  ['authorUserId', 'requestId'],
  { unique: true },
)
export class SubmissionTeacherFeedbackEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() submissionId: string;
  @Column() phaseStateId: string;
  @Index('IDX_submission_teacher_feedback_user') @Column() userId: string;
  @Column() cohortId: string;
  @Column() authorUserId: string;
  @Column() authorName: string;
  @Column() requestId: string;
  @Column({ type: 'varchar' }) action: TeacherFeedbackAction;
  @Column({ type: 'text' }) text: string;
  @CreateDateColumn() createdAt: Date;
}

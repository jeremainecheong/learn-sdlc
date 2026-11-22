import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { InstructorNoteKind, PhaseKey } from '@learnsdlc/shared';

/**
 * A note an instructor writes for a whole class.
 *
 * Two kinds share one table because they share every other column and one is
 * turned into the other by editing a select: a `mentor` note is quoted word for
 * word by the mentor to everyone in that class in that phase, and a `lecture`
 * point is a line held for the next session and never sent to a model.
 *
 * The author is `authorUserId`, deliberately not `userId`. A `userId` column is
 * what `account.service.ts` walks to export and erase a learner's coursework,
 * and this is not coursework: it is staff writing about a class, kept like
 * `audit_events` and outliving the person who wrote it. Naming the column
 * `userId` would put a note for thirty learners inside one instructor's export
 * and delete it with their account.
 */
@Entity('instructor_notes')
// Every read is one class and one kind: the mentor asks for this class's
// mentor notes on a chat turn, the console asks for its lecture points.
@Index('IDX_instructor_notes_cohort_kind', ['cohortId', 'kind'])
// An admin deleting a staff account has to find what they wrote.
@Index('IDX_instructor_notes_author', ['authorUserId'])
export class InstructorNoteEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Explicit type: an imported-alias annotation emits no usable design:type. */
  @Column({ type: 'varchar' })
  kind: InstructorNoteKind;

  @Column()
  cohortId: string;

  /** Null means every project. */
  @Column({ type: 'varchar', nullable: true })
  projectSlug: string | null;

  /** Null means every phase. */
  @Column({ type: 'varchar', nullable: true })
  phaseKey: PhaseKey | null;

  @Column({ type: 'text' })
  text: string;

  @Column()
  authorUserId: string;

  /** `"<phaseKey>:<title>"` when a derived lecture point was pinned (the lecture board reads it). */
  @Column({ type: 'varchar', nullable: true })
  sourceId: string | null;

  /** Lecture points only: when it was ticked off. */
  @Column({ type: 'varchar', nullable: true })
  doneAt: string | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}

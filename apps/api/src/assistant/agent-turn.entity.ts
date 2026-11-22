import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** Private conversation journal. A completed reply is an immutable snapshot,
 * not a live pointer whose meaning changes when a proposal is edited. */
@Entity('agent_turns')
@Index('UQ_agent_turns_request', ['userId', 'requestId'], { unique: true })
@Index('IDX_agent_turns_owner_phase_created', ['userId', 'phaseStateId', 'createdAt', 'id'])
@Check('CHK_agent_turns_kind', '"kind" IN (\'chat\', \'explain\')')
@Check('CHK_agent_turns_status', '"status" IN (\'pending\', \'completed\', \'failed\')')
export class AgentTurnEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() phaseStateId: string;
  @Column() requestId: string;
  @Column() requestHash: string;
  @Column({ type: 'varchar' }) kind: 'chat' | 'explain';
  @Column({ type: 'varchar' }) status: 'pending' | 'completed' | 'failed';
  @Column({ type: 'text' }) message: string;
  @Column({ type: 'varchar', nullable: true }) parentTurnId: string | null;
  @Column({ type: 'varchar', nullable: true }) parentProposalId: string | null;
  @Column({ type: 'varchar', nullable: true }) parentProposalHash: string | null;
  @Column() baseWorkspaceHash: string;
  @Column({ type: 'varchar', nullable: true }) proposalId: string | null;
  @Column({ type: 'simple-json', nullable: true }) response: unknown | null;
  @Column({ type: 'varchar', nullable: true }) errorCode: string | null;
  /** The reason a structured proposal was refused, after its fixed sentence; null on every other turn. */
  @Column({ type: 'text', nullable: true }) errorDetail: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

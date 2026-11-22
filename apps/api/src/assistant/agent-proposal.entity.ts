import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { SemanticAssessment } from './strict-assessment';

export interface ProposalEditEvidence {
  previousFiles: Record<string, string>;
  previousHash: string;
  currentHash: string;
  editedAt: string;
}

@Entity('agent_proposals')
@Index('IDX_agent_proposals_owner_phase', ['userId', 'phaseStateId'])
export class AgentProposalEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column() userId: string;
  @Column() phaseStateId: string;
  @Column({ type: 'text' }) prompt: string;
  @Column({ type: 'simple-json' }) files: Record<string, string>;
  @Column() proposalHash: string;
  @Column() baseWorkspaceHash: string;
  @Column({ type: 'simple-json', nullable: true }) lastEdit: ProposalEditEvidence | null;
  @Column({ type: 'simple-json' }) assessment: SemanticAssessment;
  /** The AI's short summary of what this proposal changes and what to check, shown above the diff; never part of the explanation assessment. Null when the model wrote none. */
  @Column({ type: 'text', nullable: true }) summary: string | null;
  @Column({ type: 'text', nullable: true }) explanation: string | null;
  @Column({ type: 'simple-json', nullable: true }) explanationAssessment: SemanticAssessment | null;
  @Column({ type: 'varchar', nullable: true }) approvedAt: string | null;
  @Column({ type: 'varchar', nullable: true }) appliedAt: string | null;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}

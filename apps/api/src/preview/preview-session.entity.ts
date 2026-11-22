import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import type { PreviewStatus, PreviewStopReason } from '@learnsdlc/shared';

export interface PreviewSessionState {
  bundleOk: boolean;
  message: string | null;
  stopReason: PreviewStopReason | null;
  startedAt: number;
  readyAt: number | null;
  expiresAt: number;
  lastSeenAt: number;
  bytesServed: number;
  forgetAt: number | null;
  buildMs: number;
  /** Latest time a start answer may publish a capability; never cleanup proof. */
  launchDeadline: number;
  // How often this row has asked the runner to confirm
  // its clean-up and been left without an answer. Optional because rows
  // written before it carry none, and in the JSON column, so no migration.
  /** Clean-up asks that ended without the runner confirming. */
  cleanupAttempts?: number;
  /** When the last of them was made (ms). The next waits out a back-off from here. */
  cleanupLastAttemptAt?: number;
  /**
   * When the asking stopped (ms): the row is marked failed, its seat stays
   * reserved (elapsed time is not proof the app stopped) and an operator
   * line was written. Nothing asks the runner about this row again.
   */
  cleanupAbandonedAt?: number;
  /**
   * The workspace save the app was built from: the phase row's
   * `workspaceUpdatedAt` (the stamp the IDE calls "Saved at") read together
   * with the files the start handed the runner. Null for a workspace never
   * saved (the starter files). Optional because rows written before it carry
   * none, and in the JSON column, so no migration.
   */
  builtFromVersion?: string | null;
}

/** Shared ownership, revocation and launch reservations. No raw capabilities,
 * browser tokens, learner source, logs or private mentor messages. */
@Entity('preview_sessions')
@Index('IDX_preview_sessions_owner_phase', ['userId', 'phaseStateId'])
@Index('IDX_preview_sessions_status', ['status', 'cleanupPending'])
export class PreviewSessionEntity {
  @PrimaryColumn({ type: 'varchar', length: 24 }) id: string;
  @Column({ type: 'varchar' }) userId: string;
  @Column({ type: 'varchar' }) phaseStateId: string;
  @Column({ type: 'int' }) tokenVersion: number;
  @Column({ type: 'varchar', nullable: true }) runnerId: string | null;
  @Index('UQ_preview_sessions_capability', { unique: true })
  @Column({ type: 'varchar', length: 64 }) capabilityHash: string;
  @Column({ type: 'varchar', length: 16 }) status: PreviewStatus;
  @Column({ type: 'boolean', default: false }) cleanupPending: boolean;
  @Column({ type: 'int', default: 0 }) revision: number;
  @Column({ type: 'simple-json' }) state: PreviewSessionState;
  @CreateDateColumn() createdAt: Date;
}

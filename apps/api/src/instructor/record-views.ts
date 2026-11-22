import type { ReleaseRecordView, SubmissionView } from '@learnsdlc/shared';
import type { ReleaseRecordEntity, SubmissionEntity } from '../db/entities';
import { isoOrNull } from '../db/timestamps';

/** A revision and a release row as the learner detail and the dossier show them. */

/** The same shape FeedbackService.toView produces, without the snapshot. */
export function dossierRevision(
  row: SubmissionEntity,
  attempt: number,
): SubmissionView {
  return {
    id: row.id,
    status: row.status,
    score: row.score,
    passed: row.passed,
    report: row.report,
    createdAt: isoOrNull(row.createdAt) ?? '',
    error: row.error || undefined,
    attempt,
    commitMessage: row.commitMessage ?? null,
    runClock: row.runClock ?? null,
  };
}

export function releaseView(release: ReleaseRecordEntity): ReleaseRecordView {
  return {
    id: release.id,
    enrollmentId: release.enrollmentId,
    phaseKey: release.phaseKey,
    phaseOrder: release.phaseOrder,
    version: release.version,
    score: release.score,
    notes: release.notes,
    createdAt: isoOrNull(release.createdAt) ?? '',
  };
}

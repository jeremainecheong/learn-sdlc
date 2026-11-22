import { CHANGE_OLDER_FORMAT_ROOM, CHANGE_REQUEST_JSON, RUNBOOK_JSON, RUNBOOK_OLDER_FORMAT_ROOM, type PhaseDetail } from '@learnsdlc/shared';

/** The two records a learner writes through forms, never as files: never in the explorer, the editor tabs or the PR diff. */
export const ROOM_RECORD_PATHS: readonly string[] = [RUNBOOK_JSON, CHANGE_REQUEST_JSON];
export const isRoomRecordPath = (path: string): boolean => ROOM_RECORD_PATHS.includes(path);

/** A Deployment of the config kind without `runbook`, or a Maintenance of the code kind without `change`: its room's sentence; null otherwise. */
export function olderRecordSentence(detail: Pick<PhaseDetail, 'key' | 'artifactKind' | 'runbook' | 'change'>): string | null {
  if (detail.key === 'deployment' && detail.artifactKind === 'config' && !detail.runbook) return RUNBOOK_OLDER_FORMAT_ROOM;
  if (detail.key === 'maintenance' && detail.artifactKind === 'code' && !detail.change) return CHANGE_OLDER_FORMAT_ROOM;
  return null;
}

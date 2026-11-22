/**
 * What the workspace keeps of each phase for as long as the session lasts:
 * where the learner was in it and the phase as this session last saw it.
 * Imported last by the room's page, so its session-end hook is registered
 * after every module the page imports.
 */
import type { WorkspacePhaseDetail } from '@/lib/api-workspace';
import { onSessionEnd, ownedByToken } from '@/lib/session';
import type { RightTab, Pane } from './workspace-helpers';

/**
 * Where the learner was in a phase, kept for as long as the session lasts.
 *
 * The workspace is left and returned to constantly (the sidebar, the map, the
 * phase document) and a room you come back to should be the room you left:
 * the same file open, the caret where you put it, the same view of the code,
 * the same panel underneath. None of that is worth a round trip to the server
 * and none of it is worth storing between sessions, so it lives here, keyed by
 * phase and dropped when the session ends.
 */
export interface WorkspaceView {
  /** The file the editor was showing. */
  path: string;
  /** Tabs opened beyond the ones the phase seeds. */
  extra: string[];
  cursor: { line: number; col: number };
  scrollTop: number;
  tab: RightTab;
  /** Which tab of the panel under the code. */
  bottom: string;
  pane: Pane;
}

const VIEWS = new Map<string, WorkspaceView>();

/**
 * The phase as this session last saw it, which is fresher than the shell's
 * copy: the shell loaded every phase when the session began, and a learner who
 * has since written half a file would otherwise come back to the version they
 * started from for the moment it takes the server to answer.
 */
export const DETAILS = new Map<string, WorkspacePhaseDetail>();

/**
 * Both caches belong to the learner whose token filled them. Signing out drops
 * them there and then; `ownCaches` catches the change either way (including a
 * second learner signing in over the top of the first, which ends no session
 * and so fires no hook) and is called before every read and every write.
 */
function dropWorkspaceCaches(): void {
  VIEWS.clear();
  DETAILS.clear();
}

const ownCaches = ownedByToken(dropWorkspaceCaches);
onSessionEnd(dropWorkspaceCaches);

/** Where this phase was left, if this session has been in it. */
export function heldView(phaseId: string): WorkspaceView | undefined {
  ownCaches();
  return VIEWS.get(phaseId);
}

export function keepView(phaseId: string, view: WorkspaceView): void {
  ownCaches();
  VIEWS.set(phaseId, view);
}

/** The phase as this session last saw it. */
export function heldDetail(phaseId: string): WorkspacePhaseDetail | undefined {
  ownCaches();
  return DETAILS.get(phaseId);
}

export function keepDetail(phaseId: string, detail: WorkspacePhaseDetail): void {
  ownCaches();
  DETAILS.set(phaseId, detail);
}

/** The phase with these files written into it, for the copy kept above. */
export function withSaved(
  detail: WorkspacePhaseDetail,
  saved: Record<string, string>,
): WorkspacePhaseDetail {
  return {
    ...detail,
    files: detail.files.map((f) => (saved[f.path] === undefined ? f : { ...f, content: saved[f.path] })),
  };
}

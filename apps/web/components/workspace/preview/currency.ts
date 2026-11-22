/**
 * Whether the running app preview shows the code as saved now.
 *
 * A preview is built once, from the save the workspace held when it started,
 * and keeps serving that build: an Apply from the mentor or a save after it
 * changes the files, not the running app. The API names both saves on
 * the start answer and on every status poll the panel already makes
 * (`builtFromVersion`, `workspaceVersion`, the phase row's `workspaceUpdatedAt`
 * stamps), and the page may hand over its own newest save stamp so the panel
 * notices a save before the next poll. This file compares them.
 *
 * Pure: no React, no fetch, no clock.
 */
import type { PreviewSessionView } from '@learnsdlc/shared';

/** The two fields the API's preview answers carry beside the shared view (apps/api/src/preview/preview.dto.ts). */
export interface PreviewBuildFields {
  /** The save the app was built from; absent on a session started before the field existed. */
  builtFromVersion?: string | null;
  /** The workspace's current save, as of this answer. */
  workspaceVersion?: string | null;
}

export type PreviewCurrency = 'current' | 'earlier' | 'unknown';

const instant = (version: string | null): number => (version ? Date.parse(version) || 0 : 0);

/** The newer of two save stamps; undefined when neither is known. */
export function newestSave(a: string | null | undefined, b: string | null | undefined): string | null | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return instant(b) > instant(a) ? b : a;
}

/**
 * `current` when the build is the newest save known, `earlier` when a later
 * save exists, `unknown` when the session does not name its build (an older
 * session) or no save is known at all, so the panel makes no claim.
 */
export function previewCurrency(
  session: (PreviewSessionView & PreviewBuildFields) | null,
  savedVersion?: string | null,
): PreviewCurrency {
  if (!session || session.builtFromVersion === undefined) return 'unknown';
  const built = session.builtFromVersion;
  const saved = newestSave(session.workspaceVersion, savedVersion);
  if (saved === undefined) return 'unknown';
  if (saved === built) return 'current';
  return instant(saved) > instant(built) ? 'earlier' : 'current';
}

/** The build stamp, for the sentence that names it. */
export const builtFrom = (session: (PreviewSessionView & PreviewBuildFields) | null): string | null =>
  session?.builtFromVersion ?? null;

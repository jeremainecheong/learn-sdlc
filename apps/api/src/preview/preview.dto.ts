import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { PreviewSessionView } from '@learnsdlc/shared';

/**
 * What a status poll asks for.
 *
 * `cursor` is the number of console lines the panel has already drawn, so a
 * poll every fifteen seconds carries back only what the app has printed since
 * the last one rather than the whole ring. It is a count and not an offset
 * into the ring: the ring wraps, and a client that was away while it wrapped
 * gets what is left rather than a replay or an error.
 */
export class PreviewStatusQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;
}

/**
 * Which save a running preview was built from, and which save is current.
 * After an Apply or a save, the running app keeps serving the build it
 * started with until it is rebuilt, so the panel needs both to say so. Both
 * are the phase row's `workspaceUpdatedAt` stamp, an ISO instant, or null for
 * a workspace never saved. The panel compares them: when they differ the
 * preview is using an earlier version of the code. Optional: a session row
 * may carry no `builtFromVersion`, and a reader that knows nothing of the two
 * fields reads the view unchanged.
 */
export interface PreviewBuildFields {
  /** The save the running (or last) app was built from; absent on an older row. */
  builtFromVersion?: string | null;
  /** The workspace's current save, read on this answer. */
  workspaceVersion?: string | null;
}

/**
 * Why a start was refused, when the cause is the learner's own preview and
 * not the class. Absent on every other answer, the class-full refusal
 * included, so a reader that knows nothing of it reads those unchanged.
 *
 * - `own-preview-stopping`: the learner's own earlier app is stopped but the
 *   runner has not yet confirmed it gone, so it still holds its seat.
 * - `own-preview-starting`: another start of the learner's own (a second tab)
 *   is still launching.
 *
 * The panel titles the refusal by this field; `message` still carries the
 * whole sentence, so a client that does not read the field draws a true body.
 */
export type PreviewRefusalReason = 'own-preview-stopping' | 'own-preview-starting';

export interface PreviewRefusalFields {
  reason?: PreviewRefusalReason;
}

export type PreviewSessionAnswer = PreviewSessionView & PreviewBuildFields & PreviewRefusalFields;

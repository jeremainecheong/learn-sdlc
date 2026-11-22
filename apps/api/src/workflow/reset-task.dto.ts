import { IsString, MaxLength, ValidateIf } from 'class-validator';
import type { ResetTaskInput } from '@learnsdlc/shared';

/**
 * `POST /phases/:id/tasks/:taskKey/reset`'s body, and its only
 * key (the global pipe whitelists and forbids any other).
 *
 * `baseVersion` is REQUIRED, and null is a real value: the workspace version
 * the tab last loaded (`PhaseDetail.workspaceUpdatedAt`), null for a workspace
 * never saved. Unlike a save, a reset has no "quote nothing" caller: it is
 * always a person pressing a button in a tab that loaded a version, so an
 * absent key is a 400 rather than a write that skips the check.
 */
export class ResetTaskDto implements ResetTaskInput {
  @ValidateIf((_dto, value) => value !== null)
  @IsString()
  @MaxLength(64)
  baseVersion: string | null;
}

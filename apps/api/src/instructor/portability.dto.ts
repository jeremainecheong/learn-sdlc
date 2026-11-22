import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import type { CohortExportInclude } from '@learnsdlc/shared';

/**
 * What an export carries beyond the default, as a comma-separated list:
 * `?include=messages`, `?include=snapshots,messages`, or nothing at all.
 *
 * Both extras are off unless asked for by name, for two different reasons. The
 * revision files are 247 MB for a fifty-learner class and say nothing a verdict
 * does not; the transcripts are the most personal thing in the file, so moving
 * them is a deliberate act and one the audit row records.
 */
export class CohortExportQuery {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  include?: string;
}

/** Query flags on the one import route. Both arrive as strings from a browser. */
export class CohortImportQuery {
  @IsOptional()
  @IsIn(['true', 'false'])
  dryRun?: string;

  /** Import a file this machine has already imported, making a second copy. */
  @IsOptional()
  @IsIn(['true', 'false'])
  force?: string;
}

const KNOWN: CohortExportInclude[] = ['snapshots', 'messages'];

/**
 * The list, deduplicated and in a fixed order, with anything unrecognised
 * dropped rather than refused: a query string is not the place to fail a
 * download over a typo, and what the file actually carries is written into the
 * document's own `includes`.
 */
export function parseIncludes(raw: string | undefined): CohortExportInclude[] {
  const asked = new Set((raw || '').split(',').map((part) => part.trim().toLowerCase()));
  return KNOWN.filter((include) => asked.has(include));
}

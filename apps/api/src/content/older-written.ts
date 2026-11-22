/**
 * The markdown kind's checks as an older stored row or pack still holds them,
 * read only by the legacy readers that convert an older Requirements or
 * Design. No product type names the deleted kind.
 */
export interface OlderWrittenRule { id: string; label: string; criterion: string; pattern?: string; forbidden?: string; flags?: string; required: boolean; failDetail: string; target?: string }
export interface OlderWrittenChecks { kind: 'markdown'; targets: string[]; minWords?: number; minWordsCriterion?: string; rules: OlderWrittenRule[] }
export function isOlderWritten(checks: unknown): checks is OlderWrittenChecks {
  return !!checks && typeof checks === 'object' && (checks as { kind?: unknown }).kind === 'markdown';
}
/** Whether a stored phase row's `artifactKind` is the older written kind (a column read as a string). */
export function isOlderWrittenKind(kind: string): boolean {
  return kind === 'markdown';
}

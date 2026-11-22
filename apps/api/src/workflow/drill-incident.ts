import { RUNBOOK_JSON, validateRunbookRecord, type DrillState } from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';

/**
 * The drill's one reader of the incident. For a phase that grades a
 * runbook (a config phase whose checks carry `runbook`, decided here once for
 * every caller), `workspace` is a live workspace or a submission's snapshot:
 * - no runbook record in it: the drill unchanged, so an older snapshot keeps
 *   its stored incident;
 * - a valid record: `incident` from the record, null when its root cause, fix
 *   and action item are all blank;
 * - a record that does not parse or validate: `incident: null` (the room says
 *   the record is not valid, and nothing stale is shown).
 * Any other phase's drill is answered unchanged; a null drill is null.
 */
export function drillWithIncident(drill: DrillState, workspace: Record<string, string> | null | undefined, phase: Pick<PhaseContent, 'checks'>): DrillState;
export function drillWithIncident(drill: DrillState | null, workspace: Record<string, string> | null | undefined, phase: Pick<PhaseContent, 'checks'>): DrillState | null;
export function drillWithIncident(drill: DrillState | null, workspace: Record<string, string> | null | undefined, phase: Pick<PhaseContent, 'checks'>): DrillState | null {
  if (!drill) return null;
  const gradesRunbook = phase.checks?.kind === 'config' && !!phase.checks.runbook;
  const text = workspace?.[RUNBOOK_JSON];
  if (!gradesRunbook || text === undefined) return drill;
  const found = validateRunbookRecord(text).runbook?.incident;
  const hasIncident = !!found && [found.rootCause, found.fix, found.actionItem].some((one) => one.trim());
  return { ...drill, incident: found && hasIncident ? { rootCause: found.rootCause, fix: found.fix, actionItem: found.actionItem } : null };
}

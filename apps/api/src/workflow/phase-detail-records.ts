import type { PhaseDetail } from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/** The runbook's floor and whether the phase drills, for the Runbook tab and the preview; copied. Undefined otherwise. */
export function phaseDetailRunbook(checks: PhaseChecks): PhaseDetail['runbook'] {
  if (checks.kind !== 'config' || !checks.runbook) return undefined;
  return { floor: { ...checks.runbook.floor }, drill: !!checks.drill };
}

/** The ticket, the contract switch and the floor, for the change room and the preview; copied. Undefined otherwise. */
export function phaseDetailChange(checks: PhaseChecks): PhaseDetail['change'] {
  if (checks.kind !== 'code' || !checks.change || !checks.ticket) return undefined;
  const t = checks.ticket;
  return { ticket: { ...t, acceptance: t.acceptance.map((one) => ({ ...one })) }, contract: checks.change.contract, floor: { ...checks.change.floor } };
}

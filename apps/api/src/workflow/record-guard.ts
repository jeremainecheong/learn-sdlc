import { BadRequestException } from '@nestjs/common';
import {
  CHANGE_REQUEST_JSON, EMPTY_INCIDENT, RUNBOOK_JSON, changeRequestSaveRefusal, runbookSaveRefusal, serialiseChangeRequest, serialiseRunbook,
  validateChangeRequestRecord, validateRunbookRecord,
} from '@learnsdlc/shared';
import type { PhaseChecks } from '../content/content.types';

/**
 * A save to a Deployment's runbook or a Maintenance's change request: the
 * learner's own and an Agentic apply. A malformed record is refused with the
 * fixed sentence and nothing is stored; a valid one is stored as validated,
 * so an unknown key is never kept. In a phase with a drill the incident is
 * carried from `stored` (the row's record, or the version's starting one)
 * whatever the save sends: the drill's resolve is its one writer.
 * Any other path, or a phase without a record, passes through.
 */
export function refuseInvalidRecord(path: string, content: string, checks: PhaseChecks, stored: string | undefined): string {
  if (checks.kind === 'config' && checks.runbook && path === RUNBOOK_JSON) {
    const out = validateRunbookRecord(content);
    if (out.error) throw new BadRequestException(runbookSaveRefusal(out.error));
    if (!checks.drill) return serialiseRunbook(out.runbook!);
    const held = validateRunbookRecord(stored ?? '').runbook;
    return serialiseRunbook({ ...out.runbook!, incident: held?.incident ?? EMPTY_INCIDENT });
  }
  if (checks.kind === 'code' && checks.change && checks.ticket && path === CHANGE_REQUEST_JSON) {
    const out = validateChangeRequestRecord(content, checks.ticket.acceptance.map((one) => one.id));
    if (out.error) throw new BadRequestException(changeRequestSaveRefusal(out.error));
    return serialiseChangeRequest(out.change!);
  }
  return content;
}

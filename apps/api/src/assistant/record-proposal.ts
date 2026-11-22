import {
  CHANGE_REQUEST_JSON, EMPTY_INCIDENT, RUNBOOK_JSON,
  canonicalJson, changeFloorSentence, runbookFloorSentence, serialiseChangeRequest, serialiseRunbook, validateChangeRequestRecord, validateRunbookRecord,
  type ChangeTicket,
} from '@learnsdlc/shared';
import { recordPathOf } from '../content/checks-validation';
import type { PhaseContent } from '../content/content.types';
import { carryIds } from './design-proposal';
import { filesThroughEditsSentence, recordCompactSentence } from './proposal-edits';
import { RefusedProposalException, type RefusalClause, type RefusedProposalCode } from './proposal-refusal';

/** Why a record was refused: the rule, and its reason when the rule can say one. */
type Refusal = { refusal: { clause: RefusalClause; detail: string | null } };
const refused = (clause: RefusalClause, detail: string | null = null): Refusal => ({ refusal: { clause, detail } });

/** The proposed record with what a proposal never changes carried from `live`; the refusal, with its reason, when it is not a valid record. */
function carried(phase: PhaseContent, proposedText: string, liveText: string | undefined): { text: string; proposed: string } | Refusal {
  const checks = phase.checks;
  if (checks?.kind === 'config' && checks.runbook) {
    const read = validateRunbookRecord(proposedText);
    const proposed = read.runbook;
    if (!proposed) return refused('invalid_record', `The runbook record is not valid: ${read.error}.`);
    const live = validateRunbookRecord(liveText ?? '').runbook;
    const drill = !!checks.drill;
    const next = live ? {
      ...proposed,
      environment: carryIds(proposed.environment, live.environment).list,
      health: carryIds(proposed.health, live.health).list,
      rollback: carryIds(proposed.rollback, live.rollback).list,
      data: carryIds(proposed.data, live.data).list,
      incident: drill ? live.incident : proposed.incident,
    } : { ...proposed, incident: drill ? EMPTY_INCIDENT : proposed.incident };
    // re-validated: a carried id must still be unique
    const checked = validateRunbookRecord(serialiseRunbook(next));
    return checked.runbook ? { text: serialiseRunbook(checked.runbook), proposed: serialiseRunbook(proposed) } : refused('carried_invalid', `With the saved ids carried, the runbook record is not valid: ${checked.error}.`);
  }
  if (checks?.kind === 'code' && checks.change && checks.ticket) {
    const acceptance = checks.ticket.acceptance.map((one) => one.id);
    const read = validateChangeRequestRecord(proposedText, acceptance);
    const proposed = read.change;
    if (!proposed) return refused('invalid_record', `The change request record is not valid: ${read.error}.`);
    const live = validateChangeRequestRecord(liveText ?? '', null).change;
    // a switched-off contract is not part of the change request: a proposal that changes it is refused
    if (!checks.change.contract && canonicalJson(proposed.contract) !== canonicalJson(live?.contract ?? [])) return refused('switched_off', 'The proposal changes the contract amendments, which are not part of this change request.');
    const next = live ? {
      ...proposed,
      contract: checks.change.contract ? carryIds(proposed.contract, live.contract).list : live.contract,
      tests: carryIds(proposed.tests, live.tests).list,
      release: { ...proposed.release, changes: carryIds(proposed.release.changes, live.release.changes).list },
    } : proposed;
    const checked = validateChangeRequestRecord(serialiseChangeRequest(next), acceptance);
    return checked.change ? { text: serialiseChangeRequest(checked.change), proposed: serialiseChangeRequest(proposed) } : refused('carried_invalid', `With the saved ids carried, the change request record is not valid: ${checked.error}.`);
  }
  return refused('invalid_record');
}

/** The code that refuses a proposal of this record: the runbook's or the change request's; the turn reads its fixed sentence from it. */
const refusalCodeOf = (record: string): RefusedProposalCode => (record === RUNBOOK_JSON ? 'runbook_proposal_refused' : 'change_proposal_refused');
/** What a runbook or change-request proposal keeps as the learner saved it, said when an edit or a stored proposal would change it. */
const CARRIED_CHANGED = "The edit changes an item's id, or the incident written from the drill, which a proposal keeps as saved.";
const STORED_CARRIED_CHANGED = "The stored proposal would change an item's id, a switched-off contract or the incident written from the drill, which a proposal keeps as saved.";

/**
 * A runbook or change-request proposal as it may be shown: the record valid
 * against its schema (and the ticket), every item id carried from `live`,
 * and in a drill phase the incident carried too; the phase's other files
 * whole. With `refuseCarried` (the learner's own edit) a changed
 * carried field is refused. With `dropUnchanged` (a generated proposal) the
 * record and every file that equal the saved ones are left out, so only what
 * really changes is proposed (and explained), and a proposal of any shape
 * left with nothing is refused with `DESIGN_PROPOSAL_UNCHANGED`. A phase
 * without a record passes through.
 */
export function normaliseRecordProposal(
  files: Record<string, string>, phase: PhaseContent, live: Record<string, string>,
  { refuseCarried = false, dropUnchanged = false }: { refuseCarried?: boolean; dropUnchanged?: boolean } = {},
): Record<string, string> {
  const record = recordPathOf(phase.checks);
  if (!record) return files;
  const code = refusalCodeOf(record);
  const out = { ...files };
  if (files[record] !== undefined) {
    const read = carried(phase, files[record], live[record]);
    if ('refusal' in read) throw new RefusedProposalException(code, read.refusal.clause, read.refusal.detail);
    // both sides are the validator's own output, so they differ only where something was carried
    if (refuseCarried && read.text !== read.proposed) throw new RefusedProposalException(code, 'carried_changed', CARRIED_CHANGED);
    out[record] = read.text;
  }
  if (!dropUnchanged) return out;
  for (const path of Object.keys(out)) if (out[path] === live[path]) delete out[path];
  if (Object.keys(files).length && !Object.keys(out).length) throw new RefusedProposalException('design_proposal_unchanged', 'unchanged');
  return out;
}

/**
 * Apply's re-check against the live documents: refused unless nothing needs
 * carrying and nothing is invalid, so a stored proposal that changes an id,
 * a switched-off contract or a drill phase's incident is never written.
 */
export function validateRecordProposal(files: Record<string, string>, phase: PhaseContent, live: Record<string, string>): void {
  const record = recordPathOf(phase.checks);
  if (!record || files[record] === undefined) return;
  const normal = normaliseRecordProposal(files, phase, live);
  if (normal[record] !== files[record]) throw new RefusedProposalException(refusalCodeOf(record), 'carried_changed', STORED_CARRIED_CHANGED);
}

/**
 * Under the edit-list contract ("Prefer edits"), the record is asked for as one files entry: "returned complete"
 * alone does not say which array, and a model may edit the runbook JSON field by field, quoting `"purpose": ""`,
 * which the starting record holds four times, so the edit list would be refused.
 */
const recordWhole = (name: string, path: string) => ` Under the edit-list contract the ${name} \`${path}\` is one files entry holding the complete record, never edits: its empty fields repeat, so the text an edit quotes would not be unique in it.`;

/**
 * What a runbook or change-request phase's generation call is told, in platform words only; the ticket travels as
 * data (`changeTicket`). `mode` is the generation's contract: `files` (the default) is the whole-file briefing,
 * unchanged byte for byte; `edits` asks for the code or configuration files through edits and the record as one
 * files entry holding the complete record, written as compact JSON that the server lays out.
 */
export function recordBriefing(phase: PhaseContent, mode: 'files' | 'edits' = 'files'): string {
  const checks = phase.checks;
  const each = mode === 'edits' ? 'each changed through edits' : 'each returned whole';
  const shape = (kind: 'code' | 'configuration', name: string, path: string) =>
    mode === 'edits' ? `${filesThroughEditsSentence(kind)}${recordWhole(name, path)}${recordCompactSentence(name, path)}` : '';
  if (checks?.kind === 'config' && checks.runbook) {
    return ` In this phase you may change the configuration files, ${each}, and the runbook record \`${RUNBOOK_JSON}\`, returned complete when you touch it. The runbook record is JSON with environment (each {"id","name","purpose","kind","example"}, kind config or secret), health ({"id","name","how","expected"}), rollback ({"id","step","verify"}, in the order an operator runs them), data ({"id","what","how","where","retention"}), incident ({"rootCause","fix","actionItem","timeline":[{"at","event"}]}) and optional notes text; every text at most 2000 characters and at most 20 items in a list. The teacher's floor asks for ${runbookFloorSentence(checks.runbook.floor)}. A proposal must never change an item's id: ids are kept as the learner saved them, and a new item takes the next free number after its letter (E, H, R, D).${checks.drill ? ' The incident is written from the drill page: return it exactly as saved.' : ''} Never change the learner's wording unless the request asks.${shape('configuration', 'runbook record', RUNBOOK_JSON)}`;
  }
  if (checks?.kind === 'code' && checks.change) {
    return ` In this phase you may change the code files, ${each}, and the change request record \`${CHANGE_REQUEST_JSON}\`, returned complete when you touch it. The change request is JSON with impact ({"operations":[text],"screens":[text],"files":[text]}), contract (each {"id","method","path","change","why"}, change one of added, changed or removed), tests ({"id","suite","covers":[acceptance ids],"result"}, result one of pass, fail or not-run), release ({"version","summary","changes":[{"id","line","covers":[acceptance ids]}],"rollback","risks":[text]}) and optional notes text. Every covers id is one of the ticket's acceptance ids, which are in changeTicket.${checks.change.contract ? '' : ' The contract amendments are not part of this change request: return them exactly as saved.'} The teacher's floor asks for ${changeFloorSentence(checks.change.floor, checks.change.contract)}. A proposal must never change an item's id: ids are kept as saved, and a new item takes the next free number after its letter (C, T, L). Never change the learner's wording unless the request asks.${shape('code', 'change request record', CHANGE_REQUEST_JSON)}`;
  }
  return '';
}

/**
 * A change-request phase's generation payload carries the teacher's ticket, as
 * data, and the contract switch beside it (never inside the fenced ticket, whose
 * type is the teacher's `ChangeTicket`); any other phase's payload carries neither.
 */
export function changeTicketData(phase: PhaseContent): { changeTicket?: ChangeTicket; changeContract?: boolean } {
  return phase.checks?.kind === 'code' && phase.checks.change && phase.checks.ticket
    ? { changeTicket: phase.checks.ticket, changeContract: phase.checks.change.contract }
    : {};
}

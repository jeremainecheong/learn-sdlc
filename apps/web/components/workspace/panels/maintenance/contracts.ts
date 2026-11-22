/**
 * `design/contracts.json`: the contracts the design phase promised, seeded
 * into this workspace when the phase unlocked, plus the one CR-1 asks for.
 *
 * The three seeded operations are version 1 and this editor never writes them:
 * they are what the earlier phases were graded against, and the point of the
 * exercise is that the change is an amendment to them, not a rewrite. Version 2
 * is the whole file: v1 plus the operation CR-1 asks for.
 */

import { andList, numberWord } from '@learnsdlc/shared';

export interface ContractOperation {
  /** `reopen_task(task_id)`, as the contract states it. */
  name: string;
  /** The artefact this operation exists for, e.g. US-2 or CR-1. */
  satisfies: string;
  inputs: string;
  returns: string;
  errors: string;
  /** Kept because the design phase writes them; this panel only shows them. */
  ordering?: string;
  boundary?: string;
  example?: string;
}

export interface ContractsDoc {
  operations: ContractOperation[];
}

export const CONTRACTS_JSON = 'design/contracts.json';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `reopen_task(task_id)` → `reopen_task`. */
export function baseName(name: string): string {
  const cut = name.indexOf('(');
  return (cut === -1 ? name : name.slice(0, cut)).trim();
}

/**
 * Unknown keys are spread back in, so a later content pack can add a clause
 * without this editor deleting it the next time the learner types.
 */
function parseOperation(raw: unknown): ContractOperation {
  const o = rec(raw);
  const op: ContractOperation = {
    ...o,
    name: str(o.name),
    satisfies: str(o.satisfies),
    inputs: str(o.inputs),
    returns: str(o.returns),
    errors: str(o.errors),
  } as ContractOperation;
  if ('ordering' in o) op.ordering = str(o.ordering);
  if ('boundary' in o) op.boundary = str(o.boundary);
  if ('example' in o) op.example = str(o.example);
  return op;
}

export type ContractsParse = { ok: true; doc: ContractsDoc } | { ok: false; error: string };

/**
 * A learner can edit the file by hand in the code pane, so broken JSON is an
 * expected state: the panel says so and steps aside rather than overwriting it.
 */
export function parseContracts(text: string): ContractsParse {
  if (!text.trim()) return { ok: true, doc: { operations: [] } };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The file is not valid JSON.' };
  }
  const o = rec(raw);
  return { ok: true, doc: { ...o, operations: arr(o.operations).map(parseOperation) } as ContractsDoc };
}

export function serializeContracts(doc: ContractsDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Why the Contract card cannot add the contract yet: it adds the operation the
 * change request names, and the record names none.
 */
export const NAME_THE_OPERATION_FIRST = 'Name the operation on the Request tab first.';

/**
 * The amendment's purpose line under the version 1 list: the count of
 * operations above it is the list's own (`ContractSplit.v1`), so the sentence
 * says "The three above" only when three are listed, and nothing about the
 * list when none is.
 */
export function amendmentPurpose(ticketId: string, above: number): string {
  const ask = `${ticketId} asks for one new operation.`;
  if (above <= 0) return ask;
  return above === 1 ? `${ask} The one above does not change.` : `${ask} The ${numberWord(above)} above do not change.`;
}

/**
 * The Contract v2 card on a change request with no contract: the teacher's
 * contract switch is off (`change.contract`, as on Deadline badge, whose
 * Design has no API contract), so the floor counts no contract item and the
 * change request page draws no Contract tab.
 */
export const NO_CONTRACT_CHANGE = 'This change request asks for no contract, so there is no contract to write here.';

/** The contract for the operation the change names, with nothing filled in. */
export function emptyOperation(operation: string, ticketId: string): ContractOperation {
  return { name: operation, satisfies: ticketId, inputs: '', returns: '', errors: '', example: '' };
}

/**
 * Write one operation back into the document. An index of -1 appends, which is
 * what adding the CR-1 contract does: the amendment goes after the operations
 * the design phase promised, so the file reads in the order it was written.
 */
export function upsertOperation(doc: ContractsDoc, index: number, op: ContractOperation): ContractsDoc {
  const operations = index >= 0 && index < doc.operations.length
    ? doc.operations.map((o, i) => (i === index ? op : o))
    : [...doc.operations, op];
  return { ...doc, operations };
}

export interface ContractSplit {
  /** The operations the design phase promised, in file order. Read-only here. */
  v1: ContractOperation[];
  /** The CR-1 operation, when the file carries it. */
  change: ContractOperation | null;
  /** Its index in `doc.operations`, so a patch writes back to the right row. */
  changeIndex: number;
}

/**
 * The operation the change names, found by its name in the document. A change
 * that names no operation yet claims none: every operation is version 1.
 */
export function splitContracts(doc: ContractsDoc, operation: string | null): ContractSplit {
  const target = operation?.trim().toLowerCase() ?? '';
  const changeIndex = target ? doc.operations.findIndex((op) => baseName(op.name).toLowerCase() === target) : -1;
  return {
    v1: doc.operations.filter((_, i) => i !== changeIndex),
    change: changeIndex === -1 ? null : doc.operations[changeIndex],
    changeIndex,
  };
}

/** The clauses still blank, in the order the card shows them. */
export function missingParts(op: ContractOperation): string[] {
  const out: string[] = [];
  if (!op.inputs.trim()) out.push('Inputs');
  if (!op.returns.trim()) out.push('Returns');
  if (!op.errors.trim()) out.push('Errors');
  return out;
}

/** "Errors is still blank." / "Inputs and Errors are still blank." */
export function blankSentence(parts: string[]): string {
  if (parts.length === 0) return '';
  const list = andList(parts);
  return `${list} ${parts.length === 1 ? 'is' : 'are'} still blank.`;
}

export const isWritten = (op: ContractOperation): boolean => missingParts(op).length === 0;

/* --------------------------------- the diff -------------------------------- */

export type DiffMark = 'added' | 'unchanged' | 'missing';

export interface DiffRow {
  name: string;
  mark: DiffMark;
  /** What the row says about the operation, one sentence. */
  detail: string;
  /** The clause list a reader can open, empty for an unchanged row. */
  clauses: { label: string; text: string }[];
}

// No glyph for a missing row: a minus reads as "removed in v2", and the row
// means the opposite: the operation is not there yet and has to be written.
export const MARK_GLYPH: Record<DiffMark, string> = { added: '+', unchanged: '=', missing: '' };
export const MARK_WORD: Record<DiffMark, string> = { added: 'Added', unchanged: 'Unchanged', missing: 'Not written' };

/**
 * Version 1 against version 2. The v1 rows are unchanged by construction,
 * this editor writes only the CR-1 operation, so the diff's job is to show
 * that the amendment is additive, and to name the one row that is new.
 */
export function diffRows(split: ContractSplit, signature: string | null, ticketId: string): DiffRow[] {
  const rows: DiffRow[] = split.v1.map((op) => {
    const missing = missingParts(op);
    return {
      name: baseName(op.name) || op.name,
      mark: 'unchanged' as DiffMark,
      detail: missing.length > 0 ? `From your design, where ${blankSentence(missing).toLowerCase()}` : 'From your design, word for word.',
      clauses: [],
    };
  });
  if (!split.change) {
    // A change that names nothing yet has no row to promise.
    if (!signature) return rows;
    rows.push({
      name: baseName(signature),
      mark: 'missing',
      detail: `${ticketId} asks for this operation and no contract claims it yet.`,
      clauses: [],
    });
    return rows;
  }
  const op = split.change;
  const clauses = [
    { label: 'Inputs', text: op.inputs },
    { label: 'Returns', text: op.returns },
    { label: 'Errors', text: op.errors },
    { label: 'Example', text: op.example ?? '' },
  ].filter((c) => c.text.trim());
  const missing = missingParts(op);
  rows.push({
    name: baseName(op.name) || baseName(signature ?? ''),
    mark: 'added',
    detail: missing.length > 0 ? `New in ${ticketId}. ${blankSentence(missing)}` : `New in ${ticketId}, and complete.`,
    clauses,
  });
  return rows;
}

/* ------------------------------ the maintainer ----------------------------- */

/** Words that say what reopening an already open task does. */
const NO_OP = /\bno[- ]?op\b|\bidempotent\b|\balready open\b|\bunchanged\b/i;

/**
 * The maintainer's one question about the contract, in the order a reviewer
 * would ask it: is it written, is it complete, does it answer what the ticket
 * actually stated.
 */
export function maintainerNote(
  op: ContractOperation | null,
  /** The operation the change request names, the one the claim check looks for; none while it names nothing. */
  operation: string | null,
  /** The ticket's id and its acceptance lines, the stated contract the note reads. */
  ticket: { id: string; contract: string[] },
  /**
   * The phase has passed. A blank clause is still said, because it is still blank, but not with the
   * verdict that the contract "is not a contract": the review has already accepted the change.
   */
  passed = false,
): string {
  if (!op) {
    const named = operation ?? `the operation ${ticket.id} adds`;
    return `Nothing claims ${named} yet. Write the contract here before the code, or the ledger reads the operation as unclaimed.`;
  }
  const missing = missingParts(op);
  if (missing.length > 0) {
    return passed ? blankSentence(missing) : `${blankSentence(missing)} A contract the reader cannot check is not a contract.`;
  }
  const stated = ticket.contract.find((line) => NO_OP.test(line));
  const written = `${op.inputs} ${op.returns} ${op.errors} ${op.example ?? ''}`;
  if (stated && !NO_OP.test(written)) {
    return `Your contract says what the call does. What does reopening an already open task do? ${ticket.id} says it is a no-op. Put that in the contract.`;
  }
  return `The contract answers what ${ticket.id} asked for. The conformance ledger holds your code against it.`;
}

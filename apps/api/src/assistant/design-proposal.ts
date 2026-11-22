import {
  DESIGN_DECISION_STATUSES, designDocumentPaths, designFloorSentence, isObject, readDesignDocument, serialiseDesign, validateDesignRecord,
  type Design, type DesignDecision, type DesignDecisionStatus,
} from '@learnsdlc/shared';
import type { PhaseContent } from '../content/content.types';
import { recordCompactSentence } from './proposal-edits';
import { RefusedProposalException, type RefusalClause } from './proposal-refusal';

const refuse = (clause: RefusalClause, detail: string | null = null): never => { throw new RefusedProposalException('design_proposal_refused', clause, detail); };

/**
 * The ids of one list carried from the live record, matched by id first: an
 * item whose id the live list has is that item. Only an item renamed in place
 * (its live neighbour's id is gone from the proposal and its own id is new)
 * goes back to the live id; any other new id is a new item and keeps it.
 * The runbook and change-request proposals carry their ids by it too.
 */
export function carryIds<T extends { id: string }>(proposed: T[], live: T[]): { list: T[]; renamed: Map<string, string> } {
  const liveIds = new Set(live.map((item) => item.id));
  const proposedIds = new Set(proposed.map((item) => item.id));
  const renamed = new Map<string, string>();
  const list = proposed.map((item, i) => {
    const was = live[i]?.id;
    if (was && item.id !== was && !liveIds.has(item.id) && !proposedIds.has(was)) {
      renamed.set(item.id, was);
      return { ...item, id: was };
    }
    return item;
  });
  return { list, renamed };
}

/** A decision's status as saved, with the room's decided-at stamp that belongs to it; a new decision is proposed and unstamped. */
function carryStatus(decision: DesignDecision, saved: DesignDecision | undefined): DesignDecision {
  const { decidedAt: _decidedAt, ...rest } = decision;
  return { ...rest, status: saved?.status ?? 'proposed', ...(saved?.decidedAt ? { decidedAt: saved.decidedAt } : {}) };
}

function carry(proposedRecord: Design, live: Design | null, sequence: boolean): Design {
  // a switched-off sequence diagram is not part of the design: the proposal keeps the saved one
  const proposed = sequence ? proposedRecord : { ...proposedRecord, sequence: live?.sequence };
  if (!live) return { ...proposed, decisions: proposed.decisions.map((d) => carryStatus(d, undefined)) };
  const entities = carryIds(proposed.entities, live.entities);
  const operations = carryIds(proposed.operations, live.operations);
  const decisions = carryIds(proposed.decisions, live.decisions);
  // what points at a renamed id follows it back: a relation's ends, a decision's superseded-by link
  const entity = (id: string) => entities.renamed.get(id) ?? id;
  const saved = new Map(live.decisions.map((d) => [d.id, d]));
  return {
    ...proposed,
    entities: entities.list,
    relations: proposed.relations.map((r) => ({ ...r, from: entity(r.from), to: entity(r.to) })),
    operations: operations.list,
    decisions: decisions.list.map((d) => carryStatus({
      ...d, ...(d.supersededBy ? { supersededBy: decisions.renamed.get(d.supersededBy) ?? d.supersededBy } : {}),
    }, saved.get(d.id))),
  };
}

/** A story id as a `satisfies` text names it (`US-3`), as the board's fold reads one. */
const STORY_ID = /[A-Z][A-Z0-9]*-\d+/g;

/** The record's fields that are lists of texts, by section: where a generated record's lone text is read as the one-item list it means. */
const TEXT_LIST_FIELDS: Readonly<Record<'entities' | 'operations' | 'decisions', readonly string[]>> = {
  entities: ['responsibilities', 'satisfies'],
  operations: ['inputs', 'errors', 'satisfies'],
  decisions: ['consequences', 'satisfies'],
};

/**
 * A generated design record with each lone text where the schema has a list of
 * texts read as the one-item list it means, and a blank one as the empty list;
 * everything else, and any text that is not a record, exactly as written.
 *
 * Why: a model sometimes writes a decision's `satisfies` as `"US-3"` rather
 * than `["US-3"]`, and the validator refuses a text where it reads a list, so
 * the whole Design proposal would be refused. The briefing states the shape;
 * this is the second barrier, so a model that still writes the
 * lone text proposes what it meant rather than nothing. Only a **generated**
 * proposal is read this way (`dropUnchanged`): a learner's own save and edit
 * are the forms' lists, and the validator reads them as written.
 *
 * A lone `satisfies` text is read as the story ids it names (`"US-3, US-4"`
 * and `"US-3 and US-4"` are `["US-3","US-4"]`), as the board's own fold reads
 * one, since the floor traces a story by its id and a one-item list holding
 * both would trace neither. A `satisfies` text that names no id, and a lone
 * text in a free-text list (responsibilities, inputs, errors, consequences),
 * stay the one-item list as written.
 */
export function listsAsWritten(text: string): string {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return text; }
  if (!isObject(raw)) return text;
  let changed = false;
  const out: Record<string, unknown> = { ...raw };
  for (const [section, fields] of Object.entries(TEXT_LIST_FIELDS)) {
    const items = raw[section];
    if (!Array.isArray(items)) continue;
    out[section] = items.map((item) => {
      if (!isObject(item)) return item;
      const next: Record<string, unknown> = { ...item };
      for (const field of fields) {
        const value = item[field];
        if (typeof value !== 'string') continue;
        const ids = field === 'satisfies' ? value.match(STORY_ID) : null;
        next[field] = ids ? [...new Set(ids)] : value.trim() ? [value] : [];
        changed = true;
      }
      return next;
    });
  }
  return changed ? JSON.stringify(out) : text;
}

/**
 * A generated record's decision status where it is not one of the three the
 * schema names (`proposed`, `accepted`, `superseded`): read as `proposed`,
 * since a proposal never decides a status. `carry` keeps the saved status
 * for a kept decision and makes a new one proposed, so the word the model
 * wrote (`decided`, `final`, `open`...) never reaches the record, where the
 * validator would refuse the whole proposal for it. A record whose statuses are the schema's own,
 * or a text that is not a record, comes back as written. `read`, when given,
 * is told how many statuses were read as proposed, and only when there were
 * some, so the caller can count them on its one log line (the stored
 * proposal is the record after this read, so nothing else shows it happened).
 */
export function statusesAsCarried(text: string, read?: (count: number) => void): string {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return text; }
  if (!isObject(raw) || !Array.isArray(raw.decisions)) return text;
  let count = 0;
  const decisions = raw.decisions.map((d) => {
    if (!isObject(d) || DESIGN_DECISION_STATUSES.includes(d.status as DesignDecisionStatus)) return d;
    count += 1;
    return { ...d, status: 'proposed' };
  });
  if (!count) return text;
  read?.(count);
  return JSON.stringify({ ...raw, decisions });
}

/** What a design proposal keeps as the learner saved it, said when an edit or a stored proposal would change it. */
const CARRIED_CHANGED = 'The edit changes an id, a decision status or the saved sequence, which a proposal keeps as saved.';
const STORED_CARRIED_CHANGED = 'The stored proposal would change an id, a decision status or the saved sequence, which a proposal keeps as saved.';

/**
 * A design proposal as it may be shown: each path one of the documents that
 * is on, each document valid, and what a proposal never changes carried from
 * `live` (every entity, operation and decision id, every decision status, and
 * the record's sequence while the sequence diagram is off). The record comes
 * back as validated, so a key it does not have is dropped; the contracts as
 * sent. Anything else is refused with `DESIGN_PROPOSAL_REFUSED`, the rule's
 * own reason after it (`RefusedProposalException`). With `refuseCarried` (the
 * learner's own edit of a proposal, as a story edit is treated) a changed
 * carried field is refused rather than put back. With `dropUnchanged` (a
 * generated proposal), the record is read through `listsAsWritten` and
 * `statusesAsCarried` first (`onStatusRead` is told how many statuses it
 * read as proposed), a
 * document that normalises to the saved one is left out, and a proposal left
 * with nothing is refused with `DESIGN_PROPOSAL_UNCHANGED`, so no proposal
 * that changes nothing is stored. A phase of another kind passes through.
 */
export function normaliseDesignProposal(
  files: Record<string, string>, phase: PhaseContent, live: Record<string, string>,
  { refuseCarried = false, dropUnchanged = false, onStatusRead }: { refuseCarried?: boolean; dropUnchanged?: boolean; onStatusRead?: (count: number) => void } = {},
): Record<string, string> {
  if (phase.checks?.kind !== 'design') return files;
  const { record, contracts, sequence } = phase.checks;
  const allowed = designDocumentPaths(contracts);
  const out: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    if (!allowed.includes(path)) refuse('path_not_allowed', `\`${path}\` is not one of this phase's design documents.`);
    const read = readDesignDocument(path, path === record && dropUnchanged ? statusesAsCarried(listsAsWritten(text), onStatusRead) : text);
    if (read.error) refuse('invalid_document', read.error);
    if (path === record) {
      const proposed = read.design!;
      const carried = carry(proposed, validateDesignRecord(live[path] ?? '').design, sequence);
      // re-validated: a carried id must still be unique and every relation must still land
      const revalidated = validateDesignRecord(serialiseDesign(carried));
      out[path] = serialiseDesign(revalidated.design ?? refuse('carried_invalid', `With the saved ids carried, the design record is not valid: ${revalidated.error}.`));
      // both sides are the validator's own output, so they differ only where something was carried
      if (refuseCarried && out[path] !== serialiseDesign(proposed)) refuse('carried_changed', CARRIED_CHANGED);
    } else {
      out[path] = text;
    }
    if (dropUnchanged && out[path] === live[path]) delete out[path];
  }
  if (dropUnchanged && Object.keys(files).length && !Object.keys(out).length) throw new RefusedProposalException('design_proposal_unchanged', 'unchanged');
  return out;
}

/** Apply's re-check against the live documents: refused unless there is nothing to carry and nothing invalid. */
export function validateDesignProposal(files: Record<string, string>, phase: PhaseContent, live: Record<string, string>): void {
  if (phase.checks?.kind !== 'design') return;
  const normal = normaliseDesignProposal(files, phase, live);
  if (Object.keys(files).some((path) => normal[path] !== files[path])) refuse('carried_changed', STORED_CARRIED_CHANGED);
}

/**
 * What a design phase's generation call is told, in platform words only: the
 * documents it may change, the record's schema, the contracts' shapes, the
 * teacher's floor and the carry rule. The stories travel as data
 * (`designStories`), never in here. Every list of story ids is written with
 * its shape, the decisions' included (a field named without its shape is one
 * the model may write as a text). `mode` is the generation's
 * contract: `files` (the default) is the whole-file briefing, unchanged byte
 * for byte; `edits` adds that each document is one files entry, the record
 * written as compact JSON and each contract laid out as saved.
 */
export function designBriefing(phase: PhaseContent, mode: 'files' | 'edits' = 'files'): string {
  if (phase.checks?.kind !== 'design') return '';
  const { record, contracts, sequence, floor } = phase.checks;
  const documents = designDocumentPaths(contracts).map((path) => `\`${path}\``).join(', ');
  const shape = mode === 'edits'
    ? ` Under the edit-list contract each document you change is one files entry holding the whole document, never edits.${recordCompactSentence('design record', record)}${contracts.api || contracts.screens ? ' Write each contract laid out as it is saved.' : ''}`
    : '';
  return ` In this phase you may change only these documents: ${documents}. Return each document you change complete. The design record is JSON with entities (each {"id","name","kind","attributes":[{"name","type","note"}],"responsibilities":[text, at most 30],"satisfies":[story ids]}, kind one of class, component, service or screen), relations ({"id","from","to","kind","fromCard","toCard","label"}, kind one of association, aggregation, composition, inheritance or dependency, from and to entity ids, each cardinality such as 1, 0..1, * or 1..* and at most 16 characters), operations ({"id","name","inputs":[text],"returns","errors":[text],"satisfies":[story ids],"note"}, the note holding ordering, boundary or an example), decisions ({"id","title","choice","alternative","rationale","tradeOff","context","consequences":[text, at most 6],"status" (one of proposed, accepted, superseded; a new decision is proposed),"supersededBy","satisfies":[story ids]}, supersededBy the id of the decision that replaced this one), and optional sequence and notes text.${sequence ? ' The sequence is the request path as text, one message per line (Sender -> Receiver: message), and must name at least one of the operations by its name.' : " Leave the record's sequence as it is: it is not part of this design."}${contracts.api ? ' The API contract keeps its own shape: an operations list of endpoints and an errors object, code to status and meaning.' : ''}${contracts.screens ? ' The screen contract keeps its own shape: a screens list, each with route, title, component, reads, shows, components and empty.' : ''} The teacher's floor asks for ${designFloorSentence(floor, phase.checks)}. The stories to design for are in designStories. A proposal must never change an id or a decision status: they are kept as the learner saved them. Every other field, a kind or a cardinality included, may be proposed. Never change the learner's wording unless the request asks.${shape}`;
}

/**
 * The learner's design as a structured record, `design/design.json`, and the
 * two contracts beside it. The record is the only copy: the Design room reads
 * and writes it, the floor grades it, the review reads its fields. Pure: no
 * network, no DOM.
 */
import { andList } from './requirements-story';
import {
  canonicalJson, isObject, optionalField, readItemId, readObjects, readOptionalText, readRecordText, readText, readTextList, refuseRecord,
} from './record-read';

export const DESIGN_JSON = 'design/design.json';
export const API_CONTRACT_JSON = 'shared/contract/api.json';
export const SCREEN_CONTRACT_JSON = 'shared/contract/screens.json';
export const DESIGN_DOCUMENT_LABEL: Readonly<Record<string, string>> = {
  [DESIGN_JSON]: 'Design record',
  [API_CONTRACT_JSON]: 'API contract',
  [SCREEN_CONTRACT_JSON]: 'Screen contract',
};

/** The board's entity kinds; the record owns them and the room's model re-exports them. */
export type EntityKind = 'class' | 'component' | 'service' | 'screen';
export const ENTITY_KINDS: EntityKind[] = ['class', 'component', 'service', 'screen'];
/** The board's relation kinds, in the board's order, `dependency` included. */
export type DesignRelationKind = 'association' | 'aggregation' | 'composition' | 'inheritance' | 'dependency';
export const DESIGN_RELATION_KINDS: DesignRelationKind[] = ['association', 'aggregation', 'composition', 'inheritance', 'dependency'];
export type DesignDecisionStatus = 'proposed' | 'accepted' | 'superseded';
export const DESIGN_DECISION_STATUSES: DesignDecisionStatus[] = ['proposed', 'accepted', 'superseded'];
// Frozen at runtime too, as authoring.ts freezes its lists: every caller reads the same three lists, and none may widen them.
Object.freeze(ENTITY_KINDS);
Object.freeze(DESIGN_RELATION_KINDS);
Object.freeze(DESIGN_DECISION_STATUSES);

export interface DesignAttribute { name: string; type?: string; note?: string }
export interface DesignEntity { id: string; name: string; kind: EntityKind; attributes: DesignAttribute[]; responsibilities: string[]; satisfies: string[] }
/** `fromCard` and `toCard` are the board's cardinalities ("1", "0..1", "*", "1..*"), at most 16 characters each. */
export interface DesignRelation { id: string; from: string; to: string; kind: DesignRelationKind; fromCard?: string; toCard?: string; label?: string }
/** `note` holds what the board kept as an operation's ordering, boundary and example. */
export interface DesignOperation { id: string; name: string; inputs: string[]; returns: string; errors: string[]; satisfies: string[]; note?: string }
export interface DesignDecision {
  id: string; title: string; choice: string; alternative: string; rationale: string; tradeOff: string;
  /** The record's forces, and what follows from it one line each: the board's list of at most `DESIGN_CAPS.consequences`, never joined into text. */
  context?: string; consequences?: string[];
  status: DesignDecisionStatus;
  /** The id of the decision that replaced this one, as the board's decisions card holds it and the dossier prints it. */
  supersededBy?: string;
  satisfies: string[];
  /** Stamped by the room the first time the decision is accepted; the teacher journal orders by it. */
  decidedAt?: string;
}
/** The diagram studio's model, unchanged: its source text, one message per line. */
export type SequenceModel = string;
export interface Design {
  entities: DesignEntity[]; relations: DesignRelation[]; operations: DesignOperation[]; decisions: DesignDecision[];
  sequence?: SequenceModel; notes?: string;
}

export interface DesignStory { id: string; title: string; line: string }
export interface DesignContracts { api: boolean; screens: boolean }
/** What the teacher switched on: the two contracts and the sequence diagram. Every phase spec carries it, so a caller passes the spec itself. */
export interface DesignSwitches { contracts: DesignContracts; sequence: boolean }
export interface DesignFloor {
  minEntities: number; minRelations: number; minOperations: number; operationShape: boolean;
  minDecisions: number; decisionShape: boolean; traceEveryStory: boolean;
  minEndpoints: number; requireErrorCatalogue: boolean; minScreens: number; screenShape: boolean;
}
export interface DesignChecksSpec { kind: 'design'; record: typeof DESIGN_JSON; contracts: DesignContracts; sequence: boolean; stories: DesignStory[]; floor: DesignFloor }

/** One set of caps, read by the editor DTO, the upload door, publish and the record validator. */
export const DESIGN_CAPS = {
  stories: 12, storyId: 16, storyText: 400,
  entities: 20, attributes: 30, relations: 40, operations: 30, decisions: 10,
  // the board's cards cut responsibilities and consequences at these same caps, so a record the board saved is never refused
  listItems: 20, responsibilities: 30, consequences: 6,
  fieldChars: 4000, itemId: 16, cardinality: 16, decidedAt: 40, emptySentence: 15,
  minEntities: [0, 20], minRelations: [0, 40], minOperations: [0, 30],
  minDecisions: [0, 10], minEndpoints: [0, 30], minScreens: [0, 20],
} as const;

export const DEFAULT_DESIGN_FLOOR: DesignFloor = {
  minEntities: 2, minRelations: 1, minOperations: 2, operationShape: true, minDecisions: 1, decisionShape: true,
  traceEveryStory: true, minEndpoints: 2, requireErrorCatalogue: true, minScreens: 1, screenShape: true,
};
export const DEFAULT_DESIGN_CONTRACTS: DesignContracts = { api: true, screens: false };
/** A new Design phase leaves the sequence diagram out: its tab is hidden and nothing is graded for it until the teacher switches it on. */
export const DEFAULT_DESIGN_SEQUENCE = false;
export const EMPTY_DESIGN: Design = { entities: [], relations: [], operations: [], decisions: [] };
// Frozen, lists included: a caller that fills the empty record in place would fill it for every other caller.
Object.freeze(DEFAULT_DESIGN_FLOOR);
Object.freeze(DEFAULT_DESIGN_CONTRACTS);
Object.freeze(EMPTY_DESIGN.entities);
Object.freeze(EMPTY_DESIGN.relations);
Object.freeze(EMPTY_DESIGN.operations);
Object.freeze(EMPTY_DESIGN.decisions);
Object.freeze(EMPTY_DESIGN);
export const EMPTY_API_CONTRACT = '{\n  "operations": [],\n  "errors": {}\n}\n';
export const EMPTY_SCREEN_CONTRACT = '{\n  "screens": []\n}\n';

export const DESIGN_PROPOSAL_REFUSED = "The assistant's proposal was not a valid design and was discarded.";
/** A generated design proposal that normalises to the saved documents is discarded with this sentence: valid, but no change. */
export const DESIGN_PROPOSAL_UNCHANGED = "The assistant's proposal changed nothing and was discarded.";
/** Publish and the upload door without the conversion flag refuse a teacher's Design task still in the older format with this sentence. */
export const DESIGN_OLDER_FORMAT_REFUSAL = 'Design is still in the older format. Open its Design step in the editor and save it once to convert it.';
/** The class door refuses, and the assignable list drops, a version whose Design still grades markdown. */
export const DESIGN_OLDER_FORMAT_ASSIGN_REFUSAL = "This version's Design is in the older format and cannot be assigned. Publish it again from the editor.";
/** What the learner's Design room says on a version whose Design still grades markdown. */
export const DESIGN_OLDER_FORMAT_ROOM = "This project's Design task is in an older format; its owner needs to re-save it.";

export function designDocumentPaths(contracts: DesignContracts): string[] {
  return [DESIGN_JSON, ...(contracts.api ? [API_CONTRACT_JSON] : []), ...(contracts.screens ? [SCREEN_CONTRACT_JSON] : [])];
}

/**
 * The contract path a phase mounts while its switch is off, if any (the API
 * contract asked first). The pack loader and a teacher's draft compile both
 * refuse one, in the same sentence.
 */
export function mountedSwitchedOffContract(paths: readonly string[], contracts: DesignContracts): string | undefined {
  const wanted = designDocumentPaths(contracts);
  return [API_CONTRACT_JSON, SCREEN_CONTRACT_JSON].find((at) => !wanted.includes(at) && paths.includes(at));
}

const isText = (v: unknown): v is string => typeof v === 'string';

function readRecord(raw: Record<string, unknown>): Design {
  const C = DESIGN_CAPS;
  const entityIds = new Set<string>();
  const entities: DesignEntity[] = readObjects(raw, 'entities', C.entities, 'entities', 'entity').map((e, i) => {
    const id = readItemId(e, 'entity', i, entityIds, C.itemId);
    if (!ENTITY_KINDS.includes(e.kind as EntityKind)) refuseRecord(`entity ${id} has an unknown kind`);
    if (!Array.isArray(e.attributes)) refuseRecord(`entity ${id} attributes is not a list`);
    const attrs = e.attributes as unknown[];
    if (attrs.length > C.attributes) refuseRecord(`entity ${id} has more than ${C.attributes} attributes`);
    const attributes = attrs.map((a, j) => {
      if (!isObject(a)) return refuseRecord(`entity ${id} attribute ${j + 1} is not an object`);
      const type = readOptionalText(a.type, `entity ${id} attribute ${j + 1} type`, C.fieldChars);
      const note = readOptionalText(a.note, `entity ${id} attribute ${j + 1} note`, C.fieldChars);
      return { name: readText(a.name, `entity ${id} attribute ${j + 1} name`, C.fieldChars), ...optionalField('type', type), ...optionalField('note', note) };
    });
    return {
      id, name: readText(e.name, `entity ${id} name`, C.fieldChars), kind: e.kind as EntityKind, attributes,
      responsibilities: readTextList(e.responsibilities, `entity ${id} responsibilities`, C.fieldChars, C.responsibilities),
      satisfies: readTextList(e.satisfies, `entity ${id} satisfies`, C.storyId, C.listItems),
    };
  });
  const relationIds = new Set<string>();
  const relations: DesignRelation[] = readObjects(raw, 'relations', C.relations, 'relations', 'relation').map((r, i) => {
    const id = readItemId(r, 'relation', i, relationIds, C.itemId);
    for (const end of ['from', 'to'] as const) {
      const at = r[end];
      // what it points at is quoted only when it could be an id: never more than an id's 16 characters of the record
      const named = !isText(at) ? 'nothing' : at.length > C.itemId ? `an id longer than ${C.itemId} characters` : at;
      if (!isText(at) || !entityIds.has(at)) refuseRecord(`relation ${id} points at ${named}, which is not an entity`);
    }
    if (!DESIGN_RELATION_KINDS.includes(r.kind as DesignRelationKind)) refuseRecord(`relation ${id} has an unknown kind`);
    const fromCard = readOptionalText(r.fromCard, `relation ${id} fromCard`, C.cardinality);
    const toCard = readOptionalText(r.toCard, `relation ${id} toCard`, C.cardinality);
    const label = readOptionalText(r.label, `relation ${id} label`, C.fieldChars);
    return {
      id, from: r.from as string, to: r.to as string, kind: r.kind as DesignRelationKind,
      ...optionalField('fromCard', fromCard), ...optionalField('toCard', toCard), ...optionalField('label', label),
    };
  });
  const operationIds = new Set<string>();
  const operations: DesignOperation[] = readObjects(raw, 'operations', C.operations, 'operations', 'operation').map((o, i) => {
    const id = readItemId(o, 'operation', i, operationIds, C.itemId);
    const base = {
      id, name: readText(o.name, `operation ${id} name`, C.fieldChars), inputs: readTextList(o.inputs, `operation ${id} inputs`, C.fieldChars, C.listItems),
      returns: readText(o.returns, `operation ${id} returns`, C.fieldChars), errors: readTextList(o.errors, `operation ${id} errors`, C.fieldChars, C.listItems),
      satisfies: readTextList(o.satisfies, `operation ${id} satisfies`, C.storyId, C.listItems),
    };
    const note = readOptionalText(o.note, `operation ${id} note`, C.fieldChars);
    return { ...base, ...optionalField('note', note) };
  });
  const decisionIds = new Set<string>();
  const decisions: DesignDecision[] = readObjects(raw, 'decisions', C.decisions, 'decisions', 'decision').map((d, i) => {
    const id = readItemId(d, 'decision', i, decisionIds, C.itemId);
    if (!DESIGN_DECISION_STATUSES.includes(d.status as DesignDecisionStatus)) refuseRecord(`decision ${id} has an unknown status`);
    // the room stamps it; only its type and length are checked, never its format
    const decidedAt = readOptionalText(d.decidedAt, `decision ${id} decidedAt`, C.decidedAt);
    const head = {
      id, title: readText(d.title, `decision ${id} title`, C.fieldChars), choice: readText(d.choice, `decision ${id} choice`, C.fieldChars),
      alternative: readText(d.alternative, `decision ${id} alternative`, C.fieldChars), rationale: readText(d.rationale, `decision ${id} rationale`, C.fieldChars),
      tradeOff: readText(d.tradeOff, `decision ${id} tradeOff`, C.fieldChars),
    };
    const context = readOptionalText(d.context, `decision ${id} context`, C.fieldChars);
    // the board's list, blank lines kept as it keeps them while the learner types
    const consequences = d.consequences === undefined ? undefined : readTextList(d.consequences, `decision ${id} consequences`, C.fieldChars, C.consequences);
    // a decision id; null is the board's "none"
    const supersededBy = readOptionalText(d.supersededBy, `decision ${id} supersededBy`, C.itemId);
    return {
      ...head, ...optionalField('context', context), ...optionalField('consequences', consequences),
      status: d.status as DesignDecisionStatus, ...(supersededBy ? { supersededBy } : {}),
      satisfies: readTextList(d.satisfies, `decision ${id} satisfies`, C.storyId, C.listItems), ...(decidedAt ? { decidedAt } : {}),
    };
  });
  const sequence = readOptionalText(raw.sequence, 'sequence', C.fieldChars);
  const notes = readOptionalText(raw.notes, 'notes', C.fieldChars);
  return { entities, relations, operations, decisions, ...optionalField('sequence', sequence), ...optionalField('notes', notes) };
}

export function validateDesignRecord(text: string): { design: Design; error: null } | { design: null; error: string } {
  const out = readRecordText(text, 'The design record', readRecord);
  return out.error === null ? { design: out.value, error: null } : { design: null, error: out.error };
}

export function serialiseDesign(design: Design): string {
  return `${JSON.stringify(design, null, 2)}\n`;
}

/** The API contract keeps its shape: only what the floor and the projection read is required. */
export function validateApiContract(text: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return 'The API contract is not valid JSON'; }
  if (!isObject(raw)) return 'The API contract is not an object';
  if (!Array.isArray(raw.operations)) return 'The API contract has no operations list';
  const index = (raw.operations as unknown[]).findIndex((op) => !isObject(op));
  if (index >= 0) return `API contract operation ${index + 1} is not an object`;
  if (raw.errors !== undefined && !isObject(raw.errors)) return 'The API contract errors is not an object';
  return null;
}

/** The screen contract keeps its shape: a screens list whose rows each name a route. */
export function validateScreenContract(text: string): string | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return 'The screen contract is not valid JSON'; }
  if (!isObject(raw)) return 'The screen contract is not an object';
  if (!Array.isArray(raw.screens)) return 'The screen contract has no screens list';
  for (const [i, row] of (raw.screens as unknown[]).entries()) {
    if (!isObject(row)) return `Screen ${i + 1} is not an object`;
    if (!isText(row.route) || !row.route.trim()) return `Screen ${i + 1} has no route`;
  }
  return null;
}

const DOCUMENT_CHECKS: ReadonlyMap<string, { noun: string; error: (text: string) => string | null }> = new Map([
  [DESIGN_JSON, { noun: 'design record', error: (text: string) => validateDesignRecord(text).error }],
  [API_CONTRACT_JSON, { noun: 'API contract', error: validateApiContract }],
  [SCREEN_CONTRACT_JSON, { noun: 'screen contract', error: validateScreenContract }],
]);
/**
 * What is wrong with one of the three documents, by its path, as the sentence
 * a refusal says ("The API contract is not valid: ..."), or null when it is
 * valid or the path is none of them. The workspace save, the pack loader,
 * an Agentic proposal and the editor's Starting point all read a document
 * through this one door; whether a contract is switched on is the caller's to
 * check. `which` qualifies the noun ("The starting API contract ...").
 */
export function designDocumentError(path: string, text: string, which?: string): string | null {
  const check = DOCUMENT_CHECKS.get(path);
  const error = check ? check.error(text) : null;
  return check && error ? `The ${which ? `${which} ` : ''}${check.noun} is not valid: ${error}.` : null;
}

/**
 * `designDocumentError` and, for the record, the record as the validator reads
 * it, from one parse: the save guard and a proposal's normalisation need both.
 */
export function readDesignDocument(path: string, text: string, which?: string): { error: string | null; design: Design | null } {
  if (path !== DESIGN_JSON) return { error: designDocumentError(path, text, which), design: null };
  const out = validateDesignRecord(text);
  return { error: out.error ? `The ${which ? `${which} ` : ''}design record is not valid: ${out.error}.` : null, design: out.design };
}

/* --------------------------- the board's older record ------------------------- */

const str = (v: unknown): string => (isText(v) ? v : '');
const STORY_ID = /[A-Z][A-Z0-9]*-\d+/g;
const storyIds = (v: unknown): string[] =>
  [...new Set((Array.isArray(v) ? v.filter(isText) : isText(v) ? (v.match(STORY_ID) ?? []) : []).map((s) => s.trim()).filter(Boolean))];
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isText) : isText(v) && v.trim() ? [v] : []);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** The board's per-operation clauses the schema keeps in the operation's own `note`, in this order. */
const OPERATION_EXTRAS = ['ordering', 'boundary', 'example'] as const;
/** A kept value as text: a string trimmed, a number or a boolean spelled out, an object or a list as canonical JSON. */
const keptText = (v: unknown): string => (isText(v) ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : canonicalJson(v));
/** A value holding nothing to keep: missing, null, blank text, an empty list or object. */
const holdsNothing = (v: unknown): boolean =>
  v === undefined || v === null || (isText(v) && !v.trim()) || (Array.isArray(v) && !v.length) || (isObject(v) && !Object.keys(v).length);
/** A value as the fold reads it under one key: what of it the fold does not use, as text, or '' when it uses all of it. */
type Reader = (v: unknown) => string;
/** A list's entries the fold cannot use, as canonical JSON ('' when it uses every one). */
const listRest = (v: unknown[], usable: (x: unknown) => boolean): string => {
  const left = v.filter((x) => !holdsNothing(x) && !usable(x));
  return left.length ? canonicalJson(left) : '';
};
const TEXT: Reader = (v) => (isText(v) ? '' : keptText(v));
const TEXT_LIST: Reader = (v) => (isText(v) ? '' : Array.isArray(v) ? listRest(v, isText) : keptText(v));
const OBJECT_LIST: Reader = (v) => (Array.isArray(v) ? listRest(v, isObject) : keptText(v));
const FLAG: Reader = (v) => (typeof v === 'boolean' ? '' : keptText(v));
/** A refusal's status, spelled as written: text or a number. */
const CODE: Reader = (v) => (isText(v) || typeof v === 'number' ? '' : keptText(v));
/** A kind or a status: one of the schema's words, else the fold reads the default and keeps the word written. */
const oneOf = (words: readonly string[]): Reader => (v) => (isText(v) && (words.includes(v) || !v.trim()) ? '' : keptText(v));
/**
 * Story ids. A list's text entries are ids as written (a learner names their
 * stories as they like), its other entries are kept; text is read for its ids
 * and kept whole when it says more than ids ("US-3 and the login").
 */
const STORIES: Reader = (v) => {
  if (Array.isArray(v)) return listRest(v, isText);
  if (!isText(v)) return keptText(v);
  return /[^\s,;&+/|.]/.test(v.replace(STORY_ID, ' ').replace(/\band\b/gi, ' ')) ? v.trim() : '';
};
/** How the fold reads each key of an older item, by name; every other key it does not read at all. */
const ENTITY_READER: Readonly<Record<string, Reader>> = { id: TEXT, name: TEXT, kind: oneOf(ENTITY_KINDS), attributes: OBJECT_LIST, responsibilities: TEXT_LIST, satisfies: STORIES };
const ATTRIBUTE_READER: Readonly<Record<string, Reader>> = { name: TEXT, type: TEXT, note: TEXT };
const RELATION_READER: Readonly<Record<string, Reader>> = { id: TEXT, from: TEXT, to: TEXT, kind: oneOf(DESIGN_RELATION_KINDS), fromCard: TEXT, toCard: TEXT, label: TEXT };
const OPERATION_READER: Readonly<Record<string, Reader>> = {
  id: TEXT, name: TEXT, inputs: TEXT_LIST, returns: TEXT, errors: TEXT_LIST, satisfies: STORIES, note: TEXT, ordering: TEXT, boundary: TEXT, example: TEXT,
};
const DECISION_READER: Readonly<Record<string, Reader>> = {
  id: TEXT, title: TEXT, choice: TEXT, alternative: TEXT, rationale: TEXT, tradeOff: TEXT, tradeoff: TEXT, context: TEXT, consequences: TEXT_LIST,
  status: oneOf(DESIGN_DECISION_STATUSES), supersededBy: TEXT, satisfies: STORIES, stories: STORIES, decidedAt: TEXT,
};
const FIELD_READER: Readonly<Record<string, Reader>> = { name: TEXT, type: TEXT, required: FLAG, note: TEXT, satisfies: STORIES };
const ENDPOINT_READER: Readonly<Record<string, Reader>> = { method: TEXT, path: TEXT, purpose: TEXT, refusals: OBJECT_LIST };
const REFUSAL_READER: Readonly<Record<string, Reader>> = { status: CODE, code: TEXT, when: TEXT };
const RECORD_READER: Readonly<Record<string, Reader>> = {
  entities: OBJECT_LIST, relations: OBJECT_LIST, operations: OBJECT_LIST, decisions: OBJECT_LIST, fields: OBJECT_LIST, endpoints: OBJECT_LIST, sequence: TEXT, notes: TEXT,
};
/**
 * What of `item` the fold does not use, key by key in the order written, as
 * text: a key it reads, the part its reader leaves; a key it does not read (or
 * one named in `shadowed`, which another key wins over), all of it, through
 * `unread`. A key holding nothing has nothing to keep.
 */
function leftovers(item: Record<string, unknown>, reader: Readonly<Record<string, Reader>>, unread: (v: unknown) => string = keptText, shadowed: readonly string[] = []): [string, string][] {
  return Object.keys(item).flatMap((key): [string, string][] => {
    const v = item[key];
    if (holdsNothing(v)) return [];
    const read = Object.prototype.hasOwnProperty.call(reader, key) && !shadowed.includes(key);
    const text = read ? reader[key](v) : unread(v);
    return text ? [[key, text]] : [];
  });
}
const said = (rest: [string, string][]): string[] => rest.map(([key, text]) => `${key}: ${text}`);
const keysOf = (rest: [string, string][], quiet: readonly string[] = []): string[] => rest.map(([key]) => key).filter((key) => !quiet.includes(key));

/** Whether a parsed record is the board's older shape (fields, endpoints, text operations or their extras, a lowercase tradeoff or no title). A listed `consequences` is the schema's own shape, not an older one. */
export function isLegacyDesignShape(raw: unknown): boolean {
  if (!isObject(raw)) return false;
  if ('fields' in raw || 'endpoints' in raw) return true;
  const ops = Array.isArray(raw.operations) ? raw.operations.filter(isObject) : [];
  const decs = Array.isArray(raw.decisions) ? raw.decisions.filter(isObject) : [];
  return ops.some((o) => !Array.isArray(o.inputs) || !isText(o.id) || OPERATION_EXTRAS.some((key) => key in o))
    || decs.some((d) => 'tradeoff' in d || !isText(d.title));
}

/** The older board's own limits the record has no cap for: endpoints, each endpoint's refusals, and a decision's stories. */
const BOARD_ENDPOINTS = 30;
const BOARD_REFUSALS = 30;
const BOARD_DECISION_STORIES = 8;

/** The board's own cut of a list (model.ts slices each one before it draws it), named in `folded` and in `cut` when a written item is left out. */
function boardCut<T>(items: T[], limit: number, written: (item: T) => boolean, what: (n: number) => string, folded: string[], cut: string[]): T[] {
  const left = items.slice(limit).filter(written).length;
  if (left) {
    const line = `${what(left)} left out: over the board's limit of ${limit}`;
    folded.push(line);
    cut.push(line);
  }
  return items.slice(0, limit);
}

/** Each item's id: its own unless an earlier item took it, else the first `<prefix>N` from its position that no item wrote or took. */
function foldIds(items: Record<string, unknown>[], prefix: string, noun: string, folded: string[]): string[] {
  const written = new Set(items.map((item) => str(item.id).trim()).filter(Boolean));
  const taken = new Set<string>();
  return items.map((item, i) => {
    const own = str(item.id).trim();
    if (own && !taken.has(own)) { taken.add(own); return own; }
    let n = i + 1;
    while (written.has(`${prefix}${n}`) || taken.has(`${prefix}${n}`)) n += 1;
    const id = `${prefix}${n}`;
    taken.add(id);
    if (own) folded.push(`the repeated id ${own} of ${noun} ${i + 1} read as ${id}`);
    return id;
  });
}

const notesCut = (n: number, what: string) =>
  `${count(n, `${what} line`, `${what} lines`)} left out of the notes: over the ${DESIGN_CAPS.fieldChars}-character cap`;

/**
 * The board's older record, folded into the schema. The schema carries
 * everything the board draws (an entity's kind and responsibilities, a
 * relation's cardinalities and its dependency kind, a decision's context, its
 * consequences list and its superseded-by link), so those move field for
 * field. Only what the schema retires moves elsewhere: `fields` become the
 * entity Model (or lines in `notes` beside drawn entities), `endpoints` go to
 * `notes`, and an operation's ordering, boundary and example go to its own
 * `note`. Nothing else is dropped in silence: every key the fold does not
 * read, and every value it reads but cannot use (a `satisfies` text that says
 * more than story ids, a list entry or a value of the wrong type, an unknown
 * kind or status), is kept as text, "key: value", an object or a list as
 * canonical JSON, in the nearest place the schema has: an operation's and an
 * attribute's own `note`, a relation's `label`, a field's or an endpoint's
 * notes line (or the Model attribute's note), and a line each in `notes` for
 * an entity ("Entity E1 colour: blue"), a decision ("Decision D1 ...") and the
 * record itself (title: "Board"); `folded` names each one. Decisions beyond
 * the record's 10 go to `notes` as whole lines. The board's own limits apply
 * first (entities 20, relations 40, attributes 30, responsibilities 30,
 * consequences 6, endpoints 30, refusals 30 per endpoint, stories 8 per
 * decision), an operation's or an attribute's note takes its parts only while
 * they fit the 4000-character cap, and lines added to `notes` stop, whole, at
 * that cap; those are the only cuts, and
 * `folded` names each one with everything that moved, while `cut` lists the
 * cuts alone (each also in `folded`), so a caller that must never cut a
 * learner's words (the migration from markdown designs, the boot re-pin) refuses on it without
 * matching text. The room's reader shows the fold, cuts named, as before.
 * A missing or repeated id gets one no other item has. What the board itself
 * never capped (more than 30 operations, an over-long text) still fails the
 * validator, which the caller runs on the result.
 */
export function foldLegacyDesign(raw: unknown): { design: Design; folded: string[]; cut: string[] } | null {
  if (!isObject(raw)) return null;
  const C = DESIGN_CAPS;
  const folded: string[] = [];
  const cut: string[] = [];
  // a line left out of the notes at the cap: named in `folded`, and counted in `cut`
  const notesLeftOut = (n: number, what: string) => {
    const line = notesCut(n, what);
    folded.push(line);
    cut.push(line);
  };
  const rawNotes = str(raw.notes).trim() ? str(raw.notes) : '';
  const notes: string[] = [];
  let room = C.fieldChars - rawNotes.length;
  let closed = false;
  // a line joins the notes only whole and only while every line before it did, so the kept lines stay in order
  const addNote = (line: string): boolean => {
    const cost = line.length + (rawNotes || notes.length ? 1 : 0);
    if (closed || cost > room) { closed = true; return false; }
    notes.push(line);
    room -= cost;
    return true;
  };

  // an item's note from its parts, joined with '; ' while they fit the field cap (the first always kept, as the validator
  // judges it); the parts left out are a cut, named per owner
  const joinNote = (parts: string[], owner: string, alreadyLeft = 0): string => {
    const kept: string[] = [];
    let left = alreadyLeft;
    for (const part of parts.filter(Boolean)) {
      if (kept.length && (left > alreadyLeft || [...kept, part].join('; ').length > C.fieldChars)) left += 1;
      else kept.push(part);
    }
    if (left) {
      const line = `${count(left, 'part', 'parts')} of the note of ${owner} left out: over the ${C.fieldChars}-character cap`;
      folded.push(line);
      cut.push(line);
    }
    return kept.join('; ');
  };

  // what an entity, a decision or the record leaves, a line each in the notes; `quiet` keys are named by their own "read as" line, and the lines the cap leaves out are counted per noun
  const keyLinesLeft = new Map<string, number>();
  const keepAsLines = (rest: [string, string][], prefix: string, owner: string, noun: string, quiet: readonly string[] = []) => {
    const kept: string[] = [];
    for (const [key, text] of rest) {
      if (addNote(`${prefix}${key}: ${text}`)) kept.push(key);
      else keyLinesLeft.set(noun, (keyLinesLeft.get(noun) ?? 0) + 1);
    }
    const named = kept.filter((key) => !quiet.includes(key));
    if (named.length) folded.push(`the ${andList(named)} of ${owner} kept in the notes`);
  };
  const leftOutKeys = (noun: string) => {
    const left = keyLinesLeft.get(noun) ?? 0;
    if (left) notesLeftOut(left, `${noun} key`);
  };

  const drawn = boardCut(Array.isArray(raw.entities) ? raw.entities.filter(isObject) : [], C.entities, () => true, (n) => count(n, 'entity', 'entities'), folded, cut);
  const entityIds = foldIds(drawn, 'E', 'entity', folded);
  const entities: DesignEntity[] = drawn.map((e, i) => {
    const id = entityIds[i];
    const known = ENTITY_KINDS.includes(e.kind as EntityKind);
    // the board reads a missing or unknown kind as class (model.ts parseEntity); say so when one was written
    if (!known && !holdsNothing(e.kind)) folded.push(`the kind "${keptText(e.kind)}" of ${id} read as class`);
    const attributes = boardCut(Array.isArray(e.attributes) ? e.attributes.filter(isObject) : [], C.attributes, () => true, (n) => `${count(n, 'attribute', 'attributes')} of ${id}`, folded, cut)
      .map((a, j) => {
        const rest = leftovers(a, ATTRIBUTE_READER);
        if (rest.length) folded.push(`the ${andList(keysOf(rest))} of attribute ${j + 1} of ${id} kept in its note`);
        const note = joinNote([str(a.note), ...said(rest)], `attribute ${j + 1} of ${id}`);
        return { name: str(a.name), ...(str(a.type) ? { type: str(a.type) } : {}), ...(note ? { note } : {}) };
      });
    const responsibilities = boardCut(asList(e.responsibilities), C.responsibilities, (s) => !!s.trim(), (n) => `${count(n, 'responsibility', 'responsibilities')} of ${id}`, folded, cut)
      .map((s) => s.trim()).filter(Boolean);
    keepAsLines(leftovers(e, ENTITY_READER), `Entity ${id} `, id, 'entity', ['kind']);
    return { id, name: str(e.name), kind: known ? (e.kind as EntityKind) : 'class', attributes, responsibilities, satisfies: storyIds(e.satisfies) };
  });
  leftOutKeys('entity');

  const fields = Array.isArray(raw.fields) ? raw.fields.filter(isObject) : [];
  const fieldNote = (f: Record<string, unknown>) => [f.required === true ? 'required' : '', str(f.note)].filter(Boolean).join(', ');
  // what each field leaves, kept in its attribute's note or after its notes line
  const fieldRest = fields.map((f) => leftovers(f, FIELD_READER));
  const fieldKept = (i: number, where: string) => {
    if (fieldRest[i].length) folded.push(`the ${andList(keysOf(fieldRest[i]))} of field ${i + 1} kept in ${where}`);
  };
  // with no entity drawn, the fields are the one entity Model, up to its attribute cap; the rest go to notes
  const modelFields = entities.length === 0 ? fields.slice(0, C.attributes) : [];
  if (modelFields.length) {
    entities.push({
      id: 'E1', name: 'Model', kind: 'class',
      attributes: modelFields.map((f, i) => {
        // the required flag goes in front of the field's note only when both fit; else the note is kept and the flag named as cut
        const flagged = fieldNote(f);
        const over = f.required === true && !!str(f.note) && flagged.length > C.fieldChars;
        const note = joinNote([over ? str(f.note) : flagged, ...said(fieldRest[i])], `attribute ${i + 1} of E1`, over ? 1 : 0);
        return { name: str(f.name), ...(str(f.type) ? { type: str(f.type) } : {}), ...(note ? { note } : {}) };
      }),
      responsibilities: [],
      satisfies: [...new Set(modelFields.flatMap((f) => storyIds(f.satisfies)))],
    });
    folded.push(`${count(modelFields.length, 'field', 'fields')} became the attributes of the entity Model`);
    modelFields.forEach((_, i) => fieldKept(i, 'its note'));
  }
  const noteFields = fields.slice(modelFields.length);
  const fieldLine = (f: Record<string, unknown>, i: number) => {
    const details = [str(f.type), fieldNote(f)].filter(Boolean).join(', ');
    const stories = storyIds(f.satisfies);
    return [`Field ${str(f.name)}${details ? `: ${details}` : ''}${stories.length ? `; serves ${stories.join(', ')}` : ''}`, ...said(fieldRest[i])].join('; ');
  };
  if (noteFields.length) {
    const keptAt: number[] = [];
    noteFields.forEach((f, k) => {
      const i = modelFields.length + k;
      if (addNote(fieldLine(f, i))) keptAt.push(i);
    });
    const kept = keptAt.length;
    if (kept) folded.push(`${count(kept, 'field', 'fields')} kept in the notes`);
    keptAt.forEach((i) => fieldKept(i, 'its notes line'));
    if (kept < noteFields.length) notesLeftOut(noteFields.length - kept, 'field');
  }

  const ids = new Set(entities.map((e) => e.id));
  const relations: DesignRelation[] = [];
  const written = boardCut(Array.isArray(raw.relations) ? raw.relations.filter(isObject) : [], C.relations, () => true, (n) => count(n, 'relation', 'relations'), folded, cut);
  const relationIds = foldIds(written, 'R', 'relation', folded);
  let relationsCut = 0;
  for (const [i, r] of written.entries()) {
    const id = relationIds[i];
    // a relation whose end is no entity cannot be drawn or validated: its words stay, as a line in notes, its kind and
    // cardinalities (which the line does not spell) kept after them with all else it leaves
    if (!ids.has(str(r.from)) || !ids.has(str(r.to))) {
      const rest = leftovers(r, RELATION_READER, keptText, ['kind', 'fromCard', 'toCard']);
      if (addNote([`Relation ${id}: ${str(r.from)} to ${str(r.to)} ${str(r.label)}`.trim(), ...said(rest)].join('; '))) {
        folded.push(`relation ${id} kept in the notes: it points at no entity`);
        if (rest.length) folded.push(`the ${andList(keysOf(rest))} of ${id} kept in its notes line`);
      } else relationsCut += 1;
      continue;
    }
    const rest = leftovers(r, RELATION_READER);
    const known = DESIGN_RELATION_KINDS.includes(r.kind as DesignRelationKind);
    if (!known && !holdsNothing(r.kind)) folded.push(`the kind "${keptText(r.kind)}" of ${id} read as association`);
    const named = keysOf(rest, ['kind']);
    if (named.length) folded.push(`the ${andList(named)} of ${id} kept in its label`);
    const fromCard = str(r.fromCard).trim(), toCard = str(r.toCard).trim(), label = [str(r.label).trim(), ...said(rest)].filter(Boolean).join('; ');
    relations.push({
      id, from: str(r.from), to: str(r.to), kind: known ? (r.kind as DesignRelationKind) : 'association',
      ...(fromCard ? { fromCard } : {}), ...(toCard ? { toCard } : {}), ...(label ? { label } : {}),
    });
  }
  if (relationsCut) notesLeftOut(relationsCut, 'relation');

  const rawOperations = Array.isArray(raw.operations) ? raw.operations.filter(isObject) : [];
  const operationIds = foldIds(rawOperations, 'O', 'operation', folded);
  const operations: DesignOperation[] = rawOperations.map((o, i) => {
    const id = operationIds[i];
    // the board's three clauses first, in their order, then every key the fold does not read, as written
    const extras: [string, string][] = [...OPERATION_EXTRAS.map((key): [string, string] => [key, str(o[key]).trim()]).filter(([, text]) => text), ...leftovers(o, OPERATION_READER)];
    if (extras.length) folded.push(`the ${andList(extras.map(([key]) => key))} of ${id} kept in its note`);
    const note = joinNote([str(o.note).trim(), ...extras.map(([key, text]) => `${key}: ${text}`)], id);
    return {
      id, name: str(o.name), inputs: asList(o.inputs), returns: str(o.returns), errors: asList(o.errors), satisfies: storyIds(o.satisfies),
      ...(note ? { note } : {}),
    };
  });

  const rawDecisions = Array.isArray(raw.decisions) ? raw.decisions.filter(isObject) : [];
  const decisionIds = foldIds(rawDecisions, 'D', 'decision', folded);
  // the board drew more decisions than the record keeps: the rest are whole lines in the notes, every key as written
  const beyond = rawDecisions.slice(C.decisions);
  if (beyond.length) {
    const kept = beyond.filter((d, k) => addNote(`Decision ${decisionIds[C.decisions + k]}: ${canonicalJson(d)}`)).length;
    if (kept) folded.push(`${count(kept, 'decision', 'decisions')} beyond the record's ${C.decisions} kept in the notes`);
    if (kept < beyond.length) notesLeftOut(beyond.length - kept, 'decision');
  }
  const decisions: DesignDecision[] = rawDecisions.slice(0, C.decisions).map((d, i) => {
    const id = decisionIds[i];
    const context = str(d.context).trim();
    // the board keeps consequences as a list of at most `C.consequences`; the record keeps that list, blank lines dropped
    const consequences = boardCut(asList(d.consequences), C.consequences, (s) => !!s.trim(), (n) => `${count(n, 'consequence', 'consequences')} of ${id}`, folded, cut)
      .map((s) => s.trim()).filter(Boolean);
    const supersededBy = str(d.supersededBy).trim();
    const status = DESIGN_DECISION_STATUSES.includes(d.status as DesignDecisionStatus) ? (d.status as DesignDecisionStatus) : 'proposed';
    if (!DESIGN_DECISION_STATUSES.includes(d.status as DesignDecisionStatus) && !holdsNothing(d.status)) folded.push(`the status "${keptText(d.status)}" of ${id} read as proposed`);
    // the lowercase tradeoff and the stories list are read only when the schema's own key is not there to win over them
    const shadowed = [
      ...(str(d.tradeOff) && str(d.tradeOff) !== str(d.tradeoff) ? ['tradeoff'] : []), ...(d.satisfies === undefined || d.satisfies === null ? [] : ['stories']),
    ];
    keepAsLines(leftovers(d, DECISION_READER, keptText, shadowed), `Decision ${id} `, id, 'decision', ['status']);
    return {
      id, title: str(d.title) || str(d.choice), choice: str(d.choice), alternative: str(d.alternative), rationale: str(d.rationale),
      tradeOff: str(d.tradeOff) || str(d.tradeoff), ...(context ? { context } : {}), ...(consequences.length ? { consequences } : {}),
      status, ...(supersededBy ? { supersededBy } : {}),
      satisfies: boardCut(storyIds(d.satisfies ?? d.stories), BOARD_DECISION_STORIES, () => true, (n) => `${count(n, 'story', 'stories')} of ${id}`, folded, cut),
      ...(isText(d.decidedAt) && d.decidedAt ? { decidedAt: d.decidedAt } : {}),
    };
  });

  leftOutKeys('decision');

  const endpoints = boardCut(Array.isArray(raw.endpoints) ? raw.endpoints.filter(isObject) : [], BOARD_ENDPOINTS, () => true, (n) => count(n, 'endpoint', 'endpoints'), folded, cut);
  // one compact line each: "Endpoint GET /api/tasks/overdue: the report; refuses 400 invalid_date when bad today"
  // what an endpoint and each of its refusals leave goes on its line too, a refusal's in brackets after it; `named` collects what to name once the line is kept
  const endpointLine = (e: Record<string, unknown>, n: number, named: string[]) => {
    const rest = leftovers(e, ENDPOINT_READER);
    if (rest.length) named.push(`the ${andList(keysOf(rest))} of endpoint ${n} kept in its notes line`);
    const refusals = boardCut(Array.isArray(e.refusals) ? e.refusals.filter(isObject) : [], BOARD_REFUSALS, () => true, (k) => `${count(k, 'refusal', 'refusals')} of endpoint ${n}`, folded, cut)
      .map((r, m) => {
        const own = leftovers(r, REFUSAL_READER);
        if (own.length) named.push(`the ${andList(keysOf(own))} of refusal ${m + 1} of endpoint ${n} kept in its notes line`);
        const status = isText(r.status) || typeof r.status === 'number' ? String(r.status) : '';
        const piece = [status, str(r.code), str(r.when) ? `when ${str(r.when)}` : ''].filter(Boolean).join(' ');
        return [piece, own.length ? `(${said(own).join('; ')})` : ''].filter(Boolean).join(' ');
      })
      .filter(Boolean);
    const head = [str(e.method), str(e.path)].filter(Boolean).join(' ');
    return [`Endpoint${head ? ` ${head}` : ''}${str(e.purpose) ? `: ${str(e.purpose)}` : ''}${refusals.length ? `; refuses ${refusals.join(', ')}` : ''}`, ...said(rest)].join('; ');
  };
  if (endpoints.length) {
    let kept = 0;
    const names: string[] = [];
    endpoints.forEach((e, k) => {
      const named: string[] = [];
      if (addNote(endpointLine(e, k + 1, named))) { kept += 1; names.push(...named); }
    });
    if (kept) folded.push(`${count(kept, 'endpoint', 'endpoints')} kept in the notes; the API contract is the one place for endpoints`);
    folded.push(...names);
    if (kept < endpoints.length) notesLeftOut(endpoints.length - kept, 'endpoint');
  }

  // the record's own keys last: one it does not read, or a value it cannot use, as a "key: canonical JSON" line
  keepAsLines(leftovers(raw, RECORD_READER, canonicalJson), '', 'the record', 'record');
  leftOutKeys('record');

  const sequence = str(raw.sequence);
  const allNotes = [rawNotes, ...notes].filter(Boolean).join('\n');
  return { design: { entities, relations, operations, decisions, ...(sequence ? { sequence } : {}), ...(allNotes ? { notes: allNotes } : {}) }, folded, cut };
}

/* --------------------------------- the readers -------------------------------- */

/**
 * A design record's text as a reader shows it, read-only: a record the
 * validator accepts is read as it is, and an older board's record (or one the
 * validator refuses that the fold can read) is shown folded, `folded` true.
 * Validated first, folded only when the record is invalid or carries older
 * keys, as the loader does (a valid record can also match the older shape).
 * Empty text is no record and no error; anything else that cannot be read
 * says why, in the validator's words. Nothing is written back.
 */
export function readDesignRecord(text: string): { design: Design; folded: boolean; error: null } | { design: null; folded: false; error: string | null } {
  if (!text.trim()) return { design: null, folded: false, error: null };
  const valid = validateDesignRecord(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { design: null, folded: false, error: valid.error ?? 'The design record is not valid JSON' }; }
  if (valid.design && !isLegacyDesignShape(raw)) return { design: valid.design, folded: false, error: null };
  const fold = foldLegacyDesign(raw);
  const checked = fold ? validateDesignRecord(serialiseDesign(fold.design)) : null;
  if (checked?.design) return { design: checked.design, folded: true, error: null };
  return { design: null, folded: false, error: valid.error ?? checked?.error ?? 'The design record is not an object' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The day a decision was first accepted, "4 March 2026", read in UTC so the
 * same stamp reads the same day for every reader. Empty for no stamp or one
 * that is not a date.
 */
export function decidedOn(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

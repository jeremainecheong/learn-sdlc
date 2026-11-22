/**
 * The Design phase's deterministic floor over the record and its switched-on
 * contracts, the labelled projection the review cites field by field, and the
 * change set an Agentic proposal shows. Pure: no network, no DOM.
 */
import {
  API_CONTRACT_JSON, DESIGN_CAPS, DESIGN_JSON, EMPTY_DESIGN, SCREEN_CONTRACT_JSON, validateDesignRecord,
  type Design, type DesignFloor, type DesignStory, type DesignSwitches,
} from './design-record';
import { canonicalJson, isObject } from './record-read';
import { numberedSlots as slots, projectionChangeSet, uniqueKeys, type FieldChange } from './projection-diff';
import { pluralWord as word } from './words';
import { andList } from './requirements-story';

export type DesignFloorId =
  | 'design.record' | 'design.entities.min' | 'design.relations.min' | 'design.operations.min' | 'design.operations.shape'
  | 'design.decisions.min' | 'design.decisions.shape' | 'design.trace'
  | 'design.api.min' | 'design.api.errors' | 'design.screens.min' | 'design.screens.shape' | 'design.sequence';
export const DESIGN_FLOOR_IDS: readonly DesignFloorId[] = [
  'design.record', 'design.entities.min', 'design.relations.min', 'design.operations.min', 'design.operations.shape',
  'design.decisions.min', 'design.decisions.shape', 'design.trace',
  'design.api.min', 'design.api.errors', 'design.screens.min', 'design.screens.shape', 'design.sequence',
];
export interface DesignFloorResult { id: DesignFloorId; label: string; passed: boolean; detail: string }
export type DesignDocuments = Readonly<Record<string, string | undefined>>;
export interface DesignFloorSpec extends DesignSwitches { stories: DesignStory[]; floor: DesignFloor }

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const someText = (v: unknown): boolean => Array.isArray(v) && v.some(filled);
function parsed(text: string | undefined): Record<string, unknown> | null {
  try { const v = JSON.parse(text ?? ''); return isObject(v) ? v : null; } catch { return null; }
}

export function apiEndpoints(text: string | undefined): Record<string, unknown>[] {
  const doc = parsed(text);
  return Array.isArray(doc?.operations) ? (doc!.operations as unknown[]).filter(isObject) : [];
}
/** An endpoint the floor counts: one with a method and a non-blank path; a blank row the room added is not one yet. */
const endpointNamed = (e: Record<string, unknown>): boolean => filled(e.method) && filled(e.path);
/** The catalogue's error codes: a `$`-prefixed key (`$comment`) annotates the catalogue and is not an error. */
function apiErrorCodes(text: string | undefined): string[] {
  const doc = parsed(text);
  return isObject(doc?.errors) ? Object.keys(doc!.errors as Record<string, unknown>).filter((code) => !code.startsWith('$')) : [];
}
export function screenRows(text: string | undefined): Record<string, unknown>[] {
  const doc = parsed(text);
  return Array.isArray(doc?.screens) ? (doc!.screens as unknown[]).filter(isObject) : [];
}
function screenComplete(row: Record<string, unknown>): boolean {
  return filled(row.component) && someText(row.reads) && someText(row.components)
    && typeof row.empty === 'string' && row.empty.trim().length >= DESIGN_CAPS.emptySentence;
}

export function designFloorIds(switches: DesignSwitches): DesignFloorId[] {
  const { contracts, sequence } = switches;
  return DESIGN_FLOOR_IDS.filter((id) => (contracts.api || !id.startsWith('design.api'))
    && (contracts.screens || !id.startsWith('design.screens')) && (sequence || id !== 'design.sequence'));
}

/** An operation's bare name: what comes before its first parenthesis, trimmed ("getOverdue(today)" is "getOverdue"). */
export function operationBaseName(name: string): string {
  const cut = name.indexOf('(');
  return (cut === -1 ? name : name.slice(0, cut)).trim();
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether the diagram's source names at least one of the learner's own
 * operations: the bare name, case-sensitive, as a whole word (a letter, digit
 * or underscore on either side means it is part of a longer name). The whole
 * source is scanned, participant names included: a participant named after an
 * operation counts, which is accepted as it is.
 */
function sequenceNamesAnOperation(design: Design): boolean {
  const source = design.sequence ?? '';
  if (!source.trim()) return false;
  return design.operations.some((o) => {
    const base = operationBaseName(o.name);
    return base.length > 0 && new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(base)}(?![A-Za-z0-9_])`).test(source);
  });
}

function minRule(id: DesignFloorId, have: number, want: number, one: string, many: string, place: string): DesignFloorResult {
  return {
    id, label: `At least ${want} ${word(want, one, many)}`, passed: have >= want,
    detail: have >= want ? `${have} ${word(have, one, many)}` : `Fewer than ${want} ${word(want, one, many)}${place}`,
  };
}

export function evaluateDesignFloor(docs: DesignDocuments, spec: DesignFloorSpec): DesignFloorResult[] {
  const { floor, contracts, stories, sequence } = spec;
  const out = validateDesignRecord(docs[DESIGN_JSON] ?? '');
  const d: Design = out.design ?? EMPTY_DESIGN;
  const shapeless = d.operations.filter((o) => !o.inputs.some(filled) || !o.returns.trim()).length;
  const unjustified = d.decisions.filter((x) => !x.rationale.trim() || !x.tradeOff.trim()).length;
  const traced = (id: string) => d.operations.some((o) => o.satisfies.includes(id)) || d.entities.some((e) => e.satisfies.includes(id));
  // a story the teacher listed twice is one story, named once
  const untraced = [...new Set(stories.map((s) => s.id))].filter((id) => !traced(id));
  // the entity and operation minimums count named items only (the room's Add buttons create blank rows); the
  // decision minimum still counts every row, as TaskTrackr's recorded verdict counts its scaffold's blank decision
  const results: DesignFloorResult[] = [
    {
      id: 'design.record', label: 'The design record', passed: !out.error,
      detail: out.error ? 'The design record is missing or not valid' : 'The record is well formed',
    },
    minRule('design.entities.min', d.entities.filter((e) => e.name.trim()).length, floor.minEntities, 'entity', 'entities', ' in the data model'),
    minRule('design.relations.min', d.relations.length, floor.minRelations, 'relation', 'relations', ' between entities'),
    minRule('design.operations.min', d.operations.filter((o) => o.name.trim()).length, floor.minOperations, 'operation', 'operations', ''),
    {
      id: 'design.operations.shape', label: 'Every operation has an input and a return', passed: !floor.operationShape || shapeless === 0,
      detail: !floor.operationShape ? 'Not required' : shapeless === 0 ? 'Every operation names an input and a return'
        : `${shapeless} ${word(shapeless, 'operation has', 'operations have')} no input or no return`,
    },
    minRule('design.decisions.min', d.decisions.length, floor.minDecisions, 'decision', 'decisions', ''),
    {
      id: 'design.decisions.shape', label: 'Every decision has a rationale and a trade-off', passed: !floor.decisionShape || unjustified === 0,
      detail: !floor.decisionShape ? 'Not required' : unjustified === 0 ? 'Every decision gives a rationale and a trade-off'
        : `${unjustified} ${word(unjustified, 'decision has', 'decisions have')} no rationale or no trade-off`,
    },
    {
      id: 'design.trace', label: 'Every story is traced', passed: !floor.traceEveryStory || untraced.length === 0,
      detail: !floor.traceEveryStory ? 'Not required' : untraced.length === 0 ? (stories.length ? 'Every story is traced' : 'No stories to trace')
        : `${word(untraced.length, 'Story', 'Stories')} not traced by any operation or entity: ${untraced.join(', ')}`,
    },
  ];
  if (contracts.api) {
    const catalogue = apiErrorCodes(docs[API_CONTRACT_JSON]).length;
    results.push(minRule('design.api.min', apiEndpoints(docs[API_CONTRACT_JSON]).filter(endpointNamed).length, floor.minEndpoints, 'endpoint', 'endpoints', ' in the API contract'));
    results.push({
      id: 'design.api.errors', label: 'An error catalogue', passed: !floor.requireErrorCatalogue || catalogue > 0,
      detail: !floor.requireErrorCatalogue ? 'Not required'
        : catalogue > 0 ? `${catalogue} ${word(catalogue, 'error', 'errors')} declared` : 'The API contract has no error catalogue',
    });
  }
  if (contracts.screens) {
    const rows = screenRows(docs[SCREEN_CONTRACT_JSON]);
    const incomplete = rows.filter((row) => !screenComplete(row)).length;
    results.push(minRule('design.screens.min', rows.length, floor.minScreens, 'screen', 'screens', ' in the screen contract'));
    results.push({
      id: 'design.screens.shape', label: 'Every screen is complete', passed: !floor.screenShape || incomplete === 0,
      detail: !floor.screenShape ? 'Not required' : incomplete === 0 ? 'Every screen is complete'
        : `${incomplete} ${word(incomplete, 'screen is', 'screens are')} missing a component, reads, components or an empty-state sentence`,
    });
  }
  // the sequence diagram is part of the artefact only when the teacher switched it on; then it must name one of the learner's operations
  if (sequence) {
    const named = sequenceNamesAnOperation(d);
    results.push({
      id: 'design.sequence', label: 'The sequence diagram names an operation', passed: named,
      detail: named ? 'The sequence diagram names at least one operation' : 'The sequence diagram is missing or names none of the operations',
    });
  }
  return results;
}

/**
 * The floor in words, its clauses joined by semicolons. A shape rule is named
 * even when its minimum is 0 ("every operation with an input and a return"),
 * and with nothing else switched on the sentence still asks for the record.
 */
export function designFloorSentence(floor: DesignFloor, switches: DesignSwitches): string {
  const { contracts, sequence } = switches;
  const parts: string[] = [];
  const n = (count: number, one: string, many: string) => `${count} ${word(count, one, many)}`;
  // "at least 2 operations, each with ...", "at least 1 decision with ...", "every decision with ..."
  const shaped = (min: number, one: string, many: string, shape: boolean, what: string, eachForOne: boolean) => {
    if (!min) return shape ? `every ${one} ${what}` : '';
    const tail = !shape ? '' : min === 1 && !eachForOne ? ` ${what}` : `, each ${what}`;
    return `at least ${n(min, one, many)}${tail}`;
  };
  const model = [
    floor.minEntities ? n(floor.minEntities, 'entity', 'entities') : '',
    floor.minRelations ? n(floor.minRelations, 'relation', 'relations') : '',
  ].filter(Boolean);
  if (model.length) parts.push(`at least ${andList(model)}`);
  parts.push(shaped(floor.minOperations, 'operation', 'operations', floor.operationShape, 'with an input and a return', true));
  parts.push(shaped(floor.minDecisions, 'decision', 'decisions', floor.decisionShape, 'with a rationale and a trade-off', false));
  if (floor.traceEveryStory) parts.push('every story traced to an operation or an entity');
  if (contracts.api) {
    const api = [
      floor.minEndpoints ? `at least ${n(floor.minEndpoints, 'endpoint', 'endpoints')}` : '',
      floor.requireErrorCatalogue ? 'an error catalogue' : '',
    ].filter(Boolean);
    if (api.length) parts.push(`${andList(api)} in the API contract`);
  }
  if (contracts.screens) {
    const screens = 'with a component, reads, components and an empty-state sentence';
    parts.push(floor.minScreens
      ? `at least ${n(floor.minScreens, 'screen', 'screens')} in the screen contract${floor.screenShape ? `, each ${screens}` : ''}`
      : floor.screenShape ? `every screen in the screen contract ${screens}` : '');
  }
  if (sequence) parts.push('a sequence diagram that names at least one of the operations');
  const said = parts.filter(Boolean);
  return said.length ? said.join('; ') : 'a valid design record';
}

/* ------------------------------- the projection ------------------------------- */

/** A leaf as text: a string as written, a number or a boolean spelled out, anything else (an object, a list, null) as canonical JSON. */
const leaf = (v: unknown): string => (typeof v === 'string' ? v
  : typeof v === 'number' || typeof v === 'boolean' ? String(v) : canonicalJson(v));
/** A list of text joined with `separator`; any other value as a leaf. */
const items = (v: unknown, separator: string): string =>
  (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(separator) : leaf(v));
/** The keys of `row` the projection does not read by name, as canonical JSON ('' when there are none), so no leaf is left out. */
function unread(row: Record<string, unknown>, read: readonly string[]): string {
  const left = Object.keys(row).filter((k) => !read.includes(k));
  return left.length ? canonicalJson(Object.fromEntries(left.map((k) => [k, row[k]]))) : '';
}
const spaced = (...parts: string[]) => parts.filter(Boolean).join(' ');
/**
 * The change set's own readings (`designChangeSet`), stricter than the
 * review's so no change reads as none: text that would read as a number, a
 * flag or null is quoted, and text where a list belongs is quoted too. The
 * review's projection keeps `leaf` and `items`, so its text never moves.
 */
const strictLeaf = (v: unknown): string => (typeof v === 'string' && /^(-?\d+(\.\d+)?|true|false|null)$/.test(v) ? JSON.stringify(v) : leaf(v));
const strictItems = (v: unknown, separator: string): string => (typeof v === 'string' ? JSON.stringify(v) : items(v, separator));
const plainLeaf = leaf;
const plainItems = items;

const present = <T>(item: T | undefined): item is T => item !== undefined;
const entriesOf = (doc: Record<string, unknown> | null, key: string): [string, unknown][] =>
  (isObject(doc?.[key]) ? Object.entries(doc![key] as Record<string, unknown>) : []);
/** A document's list of objects, or null when the key holds something else (then the whole value is a document-level leaf). */
const rowsOf = (doc: Record<string, unknown> | null, key: string): Record<string, unknown>[] | null => {
  const v = doc?.[key];
  return Array.isArray(v) && v.every(isObject) ? (v as Record<string, unknown>[]) : null;
};

interface Parsed { record: Design | null; api: Record<string, unknown> | null; screens: Record<string, unknown> | null }
const parseDocuments = (docs: DesignDocuments): Parsed => ({
  record: validateDesignRecord(docs[DESIGN_JSON] ?? '').design, api: parsed(docs[API_CONTRACT_JSON]), screens: parsed(docs[SCREEN_CONTRACT_JSON]),
});

const ENDPOINT_READS = ['id', 'method', 'path', 'summary', 'satisfies', 'query', 'body', 'success', 'errors', 'x-example'] as const;
const SCREEN_READS = ['route', 'title', 'component', 'reads', 'shows', 'components', 'empty'] as const;
const API_LISTS = ['entities', 'dtos', 'errors'] as const;

/**
 * The documents as labelled text, one path per field in a fixed order (the
 * design record's, then the API contract's, then the screens'), and complete:
 * every leaf lands under exactly one path. A key a
 * row holds beyond the ones read by name is kept as canonical JSON on the
 * row's descriptive path (an endpoint's summary, a screen's shows). `base` is
 * the earlier version when two are compared, and numbers the list positions by
 * its ids. `whole` adds, for a change set only, each contract's own keys beside
 * its lists (`$comment`, `version`, `base`, `router`, ...) under `api/document`
 * and `screens/document`, which the review does not cite.
 */
function project(cur: Parsed, switches: DesignSwitches, base?: Parsed, whole = false): Record<string, string> {
  const { contracts, sequence } = switches;
  // `whole` is the change set's projection: its readings never let two different values read the same
  const leaf = whole ? strictLeaf : plainLeaf;
  const items = whole ? strictItems : plainItems;
  const p: Record<string, string> = {};
  const record = cur.record;
  if (record) {
    const was = base?.record ?? undefined;
    const nameOf = (id: string) => `${record.entities.find((e) => e.id === id)?.name ?? id} (${id})`;
    slots(record.entities, (e) => e.id, was?.entities).forEach((e, i) => {
      if (!e) return;
      const at = `design/entity-${i + 1}`;
      // attributes keyed by name within their entity, so a reorder is no change
      const attributes = slots(e.attributes, (a) => a.name, was?.entities.find((x) => x.id === e.id)?.attributes).filter(present);
      p[`${at}/name`] = `${e.name} (${e.id})`;
      p[`${at}/kind`] = e.kind;
      p[`${at}/attributes`] = attributes.map((a) => [a.name, a.type, a.note ? `(${a.note})` : ''].filter(Boolean).join(' ')).join('\n');
      p[`${at}/responsibilities`] = e.responsibilities.map((line) => line.trim()).filter(Boolean).join('\n');
      p[`${at}/satisfies`] = e.satisfies.join(', ');
    });
    slots(record.relations, (r) => r.id, was?.relations).forEach((r, i) => {
      if (!r) return;
      // the cardinalities are part of the relation's one path: "List (E2) composition Task (E1), 1 to *: holds"
      const card = (c: string | undefined) => (c ? (whole && c === 'unstated' ? '"unstated"' : c) : 'unstated');
      const cards = r.fromCard || r.toCard ? `, ${card(r.fromCard)} to ${card(r.toCard)}` : '';
      p[`design/relation-${i + 1}`] = `${nameOf(r.from)} ${r.kind} ${nameOf(r.to)}${cards}${r.label ? `: ${r.label}` : ''}`;
    });
    slots(record.operations, (o) => o.id, was?.operations).forEach((o, i) => {
      if (!o) return;
      const at = `design/operation-${i + 1}`;
      p[`${at}/name`] = `${o.id}: ${o.name}`;
      p[`${at}/inputs`] = o.inputs.join('\n');
      p[`${at}/returns`] = o.returns;
      p[`${at}/errors`] = o.errors.join('\n');
      p[`${at}/satisfies`] = o.satisfies.join(', ');
      p[`${at}/note`] = o.note ?? '';
    });
    slots(record.decisions, (x) => x.id, was?.decisions).forEach((x, i) => {
      if (!x) return;
      const at = `design/decision-${i + 1}`;
      p[`${at}/title`] = `${x.id}: ${x.title}`;
      p[`${at}/choice`] = x.choice;
      p[`${at}/alternative`] = x.alternative;
      p[`${at}/rationale`] = x.rationale;
      p[`${at}/trade-off`] = x.tradeOff;
      p[`${at}/context`] = x.context ?? '';
      // the board's list, one per line; a blank line the learner left is not a consequence
      p[`${at}/consequences`] = (x.consequences ?? []).map((line) => line.trim()).filter(Boolean).join('\n');
      // the room's stamp belongs with the status it records
      p[`${at}/status`] = x.decidedAt ? `${x.status} (decided ${x.decidedAt})` : x.status;
      p[`${at}/superseded-by`] = x.supersededBy ?? '';
      p[`${at}/satisfies`] = x.satisfies.join(', ');
    });
    // a switched-off sequence diagram is not part of the design, so it is neither shown to the reviewer nor citable
    if (sequence) p['design/sequence'] = record.sequence ?? '';
    p['design/notes'] = record.notes ?? '';
  }
  if (contracts.api) {
    const doc = cur.api, was = base ? base.api : undefined;
    // maps are keyed by name: in the earlier version's order, new names last
    const keyed = (key: string) => slots(entriesOf(doc, key), ([name]) => name, was === undefined ? undefined : entriesOf(was, key)).filter(present);
    p['api/entities'] = keyed('entities').map(([name, e]) => {
      if (!isObject(e)) return `${name}: ${leaf(e)}`;
      const field = (f: unknown) => (isObject(f) ? spaced(leaf(f.name), leaf(f.type), unread(f, ['name', 'type'])) : leaf(f));
      const fields = Array.isArray(e.fields) ? e.fields.map(field).join(', ') : '';
      // a table named as its entity is said once, by the entity's name
      const read = [...(Array.isArray(e.fields) ? ['fields'] : []), ...(e.table === name ? ['table'] : [])];
      return `${name}: ${spaced(fields, unread(e, read))}`;
    }).join('\n');
    p['api/dtos'] = keyed('dtos').map(([name, dto]) => `${name}: ${leaf(dto)}`).join('\n');
    const endpoints = rowsOf(doc, 'operations') ?? [];
    slots(endpoints, (e) => e.id, was === undefined ? undefined : rowsOf(was, 'operations') ?? []).forEach((e, i) => {
      if (!e) return;
      const at = `api/endpoint-${i + 1}`;
      const satisfies = items(e.satisfies, ', ');
      p[`${at}/id`] = leaf(e.id);
      p[`${at}/route`] = spaced(leaf(e.method), leaf(e.path));
      p[`${at}/summary`] = [leaf(e.summary), satisfies ? `Satisfies ${satisfies}` : '', unread(e, ENDPOINT_READS)].filter(Boolean).join('\n');
      p[`${at}/query`] = Array.isArray(e.query)
        ? e.query.map((q) => (isObject(q)
          ? spaced([q.name, q.type, q.description].map((part) => (whole && part === '' ? '""' : leaf(part))).filter(Boolean).join(': '), unread(q, ['name', 'type', 'description']))
          : leaf(q))).join('\n')
        : leaf(e.query);
      p[`${at}/body`] = leaf(e.body);
      p[`${at}/success`] = isObject(e.success) ? spaced(leaf(e.success.status), leaf(e.success.body), unread(e.success, ['status', 'body'])) : leaf(e.success);
      p[`${at}/errors`] = items(e.errors, ', ');
      p[`${at}/example`] = leaf(e['x-example']);
    });
    p['api/errors'] = keyed('errors').map(([code, v]) =>
      `${code}: ${isObject(v) ? spaced(leaf(v.status), leaf(v.meaning), unread(v, ['status', 'meaning'])) : leaf(v)}`).join('\n');
    if (whole && doc) {
      const read = [...(rowsOf(doc, 'operations') ? ['operations'] : []), ...API_LISTS.filter((key) => isObject(doc[key]))];
      p['api/document'] = unread(doc, read);
    }
  }
  if (contracts.screens) {
    const doc = cur.screens, was = base ? base.screens : undefined;
    // screens are keyed by route
    slots(rowsOf(doc, 'screens') ?? [], (s) => s.route, was === undefined ? undefined : rowsOf(was, 'screens') ?? []).forEach((s, i) => {
      if (!s) return;
      const at = `screens/screen-${i + 1}`;
      p[`${at}/route`] = leaf(s.route);
      p[`${at}/title`] = leaf(s.title);
      p[`${at}/component`] = leaf(s.component);
      p[`${at}/reads`] = items(s.reads, ', ');
      p[`${at}/shows`] = [leaf(s.shows), unread(s, SCREEN_READS)].filter(Boolean).join('\n');
      p[`${at}/components`] = items(s.components, ', ');
      p[`${at}/empty`] = leaf(s.empty);
    });
    if (whole && doc) p['screens/document'] = unread(doc, rowsOf(doc, 'screens') ? ['screens'] : []);
  }
  return p;
}

/**
 * The labelled text the review reads and cites: one path per field,
 * `design/sequence` only when the sequence diagram is on, and a
 * contract's paths only when that contract is on.
 */
export function designReviewProjection(docs: DesignDocuments, switches: DesignSwitches): Record<string, string> {
  return project(parseDocuments(docs), switches);
}

/**
 * The field-level change between two versions of the documents. Both are
 * projected with the list positions numbered by the earlier version's ids
 * (entities, relations, operations, decisions and endpoints by id, screens by
 * route, maps by key, attributes by name within their entity), new ids last:
 * a removed item lists its fields as removed and a renamed id reads as a
 * removal plus an addition, never as a chain of renames.
 */
export function designChangeSet(before: DesignDocuments, after: DesignDocuments, switches: DesignSwitches): FieldChange[] {
  const earlier = parseDocuments(before);
  return projectionChangeSet(project(earlier, switches, earlier, true), project(parseDocuments(after), switches, earlier, true));
}

/**
 * Where each numbered item of a change set sits in the later documents' own
 * projection. A change set numbers its items by the earlier version
 * (`designChangeSet`: the earlier version's keys in its order, then the keys
 * only the later one has), and the later documents, read on their own, number
 * them by their own order, so one item can carry two numbers once an earlier
 * one is removed or added. Each change-set item ('design/operation-3') maps to
 * the same item, found by its key (an id, a screen's route), at its number in
 * `after` ('design/operation-2'), or to null when `after` no longer holds it.
 * The earlier version's own numbering is the change set's for every item it
 * holds, so the map also moves a path numbered by `before` alone.
 */
export function designItemPlaces(before: DesignDocuments, after: DesignDocuments): Record<string, string | null> {
  const was = parseDocuments(before), now = parseDocuments(after);
  const places: Record<string, string | null> = {};
  const place = <T>(prefix: string, list: readonly T[], base: readonly T[], keyOf: (item: T) => unknown) => {
    const mine = uniqueKeys(list, keyOf);
    [...new Set([...uniqueKeys(base, keyOf), ...mine])].forEach((key, i) => {
      const at = mine.indexOf(key);
      places[`${prefix}-${i + 1}`] = at < 0 ? null : `${prefix}-${at + 1}`;
    });
  };
  const id = (item: { id: string }) => item.id;
  place('design/entity', now.record?.entities ?? [], was.record?.entities ?? [], id);
  place('design/relation', now.record?.relations ?? [], was.record?.relations ?? [], id);
  place('design/operation', now.record?.operations ?? [], was.record?.operations ?? [], id);
  place('design/decision', now.record?.decisions ?? [], was.record?.decisions ?? [], id);
  place('api/endpoint', rowsOf(now.api, 'operations') ?? [], rowsOf(was.api, 'operations') ?? [], (e) => e.id);
  place('screens/screen', rowsOf(now.screens, 'screens') ?? [], rowsOf(was.screens, 'screens') ?? [], (s) => s.route);
  return places;
}

export function designCarried(live: DesignDocuments): string[] {
  const record = validateDesignRecord(live[DESIGN_JSON] ?? '').design;
  if (!record) return [];
  return [
    ...record.entities.map((e) => `entity ${e.id}`),
    ...record.operations.map((o) => `operation ${o.id}`),
    ...record.decisions.flatMap((d) => [`decision ${d.id}`, `the status of ${d.id}`]),
  ];
}

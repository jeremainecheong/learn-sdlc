/**
 * What a design proposal's `changes` say, read without React: each change's
 * field in words, the document it belongs to, and the changes grouped by
 * document for the before/after overlay.
 *
 * The paths are the review projection's (`designChangeSet` in the shared
 * package): `design/entity-N/...`, `design/relation-N`, `design/operation-N/...`,
 * `design/decision-N/...`, `design/sequence`, `design/notes`, `api/...` and
 * `screens/...`, with `api/document` and `screens/document` for a contract's
 * own keys. The N follows the saved (BEFORE) document: a removed item arrives
 * as before-only entries and an added one as after-only, so an entry is read
 * whole and never matched against another by its number.
 */
import {
  API_CONTRACT_JSON,
  DESIGN_DOCUMENT_LABEL,
  DESIGN_JSON,
  ENTITY_KINDS,
  SCREEN_CONTRACT_JSON,
  designDocumentPaths,
  type DesignContracts,
  type FieldChange,
} from '@learnsdlc/shared';

/** A field's name where the path's spelling is not already the word. */
const FIELD: Record<string, string> = { empty: 'empty-state sentence', 'trade-off': 'trade-off', 'superseded-by': 'superseded by' };
const ITEM: Record<string, string> = { entity: 'Entity', relation: 'Relation', operation: 'Operation', decision: 'Decision', endpoint: 'Endpoint', screen: 'Screen' };
/** The paths that name a whole part rather than a numbered item. */
const PART: Record<string, string> = {
  errors: 'Error catalogue',
  sequence: 'Sequence diagram',
  document: 'The contract itself',
  dtos: 'Data shapes',
};

/** 'design/entity-2/attributes' reads 'Entity 2, attributes'; 'design/notes' reads 'Notes'. */
export function designFieldLabel(path: string): string {
  const [item = '', field] = path.split('/').slice(1);
  const match = /^([a-z]+)-(\d+)$/.exec(item);
  if (match) return `${ITEM[match[1]] ?? match[1]} ${match[2]}${field ? `, ${FIELD[field] ?? field}` : ''}`;
  if (PART[item]) return PART[item];
  return item.charAt(0).toUpperCase() + item.slice(1);
}

/** The document a change path belongs to: a contract's own keys belong to that contract. */
export function documentOfPath(path: string): string {
  return path.startsWith('api/') ? API_CONTRACT_JSON : path.startsWith('screens/') ? SCREEN_CONTRACT_JSON : DESIGN_JSON;
}

/** The item a change path belongs to ('design/operation-3' for 'design/operation-3/name'), or the part itself. */
export function itemOfPath(path: string): string {
  return path.split('/').slice(0, 2).join('/');
}

export interface DesignCompareDocument { path: string; label: string; changes: FieldChange[] }

/**
 * Where a design record's part comes in the overlay: in the board's own order,
 * the entities first, then the relations, the operations and
 * the decisions, the sequence diagram, and the notes last. Within a kind the
 * items keep their numbers' order and an item's fields the order they came in.
 * A contract's paths keep the order they came in.
 */
const RECORD_ORDER = ['entity', 'relation', 'operation', 'decision', 'sequence', 'notes'];
function recordRank(path: string): [number, number] {
  if (documentOfPath(path) !== DESIGN_JSON) return [RECORD_ORDER.length, 0];
  const item = path.split('/')[1] ?? '';
  const match = /^([a-z]+)-(\d+)$/.exec(item);
  const kind = RECORD_ORDER.indexOf(match ? match[1] : item);
  return [kind < 0 ? RECORD_ORDER.length : kind, match ? Number(match[2]) : 0];
}
export function inBoardOrder(changes: FieldChange[]): FieldChange[] {
  return changes
    .map((change, at) => ({ change, at, rank: recordRank(change.path) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.at - b.at)
    .map(({ change }) => change);
}

/** An entity's kind as the board's choice names it ("Class", not the record's "class"). */
const KIND_WORD = (kind: string) => (ENTITY_KINDS as readonly string[]).includes(kind) ? kind.charAt(0).toUpperCase() + kind.slice(1) : kind;

/** A name or id with only its letters and digits, in one case: "is-overdue" and "isOverdue" both read "isoverdue". */
const squeezed = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
/** Whether an id is its name in other letters or punctuation only: then the name alone is said. */
const sameName = (name: string, id: string) => squeezed(id) !== '' && squeezed(name) === squeezed(id);

/**
 * One side of a change as the overlay prints it. The change set writes an
 * entity's name with its id ("Task (task)"), a relation's two ends the same
 * way ("Task (task) uses List (E2)"), and an operation's with its id in
 * front ("is-overdue: isOverdue"); where the id differs from the name by no
 * more than letter case and punctuation it is said once, by the name.
 * An entity's kind reads as the
 * board names it. A value the two sides would then print alike keeps its id,
 * so a change never reads as no change. Every other value is printed as sent.
 */
export function designValueText(change: FieldChange, side: 'before' | 'after'): string | undefined {
  const value = change[side];
  if (value === undefined) return undefined;
  const tidy = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    if (/^design\/entity-\d+\/name$/.test(change.path)) {
      const named = /^(.*) \(([^()]*)\)$/.exec(text);
      return named && sameName(named[1], named[2]) ? named[1] : text;
    }
    if (/^design\/operation-\d+\/name$/.test(change.path)) {
      const named = /^([^:]+): (.*)$/.exec(text);
      return named && sameName(named[2].replace(/\(.*$/, ''), named[1]) ? named[2] : text;
    }
    // A relation names both ends as "Name (id)": each end whose id is its
    // name in other letters or punctuation is said by the name ("Task uses List (E2)").
    if (/^design\/relation-\d+$/.test(change.path)) {
      return text.replace(/ \(([^()]*)\)/g, (all, id: string, at: number) => {
        const before = text.slice(0, at);
        // The shortest run of words just before the id that is the id in other letters: that end's name.
        for (let start = before.length - 1; start >= 0; start -= 1) {
          if (start > 0 && !/\s/.test(before[start - 1])) continue;
          const name = before.slice(start);
          if (squeezed(name).length > squeezed(id).length) break;
          if (sameName(name, id)) return '';
        }
        return all;
      });
    }
    if (/^design\/entity-\d+\/kind$/.test(change.path)) return KIND_WORD(text);
    return text;
  };
  const other = side === 'before' ? change.after : change.before;
  const mine = tidy(value)!;
  return other !== undefined && other !== value && tidy(other) === mine ? value : mine;
}

/**
 * The changes grouped by document, only the documents a change touches, in
 * the record-first order of `designDocumentPaths` (a switched-off contract is
 * never listed), and within the design record in the board's order. An entry
 * whose two sides read the same is no change.
 *
 * This is the one reading of a change set on screen. The ids stay as written,
 * so a name whose id changed only in letter case never reads as no change; it
 * words only the board's own kinds; and it keeps the ids in a relation's ends
 * ("Task (task) association List (E2)") and in an operation's name
 * ("isOverdue: isOverdue").
 */
export function designCompareDocuments(changes: FieldChange[], contracts: DesignContracts): DesignCompareDocument[] {
  const real = inBoardOrder(changes.filter((c) => (c.before ?? '') !== (c.after ?? '')));
  return designDocumentPaths(contracts)
    .map((path) => ({ path, label: DESIGN_DOCUMENT_LABEL[path], changes: real.filter((c) => documentOfPath(c.path) === path) }))
    .filter((doc) => doc.changes.length > 0);
}

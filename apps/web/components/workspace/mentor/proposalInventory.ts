/**
 * What a structured proposal holds, file by file: each file it carries
 * with whether Apply would change it and by how much, and each room document the
 * learner's request named that the proposal does not hold.
 *
 * A card that says "three documents" while Compare shows changes in one of them
 * leaves the learner unable to tell whether the other two are unchanged or were
 * never written. The answer is already on the client: a structured
 * proposal carries `changes`, its field-by-field difference from the saved
 * documents, so the room's own documents are counted from it with the same
 * arithmetic the before/after overlay draws (`changeCount` for a story,
 * `designCompareDocuments` for a design, the record's changed fields for a
 * runbook or change request). A file beside the record (a story or record
 * proposal that also writes a code or contract file) is counted by its changed
 * lines once the comparison has read the saved copy, and says so until then.
 *
 * Nothing here calls the API, grades anything or decides what Apply may do. It
 * counts what the proposal and the comparison already hold.
 *
 * Pure apart from the two small sessionStorage helpers at the end, each of
 * which survives a missing or full storage by doing nothing.
 */
import {
  API_CONTRACT_JSON,
  CHANGE_REQUEST_JSON,
  DESIGN_DOCUMENT_LABEL,
  DESIGN_JSON,
  RUNBOOK_JSON,
  SCREEN_CONTRACT_JSON,
  STORY_JSON,
  type FieldChange,
} from '@learnsdlc/shared';
import { documentOfPath } from '@/components/workspace/panels/design/designChanges';
import { changeCount, changedPaths } from '@/components/workspace/panels/requirements/storyChanges';
import { changedLineCount } from './RecordCompare';

export type InventoryStatus = 'changed' | 'new' | 'unchanged' | 'missing' | 'uncounted';

export interface InventoryLine {
  path: string;
  /** The room's name for one of its own documents ('Design record', 'Your story'); null for any other file. */
  label: string | null;
  status: InventoryStatus;
  /** Changed fields (`unit: 'change'`) or changed lines (`unit: 'line'`); 0 when unchanged, missing or not yet counted. */
  count: number;
  unit: 'change' | 'line';
  /** The learner's request for this proposal names this file, by its path or, for a design document, by its name. */
  requested: boolean;
}

/** A file beside the record that differs from its saved copy, as the comparisons read it (`before` undefined: not saved). */
export type DifferingFile = { path: string; before?: string; after: string };

const DESIGN_DOCUMENTS = [DESIGN_JSON, API_CONTRACT_JSON, SCREEN_CONTRACT_JSON];
const STRUCTURED = [STORY_JSON, RUNBOOK_JSON, CHANGE_REQUEST_JSON, ...DESIGN_DOCUMENTS];
const real = (changes: readonly FieldChange[]) => changes.filter((change) => (change.before ?? '') !== (change.after ?? ''));

export type ProposalKind = 'story' | 'record' | 'design' | 'files';

/** Which room's documents a proposal's `changes` describe, in the order the card and the overlay ask it. */
export function proposalKind(files: Record<string, string>, changes: readonly FieldChange[] | undefined): ProposalKind {
  if (!changes) return 'files';
  if (files[STORY_JSON] !== undefined) return 'story';
  if (files[RUNBOOK_JSON] !== undefined || files[CHANGE_REQUEST_JSON] !== undefined) return 'record';
  if (Object.keys(files).some((path) => DESIGN_DOCUMENTS.includes(path))) return 'design';
  return 'files';
}

/** The room's own name for a document it keeps, or null. */
export function documentLabel(path: string): string | null {
  if (path === STORY_JSON) return 'Your story';
  if (path === RUNBOOK_JSON) return 'Runbook';
  if (path === CHANGE_REQUEST_JSON) return 'Change request';
  return DESIGN_DOCUMENT_LABEL[path] ?? null;
}

/**
 * Whether the learner's request names a file: its path, written as it is, or a
 * design document by its own name ("the API contract"). A sentence that names a
 * document is not always a request to change it, so the card says only that the
 * request named it.
 */
export function namedInRequest(path: string, request: string | null | undefined): boolean {
  if (!request) return false;
  if (request.includes(path)) return true;
  const label = DESIGN_DOCUMENT_LABEL[path];
  return Boolean(label && request.toLowerCase().includes(label.toLowerCase()));
}

/* ------------------- the workspace files a request asks for ------------------- */

const PATH_CHAR = /[A-Za-z0-9_\-./]/;
const PATH_TAIL = /[A-Za-z0-9_\-/]/;

/**
 * Where `path` is written out in `text` as a path of its own: not inside a
 * longer path, and ended by anything but more path (so "design/contracts.json."
 * at the end of a sentence, in backticks, quotes or brackets, or before a comma,
 * is the path; "design/contracts.json.bak" is not). A leading "./" is allowed.
 */
function positionsOf(text: string, path: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(path); i >= 0; i = text.indexOf(path, i + 1)) {
    const before = i === 0 || !PATH_CHAR.test(text[i - 1])
      || (text.slice(i - 2, i) === './' && (i === 2 || !PATH_CHAR.test(text[i - 3])));
    const j = i + path.length;
    const after = j === text.length || !PATH_TAIL.test(text[j]) && (text[j] !== '.' || j + 1 === text.length || !PATH_TAIL.test(text[j + 1]));
    if (before && after) at.push(i);
  }
  return at;
}

/**
 * The words just before a path that make it a pointer, not a file asked for:
 * "as api/routes/tasks.py does", "like …", "leave … as it is", "keep … as they
 * stand", "do not change …", "without touching the …", and the file a change
 * is to follow: "based on …", "according to …", "so it matches …", "instead
 * of …", "using the operations from …". A bare "from" is
 * not one: "remove X from Y" asks for Y.
 * The reference words point only where they really point: "following X",
 * "matching X", "following the pattern in X", "checked
 * against X", "as per X". After "the", "a" or "an", "following" and
 * "matching" describe the file asked for ("update the following file X", "the
 * matching X change"), and "against" after "tests" or "the test" names the file
 * the tests are for ("write the tests against X"). Anything else stays a
 * pointer: when a wording is in doubt, the card says nothing.
 */
const KEEP_POINTER = /(?:\b(?:as|like|unlike|than|except|leave|leaving|keep|keeping)|\b(?:do not|don't|never|without|not)(?:\s+\w+){0,2})\s+(?:the\s+)?(?:file\s+)?$/i;
const REFERENCE_POINTER = /(?:\b(?:per|using|based\s+on|according\s+to|in\s+line\s+with|consistent\s+with|instead\s+of)|(?<!\b(?:the|a|an)\s+)\b(?:following|match(?:es|ed|ing)?)|(?<!\btests\s+|\b(?:the|a|an)\s+test\s+)\bagainst|\busing(?:\s+[\w'-]+){1,4}\s+from|(?<!\b(?:the|a|an)\s+)\b(?:following|matching|using|like|copying|mirroring|reusing)\s+(?:the\s+)?(?:same\s+)?(?:pattern|style|structure|shape|layout|approach|conventions?|format|example)\s+(?:used\s+)?(?:in|of|from))\s+(?:the\s+)?(?:file\s+)?$/i;
/** What may stand between two paths of one list ("a, b and c"), so the later ones read as the first does. */
const LIST_GAP = /^[\s,`'"’”)(]*(?:and|or)?[\s`'"‘“(]*$/i;
/**
 * "too" or "as well" just after a path: the path is one more file asked for,
 * not one more file to follow ("X per Y and Z too" asks for Z; m-4). It ends
 * only a reference word's list: "do not change a and b too" asks for neither.
 */
const ADDED = /^[`'"’”)]*\s*,?\s*(?:too|as\s+well)\b/i;

/** Anything written like a file path: a word with a slash in it, or a name with a short extension ("docker-compose.yml"). */
const PATH_TOKEN = /(?:\.\/)?[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.]+)+|[A-Za-z0-9_\-]+\.[A-Za-z][A-Za-z0-9]{0,4}(?![A-Za-z0-9_\-/])/g;
/** "return only", then at most "the file(s)" and an opening quote or bracket before the first path of its list. */
const RETURN_ONLY = /\breturn only\s+(?:the\s+)?(?:files?\s+)?[`'"‘“(]*/gi;

/**
 * Where in a request a written-out path is a file the request asks for. A
 * request also writes paths as record content ("Impact: ...;
 * files a, b, c"), as the things a sentence declares ("as design/contracts.json
 * declares it") or as instructions inside a file, and none of those asks for a
 * file. So:
 * (i) where the request has an explicit "return only <path>, <path> ..." list,
 * the asked paths are that list's, and nothing else is;
 * (ii) otherwise they are the paths of the request's opening sentence (to the
 * first ".", "!" or "?" followed by a space), the "Please propose ..." or
 * "Please add ... to the proposal above" sentence. "return only these four
 * files" names no path, so such a request falls to (ii).
 * When in doubt it says less: a false "asked for, not in this proposal" line
 * sends the learner to spend a message on a re-ask nobody wanted.
 */
function askedSpans(text: string): Array<[number, number]> {
  const lists: Array<[number, number]> = [];
  for (const clause of text.matchAll(RETURN_ONLY)) {
    const from = clause.index! + clause[0].length;
    let end = -1;
    // The list: a path right after "return only", then each path joined to it by a comma, "and" or "or".
    for (const token of text.slice(from).matchAll(PATH_TOKEN)) {
      const at = from + token.index!;
      if (at !== from && (end < 0 || !LIST_GAP.test(text.slice(end, at)))) break;
      end = at + token[0].replace(/\.+$/, '').length;
    }
    if (end > 0) lists.push([from, end]);
  }
  if (lists.length) return lists;
  // The opening sentence. A dot inside a path ("api/main.py") is never followed by a space, so it does not end it.
  const stop = /[.!?](?=\s|$)|\n/.exec(text);
  return [[0, stop ? stop.index : text.length]];
}

/**
 * The paths of `paths` that `request` asks for: each one written out (see
 * `positionsOf`) at least once inside the request's asked span (see
 * `askedSpans`) where it is not only a pointer ("as api/routes/tasks.py does",
 * "Leave ... as it is"). A path in a list reads as the list's first path does
 * ("Leave a and b as they are" asks for neither). Paths in the order the
 * request first names them.
 */
export function askedPaths(request: string | null | undefined, paths: readonly string[]): string[] {
  if (!request || !paths.length) return [];
  const text = request.replace(/\\/g, '/');
  const spans = askedSpans(text);
  const found = paths.flatMap((path) => positionsOf(text, path).map((at) => ({ path, at, end: at + path.length })))
    .sort((a, b) => a.at - b.at || b.end - a.end);
  const asked = new Set<string>();
  let previous: { end: number; pointer: boolean; reference: boolean } | null = null;
  for (const one of found) {
    if (previous && one.at < previous.end) continue;
    let pointer: boolean;
    let reference = false;
    if (previous && LIST_GAP.test(text.slice(previous.end, one.at))) {
      // A reference word's list ends at a path marked as one more asked for ("X per Y and Z too").
      reference = previous.reference && !ADDED.test(text.slice(one.end));
      pointer = previous.pointer && (!previous.reference || reference);
    } else {
      // The words of this clause before the path: from the last sentence or clause break.
      const head = text.slice(0, one.at);
      let from = 0;
      for (const m of head.matchAll(/[.!?;:]\s|\n/g)) from = m.index! + m[0].length;
      const words = `${head.slice(from).replace(/[`'"‘“(]+$/, '').trimEnd()} `;
      reference = !KEEP_POINTER.test(words) && REFERENCE_POINTER.test(words);
      pointer = reference || KEEP_POINTER.test(words);
    }
    const inSpan = spans.some(([from, to]) => one.at >= from && one.end <= to);
    if (!pointer && inSpan) asked.add(one.path);
    previous = { end: one.end, pointer, reference };
  }
  return [...asked].sort((a, b) => text.indexOf(a) - text.indexOf(b));
}

/**
 * Whether the request asks (by `askedPaths`'s rule) for a path the proposal
 * does not hold. Only then does the panel read the phase's file list, to learn
 * whether that path is one of the phase's editable files.
 */
export function asksForPathNotHeld(request: string | null | undefined, held: readonly string[]): boolean {
  if (!request) return false;
  const tokens = [...new Set((request.replace(/\\/g, '/').match(PATH_TOKEN) ?? []).map((token) => token.replace(/^\.\//, '').replace(/\.+$/, '')))];
  return askedPaths(request, tokens).some((path) => !held.includes(path));
}

/**
 * The files the request asks for that the proposal does not hold, among the
 * phase's editable files (`workspace`; null while not read, then none).
 */
export function missingAsked(files: Record<string, string>, request: string | null | undefined, workspace: readonly string[] | null | undefined): InventoryLine[] {
  return askedPaths(request, (workspace ?? []).filter((path) => files[path] === undefined))
    .map((path) => ({ path, label: documentLabel(path), status: 'missing' as const, count: 0, unit: 'change' as const, requested: true }));
}

/**
 * One line per file the proposal holds, then one per room document the request
 * named and the proposal does not hold (once `workspace` is read, only one the
 * phase holds), and one per other editable file of the
 * phase (`workspace`) the request asks for and the proposal does not hold.
 * `others` is the comparison's list of the files beside the record that differ
 * from their saved copies, or null while it has not been read: a file beside
 * the record is then `uncounted`, never guessed.
 */
export function proposalInventory({ files, changes, others = null, request = null, workspace = null }: {
  files: Record<string, string>;
  changes: readonly FieldChange[] | undefined;
  others?: readonly DifferingFile[] | null;
  request?: string | null;
  workspace?: readonly string[] | null;
}): InventoryLine[] {
  const kind = proposalKind(files, changes);
  const fieldChanges = real(changes ?? []);
  const line = (path: string, status: InventoryStatus, count: number, unit: 'change' | 'line'): InventoryLine =>
    ({ path, label: documentLabel(path), status, count, unit, requested: namedInRequest(path, request) });
  const counted = (path: string, count: number) => line(path, count > 0 ? 'changed' : 'unchanged', count, 'change');
  const beside = (path: string): InventoryLine => {
    if (others === null) return line(path, 'uncounted', 0, 'line');
    const differing = others.find((file) => file.path === path);
    if (!differing) return line(path, 'unchanged', 0, 'line');
    return line(path, differing.before === undefined ? 'new' : 'changed', changedLineCount(differing.before, differing.after), 'line');
  };
  const held = Object.keys(files);
  const ordered = [...STRUCTURED.filter((path) => held.includes(path)), ...held.filter((path) => !STRUCTURED.includes(path))];
  const lines = ordered.map((path) => {
    if (kind === 'story' && path === STORY_JSON) return counted(path, changeCount(changedPaths(fieldChanges)));
    if (kind === 'record' && (path === RUNBOOK_JSON || path === CHANGE_REQUEST_JSON)) return counted(path, fieldChanges.length);
    if (kind === 'design' && DESIGN_DOCUMENTS.includes(path)) return counted(path, fieldChanges.filter((change) => documentOfPath(change.path) === path).length);
    return beside(path);
  });
  // A room document the request asked for and the proposal lacks. A design proposal is asked about the design
  // documents by name; a story or record proposal about a room document the request asks for by path, by the
  // same rule as any other file (`askedPaths`: not a path the request only mentions), and, once the phase's
  // files are read, only a document this phase holds (so no runbook line on a Maintenance card).
  const candidates = kind === 'design' ? DESIGN_DOCUMENTS
    : kind === 'files' ? []
      : STRUCTURED.filter((path) => !workspace || workspace.includes(path));
  const askedByPath = kind === 'design' ? [] : askedPaths(request, candidates);
  const missing = candidates
    .filter((path) => files[path] === undefined && (kind === 'design' ? namedInRequest(path, request) : askedByPath.includes(path)))
    .map((path) => line(path, 'missing', 0, 'change'));
  // Any other file of the phase the request asks for (design/contracts.json beside a change request).
  const asked = missingAsked(files, request, workspace).filter((one) => !missing.some((known) => known.path === one.path));
  return [...lines, ...missing, ...asked];
}

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

/** The file's name on the line: the room's name with its path while the proposal is pending, the name alone once it is not. */
export function inventoryName(line: Pick<InventoryLine, 'path' | 'label'>, withPath: boolean): string {
  if (!line.label) return line.path;
  return withPath ? `${line.label} (${line.path})` : line.label;
}

/** A missing line's status: the request asked for the file, and the proposal does not hold it. */
export const MISSING_STATUS = 'asked for, not in this proposal';

/** What a line says after its name: "changed, 17 changes", "unchanged", "asked for, not in this proposal". */
export function inventoryStatusText(line: InventoryLine, applied = false): string {
  switch (line.status) {
    case 'changed': return `changed, ${plural(line.count, line.unit)}`;
    case 'new': return `new file, ${plural(line.count, 'line')}`;
    case 'unchanged': return line.requested ? 'unchanged, though your request named it' : 'unchanged';
    case 'uncounted': return applied ? 'saved, its lines not counted' : 'counted when you compare before and after';
    case 'missing': return MISSING_STATUS;
  }
}

/**
 * The sentence under a missing line: the card cannot add a file to a proposal,
 * so it says how to get one, the same re-ask the mentor already answers.
 */
export const MISSING_NOTE = 'Your request named it, but this proposal does not hold it. To have it changed, ask for it in a new message before you explain.';

/** "design/design.json: changed, 17 changes". */
export function inventoryText(line: InventoryLine, withPath = true, applied = false): string {
  return `${inventoryName(line, withPath)}: ${inventoryStatusText(line, applied)}`;
}

/**
 * The card's count beside its heading: every held document while all of them
 * change (or any is still uncounted), "1 of 3 documents changed" once one is
 * known to be unchanged, and the missing ones said after.
 */
export function inventoryCount(lines: readonly InventoryLine[], noun = 'document'): string {
  const held = lines.filter((line) => line.status !== 'missing');
  const changed = held.filter((line) => line.status === 'changed' || line.status === 'new').length;
  const missing = lines.length - held.length;
  const nouns = (count: number) => `${count} ${count === 1 ? noun : `${noun}s`}`;
  const base = held.some((line) => line.status === 'uncounted') || changed === held.length
    ? nouns(held.length)
    : `${changed} of ${nouns(held.length)} changed`;
  return missing ? `${base}, ${missing} missing` : base;
}

/** The count's noun: "file" once the card holds a file that is not one of the room's documents (code beside a record), else "document". */
export function inventoryNoun(lines: readonly InventoryLine[]): 'file' | 'document' {
  return lines.some((line) => line.status !== 'missing' && line.label === null) ? 'file' : 'document';
}

/** How many held documents Apply would write differently from the saved copies, when every one is counted. */
export function changedDocuments(lines: readonly InventoryLine[]): number | null {
  const held = lines.filter((line) => line.status !== 'missing');
  if (held.some((line) => line.status === 'uncounted')) return null;
  return held.filter((line) => line.status === 'changed' || line.status === 'new').length;
}

/* ---------------- what the explanation review's finding points at ---------------- */

export interface RevealTarget { path?: string; line?: number }

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The file or line a finding's cited sentences name, for "Show the change": a
 * held file with a change, by its path, its file name or (a room document) its
 * own name, and a line by "line N". Null when they name neither; the control is
 * then not drawn.
 */
export function revealTarget(texts: readonly string[], lines: readonly Pick<InventoryLine, 'path' | 'label' | 'status'>[]): RevealTarget | null {
  const said = texts.join('\n');
  if (!said.trim()) return null;
  const lower = said.toLowerCase();
  // Only a file with a change to show: an unchanged or missing one has nothing to scroll to.
  const file = lines.find((line) => line.status !== 'missing' && line.status !== 'unchanged' && (said.includes(line.path) || said.includes(basename(line.path)) || Boolean(line.label && lower.includes(line.label.toLowerCase()))));
  const lineNo = /\bline\s+(\d+)\b/i.exec(said);
  if (!file && !lineNo) return null;
  return { ...(file ? { path: file.path } : {}), ...(lineNo ? { line: Number(lineNo[1]) } : {}) };
}

/* ------------------------------- kept on this tab ------------------------------- */

/**
 * The counts as they were when the proposal was applied. Once applied,
 * the saved documents hold the proposal, so its `changes`, read again against
 * them, are empty; the receipt keeps what the Apply changed so a later read of
 * the card never implies that the Apply changed nothing. A convenience kept in
 * this tab's sessionStorage: without storage the card says only what it can read.
 */
export const receiptKey = (phaseId: string, proposalId: string) => `learnsdlc:agentic-applied:${phaseId}:${proposalId}`;

const isLine = (value: unknown): value is InventoryLine => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.path === 'string' && (row.label === null || typeof row.label === 'string') && typeof row.count === 'number'
    && (row.unit === 'change' || row.unit === 'line') && typeof row.requested === 'boolean'
    && ['changed', 'new', 'unchanged', 'missing', 'uncounted'].includes(row.status as string);
};

export function readReceipt(phaseId: string | undefined, proposalId: string): InventoryLine[] | null {
  if (!phaseId) return null;
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(receiptKey(phaseId, proposalId)) ?? 'null');
    return Array.isArray(raw) && raw.length > 0 && raw.every(isLine) ? raw : null;
  } catch { return null; }
}

export function writeReceipt(phaseId: string | undefined, proposalId: string, lines: readonly InventoryLine[]): void {
  if (!phaseId || !lines.length) return;
  try { sessionStorage.setItem(receiptKey(phaseId, proposalId), JSON.stringify(lines)); } catch { /* A convenience; the card still reads the proposal. */ }
}

/**
 * The learner's unsent explanation of one proposal, so it survives a
 * reload as it survives closing the overlay. Keyed by the signed-in learner,
 * the phase and the proposal's id; removed when it is emptied (sent, discarded)
 * and when the proposal is applied. It is only ever the learner's own typing:
 * nothing is written into it but what they typed, and nothing is sent from it.
 */
export const explainDraftKey = (owner: string, proposalId: string) => `learnsdlc:explain-draft:${owner}:${proposalId}`;

export function readExplainDraft(owner: string, proposalId: string): string {
  try { return sessionStorage.getItem(explainDraftKey(owner, proposalId)) ?? ''; } catch { return ''; }
}

export function writeExplainDraft(owner: string, proposalId: string, text: string): void {
  try {
    if (text.trim()) sessionStorage.setItem(explainDraftKey(owner, proposalId), text);
    else sessionStorage.removeItem(explainDraftKey(owner, proposalId));
  } catch { /* Without storage the draft lives as long as the page. */ }
}

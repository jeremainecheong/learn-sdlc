/**
 * The change room's edits, pure, each held to `CHANGE_CAPS` so a save is
 * never refused; ids minted as the room mints them (C, T, L).
 */
import {
  CHANGE_CAPS, CHANGE_ID_LETTER, EMPTY_CHANGE_REQUEST, nextItemId, validateChangeRequestRecord,
  type ChangeRequest, type FieldChange, type ImpactList,
} from '@learnsdlc/shared';
import { touchedStore } from '../requirements/touched';

export function readChangeText(text: string | undefined, acceptanceIds: readonly string[]): { change: ChangeRequest; error: string | null } {
  const out = validateChangeRequestRecord(text ?? '', acceptanceIds);
  return out.change ? { change: out.change, error: null } : { change: EMPTY_CHANGE_REQUEST, error: out.error };
}
const cap = (value: string, max: number = CHANGE_CAPS.fieldChars) => value.slice(0, max);
export function addImpact(change: ChangeRequest, list: ImpactList, entry: string): ChangeRequest {
  const text = cap(entry.trim());
  const held = change.impact[list];
  if (!text || held.includes(text) || held.length >= CHANGE_CAPS.listItems) return change;
  return { ...change, impact: { ...change.impact, [list]: [...held, text] } };
}
export function removeImpact(change: ChangeRequest, list: ImpactList, index: number): ChangeRequest {
  return { ...change, impact: { ...change.impact, [list]: change.impact[list].filter((_, at) => at !== index) } };
}
const full = (n: number) => n >= CHANGE_CAPS.listItems;
export function addAmendment(change: ChangeRequest): ChangeRequest {
  if (full(change.contract.length)) return change;
  return { ...change, contract: [...change.contract, { id: nextItemId(change.contract.map((c) => c.id), CHANGE_ID_LETTER.contract), method: 'GET', path: '', change: 'added', why: '' }] };
}
export function addTest(change: ChangeRequest): ChangeRequest {
  if (full(change.tests.length)) return change;
  return { ...change, tests: [...change.tests, { id: nextItemId(change.tests.map((t) => t.id), CHANGE_ID_LETTER.tests), suite: '', covers: [], result: 'not-run' }] };
}
export function addChangeLine(change: ChangeRequest): ChangeRequest {
  if (full(change.release.changes.length)) return change;
  const id = nextItemId(change.release.changes.map((l) => l.id), CHANGE_ID_LETTER.changes);
  return { ...change, release: { ...change.release, changes: [...change.release.changes, { id, line: '', covers: [] }] } };
}
const listOf = (change: ChangeRequest, list: 'contract' | 'tests' | 'changes') => (list === 'changes' ? change.release.changes : change[list]);
const withList = (change: ChangeRequest, list: 'contract' | 'tests' | 'changes', items: unknown[]): ChangeRequest =>
  (list === 'changes' ? { ...change, release: { ...change.release, changes: items as ChangeRequest['release']['changes'] } } : { ...change, [list]: items } as ChangeRequest);
export function removeItem(change: ChangeRequest, list: 'contract' | 'tests' | 'changes', index: number): ChangeRequest {
  return withList(change, list, listOf(change, list).filter((_, at) => at !== index));
}
export function setItemField(change: ChangeRequest, list: 'contract' | 'tests' | 'changes', index: number, key: string, value: string): ChangeRequest {
  const max = key === 'method' ? CHANGE_CAPS.method : CHANGE_CAPS.fieldChars;
  return withList(change, list, listOf(change, list).map((item, at) => (at === index ? { ...item, [key]: cap(value, max) } : item)));
}
export function toggleCover(change: ChangeRequest, list: 'tests' | 'changes', index: number, id: string): ChangeRequest {
  return withList(change, list, listOf(change, list).map((item, at) => {
    if (at !== index) return item;
    const covers = (item as { covers: string[] }).covers;
    if (covers.includes(id)) return { ...item, covers: covers.filter((one) => one !== id) };
    return covers.length >= CHANGE_CAPS.covers ? item : { ...item, covers: [...covers, id] };
  }));
}
export function setRelease(change: ChangeRequest, key: 'version' | 'summary' | 'rollback', value: string): ChangeRequest {
  return { ...change, release: { ...change.release, [key]: cap(value, key === 'version' ? CHANGE_CAPS.version : CHANGE_CAPS.fieldChars) } };
}
export function setRisks(change: ChangeRequest, text: string): ChangeRequest {
  const risks = text.split('\n').slice(0, CHANGE_CAPS.listItems).map((line) => cap(line));
  return { ...change, release: { ...change.release, risks } };
}
/** The change's signature: the first added amendment's path, else the first impact operation, else none. */
export function changeSignature(change: ChangeRequest): string | null {
  return change.contract.find((c) => c.change === 'added' && c.path.trim())?.path ?? change.impact.operations.find((op) => op.trim()) ?? null;
}
/** The operation the change names (`impact.operations`, first entry), else none: what the Contract card claims and adds by name. */
export function changeOperation(change: ChangeRequest): string | null {
  return change.impact.operations.find((op) => op.trim())?.trim() ?? null;
}
export function changeTarget(change: ChangeRequest, editable: readonly string[]): string | null {
  return change.impact.files.find((path) => editable.includes(path)) ?? null;
}

/* ------------------- the "changed by the assistant" marks ------------------- */

const ITEM_LIST: Record<string, 'contract' | 'tests' | 'changes'> = { contract: 'contract', test: 'tests', 'release/change': 'changes' };
const readAny = (text: string | undefined): ChangeRequest => validateChangeRequestRecord(text ?? '', null).change ?? EMPTY_CHANGE_REQUEST;
/**
 * The fields an applied proposal touched: `impact:<list>`, `<list>:<id>:<field>`
 * for an amendment, a test or a change line, `release:<field>` and `notes`. A
 * change set numbers items by the earlier version's ids, then the new ones
 * (`changeRequestChangeSet`), so slot N is read back to the item it names.
 */
export function changedChangeFields(before: string | undefined, changes: readonly FieldChange[]): Set<string> {
  const was = readAny(before);
  const items = { contract: was.contract, tests: was.tests, changes: was.release.changes };
  const slotIds = new Map<string, string>();
  for (const c of changes) {
    const naming = /^(change\/(?:contract|test|release\/change)-\d+)\/(?:path|suite|line)$/.exec(c.path);
    const id = naming ? /^([A-Z]\d+): /.exec(c.after ?? c.before ?? '')?.[1] : undefined;
    if (naming && id) slotIds.set(naming[1], id);
  }
  const out = new Set<string>();
  for (const c of changes) {
    const impact = /^change\/impact\/(operations|screens|files)$/.exec(c.path);
    if (impact) { out.add(`impact:${impact[1]}`); continue; }
    const item = /^change\/(contract|test|release\/change)-(\d+)\/([a-z]+)$/.exec(c.path);
    if (item) {
      const list = ITEM_LIST[item[1]];
      const id = slotIds.get(`change/${item[1]}-${item[2]}`) ?? items[list][Number(item[2]) - 1]?.id;
      if (id) out.add(`${list}:${id}:${item[3]}`);
      continue;
    }
    const release = /^change\/release\/(version|summary|rollback|risks)$/.exec(c.path);
    if (release) out.add(`release:${release[1]}`);
    else if (c.path === 'change/notes') out.add('notes');
  }
  return out;
}
export type ChangeTouched = Readonly<Record<string, string>>;
/** A field's text as the marks compare it: a list joined as the projection joins it. */
function markedText(change: ChangeRequest, key: string): string | undefined {
  const [head, id, field] = key.split(':');
  if (head === 'impact') return change.impact[id as ImpactList]?.join('\n');
  if (head === 'release') return id === 'risks' ? (change.release.risks ?? []).join('\n') : String(change.release[id as 'version' | 'summary' | 'rollback'] ?? '');
  if (head === 'notes') return change.notes ?? '';
  const list = head === 'changes' ? change.release.changes : change[head as 'contract' | 'tests'];
  const item = (list as { id: string }[] | undefined)?.find((one) => one.id === id) as Record<string, unknown> | undefined;
  if (!item || item[field] === undefined) return undefined;
  return Array.isArray(item[field]) ? (item[field] as string[]).join(', ') : String(item[field]);
}
export function touchedChange(before: string | undefined, changes: readonly FieldChange[], applied: string): ChangeTouched {
  const now = readAny(applied);
  const out: Record<string, string> = {};
  for (const key of changedChangeFields(before, changes)) {
    const text = markedText(now, key);
    if (text !== undefined) out[key] = text;
  }
  return out;
}
/** A mark shows only while its field still holds the assistant's text (until it is edited or submitted). */
export function liveChangeMarks(touched: ChangeTouched, text: string): Set<string> {
  const now = readAny(text);
  return new Set(Object.keys(touched).filter((key) => markedText(now, key) === touched[key]));
}
// Kept per phase in sessionStorage, by touched.ts's store (a storage that throws or is empty answers no marks).
const changeTouched = touchedStore<ChangeTouched>((phaseId) => `learnsdlc:touched:${phaseId}:change`);
export function recordChangeTouched(phaseId: string, touched: ChangeTouched): void {
  changeTouched.write(phaseId, touched);
}
export function readChangeTouched(phaseId: string): ChangeTouched {
  return changeTouched.read(phaseId);
}
export function clearChangeTouched(phaseId: string): void {
  changeTouched.clear(phaseId);
}
/**
 * Record what an applied change-request proposal wrote (the overlay's Apply
 * calls this): the fields its change set touched, each with the text the
 * applied record holds, over the marks of earlier applies, which
 * `liveChangeMarks` drops once their field no longer holds that text.
 */
export function recordAppliedChange(phaseId: string, changes: readonly FieldChange[], saved: string | undefined, applied: string | undefined): void {
  if (applied === undefined) return;
  recordChangeTouched(phaseId, { ...readChangeTouched(phaseId), ...touchedChange(saved, changes, applied) });
}

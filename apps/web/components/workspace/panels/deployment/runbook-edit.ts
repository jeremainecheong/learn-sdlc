/**
 * The Runbook tab's edits, pure: each takes the record and answers the next
 * one, held to `RUNBOOK_CAPS` so a save is never refused. Ids are minted as
 * the room mints them (`nextItemId`, the next free number after the list's letter).
 */
import {
  EMPTY_RUNBOOK, RUNBOOK_CAPS, RUNBOOK_ID_LETTER, nextItemId, validateRunbookRecord,
  type FieldChange, type Runbook, type RunbookList,
} from '@learnsdlc/shared';
import { touchedStore } from '../requirements/touched';

export interface RunbookRead { runbook: Runbook; error: string | null }
export function readRunbookText(text: string | undefined): RunbookRead {
  const out = validateRunbookRecord(text ?? '');
  return out.runbook ? { runbook: out.runbook, error: null } : { runbook: EMPTY_RUNBOOK, error: out.error };
}
const cap = (value: string) => value.slice(0, RUNBOOK_CAPS.fieldChars);
const blank: Record<RunbookList, (id: string) => Runbook[RunbookList][number]> = {
  environment: (id) => ({ id, name: '', purpose: '', kind: 'config' }),
  health: (id) => ({ id, name: '', how: '', expected: '' }),
  rollback: (id) => ({ id, step: '', verify: '' }),
  data: (id) => ({ id, what: '', how: '', where: '' }),
};
export const listFull = (runbook: Runbook, list: RunbookList): boolean => runbook[list].length >= RUNBOOK_CAPS.listItems;
export function addRunbookItem(runbook: Runbook, list: RunbookList): Runbook {
  if (listFull(runbook, list)) return runbook;
  const id = nextItemId(runbook[list].map((item) => item.id), RUNBOOK_ID_LETTER[list]);
  return { ...runbook, [list]: [...runbook[list], blank[list](id)] };
}
export function removeRunbookItem(runbook: Runbook, list: RunbookList, index: number): Runbook {
  return { ...runbook, [list]: runbook[list].filter((_, at) => at !== index) };
}
export function moveRollback(runbook: Runbook, index: number, by: -1 | 1): Runbook {
  const to = index + by;
  if (to < 0 || to >= runbook.rollback.length) return runbook;
  const rollback = [...runbook.rollback];
  [rollback[index], rollback[to]] = [rollback[to], rollback[index]];
  return { ...runbook, rollback };
}
export function setRunbookField(runbook: Runbook, list: RunbookList, index: number, key: string, value: string): Runbook {
  const items = runbook[list].map((item, at) => (at === index ? { ...item, [key]: cap(value) } : item));
  return { ...runbook, [list]: items } as Runbook;
}
export function setIncident(runbook: Runbook, key: 'rootCause' | 'fix' | 'actionItem', value: string): Runbook {
  return { ...runbook, incident: { ...runbook.incident, [key]: cap(value) } };
}

const PATH_LIST: Record<string, RunbookList> = { env: 'environment', health: 'health', rollback: 'rollback', data: 'data' };
/** The fields outside the lists' items, by projection path: the rollback's order, the incident's three fields, its timeline and Notes. */
const PATH_KEY: Record<string, string> = {
  'runbook/rollback/order': 'rollback:order',
  'runbook/incident/root-cause': 'incident:rootCause', 'runbook/incident/fix': 'incident:fix', 'runbook/incident/action-item': 'incident:actionItem',
  'runbook/incident/timeline': 'incident:timeline', 'runbook/notes': 'notes',
};
/**
 * The fields an applied proposal touched, as `<list>:<id>:<field>` (the kind
 * among them), `rollback:order`, `incident:<field>`, `incident:timeline` or
 * `notes`: a change
 * set numbers its items by the earlier version's ids, then the new ones
 * (`runbookChangeSet`), so slot N is read back to the item it names.
 */
export function changedRunbookFields(before: string | undefined, changes: readonly FieldChange[]): Set<string> {
  const was = readRunbookText(before).runbook;
  // a slot's id from its naming change ("E2: PORT"), which a new item's describing fields share
  const slotIds = new Map<string, string>();
  for (const change of changes) {
    const naming = /^(runbook\/(?:env|health|rollback|data)-\d+)\/(?:name|step|what)$/.exec(change.path);
    const id = naming ? /^([A-Z]\d+): /.exec(change.after ?? change.before ?? '')?.[1] : undefined;
    if (naming && id) slotIds.set(naming[1], id);
  }
  const out = new Set<string>();
  for (const change of changes) {
    if (PATH_KEY[change.path]) { out.add(PATH_KEY[change.path]); continue; }
    const m = /^runbook\/(env|health|rollback|data)-(\d+)\/([a-z-]+)$/.exec(change.path);
    if (!m) continue;
    const list = PATH_LIST[m[1]];
    // otherwise slot N is the earlier version's Nth item (the change set numbers by its ids first)
    const id = slotIds.get(`runbook/${m[1]}-${m[2]}`) ?? was[list][Number(m[2]) - 1]?.id;
    const field = m[3].replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase());
    if (id) out.add(`${list}:${id}:${field}`);
  }
  return out;
}

/** What the assistant wrote, by field: the touched keys with the text the applied record holds there. */
export type RunbookTouched = Readonly<Record<string, string>>;
const fieldText = (runbook: Runbook, key: string): string | undefined => {
  if (key === 'notes') return runbook.notes ?? '';
  if (key === 'rollback:order') return runbook.rollback.map((step) => step.id).join(', ');
  if (key === 'incident:timeline') return (runbook.incident.timeline ?? []).map((t) => `${t.at} ${t.event}`).join('\n');
  if (key === 'incident:rootCause' || key === 'incident:fix' || key === 'incident:actionItem') return runbook.incident[key.slice('incident:'.length) as 'rootCause' | 'fix' | 'actionItem'];
  const [list, id, field] = key.split(':') as [RunbookList, string, string];
  const item = runbook[list]?.find((one) => one.id === id) as Record<string, unknown> | undefined;
  return item === undefined || item[field] === undefined ? undefined : String(item[field]);
};
export function touchedRunbook(before: string | undefined, changes: readonly FieldChange[], applied: string): RunbookTouched {
  const now = readRunbookText(applied).runbook;
  const out: Record<string, string> = {};
  for (const key of changedRunbookFields(before, changes)) {
    const text = fieldText(now, key);
    if (text !== undefined) out[key] = text;
  }
  return out;
}
/** A mark shows only while its field still holds the assistant's text (until it is edited or submitted), as Design's `isTouched` reads. */
export function liveRunbookMarks(touched: RunbookTouched, text: string): Set<string> {
  const now = readRunbookText(text).runbook;
  return new Set(Object.keys(touched).filter((key) => fieldText(now, key) === touched[key]));
}
// Kept per phase in sessionStorage, by touched.ts's store (a storage that throws or is empty answers no marks).
const runbookTouched = touchedStore<RunbookTouched>((phaseId) => `learnsdlc:touched:${phaseId}:runbook`);
export function recordRunbookTouched(phaseId: string, touched: RunbookTouched): void {
  runbookTouched.write(phaseId, touched);
}
export function readRunbookTouched(phaseId: string): RunbookTouched {
  return runbookTouched.read(phaseId);
}
export function clearRunbookTouched(phaseId: string): void {
  runbookTouched.clear(phaseId);
}

/**
 * "11:12:04": a drill timeline's moment on the same 24-hour local clock as
 * `clock` in drill.ts (the drill page's times), to the second, because the drill's own events (paged, the
 * check that passed, closed) are seconds apart and would read as one minute.
 */
export const clockToSecond = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

/** A timeline's "at" that is a stored instant ("2026-11-17T03:12:04.506Z"), not words a learner typed. */
export const isInstant = (at: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) && !Number.isNaN(Date.parse(at));

export function addTimeline(runbook: Runbook): Runbook {
  const timeline = runbook.incident.timeline ?? [];
  if (timeline.length >= RUNBOOK_CAPS.timeline) return runbook;
  return { ...runbook, incident: { ...runbook.incident, timeline: [...timeline, { at: '', event: '' }] } };
}
export function removeTimeline(runbook: Runbook, index: number): Runbook {
  return { ...runbook, incident: { ...runbook.incident, timeline: (runbook.incident.timeline ?? []).filter((_, at) => at !== index) } };
}
export function setTimeline(runbook: Runbook, index: number, key: 'at' | 'event', value: string): Runbook {
  const max = key === 'at' ? RUNBOOK_CAPS.timelineAt : RUNBOOK_CAPS.fieldChars;
  const timeline = (runbook.incident.timeline ?? []).map((entry, at) => (at === index ? { ...entry, [key]: value.slice(0, max) } : entry));
  return { ...runbook, incident: { ...runbook.incident, timeline } };
}

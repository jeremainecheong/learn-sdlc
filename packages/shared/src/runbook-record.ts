/**
 * The Deployment runbook as a structured record, `deployment/runbook.json`:
 * what an operator reads at 3am, as five sections and notes. The record is
 * the only copy: the Runbook tab reads and writes it, the drill's resolve
 * writes its incident, the floor grades it and the review reads its fields.
 * Pure: no network, no DOM.
 */
import { isProjectionPathUnder, numberedSlots, projectionChangeSet, type FieldChange } from './projection-diff';
import {
  blankText as blank, isObject, optionalField, readItemId, readObjects, readOptionalText, readRecordText, readText, refuseRecord,
} from './record-read';
import { pluralWord as word } from './words';
import { andList } from './requirements-story';

export const RUNBOOK_JSON = 'deployment/runbook.json';

export type RunbookEnvKind = 'config' | 'secret';
const RUNBOOK_ENV_KINDS: RunbookEnvKind[] = ['config', 'secret'];
Object.freeze(RUNBOOK_ENV_KINDS);

export interface RunbookEnvironment { id: string; name: string; purpose: string; kind: RunbookEnvKind; example?: string }
export interface RunbookHealth { id: string; name: string; how: string; expected: string }
/** In the order an operator runs them. */
export interface RunbookRollback { id: string; step: string; verify: string }
export interface RunbookData { id: string; what: string; how: string; where: string; retention?: string }
export interface RunbookTimelineEntry { at: string; event: string }
export interface RunbookIncident { rootCause: string; fix: string; actionItem: string; timeline?: RunbookTimelineEntry[] }
export interface Runbook {
  environment: RunbookEnvironment[]; health: RunbookHealth[]; rollback: RunbookRollback[]; data: RunbookData[];
  incident: RunbookIncident; notes?: string;
}
export type RunbookList = 'environment' | 'health' | 'rollback' | 'data';
export const RUNBOOK_LISTS: readonly RunbookList[] = ['environment', 'health', 'rollback', 'data'];
export const RUNBOOK_ID_LETTER: Readonly<Record<RunbookList, 'E' | 'H' | 'R' | 'D'>> = { environment: 'E', health: 'H', rollback: 'R', data: 'D' };
Object.freeze(RUNBOOK_LISTS);
Object.freeze(RUNBOOK_ID_LETTER);

export interface RunbookFloor { minEnvironment: number; minHealth: number; minRollback: number; minData: number; requireIncident: boolean }
/** `ConfigChecks.runbook`: the record path and the floor. */
export interface RunbookChecks { record: typeof RUNBOOK_JSON; floor: RunbookFloor }

/** One set of caps, read by the DTO, the upload door, publish and the validator. */
export const RUNBOOK_CAPS = {
  listItems: 20, timeline: 20, fieldChars: 2000, itemId: 16, timelineAt: 40,
  minEnvironment: [0, 20], minHealth: [0, 20], minRollback: [0, 20], minData: [0, 20],
} as const;

/** A new teacher phase's floor; `defaultRunbookFloor` sets the incident by the drill. */
export const DEFAULT_RUNBOOK_FLOOR: RunbookFloor = { minEnvironment: 2, minHealth: 1, minRollback: 2, minData: 1, requireIncident: false };
Object.freeze(DEFAULT_RUNBOOK_FLOOR);
export function defaultRunbookFloor(hasDrill: boolean): RunbookFloor {
  return { ...DEFAULT_RUNBOOK_FLOOR, requireIncident: hasDrill };
}
export const EMPTY_INCIDENT: RunbookIncident = { rootCause: '', fix: '', actionItem: '' };
export const EMPTY_RUNBOOK: Runbook = { environment: [], health: [], rollback: [], data: [], incident: EMPTY_INCIDENT };
Object.freeze(EMPTY_INCIDENT);
for (const list of RUNBOOK_LISTS) Object.freeze(EMPTY_RUNBOOK[list]);
Object.freeze(EMPTY_RUNBOOK);

export const RUNBOOK_PROPOSAL_REFUSED = "The assistant's proposal was not a valid runbook and was discarded.";
export const RUNBOOK_OLDER_FORMAT_ROOM = "This project's Deployment task is in an older format; its owner needs to re-save it.";
export const RUNBOOK_OLDER_FORMAT_REFUSAL = 'Deployment is still in the older format. Open its Deployment step in the editor and save it once to convert it.';
export const RUNBOOK_OLDER_FORMAT_ASSIGN_REFUSAL = "This version's Deployment is in the older format and cannot be assigned. Publish it again from the editor.";
export const RUNBOOK_RESOLVE_CONFLICT = 'Your runbook was saved somewhere else while you closed the incident. Close it again.';
export const RUNBOOK_RESOLVE_INVALID = 'Save a valid runbook before you close the incident.';
export const RUNBOOK_DRILL_START_NOT_EMPTY = 'A starting runbook in a phase with a drill has an empty incident: the drill writes it.';
export const RUNBOOK_INCIDENT_FROM_DRILL = 'Written from the drill page when you close the incident.';
/** The one refusal the pack loader and the authoring door give a runbook on any phase but Deployment. */
export const ONLY_DEPLOYMENT_RUNBOOK = 'Only Deployment carries a runbook.';
/** The three timeline lines the drill's resolve writes. */
export const DRILL_TIMELINE_EVENTS = {
  paged: 'Paged: the check against the faulted copy failed.',
  fixed: 'A health check passed after the failure.',
  closed: 'Incident closed.',
} as const;
Object.freeze(DRILL_TIMELINE_EVENTS);
export const runbookSaveRefusal = (error: string) => `The runbook was not saved: ${error}.`;
export const startingRunbookError = (error: string) => `The starting runbook is not valid: ${error}.`;

/** The next free number after `letter` among `ids` ("E1", "E2", ...): the room's and the stub's one minting rule. */
export function nextItemId(ids: readonly string[], letter: string): string {
  const numbered = new RegExp(`^${letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  let n = 1;
  for (const id of ids) {
    const m = numbered.exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  return `${letter}${n}`;
}

export function incidentIsEmpty(incident: RunbookIncident): boolean {
  return !incident.rootCause.trim() && !incident.fix.trim() && !incident.actionItem.trim() && !(incident.timeline ?? []).length;
}

const C = RUNBOOK_CAPS;
const field = (item: Record<string, unknown>, key: string, what: string) => readText(item[key], `${what} ${key}`, C.fieldChars);

function readRunbook(raw: Record<string, unknown>): Runbook {
  const envIds = new Set<string>();
  const environment = readObjects(raw, 'environment', C.listItems, 'environment entries', 'environment entry').map((e, i) => {
    const id = readItemId(e, 'environment entry', i, envIds, C.itemId);
    const what = `environment entry ${id}`;
    const name = field(e, 'name', what);
    const purpose = field(e, 'purpose', what);
    if (!(RUNBOOK_ENV_KINDS as unknown[]).includes(e.kind)) refuseRecord(`${what} has an unknown kind`);
    return { id, name, purpose, kind: e.kind as RunbookEnvKind, ...optionalField('example', readOptionalText(e.example, `${what} example`, C.fieldChars)) };
  });
  const healthIds = new Set<string>();
  const health = readObjects(raw, 'health', C.listItems, 'health checks', 'health check').map((h, i) => {
    const id = readItemId(h, 'health check', i, healthIds, C.itemId);
    const what = `health check ${id}`;
    return { id, name: field(h, 'name', what), how: field(h, 'how', what), expected: field(h, 'expected', what) };
  });
  const rollbackIds = new Set<string>();
  const rollback = readObjects(raw, 'rollback', C.listItems, 'rollback steps', 'rollback step').map((s, i) => {
    const id = readItemId(s, 'rollback step', i, rollbackIds, C.itemId);
    const what = `rollback step ${id}`;
    return { id, step: field(s, 'step', what), verify: field(s, 'verify', what) };
  });
  const dataIds = new Set<string>();
  const data = readObjects(raw, 'data', C.listItems, 'data entries', 'data entry').map((d, i) => {
    const id = readItemId(d, 'data entry', i, dataIds, C.itemId);
    const what = `data entry ${id}`;
    return { id, what: field(d, 'what', what), how: field(d, 'how', what), where: field(d, 'where', what), ...optionalField('retention', readOptionalText(d.retention, `${what} retention`, C.fieldChars)) };
  });
  const rawIncident = raw.incident;
  if (!isObject(rawIncident)) return refuseRecord('incident is not an object');
  const incident: RunbookIncident = {
    rootCause: readText(rawIncident.rootCause, 'incident rootCause', C.fieldChars),
    fix: readText(rawIncident.fix, 'incident fix', C.fieldChars),
    actionItem: readText(rawIncident.actionItem, 'incident actionItem', C.fieldChars),
  };
  if (rawIncident.timeline !== undefined && rawIncident.timeline !== null) {
    if (!Array.isArray(rawIncident.timeline)) refuseRecord('incident timeline is not a list');
    const entries = rawIncident.timeline as unknown[];
    if (entries.length > C.timeline) refuseRecord(`more than ${C.timeline} timeline entries`);
    incident.timeline = entries.map((t, i) => {
      if (!isObject(t)) return refuseRecord(`timeline entry ${i + 1} is not an object`);
      return { at: readText(t.at, `timeline entry ${i + 1} at`, C.timelineAt), event: readText(t.event, `timeline entry ${i + 1} event`, C.fieldChars) };
    });
  }
  const notes = readOptionalText(raw.notes, 'notes', C.fieldChars);
  return { environment, health, rollback, data, incident, ...optionalField('notes', notes) };
}

export function validateRunbookRecord(text: string): { runbook: Runbook; error: null } | { runbook: null; error: string } {
  const out = readRecordText(text, 'The runbook record', readRunbook);
  return out.error === null ? { runbook: out.value, error: null } : { runbook: null, error: out.error };
}

export function serialiseRunbook(runbook: Runbook): string {
  return `${JSON.stringify(runbook, null, 2)}\n`;
}

/* ------------------------------- the floor ------------------------------- */

export type RunbookFloorId =
  | 'runbook.record' | 'runbook.environment.min' | 'runbook.health.min' | 'runbook.rollback.min' | 'runbook.data.min'
  | 'runbook.incident' | 'runbook.named';
export const RUNBOOK_FLOOR_IDS: readonly RunbookFloorId[] = [
  'runbook.record', 'runbook.environment.min', 'runbook.health.min', 'runbook.rollback.min', 'runbook.data.min', 'runbook.incident', 'runbook.named',
];
export interface RunbookFloorResult { id: RunbookFloorId; label: string; passed: boolean; detail: string }

const allFilled = (...texts: (string | undefined)[]) => texts.every((one) => !blank(one));

/** Filled items per list: the naming field and the describing fields non-blank. */
export function filledRunbookCounts(runbook: Runbook): Record<RunbookList, number> {
  return {
    environment: runbook.environment.filter((e) => allFilled(e.name, e.purpose)).length,
    health: runbook.health.filter((h) => allFilled(h.name, h.how, h.expected)).length,
    rollback: runbook.rollback.filter((s) => allFilled(s.step, s.verify)).length,
    data: runbook.data.filter((d) => allFilled(d.what, d.how, d.where)).length,
  };
}

/** Items whose naming field is blank, over the four lists. */
function unnamedRunbookItems(runbook: Runbook): number {
  return runbook.environment.filter((e) => blank(e.name)).length + runbook.health.filter((h) => blank(h.name)).length
    + runbook.rollback.filter((s) => blank(s.step)).length + runbook.data.filter((d) => blank(d.what)).length;
}

const INCIDENT_FIELDS = [['rootCause', 'root cause'], ['fix', 'fix'], ['actionItem', 'action item']] as const;
/** The incident's blank fields as the floor names them: 'root cause', 'fix', 'action item', in that order. */
function blankIncidentFields(incident: RunbookIncident): string[] {
  return INCIDENT_FIELDS.filter(([key]) => blank(incident[key])).map(([, said]) => said);
}
/** The three incident fields non-blank: what the explanation evidence and the dossier call recorded. */
export function incidentRecorded(incident: RunbookIncident | null | undefined): boolean {
  return !!incident && blankIncidentFields(incident).length === 0;
}

interface MinRule { list: RunbookList; id: RunbookFloorId; floorKey: 'minEnvironment' | 'minHealth' | 'minRollback' | 'minData'; one: string; many: string; tail: string }
const MIN_RULES: readonly MinRule[] = [
  { list: 'environment', id: 'runbook.environment.min', floorKey: 'minEnvironment', one: 'environment entry', many: 'environment entries', tail: 'with a name and a purpose' },
  { list: 'health', id: 'runbook.health.min', floorKey: 'minHealth', one: 'health check', many: 'health checks', tail: 'with a name, a command and the expected output' },
  { list: 'rollback', id: 'runbook.rollback.min', floorKey: 'minRollback', one: 'rollback step', many: 'rollback steps', tail: 'with a step and a check' },
  { list: 'data', id: 'runbook.data.min', floorKey: 'minData', one: 'data entry', many: 'data entries', tail: 'saying what is kept, how and where' },
];

/**
 * The runbook floor: every rule emitted, in `RUNBOOK_FLOOR_IDS` order. A
 * missing or invalid record fails `runbook.record` and the rest is scored
 * against the empty runbook. A minimum of 0 passes; the incident rule reads
 * "Not required" when its toggle is off.
 */
export function evaluateRunbookFloor(text: string | undefined, floor: RunbookFloor): RunbookFloorResult[] {
  const out = validateRunbookRecord(text ?? '');
  const runbook = out.runbook ?? EMPTY_RUNBOOK;
  const counts = filledRunbookCounts(runbook);
  const results: RunbookFloorResult[] = [{
    id: 'runbook.record', label: 'The runbook record', passed: !out.error,
    detail: out.error ? 'The runbook record is missing or not valid' : 'The record is well formed',
  }];
  for (const rule of MIN_RULES) {
    const want = floor[rule.floorKey];
    const have = counts[rule.list];
    results.push({
      id: rule.id, label: `At least ${want} ${word(want, rule.one, rule.many)}`, passed: have >= want,
      detail: have >= want ? `${have} ${word(have, rule.one, rule.many)} ${rule.tail}` : `Fewer than ${want} ${word(want, rule.one, rule.many)} ${rule.tail}`,
    });
  }
  const missing = blankIncidentFields(runbook.incident);
  results.push({
    id: 'runbook.incident', label: 'The incident is recorded', passed: !floor.requireIncident || missing.length === 0,
    detail: !floor.requireIncident ? 'Not required' : missing.length === 0 ? 'The root cause, fix and action item are recorded' : `The incident is missing its ${andList(missing)}`,
  });
  const unnamed = unnamedRunbookItems(runbook);
  results.push({
    id: 'runbook.named', label: 'Every runbook item is named', passed: unnamed === 0,
    detail: unnamed === 0 ? 'Every runbook item is named' : `${unnamed} runbook ${word(unnamed, 'item has', 'items have')} no name`,
  });
  return results;
}

/** The floor in one line, clauses joined by semicolons, as `designFloorSentence` does. */
export function runbookFloorSentence(floor: RunbookFloor): string {
  const parts = MIN_RULES.filter((rule) => floor[rule.floorKey] > 0).map((rule) => {
    const n = floor[rule.floorKey];
    return `at least ${n} ${word(n, rule.one, rule.many)} ${rule.tail}`;
  });
  if (floor.requireIncident) parts.push("the incident's root cause, fix and action item");
  parts.push('every item named');
  return parts.join('; ');
}

/* ----------------------------- the projection ---------------------------- */

/** One path per field, N numbered by `base`'s ids when two versions are compared. */
function runbookPaths(runbook: Runbook, base: Runbook | null): Record<string, string> {
  const p: Record<string, string> = {};
  numberedSlots(runbook.environment, (e) => e.id, base?.environment).forEach((e, i) => {
    if (!e) return;
    const at = `runbook/env-${i + 1}`;
    p[`${at}/name`] = `${e.id}: ${e.name}`;
    p[`${at}/purpose`] = e.purpose;
    p[`${at}/kind`] = e.kind;
    p[`${at}/example`] = e.example ?? '';
  });
  numberedSlots(runbook.health, (h) => h.id, base?.health).forEach((h, i) => {
    if (!h) return;
    const at = `runbook/health-${i + 1}`;
    p[`${at}/name`] = `${h.id}: ${h.name}`;
    p[`${at}/how`] = h.how;
    p[`${at}/expected`] = h.expected;
  });
  numberedSlots(runbook.rollback, (s) => s.id, base?.rollback).forEach((s, i) => {
    if (!s) return;
    const at = `runbook/rollback-${i + 1}`;
    p[`${at}/step`] = `${s.id}: ${s.step}`;
    p[`${at}/verify`] = s.verify;
  });
  p['runbook/rollback/order'] = runbook.rollback.map((s) => s.id).join(', ');
  numberedSlots(runbook.data, (d) => d.id, base?.data).forEach((d, i) => {
    if (!d) return;
    const at = `runbook/data-${i + 1}`;
    p[`${at}/what`] = `${d.id}: ${d.what}`;
    p[`${at}/how`] = d.how;
    p[`${at}/where`] = d.where;
    p[`${at}/retention`] = d.retention ?? '';
  });
  p['runbook/incident/root-cause'] = runbook.incident.rootCause;
  p['runbook/incident/fix'] = runbook.incident.fix;
  p['runbook/incident/action-item'] = runbook.incident.actionItem;
  p['runbook/incident/timeline'] = (runbook.incident.timeline ?? []).map((t) => `${t.at} ${t.event}`).join('\n');
  p['runbook/notes'] = runbook.notes ?? '';
  return p;
}

/** What the reviewer reads and cites: one labelled field per path, never the file; empty for an unreadable record. */
export function runbookReviewProjection(text: string | undefined): Record<string, string> {
  const runbook = validateRunbookRecord(text ?? '').runbook;
  return runbook ? runbookPaths(runbook, null) : {};
}

/** The field-level change between two versions, numbered by the earlier version's ids (a renamed id is a removal plus an addition). */
export function runbookChangeSet(before: string | undefined, after: string | undefined): FieldChange[] {
  const was = validateRunbookRecord(before ?? '').runbook;
  const now = validateRunbookRecord(after ?? '').runbook;
  return projectionChangeSet(was ? runbookPaths(was, was) : {}, now ? runbookPaths(now, was) : {});
}

/** What a proposal never changes, named as kept: every item id and, in a drill phase, the incident. */
export function runbookCarried(live: string | undefined, drill: boolean): string[] {
  const runbook = validateRunbookRecord(live ?? '').runbook;
  if (!runbook) return [];
  return [
    ...runbook.environment.map((e) => `environment entry ${e.id}`),
    ...runbook.health.map((h) => `health check ${h.id}`),
    ...runbook.rollback.map((s) => `rollback step ${s.id}`),
    ...runbook.data.map((d) => `data entry ${d.id}`),
    ...(drill ? ['the incident'] : []),
  ];
}

/** A runbook review path (`runbook/...`), never a file under a `runbook/` folder such as `runbook/notes.md`. */
export const isRunbookPath = (path: string): boolean => isProjectionPathUnder('runbook', path);

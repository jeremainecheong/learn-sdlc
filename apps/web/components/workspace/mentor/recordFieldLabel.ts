/**
 * A runbook or change-request field change named in words, the way
 * the forms name it: "Environment E2, name", "Incident, root cause", "Test T1,
 * covers". A change set numbers each list's items by slot (`runbook/env-2/...`),
 * so a slot is read back to the item id it holds: from its naming change
 * ("E2: API_URL"), which a new item always has, or else from the earlier
 * version's item in that slot when the saved record is given. A slot with
 * neither is named by its number. No projection path is ever shown.
 */
import { CHANGE_REQUEST_JSON, RUNBOOK_JSON, validateChangeRequestRecord, validateRunbookRecord, type FieldChange } from '@learnsdlc/shared';

/** A room record's file named in words, as its forms name it (no file name is shown); null for any other path. */
export const recordInWords = (path: string): string | null =>
  path === RUNBOOK_JSON ? 'Your runbook' : path === CHANGE_REQUEST_JSON ? 'Your change request' : null;

/** A numbered list: its name with an id, its name with only a slot number, and its fields in words. */
interface Slot { noun: string; numbered: string; fields: Record<string, string> }
const SLOTS: Record<string, Slot> = {
  'runbook/env': { noun: 'Environment', numbered: 'Environment entry', fields: { name: 'name', purpose: 'what it controls', kind: 'kind', example: 'example' } },
  'runbook/health': { noun: 'Health check', numbered: 'Health check', fields: { name: 'name', how: 'command', expected: 'expected output' } },
  'runbook/rollback': { noun: 'Rollback step', numbered: 'Rollback step', fields: { step: 'step', verify: 'how to verify' } },
  'runbook/data': { noun: 'Data entry', numbered: 'Data entry', fields: { what: 'what is kept', how: 'how', where: 'where', retention: 'kept for' } },
  'change/contract': { noun: 'Contract change', numbered: 'Contract change', fields: { path: 'path', method: 'method', change: 'change', why: 'why' } },
  'change/test': { noun: 'Test', numbered: 'Test', fields: { suite: 'suite', covers: 'covers', result: 'result' } },
  'change/release/change': { noun: 'Release line', numbered: 'Release line', fields: { line: 'line', covers: 'covers' } },
};
const PLAIN: Record<string, string> = {
  'runbook/rollback/order': 'Rollback, order of the steps',
  'runbook/incident/root-cause': 'Incident, root cause',
  'runbook/incident/fix': 'Incident, fix',
  'runbook/incident/action-item': 'Incident, action item',
  'runbook/incident/timeline': 'Incident, timeline',
  'runbook/notes': 'Notes',
  'change/impact/operations': 'Impact, operations',
  'change/impact/screens': 'Impact, screens',
  'change/impact/files': 'Impact, files',
  'change/release/version': 'Release, version',
  'change/release/summary': 'Release, summary',
  'change/release/rollback': 'Release, rollback',
  'change/release/risks': 'Release, risks',
  'change/notes': 'Notes',
};
const SLOT_PATH = /^((?:runbook\/(?:env|health|rollback|data))|(?:change\/(?:contract|test|release\/change)))-(\d+)\/([a-z-]+)$/;
const NAMING = new Set(['name', 'step', 'what', 'path', 'suite', 'line']);

/** The earlier version's item ids per slot list, in the order the change set numbers them. */
function savedIds(saved: string | undefined): Record<string, string[]> {
  if (saved === undefined) return {};
  const runbook = validateRunbookRecord(saved).runbook;
  if (runbook) {
    return {
      'runbook/env': runbook.environment.map((e) => e.id), 'runbook/health': runbook.health.map((h) => h.id),
      'runbook/rollback': runbook.rollback.map((s) => s.id), 'runbook/data': runbook.data.map((d) => d.id),
    };
  }
  const change = validateChangeRequestRecord(saved, null).change;
  if (change) {
    return {
      'change/contract': change.contract.map((c) => c.id), 'change/test': change.tests.map((t) => t.id),
      'change/release/change': change.release.changes.map((l) => l.id),
    };
  }
  return {};
}

/** Each slot's item id (`runbook/env-2` to `E2`), from the naming changes first, then the saved record. */
export function recordSlotIds(changes: readonly FieldChange[], saved?: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const change of changes) {
    const m = SLOT_PATH.exec(change.path);
    const id = m && NAMING.has(m[3]) ? /^([A-Z]\d+): /.exec(change.after ?? change.before ?? '')?.[1] : undefined;
    if (m && id) ids.set(`${m[1]}-${m[2]}`, id);
  }
  for (const [list, listIds] of Object.entries(savedIds(saved))) {
    listIds.forEach((id, at) => { if (!ids.has(`${list}-${at + 1}`)) ids.set(`${list}-${at + 1}`, id); });
  }
  return ids;
}

/** A record field change's path in words, its item named by id when `ids` knows the slot. */
export function recordFieldLabel(path: string, ids: ReadonlyMap<string, string> = new Map()): string {
  if (PLAIN[path]) return PLAIN[path];
  const m = SLOT_PATH.exec(path);
  if (m) {
    const slot = SLOTS[m[1]];
    const id = ids.get(`${m[1]}-${m[2]}`);
    const field = slot.fields[m[3]] ?? m[3].replace(/-/g, ' ');
    return `${id ? `${slot.noun} ${id}` : `${slot.numbered} ${m[2]}`}, ${field}`;
  }
  return path.replace(/^(?:runbook|change)\//, '').replace(/[/-]/g, ' ');
}

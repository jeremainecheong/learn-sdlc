/**
 * The Maintenance change request as a structured record,
 * `maintenance/change-request.json`, beside the teacher's ticket
 * (`checks.ticket`). The learner's record says what the change touched, the
 * contract amendments it declares (behind the teacher's switch), the tests
 * that cover each acceptance item and the release. Every `covers` is a list
 * of the ticket's acceptance ids, so the trace rule is counted, never matched
 * in prose. Pure: no network, no DOM.
 */
import { isProjectionPathUnder, numberedSlots, projectionChangeSet, type FieldChange } from './projection-diff';
import {
  blankText as blank, isObject, optionalField, readItemId, readObjects, readOptionalText, readRecordText, readText, readTextList, refuseRecord,
} from './record-read';
import { pluralWord as word } from './words';

export const CHANGE_REQUEST_JSON = 'maintenance/change-request.json';

export interface AcceptanceLine { id: string; line: string }
export interface ChangeTicket { id: string; title: string; summary: string; acceptance: AcceptanceLine[] }
export type ContractChangeKind = 'added' | 'changed' | 'removed';
export const CONTRACT_CHANGE_KINDS: ContractChangeKind[] = ['added', 'changed', 'removed'];
export type ChangeTestResult = 'pass' | 'fail' | 'not-run';
export const CHANGE_TEST_RESULTS: ChangeTestResult[] = ['pass', 'fail', 'not-run'];
Object.freeze(CONTRACT_CHANGE_KINDS);
Object.freeze(CHANGE_TEST_RESULTS);

export interface ChangeImpact { operations: string[]; screens: string[]; files: string[] }
export interface ContractAmendment { id: string; method: string; path: string; change: ContractChangeKind; why: string }
export interface ChangeTest { id: string; suite: string; covers: string[]; result: ChangeTestResult }
export interface ReleaseChange { id: string; line: string; covers: string[] }
export interface ChangeRelease { version: string; summary: string; changes: ReleaseChange[]; rollback: string; risks?: string[] }
export interface ChangeRequest { impact: ChangeImpact; contract: ContractAmendment[]; tests: ChangeTest[]; release: ChangeRelease; notes?: string }
export type ImpactList = keyof ChangeImpact;
export const IMPACT_LISTS: readonly ImpactList[] = ['operations', 'screens', 'files'];
export const CHANGE_ID_LETTER = { contract: 'C', tests: 'T', changes: 'L' } as const;
Object.freeze(IMPACT_LISTS);
Object.freeze(CHANGE_ID_LETTER);

export interface ChangeFloor { minImpact: number; minContract: number; minTests: number; requireRelease: boolean; traceEveryAcceptance: boolean }
/** `CodeChecks.change`: the record path, the contract switch and the floor. */
export interface ChangeChecks { record: typeof CHANGE_REQUEST_JSON; contract: boolean; floor: ChangeFloor }

export const CHANGE_CAPS = {
  listItems: 20, covers: 12, fieldChars: 2000, method: 16, version: 40, itemId: 16,
  ticketId: 16, ticketTitle: 400, ticketSummary: 2000, acceptance: 12, acceptanceId: 16, acceptanceLine: 400,
  minImpact: [0, 20], minContract: [0, 20], minTests: [0, 20],
} as const;

export const DEFAULT_CHANGE_FLOOR: ChangeFloor = { minImpact: 1, minContract: 1, minTests: 1, requireRelease: true, traceEveryAcceptance: true };
Object.freeze(DEFAULT_CHANGE_FLOOR);
export const DEFAULT_CHANGE_CONTRACT = false;
export const EMPTY_CHANGE_REQUEST: ChangeRequest = {
  impact: { operations: [], screens: [], files: [] }, contract: [], tests: [],
  release: { version: '', summary: '', changes: [], rollback: '' },
};
for (const list of IMPACT_LISTS) Object.freeze(EMPTY_CHANGE_REQUEST.impact[list]);
Object.freeze(EMPTY_CHANGE_REQUEST.impact);
Object.freeze(EMPTY_CHANGE_REQUEST.contract);
Object.freeze(EMPTY_CHANGE_REQUEST.tests);
Object.freeze(EMPTY_CHANGE_REQUEST.release.changes);
Object.freeze(EMPTY_CHANGE_REQUEST.release);
Object.freeze(EMPTY_CHANGE_REQUEST);

export const CHANGE_PROPOSAL_REFUSED = "The assistant's proposal was not a valid change request and was discarded.";
export const CHANGE_OLDER_FORMAT_ROOM = "This project's Maintenance task is in an older format; its owner needs to re-save it.";
export const CHANGE_OLDER_FORMAT_REFUSAL = 'Maintenance is still in the older format. Open its Maintenance step in the editor and save it once to convert it.';
export const CHANGE_OLDER_FORMAT_ASSIGN_REFUSAL = "This version's Maintenance is in the older format and cannot be assigned. Publish it again from the editor.";
/** The one refusal the pack loader and the authoring door give a ticket or a change request on any phase but Maintenance. */
export const ONLY_MAINTENANCE_CHANGE = 'Only Maintenance carries a ticket and a change request.';
export const changeRequestSaveRefusal = (error: string) => `The change request was not saved: ${error}.`;
export const startingChangeRequestError = (error: string) => `The starting change request is not valid: ${error}.`;
/**
 * The editor's ticket and change saves read the starting change request (the covered-id guard, the contract-off
 * rewrite), so a starting record that does not parse refuses them rather than skipping both.
 */
export const STARTING_CHANGE_UNREADABLE =
  "The starting change request could not be read. Start it empty or reset it to the pack's before you change the ticket or the contract switch.";

/** The teacher's ticket, held to `CHANGE_CAPS`; throws an Error with one fixed sentence. Unknown keys are dropped. */
export function validateChangeTicket(raw: unknown): ChangeTicket {
  if (!isObject(raw)) throw new Error('ticket must be an object.');
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const id = text(raw.id);
  if (!id || !id.trim()) throw new Error('The ticket needs an id.');
  if (id.length > CHANGE_CAPS.ticketId) throw new Error(`A ticket id is at most ${CHANGE_CAPS.ticketId} characters.`);
  const title = text(raw.title);
  if (!title || !title.trim()) throw new Error('The ticket needs a title.');
  if (title.length > CHANGE_CAPS.ticketTitle) throw new Error(`The ticket title is at most ${CHANGE_CAPS.ticketTitle} characters.`);
  const summary = raw.summary === undefined ? '' : text(raw.summary);
  if (summary === null) throw new Error('The ticket summary must be text.');
  if (summary.length > CHANGE_CAPS.ticketSummary) throw new Error(`The ticket summary is at most ${CHANGE_CAPS.ticketSummary} characters.`);
  if (!Array.isArray(raw.acceptance)) throw new Error('The ticket acceptance lines must be a list.');
  if (raw.acceptance.length > CHANGE_CAPS.acceptance) throw new Error(`A ticket has at most ${CHANGE_CAPS.acceptance} acceptance lines.`);
  const seen = new Set<string>();
  const acceptance = (raw.acceptance as unknown[]).map((one, i) => {
    if (!isObject(one)) throw new Error(`Acceptance line ${i + 1} must be an object.`);
    const lineId = text(one.id);
    if (!lineId || !lineId.trim()) throw new Error(`Acceptance line ${i + 1} needs an id.`);
    if (lineId.length > CHANGE_CAPS.acceptanceId) throw new Error(`Acceptance line ${i + 1} has an id longer than ${CHANGE_CAPS.acceptanceId} characters.`);
    if (seen.has(lineId)) throw new Error(`Acceptance ids are unique: ${lineId} is used twice.`);
    seen.add(lineId);
    const line = text(one.line);
    if (!line || !line.trim()) throw new Error(`Acceptance ${lineId} needs a line.`);
    if (line.length > CHANGE_CAPS.acceptanceLine) throw new Error(`Acceptance ${lineId} is longer than ${CHANGE_CAPS.acceptanceLine} characters.`);
    return { id: lineId, line };
  });
  return { id, title, summary, acceptance };
}

const K = CHANGE_CAPS;

function readCovers(item: Record<string, unknown>, what: string, acceptance: ReadonlySet<string> | null): string[] {
  const covers = readTextList(item.covers, `${what} covers`, K.acceptanceId, K.covers);
  if (acceptance) {
    const unknown = covers.find((id) => !acceptance.has(id));
    if (unknown !== undefined) refuseRecord(`${what} covers ${unknown}, which is not an acceptance item of the ticket`);
  }
  return covers;
}

function readChange(raw: Record<string, unknown>, acceptance: ReadonlySet<string> | null): ChangeRequest {
  const rawImpact = raw.impact;
  if (!isObject(rawImpact)) return refuseRecord('impact is not an object');
  const impact: ChangeImpact = {
    operations: readTextList(rawImpact.operations, 'impact operations', K.fieldChars, K.listItems),
    screens: readTextList(rawImpact.screens, 'impact screens', K.fieldChars, K.listItems),
    files: readTextList(rawImpact.files, 'impact files', K.fieldChars, K.listItems),
  };
  const contractIds = new Set<string>();
  const contract = readObjects(raw, 'contract', K.listItems, 'contract amendments', 'contract amendment').map((c, i) => {
    const id = readItemId(c, 'contract amendment', i, contractIds, K.itemId);
    const what = `contract amendment ${id}`;
    const method = readText(c.method, `${what} method`, K.method);
    const path = readText(c.path, `${what} path`, K.fieldChars);
    if (!(CONTRACT_CHANGE_KINDS as unknown[]).includes(c.change)) refuseRecord(`${what} has an unknown change`);
    return { id, method, path, change: c.change as ContractChangeKind, why: readText(c.why, `${what} why`, K.fieldChars) };
  });
  const testIds = new Set<string>();
  const tests = readObjects(raw, 'tests', K.listItems, 'tests', 'test').map((t, i) => {
    const id = readItemId(t, 'test', i, testIds, K.itemId);
    const what = `test ${id}`;
    const suite = readText(t.suite, `${what} suite`, K.fieldChars);
    const covers = readCovers(t, what, acceptance);
    if (!(CHANGE_TEST_RESULTS as unknown[]).includes(t.result)) refuseRecord(`${what} has an unknown result`);
    return { id, suite, covers, result: t.result as ChangeTestResult };
  });
  const rawRelease = raw.release;
  if (!isObject(rawRelease)) return refuseRecord('release is not an object');
  const version = readText(rawRelease.version, 'release version', K.version);
  const summary = readText(rawRelease.summary, 'release summary', K.fieldChars);
  // named under its parent, as every other release field is: readObjects names a list by its key alone
  if (!Array.isArray(rawRelease.changes)) refuseRecord('release changes is not a list');
  const lineIds = new Set<string>();
  const changes = readObjects(rawRelease, 'changes', K.listItems, 'release change lines', 'change line').map((l, i) => {
    const id = readItemId(l, 'change line', i, lineIds, K.itemId);
    const what = `change line ${id}`;
    return { id, line: readText(l.line, `${what} line`, K.fieldChars), covers: readCovers(l, what, acceptance) };
  });
  const rollback = readText(rawRelease.rollback, 'release rollback', K.fieldChars);
  const risks = rawRelease.risks === undefined || rawRelease.risks === null ? undefined : readTextList(rawRelease.risks, 'release risks', K.fieldChars, K.listItems);
  const notes = readOptionalText(raw.notes, 'notes', K.fieldChars);
  return {
    impact, contract, tests,
    release: { version, summary, changes, rollback, ...optionalField('risks', risks) },
    ...optionalField('notes', notes),
  };
}

/** `acceptanceIds` null reads `covers` as ids of at most 16 characters only (the projection's and the migration's reading). */
export function validateChangeRequestRecord(text: string, acceptanceIds: readonly string[] | null): { change: ChangeRequest; error: null } | { change: null; error: string } {
  const acceptance = acceptanceIds ? new Set(acceptanceIds) : null;
  const out = readRecordText(text, 'The change request record', (raw) => readChange(raw, acceptance));
  return out.error === null ? { change: out.value, error: null } : { change: null, error: out.error };
}

export function serialiseChangeRequest(change: ChangeRequest): string {
  return `${JSON.stringify(change, null, 2)}\n`;
}

/* ------------------------------- the floor ------------------------------- */

export type ChangeFloorId = 'change.record' | 'change.impact.min' | 'change.contract.min' | 'change.tests.min' | 'change.release' | 'change.trace' | 'change.named';
const CHANGE_FLOOR_IDS: readonly ChangeFloorId[] = ['change.record', 'change.impact.min', 'change.contract.min', 'change.tests.min', 'change.release', 'change.trace', 'change.named'];
export interface ChangeFloorResult { id: ChangeFloorId; label: string; passed: boolean; detail: string }
/** What the floor reads beside the record: the switch, the floor and the ticket's acceptance ids. */
export interface ChangeFloorSpec { contract: boolean; floor: ChangeFloor; ticket: ChangeTicket }

const amendments = (n: number) => `${n} contract ${word(n, 'amendment', 'amendments')}`;
/** Each minimum counted with what it counts, as the floor's details and its one-line sentence both say it. */
const MIN_PHRASES: Readonly<Record<'minImpact' | 'minContract' | 'minTests', (n: number) => string>> = {
  minImpact: (n) => `${n} ${word(n, 'operation, screen or file', 'operations, screens or files')}`,
  minContract: (n) => `${amendments(n)} with a method, a path and a reason`,
  minTests: (n) => `${n} ${word(n, 'test', 'tests')} naming a suite and the acceptance items ${n === 1 ? 'it covers' : 'they cover'}`,
};

/** The rules the floor emits, in order: `change.contract.min` only when the contract is on. */
export function changeFloorIds(contract: boolean): ChangeFloorId[] {
  return CHANGE_FLOOR_IDS.filter((id) => contract || id !== 'change.contract.min');
}

/** Non-blank entries over the impact's three lists. */
export function impactEntries(change: ChangeRequest): number {
  return IMPACT_LISTS.reduce((n, list) => n + change.impact[list].filter((one) => !blank(one)).length, 0);
}

/** The acceptance ids a named test or a named change line covers. */
export function coveredAcceptance(change: ChangeRequest): Set<string> {
  return new Set([
    ...change.tests.filter((t) => !blank(t.suite)).flatMap((t) => t.covers),
    ...change.release.changes.filter((l) => !blank(l.line)).flatMap((l) => l.covers),
  ]);
}

/**
 * The change-request floor, every rule emitted in `CHANGE_FLOOR_IDS` order,
 * `change.contract.min` only when the contract is on. The record is read
 * against the ticket's acceptance ids, so a `covers` id the ticket does not
 * hold fails `change.record`, and the rest is scored against the empty record.
 */
export function evaluateChangeFloor(text: string | undefined, spec: ChangeFloorSpec): ChangeFloorResult[] {
  const { floor, contract, ticket } = spec;
  const out = validateChangeRequestRecord(text ?? '', ticket.acceptance.map((one) => one.id));
  const change = out.change ?? EMPTY_CHANGE_REQUEST;
  const results: ChangeFloorResult[] = [{
    id: 'change.record', label: 'The change request record', passed: !out.error,
    detail: out.error ? 'The change request record is missing or not valid' : 'The record is well formed',
  }];
  const impact = impactEntries(change);
  results.push({
    id: 'change.impact.min', label: `At least ${floor.minImpact} ${word(floor.minImpact, 'impact entry', 'impact entries')}`, passed: impact >= floor.minImpact,
    detail: impact >= floor.minImpact ? `${impact} ${word(impact, 'entry', 'entries')} named in the impact`
      : `Fewer than ${MIN_PHRASES.minImpact(floor.minImpact)} named in the impact`,
  });
  if (contract) {
    const filled = change.contract.filter((c) => !blank(c.method) && !blank(c.path) && !blank(c.why)).length;
    results.push({
      id: 'change.contract.min', label: `At least ${amendments(floor.minContract)}`, passed: filled >= floor.minContract,
      detail: filled >= floor.minContract ? MIN_PHRASES.minContract(filled) : `Fewer than ${MIN_PHRASES.minContract(floor.minContract)}`,
    });
  }
  const tests = change.tests.filter((t) => !blank(t.suite) && t.covers.length > 0).length;
  results.push({
    id: 'change.tests.min', label: `At least ${floor.minTests} ${word(floor.minTests, 'test', 'tests')}`, passed: tests >= floor.minTests,
    detail: tests >= floor.minTests ? MIN_PHRASES.minTests(tests) : `Fewer than ${MIN_PHRASES.minTests(floor.minTests)}`,
  });
  const released = !blank(change.release.version) && change.release.changes.some((l) => !blank(l.line));
  results.push({
    id: 'change.release', label: 'The release is recorded', passed: !floor.requireRelease || released,
    detail: !floor.requireRelease ? 'Not required' : released ? 'The release has a version and a change line' : 'The release has no version or no change line',
  });
  const covered = coveredAcceptance(change);
  const ids = [...new Set(ticket.acceptance.map((one) => one.id))];
  const uncovered = ids.filter((id) => !covered.has(id));
  results.push({
    id: 'change.trace', label: 'Every acceptance item is covered', passed: !floor.traceEveryAcceptance || uncovered.length === 0,
    detail: !floor.traceEveryAcceptance ? 'Not required' : !ids.length ? 'No acceptance items to trace'
      : uncovered.length === 0 ? 'Every acceptance item is covered'
        : `${word(uncovered.length, 'Acceptance item', 'Acceptance items')} not covered by any change line or test: ${uncovered.join(', ')}`,
  });
  const unnamed = IMPACT_LISTS.reduce((n, list) => n + change.impact[list].filter(blank).length, 0)
    + (contract ? change.contract.filter((c) => blank(c.path)).length : 0)
    + change.tests.filter((t) => blank(t.suite)).length
    + change.release.changes.filter((l) => blank(l.line)).length;
  results.push({
    id: 'change.named', label: 'Every change request item is named', passed: unnamed === 0,
    detail: unnamed === 0 ? 'Every change request item is named' : `${unnamed} ${word(unnamed, 'item in the change request has', 'items in the change request have')} no name`,
  });
  return results;
}

/** The floor in one line, clauses joined by semicolons, as `designFloorSentence` does; the contract clause only when on. */
export function changeFloorSentence(floor: ChangeFloor, contract: boolean): string {
  const parts: string[] = [];
  if (floor.minImpact > 0) parts.push(`at least ${MIN_PHRASES.minImpact(floor.minImpact)} in the impact`);
  if (contract && floor.minContract > 0) parts.push(`at least ${MIN_PHRASES.minContract(floor.minContract)}`);
  if (floor.minTests > 0) parts.push(`at least ${MIN_PHRASES.minTests(floor.minTests)}`);
  if (floor.requireRelease) parts.push('a release with a version and a change line');
  if (floor.traceEveryAcceptance) parts.push('every acceptance item covered by a test or a change line');
  parts.push('every item named');
  return parts.join('; ');
}

/* ----------------------------- the projection ---------------------------- */

/** One path per field, N numbered by `base`'s ids when two versions are compared; the contract only when on. */
function changePaths(change: ChangeRequest, contract: boolean, base: ChangeRequest | null): Record<string, string> {
  const p: Record<string, string> = {};
  for (const list of IMPACT_LISTS) p[`change/impact/${list}`] = change.impact[list].join('\n');
  if (contract) {
    numberedSlots(change.contract, (c) => c.id, base?.contract).forEach((c, i) => {
      if (!c) return;
      const at = `change/contract-${i + 1}`;
      p[`${at}/path`] = `${c.id}: ${c.path}`;
      p[`${at}/method`] = c.method;
      p[`${at}/change`] = c.change;
      p[`${at}/why`] = c.why;
    });
  }
  numberedSlots(change.tests, (t) => t.id, base?.tests).forEach((t, i) => {
    if (!t) return;
    const at = `change/test-${i + 1}`;
    p[`${at}/suite`] = `${t.id}: ${t.suite}`;
    p[`${at}/covers`] = t.covers.join(', ');
    p[`${at}/result`] = t.result;
  });
  p['change/release/version'] = change.release.version;
  p['change/release/summary'] = change.release.summary;
  p['change/release/rollback'] = change.release.rollback;
  p['change/release/risks'] = (change.release.risks ?? []).join('\n');
  numberedSlots(change.release.changes, (l) => l.id, base?.release.changes).forEach((l, i) => {
    if (!l) return;
    const at = `change/release/change-${i + 1}`;
    p[`${at}/line`] = `${l.id}: ${l.line}`;
    p[`${at}/covers`] = l.covers.join(', ');
  });
  p['change/notes'] = change.notes ?? '';
  return p;
}

/** The ticket is not projected: it is the teacher's text and reaches the reviewer fenced as data. */
export function changeRequestReviewProjection(text: string | undefined, contract: boolean): Record<string, string> {
  const change = validateChangeRequestRecord(text ?? '', null).change;
  return change ? changePaths(change, contract, null) : {};
}

/** The field-level change between two versions, numbered by the earlier version's ids (a renamed id is a removal plus an addition). */
export function changeRequestChangeSet(before: string | undefined, after: string | undefined, contract: boolean): FieldChange[] {
  const was = validateChangeRequestRecord(before ?? '', null).change;
  const now = validateChangeRequestRecord(after ?? '', null).change;
  return projectionChangeSet(was ? changePaths(was, contract, was) : {}, now ? changePaths(now, contract, was) : {});
}

/** What a proposal never changes, named as kept: every item id, the contract amendments only when the contract is on. */
export function changeRequestCarried(live: string | undefined, contract: boolean): string[] {
  const change = validateChangeRequestRecord(live ?? '', null).change;
  if (!change) return [];
  return [
    ...(contract ? change.contract.map((c) => `contract amendment ${c.id}`) : []),
    ...change.tests.map((t) => `test ${t.id}`),
    ...change.release.changes.map((l) => `change line ${l.id}`),
  ];
}

/** A change-request review path (`change/...`), never a file under a `change/` folder such as `change/notes.md`. */
export const isChangePath = (path: string): boolean => isProjectionPathUnder('change', path);

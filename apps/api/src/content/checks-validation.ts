import {
  CHANGE_CAPS,
  CHANGE_REQUEST_JSON,
  CONFIG_SMOKE_KEY,
  DEFAULT_CHANGE_CONTRACT,
  DEFAULT_CHANGE_FLOOR,
  FIXED_SCORER_KEYS,
  ONLY_DEPLOYMENT_RUNBOOK,
  ONLY_MAINTENANCE_CHANGE,
  RUNBOOK_CAPS,
  RUNBOOK_DRILL_START_NOT_EMPTY,
  RUNBOOK_JSON,
  defaultRunbookFloor,
  incidentIsEmpty,
  startingChangeRequestError,
  startingRunbookError,
  validateChangeRequestRecord,
  validateRunbookRecord,
} from '@learnsdlc/shared';
import type { ChangeChecks, ChangeTicket, PhaseKey, RunbookChecks } from '@learnsdlc/shared';
import type { PhaseChecks } from './content.types';
import { req } from './validate';

/*
 * The record validators of Deployment's runbook and Maintenance's change
 * request, and the record helpers every layer reads. Pure: each reads only its
 * arguments and the shared package. They sit apart from the loader because
 * the loader, the task editor and the upload door hold a record to these same
 * rules, and the other modules read them without loading the loader.
 */

const RUNBOOK_FLOOR_RANGES = ['minEnvironment', 'minHealth', 'minRollback', 'minData'] as const;
const CHANGE_FLOOR_RANGES = ['minImpact', 'minContract', 'minTests'] as const;
const CHANGE_FLOOR_TOGGLES = ['requireRelease', 'traceEveryAcceptance'] as const;

/**
 * `checks.runbook`, held to `RUNBOOK_CAPS` by the pack loader, the task editor
 * and the upload door alike. A missing minimum takes the new-phase default and
 * a missing incident toggle follows the drill (spec section 4). Throws one
 * fixed sentence naming the field.
 */
export function validateRunbookChecks(spec: unknown, phaseKey: PhaseKey | undefined, hasDrill: boolean): RunbookChecks {
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'checks.runbook must be an object.');
  req(phaseKey === undefined || phaseKey === 'deployment', ONLY_DEPLOYMENT_RUNBOOK);
  const raw = spec as Record<string, unknown>;
  req(raw.record === undefined || raw.record === RUNBOOK_JSON, `The runbook lives at ${RUNBOOK_JSON}.`);
  const f = (raw.floor ?? {}) as Record<string, unknown>;
  req(f && typeof f === 'object' && !Array.isArray(f), 'runbook.floor must be an object.');
  const floor = defaultRunbookFloor(hasDrill);
  for (const key of RUNBOOK_FLOOR_RANGES) {
    const value = f[key] ?? floor[key];
    const [lo, hi] = RUNBOOK_CAPS[key];
    req(Number.isInteger(value) && (value as number) >= lo && (value as number) <= hi, `runbook.floor.${key} must be between ${lo} and ${hi}`);
    floor[key] = value as number;
  }
  const incident = f.requireIncident ?? floor.requireIncident;
  req(typeof incident === 'boolean', 'runbook.floor.requireIncident must be true or false');
  floor.requireIncident = incident as boolean;
  return { record: RUNBOOK_JSON, floor };
}

/** `checks.change`, held to `CHANGE_CAPS`; the contract switch is off unless said (spec section 4). */
export function validateChangeChecks(spec: unknown, phaseKey?: PhaseKey): ChangeChecks {
  req(spec && typeof spec === 'object' && !Array.isArray(spec), 'checks.change must be an object.');
  req(phaseKey === undefined || phaseKey === 'maintenance', ONLY_MAINTENANCE_CHANGE);
  const raw = spec as Record<string, unknown>;
  req(raw.record === undefined || raw.record === CHANGE_REQUEST_JSON, `The change request lives at ${CHANGE_REQUEST_JSON}.`);
  const contract = raw.contract ?? DEFAULT_CHANGE_CONTRACT;
  req(typeof contract === 'boolean', 'change.contract must be true or false');
  const f = (raw.floor ?? {}) as Record<string, unknown>;
  req(f && typeof f === 'object' && !Array.isArray(f), 'change.floor must be an object.');
  const floor = { ...DEFAULT_CHANGE_FLOOR };
  for (const key of CHANGE_FLOOR_RANGES) {
    const value = f[key] ?? floor[key];
    const [lo, hi] = CHANGE_CAPS[key];
    req(Number.isInteger(value) && (value as number) >= lo && (value as number) <= hi, `change.floor.${key} must be between ${lo} and ${hi}`);
    floor[key] = value as number;
  }
  for (const key of CHANGE_FLOOR_TOGGLES) {
    const value = f[key] ?? floor[key];
    req(typeof value === 'boolean', `change.floor.${key} must be true or false`);
    floor[key] = value as boolean;
  }
  return { record: CHANGE_REQUEST_JSON, contract: contract as boolean, floor };
}

/** What is wrong with a starting runbook, as a sentence (the loader, the upload door and the file-replace door), or null. */
export function startingRunbookProblem(text: string, drill: boolean): string | null {
  const out = validateRunbookRecord(text);
  if (out.error) return startingRunbookError(out.error);
  return drill && !incidentIsEmpty(out.runbook!.incident) ? RUNBOOK_DRILL_START_NOT_EMPTY : null;
}

/** What is wrong with a starting change request, read against the ticket, or null. */
export function startingChangeProblem(text: string, ticket: ChangeTicket): string | null {
  const out = validateChangeRequestRecord(text, ticket.acceptance.map((one) => one.id));
  return out.error ? startingChangeRequestError(out.error) : null;
}

/** A config phase with a runbook, or a code phase with a change request. */
export function hasRecord(checks: PhaseChecks): boolean {
  return recordPathOf(checks) !== null;
}

/**
 * The record a config or code phase grades beside its rules or runs: a
 * Deployment's runbook or a Maintenance's change request, by its fixed path.
 * Null for a phase without one; a story or design record is not asked here.
 */
export function recordPathOf(checks: PhaseChecks | null | undefined): string | null {
  if (checks?.kind === 'config' && checks.runbook) return RUNBOOK_JSON;
  if (checks?.kind === 'code' && checks.change) return CHANGE_REQUEST_JSON;
  return null;
}

/**
 * The rubric keys a config or code phase's own scorers set, each once: a
 * config phase's file-rule criteria in rule order and then `build_smoke`, a
 * code phase's four fixed keys. [] for every other kind.
 */
export function lockedCriteriaOf(checks: PhaseChecks): string[] {
  if (checks.kind === 'config') return [...new Set([...checks.rules.map((r) => r.criterion), CONFIG_SMOKE_KEY])];
  if (checks.kind === 'code') return [...FIXED_SCORER_KEYS.code];
  return [];
}

/**
 * The record criteria of a phase with a record, in rubric order: every key
 * outside `lockedCriteriaOf`, so in a config phase every key no file rule
 * claims that is not `build_smoke`, in a code phase every key outside the
 * four fixed ones (spec section 4). [] otherwise.
 */
export function recordCriteriaOf(checks: PhaseChecks, rubric: { criteria: readonly { key: string }[] }): string[] {
  if (!hasRecord(checks)) return [];
  const locked = new Set(lockedCriteriaOf(checks));
  return rubric.criteria.map((c) => c.key).filter((key) => !locked.has(key));
}

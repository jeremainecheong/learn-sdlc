import {
  CHANGE_OLDER_FORMAT_ROOM,
  DESIGN_OLDER_FORMAT_ROOM,
  REQUIREMENTS_OLDER_FORMAT_ROOM,
  RETIRED_WRITTEN_PHASE_ROOM,
  RUNBOOK_OLDER_FORMAT_ROOM,
  type PhaseKey,
} from '@learnsdlc/shared';
import type { PhaseContent } from './content.types';
import type { CompiledSnapshot } from './pack-compiler';

/**
 * What a version's phase grades, read from its compiled snapshot: the checks
 * kind (`story`, `design`, or the older `markdown`). One reading for every
 * caller that tells an older-format version from a structured one, so they
 * never disagree: `requirementsGrading` (the boot re-pin and the class picker
 * read Requirements through it), and the readings below, which name the
 * older format phase by phase.
 */
export function phaseCheckKind(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined, phaseKey: PhaseKey): string | undefined {
  const checks = compiled?.content?.phases?.find((phase) => phase.key === phaseKey)?.checks as { kind?: string } | undefined;
  return checks?.kind;
}

/** The parts of a phase's checks the per-rule predicate reads: the kind, and whether a record is declared. */
type ChecksShape = { kind?: string; runbook?: unknown; change?: unknown } | undefined;

/** A structured phase a version can still hold in an older form. */
export type OlderFormatKey = 'requirements' | 'design' | 'deployment' | 'maintenance';

/**
 * The structured phases in the one order every older-format answer names
 * them, Requirements first. `olderFormatPhase`, the publish
 * refusals (`AuthoringService`) and the class door all read it.
 */
export const OLDER_FORMAT_PHASES: readonly OlderFormatKey[] = ['requirements', 'design', 'deployment', 'maintenance'];

/** A version's phase's checks, read from its compiled snapshot; undefined when it has no such phase. */
export function phaseChecksOf(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined, phaseKey: PhaseKey): ChecksShape {
  return compiled?.content?.phases?.find((phase) => phase.key === phaseKey)?.checks as ChecksShape;
}

/**
 * The older form of each structured phase, by its own rule: the markdown kind
 * for Requirements and Design, a config Deployment with no runbook, a code
 * Maintenance with no change request.
 */
export function isOlderFormat(key: OlderFormatKey, checks: ChecksShape): boolean {
  if (key === 'requirements' || key === 'design') return checks?.kind === 'markdown';
  if (key === 'deployment') return checks?.kind === 'config' && !checks.runbook;
  return checks?.kind === 'code' && !checks.change;
}

/** The structured form of each: a story, a design, a config Deployment with a runbook, a code Maintenance with a change request. */
export function isStructured(key: OlderFormatKey, checks: ChecksShape): boolean {
  if (key === 'requirements') return checks?.kind === 'story';
  if (key === 'design') return checks?.kind === 'design';
  if (key === 'deployment') return checks?.kind === 'config' && !!checks.runbook;
  return checks?.kind === 'code' && !!checks.change;
}

/** Which structured phase a version still holds in its older form, in `OLDER_FORMAT_PHASES` order; null when none. */
export function olderFormatPhase(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined): OlderFormatKey | null {
  return OLDER_FORMAT_PHASES.find((key) => isOlderFormat(key, phaseChecksOf(compiled, key))) ?? null;
}

/** Whether a phase is a written (markdown) phase under a key no structured kind keeps: nothing is left to grade it. */
const isRetiredWritten = (phase: { key: string; checks?: unknown }): boolean =>
  (phase.checks as ChecksShape)?.kind === 'markdown' && phase.key !== 'requirements' && phase.key !== 'design';

/**
 * Every phase, in phase order, of the markdown kind whose key is neither
 * Requirements nor Design; empty when the version holds none.
 */
export function retiredWrittenPhases(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined): PhaseKey[] {
  const phases = [...(compiled?.content?.phases ?? [])].sort((a, b) => a.order - b.order);
  return phases.filter(isRetiredWritten).map((phase) => phase.key);
}

/** The first of `retiredWrittenPhases`; null when the version holds none. */
export function retiredWrittenPhase(compiled: Pick<CompiledSnapshot, 'content'> | null | undefined): PhaseKey | null {
  return retiredWrittenPhases(compiled)[0] ?? null;
}

/** Each structured phase's older-format room sentence. */
const ROOM: Record<OlderFormatKey, string> = {
  requirements: REQUIREMENTS_OLDER_FORMAT_ROOM,
  design: DESIGN_OLDER_FORMAT_ROOM,
  deployment: RUNBOOK_OLDER_FORMAT_ROOM,
  maintenance: CHANGE_OLDER_FORMAT_ROOM,
};

/**
 * What the API answers (409) for a submit, a run or a regrade of a phase its
 * pinned version holds in an older form, the room's own sentence:
 * a retired written phase's, or the structured phase's older-format one.
 * Null for a phase that can be graded.
 */
export function olderFormatRoomSentence(phase: Pick<PhaseContent, 'key' | 'checks'>): string | null {
  if (isRetiredWritten(phase)) return RETIRED_WRITTEN_PHASE_ROOM;
  const key = phase.key as OlderFormatKey;
  return OLDER_FORMAT_PHASES.includes(key) && isOlderFormat(key, phase.checks as ChecksShape) ? ROOM[key] : null;
}

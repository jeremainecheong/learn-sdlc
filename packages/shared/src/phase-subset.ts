/**
 * A project is an ordered subset of LearnSDLC's six phases: at least one, each
 * once, in LearnSDLC's order, numbered 1 to n. A phase's key is its identity;
 * its order is its place in its own project. Every reader that needs "the next
 * phase", "the last phase" or "Phase 2 of 3" asks here, so no site computes
 * `order + 1` or mistakes a key for a place.
 */
import { PHASE_ORDER, type PhaseKey } from './phases';
import { andList } from './requirements-story';

/** A phase as the helpers read it: its key, and its stored order, which they sort by. */
export interface PlacedPhase { key: PhaseKey; order: number }

export const PHASE_TITLES: Readonly<Record<PhaseKey, string>> = Object.freeze({
  requirements: 'Requirements', design: 'Design', implementation: 'Implementation',
  testing: 'Testing', deployment: 'Deployment', maintenance: 'Maintenance',
});

export const ADDABLE_PHASES: readonly PhaseKey[] = Object.freeze(['requirements', 'design'] as PhaseKey[]);

/** A sorted copy of the phases, by stored order; the input is not changed. */
export function phasesInPlace<T extends PlacedPhase>(phases: readonly T[]): T[] {
  return [...phases].sort((a, b) => a.order - b.order);
}
/** The phase at a 1-based place, never a stored order; null past the end. */
export function phaseAt<T extends PlacedPhase>(project: { phases: readonly T[] }, place: number): T | null {
  return phasesInPlace(project.phases)[place - 1] ?? null;
}
/** The phase at place 1; null for an empty list. */
export function firstPhaseOf<T extends PlacedPhase>(project: { phases: readonly T[] }): T | null {
  return phaseAt(project, 1);
}
/** The 1-based place of a key; 0 when absent. */
export function placeOf(project: { phases: readonly PlacedPhase[] }, key: PhaseKey): number {
  return phasesInPlace(project.phases).findIndex((one) => one.key === key) + 1;
}
/** The phase after a key by place; null at the end and for a key the project lacks. */
export function nextPhaseOf<T extends PlacedPhase>(project: { phases: readonly T[] }, key: PhaseKey): T | null {
  const at = placeOf(project, key);
  return at ? phaseAt(project, at + 1) : null;
}
/** The phase before a key by place; null at the start and for a key the project lacks. */
export function previousPhaseOf<T extends PlacedPhase>(project: { phases: readonly T[] }, key: PhaseKey): T | null {
  const at = placeOf(project, key);
  return at > 1 ? phaseAt(project, at - 1) : null;
}
/** Whether a key is at the last place; false when absent. Pass the version's whole phase list, never a filtered one. */
export function isLastPhase(project: { phases: readonly PlacedPhase[] }, key: PhaseKey): boolean {
  const at = placeOf(project, key);
  return at > 0 && at === project.phases.length;
}
/** "Phase 2 of 3" over the version's whole phase list. Call it only for a key the list holds: an absent key reads "Phase 0 of n". */
export function placeLabel(project: { phases: readonly PlacedPhase[] }, key: PhaseKey): string {
  return `Phase ${placeOf(project, key)} of ${project.phases.length}`;
}
/** Whether the project holds a key. */
export function holdsPhase(project: { phases: readonly { key: string }[] }, key: PhaseKey): boolean {
  return project.phases.some((one) => one.key === key);
}
/** The phases' titles as one list: "Requirements, Design and Implementation". */
export function phaseListSentence(keys: readonly PhaseKey[]): string {
  return andList(keys.map((key) => PHASE_TITLES[key]));
}

export type PhaseSetFault = 'empty' | 'unknown' | 'duplicate' | 'unordered' | 'gapped';

/** The subset rule: null when the phases are a project's, else the first fault and its sentence. */
export function phaseSetRefusal(phases: readonly { key: string; order: number }[]): { fault: PhaseSetFault; sentence: string } | null {
  if (phases.length === 0) return { fault: 'empty', sentence: "A project holds at least one of LearnSDLC's six phases." };
  const unknown = phases.find((one) => !PHASE_ORDER.includes(one.key as PhaseKey));
  if (unknown) return { fault: 'unknown', sentence: unknownPhaseRefusal(unknown.key) };
  const seen = new Set<string>();
  for (const one of phases) {
    if (seen.has(one.key)) return { fault: 'duplicate', sentence: `A project holds each phase once, and ${PHASE_TITLES[one.key as PhaseKey]} is there twice.` };
    seen.add(one.key);
  }
  const placed = [...phases].sort((a, b) => a.order - b.order);
  for (let at = 1; at < placed.length; at += 1) {
    const before = PHASE_ORDER.indexOf(placed[at - 1].key as PhaseKey);
    const here = PHASE_ORDER.indexOf(placed[at].key as PhaseKey);
    if (here < before) {
      return { fault: 'unordered', sentence: `A project keeps LearnSDLC's order, and ${PHASE_TITLES[placed[at].key as PhaseKey]} comes before ${PHASE_TITLES[placed[at - 1].key as PhaseKey]}.` };
    }
  }
  const orders = placed.map((one) => one.order);
  if (orders.some((order, at) => order !== at + 1)) {
    return { fault: 'gapped', sentence: `A project's phases are numbered 1 to ${placed.length} in order, and these are numbered ${andList(orders.map(String))}.` };
  }
  return null;
}

export const PHASE_COMPLETION_REFUSAL = 'Every phase of this project must be passed before its record can be exported.';
export const NO_PHASE_TO_PUBLISH = 'This draft holds no phase. Put a phase back or add one before you publish.';
export const PUBLISHED_PHASES_FIXED = 'A published version does not change. Open a draft to change its phases.';

/** "an implementation folder", "a testing folder": the folder an upload adds a phase with. */
const phaseFolder = (key: PhaseKey) => `${/^[aeiou]/.test(key) ? 'an' : 'a'} ${key} folder`;

export const keepOnePhaseRefusal = (key: PhaseKey) => `A project keeps at least one phase. Put another phase back before you remove ${PHASE_TITLES[key]}.`;
/**
 * Why a phase cannot be put back. The caller says whether the draft was opened
 * from a version (`hasSource`); Requirements and Design point to Add, the other
 * four to an upload.
 */
export function cannotPutBackRefusal(key: PhaseKey, { hasSource }: { hasSource: boolean }): string {
  const title = PHASE_TITLES[key];
  const addable = ADDABLE_PHASES.includes(key);
  if (!hasSource) {
    const door = addable ? 'Add it from the Phases card.' : `Upload a project that holds ${phaseFolder(key)}.`;
    return `This draft was not opened from a version, so ${title} cannot be put back. ${door}`;
  }
  return addable
    ? `${title} is not in this draft. Add it from the Phases card.`
    : `${title} cannot be put back: the version this draft was opened from does not hold it. Upload the project again with ${phaseFolder(key)} to add it.`;
}
export const addByUploadRefusal = (key: PhaseKey) =>
  `${PHASE_TITLES[key]} comes with its files, tests and solution, so it is added by upload. Upload the project again with ${phaseFolder(key)} to add it.`;
export const alreadyHeldRefusal = (key: PhaseKey) => `${PHASE_TITLES[key]} is already in this project.`;
/** Echoes the key as given, unclipped: a caller passing a raw route parameter clips it to 64 code units first. */
export const unknownPhaseRefusal = (key: string) =>
  `${key} is not one of LearnSDLC's phases. A phase is one of requirements, design, implementation, testing, deployment or maintenance.`;

export type RemoveSource = 'held' | 'no-source' | 'not-held';
export function removeConfirm(key: PhaseKey, source: RemoveSource): string {
  const title = PHASE_TITLES[key];
  const head = `Remove ${title} from this project? Its task, its files, its sealed files and its quizzes leave this draft.`;
  if (source === 'held') return `${head} Published versions keep it.`;
  const back = ADDABLE_PHASES.includes(key) ? `${title} comes back only as an empty phase, through Add.` : `${title} comes back only by uploading the project again.`;
  return source === 'no-source'
    ? `${head} This draft was not opened from a version, so ${back}`
    : `${head} The version this draft was opened from does not hold ${title}, so ${back}`;
}

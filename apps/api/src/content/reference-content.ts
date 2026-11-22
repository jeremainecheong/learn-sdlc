import { CHANGE_REQUEST_JSON, RUNBOOK_JSON } from '@learnsdlc/shared';
import { digestOf, sha256Hex } from './blob.store';
import type { InterviewBrief, PhaseContent } from './content.types';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH } from './screen-copy';
import { REFERENCE_SCENARIOS, type ReferenceScenarioRow } from './reference-scenarios';

/**
 * Which **written scenario** is still the reference project's, once a copy
 * becomes the teacher's own.
 *
 * The task anchor (`assistant/project-scope.ts` `referenceAnchor`) hashes what
 * grades a task: its brief, objectives, rubric, check slice and owned
 * baselines. It does not hash what the phase tells the model *about the
 * world* (the stakeholder interview, the read-only documents the phase mounts
 * (the provided backlog, the architecture document)) nor the phase's intro.
 * Once a teacher can write those, a copy whose interview or backlog is theirs
 * but whose inherited task is untouched would still get the reference
 * reviewer, fed the teacher's facts or stories under the reference project's
 * wording. The **scenario digest** closes that: a phase is the reference
 * project's only when its task anchor **and** its scenario digest are recorded.
 *
 * **The intro joins the scenario.** An
 * intro is not model input, but "any teacher edit to a written element gives
 * the neutral reviewer" is then one predicate the web's provenance switch and
 * the AI scope share. It moves no reference byte, and a copy whose intro is
 * untouched keeps the reference reviewer.
 *
 * Every digest here is a function of bytes, never of an object or a key, so a
 * teacher who writes the reference's own bytes back (re-saves the interview
 * they copied, restores the original backlog) is the reference's again.
 *
 * This module imports only the blob store, the screen-copy paths and its
 * generated table; the recorder lives under `apps/api/test/` and never ships.
 */

/* --------------------------------- digests -------------------------------- */

/** One read-only file of a phase, as the scenario digest sees it: its path and the sha of its bytes. */
function readOnlyFiles(phase: PhaseContent): [string, string][] {
  return (phase.files ?? [])
    .filter((file) => !file.editable)
    .map((file): [string, string] => [file.path, sha256Hex(file.content)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const scenarioMemo = new WeakMap<PhaseContent, string>();

/**
 * sha256 over the canonical JSON of a phase's written scenario: its key, its
 * intro, its interview (or null) and every read-only file it mounts, by path
 * and by the sha of its bytes. Memoised by the phase object, which the
 * registry keeps stable per published version.
 */
export function scenarioDigest(phase: PhaseContent): string {
  const held = scenarioMemo.get(phase);
  if (held !== undefined) return held;
  const digest = digestOf({
    phaseKey: phase.key,
    intro: phase.intro ?? null,
    interview: phase.interview ?? null,
    readOnly: readOnlyFiles(phase),
  });
  scenarioMemo.set(phase, digest);
  return digest;
}

/** The digest of one interview brief: sha256 of its canonical JSON (the sealed row's own sha). */
export function interviewDigest(brief: InterviewBrief): string {
  return digestOf(brief);
}

/** The digest of one intro. */
export function introDigest(intro: string | null | undefined): string {
  return digestOf({ intro: intro ?? null });
}

/**
 * The files `withScreenCopy` may rewrite on a learner's own copy of a phase:
 * the accepted screen copy, and a read-only screen contract beside it. An
 * application digest leaves them out, so it is the same before and after a
 * learner's Design copy is laid over the phase: even though the
 * resolver is only ever asked of the pinned base.
 */
function overlaidByScreenCopy(file: { path: string; editable: boolean }): boolean {
  return file.path === SCREEN_COPY_PATH || (file.path === SCREEN_CONTRACT_PATH && !file.editable);
}

const applicationMemo = new WeakMap<PhaseContent, string>();

/**
 * One digest per executable phase over its workspace files (path, editability
 * and the sha of the bytes, sorted by path) the screen-copy overlay's two
 * files excluded, and the runbook and the change request with them: the
 * records are the teacher's to edit without a deep run.
 */
export function applicationDigest(phase: PhaseContent): string {
  const held = applicationMemo.get(phase);
  if (held !== undefined) return held;
  const files = (phase.files ?? [])
    .filter((file) => !overlaidByScreenCopy(file) && file.path !== RUNBOOK_JSON && file.path !== CHANGE_REQUEST_JSON)
    .map((file): [string, boolean, string] => [file.path, file.editable, sha256Hex(file.content)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const digest = digestOf({ phaseKey: phase.key, files });
  applicationMemo.set(phase, digest);
  return digest;
}

/** The per-element digests provenance reads (design section 3.8). */
export interface ElementDigests {
  intro: string;
  interview: string | null;
  /** Each read-only file, by path. */
  files: Record<string, string>;
}

export function elementDigests(phase: PhaseContent): ElementDigests {
  return {
    intro: introDigest(phase.intro),
    interview: phase.interview ? interviewDigest(phase.interview) : null,
    files: Object.fromEntries(readOnlyFiles(phase)),
  };
}

/* ------------------------------ the questions ----------------------------- */

const rowIndex = new Set(REFERENCE_SCENARIOS.map((row) => keyOf(row.grain, row.phaseKey, row.key, row.digest)));

function keyOf(grain: ReferenceScenarioRow['grain'], phaseKey: string, key: string, digest: string): string {
  return `${grain}|${phaseKey}|${key}|${digest}`;
}

/** Whether this digest is recorded for this phase, grain and key, in any version of the reference pack. */
export function isRecorded(grain: ReferenceScenarioRow['grain'], phaseKey: string, key: string, digest: string): boolean {
  return rowIndex.has(keyOf(grain, phaseKey, key, digest));
}

/** Whether a phase's whole written scenario is the reference project's. Never throws: unreadable is not reference. */
export function isReferenceScenario(phase: PhaseContent): boolean {
  try {
    return isRecorded('scenario', phase.key, '', scenarioDigest(phase));
  } catch {
    return false;
  }
}

/** Whether an interview brief is the reference project's, byte for byte. */
export function isReferenceInterview(brief: InterviewBrief | null | undefined): boolean {
  if (!brief) return false;
  try {
    return rowIndex.has(keyOf('interview', 'requirements', '', interviewDigest(brief)));
  } catch {
    return false;
  }
}

/** Whether a phase's intro is the reference project's for that phase. */
export function isReferenceIntro(phaseKey: string, intro: string | null | undefined): boolean {
  return isRecorded('intro', phaseKey, '', introDigest(intro));
}

/** Whether one read-only file's bytes are the reference project's at that path in that phase. */
export function isReferenceFile(phaseKey: string, path: string, content: string): boolean {
  return isRecorded('file', phaseKey, path, sha256Hex(content));
}

/** Whether an executable phase's files are the reference project's application. */
export function isReferenceApplication(phase: PhaseContent): boolean {
  try {
    return isRecorded('application', phase.key, '', applicationDigest(phase));
  } catch {
    return false;
  }
}

/** The packs the table records, so a caller can name the reference project from its registry title. */
export function referencePacks(): string[] {
  return [...new Set(REFERENCE_SCENARIOS.map((row) => row.pack))];
}

/**
 * A project's name as a person reads it: its title before the em dash.
 * "<Name> — <what it is>" reads "<Name>"; a title with no em dash is the name.
 * Never a slug, and never a literal in a client.
 */
export function referenceNameOf(title: string | null | undefined): string {
  const name = (title ?? '').split(' \u2014 ')[0].trim();
  return name.length > 0 ? name : 'the reference project';
}

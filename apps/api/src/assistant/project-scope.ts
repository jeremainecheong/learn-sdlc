import { fencedLine } from './fence-markers';
import { PHASE_ROOM_ARTEFACT_PATHS, andList, plainTextOf } from '@learnsdlc/shared';
import { designRoomTabs } from './design-review-scope';
import { digestOf, sha256Hex } from '../content/blob.store';
import type { PhaseChecks, PhaseContent } from '../content/content.types';
import { STORY_RECORD_PATH, checksOf, isQuizTask, soleTaskFor, type CompiledTask } from '../content/pack-compiler';
import { isReferenceApplication, isReferenceScenario } from '../content/reference-content';
import { referencePackOnDisk } from '../content/reference-pack-disk';
import { SCREEN_CONTRACT_PATH, SCREEN_COPY_PATH } from '../content/screen-copy';
import { REFERENCE_ANCHORS } from './reference-anchors';
import { REFERENCE_EXEC_ANCHORS } from './reference-exec-anchors';

/**
 * Whose content a model request is about.
 *
 * **The rule: every TaskTrackr fragment belongs to TaskTrackr's task content,
 * identified by its bytes. Any other task gets a project-neutral reviewer and
 * mentor framed only by its own brief, objectives, rules and rubric.**
 *
 * A teacher project is a fork of TaskTrackr, and a fork keeps each phase's
 * mentor prompt, interview, objectives and files. A task key cannot tell the
 * inherited task from a teacher's (both are authored keys), and lineage would
 * keep TaskTrackr's rules on an inherited brief a teacher rewrote. So the
 * resolver hashes what a task *is*, `referenceAnchor`, and looks the digest
 * up in the committed `REFERENCE_ANCHORS` table, which a CLI records from the
 * shipped pack (`apps/api/test/cli/reference-anchors.ts`).
 *
 * Three answers, and each is safe:
 * - an **executable** phase (`code`, `tests`, `config`) is `reference` only
 *   when its workspace is the reference application's
 *   (`isReferenceApplication`), it holds exactly one work task, and that
 *   task's `exec` anchor is recorded in `REFERENCE_EXEC_ANCHORS` (an upload is
 *   a whole application of the teacher's own, so an executable phase is never
 *   `reference` without an anchor);
 * - a **written** phase or task whose bytes are in the table is `reference`,
 *   and gets the reference prompts byte for byte;
 * - **everything else**, a teacher's task, an edited inherited task, a mixed
 *   phase, a phase with no checks, anything the resolver cannot read, is
 *   `authored`. The resolver never throws: a caller that passes nothing, or a
 *   phase it cannot read, fails safe to the neutral prompts, never to
 *   TaskTrackr's.
 *
 * Scopes are **minted only here**. `REFERENCE_SCOPE` and the two `authored…`
 * constructors are the only way to make one; the composers accept a scope only
 * if this module minted it (`isMintedScope`) and otherwise resolve their own.
 */

/** The three kinds that grade by running something. Reference only by their `exec` anchor. */
const EXECUTABLE_KINDS: ReadonlySet<string> = new Set(['code', 'tests', 'config']);

declare const SCOPE_BRAND: unique symbol;

/** TaskTrackr's own content: every composer takes the reference code path, byte for byte. */
export interface ReferenceScope {
  readonly kind: 'reference';
  readonly [SCOPE_BRAND]: true;
}

/** One task that is not TaskTrackr's, as the reviewer sees it. */
export interface AuthoredTaskScope {
  readonly kind: 'authored';
  readonly grain: 'task';
  /** The task under review, or null when the resolver could not read one. */
  readonly task: CompiledTask | null;
  /** The web routes this task to its phase's own room, not to the editor. */
  readonly roomTask: boolean;
  /** It owns the requirements record the consistency check reads. */
  readonly ownsRecord: boolean;
  readonly [SCOPE_BRAND]: true;
}

/** A phase that is not wholly TaskTrackr's, as the mentor and the Agentic calls see it. */
export interface AuthoredPhaseScope {
  readonly kind: 'authored';
  readonly grain: 'phase';
  /** The phase's non-quiz tasks, in order. Empty when the resolver could not read them. */
  readonly tasks: readonly CompiledTask[];
  /** The task the web routes to the phase's room, or null. */
  readonly roomTaskKey: string | null;
  /** The optional lesson conversation, which adds its one sentence to the frame. */
  readonly lesson: boolean;
  readonly [SCOPE_BRAND]: true;
}

export type TaskScope = ReferenceScope | AuthoredTaskScope;
export type PhaseScope = ReferenceScope | AuthoredPhaseScope;

const minted = new WeakSet<object>();

function mint<T extends object>(value: T): T {
  Object.freeze(value);
  minted.add(value);
  return value;
}

/** Whether this module made `value`. A look-alike object is not a scope. */
export function isMintedScope(value: unknown): value is TaskScope | PhaseScope {
  return typeof value === 'object' && value !== null && minted.has(value);
}

/** The one reference scope. Specs that pin TaskTrackr wording on synthetic phases pass it on purpose. */
export const REFERENCE_SCOPE: ReferenceScope = mint({ kind: 'reference' } as unknown as ReferenceScope);

/** An authored scope for one task. `phaseTasks` decides which task the room belongs to. */
export function authoredTaskScope(
  phase: PhaseContent,
  task: CompiledTask | null,
  phaseTasks: readonly CompiledTask[],
): AuthoredTaskScope {
  let roomTask = false;
  let ownsRecord = false;
  try {
    if (task) {
      const list = phaseTasks.length ? phaseTasks : [task];
      roomTask = phaseRoomTaskKeyOf(phase?.key, list) === task.taskKey;
      ownsRecord = Array.isArray(task.owns) && task.owns.includes(STORY_RECORD_PATH);
    }
  } catch {
    roomTask = false;
    ownsRecord = false;
  }
  return mint({ kind: 'authored', grain: 'task', task, roomTask, ownsRecord } as unknown as AuthoredTaskScope);
}

/** An authored scope for a phase: its non-quiz tasks in order, and the room task among them. */
export function authoredPhaseScope(
  phase: PhaseContent,
  tasks: readonly CompiledTask[],
  options: { lesson?: boolean } = {},
): AuthoredPhaseScope {
  let work: CompiledTask[] = [];
  let roomTaskKey: string | null = null;
  try {
    work = [...tasks].filter((task) => !isQuizTask(task)).sort((a, b) => a.order - b.order);
    roomTaskKey = phaseRoomTaskKeyOf(phase?.key, work);
  } catch {
    work = [];
    roomTaskKey = null;
  }
  return mint({ kind: 'authored', grain: 'phase', tasks: work, roomTaskKey, lesson: options.lesson === true } as unknown as AuthoredPhaseScope);
}

/* -------------------------------- the rooms ------------------------------- */

/**
 * The task the web routes to a phase's own room, the same rule as
 * `phaseRoomTaskKey` in the web's `components/workspace/task-model.ts`.
 *
 * The declarer is asked first across the whole list, and ownership only
 * answers a path nobody declares, in the teacher's order. The paths are
 * `PHASE_ROOM_ARTEFACT_PATHS`, the list the web's `PHASE_ROOM_ARTEFACT` is held
 * equal to.
 */
export function phaseRoomTaskKeyOf(phaseKey: string | undefined, tasks: readonly CompiledTask[] | undefined): string | null {
  const path = phaseKey ? (PHASE_ROOM_ARTEFACT_PATHS as Record<string, string | undefined>)[phaseKey] : undefined;
  if (!path || !tasks?.length) return null;
  const list = [...tasks].sort((a, b) => a.order - b.order);
  const found = list.find((task) => task.artefactPath === path) ?? list.find((task) => task.owns?.includes(path));
  return found ? found.taskKey : null;
}

/**
 * The topics the Requirements and Design mentors stay on, from the "stay on … topics"
 * clauses of TaskTrackr's own Requirements and Design prompts. The
 * application phases have their own list, `EXECUTABLE_PHASE_TOPICS`.
 */
export const PHASE_TOPICS: Readonly<Record<'requirements' | 'design', string>> = {
  requirements: 'user stories, acceptance criteria, scope, edge cases',
  design: 'data modelling, contracts, cohesion, trade-offs, traceability',
};

/**
 * The topics each application phase's neutral mentor stays on.
 * Written about the work of the phase, never about a project: an uploaded
 * application's mentor frame names them where TaskTrackr's prompt named its
 * own change request and bundle.
 */
export const EXECUTABLE_PHASE_TOPICS: Readonly<Record<'implementation' | 'testing' | 'deployment' | 'maintenance', string>> = {
  implementation: "the brief's rules, the editable source files, the visible tests, reading one failing case at a time",
  testing: 'test design, assertions, edge cases, mapping requirements to tests, why a planted bug survives a suite',
  deployment: 'image definitions, entry points, configuration, the selfcheck, runbooks, diagnosing a faulted configuration',
  maintenance: 'reading the change request, its impact on existing behaviour, regression tests, contracts, the change request record',
};

/**
 * One line per task of an authored phase: where the learner works it. The
 * phase's room task is told its room's controls; every other task is told the
 * workspace editor, on its own file, which is where the web opens a task of a
 * phase with no record room. The Guided output reviewer grounds advice in
 * these lines, so telling a learner to edit their file in the editor is
 * grounded advice for the tasks worked there.
 */
export function authoredInterfaceLines(phaseKey: string | undefined, tasks: readonly CompiledTask[], checks?: PhaseChecks): string[] {
  if (!tasks.length) return ["- This phase's work is done in the workspace editor; Submit for review requests the assessment."];
  const room = phaseRoomTaskKeyOf(phaseKey, tasks);
  return tasks.map((task) => {
    // A teacher's title sits outside the fence here, so
    // it carries no fence marker, no line break, and no more than the 160
    // characters the task DTO allows.
    const title = JSON.stringify(fencedLine(task.title ?? '', 160));
    if (room !== null && task.taskKey === room) {
      if (phaseKey === 'requirements') {
        return `- ${title} is worked in the phase's story desk (My backlog): the learner opens the story in Edit story, fills its As a / I want / So that and Given / When / Then fields, and chooses Save story; the application keeps the saved evidence files in step. It has no code editor, raw file editor or Run control; Submit for review requests the assessment.`;
      }
      if (phaseKey === 'design') {
        // A structured Design names the tabs its switches turn on; the markdown board's line stays as recorded.
        const tabs = checks?.kind === 'design' ? andList(designRoomTabs(checks)) : 'UML model, API contracts, Sequence diagram, Decisions and Review';
        return `- ${title} is worked on the phase's design board: its ${tabs} tabs, each saved from the board. It has no code editor or Run action; Submit for review requests the assessment.`;
      }
      if (phaseKey === 'deployment') {
        return `- ${title} is worked in two places: its files in the workspace editor, its runbook in the Runbook tab's forms. Submit for review requests the assessment.`;
      }
      if (phaseKey === 'maintenance') {
        return `- ${title} is worked in two places: its code in the workspace editor, its change request in the change room's tabs. Submit for review requests the assessment.`;
      }
      return `- ${title} is worked in the phase's own room; Submit for review requests the assessment.`;
    }
    const path = task.artefactPath ?? task.owns?.[0] ?? 'its own file';
    return `- ${title} is worked in the workspace editor on ${path}: the learner edits and saves that file there, and Submit for review requests the assessment.`;
  });
}

/* -------------------------------- the anchor ------------------------------ */

/**
 * sha256 over the canonical JSON of what grades a task: the phase key, the
 * task's brief, objectives and rubric, its check slice (the kind, plus the
 * record, stories and floor of a story slice; the record, switches, stories
 * and floor of a design slice), the paths it owns
 * (sorted), and the sha256 of each owned path's baseline bytes.
 */
export function referenceAnchor(phase: PhaseContent, task: CompiledTask): string {
  const checks = checksOf(phase, task);
  const slice = checks.kind === 'story'
    ? { kind: checks.kind, record: checks.record, providedStories: checks.providedStories, learnerStory: checks.learnerStory, floor: checks.floor }
    : checks.kind === 'design'
      ? { kind: checks.kind, record: checks.record, contracts: checks.contracts, sequence: checks.sequence, stories: checks.stories, floor: checks.floor }
      : { kind: checks.kind };
  const owns = [...task.owns].sort();
  const baselines = owns.map((path) => {
    const file = phase.files.find((one) => one.path === path);
    return [path, file ? sha256Hex(file.content) : null];
  });
  return digestOf({ phaseKey: phase.key, brief: task.brief, objectives: task.objectives, rubric: task.rubric, checks: slice, owns, baselines });
}

/** The phase-grain anchor: the task's anchor and the phase's mentor prompt block. */
export function phaseReferenceAnchor(phase: PhaseContent, task: CompiledTask): string {
  return digestOf({ task: referenceAnchor(phase, task), assistant: digestOf(phase.assistant) });
}

/*
 * The `exec` anchor of an executable phase's work task.
 *
 * The files a learner's accepted Design screen copy overlays (`withScreenCopy`)
 * are left out exactly where that overlay writes them, so a TaskTrackr
 * learner whose Design copy is laid over the phase is still on TaskTrackr's
 * prompts, as `applicationDigest` leaves them out of the workspace. That is
 * the copy's path, and the screen contract's when the phase serves it locked,
 * of a phase that serves the copy locked, and only in the read-only
 * application maps the overlay rewrites. A sealed map it never touches (a
 * mutant, a reference suite, the drill) keeps those paths in the anchor.
 */
const OVERLAID_MAPS: Readonly<Record<string, { flat: readonly string[]; runs: readonly string[] }>> = {
  code: { flat: [], runs: ['supportFiles', 'implFiles'] },
  tests: { flat: ['supportFiles', 'implFiles'], runs: ['supportFiles', 'implFiles'] },
  config: { flat: ['smokeImplFiles'], runs: [] },
};

function overlaidPathsOf(phase: PhaseContent): string[] {
  const files = Array.isArray(phase?.files) ? phase.files : [];
  const locked = (path: string) => files.some((file) => file?.path === path && !file.editable);
  if (!locked(SCREEN_COPY_PATH)) return [];
  return locked(SCREEN_CONTRACT_PATH) ? [SCREEN_COPY_PATH, SCREEN_CONTRACT_PATH] : [SCREEN_COPY_PATH];
}

/** `checks` with the overlaid paths taken out of the maps the overlay rewrites. Shallow: everything else is shared. */
function withoutOverlay(checks: PhaseChecks, overlaid: readonly string[]): PhaseChecks {
  const maps = OVERLAID_MAPS[checks.kind];
  if (!overlaid.length || !maps) return checks;
  const strip = (node: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const out = { ...node };
    for (const key of keys) {
      const map = out[key];
      if (map && typeof map === 'object' && !Array.isArray(map)) {
        out[key] = Object.fromEntries(Object.entries(map as Record<string, unknown>).filter(([path]) => !overlaid.includes(path)));
      }
    }
    return out;
  };
  const out = strip(checks as unknown as Record<string, unknown>, maps.flat);
  if (maps.runs.length && Array.isArray(out.runs)) {
    out.runs = out.runs.map((run: unknown) => (run && typeof run === 'object' ? strip(run as Record<string, unknown>, maps.runs) : run));
  }
  return out as unknown as PhaseChecks;
}

/**
 * sha256 over the canonical JSON of what an executable task is: the phase key
 * and kind, the task's brief, objectives and rubric, the paths it owns (sorted)
 * with the sha256 of each owned baseline, the digests of the phase's runs, its
 * mutants, its hidden tests and its reference answer (the solution files and
 * the normalised sources), the whole check slice, the rules, the smoke and
 * the drill, and the phase's mentor block. A teacher who changes any one of
 * those has a task of their own, and gets the neutral prompts.
 */
export function executableReferenceAnchor(phase: PhaseContent, task: CompiledTask): string {
  const checks = checksOf(phase, task);
  const owns = [...task.owns].sort();
  const baselines = owns.map((path) => {
    const file = phase.files.find((one) => one.path === path);
    return [path, file ? sha256Hex(file.content) : null];
  });
  return digestOf({
    grain: 'exec',
    phaseKey: phase.key,
    kind: checks.kind,
    brief: task.brief,
    objectives: task.objectives,
    rubric: task.rubric,
    owns,
    baselines,
    ...sealedDigestsOf(checks, overlaidPathsOf(phase)),
    assistant: digestOf(phase.assistant),
  });
}

type SealedDigests = Readonly<Record<'runs' | 'mutants' | 'hiddenTests' | 'solution' | 'checks', string>>;
const sealedDigestMemo = new WeakMap<object, Map<string, SealedDigests>>();

/**
 * The anchor's digests of the grader's bytes, once per check object and
 * overlay: a sole task is compiled afresh on many reads, but the phase's
 * checks, a few hundred kilobytes for the shipped pack, are one object per
 * served version. The overlay is taken out once, shallowly, and every digest
 * reads that one copy.
 */
function sealedDigestsOf(checks: PhaseChecks, overlaid: readonly string[]): SealedDigests {
  const key = overlaid.join('\n');
  let byOverlay = sealedDigestMemo.get(checks);
  const held = byOverlay?.get(key);
  if (held) return held;
  const bare = withoutOverlay(checks, overlaid);
  const digests = {
    runs: digestOf(bare.kind === 'code' || bare.kind === 'tests' ? bare.runs : []),
    mutants: digestOf(bare.kind === 'tests' ? bare.mutants : []),
    hiddenTests: digestOf(bare.kind === 'code' ? bare.hiddenTestFiles : {}),
    solution: digestOf(bare.kind === 'code' ? { files: bare.solutionFiles, sources: bare.solutionSources } : {}),
    checks: digestOf(bare),
  };
  if (!byOverlay) {
    byOverlay = new Map();
    sealedDigestMemo.set(checks, byOverlay);
  }
  byOverlay.set(key, digests);
  return digests;
}

const anchorIndex = new Map(REFERENCE_ANCHORS.map((row) => [`${row.grain}|${row.phaseKey}|${row.anchor}`, row]));
const execIndex = new Set(REFERENCE_EXEC_ANCHORS.map((row) => `${row.phaseKey}|${row.anchor}`));

/* ------------------------- the plain-text twins ------------------------- */

/*
 * A reference task whose brief and objectives became plain text (a converted
 * draft; a row written as `plainTextOf` of the reference's words) is
 * still the reference's, here as in publish's and provenance's key
 * (`referenceExecutableKeys`, provenance.ts): the same twin, over the same two
 * members, so a converted TaskTrackr copy reads `reference` to the mentor, the
 * reviewer, the Agentic calls, deep validation and publish alike.
 *
 * A twin is the anchor a recorded reference phase's sole task has with its
 * brief and objectives through `plainTextOf`, every other byte unchanged. It
 * is taken only from a phase whose own anchor is in the committed tables, so
 * the twin of anything but the reference's bytes is never added, and the
 * tables, their recorder and its `--check` never see a twin. The phases come
 * from the reference pack on this disk (read once, lazily) and from every
 * published reference version the authoring service reads
 * (`rememberReferencePlainAnchors`), as provenance's keys do. A teacher's own
 * words match no twin: the only text whose plain form equals the reference's
 * plain words is the reference's (`plainTextOf` keeps every word, in order).
 */
const plainTwins = new Set<string>();
const twinsTaken = new WeakSet<PhaseContent>();
let twinsFromDisk = false;

/** The task with its brief and objectives as `plainTextOf` makes them, every other member the same. */
function withPlainWords(task: CompiledTask): CompiledTask {
  return { ...task, brief: plainTextOf(task.brief ?? ''), objectives: (task.objectives ?? []).map(plainTextOf) };
}

/** Add the plain-text twins of every phase here whose own anchors are recorded. Total: a phase it cannot read adds none. */
export function rememberReferencePlainAnchors(phases: readonly PhaseContent[]): void {
  for (const phase of phases) {
    if (!phase || typeof phase !== 'object' || twinsTaken.has(phase)) continue;
    twinsTaken.add(phase);
    try {
      const kind = kindOf(phase);
      const task = soleTaskFor(phase);
      const plain = withPlainWords(task);
      if (kind && EXECUTABLE_KINDS.has(kind)) {
        if (execIndex.has(`${phase.key}|${executableReferenceAnchor(phase, task)}`)) plainTwins.add(`exec|${phase.key}|${executableReferenceAnchor(phase, plain)}`);
        continue;
      }
      if (anchorIndex.has(`task|${phase.key}|${referenceAnchor(phase, task)}`)) plainTwins.add(`task|${phase.key}|${referenceAnchor(phase, plain)}`);
      if (anchorIndex.has(`phase|${phase.key}|${phaseReferenceAnchor(phase, task)}`)) plainTwins.add(`phase|${phase.key}|${phaseReferenceAnchor(phase, plain)}`);
    } catch {
      // unreadable: no twin
    }
  }
}

/** Whether an anchor is the reference's: recorded in the committed tables, or the plain-text twin of one that is. */
function isRecordedAnchor(grain: 'task' | 'phase' | 'exec', phaseKey: string, anchor: string): boolean {
  if (grain === 'exec' ? execIndex.has(`${phaseKey}|${anchor}`) : anchorIndex.has(`${grain}|${phaseKey}|${anchor}`)) return true;
  if (!twinsFromDisk) {
    const disk = referencePackOnDisk();
    if (disk) {
      if (disk.project) rememberReferencePlainAnchors(disk.project.phases);
      twinsFromDisk = true;
    }
  }
  return plainTwins.has(`${grain}|${phaseKey}|${anchor}`);
}

/*
 * The anchors are memoised (a sole task is compiled afresh on many reads, but
 * its phase is one object per served version); whether one is recorded is
 * asked afresh each time, because the twins can grow after the first answer.
 */
type AnchorMemo = WeakMap<PhaseContent, WeakMap<CompiledTask, string>>;
const taskAnchorMemo: AnchorMemo = new WeakMap();
const phaseAnchorMemo: AnchorMemo = new WeakMap();
const execAnchorMemo: AnchorMemo = new WeakMap();

function anchorOnce(memo: AnchorMemo, phase: PhaseContent, task: CompiledTask, compute: () => string): string {
  let inner = memo.get(phase);
  if (!inner) {
    inner = new WeakMap();
    memo.set(phase, inner);
  }
  const held = inner.get(task);
  if (held !== undefined) return held;
  const anchor = compute();
  inner.set(task, anchor);
  return anchor;
}

const taskAnchorOf = (phase: PhaseContent, task: CompiledTask): string => anchorOnce(taskAnchorMemo, phase, task, () => referenceAnchor(phase, task));

/**
 * A written task or phase is the reference's only when its anchor **and**
 * its phase's scenario digest are recorded. The
 * anchor covers what grades the task; the scenario covers what the phase
 * tells the model about the world, the interview, the read-only documents,
 * and the intro. TaskTrackr and an untouched copy satisfy both, so they keep
 * the reference requests; a copy whose interview, backlog, architecture
 * document or intro is the teacher's gets the neutral prompts. The scenario
 * check needs no change to `reference-anchors.ts`.
 */
function isReferenceTask(phase: PhaseContent, task: CompiledTask): boolean {
  return isRecordedAnchor('task', phase.key, taskAnchorOf(phase, task)) && isReferenceScenario(phase);
}

function isReferencePhase(phase: PhaseContent, task: CompiledTask): boolean {
  return isRecordedAnchor('phase', phase.key, anchorOnce(phaseAnchorMemo, phase, task, () => phaseReferenceAnchor(phase, task))) && isReferenceScenario(phase);
}

/**
 * An executable phase's one work task is the reference's only when the
 * phase's workspace is the reference application
 * (`isReferenceApplication`) **and** the task's
 * `exec` anchor is recorded. Total: anything it cannot read is not the
 * reference's.
 */
function isReferenceExecutable(phase: PhaseContent, task: CompiledTask): boolean {
  try {
    return isReferenceApplication(phase) && isRecordedAnchor('exec', phase.key, anchorOnce(execAnchorMemo, phase, task, () => executableReferenceAnchor(phase, task)));
  } catch {
    return false;
  }
}


/**
 * Whether one written task is the reference's **by its own anchor alone**,
 * whatever its phase's scenario. Pure and total: anything it cannot
 * read is not the reference's.
 *
 * The one reader is the screen-copy rule (`workflow/accepted-screen-copy.ts`):
 * a Design task that still grades the reference's screen contract keeps
 * the reference's throw at the Design → Implementation advance even when the teacher
 * rewrote the backlog beside it, because its learner still writes that
 * contract. It is never a scope, scopes are `taskScopeOf`'s and
 * `phaseScopeOf`'s alone.
 */
export function isReferenceTaskAnchor(phase: PhaseContent, task: CompiledTask): boolean {
  try {
    const kind = kindOf(phase);
    if ((kind !== 'story' && kind !== 'design') || !task) return false;
    return isRecordedAnchor('task', phase.key, taskAnchorOf(phase, task));
  } catch {
    return false;
  }
}

const kindOf = (phase: PhaseContent | undefined): string | undefined =>
  phase && typeof phase === 'object' && phase.checks && typeof phase.checks === 'object' ? phase.checks.kind : undefined;

/* ------------------------------- the resolvers ---------------------------- */

/**
 * The reviewer's scope for one task. `task` defaults to the phase's sole task
 * and `phaseTasks` to `[task]`, so a caller that passes nothing gets
 * TaskTrackr's reviewer only when the content really is TaskTrackr's.
 */
export function taskScopeOf(phase: PhaseContent, task?: CompiledTask, phaseTasks?: readonly CompiledTask[]): TaskScope {
  try {
    const kind = kindOf(phase);
    const subject = task ?? soleTaskFor(phase);
    const tasks = phaseTasks?.length ? phaseTasks : [subject];
    if (kind && EXECUTABLE_KINDS.has(kind)) {
      // The one work task of a phase that is TaskTrackr's application, by its bytes.
      const work = tasks.filter((one) => !isQuizTask(one));
      if (work.length === 1 && work[0].taskKey === subject.taskKey && !isQuizTask(subject) && isReferenceExecutable(phase, subject)) return REFERENCE_SCOPE;
      return authoredTaskScope(phase, subject, tasks);
    }
    // A structured Design is never TaskTrackr's reviewer: the neutral scope reads the teacher's stories and floor.
    if (kind === 'design') return authoredTaskScope(phase, subject, tasks);
    if (kind === 'story' && isReferenceTask(phase, subject)) return REFERENCE_SCOPE;
    return authoredTaskScope(phase, subject, tasks);
  } catch {
    return authoredTaskScope(phase, task ?? null, phaseTasks ?? []);
  }
}

/**
 * The mentor's and the Agentic calls' scope for a phase. `reference` only when
 * the phase holds exactly one non-quiz task, that task is TaskTrackr's, and
 * the phase's mentor prompt is TaskTrackr's too. A quiz beside the inherited
 * task changes nothing; a teacher's task beside it makes the phase authored.
 */
export function phaseScopeOf(phase: PhaseContent, phaseTasks?: readonly CompiledTask[], options: { lesson?: boolean } = {}): PhaseScope {
  try {
    const kind = kindOf(phase);
    const tasks = phaseTasks?.length ? [...phaseTasks] : [soleTaskFor(phase)];
    const work = tasks.filter((task) => !isQuizTask(task));
    // The exec anchor carries the mentor block, so it is the phase grain's too.
    if (kind && EXECUTABLE_KINDS.has(kind)) {
      return work.length === 1 && isReferenceExecutable(phase, work[0]) ? REFERENCE_SCOPE : authoredPhaseScope(phase, tasks, options);
    }
    // The mentor and the Agentic calls of a structured Design take the neutral prompts, TaskTrackr's included.
    if (kind === 'design') return authoredPhaseScope(phase, tasks, options);
    if (kind === 'story' && work.length === 1 && isReferencePhase(phase, work[0])) return REFERENCE_SCOPE;
    return authoredPhaseScope(phase, tasks, options);
  } catch {
    return authoredPhaseScope(phase, phaseTasks ?? [], options);
  }
}

/** A scope the caller passed on purpose, if this module minted it for a phase: the reference, or a teacher's phase. */
export function explicitPhaseScope(value: unknown): PhaseScope | null {
  if (!isMintedScope(value)) return null;
  if (value.kind === 'reference') return value;
  return 'grain' in value && value.grain === 'phase' ? value : null;
}

/** The phase scope a call composes under: the caller's minted phase scope, else the one resolved from the phase (which fails safe). */
export function resolvePhaseScope(phase: PhaseContent, scope?: unknown): PhaseScope {
  return explicitPhaseScope(scope) ?? phaseScopeOf(phase);
}

/**
 * The pinned version's task list that `read` returns, or undefined when it
 * cannot be read; `phaseScopeOf` then falls back to the phase's sole task,
 * which is TaskTrackr's only when the bytes are.
 */
export function readableTasks(read: () => CompiledTask[]): CompiledTask[] | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/* ------------------------- the output redaction union ---------------------- */

/**
 * Every sealed source a mentor reply must not reproduce, for every executable
 * kind. `assistant.service.ts` hands this to `redactSolutions`; a `code`
 * phase's `solutionSources` alone would leave a `tests` phase's own
 * acceptance suites, the implementation it grades against and its mutants,
 * and a `config` phase's smoke files and the drill's faulted copy unredacted.
 *
 * - `code`: the normalised reference answer and the hidden suites (flat and per run);
 * - `tests`: the reference suites, the implementation graded against and every mutant (flat and per run);
 * - `config`: the smoke implementation files and the drill's faulted files.
 *
 * Built from the compiled checks the phase carries, so an uploaded project's
 * sealed bytes are in it the moment its pack is compiled. Never throws: a
 * slice it cannot read adds nothing, and the rest still redacts.
 *
 * **What the learner is served or owns is not sealed.** A sealed map repeats
 * lines the learner reads every day: a tests
 * phase's implementation *is* the application served locked, a hidden suite
 * repeats the visible tests' titles and fixtures, the drill is a faulted copy
 * of the learner's own configuration. A mentor reply quoting two of those
 * lines quotes the learner's own screen back, and withholding it whole is a
 * false refusal. So every line of these sources that `served` holds, the
 * phase's files and the learner's own workspace, is taken out, here, once,
 * for every kind and every pack: the redaction set is what nobody showed the
 * learner. A line a served line carries whole (the guardrail's containment
 * rule) goes too. The code phase's reference answer (`solutionSources`) is
 * kept whole: its rule is unchanged from the plain code-phase redaction.
 */
export function sealedRedactionSources(
  checks: PhaseChecks | null | undefined,
  served: { files?: readonly { content?: unknown }[] | null; workspace?: Readonly<Record<string, unknown>> | null } = {},
): string[] {
  const out = new Set<string>();
  const sealed: string[] = [];
  const add = (values: unknown, into: (value: string) => void): void => {
    const list = Array.isArray(values) ? values : values && typeof values === 'object' ? Object.values(values as Record<string, unknown>) : [];
    for (const value of list) if (typeof value === 'string' && value) into(value);
  };
  const seal = (values: unknown): void => add(values, (value) => sealed.push(value));
  try {
    if (!checks || typeof checks !== 'object') return [];
    if (checks.kind === 'code') {
      add(checks.solutionSources, (value) => out.add(value));
      seal(checks.hiddenTestFiles);
      for (const run of checks.runs ?? []) seal(run?.hiddenTestFiles);
    } else if (checks.kind === 'tests') {
      seal(checks.referenceTestFiles);
      seal(checks.implFiles);
      for (const mutant of checks.mutants ?? []) seal(mutant?.files);
      for (const run of checks.runs ?? []) {
        seal(run?.referenceTestFiles);
        seal(run?.implFiles);
      }
    } else if (checks.kind === 'config') {
      seal(checks.smokeImplFiles);
      seal(checks.drill?.faultedFiles);
    }
  } catch {
    // whatever was read before the fault still redacts
  }
  for (const source of unservedLines(sealed, served)) out.add(source);
  return [...out];
}

/** A line as `redactSolutions` compares a source's (guardrails.ts `significantLines`, unmarked). */
const comparedLine = (raw: string): string => raw.replace(/#.*$/, '').trim().replace(/\s+/g, ' ');
/** A line the guardrail also finds inside a longer one (guardrails.ts `carriable`). */
const carriable = (line: string): boolean => line.length >= 16 && /[()[\]{}=:]/.test(line);

/** Each distinct sealed source with the lines `served` holds taken out; a source left with nothing is dropped. Never throws. */
function unservedLines(
  sources: readonly string[],
  served: { files?: readonly { content?: unknown }[] | null; workspace?: Readonly<Record<string, unknown>> | null },
): string[] {
  const shown = new Set<string>();
  try {
    for (const file of Array.isArray(served.files) ? served.files : []) {
      if (typeof file?.content === 'string') for (const raw of file.content.split('\n')) shown.add(comparedLine(raw));
    }
    for (const value of Object.values(served.workspace && typeof served.workspace === 'object' ? served.workspace : {})) {
      if (typeof value === 'string') for (const raw of value.split('\n')) shown.add(comparedLine(raw));
    }
  } catch {
    shown.clear(); // unreadable: nothing is subtracted, and everything sealed still redacts
  }
  if (!shown.size) return [...new Set(sources)];
  const longer = [...shown].filter((line) => line.length >= 16);
  const kept = new Set<string>();
  for (const source of new Set(sources)) {
    const lines = source.split('\n').filter((raw) => {
      const line = comparedLine(raw);
      return !shown.has(line) && !(carriable(line) && longer.some((one) => one.includes(line)));
    });
    if (lines.some((raw) => comparedLine(raw).length >= 12)) kept.add(lines.join('\n'));
  }
  return [...kept];
}

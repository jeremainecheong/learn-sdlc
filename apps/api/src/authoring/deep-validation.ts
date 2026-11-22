import { randomUUID } from 'crypto';
import {
  BeforeApplicationShutdown,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  DEEP_VALIDATION_CHECK_IDS,
  deepValidationCostWarning,
  draftOnlyRefusal,
  isRunnerUnavailable,
  platformProjectCopyOnlyRefusal,
  projectNotYoursRefusal,
} from '@learnsdlc/shared';
import type {
  DeepValidationCheckId,
  DeepValidationCheckView,
  DeepValidationReceipt,
  DeepValidationView,
  ProjectVersionValidation,
  RunResult,
} from '@learnsdlc/shared';
import { taskScopeOf } from '../assistant/project-scope';
import { config } from '../config';
import { digestOf } from '../content/blob.store';
import { ContentService } from '../content/content.service';
import type { CodeChecks, ConfigChecks, PhaseContent, PhaseRun, TestsChecks } from '../content/content.types';
import { isQuizTask, soleTaskFor } from '../content/pack-compiler';
import type { CompiledSnapshot, CompiledTask } from '../content/pack-compiler';
import { ProjectEntity, ProjectVersionEntity } from '../content/project.entities';
import { SandboxService, sandboxHarnessTimeoutMs } from '../execution/sandbox.service';
import type { SandboxJob, SandboxTestJob } from '../execution/sandbox.service';
import { dockerEntrypoint, smokeArgvFor } from '../feedback/checkers';
import { recordAudit } from '../audit/audit';
import { isHiddenTestName } from './door-rules';
import { isReferenceApplicationPhase } from './provenance';
import { UUID_PATTERN } from '../db/uuid';
import { DEEP_VALIDATION_STEP_PREFIX } from '../execution/startup-probe';
import { errorName } from '../observability/error-name';

/**
 * Deep validation of a teacher's draft.
 *
 * **What it proves, a to d** (`DEEP_VALIDATION_CHECK_IDS`):
 * (a) the reference solution passes its hidden suite (the graded run exactly
 *     as a learner who hands in the answer meets it;
 * (b) the starter fails the hidden suite) the suite has teeth on every run;
 * (c) the reference tests pass the reference implementation and kill every
 *     mutant: the grader's own mutation job, the reference suite standing
 *     where the learner's would (the cuttable `mutants` sub-check);
 * (d) the deployment smoke run passes on a working configuration and the
 *     drill's faulted copy breaks it, when the phase declares one (the
 *     cuttable `smoke` sub-check).
 * (a) and (b) are never cut: without them no uploaded code phase
 * can publish.
 *
 * **How it runs.** In the sandbox only, and never a model: nothing here can
 * reach an AI provider, and the service is built from the database, the
 * sandbox and the pack's pure helpers. Every job goes through
 * `SandboxService.execute`, so it waits in the existing run gate's line beside
 * every learner's run (the gate is not raised) and is sent with the learner
 * limits `execute` stamps on every payload: a job here never names a time or a
 * memory of its own. The jobs are the grader's own shapes, one after another,
 * never in parallel, off the request path. Each carries a trace owner of kind
 * `run` whose step names it (`DEEP_VALIDATION_STEP_PREFIX`), which is how
 * `execute` labels it `purpose: 'validation'` without one new field on the
 * trace the microVM controller checks key by key.
 *
 * **One in flight per teacher.** The state lives in the one column a version
 * already has for its validation (simple-json over unbounded text, no
 * column, no migration): `validation.deepRun` is the token of a queued or
 * running deep validation and `validation.deep` is the receipt it leaves.
 * Every write is a compare-and-swap on the row's current text
 * (`UPDATE … WHERE id AND status = 'draft' AND validation = <what was read>`),
 * so two connections racing one token have exactly one winner, and a run is
 * promoted from queued to running only under a per-teacher lock (PostgreSQL's
 * transaction advisory lock; sqlite has one writer) after checking that none
 * of that teacher's drafts holds a live running token. A second start by the
 * same teacher therefore **waits**, queued, and runs when the first finishes;
 * pressing start twice on one draft is the same run. Across teachers, at most
 * `DEEP_VALIDATION_PLATFORM_IN_FLIGHT` (2) run at once, counted from the rows
 * under a platform lock; a third waits, queued, and the oldest queued run is
 * promoted when one finishes. A running run beats
 * (rewrites its token's `beatAt`) before every job, so a token whose process
 * died stops counting one job's bound after its last beat; a queued token a
 * gone process left is picked up when its teacher next reads the view. A
 * queued token a live pump holds is wait-beaten (`queuedBeatAt`), so a
 * wait behind the cap never lapses; one no process has held for an hour does,
 * and its view says so.
 *
 * **The receipt** is keyed by `executableContentDigest(version)`: sha256 over
 * the executable phases' files and checks (code, tests, config), nothing
 * written. The run's token and its receipt also carry the draft's phase keys
 * when it was pressed (`phaseKeysOf`), because removing, putting back or
 * adding a written phase moves no executable byte. `hasCurrentDeepReceipt` is
 * what publish asks: a passed receipt whose digest is the draft's digest now,
 * on the phases the draft holds now.
 *
 * **Cost.** The count shown before the start control enables is the number of
 * microVMs the plan books (never money) and a start that names a stale
 * count is refused before anything boots.
 */

/* ---------------------------------- contract --------------------------------- */

export const DEEP_VALIDATION_AUDIT_EVENT = 'project.deep-validation';

// The trace step prefix lives with the sandbox's other platform step ids.
export { DEEP_VALIDATION_STEP_PREFIX };

/**
 * The two cuttable sub-checks: (c) mutants and (d) smoke. Each is one
 * switch, so a cut is a one-line change; (a) and (b) have no switch,
 * because they are never cut. A cut fails closed: the reference
 * project's own Testing or Deployment phase reads `not-applicable`, and any
 * other one fails its check, so it can never publish on a passed receipt.
 */
export const DEEP_VALIDATION_SCOPE = Object.freeze({
  /** (c): setting this to false cuts the mutant sub-check. */
  mutants: true,
  /**
   * (d): setting this to false cuts the smoke sub-check.
   * (a) and (b) have no switch: they are never cut.
   */
  smoke: true,
});

/** The caller as the routes hand it over (`AuthUser` and `InstructorCaller` both fit). */
export interface DeepValidationCaller {
  id: string;
  role: string;
}

/**
 * At most this many deep
 * validations run at once across the whole platform, whoever started them, so
 * K teachers validating cannot hold the run gate against learners' runs. A
 * start past it stays `queued` (the same token and sentence), and the oldest
 * queued run is promoted when one finishes. It sits beside the budget ceiling
 * (`BUDGET_CEILING`, the most one version's run may book); neither raises the
 * run gate.
 */
export const DEEP_VALIDATION_PLATFORM_IN_FLIGHT = 2;

/** The token of a queued or running deep validation, stored beside the receipt. */
export interface DeepRunToken {
  token: string;
  userId: string;
  state: 'queued' | 'running';
  requestedAt: string;
  startedAt: string | null;
  /** A running run rewrites this before every job; liveness is measured from it. */
  beatAt?: string | null;
  /**
   * A queued token's wait-beat. A live pump holding the
   * teacher's queue rewrites it while the token waits; the hour a queued token
   * lives is counted from it (or from `requestedAt` when no pump beat it).
   */
  queuedBeatAt?: string | null;
  contentDigest: string;
  microVMs: number;
  /** The draft's phase keys in order when the run was pressed (`phaseKeysOf`); absent on a token stored before they were stamped. */
  phaseKeys?: string[];
}

/**
 * The receipt as stored: the contract's receipt and the phase keys the run
 * checked (`phaseKeysOf`). A receipt stored before they were stamped has none,
 * and reads by its digest alone, as it always did.
 */
export type StoredDeepReceipt = DeepValidationReceipt & { phaseKeys?: string[] };

/** `project_versions.validation` as deep validation reads and writes it; every other key is carried untouched. */
type StoredValidation = Partial<ProjectVersionValidation> & {
  deep?: StoredDeepReceipt;
  deepRun?: DeepRunToken;
  [key: string]: unknown;
};

export const DEEP_VALIDATION_REFUSALS = {
  nothingToRun:
    'This version has no code, tests or config phase, so deep validation has nothing to run. Fast validation already covers it.',
  notCompiled: 'This draft has not compiled yet. Validate it, fix what the report names, then start deep validation.',
  busy: 'This draft changed while deep validation was being queued. Start it again.',
  runningOlder:
    'Deep validation is running on an earlier copy of this draft. Start it again when that run finishes, so it checks the bytes you have now.',
  staleCost: (microVMs: number): string =>
    `This draft now needs ${microVMs === 1 ? '1 microVM' : `${microVMs} microVMs`} for deep validation, not the count you were shown. Read the new count and start again.`,
} as const;

/* ------------------------------- the digest ------------------------------- */

const isExecutable = (phase: PhaseContent): boolean =>
  phase.checks.kind === 'code' || phase.checks.kind === 'tests' || phase.checks.kind === 'config';

/**
 * sha256 over everything a deep validation runs: every code, tests and config
 * phase's files (path, editability, bytes) and checks (runs, hidden suites,
 * solutions, reference suites, implementations, mutants, smoke, drill, rules),
 * in phase order, plus the pack's runtime. A written phase is not in it, so a
 * brief or a story edit leaves a receipt current; any executable byte moves it.
 */
export function executableContentDigest(version: Pick<ProjectVersionEntity, 'compiled'>): string {
  const content = (version.compiled as CompiledSnapshot | null)?.content;
  const phases = (content?.phases ?? []).filter(isExecutable).map((phase) => ({
    key: phase.key,
    kind: phase.checks.kind,
    language: phase.language,
    files: phase.files
      .map((file) => ({ path: file.path, editable: Boolean(file.editable), content: file.content }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    checks: phase.checks,
  }));
  return digestOf({ digest: 'deep-validation/1', runtime: content?.runtime ?? null, phases });
}

/**
 * The draft's phase keys in order. The executable digest leaves a written
 * phase out, so a Remove, Put back or Add of Requirements or Design does not
 * move it; a run and its receipt carry these keys too, and a receipt made on
 * another phase set is not current.
 */
export function phaseKeysOf(version: Pick<ProjectVersionEntity, 'compiled'>): string[] {
  return ((version.compiled as CompiledSnapshot | null)?.content?.phases ?? []).map((phase) => phase.key);
}

/** Whether a token's or a receipt's phase keys are the draft's now; one stored without them reads as matching. */
const samePhaseKeys = (stamped: readonly string[] | undefined, now: readonly string[]): boolean =>
  stamped === undefined || (stamped.length === now.length && stamped.every((key, at) => key === now[at]));

/** Whether a receipt was made against the version as it stands: its executable digest, and its phase keys when it carries them. */
const receiptMatches = (deep: StoredDeepReceipt, version: Pick<ProjectVersionEntity, 'compiled'>): boolean =>
  deep.contentDigest === executableContentDigest(version) && samePhaseKeys(deep.phaseKeys, phaseKeysOf(version));

const storedOf = (validation: unknown): StoredValidation => {
  if (!validation) return {};
  if (typeof validation === 'string') {
    try {
      const parsed = JSON.parse(validation) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as StoredValidation) : {};
    } catch {
      return {};
    }
  }
  return typeof validation === 'object' ? (validation as StoredValidation) : {};
};

/**
 * True when the version carries a **passed** deep receipt made against the
 * executable bytes it holds now, on the phases it holds now (a receipt stamped
 * with other phase keys is not current; one stored without them reads by its
 * digest). A failed receipt is a receipt, and never one that lets a version
 * publish.
 */
export function hasCurrentDeepReceipt(version: Pick<ProjectVersionEntity, 'compiled' | 'validation'>): boolean {
  const deep = storedOf(version.validation).deep;
  return Boolean(deep && deep.status === 'passed' && receiptMatches(deep, version));
}

/* -------------------------------- the plan -------------------------------- */

/** How one step's result is read. */
type Proof = 'passes-all' | 'caught' | 'killed' | 'smoke-ok' | 'smoke-broken';

interface Step {
  check: DeepValidationCheckId;
  phase: PhaseContent;
  taskKey: string | null;
  /** The run, the mutant or the smoke this step is about, as a teacher names it. */
  subject: string;
  kind: 'hidden' | 'starter' | 'reference' | 'mutant' | 'smoke' | 'drill';
  proof: Proof;
  /** Null when there is nothing to boot: the verdict is already known (`refusal`). */
  job: SandboxJob | null;
  refusal?: { passed: boolean; sentence: string };
}

interface Plan {
  steps: Step[];
  /** Which checks have anything to prove in this version. */
  applies: Record<DeepValidationCheckId, boolean>;
  microVMs: number;
}

/** `feedback.service.ts` codeJob, as a graded hidden run sends it. */
function hiddenJob(files: Record<string, string>, run: PhaseRun, testPaths: string[], stamp: boolean): SandboxTestJob {
  return {
    files: { ...files, ...run.hiddenTestFiles },
    mode: 'tests',
    testPaths,
    language: run.language,
    harness: run.hiddenHarness,
    ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
    ...(stamp ? { runId: run.id } : {}),
  };
}

/**
 * What the reference suite collects is its own file list. A run's
 * `testPaths` are the learner's suite's (a new reference test is never added
 * to them), so a reference test a teacher wrote outside them would be mounted
 * and never run. Kept: each `testPaths` entry that holds a reference test file
 * (the file itself, or a folder above it), in order; then every reference test
 * file none of them holds, in the run's order. TaskTrackr's runs collect
 * `tests` and `web/src`, which hold every reference file, so their jobs are
 * exactly their `testPaths`. A run with no reference test file keeps its
 * `testPaths` (it proves nothing either way).
 *
 * A file is ADDED only when it is a hidden test of the run's own
 * language by the hidden-test name rule (`isHiddenTestName`, the rule draft.ts's
 * `collectNew`, the sealed-role door and publish ask). The loader mounts a reference
 * helper, and a test of the other language, in every run; collecting those
 * would error the run (node cannot load a `.py`, pytest cannot find a `.ts`).
 */
function referenceSuitePaths(run: PhaseRun): string[] {
  const files = Object.keys(run.referenceTestFiles);
  if (!files.length) return run.testPaths;
  const holds = (entry: string, at: string): boolean => {
    const folder = entry.replace(/\/+$/, '');
    return at === folder || at.startsWith(`${folder}/`);
  };
  const kept = run.testPaths.filter((entry) => files.some((at) => holds(entry, at)));
  const added = files.filter((at) => isHiddenTestName(at, run.language) && !kept.some((entry) => holds(entry, at)));
  if (!kept.length && !added.length) return run.testPaths;
  return [...kept, ...added];
}

/**
 * `feedback.service.ts` mutationJob with the reference suite standing where the
 * learner's suite stands: the implementation (and a mutant's planted files)
 * ride in `gradedFiles`, out of the suite's reach, and the suite runs under the
 * run's own learner harness, collecting the reference suite's own files
 * (`referenceSuitePaths`) for the suite-passes run and every mutant run alike.
 */
function mutationJob(run: PhaseRun, stamp: boolean, mutant: Record<string, string> = {}): SandboxTestJob {
  return {
    files: { ...run.supportFiles, ...run.referenceTestFiles },
    gradedFiles: { ...run.implFiles, ...mutant },
    mode: 'tests',
    testPaths: referenceSuitePaths(run),
    language: run.language,
    harness: run.harness,
    ...(run.transform ? { transform: { tool: 'esbuild' as const, jsx: 'automatic' as const } } : {}),
    ...(stamp ? { runId: run.id } : {}),
  };
}

const SCRIPT_FILE = /\.(py|js)$/;

/**
 * A container a learner could hand in: the launcher the pack's own smoke
 * command names, started from the working directory. Built here because a
 * teacher's pack ships the deployment scaffold, not its answer; the smoke run
 * then reads it exactly as it reads a learner's (`dockerEntrypoint`).
 */
function workingDockerfile(command: string[], language: string): string | null {
  const at = command.findIndex((arg) => SCRIPT_FILE.test(arg));
  if (at < 1) return null;
  const base = language === 'python' ? 'FROM python:3.11-slim' : 'FROM node:22-slim';
  return `${base}\nWORKDIR /app\nCOPY . /app\nENTRYPOINT ${JSON.stringify(command.slice(0, at + 1))}\n`;
}

function smokeJob(phase: PhaseContent, files: Record<string, string>): { job: SandboxJob | null; problem: string } {
  const checks = phase.checks as ConfigChecks;
  const all = { ...checks.smokeImplFiles, ...files };
  const entry = dockerEntrypoint(files[checks.smokeDockerfile || 'Dockerfile'] || '', all);
  if (!entry.argv.length) return { job: null, problem: entry.problem || '' };
  return {
    job: {
      files: all,
      mode: 'smoke',
      smokeCommands: smokeArgvFor(entry.argv, checks.smokeCommands),
      expectInOutput: checks.expectInOutput,
      language: phase.language,
    },
    problem: '',
  };
}

type Scope = { mutants: boolean; smoke: boolean };

/**
 * Whether an executable phase is the reference project's own, decided
 * by the recorded `exec` anchor and by the anchor module's own rule, never a
 * second one of this file's: the phase holds exactly one work task (quiz tasks
 * aside) and `taskScopeOf` answers `reference` for it: its workspace is the
 * reference application and the task's `executableReferenceAnchor` (brief,
 * objectives, rubric, owned baselines, runs, mutants, hidden tests, reference
 * answer, check slice, mentor block; never the title) is in
 * `REFERENCE_EXEC_ANCHORS`. `tasks` are the phase's compiled tasks; absent,
 * the phase's sole task. Total: anything it cannot read is not the
 * reference's, so a cut fails closed.
 *
 * **And** publish's own reader says so too:
 * `isReferenceApplicationPhase` (provenance.ts),
 * whose key hashes the whole checks. The exec anchor leaves the screen-copy
 * overlay's paths (`shared/contract/accepted-screen-copy.json`, and
 * `shared/contract/screens.json` where the phase serves it locked) out of
 * tests `implFiles`/`supportFiles` and config `smokeImplFiles`; publish's key
 * keeps them. Were deep validation to read the anchor alone, a copy whose only change is one of
 * those files would be reference to deep validation (its cut check not applicable, the
 * receipt passed) and not to publish (which then asks for that receipt): an
 * edited reference implementation published with nothing run. A cut lets a
 * phase through only when both say reference.
 */
export function isReferenceExecutablePhase(phase: PhaseContent, tasks?: readonly CompiledTask[]): boolean {
  try {
    if (!isExecutable(phase)) return false;
    const held = tasks?.length ? tasks : [soleTaskFor(phase)];
    const work = held.filter((task) => !isQuizTask(task));
    if (work.length !== 1) return false;
    return taskScopeOf(phase, work[0], held).kind === 'reference' && isReferenceApplicationPhase(phase);
  } catch {
    return false;
  }
}

function planOf(snapshot: CompiledSnapshot, content: ContentService, scope: Scope): Plan {
  const byCheck: Record<DeepValidationCheckId, Step[]> = {
    'solution-passes-hidden': [],
    'starter-fails-hidden': [],
    'mutants-killed': [],
    'smoke-passes': [],
  };
  const taskKeyOf = (phase: PhaseContent): string | null =>
    snapshot.phases?.find((one) => one.key === phase.key)?.tasks.find((task) => task.checkKind !== 'quiz')?.taskKey ?? null;
  const isReferencePhase = (phase: PhaseContent): boolean =>
    isReferenceExecutablePhase(phase, snapshot.phases?.find((one) => one.key === phase.key)?.tasks);

  for (const phase of snapshot.content.phases) {
    const taskKey = taskKeyOf(phase);
    const at = { phase, taskKey };
    if (phase.checks.kind === 'code') {
      const checks = phase.checks as CodeChecks;
      const stamp = checks.runs.length > 1;
      for (const run of checks.runs) {
        const hidden = Object.keys(run.hiddenTestFiles);
        const none = {
          passed: false,
          sentence: `In ${phase.title}, the ${run.label} run has no hidden suite, so nothing decides the grade.`,
        };
        byCheck['solution-passes-hidden'].push({
          ...at,
          check: 'solution-passes-hidden',
          subject: run.label,
          kind: 'hidden',
          proof: 'passes-all',
          job: hidden.length ? hiddenJob(content.executionFiles(phase, checks.solutionFiles), run, run.testPaths, stamp) : null,
          ...(hidden.length ? {} : { refusal: none }),
        });
        byCheck['starter-fails-hidden'].push({
          ...at,
          check: 'starter-fails-hidden',
          subject: run.label,
          kind: 'starter',
          proof: 'caught',
          // the hidden suite alone: a starter caught only by the visible tests
          // says nothing about whether the suite that grades has teeth
          job: hidden.length ? hiddenJob(content.executionFiles(phase, null), run, hidden, stamp) : null,
          ...(hidden.length ? {} : { refusal: none }),
        });
      }
    } else if (phase.checks.kind === 'tests' && !scope.mutants) {
      // a cut mutant check fails closed: only the reference project's own Testing phase is let through
      if (!isReferencePhase(phase)) {
        byCheck['mutants-killed'].push({
          ...at,
          check: 'mutants-killed',
          subject: 'mutants',
          kind: 'mutant',
          proof: 'killed',
          job: null,
          refusal: {
            passed: false,
            sentence: `In ${phase.title}, this release does not deep-validate mutants, so this Testing phase cannot publish. Make Testing a written task, or keep the reference project's Testing phase.`,
          },
        });
      }
    } else if (phase.checks.kind === 'tests') {
      const checks = phase.checks as TestsChecks;
      const stamp = checks.runs.length > 1;
      for (const run of checks.runs) {
        byCheck['mutants-killed'].push({
          ...at,
          check: 'mutants-killed',
          subject: run.label,
          kind: 'reference',
          proof: 'passes-all',
          job: mutationJob(run, stamp),
        });
        // a mutant belongs to its run; one naming no run the phase declares
        // is overlaid on the first, as the grader's runForMutant does
        const own = checks.mutants.filter(
          (mutant) => mutant.run === run.id || (run === checks.runs[0] && !checks.runs.some((r) => r.id === mutant.run)),
        );
        for (const mutant of own) {
          byCheck['mutants-killed'].push({
            ...at,
            check: 'mutants-killed',
            subject: mutant.name,
            kind: 'mutant',
            proof: 'killed',
            job: mutationJob(run, stamp, mutant.files),
          });
        }
      }
    } else if (phase.checks.kind === 'config' && !scope.smoke) {
      // a cut smoke check fails closed: only the reference project's own Deployment smoke is let through
      if ((phase.checks as ConfigChecks).smokeCommands?.length && !isReferencePhase(phase)) {
        byCheck['smoke-passes'].push({
          ...at,
          check: 'smoke-passes',
          subject: 'smoke',
          kind: 'smoke',
          proof: 'smoke-ok',
          job: null,
          refusal: {
            passed: false,
            sentence: `In ${phase.title}, this release does not deep-validate the deployment smoke run, so this Deployment phase cannot publish. Keep the reference project's Deployment phase; the runbook record is the Deployment's written part.`,
          },
        });
      }
    } else if (phase.checks.kind === 'config') {
      const checks = phase.checks as ConfigChecks;
      if (!checks.smokeCommands?.length) continue;
      const dockerfile = workingDockerfile(checks.smokeCommands[0], phase.language);
      if (!dockerfile) {
        byCheck['smoke-passes'].push({
          ...at,
          check: 'smoke-passes',
          subject: 'smoke',
          kind: 'smoke',
          proof: 'smoke-ok',
          job: null,
          refusal: {
            passed: false,
            sentence: `In ${phase.title}, the smoke command names no .py or .js file to start, so no container could pass it.`,
          },
        });
        continue;
      }
      // the working container holds the pack's finished copy of each editable
      // file its smoke folder ships, as the pack check's working workspace does:
      // a two-service pack's selfcheck reads the compose file, and the starter's
      // is half-written, so a container built on it fails whatever its image holds
      const working = { ...content.executionFiles(phase, checks.smokeImplFiles), [checks.smokeDockerfile || 'Dockerfile']: dockerfile };
      const fixed = smokeJob(phase, working);
      byCheck['smoke-passes'].push({
        ...at,
        check: 'smoke-passes',
        subject: 'smoke',
        kind: 'smoke',
        proof: 'smoke-ok',
        job: fixed.job,
        ...(fixed.job
          ? {}
          : {
              refusal: {
                passed: false,
                sentence: `In ${phase.title}, a working container cannot start the smoke command: ${fixed.problem}.`,
              },
            }),
      });
      const drill = content.drillSpec(phase);
      if (drill) {
        const broken = smokeJob(phase, { ...working, ...drill.faultedFiles });
        byCheck['smoke-passes'].push({
          ...at,
          check: 'smoke-passes',
          subject: drill.fault,
          kind: 'drill',
          proof: 'smoke-broken',
          job: broken.job,
          // a faulted copy the entrypoint reader already refuses is a drill
          // that breaks the smoke run before it boots anything
          ...(broken.job ? {} : { refusal: { passed: true, sentence: '' } }),
        });
      }
    }
  }
  const steps = DEEP_VALIDATION_CHECK_IDS.flatMap((id) => byCheck[id]);
  return {
    steps,
    applies: Object.fromEntries(DEEP_VALIDATION_CHECK_IDS.map((id) => [id, byCheck[id].length > 0])) as Record<
      DeepValidationCheckId,
      boolean
    >,
    microVMs: steps.filter((step) => step.job).length,
  };
}

/* ------------------------------ the verdicts ------------------------------ */

interface StepOutcome {
  step: Step;
  passed: boolean;
  unavailable: boolean;
  total: number;
  failed: number;
}

function judge(step: Step, result: RunResult): StepOutcome {
  const tests = result.tests;
  const total = tests?.total ?? 0;
  const failed = (tests?.failed ?? 0) + (tests?.errored ?? 0);
  const unavailable = isRunnerUnavailable(result);
  let passed = false;
  if (!unavailable) {
    switch (step.proof) {
      case 'passes-all':
        passed = result.ok && total > 0 && failed === 0;
        break;
      case 'caught':
        // a run that collected nothing caught nothing (content-check's rule);
        // a starter the learner limits stop is failed by the grader all the same
        passed = !result.ok && (failed > 0 || result.exitKind === 'timeout' || result.exitKind === 'memory');
        break;
      case 'killed':
        // the grader's kill rule: a failure or an error; no result is no kill
        passed = Boolean(tests) && failed > 0;
        break;
      case 'smoke-ok':
        passed = result.ok;
        break;
      case 'smoke-broken':
        passed = !result.ok;
        break;
    }
  }
  return { step, passed, unavailable, total, failed };
}

const UNAVAILABLE_SENTENCE = (title: string): string =>
  `In ${title}, the sandbox could not run part of this check, so it proves nothing yet. Start deep validation again in a moment.`;

function failureSentence(outcome: StepOutcome): string {
  const { step } = outcome;
  if (step.refusal && !step.job) return step.refusal.sentence;
  const title = step.phase.title;
  if (outcome.unavailable) return UNAVAILABLE_SENTENCE(title);
  switch (step.kind) {
    case 'hidden':
      return outcome.total === 0
        ? `In ${title}, the hidden suite reported no cases against the reference solution on the ${step.subject} run, so it decides nothing.`
        : `In ${title}, the reference solution fails ${outcome.failed} of ${outcome.total} hidden cases on the ${step.subject} run, so a learner who hands in the answer would not pass.`;
    case 'starter':
      return `In ${title}, the starter already passes the hidden suite on the ${step.subject} run, so a learner could pass without writing anything.`;
    case 'reference':
      return `In ${title}, the reference tests do not pass the reference implementation on the ${step.subject} run, so a mutant they kill proves nothing.`;
    case 'mutant':
      return `In ${title}, the mutant ${step.subject} survives: the reference tests ran ${outcome.total} cases and none of them failed.`;
    case 'smoke':
      return `In ${title}, the smoke run fails on a working container, so every learner would fail it.`;
    case 'drill':
      return `In ${title}, the drill's faulted copy still passes the smoke run, so there is nothing to diagnose.`;
  }
}

const notApplicable = (scope: Scope): Record<DeepValidationCheckId, string> => ({
  'solution-passes-hidden': 'This version has no code phase, so there is no hidden suite to run.',
  'starter-fails-hidden': 'This version has no code phase, so there is no starter to run.',
  'mutants-killed': scope.mutants
    ? 'This version has no tests phase, so there are no mutants to kill.'
    : "Deep validation does not run mutants in this release; the reference project's own Testing phase needs none.",
  'smoke-passes': scope.smoke
    ? 'This version declares no deployment smoke run.'
    : "Deep validation does not run the deployment smoke in this release; the reference project's own Deployment phase needs none.",
});

const PENDING = {
  idle: 'This check has not run on this draft yet.',
  waiting: 'This check is waiting for its turn in the sandbox.',
  /** A token no live process holds any more, with no receipt to show instead. */
  lapsed:
    'The deep validation started on this draft lapsed before it finished, so this check proves nothing yet. Start it again.',
} as const;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function passSentence(id: DeepValidationCheckId, outcomes: StepOutcome[]): string {
  switch (id) {
    case 'solution-passes-hidden':
      return `The reference solution passes its hidden suite on every run (${plural(outcomes.length, 'run')}).`;
    case 'starter-fails-hidden':
      return `The starter fails the hidden suite on every run (${plural(outcomes.length, 'run')}), so the suite has teeth.`;
    case 'mutants-killed': {
      const mutants = outcomes.filter((o) => o.step.kind === 'mutant').length;
      return mutants
        ? `The reference tests pass the reference implementation and kill all ${plural(mutants, 'mutant')}.`
        : 'The reference tests pass the reference implementation. The phase plants no mutant.';
    }
    case 'smoke-passes':
      return outcomes.some((o) => o.step.kind === 'drill')
        ? 'The deployment smoke run passes on a working container, and the drill breaks it.'
        : 'The deployment smoke run passes on a working container.';
  }
}

function checkViews(plan: Plan, outcomes: StepOutcome[], scope: Scope): DeepValidationCheckView[] {
  return DEEP_VALIDATION_CHECK_IDS.map((id) => {
    if (!plan.applies[id]) return { id, status: 'not-applicable', sentence: notApplicable(scope)[id], phaseKey: null, taskKey: null };
    const mine = outcomes.filter((o) => o.step.check === id);
    const bad = mine.filter((o) => !o.passed);
    if (!bad.length) {
      const phases = [...new Set(mine.map((o) => o.step.phase.key))];
      return {
        id,
        status: 'passed',
        sentence: passSentence(id, mine),
        phaseKey: phases.length === 1 ? phases[0] : null,
        taskKey: phases.length === 1 ? mine[0].step.taskKey : null,
      };
    }
    const first = bad[0];
    const more = bad.length - 1;
    return {
      id,
      status: 'failed',
      sentence: `${failureSentence(first)}${more ? ` ${plural(more, 'more step')} of this check also failed.` : ''}`,
      phaseKey: first.step.phase.key,
      taskKey: first.step.taskKey,
    };
  });
}

/* ------------------------------- the service ------------------------------ */

/** One sandbox job's worst case: the learner limit, the harness's own margin, the transport, and its wait in line. */
const perJobBoundMs = (): number => sandboxHarnessTimeoutMs() + config.runnerMaxWaitMs;

/** A running token whose last beat is older than this belongs to a process that is gone (one job's bound plus a minute). */
export const deepRunHeartbeatBoundMs = (): number => perJobBoundMs() + 60_000;

/**
 * A queued token nobody has held in this long was left by a process that is
 * gone. Counted from its last wait-beat (`queuedBeatAt`), or
 * from when it was pressed if no pump ever beat it, never from the press
 * alone, so a wait the platform cap holds (behind other teachers' runs, or
 * behind the teacher's own) lasts as long as a live pump holds it.
 */
const QUEUED_TTL_MS = 60 * 60 * 1000;

/**
 * A live pump holding a teacher's queued tokens rewrites
 * their `queuedBeatAt` on a round once this long has passed since the last
 * beat: often enough that the hour above is never at risk, and rarely enough
 * that a teacher's own edits to a waiting draft do not race a write every
 * retry round.
 */
const QUEUED_BEAT_MS = 60 * 1000;

/** When a queued token was last held: its wait-beat, or its press. NaN when neither reads. */
function queuedSince(token: DeepRunToken): number {
  const requested = Date.parse(token.requestedAt);
  if (!Number.isFinite(requested)) return Number.NaN;
  const beat = Date.parse(token.queuedBeatAt ?? '');
  return Number.isFinite(beat) ? Math.max(requested, beat) : requested;
}

function isLive(token: DeepRunToken | undefined, now = Date.now()): token is DeepRunToken {
  if (!token || typeof token !== 'object' || typeof token.token !== 'string') return false;
  if (token.state === 'running') {
    const beat = Date.parse(token.beatAt ?? token.startedAt ?? '');
    return Number.isFinite(beat) && now - beat < deepRunHeartbeatBoundMs();
  }
  if (token.state === 'queued') {
    const since = queuedSince(token);
    return Number.isFinite(since) && now - since < QUEUED_TTL_MS;
  }
  return false;
}

interface Claimed {
  versionId: string;
  token: DeepRunToken;
  snapshot: CompiledSnapshot;
  startedAt: string;
}

@Injectable()
export class DeepValidationService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(DeepValidationService.name);
  /** The one pump per teacher in this process. */
  private readonly pumping = new Map<string, Promise<void>>();
  /** A teacher whose pump should look again once it is done. */
  private readonly again = new Set<string>();
  /** A teacher whose next run is held by a run in another process: look again shortly. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** sqlite has one connection: this service's transactions take turns. */
  private sqliteChain: Promise<unknown> = Promise.resolve();
  private closing = false;
  /** How long a teacher whose run another process holds waits before looking again. */
  retryMs = 2000;
  /** Which cuttable checks this build runs (tests set it; the build reads `DEEP_VALIDATION_SCOPE`). */
  scope: { mutants: boolean; smoke: boolean } = DEEP_VALIDATION_SCOPE;

  constructor(
    private readonly dataSource: DataSource,
    private readonly sandbox: SandboxService,
    private readonly content: ContentService,
  ) {}

  /* ------------------------------- the routes ------------------------------ */

  /**
   * Queue a deep validation of the caller's draft and return its view.
   *
   * Idempotent per draft: while one is queued or running, a second press
   * answers that one. A start naming a microVM count that is not the count now
   * is refused before anything is written or booted.
   */
  async start(
    caller: DeepValidationCaller,
    versionId: string,
    body?: { acknowledgedMicroVMs?: number },
  ): Promise<DeepValidationView> {
    const { project, version } = await this.requireOwned(caller, versionId, true);
    const snapshot = version.compiled as CompiledSnapshot | null;
    if (!snapshot?.content) throw new ConflictException(DEEP_VALIDATION_REFUSALS.notCompiled);
    const plan = planOf(snapshot, this.content, this.scope);
    if (!plan.steps.length) throw new ConflictException(DEEP_VALIDATION_REFUSALS.nothingToRun);
    if (body?.acknowledgedMicroVMs !== undefined && body.acknowledgedMicroVMs !== plan.microVMs) {
      throw new ConflictException(DEEP_VALIDATION_REFUSALS.staleCost(plan.microVMs));
    }
    const contentDigest = executableContentDigest(version);
    const phaseKeys = phaseKeysOf(version);

    await this.transaction(async (manager) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const raw = await this.rawRow(manager, versionId);
        if (!raw || raw.status !== 'draft') {
          throw new ConflictException(draftOnlyRefusal(version.version, (raw?.status ?? 'published') as never));
        }
        const stored = storedOf(raw.validation);
        const live = stored.deepRun;
        if (isLive(live)) {
          // the same draft twice is the same run (its bytes and its phases)
          if (live.contentDigest === contentDigest && samePhaseKeys(live.phaseKeys, phaseKeys)) return;
          // a run already booting an earlier copy cannot take the new bytes: say so
          if (live.state === 'running') throw new ConflictException(DEEP_VALIDATION_REFUSALS.runningOlder);
          // a queued run on an earlier copy is replaced by one on the bytes now (below)
        }
        const token: DeepRunToken = {
          token: randomUUID(),
          userId: caller.id,
          state: 'queued',
          requestedAt: new Date().toISOString(),
          startedAt: null,
          contentDigest,
          microVMs: plan.microVMs,
          phaseKeys,
        };
        if (await this.swap(manager, versionId, raw.validation, { ...stored, deepRun: token })) {
          await recordAudit(manager, {
            event: DEEP_VALIDATION_AUDIT_EVENT,
            actorUserId: caller.id,
            subjectUserId: caller.id,
            targetId: project.id,
            action: null,
            reason: null,
            detail: { versionId, version: version.version, microVMs: plan.microVMs, contentDigest },
          });
          return;
        }
      }
      throw new ConflictException(DEEP_VALIDATION_REFUSALS.busy);
    });
    this.kick(caller.id);
    return this.view(caller, versionId);
  }

  /** A version's deep validation: its state, its four checks, and whether its receipt is current. */
  async view(caller: DeepValidationCaller, versionId: string): Promise<DeepValidationView> {
    const { version } = await this.requireOwned(caller, versionId, false);
    const raw = await this.rawRow(this.dataSource.manager, versionId);
    const stored = storedOf(raw?.validation ?? null);
    const snapshot = version.compiled as CompiledSnapshot | null;
    const plan = snapshot?.content ? planOf(snapshot, this.content, this.scope) : null;
    const microVMs = plan?.microVMs ?? 0;
    const costWarning = { microVMs, sentence: deepValidationCostWarning(microVMs) };
    const digest = executableContentDigest(version);
    const pending = (sentence: string): DeepValidationCheckView[] =>
      DEEP_VALIDATION_CHECK_IDS.map((id) =>
        plan && !plan.applies[id]
          ? { id, status: 'not-applicable', sentence: notApplicable(this.scope)[id], phaseKey: null, taskKey: null }
          : { id, status: 'pending', sentence, phaseKey: null, taskKey: null },
      );

    if (isLive(stored.deepRun)) {
      const run = stored.deepRun;
      // a queued run no pump here holds (its process is gone): this process takes it up
      if (run.state === 'queued' && !this.pumping.has(run.userId)) this.kick(run.userId);
      return {
        versionId,
        status: run.state,
        current: false,
        contentDigest: run.contentDigest,
        checks: pending(PENDING.waiting),
        costWarning,
        startedAt: run.startedAt,
        finishedAt: null,
      };
    }
    const deep = stored.deep;
    if (deep) {
      return {
        versionId,
        status: deep.status,
        current: deep.contentDigest === digest && samePhaseKeys(deep.phaseKeys, phaseKeysOf(version)),
        contentDigest: deep.contentDigest,
        checks: deep.checks,
        costWarning,
        startedAt: deep.startedAt,
        finishedAt: deep.finishedAt,
      };
    }
    return {
      versionId,
      status: 'not-run',
      current: false,
      contentDigest: null,
      // a press whose token lapsed is said, never a silent "not run"
      checks: pending(stored.deepRun ? PENDING.lapsed : PENDING.idle),
      costWarning,
      startedAt: null,
      finishedAt: null,
    };
  }

  /** Resolve once this process has nothing queued, running or waiting to look again. Tests read it. */
  async idle(): Promise<void> {
    for (;;) {
      const pending = [...this.pumping.values()];
      if (!pending.length && !this.retries.size) return;
      await Promise.all(pending);
      if (!this.pumping.size && this.retries.size) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(5, this.retryMs)));
      }
    }
  }

  /**
   * Stop taking new runs, and let the one in flight stop at its next step:
   * its token is cleared without a receipt, so the teacher starts again
   * rather than waiting out a token nobody will finish.
   */
  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    await Promise.all([...this.pumping.values()]);
  }

  /* ------------------------------- the access ------------------------------ */

  /**
   * The owner's version: another teacher's is a 404 (ids tell nobody what
   * exists), the platform's and an ADMIN's reach into a teacher's are 403:
   * `AuthoringService.requireOwnedProject`'s rule, restated.
   */
  private async requireOwned(
    caller: DeepValidationCaller,
    versionId: string,
    draftOnly: boolean,
  ): Promise<{ project: ProjectEntity; version: ProjectVersionEntity }> {
    const manager = this.dataSource.manager;
    const version = UUID_PATTERN.test(versionId)
      ? await manager.findOne(ProjectVersionEntity, { where: { id: versionId } })
      : null;
    if (!version) throw new NotFoundException('no version with that id');
    const project = await manager.findOne(ProjectEntity, { where: { id: version.projectId } });
    const visible =
      project && (caller.role === 'ADMIN' || project.platformOwned || project.ownerUserId === caller.id);
    if (!project || !visible) throw new NotFoundException('no project with that id in your library');
    if (project.platformOwned) throw new ForbiddenException(platformProjectCopyOnlyRefusal(project.title));
    if (project.ownerUserId !== caller.id) throw new ForbiddenException(projectNotYoursRefusal());
    if (draftOnly && version.status !== 'draft') {
      throw new ConflictException(draftOnlyRefusal(version.version, version.status));
    }
    return { project, version };
  }

  /* ------------------------------ the database ----------------------------- */

  private transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const type = this.dataSource.options.type;
    if (type !== 'better-sqlite3' && type !== 'sqlite') return this.dataSource.transaction(work);
    const run = () => this.dataSource.transaction(work);
    const next = this.sqliteChain.then(run, run);
    this.sqliteChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The row's status and its validation **as stored text**, which is what the swap compares. */
  private async rawRow(
    manager: EntityManager,
    versionId: string,
  ): Promise<{ status: string; validation: string | null } | null> {
    const row = (await manager
      .createQueryBuilder(ProjectVersionEntity, 'v')
      .select('v.status', 'status')
      .addSelect('v.validation', 'validation')
      .where('v.id = :id', { id: versionId })
      .getRawOne()) as { status: string; validation: string | null } | undefined;
    if (!row) return null;
    return { status: row.status, validation: row.validation ?? null };
  }

  /**
   * The compare-and-swap: write `next` only if the row is still a draft and
   * its validation is still exactly the text that was read. One winner per
   * token, on both dialects; on PostgreSQL the loser blocks on the winner's
   * row lock and then re-reads a row that no longer matches.
   */
  private async swap(
    manager: EntityManager,
    versionId: string,
    prev: string | null,
    next: StoredValidation,
  ): Promise<boolean> {
    const query = manager
      .createQueryBuilder()
      .update(ProjectVersionEntity)
      .set({ validation: () => ':next' } as never)
      .where('id = :id', { id: versionId })
      .andWhere('status = :draft', { draft: 'draft' })
      .setParameter('next', JSON.stringify(next));
    if (prev === null) query.andWhere('validation IS NULL');
    else query.andWhere('validation = :prev', { prev });
    const result = await query.execute();
    return (result.affected ?? 0) === 1;
  }

  /**
   * Every draft holding a deep-validation token, every teacher's (the
   * platform-wide cap is counted from these rows, never from this process).
   */
  private async tokensOf(
    manager: EntityManager,
  ): Promise<{ versionId: string; raw: string; run: DeepRunToken }[]> {
    const rows = (await manager
      .createQueryBuilder(ProjectVersionEntity, 'v')
      .select('v.id', 'id')
      .addSelect('v.validation', 'validation')
      .where('v.status = :draft', { draft: 'draft' })
      .andWhere('v.validation LIKE :marker', { marker: '%"deepRun"%' })
      .getRawMany()) as { id: string; validation: string | null }[];
    const out: { versionId: string; raw: string; run: DeepRunToken }[] = [];
    for (const row of rows) {
      if (!row.validation) continue;
      const run = storedOf(row.validation).deepRun;
      if (run && typeof run === 'object' && typeof run.userId === 'string') out.push({ versionId: row.id, raw: row.validation, run });
    }
    return out;
  }

  /* -------------------------------- the pump ------------------------------- */

  /** Make sure this process is working through the teacher's queue. */
  private kick(userId: string): void {
    if (this.closing) return;
    if (this.pumping.has(userId)) {
      this.again.add(userId);
      return;
    }
    const pump = this.pump(userId)
      .catch((error: unknown) => {
        this.logger.error(`deep validation stopped: ${(error as Error)?.message ?? 'unknown error'}`);
      })
      .finally(() => {
        this.pumping.delete(userId);
        if (this.again.delete(userId)) this.kick(userId);
      });
    this.pumping.set(userId, pump);
  }

  /**
   * A slot changed hands (a run finished, or one was promoted): every
   * teacher this process holds waiting for one looks again now rather than at
   * its next retry. The order is still the rows' (`claim`), not this call's.
   */
  private wake(except?: string): void {
    for (const [userId, timer] of [...this.retries]) {
      if (userId === except) continue;
      clearTimeout(timer);
      this.retries.delete(userId);
      this.kick(userId);
    }
  }

  private retryLater(userId: string): void {
    if (this.closing || this.retries.has(userId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(userId);
      this.kick(userId);
    }, this.retryMs);
    timer.unref?.();
    this.retries.set(userId, timer);
  }

  private async pump(userId: string): Promise<void> {
    while (!this.closing) {
      const next = await this.claim(userId);
      if (next === 'none') return;
      if (next === 'blocked') {
        this.retryLater(userId);
        return;
      }
      if (next === 'again') continue;
      if ('handTo' in next) {
        // the free slot is an older run's, another teacher's: that teacher's
        // pump takes it, and this one looks again once a slot moves
        this.kick(next.handTo);
        this.retryLater(userId);
        return;
      }
      this.wake(userId);
      await this.execute(next);
      this.wake(userId);
    }
  }

  /**
   * Promote the teacher's oldest queued token to running, unless one of their
   * runs is already live (one per teacher) or `DEEP_VALIDATION_PLATFORM_IN_FLIGHT`
   * runs are live platform-wide. Both counts are read from the rows,
   * under the platform lock and then the per-teacher lock (PostgreSQL's
   * transaction advisory locks, always in that order; sqlite has one writer),
   * so two processes promoting at once can never pass the cap. A free slot
   * goes to the oldest queued run of a teacher with nothing running, across
   * every teacher: when that run is another teacher's, this pump hands it over
   * and waits. A token whose draft's executable bytes moved since it was
   * queued is dropped: the count the teacher was shown is not this draft's any
   * more.
   */
  private claim(userId: string): Promise<Claimed | 'none' | 'blocked' | 'again' | { handTo: string }> {
    return this.transaction(async (manager) => {
      if (this.dataSource.options.type === 'postgres') {
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['learnsdlc.deep-validation.platform']);
        await manager.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
          'learnsdlc.deep-validation',
          userId,
        ]);
      }
      const now = Date.now();
      const live = (await this.tokensOf(manager)).filter((one) => isLive(one.run, now));
      const inFlight = live.filter((one) => one.run.state === 'running');
      if (inFlight.some((one) => one.run.userId === userId)) {
        await this.beatWaiting(manager, userId, live, now);
        return 'blocked';
      }
      const busy = new Set(inFlight.map((one) => one.run.userId));
      const queued = live
        .filter((one) => one.run.state === 'queued' && !busy.has(one.run.userId))
        .sort((a, b) => a.run.requestedAt.localeCompare(b.run.requestedAt) || a.versionId.localeCompare(b.versionId));
      if (!queued.some((one) => one.run.userId === userId)) return 'none';
      if (inFlight.length >= DEEP_VALIDATION_PLATFORM_IN_FLIGHT) {
        // the cap holds this teacher's run; this pump is alive and says so
        await this.beatWaiting(manager, userId, live, now);
        return 'blocked';
      }
      const first = queued[0];
      if (first.run.userId !== userId) {
        await this.beatWaiting(manager, userId, live, now);
        return { handTo: first.run.userId };
      }
      const version = await manager.findOne(ProjectVersionEntity, { where: { id: first.versionId } });
      const stored = storedOf(first.raw);
      const snapshot = version?.compiled as CompiledSnapshot | null;
      if (
        !version ||
        !snapshot?.content ||
        executableContentDigest(version) !== first.run.contentDigest ||
        !samePhaseKeys(first.run.phaseKeys, phaseKeysOf(version))
      ) {
        const { deepRun: _dropped, ...rest } = stored;
        await this.swap(manager, first.versionId, first.raw, rest);
        return 'again';
      }
      const startedAt = new Date().toISOString();
      const running: DeepRunToken = { ...first.run, state: 'running', startedAt };
      if (!(await this.swap(manager, first.versionId, first.raw, { ...stored, deepRun: running }))) return 'again';
      return { versionId: first.versionId, token: running, snapshot, startedAt };
    });
  }

  /**
   * The wait-beat. The teacher's live queued tokens whose
   * last beat (or press) is `QUEUED_BEAT_MS` old get `queuedBeatAt = now`, by
   * compare-and-swap on the text just read; a lost swap is somebody else's
   * write and the next round beats again. Only a live token is beaten, so a
   * lapsed one is never brought back, and `requestedAt` never moves, so a
   * beat never changes a run's place in line.
   */
  private async beatWaiting(
    manager: EntityManager,
    userId: string,
    tokens: readonly { versionId: string; raw: string; run: DeepRunToken }[],
    now: number,
  ): Promise<void> {
    // Rows are written in one fixed order (versionId), so two
    // processes beating the same teacher's rows take their locks in the same
    // order and cannot deadlock on PostgreSQL.
    const ordered = [...tokens].sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
    for (const one of ordered) {
      if (one.run.userId !== userId || one.run.state !== 'queued' || !isLive(one.run, now)) continue;
      if (now - queuedSince(one.run) < QUEUED_BEAT_MS) continue;
      const stored = storedOf(one.raw);
      await this.swap(manager, one.versionId, one.raw, {
        ...stored,
        deepRun: { ...one.run, queuedBeatAt: new Date(now).toISOString() },
      });
    }
  }

  /** Run the plan one job at a time, then leave the receipt. */
  private async execute(claimed: Claimed): Promise<void> {
    const plan = planOf(claimed.snapshot, this.content, this.scope);
    const outcomes: StepOutcome[] = [];
    let index = 0;
    for (const step of plan.steps) {
      if (this.closing) {
        await this.finish(claimed, null);
        return;
      }
      if (!step.job) {
        const refusal = step.refusal ?? { passed: false, sentence: '' };
        outcomes.push({ step, passed: refusal.passed, unavailable: false, total: 0, failed: 0 });
        continue;
      }
      // beat before every job; a draft no longer a draft, or a token no longer
      // this run's, boots nothing more and is left as it is
      if (!(await this.beat(claimed))) return;
      index += 1;
      let result: RunResult;
      try {
        result = await this.sandbox.execute(step.job, {
          kind: 'run',
          ownerId: claimed.versionId,
          stepId: `${DEEP_VALIDATION_STEP_PREFIX}${step.check}:${index}`,
        });
      } catch (error) {
        // the teacher reads the step as unavailable; the operator reads why, by the error's class only
        this.logger.warn(`deep validation step ${step.check}:${index} could not run (${errorName(error)})`);
        result = { ok: false, exitKind: 'unavailable', stdout: '', stderr: '', durationMs: 0 };
      }
      outcomes.push(judge(step, result));
    }
    const checks = checkViews(plan, outcomes, this.scope);
    const receipt: StoredDeepReceipt = {
      contentDigest: claimed.token.contentDigest,
      status: checks.every((check) => check.status !== 'failed') ? 'passed' : 'failed',
      checks,
      microVMs: plan.microVMs,
      startedAt: claimed.startedAt,
      finishedAt: new Date().toISOString(),
      // the phases the run was pressed on (promotion checked the snapshot it ran still held them)
      ...(claimed.token.phaseKeys ? { phaseKeys: claimed.token.phaseKeys } : {}),
    };
    await this.finish(claimed, receipt);
  }

  /**
   * Rewrite this run's `beatAt`, by compare-and-swap. False when the draft is
   * gone, no longer a draft, or holds another token: the run stops there.
   */
  private async beat(claimed: Claimed): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await this.transaction(async (manager) => {
        const raw = await this.rawRow(manager, claimed.versionId);
        if (!raw || raw.status !== 'draft') return 'stop';
        const stored = storedOf(raw.validation);
        if (stored.deepRun?.token !== claimed.token.token) return 'stop';
        const deepRun: DeepRunToken = { ...stored.deepRun, beatAt: new Date().toISOString() };
        if (!(await this.swap(manager, claimed.versionId, raw.validation, { ...stored, deepRun }))) return 'retry';
        // This pump also holds the teacher's other drafts
        // queued behind this run (one per teacher): they wait while it lives
        const now = Date.now();
        await this.beatWaiting(manager, claimed.token.userId, await this.tokensOf(manager), now);
        return 'go';
      });
      if (outcome !== 'retry') return outcome === 'go';
    }
    this.logger.warn('deep validation could not record its beat after five attempts; it carries on');
    return true;
  }

  /**
   * Store the receipt (or, on shutdown, nothing) and clear this run's token,
   * by compare-and-swap. A draft edited meanwhile still gets its receipt (it
   * is keyed by the digest it was made against, so it reads as not current)
   * unless the draft already holds a receipt for its bytes now, or a later
   * one for the same bytes: an older run finishing last never replaces it.
   * A draft published or deleted meanwhile gets nothing.
   */
  private async finish(claimed: Claimed, receipt: StoredDeepReceipt | null): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const done = await this.transaction(async (manager) => {
        const raw = await this.rawRow(manager, claimed.versionId);
        if (!raw || raw.status !== 'draft') return true;
        const stored = storedOf(raw.validation);
        const next: StoredValidation = { ...stored };
        const ours = stored.deepRun?.token === claimed.token.token;
        if (ours) delete next.deepRun;
        if (receipt && !(await this.keepsPrior(manager, claimed.versionId, stored.deep, receipt))) next.deep = receipt;
        if (!ours && next.deep === stored.deep) return true;
        return this.swap(manager, claimed.versionId, raw.validation, next);
      });
      if (done) return;
    }
    this.logger.warn('deep validation finished but its receipt could not be stored after five attempts');
  }

  /** Whether the receipt already stored outranks this one: it is for the draft's bytes now and this is not, or it is later for the same bytes. */
  private async keepsPrior(
    manager: EntityManager,
    versionId: string,
    prior: StoredDeepReceipt | undefined,
    receipt: StoredDeepReceipt,
  ): Promise<boolean> {
    if (!prior) return false;
    if (prior.contentDigest === receipt.contentDigest && (receipt.phaseKeys === undefined || samePhaseKeys(prior.phaseKeys, receipt.phaseKeys))) {
      return (prior.finishedAt ?? '') > (receipt.finishedAt ?? '');
    }
    const version = await manager.findOne(ProjectVersionEntity, { where: { id: versionId } });
    if (!version) return false;
    return receiptMatches(prior, version) && !receiptMatches(receipt, version);
  }
}
